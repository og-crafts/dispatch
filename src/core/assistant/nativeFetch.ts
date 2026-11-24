/**
 * A fetch for the assistant that goes through Rust (`ai_stream`, src-tauri/src/ai.rs): the webview can't reach AI hosts.
 * The rules are checked here before anything leaves the webview, and again in Rust.
 */
import type { Settings } from '../types'
import { validateAddress, type Connection } from './connections'
import { abortError, AssistantError, assertUsable, scrub } from './providers/shared'

export type NetSettings = Pick<Settings, 'proxyUrl' | 'proxyBypass' | 'caCerts'>

type AiEvent =
  | { kind: 'head'; status: number; headers: [string, string][] }
  | { kind: 'chunk'; base64: string }
  | { kind: 'end' }
  | { kind: 'error'; message: string }

/** A random id that fits a u64 and a JS safe integer. */
function randomId(): number {
  const [hi, lo] = globalThis.crypto.getRandomValues(new Uint32Array(2))
  return (hi & 0x1fffff) * 0x1_0000_0000 + lo
}

function decode(base64: string): Uint8Array {
  const text = atob(base64), out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

const parse = (url: string): URL | null => { try { return new URL(url) } catch { return null } }

/** The request's URL, or an error for anything this connection may not call. */
function checked(conn: Connection, url: string): URL {
  const bad = validateAddress(conn.baseUrl)
  if (bad) throw new AssistantError(bad)
  assertUsable(conn)
  const u = parse(url), base = parse(conn.baseUrl.trim())
  if (!u || !base || u.origin !== base.origin || u.username || u.password) throw new AssistantError('The request goes somewhere other than the connection’s address, so nothing was sent.')
  return u
}

export function nativeFetch(conn: Connection, net: NetSettings): typeof fetch {
  return async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('nativeFetch takes a URL.')
    const url = checked(conn, String(input))
    const signal = init?.signal ?? undefined
    if (init?.body != null && typeof init.body !== 'string') throw new TypeError('nativeFetch sends text only.')
    const body = init?.body ?? null
    const { invoke, Channel } = await import('@tauri-apps/api/core')
    if (signal?.aborted) throw abortError()

    const id = randomId()
    return new Promise<Response>((resolve, reject) => {
      let over = false
      let answered = false
      let out: ReadableStreamDefaultController<Uint8Array> | null = null
      /** Ends the call once; everything after it is dropped. */
      const finish = (): boolean => {
        if (over) return false
        over = true
        signal?.removeEventListener('abort', onAbort)
        return true
      }
      const fail = (e: Error) => { if (finish()) { if (answered) out?.error(e); else reject(e) } }
      const cancel = () => { void invoke('ai_cancel', { id }).catch(() => {}) }
      const onAbort = () => { if (!over) { fail(abortError()); cancel() } }
      signal?.addEventListener('abort', onAbort, { once: true })

      const onEvent = new Channel<AiEvent>((ev) => {
        if (over) return
        if (ev.kind === 'head') {
          const stream = new ReadableStream<Uint8Array>({ start(c) { out = c }, cancel() { if (finish()) cancel() } })
          const headers = new Headers()
          for (const [k, v] of ev.headers) { try { headers.append(k, v) } catch { /* a header this engine can't hold */ } }
          const bodiless = ev.status === 204 || ev.status === 205 || ev.status === 304
          try { resolve(new Response(bodiless ? null : stream, { status: ev.status, headers })) } catch {
            fail(new AssistantError(scrub(`${conn.name} answered with a status Dispatch doesn’t know (${ev.status}).`, conn)))
            cancel()
            return
          }
          answered = true
        } else if (ev.kind === 'chunk') {
          out?.enqueue(decode(ev.base64))
        } else if (ev.kind === 'end') {
          if (!answered) fail(new AssistantError(scrub(`${conn.name} ended the connection without an answer.`, conn)))
          else if (finish()) out?.close()
        } else {
          const what = answered ? `The connection to ${conn.name} was lost before the answer was finished` : `Couldn’t reach ${conn.name}. Check the address and your connection, then try again`
          fail(new AssistantError(scrub(`${what} (${ev.message}).`, conn)))
        }
      })

      invoke('ai_stream', {
        req: {
          id, method: init?.method ?? 'GET', url: url.href, origin: url.origin, headers: [...new Headers(init?.headers)], body,
          proxy: net.proxyUrl || null, noProxy: net.proxyBypass || null, caCertsPem: net.caCerts.filter((c) => c.trim()),
        },
        onEvent,
      }).catch((e: unknown) => fail(new AssistantError(scrub(typeof e === 'string' ? e : e instanceof Error ? e.message : 'The request couldn’t be sent.', conn))))
    })
  }
}
