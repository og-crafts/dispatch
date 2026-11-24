/** OpenAI and OpenAI-compatible servers: a small client over {baseUrl}/chat/completions. */
import type { Connection } from '../connections'
import { SseParser, SseTooLarge } from '../../sse'
import { abortError, AssistantError, assertUsable, blockCall, cutShort, httpError, limited, matchCalls, parseCall, runTurn, tooLarge, unreadable } from './shared'
import type { Provider, Turn, TurnRequest } from './types'

interface Piece { index?: number; id?: string; function?: { name?: string; arguments?: unknown } }
interface Chunk {
  choices?: { delta?: { content?: string | null; refusal?: string | null; tool_calls?: Piece[] | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  error?: unknown
}
interface Building { index?: number; id: string; name: string; args: string; /** Came in one piece: name and complete arguments. */ whole: boolean }

const isObject = (json: string) => { try { const v: unknown = JSON.parse(json); return !!v && typeof v === 'object' && !Array.isArray(v) } catch { return false } }
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * Puts streamed calls together. Servers differ: whole calls or pieces, ids or not, right indexes, none, or all 0.
 * While every piece clearly belongs to one call (the only one, or the one with its index or id; name first), pieces are joined.
 * Once one doesn't, the stream is `mixed`: joining stops, and only calls that came in one piece may run.
 */
class CallBuilder {
  readonly calls: Building[] = []
  mixed = false

  add(p: Piece): void {
    const id = str(p.id), name = str(p.function?.name), raw = p.function?.arguments
    const args = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw)
    const piece = { index: typeof p.index === 'number' ? p.index : undefined, id, name, args }
    if (!this.mixed) {
      const cur = this.owner(piece)
      if (cur && this.continues(cur, piece)) { cur.id ||= id; cur.name ||= name; cur.args += args; cur.whole &&= !args.trim(); return }
      if (!cur && this.opens(piece)) { this.push(piece); return }
      this.mixed = true
    }
    if (name || !this.calls.length) this.push(piece)
  }

  /** The call this piece names by index, or by id, or the only one there is. */
  private owner(p: { index?: number; id: string }): Building | undefined {
    const { calls } = this
    if (p.index !== undefined && calls.some((c) => c.index !== undefined)) return calls.find((c) => c.index === p.index)
    const byId = p.id ? calls.filter((c) => c.id === p.id) : []
    if (byId.length === 1) return byId[0]
    return calls.length === 1 && !(p.id && calls[0].id) ? calls[0] : undefined
  }

  private continues(cur: Building, p: { id: string; name: string; args: string }): boolean {
    if (p.id && cur.id && p.id !== cur.id) return false
    if (p.args.trim() && isObject(cur.args)) return false // its arguments are complete: these are another call's
    if (!p.name) return true
    if (!cur.name) return !cur.args // arguments never go to a name that came later
    // the name again: a new call's first piece is empty or starts with {
    return p.name === cur.name && p.args.trim() !== '' && !p.args.trimStart().startsWith('{')
  }

  /** Whether the piece can start a call that later pieces can't confuse with another. */
  private opens(p: { index?: number; id: string; name: string; args: string }): boolean {
    if (!p.name && p.args.trim()) return false
    if (!this.calls.length) return true
    return p.index !== undefined ? this.calls.every((c) => c.index !== undefined)
      : p.id !== '' && this.calls.every((c) => c.index === undefined && c.id && c.id !== p.id)
  }

  private push(p: { index?: number; id: string; name: string; args: string }): void {
    // what looks whole may be the inside of an unfinished call that repeats its name
    const inside = this.calls.some((c) => c.name === p.name && c.args.trim() && !isObject(c.args))
    this.calls.push({ ...p, whole: p.name !== '' && isObject(p.args) && !inside })
  }
}

const STOPS = new Map<string, Turn['stop']>(Object.entries({
  stop: 'end', eos_token: 'end', stop_sequence: 'end', tool_calls: 'tools', function_call: 'tools', length: 'length', content_filter: 'refused',
}))

const MAX_EVENT = 4 * 1024 * 1024

export function chatProvider(conn: Connection, unlimited: typeof globalThis.fetch): Provider {
  const fetch = limited(conn, unlimited)
  const base = conn.baseUrl.trim().replace(/\/+$/, '')
  const key = conn.key.trim()
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }

