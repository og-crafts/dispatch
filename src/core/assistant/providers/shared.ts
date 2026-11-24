/** What the providers and nativeFetch share: plain failures that can't hold the key, retries before output, stopping. */
import { needsKey, type Connection } from '../connections'
import type { Call, Turn } from './types'

/** A failure with a message for the person. Holds no request, response, headers or cause. */
export class AssistantError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'AssistantError'
  }
}

export const abortError = () => new DOMException('Stopped.', 'AbortError')

/** `text` without the connection's key, in any spelling a server may echo. */
export function scrub(text: string, conn: Connection): string {
  let out = text
  const key = conn.key.trim()
  for (const k of new Set([conn.key, key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) if (k.trim()) out = out.split(k).join('[hidden]')
  return out.replace(/\bsk-[\w*.-]{6,}/g, '[hidden]') // servers also echo keys partly masked
}

/** Throws when the connection can't be used as it is (its key is missing, unreadable here or unsendable). */
export function assertUsable(conn: Connection): void {
  if (conn.keyLost) throw new AssistantError(scrub(`Enter the key again for ${conn.name}.`, conn))
  const key = conn.key.trim()
  if (!key && needsKey(conn)) throw new AssistantError(`Enter the key for ${conn.name}.`)
  // checked here because Headers would throw an error that quotes the key
  if (/[^\x21-\x7e]/.test(key)) throw new AssistantError(scrub(`The key for ${conn.name} has characters that can’t be sent. Enter it again.`, conn))
}

/** The server's own words from an error body, if it gave any. */
function detailOf(body: unknown): { message: string; code: string } {
  let b = body
  if (typeof b === 'string') { try { b = JSON.parse(b) } catch { return { message: '', code: '' } } }
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
  const e = o.error ?? o
  if (typeof e === 'string') return { message: e, code: '' }
  const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  return { message: typeof x.message === 'string' ? x.message : '', code: [x.code, x.type].filter((v) => typeof v === 'string').join(' ') }
}

/** The plain message for an HTTP status (or an error reported inside a stream). */
export function httpError(conn: Connection, status: number | undefined, body: unknown, retryAfter?: string | null): AssistantError {
  const { message, code } = detailOf(body)
  const n = conn.name
  const at = status === undefined ? '' : ` (${status})`
  const fail = (text: string, retryable = false) => new AssistantError(scrub(text, conn), status, retryable, waitOf(retryAfter))
  if (status === 402 || /insufficient_quota|billing/.test(code) || (status === 400 && /credit balance/i.test(message))) return fail(`${n} says there’s no credit left on this account. Add credit with them, then try again.`)
  if (status === 401) return fail(conn.key.trim() ? `${n} didn’t accept the key. Check it in the connection’s settings.` : `${n} needs a key. Add it in the connection’s settings.`)
  if (status === 403) return fail(`${n} doesn’t let this key do that. Check the key and what it may use, or pick another model.`)
  if (status === 404) return fail(conn.kind === 'compatible' ? `${n} doesn’t know this model, or the address is wrong. Check both in the connection’s settings.` : `${n} doesn’t know this model. Pick another in the connection’s settings.`)
  if (status === 413) return fail(`This chat is too long for ${n}. Start a new chat.`)
  if (status === 429) return fail(`${n} is getting too many requests right now. Wait a minute, then try again.`, true)
  if (status === 408 || (status !== undefined && status >= 500)) return fail(`${n} has a problem on its side${at}. Try again in a moment.`, true)
  const said = scrub(message, conn).slice(0, 300)
  return fail(`${n} couldn’t use this request${at}${said ? `: ${said}` : '. Check the model and the address.'}`)
}

const waitOf = (h: string | null | undefined): number | undefined => (h && /^\d+(\.\d+)?$/.test(h.trim()) ? Number(h) * 1000 : undefined)

export const cutShort = (conn: Connection) => new AssistantError(scrub(`The connection to ${conn.name} ended before the answer was finished. Try again.`, conn))
export const unreadable = (conn: Connection) => new AssistantError(scrub(`${conn.name} sent an answer Dispatch couldn’t read. Check the address and try again.`, conn))

const DELAYS = [500, 2000]
const LONGEST_WAIT = 10_000

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  const stop = () => { clearTimeout(t); rej(abortError()) }
  const t = setTimeout(() => { signal.removeEventListener('abort', stop); res() }, ms)
  signal.addEventListener('abort', stop, { once: true })
})

