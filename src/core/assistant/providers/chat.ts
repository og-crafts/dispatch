/** OpenAI and OpenAI-compatible servers: a small client over {baseUrl}/chat/completions. */
import type { Connection } from '../connections'
import { SseParser } from '../../sse'
import { abortError, AssistantError, assertUsable, blockCall, cutShort, httpError, parseCall, runTurn, unreadable } from './shared'
import type { Provider, Turn, TurnRequest } from './types'

interface Piece { index?: number; id?: string; function?: { name?: string; arguments?: unknown } }
interface Chunk {
  choices?: { delta?: { content?: string | null; refusal?: string | null; tool_calls?: Piece[] | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  error?: unknown
}
interface Building { index?: number; id: string; name: string; args: string }

const isComplete = (json: string) => { try { JSON.parse(json); return true } catch { return false } }

/** Adds one piece of a call. Servers differ: whole calls or pieces, ids or not, right indexes, none, or all 0. */
function addPiece(calls: Building[], p: Piece): void {
  const id = p.id ?? '', name = p.function?.name ?? '', raw = p.function?.arguments
  const args = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw)
  let cur: Building | undefined
  if (id) cur = calls.find((c) => c.id === id)
  if (!cur && typeof p.index === 'number') cur = calls.filter((c) => c.index === p.index).at(-1)
  else if (!cur && !id) cur = calls.at(-1)
  const another = cur && ((id && cur.id && id !== cur.id) || (!id && name && args.trimStart().startsWith('{') && isComplete(cur.args)))
  if (!cur || another) { calls.push({ index: p.index, id, name, args }); return }
  cur.id ||= id
  cur.name ||= name
  cur.args += args
}

const STOPS: Record<string, Turn['stop']> = {
  stop: 'end', eos_token: 'end', stop_sequence: 'end', tool_calls: 'tools', function_call: 'tools', length: 'length', content_filter: 'refused',
}

export function chatProvider(conn: Connection, fetch: typeof globalThis.fetch): Provider {
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
      if (choice.finish_reason) finish = choice.finish_reason
    }
    try {
      while (!done) {
        const r = await reader.read()
        // the end of the stream also ends a last line the server left open
        for (const ev of parser.push(r.done ? `${decoder.decode()}\n\n` : decoder.decode(r.value, { stream: true }))) { take(ev.data); if (done) break }
        if (r.done) break
      }
    } finally { reader.cancel().catch(() => {}) }

    let stop = finish ? STOPS[finish] : undefined
    if (!done || !finish) throw cutShort(conn)
    if (!stop) throw unreadable(conn)
    if (refusal) stop = 'refused'
    else if (stop === 'end' && building.length) stop = 'tools'
    else if (stop === 'tools' && !building.length) stop = 'end'

    const prefix = globalThis.crypto.randomUUID().slice(0, 8) // only for servers that send no ids, or the same one twice
    const seen = new Set<string>()
    const calls = building.map((b, i) => {
      const id = b.id && !seen.has(b.id) ? b.id : `call_${prefix}_${i}`
      seen.add(id)
      const c = parseCall(id, b.name, b.args)
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
