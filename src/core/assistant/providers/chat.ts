/** OpenAI and OpenAI-compatible servers: a small client over {baseUrl}/chat/completions. */
import type { Connection } from '../connections'
import { SseParser } from '../../sse'
import { abortError, AssistantError, assertUsable, blockCall, cutShort, httpError, limited, matchCalls, parseCall, runTurn, unreadable } from './shared'
import type { Provider, Turn, TurnRequest } from './types'

interface Piece { index?: number; id?: string; function?: { name?: string; arguments?: unknown } }
interface Chunk {
  choices?: { delta?: { content?: string | null; refusal?: string | null; tool_calls?: Piece[] | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  error?: unknown
}
interface Building { index?: number; id: string; name: string; args: string; unsure: boolean; unsureIfEmpty: boolean }

const isComplete = (json: string) => { try { JSON.parse(json); return true } catch { return false } }
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * Adds one piece of a call. Servers differ: whole calls or pieces, ids or not, right indexes, none, or all 0. Two calls must
 * never become one, so a piece that could belong to either of two makes them unsure, and an unsure call doesn't run.
 */
function addPiece(calls: Building[], p: Piece): void {
  const id = str(p.id), name = str(p.function?.name), raw = p.function?.arguments
  const args = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw)
  const index = typeof p.index === 'number' ? p.index : undefined
  const sameIndex = (c: Building) => index === undefined || c.index === undefined || c.index === index
  const add = (unsureIfEmpty = false) => { calls.push({ index, id, name, args, unsureIfEmpty, unsure: false }) }

  const byId = id ? calls.filter((c) => c.id === id && sameIndex(c)) : []
  // no call has this id yet: it can only finish one that came without an id, at the same index
  const at = byId.length ? byId : index !== undefined ? calls.filter((c) => c.index === index && !(id && c.id)) : id ? [] : calls
  const cur = at.at(-1)
  if (!cur || (name && cur.name && name !== cur.name)) { add(); return }
  if (name && cur.name && !byId.length) { // the name again: another call, or the same one's next piece?
    if (!cur.args) { cur.unsureIfEmpty = true; add(); return }
    if (isComplete(cur.args) && (!args.trim() || args.trimStart().startsWith('{'))) { add(true); return }
  }
  if (args.trim() || (name && !cur.name)) {
    const open = at.filter((c) => !c.unsureIfEmpty && !isComplete(c.args))
    if (open.length > 1) for (const c of open) c.unsure = true
  }
  cur.id ||= id
  cur.name ||= name
  cur.args += args
}

const STOPS = new Map<string, Turn['stop']>(Object.entries({
  stop: 'end', eos_token: 'end', stop_sequence: 'end', tool_calls: 'tools', function_call: 'tools', length: 'length', content_filter: 'refused',
}))

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
    const building: Building[] = []
    const parser = new SseParser(), decoder = new TextDecoder(), reader = res.body.getReader()
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
      for (const p of d.tool_calls ?? []) { began(); addPiece(building, p) }
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
      if (!c.invalid && (b.unsure || (b.unsureIfEmpty && !b.args.trim()))) c = { id, name: c.name, input: undefined, invalid: 'The server mixed up its calls. Nothing was run.' }
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
    turn: (t) => runTurn(t.signal, async (began) => {
      assertUsable(conn)
      try { return await attempt(t, began) } catch (e) {
        if (t.signal.aborted) throw abortError()
        throw e instanceof AssistantError ? e : unreadable(conn)
      }
    }),
    toolResults: (calls) => calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: c.isError ? `Error: ${c.text}` : c.text })),
    async listModels() {
      assertUsable(conn)
      const res = await fetch(`${base}/models`, { headers })
      const body = await res.text()
      if (!res.ok) throw httpError(conn, res.status, body)
      try {
        const ids = (JSON.parse(body) as { data: { id?: unknown }[] }).data.map((m) => m.id).filter((x): x is string => typeof x === 'string' && x !== '')
        return [...new Set(ids)]
      } catch { throw unreadable(conn) }
    },
  }
}