/**
 * Runs one turn: rejects as soon as `signal` aborts, and tries again (twice) when the server is busy or failing and no
 * output has begun. A lost connection isn't tried again: the server may be working on (and billing) the first one.
 */
export function runTurn<T>(signal: AbortSignal, attempt: (began: () => void) => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  const run = async (): Promise<T> => {
    for (let i = 0; ; i++) {
      let output = false
      try { return await attempt(() => { output = true }) } catch (e) {
        if (signal.aborted) throw abortError()
        if (output || i >= DELAYS.length || !(e instanceof AssistantError) || !e.retryable || (e.retryAfterMs ?? 0) > LONGEST_WAIT) throw e
        await pause(Math.max(DELAYS[i], e.retryAfterMs ?? 0), signal)
      }
    }
  }
  return new Promise<T>((res, rej) => {
    const stop = () => rej(abortError())
    signal.addEventListener('abort', stop, { once: true })
    run().then(res, rej).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** Servers disagree on the stop reason: what matters is whether there are calls. */
export const matchCalls = (stop: Turn['stop'], calls: number): Turn['stop'] =>
  (stop === 'end' && calls ? 'tools' : stop === 'tools' && !calls ? 'end' : stop)

const ERROR_BYTES = 64 * 1024
const LINE_BYTES = 4 * 1024 * 1024

/** `fetch` with limits on what a server may make us hold: an error body is cut, an endless line is an error. */
export function limited(conn: Connection, fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await fetch(input, init)
    if (!res.body) return res
    const reader = res.body.getReader()
    let size = 0 // of the error body, or of the line so far
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await reader.read() // a failure fails this stream too
        if (done) { c.close(); return }
        if (!res.ok) {
          const part = value.subarray(0, ERROR_BYTES - size)
          size += part.length
          c.enqueue(part)
          if (size >= ERROR_BYTES) { c.close(); reader.cancel().catch(() => {}) }
          return
        }
        const isEnd = (b: number) => b === 10 || b === 13
        const first = value.findIndex(isEnd)
        const longest = size + (first < 0 ? value.length : first)
        size = first < 0 ? longest : value.length - 1 - Math.max(value.lastIndexOf(10), value.lastIndexOf(13))
        if (Math.max(longest, size) > LINE_BYTES) {
          c.error(new AssistantError(scrub(`${conn.name} sent an answer that’s too large to read.`, conn)))
          reader.cancel().catch(() => {})
          return
        }
        c.enqueue(value)
      },
      cancel: (why) => reader.cancel(why),
    })
    return new Response(body, { status: res.status, headers: res.headers })
  }
}

/** A call from the model's argument text: one complete JSON object, or `invalid`. Never a partial object. */
export function parseCall(id: string, name: string, json: string): Call {
  if (!name.trim()) return { id, name: 'unknown_tool', input: undefined, invalid: 'The call didn’t name a tool.' }
  let input: unknown
  try { input = json.trim() ? JSON.parse(json) : {} } catch { return { id, name, input: undefined, invalid: 'The arguments weren’t valid JSON. Nothing was run.' } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { id, name, input: undefined, invalid: 'The arguments weren’t a JSON object. Nothing was run.' }
  return { id, name, input }
}

/** After a cut-off or refused answer no call may run, however complete it looks. */
export const blockCall = (c: Call, stop: 'length' | 'refused'): Call =>
  ({ id: c.id, name: c.name, input: undefined, invalid: stop === 'length' ? 'The answer was cut off. Nothing was run.' : 'The answer was refused. Nothing was run.' })
