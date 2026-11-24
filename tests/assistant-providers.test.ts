import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newConnection, type Connection } from '../src/core/assistant/connections'
import { nativeFetch } from '../src/core/assistant/nativeFetch'
import { createProvider } from '../src/core/assistant/providers'
import type { Provider, ToolSpec } from '../src/core/assistant/providers/types'

// ---- a fake Rust side: ai_stream plays a script into the channel ----
type Script = { status?: number; headers?: [string, string][]; chunks?: Uint8Array[]; then?: 'end' | 'hang' | { error: string }; reject?: string; noHead?: boolean }
type Req = { id: number; method: string; url: string; origin: string; headers: [string, string][]; body: string | null; proxy: string | null; noProxy: string | null; caCertsPem: string[] }
type Ev = { kind: string; [k: string]: unknown }
const rust = vi.hoisted(() => ({
  scripts: [] as unknown[], sent: [] as unknown[], cancelled: [] as number[], channels: [] as { emit(e: unknown): void }[],
}))
vi.mock('@tauri-apps/api/core', () => {
  class Channel { onmessage: (e: unknown) => void; constructor(cb?: (e: unknown) => void) { this.onmessage = cb ?? (() => {}) } emit(e: unknown) { this.onmessage(e) } }
  return {
    Channel,
    invoke: async (cmd: string, args: { id: number; req: Req; onEvent: Channel }) => {
      if (cmd === 'ai_cancel') { rust.cancelled.push(args.id); return }
      rust.sent.push(args.req); rust.channels.push(args.onEvent)
      const s = rust.scripts.shift() as Script | undefined
      if (!s) throw new Error('no script left')
      if (s.reject) throw s.reject
      await Promise.resolve()
      if (!s.noHead) args.onEvent.emit({ kind: 'head', status: s.status ?? 200, headers: s.headers ?? [['content-type', 'text/event-stream']] })
      for (const c of s.chunks ?? []) args.onEvent.emit({ kind: 'chunk', base64: Buffer.from(c).toString('base64') })
      const then = s.then ?? 'end'
      if (then === 'end') args.onEvent.emit({ kind: 'end' })
      else if (then !== 'hang') args.onEvent.emit({ kind: 'error', message: then.error })
    },
  }
})

const KEY = 'sk-ant-planted-KEY-123456'
const net = { proxyUrl: '', proxyBypass: '', caCerts: [] as string[] }
const conn = (kind: Connection['kind'], over: Partial<Connection> = {}): Connection =>
  ({ ...newConnection(kind), name: 'Work', model: kind === 'anthropic' ? 'claude-opus-5-5' : 'm1', key: kind === 'compatible' ? '' : KEY, ...over })
const enc = (s: string) => new TextEncoder().encode(s)
const bytes = (s: string) => Array.from(enc(s), (b) => Uint8Array.of(b))
const play = (...s: Script[]) => rust.scripts.push(...s)
const text = (body: string) => ({ chunks: bytes(body) })
const reqs = () => rust.sent as Req[]
const bodyOf = (i = 0) => JSON.parse(reqs()[i].body!)
const header = (r: Req, n: string) => r.headers.find(([k]) => k.toLowerCase() === n)?.[1]
const tools: ToolSpec[] = [{ name: 'get', description: 'Gets', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }]
const turn = (p: Provider, over: Partial<Parameters<Provider['turn']>[0]> = {}) =>
  p.turn({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools, signal: new AbortController().signal, onText: () => {}, ...over })
const failure = async (p: Promise<unknown>): Promise<Error> => { try { await p } catch (e) { return e as Error } throw new Error('it did not reject') }
/** Everything reachable from a thrown value, so a key can't hide in a nested property. */
function dump(v: unknown, seen = new Set<unknown>()): string {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return String(v)
  if (seen.has(v)) return ''
  seen.add(v)
  if (v instanceof Headers) return JSON.stringify([...v])
  return Reflect.ownKeys(v).map((k) => { try { return `${String(k)}=${dump((v as Record<PropertyKey, unknown>)[k], seen)}` } catch { return '' } }).join('\n')
}

beforeEach(() => { rust.scripts.length = 0; rust.sent.length = 0; rust.cancelled.length = 0; rust.channels.length = 0 })
afterEach(() => { vi.useRealTimers() })

// ---- recorded streams ----
const sse = (evs: { type: string }[]) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const start = (over: object = {}) => ({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 1 }, ...over } })
const open = (index: number, content_block: object) => ({ type: 'content_block_start', index, content_block })
const delta = (index: number, d: object) => ({ type: 'content_block_delta', index, delta: d })
const close = (index: number) => ({ type: 'content_block_stop', index })
const done = (stop_reason: string | null, usage: object = { output_tokens: 15 }) => [{ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage }, { type: 'message_stop' }]
const aText = sse([start(), open(0, { type: 'text', text: '' }), { type: 'ping' }, delta(0, { type: 'text_delta', text: 'Héllo ' }), delta(0, { type: 'text_delta', text: '🌍 wörld' }), close(0), ...done('end_turn')])
const aTools = (two = '{"a": 2}', stop = 'tool_use') => sse([start(),
  open(0, { type: 'thinking', thinking: '', signature: '' }), delta(0, { type: 'thinking_delta', thinking: 'let me ' }), delta(0, { type: 'thinking_delta', thinking: 'see' }), delta(0, { type: 'signature_delta', signature: 'c2ln' }), close(0),
  open(1, { type: 'redacted_thinking', data: 'opaque' }), close(1),
  open(2, { type: 'text', text: '' }), delta(2, { type: 'text_delta', text: 'On it' }), close(2),
  open(3, { type: 'tool_use', id: 'tu_1', name: 'get', input: {} }), delta(3, { type: 'input_json_delta', partial_json: '' }), delta(3, { type: 'input_json_delta', partial_json: '{"a"' }), delta(3, { type: 'input_json_delta', partial_json: ': 1}' }), close(3),
  open(4, { type: 'tool_use', id: 'tu_2', name: 'get', input: {} }), delta(4, { type: 'input_json_delta', partial_json: two }), close(4),
  ...done(stop)])