  async function attempt(t: TurnRequest, began: () => void): Promise<Turn> {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers, signal: t.signal,
      body: JSON.stringify({
        model: conn.model, stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'system', content: t.system }, ...t.messages],
        ...(t.tools.length ? { tools: t.tools.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.inputSchema } })) } : {}),
      }),
    })
    if (!res.ok) throw httpError(conn, res.status, await res.text(), res.headers.get('retry-after'))
    if (!res.body) throw cutShort(conn)

    let text = '', refusal = '', finish = '', done = false
    let usage: Turn['usage']
    const builder = new CallBuilder(), building = builder.calls
    const parser = new SseParser(MAX_EVENT), decoder = new TextDecoder(), reader = res.body.getReader()
    const say = (s: string) => { text += s; if (!t.signal.aborted) t.onText(s) }
    const take = (data: string) => {
      if (data.trim() === '[DONE]') { done = true; return }
      let c: Chunk
      try { c = JSON.parse(data) as Chunk } catch { throw unreadable(conn) }
      if (!c || typeof c !== 'object') throw unreadable(conn)
      if (c.error) {
        const code = (c.error as { code?: unknown }).code
        throw httpError(conn, typeof code === 'number' ? code : undefined, c)
      }
      if (c.usage && typeof c.usage.prompt_tokens === 'number') usage = { input: c.usage.prompt_tokens, output: c.usage.completion_tokens ?? 0 }
      const choice = c.choices?.[0]
      if (!choice) return
      const d = choice.delta ?? {}
      if (d.content) { began(); say(d.content) }
      if (d.refusal) { began(); refusal += d.refusal; say(d.refusal) }
      for (const p of d.tool_calls ?? []) { began(); builder.add(p) }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason
    }
    try {
      while (!done) {
        const r = await reader.read()
        // the end of the stream also ends a last line the server left open
        for (const ev of parser.push(r.done ? `${decoder.decode()}\n\n` : decoder.decode(r.value, { stream: true }))) { take(ev.data); if (done) break }
        if (r.done) break
      }
    } finally { reader.cancel().catch(() => {}) }

    let stop = STOPS.get(finish)
    // a finish reason and a clean end is a whole answer: some servers leave [DONE] out
    if (!finish) throw cutShort(conn)
    if (!stop) throw unreadable(conn)
    if (refusal) stop = 'refused'
    stop = matchCalls(stop, building.length)

    const prefix = globalThis.crypto.randomUUID().slice(0, 8) // only for servers that send no ids, or the same one twice
    const seen = new Set<string>()
    const calls = building.map((b, i) => {
      const id = b.id && !seen.has(b.id) ? b.id : `call_${prefix}_${i}`
      seen.add(id)
      let c = parseCall(id, b.name, b.args)
      if (!c.invalid && builder.mixed && !b.whole) c = { id, name: c.name, input: undefined, invalid: 'The server mixed up its calls. Nothing was run.' }
      return stop === 'length' || stop === 'refused' ? blockCall(c, stop) : c
    })
    const message = {
      role: 'assistant', content: calls.length && !text ? null : text,
      // arguments that aren't a JSON object would make some servers refuse the whole conversation
      ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.invalid || !building[i].args.trim() ? '{}' : building[i].args } })) } : {}),
    }
    return { message, text, calls, stop, ...(usage ? { usage } : {}) }
  }

  return {
    connectionId: conn.id,
    turn: (t) => runTurn(t.signal, async (began) => {
      assertUsable(conn)
      try { return await attempt(t, began) } catch (e) {
        if (t.signal.aborted) throw abortError()
        if (e instanceof SseTooLarge) throw tooLarge(conn)
        throw e instanceof AssistantError ? e : unreadable(conn)
      }
    }),
    toolResults: (calls) => calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: c.isError ? `Error: ${c.text}` : c.text })),
    async listModels(signal) {
      assertUsable(conn)
      const res = await fetch(`${base}/models`, { headers, signal })
      const body = await res.text()
      if (!res.ok) throw httpError(conn, res.status, body)
      try {
        const ids = (JSON.parse(body) as { data: { id?: unknown }[] }).data.map((m) => m.id).filter((x): x is string => typeof x === 'string' && x !== '')
        return [...new Set(ids)]
      } catch { throw unreadable(conn) }
    },
  }
}