const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
const chat = (objs: object[], end = 'data: [DONE]\n\n') => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + end
const usage = { id: 'c1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }
const cText = chat([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Héllo ' }), chunk({ content: '🌍 wörld' }), chunk({}, 'stop'), usage])
const cTools = chat([chunk({ role: 'assistant', content: 'On it' }),
  chunk({ tool_calls: [{ index: 0, id: 'c_1', type: 'function', function: { name: 'get', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }),
  chunk({ tool_calls: [{ index: 1, id: 'c_2', type: 'function', function: { name: 'get', arguments: '{"a": 2}' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: ': 1}' } }] }),
  chunk({}, 'tool_calls'), usage])

describe('nativeFetch', () => {
  it('sends the request to Rust and streams the answer as it comes', async () => {
    play({ chunks: [], then: 'hang', headers: [['X-A', '1']] })
    const c = conn('compatible', { key: '' })
    const res = await nativeFetch(c, { proxyUrl: 'http://p:1', proxyBypass: 'x', caCerts: ['PEM', ' '] })('http://localhost:11434/v1/chat/completions', { method: 'POST', headers: { 'X-B': '2' }, body: '{}' })
    expect(res).toBeInstanceOf(Response)
    expect(res.headers.get('x-a')).toBe('1')
    const r = reqs()[0]
    expect(r).toMatchObject({ method: 'POST', url: 'http://localhost:11434/v1/chat/completions', origin: 'http://localhost:11434', body: '{}', proxy: 'http://p:1', noProxy: 'x', caCertsPem: ['PEM'] })
    expect(header(r, 'x-b')).toBe('2')
    expect(Number.isSafeInteger(r.id) && r.id >= 0).toBe(true)
    const reader = res.body!.getReader()
    rust.channels[0].emit({ kind: 'chunk', base64: Buffer.from([0, 255]).toString('base64') } satisfies Ev)
    expect([...(await reader.read()).value!]).toEqual([0, 255])
    rust.channels[0].emit({ kind: 'end' })
    expect((await reader.read()).done).toBe(true)
  })
  it('uses a new id each time', async () => {
    play(...Array.from({ length: 20 }, () => text('')))
    const f = nativeFetch(conn('compatible'), net)
    for (let i = 0; i < 20; i++) await f('http://localhost:11434/v1/models')
    expect(new Set(reqs().map((r) => r.id)).size).toBe(20)
  })
  it('a non-2xx answer carries its body; bodiless statuses work', async () => {
    play({ status: 418, ...text('teapot') }, { status: 204 })
    const f = nativeFetch(conn('compatible'), net)
    const r = await f('http://localhost:11434/v1/models')
    expect([r.status, await r.text()]).toEqual([418, 'teapot'])
    expect((await f('http://localhost:11434/v1/models')).status).toBe(204)
  })
  it('both failure paths are a clean rejection without the key', async () => {
    const f = nativeFetch(conn('openai'), net)
    play({ reject: `refused ${KEY}` }, { noHead: true, then: { error: `dns ${KEY}` } })
    for (let i = 0; i < 2; i++) {
      const e = await failure(f('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${KEY}` } }))
      expect(e).toBeInstanceOf(Error)
      expect(e.message).toMatch(i ? /dns/ : /refused/)
      expect(dump(e)).not.toContain(KEY)
    }
  })
  it('an error after the head fails the body', async () => {
    play({ chunks: [enc('part')], then: { error: 'reset' } })
    const r = await nativeFetch(conn('compatible'), net)('http://localhost:11434/v1/models')
    expect((await failure(r.text())).message).toContain('reset')
  })
  it('refuses before calling Rust', async () => {
    const cases: [Connection, string, RegExp][] = [
      [conn('compatible', { baseUrl: 'http://example.com/v1' }), 'http://example.com/v1/models', /https/],
      [conn('compatible', { baseUrl: 'https://u:p@example.com' }), 'https://example.com/models', /user name/],
      [conn('openai'), 'https://evil.com/v1/models', /address/],
      [conn('openai'), 'https://api.openai.com:444/v1/models', /address/],
      [conn('openai'), 'https://u:p@api.openai.com/v1/models', /address/],
      [conn('openai', { key: ' ' }), 'https://api.openai.com/v1/models', /key/],
      [conn('openai', { keyLost: true }), 'https://api.openai.com/v1/models', /^Enter the key again for Work\.$/],
      [conn('compatible', { keyLost: true }), 'http://localhost:11434/v1/models', /^Enter the key again for Work\.$/],
      [conn('openai', { key: 'sk-“bad”' }), 'https://api.openai.com/v1/models', /characters/],
    ]
    for (const [c, url, msg] of cases) expect((await failure(nativeFetch(c, net)(url))).message, url).toMatch(msg)
    expect(rust.sent).toEqual([])
  })
  it('abort cancels in Rust, rejects within a tick and drops later events', async () => {
    play({ noHead: true, then: 'hang' }, { then: 'hang' })
    const f = nativeFetch(conn('compatible'), net)
    const a = new AbortController()
    const p = f('http://localhost:11434/v1/models', { signal: a.signal })
    p.catch(() => {})
    await vi.waitFor(() => expect(rust.sent.length).toBe(1))
    a.abort()
    expect(await Promise.race([failure(p).then((e) => e.name), new Promise((r) => setTimeout(() => r('late'), 0))])).toBe('AbortError')
    rust.channels[0].emit({ kind: 'head', status: 200, headers: [] })
    expect(rust.cancelled).toEqual([reqs()[0].id])

    const b = new AbortController()
    const res = await f('http://localhost:11434/v1/models', { signal: b.signal })
    const read = res.body!.getReader().read()
    b.abort()
    expect((await failure(read)).name).toBe('AbortError')
    rust.channels[1].emit({ kind: 'chunk', base64: 'AAAA' })
    rust.channels[1].emit({ kind: 'end' })
    expect(rust.cancelled).toEqual(reqs().map((r) => r.id))
  })
  it('an already stopped call never reaches Rust; abort after the end cancels nothing; a dropped body cancels', async () => {
    const f = nativeFetch(conn('compatible'), net)
    expect((await failure(f('http://localhost:11434/v1/models', { signal: AbortSignal.abort() }))).name).toBe('AbortError')
    expect(rust.sent).toEqual([])
    play(text('x'), { then: 'hang' })
    const a = new AbortController()
    await (await f('http://localhost:11434/v1/models', { signal: a.signal })).text()
    a.abort()
    expect(rust.cancelled).toEqual([])
    await (await f('http://localhost:11434/v1/models')).body!.cancel()
    expect(rust.cancelled).toEqual([reqs()[1].id])
  })
})

describe('Anthropic', () => {
  const make = (over: Partial<Connection> = {}) => createProvider(conn('anthropic', over), net)

  it('streams text split at every byte, with usage', async () => {
    play(text(aText))
    const got: string[] = []
    const t = await turn(await make(), { onText: (s) => got.push(s) })
    expect(got).toEqual(['Héllo ', '🌍 wörld'])
    expect(t).toMatchObject({ text: 'Héllo 🌍 wörld', calls: [], stop: 'end', usage: { input: 25, output: 15 } })
    expect(t.message).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Héllo 🌍 wörld' }] })
  })
  it('any two-part split gives the same turn', async () => {
    const p = await make()
    const all = enc(aText)
    for (let i = 1; i < all.length; i += 3) {
      play({ chunks: [all.slice(0, i), all.slice(i)] })
      expect((await turn(p)).text).toBe('Héllo 🌍 wörld')
    }
  })
  it('sends what the rules say', async () => {
    play(text(aText))
    await turn(await make())
    const r = reqs()[0], b = bodyOf()
    expect(new URL(r.url).origin + new URL(r.url).pathname).toBe('https://api.anthropic.com/v1/messages')
    expect(r.origin).toBe('https://api.anthropic.com')
    expect(header(r, 'authorization')).toBe(`Bearer ${KEY}`) // SDK 1.x, API version 2026-10-21
    expect(header(r, 'x-api-key')).toBeUndefined()
    expect(header(r, 'host')).toBeUndefined()
    expect(header(r, 'anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(header(r, 'anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(b).toMatchObject({ model: 'claude-opus-5-5', stream: true, system: 'sys', thinking: { type: 'adaptive' }, tool_choice: { type: 'auto' }, fallbacks: 'default',
      messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'get', description: 'Gets', input_schema: tools[0].inputSchema }] })
    expect(JSON.stringify(b)).not.toContain(KEY)
  })
  it('no refusal fallback for another host', async () => {
    play(text(aText))
    await turn(await make({ baseUrl: 'https://gateway.example.com' }))
    expect(header(reqs()[0], 'anthropic-beta')).toBeUndefined()
    expect(bodyOf().fallbacks).toBeUndefined()
    expect(new URL(reqs()[0].url).origin).toBe('https://gateway.example.com')
  })
  it('leaves tools out when there are none', async () => {
    play(text(aText))
    await turn(await make(), { tools: [] })
    expect(bodyOf()).not.toHaveProperty('tools')
    expect(bodyOf()).not.toHaveProperty('tool_choice')
  })
  it('two parallel calls; thinking blocks come back unchanged and are sent unchanged', async () => {
    play(text(aTools()), text(aText))
    const p = await make()
    const t = await turn(p)
    expect(t.stop).toBe('tools')
    expect(t.calls).toEqual([{ id: 'tu_1', name: 'get', input: { a: 1 } }, { id: 'tu_2', name: 'get', input: { a: 2 } }])
    const message = { role: 'assistant', content: [
      { type: 'thinking', thinking: 'let me see', signature: 'c2ln' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'On it' },
      { type: 'tool_use', id: 'tu_1', name: 'get', input: { a: 1 } }, { type: 'tool_use', id: 'tu_2', name: 'get', input: { a: 2 } }] }
    expect(t.message).toEqual(message)
    const results = p.toolResults([{ id: 'tu_1', text: 'one', isError: false }, { id: 'tu_2', text: 'no', isError: true }])
    expect(results).toEqual([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'one', is_error: false }, { type: 'tool_result', tool_use_id: 'tu_2', content: 'no', is_error: true }] }])
    const messages = [{ role: 'user', content: 'hi' }, t.message, ...results]
    const before = JSON.stringify(messages)
    await turn(p, { messages })
    expect(JSON.stringify(messages)).toBe(before)
    expect(bodyOf(1).messages).toEqual(JSON.parse(before))
    expect(p.toolResults([])).toEqual([])
  })
  it('invalid tool JSON is flagged, never a partial object', async () => {
    for (const bad of ['{"a": 1', '{"a": "x" "b"}', '[1]', '"s"', 'null', '{"a":1} trailing']) {
      play(text(aTools(bad)))
      const t = await turn(await make())
      expect(t.calls[0].invalid, bad).toBeUndefined()
      expect(t.calls[1].invalid, bad).toBeTruthy()
      expect(t.calls[1].input, bad).toBeUndefined()
    }
  })
  it('a tool block that never closed is invalid', async () => {
    play(text(sse([start(), open(0, { type: 'tool_use', id: 'x', name: 'get', input: {} }), delta(0, { type: 'input_json_delta', partial_json: '{"a":1}' }), ...done('tool_use')])))
    expect((await turn(await make())).calls[0].invalid).toBeTruthy()
  })
  it('a call without arguments gets an empty object', async () => {
    play(text(sse([start(), open(0, { type: 'tool_use', id: 'x', name: 'get', input: {} }), close(0), ...done('tool_use')])))
    expect((await turn(await make())).calls).toEqual([{ id: 'x', name: 'get', input: {} }])
  })
  it('cut off or refused: no call may run', async () => {
    for (const [reason, stop] of [['max_tokens', 'length'], ['model_context_window_exceeded', 'length'], ['refusal', 'refused']] as const) {
      play(text(aTools('{"a": 2}', reason)))
      const t = await turn(await make())
      expect(t.stop).toBe(stop)
      expect(t.calls.length).toBe(2)
      for (const c of t.calls) { expect(c.invalid).toBeTruthy(); expect(c.input).toBeUndefined() }
    }
  })
  it('a refusal fallback is named, and the declined part’s thinking and calls are not echoed', async () => {
    play(text(sse([start(), open(0, { type: 'thinking', thinking: '', signature: 's' }), close(0), open(1, { type: 'text', text: 'Part' }), close(1),
      open(2, { type: 'tool_use', id: 'old', name: 'get', input: {} }), close(2),
      open(3, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } }), close(3),
      open(4, { type: 'text', text: '' }), delta(4, { type: 'text_delta', text: ' done' }), close(4), ...done('end_turn', { output_tokens: 3, iterations: [{ type: 'fallback_message' }] })])))
    const t = await turn(await make())
    expect(t).toMatchObject({ stop: 'end', calls: [], text: 'Part done', fallbackModel: 'claude-opus-4-8' })
    expect((t.message as { content: { type: string }[] }).content.map((b) => b.type)).toEqual(['text', 'fallback', 'text'])
  })
  it('a sticky fallback (no block) is named too', async () => {
    play(text(sse([start({ model: 'claude-opus-4-8' }), open(0, { type: 'text', text: 'x' }), close(0), ...done('end_turn', { output_tokens: 1, iterations: [{ type: 'fallback_message' }] })])))
    expect((await turn(await make())).fallbackModel).toBe('claude-opus-4-8')
  })
  it('rejects when the stream ends early, at any event', async () => {
    const parts = aTools().split(/(?<=\n\n)/)
    for (let i = 0; i < parts.length; i++) {
      play({ chunks: [enc(parts.slice(0, i).join(''))] })
      expect((await failure(turn(await make()))).message, String(i)).toMatch(/finished|answer/)
    }
    play(text(sse([start(), ...done(null)])))
    await failure(turn(await make()))
    play(text(sse([start(), ...done('pause_turn')])))
    await failure(turn(await make()))
  })
  it('CRLF lines and comments are fine, split at every byte', async () => {
    play(text(`: hi\r\n\r\n${aText.replaceAll('\n', '\r\n').replaceAll('\r\n\r\n', '\r\n\r\n: ping\r\n\r\n')}`))
    expect(await turn(await make())).toMatchObject({ text: 'Héllo 🌍 wörld', stop: 'end' })
  })
  it('stop and error names that name an object member aren’t accepted', async () => {
    for (const f of ['constructor', 'toString']) {
      play(text(sse([start(), ...done(f)])))
      expect((await failure(turn(await make()))).message, f).toContain('couldn’t read')
      play(text(`event: error\ndata: {"type":"error","error":{"type":"${f}","message":"m"}}\n\n`))
      expect(await failure(turn(await make())), f).toMatchObject({ status: undefined, message: 'Work couldn’t use this request: m' })
    }
  })
  it('the stop follows the calls', async () => {
    play(text(aTools('{"a": 2}', 'end_turn')), text(aText.replace('end_turn', 'tool_use')))
    expect((await turn(await make())).stop).toBe('tools')
    expect((await turn(await make())).stop).toBe('end')
  })
  it('empty text blocks aren’t sent back', async () => {
    play(text(sse([start(), open(0, { type: 'thinking', thinking: 't', signature: 's' }), close(0), open(1, { type: 'text', text: '' }), close(1), open(2, { type: 'tool_use', id: 'x', name: 'get', input: {} }), close(2), ...done('tool_use')])))
    expect(((await turn(await make())).message as { content: { type: string }[] }).content.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
  })
  it('asks for prompt caching, only on the Anthropic host', async () => {
    play(text(aText), text(aText))
    await turn(await make())
    expect(bodyOf().cache_control).toEqual({ type: 'ephemeral' })
    await turn(await make({ baseUrl: 'https://gateway.example.com' }))
    expect(bodyOf(1)).not.toHaveProperty('cache_control')
  })
  it('lists models, following pages', async () => {
    const page = (ids: string[], more: boolean) => text(JSON.stringify({ data: ids.map((id) => ({ id, type: 'model' })), has_more: more, first_id: ids[0], last_id: ids.at(-1) }))
    const json: [string, string][] = [['content-type', 'application/json']]
    play({ ...page(['a', 'b'], true), headers: json }, { ...page(['c'], false), headers: json })
    expect(await (await make()).listModels()).toEqual(['a', 'b', 'c'])
    expect(reqs()[0].method).toBe('GET')
  })
})

describe('chat completions', () => {
  const make = (over: Partial<Connection> = {}, kind: 'openai' | 'compatible' = 'compatible') => createProvider(conn(kind, over), net)

  it('streams text split at every byte, with usage', async () => {
    play(text(cText))
    const got: string[] = []
    const t = await turn(await make(), { onText: (s) => got.push(s) })
    expect(got).toEqual(['Héllo ', '🌍 wörld'])
    expect(t).toEqual({ message: { role: 'assistant', content: 'Héllo 🌍 wörld' }, text: 'Héllo 🌍 wörld', calls: [], stop: 'end', usage: { input: 11, output: 7 } })
  })
  it('any two-part split, and CRLF lines, give the same turn', async () => {
    const p = await make()
    for (const s of [cText, cText.replaceAll('\n', '\r\n')]) {
      const all = enc(s)
      for (let i = 1; i < all.length; i++) {
        play({ chunks: [all.slice(0, i), all.slice(i)] })
        expect((await turn(p)).text).toBe('Héllo 🌍 wörld')
      }
    }
  })
  it('sends what the rules say; OpenAI gets its key', async () => {
    play(text(cText), text(cText))
    await turn(await make({}, 'openai'))
    expect(reqs()[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(header(reqs()[0], 'authorization')).toBe(`Bearer ${KEY}`)
    expect(bodyOf()).toEqual({ model: 'm1', stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get', description: 'Gets', parameters: tools[0].inputSchema } }] })
    await turn(await make({ baseUrl: 'http://localhost:1234/v1/' }), { tools: [] })
    expect(reqs()[1].url).toBe('http://localhost:1234/v1/chat/completions')
    expect(header(reqs()[1], 'authorization')).toBeUndefined()
    expect(bodyOf(1)).not.toHaveProperty('tools')
  })
  it('a compatible connection with a key sends it', async () => {
    play(text(cText))
    await turn(await make({ key: ' k1 ' }))
    expect(header(reqs()[0], 'authorization')).toBe('Bearer k1')
  })
  it('two parallel calls in pieces', async () => {
    play(text(cTools))
    const p = await make()
    const t = await turn(p)
    expect(t).toMatchObject({ stop: 'tools', text: 'On it', usage: { input: 11, output: 7 } })
    expect(t.calls).toEqual([{ id: 'c_1', name: 'get', input: { a: 1 } }, { id: 'c_2', name: 'get', input: { a: 2 } }])
    expect(t.message).toEqual({ role: 'assistant', content: 'On it', tool_calls: [
      { id: 'c_1', type: 'function', function: { name: 'get', arguments: '{"a": 1}' } }, { id: 'c_2', type: 'function', function: { name: 'get', arguments: '{"a": 2}' } }] })
    expect(p.toolResults([{ id: 'c_1', text: 'one', isError: false }, { id: 'c_2', text: 'no', isError: true }])).toEqual([
      { role: 'tool', tool_call_id: 'c_1', content: 'one' }, { role: 'tool', tool_call_id: 'c_2', content: 'Error: no' }])
  })
  it('whole calls without ids or usage, all at index 0, object arguments, finish "stop"', async () => {
    play(text(chat([chunk({ tool_calls: [{ index: 0, function: { name: 'get', arguments: '{"a":1}' } }] }), { choices: [] }, { id: 'x' },
      chunk({ tool_calls: [{ index: 0, function: { name: 'get', arguments: { a: 2 } } }] }), chunk({}, 'stop')])))
    const t = await turn(await make())
    expect(t.stop).toBe('tools')
    expect(t.usage).toBeUndefined()
    expect(t.calls.map((c) => c.input)).toEqual([{ a: 1 }, { a: 2 }])
    const ids = t.calls.map((c) => c.id)
    expect(ids.every(Boolean) && new Set(ids).size === 2).toBe(true)
    expect((t.message as { tool_calls: { id: string }[] }).tool_calls.map((c) => c.id)).toEqual(ids)
  })
  it('calls without an index, different ids at one index, and a name repeated on each piece', async () => {
    const f = (name: string, args: string) => ({ function: { name, arguments: args } })
    play(text(chat([chunk({ tool_calls: [{ ...f('get', '{"a":1}') }, { ...f('get', '{"a":2}') }] }), chunk({}, 'tool_calls')])),
      text(chat([chunk({ tool_calls: [{ index: 0, id: 'p', ...f('get', '{"a":1}') }] }), chunk({ tool_calls: [{ index: 0, id: 'q', ...f('get', '{"a":2}') }] }), chunk({}, 'tool_calls')])),
      text(chat([chunk({ tool_calls: [{ index: 0, id: 'p', ...f('get', '{"a"') }] }), chunk({ tool_calls: [{ index: 0, id: 'p', ...f('get', ':1}') }] }), chunk({}, 'tool_calls')])))
    const p = await make()
    expect((await turn(p)).calls.map((c) => c.input)).toEqual([{ a: 1 }, { a: 2 }])
    expect((await turn(p)).calls).toEqual([{ id: 'p', name: 'get', input: { a: 1 } }, { id: 'q', name: 'get', input: { a: 2 } }])
    expect((await turn(p)).calls).toEqual([{ id: 'p', name: 'get', input: { a: 1 } }])
  })
  it('invalid tool JSON is flagged; no arguments is an empty object', async () => {
    const one = (args: string) => chat([chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'get', arguments: args } }] }), chunk({}, 'tool_calls')])
    const p = await make()
    for (const bad of ['{"a": 1', '[1]', 'null', '{"a":1}}']) {
      play(text(one(bad)))
      const c = (await turn(p)).calls[0]
      expect(c.invalid, bad).toBeTruthy()
      expect(c.input, bad).toBeUndefined()
    }
    play(text(one('')))
    expect((await turn(p)).calls).toEqual([{ id: 'c', name: 'get', input: {} }])
  })
  it('a call without a name is invalid', async () => {
    play(text(chat([chunk({ tool_calls: [{ index: 0, id: 'c', function: { arguments: '{}' } }] }), chunk({}, 'tool_calls')])))
    expect((await turn(await make())).calls[0].invalid).toBeTruthy()
  })
  it('cut off or refused: no call may run', async () => {
    for (const [reason, stop] of [['length', 'length'], ['content_filter', 'refused']] as const) {
      play(text(cTools.replace('"tool_calls"}', `"${reason}"}`)))
      const t = await turn(await make())
      expect(t.stop).toBe(stop)
      for (const c of t.calls) { expect(c.invalid).toBeTruthy(); expect(c.input).toBeUndefined() }
    }
    play(text(chat([chunk({ refusal: 'I can’t ' }), chunk({ refusal: 'help' }), chunk({}, 'stop')])))
    expect(await turn(await make())).toMatchObject({ stop: 'refused', text: 'I can’t help' })
  })
  it('rejects when the stream ends early, isn’t readable or reports an error', async () => {
    const p = await make()
    for (const s of [chat([chunk({ content: 'x' }), chunk({}, 'stop')], 'data: {"ch'), chat([chunk({ content: 'x' })], ''), chat([chunk({ content: 'x' })]), 'data: {oops\n\n', '{"choices":[]}', '']) {
      play(text(s))
      expect((await failure(turn(p))).message.length, s).toBeGreaterThan(10)
    }
    play(text(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\ndata: ${JSON.stringify({ error: { message: `boom ${KEY}` } })}\n\n`))
    expect(dump(await failure(turn(await make({ key: KEY }))))).not.toContain(KEY)
  })
  it('a finish reason and a clean end is complete without [DONE]; a lost connection after it is not', async () => {
    const s = chat([chunk({ content: 'x' }), chunk({}, 'stop')], '')
    play(text(s), { ...text(s), then: { error: 'reset' } })
    expect(await turn(await make())).toMatchObject({ text: 'x', stop: 'end' })
    expect((await failure(turn(await make()))).message).toContain('reset')
  })
  it('a terminator without its last line break counts', async () => {
    play(text(chat([chunk({ content: 'x' }), chunk({}, 'stop')], 'data: [DONE]')))
    expect((await turn(await make())).text).toBe('x')
  })
  const calls = async (...pieces: object[]) => {
    play(text(chat([...pieces.map((p) => chunk({ tool_calls: [p] })), chunk({}, 'tool_calls')])))
    return (await turn(await make())).calls.map((c) => [c.name, c.invalid ? 'invalid' : c.input])
  }
  const fn = (name: string, args: string, more: object = {}) => ({ ...more, function: { name, arguments: args } })
  it('whole calls in one piece each are kept apart; a call without arguments among unclear ones doesn’t run', async () => {
    for (const more of [{ index: 0 }, {}, { index: 0, id: 'x' }, { id: 'x' }]) {
      const label = JSON.stringify(more)
      expect(await calls(fn('list', '{"y":1}', more), fn('send', '{"x":1}', more)), label).toEqual([['list', { y: 1 }], ['send', { x: 1 }]])
      expect(await calls(fn('list', '', more), fn('send', '{"x":1}', more)), label).toEqual([['list', 'invalid'], ['send', { x: 1 }]])
      expect(await calls(fn('send', '{"x":1}', more), fn('list', '', more)), label).toEqual([['send', { x: 1 }], ['list', 'invalid']])
      expect(await calls(fn('get', '{"a":1}', more), fn('get', '{"a":2}', more)), label).toEqual([['get', { a: 1 }], ['get', { a: 2 }]])
    }
  })
  it('one call in pieces works without an id or index, also with its name repeated', async () => {
    const bare = (args: string) => ({ function: { arguments: args } })
    expect(await calls(fn('get', '{"a"'), bare(':{"b"'), bare(':1}}'))).toEqual([['get', { a: { b: 1 } }]])
    expect(await calls(fn('get', ''), bare('{"a":1}'))).toEqual([['get', { a: 1 }]])
    expect(await calls(fn('get', '{"a"'), fn('get', ':1}'))).toEqual([['get', { a: 1 }]])
    expect(await calls(fn('get', ''))).toEqual([['get', {}]])
  })
  it('a repeated name whose piece could be another call leaves nothing to run', async () => {
    expect((await calls(fn('get', '{"a":'), fn('get', '{"b":1}'), fn('get', '}'))).every((c) => c[1] === 'invalid')).toBe(true)
  })
  it('arguments never go to a call they may not belong to', async () => {
    for (const more of [{ index: 0 }, {}]) {
      const bare = { ...more, function: { arguments: '{"x":1}' } }
      const valid = async (...p: object[]) => (await calls(...p)).filter((c) => c[1] !== 'invalid')
      expect(await valid(fn('get', '{"a":1}', more), fn('get', '', more), fn('send', '', more), bare)).toEqual([['get', { a: 1 }]])
      expect(await valid(fn('get', '', more), fn('get', '{"a":1}', more), fn('send', '', more), bare)).toEqual([['get', { a: 1 }]])
      expect(await valid(fn('list', '', more), fn('send', '', more), bare)).toEqual([])
      expect(await valid(bare, fn('send', '', more))).toEqual([])
      expect(await valid({ id: 'a', function: { arguments: '{"x":1}' } }, fn('send', ''))).toEqual([])
      expect(await valid({ index: 0, id: 'a', function: { arguments: '{"x":1}' } }, fn('send', ''))).toEqual([])
      expect(await valid(fn('list', '', more), fn('send', '', more), fn('list', '{"x":1}', more))).toEqual([['list', { x: 1 }]])
      expect(await valid(fn('get', '{"a":1}', more), bare)).toEqual([['get', { a: 1 }]])
    }
  })
  it('a streamed call with its own index or id is whole, however the pieces interleave', async () => {
    const bare = (args: string, more: object) => ({ ...more, function: { arguments: args } })
    for (const key of [(i: number) => ({ index: i }), (i: number) => ({ id: `c${i}` }), (i: number) => ({ index: i, id: `c${i}` })])
      expect(await calls(fn('get', '', key(0)), fn('get', '{"a"', key(1)), bare('{"a":1', key(0)), bare(':2}', key(1)), bare('}', key(0)))).toEqual([['get', { a: 1 }], ['get', { a: 2 }]])
  })
  it('any interleaving: a valid call is one that was sent', async () => {
    let seed = 7
    const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n }
    const argsOf = ['', '{}', '{"a":1}', '{"x":"y"}', '{"a":{"b":[1,{}]}}', '{"s":"{}"}', '{"s":""}', '{"x":1}']
    const sse2 = (pieces: object[]) => ({ chunks: [enc(chat([...pieces.map((p) => chunk({ tool_calls: [p] })), chunk({}, 'tool_calls')]))] })
    const p = await make()
    let valid = 0
    for (let round = 0; round < 4000; round++) {
      const mode = rnd(9), repeatName = rnd(3) === 0, repeatId = rnd(2) === 0
      const sent = Array.from({ length: 2 + rnd(2) }, () => ({ name: ['get', 'send', 'list'][rnd(3)], args: argsOf[rnd(argsOf.length)] }))
      const queues = sent.map(({ name, args }, i) => {
        const parts: string[] = rnd(3) === 0 ? [args] : rnd(2) ? ['', args] : []
        if (!parts.length) { let rest = args; do { const n = 1 + rnd(rest.length || 1); parts.push(rest.slice(0, n)); rest = rest.slice(n) } while (rest) }
        return parts.map((a, k) => ({
          ...([0, 1, 6].includes(mode) ? { index: i } : [2, 3, 7].includes(mode) ? { index: 0 } : {}),
          ...(k === 0 || repeatId ? ([1, 3, 4].includes(mode) ? { id: `c${i}` } : [6, 7, 8].includes(mode) ? { id: 'x' } : {}) : {}),
          function: { ...(k === 0 || repeatName ? { name } : {}), arguments: a },
        }))
      })
      const pieces: object[] = []
      while (queues.some((q) => q.length)) { const q = queues[rnd(queues.length)]; if (q.length) pieces.push(q.shift()!) }
      play(sse2(pieces))
      const t = await turn(p)
      for (const c of t.calls.filter((x) => !x.invalid)) {
        valid++
        const left = sent.findIndex((x) => x.name === c.name && JSON.stringify(JSON.parse(x.args || '{}')) === JSON.stringify(c.input))
        expect(left, `${JSON.stringify(pieces)} gave ${c.name}(${JSON.stringify(c.input)})`).toBeGreaterThanOrEqual(0)
        sent.splice(left, 1) // and each only once
      }
    }
    expect(valid).toBeGreaterThan(1000)
  }, 60_000)
  it('an event built of endless data lines is cut short', async () => {
    play({ chunks: Array.from({ length: 5 }, () => enc(`data: ${'x'.repeat(1_000_000)}\n`)), then: 'hang' })
    expect((await failure(turn(await make()))).message).toBe('Work sent an answer that’s too large to read.')
    expect(rust.cancelled.length).toBe(1)
  }, 30_000)
  it('one id at two indexes is two calls', async () => {
    expect(await calls(fn('get', '', { index: 0, id: 'x' }), fn('get', '{"a":2}', { index: 1, id: 'x' }), { index: 0, function: { arguments: '{"a":1}' } })).toEqual([['get', { a: 1 }], ['get', { a: 2 }]])
  })
  it('a call without a name goes back under a placeholder', async () => {
    play(text(chat([chunk({ tool_calls: [{ index: 0, id: 'c', function: { arguments: '{}' } }] }), chunk({}, 'tool_calls')])))
    const t = await turn(await make())
    expect(t.calls[0]).toMatchObject({ name: 'unknown_tool', input: undefined })
    expect((t.message as { tool_calls: { function: object }[] }).tool_calls[0].function).toEqual({ name: 'unknown_tool', arguments: '{}' })
  })
  it('an unknown finish reason that names an object member isn’t accepted', async () => {
    for (const f of ['constructor', 'toString', '__proto__']) {
      play(text(chat([chunk({ content: 'x' }), chunk({}, f)])))
      expect((await failure(turn(await make()))).message, f).toContain('couldn’t read')
    }
  })
  it('skips comment lines between events', async () => {
    play(text(`: ping\n\n${cText.replaceAll('\n\n', '\n\n: ping\n\n')}`))
    expect((await turn(await make())).text).toBe('Héllo 🌍 wörld')
  })
  it('lists models', async () => {
    play({ ...text(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, {}] })) })
    expect(await (await make()).listModels()).toEqual(['a', 'b'])
    expect(reqs()[0]).toMatchObject({ method: 'GET', url: 'http://localhost:11434/v1/models' })
    play(text('<html>'))
    expect((await failure((await make()).listModels())).message).toContain('Work')
  })
})

describe('failures, for each kind', () => {
  const good = { anthropic: aText, openai: cText }
  for (const kind of ['anthropic', 'openai'] as const) {
    const make = (over: Partial<Connection> = {}) => createProvider(conn(kind, over), net)
    const err = (status: number, message = `bad ${KEY}`, extra: object = {}): Script =>
      ({ status, headers: [['content-type', 'application/json'], ['x-echo', KEY]], ...text(JSON.stringify({ type: 'error', error: { type: 'e', message, ...extra } })) })

    it(`${kind}: plain messages by status, never the key`, async () => {
      for (const [status, msg] of [[400, /Work couldn’t use/], [401, /key/], [402, /credit/], [403, /key/], [404, /model/], [413, /too long/], [422, /Work couldn’t use/]] as const) {
        play(err(status))
        const e = await failure(turn(await make()))
        expect(e.message, String(status)).toMatch(msg)
        expect(dump(e), String(status)).not.toContain(KEY)
        expect(e).toMatchObject({ status })
      }
      expect(rust.sent.length).toBe(7) // none was tried again
    })
    it(`${kind}: no credit is told from a rate limit, and not retried`, async () => {
      play(kind === 'anthropic' ? err(400, 'Your credit balance is too low') : err(429, 'x', { code: 'insufficient_quota' }))
      expect((await failure(turn(await make()))).message).toMatch(/credit/)
      expect(rust.sent.length).toBe(1)
    })
    it(`${kind}: 429 and 5xx are tried again before output, then told plainly`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      for (const [status, msg] of [[429, /too many/], [500, /problem/], [503, /problem/], [529, /problem/]] as const) {
        rust.sent.length = 0
        play(err(status), err(status), err(status))
        const p = failure(turn(await make()))
        await vi.advanceTimersByTimeAsync(20_000)
        const e = await p
        expect(e.message).toMatch(msg)
        expect(dump(e)).not.toContain(KEY)
        expect(rust.sent.length).toBe(3)
      }
      play(err(503), text(good[kind]))
      const p = turn(await make())
      await vi.advanceTimersByTimeAsync(20_000)
      expect((await p).text).toBe('Héllo 🌍 wörld')
    })
    it(`${kind}: a long retry-after isn’t waited for`, async () => {
      play({ ...err(429), headers: [['retry-after', '3600']] })
      expect((await failure(turn(await make()))).message).toMatch(/too many/)
      expect(rust.sent.length).toBe(1)
    })
    it(`${kind}: never tried again once output began`, async () => {
      const cut = good[kind].slice(0, good[kind].indexOf('wörld') - 60)
      const bad = kind === 'anthropic' ? `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${KEY}"}}\n\n` : `data: {"error":{"message":"${KEY}","code":503}}\n\n`
      const upTo = cut.slice(0, cut.lastIndexOf('\n\n') + 2)
      expect(upTo).toContain('Héllo')
      play(text(upTo + bad), { chunks: [enc(upTo)], then: { error: 'reset' } })
      for (let i = 0; i < 2; i++) expect(dump(await failure(turn(await make())))).not.toContain(KEY)
      expect(rust.sent.length).toBe(2)
    })
    it(`${kind}: offline and refused by Rust are told plainly, once`, async () => {
      play({ noHead: true, then: { error: 'dns error' } }, { reject: 'The proxy address isn’t valid.' })
      expect((await failure(turn(await make()))).message).toMatch(/reach Work/)
      expect((await failure(turn(await make()))).message).toContain('The proxy address isn’t valid.')
      expect(rust.sent.length).toBe(2)
    })
    it(`${kind}: no key or a lost key sends nothing`, async () => {
      expect((await failure(turn(await make({ key: '' })))).message).toMatch(/key/)
      expect((await failure(turn(await make({ keyLost: true })))).message).toBe('Enter the key again for Work.')
      expect((await failure((await make({ keyLost: true })).listModels())).message).toBe('Enter the key again for Work.')
      const e = await failure(turn(await make({ key: 'sk-“odd”-secret' })))
      expect(e.message).toMatch(/characters/)
      expect(dump(e)).not.toContain('odd')
      expect(rust.sent).toEqual([])
    })
    it(`${kind}: abort rejects within one tick, at every stage, and nothing follows`, async () => {
      const upTo = good[kind].slice(0, good[kind].indexOf('wörld') - 80)
      const stages: Script[] = [{ noHead: true, then: 'hang' }, { then: 'hang' }, { chunks: [enc(upTo)], then: 'hang' }]
      for (const s of stages) {
        rust.sent.length = 0; rust.cancelled.length = 0; rust.channels.length = 0
        play(s)
        const a = new AbortController()
        const got: string[] = []
        const p = failure(turn(await make(), { signal: a.signal, onText: (x) => got.push(x) }))
        await vi.waitFor(() => expect(rust.sent.length).toBe(1))
        if (s.chunks) await vi.waitFor(() => expect(got.length).toBe(1))
        const n = got.length
        a.abort()
        expect(await Promise.race([p.then((e) => e.name), new Promise((r) => setTimeout(() => r('late'), 0))])).toBe('AbortError')
        rust.channels[0].emit({ kind: 'chunk', base64: Buffer.from(good[kind]).toString('base64') })
        await new Promise((r) => setTimeout(r, 5))
        expect(got.length).toBe(n)
        expect(rust.cancelled).toEqual([reqs()[0].id])
      }
      rust.sent.length = 0
      expect((await failure(turn(await make(), { signal: AbortSignal.abort() }))).name).toBe('AbortError')
      expect(rust.sent).toEqual([])
    })
    it(`${kind}: a huge error body or line is cut short, not waited for`, async () => {
      play({ status: 400, chunks: [enc('x'.repeat(70_000))], then: 'hang' }, { chunks: [enc(`data: ${'x'.repeat(2_500_000)}`), enc('x'.repeat(2_500_000))], then: 'hang' })
      expect(await failure(turn(await make()))).toMatchObject({ status: 400 })
      expect((await failure(turn(await make()))).message).toBe('Work sent an answer that’s too large to read.')
      expect(rust.cancelled).toEqual(reqs().map((r) => r.id))
    }, 30_000)
    it(`${kind}: no abort listener is left after a turn`, async () => {
      for (const s of [text(good[kind]), err(401)]) {
        play(s)
        const { signal } = new AbortController()
        let n = 0
        const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal)
        const live = new Set<unknown>()
        signal.addEventListener = ((e: string, f: EventListener, o?: object) => { n++; live.add(f); add(e, f, o) }) as typeof signal.addEventListener
        signal.removeEventListener = ((e: string, f: EventListener) => { live.delete(f); remove(e, f) }) as typeof signal.removeEventListener
        await turn(await make(), { signal }).catch(() => {})
        await new Promise((r) => setTimeout(r, 5))
        expect(n).toBeGreaterThan(0)
        expect(live.size).toBe(0)
      }
    })
    it(`${kind}: abort during the wait before a retry`, async () => {
      play(err(503))
      const a = new AbortController()
      const p = failure(turn(await make(), { signal: a.signal }))
      await new Promise((r) => setTimeout(r, 50))
      a.abort()
      expect((await p).name).toBe('AbortError')
      await new Promise((r) => setTimeout(r, 1200))
      expect(rust.sent.length).toBe(1)
    })
  }
  it('nothing is logged, and no environment key is picked up', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key'); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token'); vi.stubEnv('ANTHROPIC_LOG', 'debug'); vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example')
    play(text(`event: message_start\ndata: {bad ${KEY}\n\n`))
    await failure(turn(await createProvider(conn('anthropic'), net)))
    expect(JSON.stringify(reqs()[0])).not.toMatch(/env-|evil/)
    for (const l of logs) { expect(l).not.toHaveBeenCalled(); l.mockRestore() }
    vi.unstubAllEnvs()
  })
})
