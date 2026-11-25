/** The assistant's hook: what is sent and to whom, whose chat an answer lands in, and what is kept. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../src/core/db'
import { listChats, saveChat, type Chat } from '../src/core/assistant/chats'
import { newConnection, type Connection } from '../src/core/assistant/connections'
import { CookieJars } from '../src/core/cookies'
import { defaultSettings, kv, newCollection, newEnvironment, newRequest, type HistoryEntry, type LogLine } from '../src/core/types'
import type { McpSignIn } from '../src/core/mcpAuth'
import type { WorkspaceApi } from '../src/ui/useWorkspace'
import { removeAllChats, updateConnections } from '../src/ui/assistant/store'
import { useAssistant, type AssistantApi } from '../src/ui/assistant/useAssistant'

type Req = { url: string; body: string | null; headers: [string, string][]; origin: string }
type Emit = (e: object) => void
const rust = vi.hoisted(() => ({ answers: [] as unknown[], sent: [] as unknown[], cancelled: 0, emit: [] as unknown[] }))
vi.mock('@tauri-apps/api/core', () => {
  class Channel { onmessage: (e: unknown) => void; constructor(cb?: (e: unknown) => void) { this.onmessage = cb ?? (() => {}) } }
  return {
    Channel,
    invoke: async (cmd: string, args: { req: Req; onEvent: Channel }) => {
      if (cmd === 'ai_cancel') { rust.cancelled++; return }
      rust.sent.push(args.req)
      rust.emit.push((e: unknown) => args.onEvent.onmessage(e))
      const a = rust.answers.shift()
      if (a === undefined) throw new Error('offline')
      await Promise.resolve()
      args.onEvent.onmessage({ kind: 'head', status: 200, headers: [] })
      if (a === 'hang') return
      args.onEvent.onmessage({ kind: 'chunk', base64: Buffer.from(a as string).toString('base64') })
      args.onEvent.onmessage({ kind: 'end' })
    },
  }
})
const b64 = (s: string) => Buffer.from(s).toString('base64')
const data = (o: object) => `data: ${JSON.stringify(o)}\n\n`
const says = (text: string, input?: number) => data({ choices: [{ delta: { content: text } }] }) + data({ choices: [{ delta: {}, finish_reason: 'stop' }], ...(input ? { usage: { prompt_tokens: input, completion_tokens: 5 } } : {}) }) + 'data: [DONE]\n\n'
const calls = (name: string, args: object, text = '') => data({ choices: [{ delta: { content: text, tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: JSON.stringify(args) } }] } }] }) + data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'
const sent = () => rust.sent as Req[]
const emit = (i: number) => rust.emit[i] as Emit
const bodyOf = (i: number) => JSON.parse(sent()[i].body!)

const KEY = 'planted-conn-KEY-123'
const local = (over: Partial<Connection> = {}): Connection => ({ ...newConnection('compatible'), id: 'l', name: 'Mine', model: 'qwen', tools: 'yes', ...over })
const cloud = (over: Partial<Connection> = {}): Connection => local({ id: 'c', name: 'Cloud one', baseUrl: 'https://models.example.com/v1', key: KEY, readLogs: false, ...over })

const shop = newCollection('Shop')
const items = { ...newRequest(), name: 'Items', url: 'https://x.test', collectionId: shop.id }
function world(over: object = {}): WorkspaceApi {
  const space = (over as { activeSpaceId?: string }).activeSpaceId ?? 'default'
  return {
    ready: true, spaces: [{ id: 'default', name: 'Orders' }, { id: 'two', name: 'Second' }], activeSpaceId: space, settings: { ...defaultSettings, activeSpaceId: space },
    collections: [shop], allCollections: [shop], folders: [], requests: [items], environments: [], allEnvironments: [], environment: null, globals: [], flows: [],
    history: [] as HistoryEntry[], logs: [] as LogLine[], tabs: [], allTabs: [], view: { kind: 'request' }, draft: { ...items, name: 'Open one' },
    transport: { label: 't', unrestricted: true, send: async () => { throw new Error('must not send') } }, pipeline: { current: {} }, cookieJars: new CookieJars(), ...over,
  } as never
}
let h: ReturnType<typeof renderHook<AssistantApi, { ws: WorkspaceApi }>>
const a = () => h.result.current
async function mount(list: Connection[], ws = world()) {
  await db.putSpaces([{ id: 'default', name: 'Orders' }, { id: 'two', name: 'Second' }])
  await db.putConnections(list)
  h = renderHook(({ ws }) => useAssistant(ws), { initialProps: { ws } })
  await waitFor(() => expect(a().ready).toBe(true))
}
const send = async (text: string) => { let r = ''; await act(async () => { r = await a().send(text) }); return r }
const idle = () => waitFor(() => expect(a().status).toBe('idle'))
const ask = async (text: string, ...answers: string[]) => { rust.answers.push(...answers); expect(await send(text)).toBe('sent'); await idle() }
const texts = () => (a().chat?.messages ?? []).map((m) => (m as { content: string }).content)

beforeEach(async () => { await db.resetForTests(); rust.answers.length = 0; rust.sent.length = 0; rust.emit.length = 0; rust.cancelled = 0 })
afterEach(() => { vi.restoreAllMocks(); cleanup() })

describe('sending', () => {
  it('without a connection sends nothing', async () => {
    await mount([])
    expect(a().connection).toBeNull()
    expect(a().blocked).toMatch(/Add a connection/)
    expect(await send('hi')).toBe('blocked')
    expect(sent()).toEqual([])
  })

  it('answers, keeps the messages as they are, and saves them with a title without keys', async () => {
    await mount([local(), cloud()])
    const q = `What  is ${KEY}\nand ${'x'.repeat(80)}`
    await ask(q, says('Hello', 100))
    expect(texts()[1]).toBe('Hello')
    expect(a().usage).toMatchObject({ input: 100, output: 5 })
    const [c] = await listChats('default')
    expect(c.messages).toEqual(a().chat!.messages)
    expect(c).toMatchObject({ connectionId: 'l', model: 'qwen', spaceId: 'default' })
    expect(c.title.length).toBeLessThanOrEqual(60)
    expect(JSON.stringify(c) + JSON.stringify(sent())).not.toContain(KEY)
    expect(c.title).toMatch(/^What is <hidden> and x/)
    await waitFor(() => expect(a().chats.map((x) => x.id)).toEqual([c.id]))
    await ask('more', says('Again'))
    expect(bodyOf(1).messages.slice(1)).toHaveLength(3)
    expect(await listChats('default')).toHaveLength(1)
    expect(bodyOf(0).messages[0].content).toContain('"Open one"')
  })

  it('shows text as it comes and refuses a second send meanwhile', async () => {
    await mount([local()])
    rust.answers.push('hang')
    let both: string[] = []
    await act(async () => { both = await Promise.all([a().send('one'), a().send('two')]) })
    expect(both).toEqual(['sent', 'busy'])
    await waitFor(() => expect(sent()).toHaveLength(1))
    await act(async () => { emit(0)({ kind: 'chunk', base64: b64(data({ choices: [{ delta: { content: 'part' } }] })) }) })
    await waitFor(() => expect(a().streamed).toBe('part'))
    expect(texts()).toEqual(['one'])
    act(() => a().stop())
    await idle()
    expect(rust.cancelled).toBe(1)
    expect(a().ended).toBe('stopped')
    expect(a().streamed).toBe('part') // not in the messages, still on screen
    expect((await listChats('default'))[0].messages).toEqual([{ role: 'user', content: 'one' }])
  })

  it('a failure is plain and the chat is kept', async () => {
    await mount([local()])
    await ask('hi') // offline
    expect(a().error).toMatch(/offline/)
    expect(await listChats('default')).toHaveLength(1)
    expect(await send('  ')).toBe('empty')
  })

  it('an empty answer says so, and the next question goes on', async () => {
    await mount([local()])
    await ask('one', says(''))
    expect(a().ended).toBe('error')
    expect(a().error).toBe('Mine sent an empty answer. Try again, or another model. Its context may be too small.')
    expect(texts()).toEqual(['one'])
    await ask('two', says('Yes'))
    expect(a().error).toBe('')
    expect(texts()).toEqual(['one', 'two', 'Yes'])
    expect(bodyOf(1).messages.slice(1)).toEqual([{ role: 'user', content: 'one\n\ntwo' }])
  })

  it('a missing or lost key stops before anything is sent or kept', async () => {
    await mount([cloud({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', key: '' })])
    expect(await send('hi')).toBe('blocked')
    expect(a().error).toMatch(/Enter the key/)
    expect(a().chat).toBeNull()
  })

  it('uses the connection as it is saved now', async () => {
    await mount([cloud({ consentHost: 'models.example.com' })])
    await ask('one', says('1'))
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, key: 'second-key-2222' }))))
    await ask('two', says('2'))
    expect(JSON.stringify(sent()[1].headers)).toContain('second-key-2222')
    expect(a().chat!.messages).toHaveLength(4)
  })

  it('keeping off in the settings on screen stores nothing, even before it is written down', async () => {
    await mount([local()], world({ settings: { ...defaultSettings, keepChats: false } }))
    await ask('hi', says('yo'))
    expect(a().chat!.messages).toHaveLength(2)
    expect(await listChats('default')).toEqual([])
  })

  it('keeping off as it is saved stores nothing, even before the screen knows', async () => {
    await db.putSettings({ ...defaultSettings, keepChats: false })
    await mount([local()])
    await ask('hi', says('yo'))
    expect(await listChats('default')).toEqual([])
  })

  it('tells which model answered instead', async () => {
    const ev = (o: { type: string }) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`
    await mount([{ ...newConnection('anthropic'), id: 'n', key: KEY, consentHost: 'api.anthropic.com' }])
    await ask('hi', [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'other-model' } } }, { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'ok' } }, { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
    ].map(ev).join(''))
    expect(a().error).toBe('')
    expect(a().fallback).toBe('other-model')
  })
})

describe('consent', () => {
  it('nothing leaves before it; no means nothing sent; yes is kept for the host and sends', async () => {
    await mount([cloud()])
    expect(await send('hi')).toBe('consent')
    expect(sent()).toEqual([])
    expect(a().pendingConsent).toMatchObject({ host: 'models.example.com', text: 'hi' })
    act(() => a().declineConsent())
    expect(a().pendingConsent).toBeNull()
    expect(await send('hi')).toBe('consent')
    rust.answers.push(says('yo'))
    await act(async () => { expect(await a().allowConsent()).toBe('sent') })
    await idle()
    expect((await db.getConnections())[0].consentHost).toBe('models.example.com')
    expect(texts()).toEqual(['hi', 'yo'])
    await ask('more', says('ok'))
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, baseUrl: 'https://other.example.com/v1', consentHost: undefined }))))
    expect(await send('again')).toBe('consent')
    expect(a().pendingConsent!.host).toBe('other.example.com')
  })

  it('a yes for what was shown does not count for a changed connection', async () => {
    await mount([cloud()])
    await send('hi')
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, readLogs: true }))))
    await act(async () => { expect(await a().allowConsent()).toBe('consent') })
    expect((await db.getConnections())[0].consentHost).toBeUndefined()
    expect(sent()).toEqual([])
  })
})

describe('tools', () => {
  it('every workspace’s secrets, sign-ins, cookies, keys and history stay out of what is sent', async () => {
    const P = { env: 'plant-otherenv-1111', access: 'plant-signin-2222', cookie: 'plant-cookie-3333', cert: 'plant-certkey-4444', hist: 'plant-history-5555', other: 'plant-otherconn-6666', draft: 'plant-draft-7777' }
    const jars = new CookieJars()
    jars.get('none:two').set({ host: 'h', name: 'n', value: P.cookie, path: '/', expiresAt: null } as never)
    await db.putMcpSignIns([{ accessToken: P.access, refreshToken: '', clientSecret: '' } as McpSignIn])
    const req = { ...items, docs: Object.values(P).join(' ') }
    const entry = { id: 'e', at: 1, request: newRequest(), sent: { method: 'GET', url: '', headers: [['Authorization', `Bearer ${P.hist}`]], body: '', unresolved: [] }, response: null, error: null, tests: [] } as unknown as HistoryEntry
    const otherEnv = { ...newEnvironment('o'), workspaceId: 'two', variables: [{ ...kv('s', P.env), secret: true }] }
    const draft = { ...newRequest(), headers: [kv('Authorization', P.draft)] }
    await mount([local({ readLogs: false }), cloud({ key: P.other })], world({
      requests: [req], allEnvironments: [otherEnv], cookieJars: jars, history: [entry], allTabs: [{ id: 't', draft, space: 'two' }],
      settings: { ...defaultSettings, clientCerts: [{ id: '1', host: 'h', cert: '', key: P.cert, enabled: true }] },
    }))
    await ask('look', calls('get_request', { name: 'Shop/Items' }, 'Looking'), says('Done'))
    expect(a().tools).toMatchObject([{ name: 'get_request', state: 'ok' }])
    expect(bodyOf(1).messages.at(-1).role).toBe('tool')
    expect(bodyOf(1).messages.at(-1).content).toContain('Items')
    for (const p of Object.values(P)) expect(sent().map((r) => r.body).join(''), p).not.toContain(p)
    expect(JSON.stringify(await listChats('default'))).not.toMatch(/plant-/)
  })

  it('turning the console off mid-answer takes effect at once', async () => {
    await mount([local({ readLogs: true })], world({ logs: [{ level: 'log', at: 1, source: 'script', text: 'console words' }] }))
    rust.answers.push('hang', says('ok'))
    await send('look')
    await waitFor(() => expect(sent()).toHaveLength(1))
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, readLogs: false }))))
    await act(async () => { emit(0)({ kind: 'chunk', base64: b64(calls('get_logs', {})) }); emit(0)({ kind: 'end' }) })
    await idle()
    expect(a().tools).toMatchObject([{ name: 'get_logs', state: 'failed' }])
    expect(sent().map((r) => r.body).join('')).not.toContain('console words')
  })

  it('a look-up left open by Stop is closed', async () => {
    await mount([local()])
    const real = db.getMcpSignIns
    let n = 0
    vi.spyOn(db, 'getMcpSignIns').mockImplementation(() => (n++ ? new Promise(() => {}) : real()))
    rust.answers.push(calls('list_requests', {}))
    await send('look')
    await waitFor(() => expect(a().tools).toMatchObject([{ state: 'running' }]))
    act(() => a().stop())
    await idle()
    expect(a().tools).toMatchObject([{ state: 'stopped' }])
    expect(a().chat!.messages.length).toBeGreaterThan(1) // the turn and its result
  })
})

describe('whose chat', () => {
  it('switching workspace stops the answer and pauses the chat; late text lands nowhere else', async () => {
    await mount([local()])
    rust.answers.push('hang')
    await send('one')
    await waitFor(() => expect(sent()).toHaveLength(1))
    h.rerender({ ws: world({ activeSpaceId: 'two' }) })
    await idle()
    expect(rust.cancelled).toBe(1)
    expect(a().paused).toBe(true)
    expect(await send('two')).toBe('blocked')
    expect((await listChats('default'))[0].messages).toEqual([{ role: 'user', content: 'one' }])
    expect(await listChats('two')).toEqual([])
    act(() => a().newChat())
    expect(a().paused).toBe(false)
    act(() => { emit(0)({ kind: 'chunk', base64: b64(says('late')) }) })
    expect(a().chat).toBeNull()
    await ask('in two', says('ok'))
    expect((await listChats('two'))[0].messages).toHaveLength(2)
    await act(async () => { h.rerender({ ws: world() }) })
    expect(a().paused).toBe(true)
    const [first] = await listChats('default')
    await waitFor(() => expect(a().chats.map((c) => c.id)).toEqual([first.id]))
    await act(() => a().openChat(first.id))
    expect(a().paused).toBe(false)
    expect(texts()).toEqual(['one'])
  })

  it('a workspace switch drops a waiting consent question and a summary', async () => {
    await mount([cloud()])
    await send('secret plan')
    h.rerender({ ws: world({ activeSpaceId: 'two' }) })
    await waitFor(() => expect(a().pendingConsent).toBeNull())
  })

  it('a new chat while answering: the old one is kept in its place', async () => {
    await mount([local()])
    rust.answers.push('hang')
    await send('one')
    await waitFor(() => expect(sent()).toHaveLength(1))
    await act(async () => { emit(0)({ kind: 'chunk', base64: b64(data({ choices: [{ delta: { content: 'old text' } }] })) }) })
    await waitFor(() => expect(a().streamed).toBe('old text'))
    await act(async () => { a().newChat(); await new Promise((r) => setTimeout(r, 50)) })
    expect([a().streamed, a().ended, a().error]).toEqual(['', null, ''])
    await ask('two', says('ok'))
    expect(texts()).toEqual(['two', 'ok'])
    await waitFor(async () => expect((await listChats('default')).map((c) => c.messages.length).sort()).toEqual([1, 2]))
  })

  it('another connection or another model starts a new chat', async () => {
    await mount([local(), local({ id: 'l2', name: 'Other' })])
    await ask('one', says('1'))
    const first = a().chat!.id
    act(() => a().selectConnection('l2'))
    expect(a().chat).toBeNull()
    await ask('two', says('2'))
    expect(a().chat!.id).not.toBe(first)
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, model: 'newer' }))))
    expect(a().chat).toBeNull()
    await act(() => a().openChat(first))
    expect(a().connection!.id).toBe('l')
    expect(a().blocked).toMatch(/qwen/)
    expect(await send('go on')).toBe('blocked')
  })

  it('a chat whose connection was removed can be read, not continued', async () => {
    await mount([local(), local({ id: 'l2' })])
    await ask('one', says('1'))
    await act(() => updateConnections((l) => l.filter((c) => c.id !== 'l')))
    expect(texts()).toEqual(['one', '1'])
    expect(a().blocked).toMatch(/removed/)
    expect(await send('more')).toBe('blocked')
    act(() => a().newChat())
    expect(a().blocked).toBeNull()
    expect(a().connection!.id).toBe('l2')
  })

  it('moving the connection mid-answer stops it', async () => {
    await mount([local()])
    rust.answers.push('hang')
    await send('one')
    await waitFor(() => expect(sent()).toHaveLength(1))
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, baseUrl: 'http://localhost:9/v1' }))))
    await waitFor(() => expect(rust.cancelled).toBe(1))
  })

  it('deleting a chat, or all of them, while it answers: it does not come back', async () => {
    await mount([local()])
    rust.answers.push('hang', 'hang')
    await send('one')
    await waitFor(() => expect(sent()).toHaveLength(1))
    await act(() => a().deleteChat(a().chat!.id))
    expect(a().chat).toBeNull()
    await send('two')
    await waitFor(() => expect(sent()).toHaveLength(2))
    await act(() => removeAllChats())
    expect(a().chat).toBeNull()
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(await listChats('default')).toEqual([])
    expect(a().status).toBe('idle')
  })

  it('opening a chat from another workspace does nothing', async () => {
    const other: Chat = { id: 'o', spaceId: 'two', connectionId: 'l', model: 'qwen', title: 't', messages: [], updatedAt: 1 }
    await mount([local()])
    await saveChat(other)
    await act(() => a().openChat('o'))
    expect(a().chat).toBeNull()
  })

  it('unmounting and closing the window stop it', async () => {
    await mount([local()])
    rust.answers.push('hang', 'hang')
    await send('one')
    await waitFor(() => expect(sent()).toHaveLength(1))
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    await waitFor(() => expect(rust.cancelled).toBe(1))
    await idle()
    await send('two')
    await waitFor(() => expect(sent()).toHaveLength(2))
    h.unmount()
    await waitFor(() => expect(rust.cancelled).toBe(2))
  })
})

describe('a nearly full chat', () => {
  it('offers a summary, shows it, and starts the new chat with what the person made of it', async () => {
    await mount([local({ contextTokens: 1000 })])
    await ask('one', calls('list_requests', {}), says('1', 700))
    expect(a().nearFull).toBe(false)
    await ask('two', says('2', 801))
    expect(a().nearFull).toBe(true)
    expect(sent()).toHaveLength(3) // never by itself
    const before = a().chat!
    rust.answers.push(says('We talked about Shop.'))
    await act(() => a().summarise())
    await idle()
    expect(a().summary).toContain('We talked about Shop.')
    expect(a().chat).toEqual(before)
    expect(bodyOf(3).tools).toBeUndefined()
    expect(bodyOf(3).model).toBe('qwen')
    expect(await listChats('default')).toHaveLength(1)
    rust.answers.push(says('Go on'))
    await act(async () => { expect(await a().startFromSummary('Edited summary')).toBe('sent') })
    await idle()
    expect(a().chat!.id).not.toBe(before.id)
    expect(texts()).toEqual(['Edited summary', 'Go on'])
    expect(a().summary).toBeNull()
    expect(a().nearFull).toBe(false)
  })

  it('knows the usual sizes, and says nothing when it can’t know', async () => {
    await mount([cloud({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', consentHost: 'api.openai.com' }), local()])
    await ask('one', says('1', 102_401))
    expect(a().nearFull).toBe(true)
    act(() => a().selectConnection('l'))
    await ask('one', says('1', 9_000_000))
    expect(a().nearFull).toBe(false)
  })

  it('Stop ends a summary; a workspace switch drops one', async () => {
    await mount([local()])
    await ask('one', says('1'))
    rust.answers.push('hang')
    let p!: Promise<unknown>
    await act(async () => { p = a().summarise() })
    await waitFor(() => expect(a().status).toBe('summarising'))
    await waitFor(() => expect(sent()).toHaveLength(2))
    act(() => a().stop())
    await act(async () => { await p })
    expect(a().summary).toBeNull()
    rust.answers.push(says('sum'))
    await act(() => a().summarise())
    expect(a().summary).toContain('sum')
    h.rerender({ ws: world({ activeSpaceId: 'two' }) })
    await waitFor(() => expect(a().summary).toBeNull())
  })
})

/** Holds `prepare` (or a tool) at reading the sign-ins until released. */
function hold() {
  const real = db.getMcpSignIns
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  vi.spyOn(db, 'getMcpSignIns').mockImplementation(async () => { await gate; return real() })
  return release
}
const moveTo = (baseUrl: string) => act(() => updateConnections((l) => l.map((c) => ({ ...c, baseUrl }))))
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)) })

describe('bound to connection, model and origin', () => {
  it('the chat keeps its origin; after a move it can be read, not continued, also when reopened', async () => {
    await mount([local()])
    await ask('one', says('1'))
    const id = a().chat!.id
    expect((await listChats('default'))[0].origin).toBe('http://localhost:11434')
    await moveTo('https://other.example.com/v1')
    expect(a().chat).toBeNull()
    await act(() => a().openChat(id))
    expect(texts()).toEqual(['one', '1'])
    expect(a().blocked).toMatch(/address/)
    expect(await send('go on')).toBe('blocked')
    await moveTo('http://localhost:11434/other/path')
    await act(() => a().openChat(id))
    expect(a().blocked).toBeNull()
  })

  it('a chat kept without an origin is only readable', async () => {
    await mount([local()])
    await saveChat({ id: 'old', spaceId: 'default', connectionId: 'l', model: 'qwen', title: 't', messages: [{ role: 'user', content: 'x' }], updatedAt: 1 })
    await act(() => a().openChat('old'))
    expect(texts()).toEqual(['x'])
    expect(await send('go on')).toBe('blocked')
    expect(sent()).toEqual([])
  })

  it.each([true, false])('a yes for one connection never sends to another (removed first: %s)', async (first) => {
    await mount([cloud(), local()])
    expect(await send('for the cloud')).toBe('consent')
    const remove = () => updateConnections((l) => l.filter((c) => c.id !== 'c'))
    let r = ''
    await act(async () => {
      const q = first && remove()
      const p = a().allowConsent()
      if (!first) void remove()
      await q; r = await p
    })
    await settle()
    if (first) expect(['blocked', 'stopped']).toContain(r)
    expect(sent().filter((x) => !x.url.startsWith('https://models.example.com/'))).toEqual([])
  })

  it('a waiting question goes with its connection, and with its origin (https to http on one host)', async () => {
    await mount([cloud({ baseUrl: 'https://192.168.1.5/v1' }), local()])
    await send('hi')
    await act(() => updateConnections((l) => l.map((c) => (c.id === 'c' ? { ...c, baseUrl: 'http://192.168.1.5/v1' } : c))))
    expect(a().pendingConsent).toBeNull()
    await send('hi')
    expect(a().pendingConsent).not.toBeNull()
    await act(() => updateConnections((l) => l.filter((c) => c.id !== 'c')))
    expect(a().pendingConsent).toBeNull()
  })

  it('an unnoticed move to http on the same host is not covered by the yes', async () => {
    await mount([cloud({ baseUrl: 'https://192.168.1.5/v1' })])
    await send('hi')
    await db.putConnections((await db.getConnections()).map((c) => ({ ...c, baseUrl: 'http://192.168.1.5/v1' })))
    let r = ''
    await act(async () => { r = await a().allowConsent() })
    expect(r).not.toBe('sent')
    expect((await db.getConnections())[0].consentHost).toBeUndefined()
    expect(sent()).toEqual([])
  })

  it.each([
    ['removed', (l: Connection[]) => l.filter((c) => c.id !== 'c')],
    ['its key changed', (l: Connection[]) => l.map((c) => (c.id === 'c' ? { ...c, key: 'another-key-1' } : c))],
    ['its model changed', (l: Connection[]) => l.map((c) => (c.id === 'c' ? { ...c, model: 'm2' } : c))],
    ['its consent taken back', (l: Connection[]) => l.map((c) => (c.id === 'c' ? { ...c, consentHost: undefined } : c))],
    ['its address changed', (l: Connection[]) => l.map((c) => (c.id === 'c' ? { ...c, baseUrl: 'https://b.example.com' } : c))],
  ])('connection %s: stops an answer, and a message still being prepared', async (_n, change) => {
    const list = [cloud({ consentHost: 'models.example.com' }), local()]
    await mount(list)
    rust.answers.push('hang')
    await send('one')
    await waitFor(() => expect(sent()).toHaveLength(1))
    await act(() => updateConnections(change))
    await waitFor(() => expect(rust.cancelled).toBe(1))
    await idle()
    // being prepared, with the change announced
    await act(() => updateConnections(() => list)); act(() => a().newChat())
    act(() => a().selectConnection('c'))
    let release = hold()
    let p!: Promise<string>
    await act(async () => { p = a().send('two') })
    await settle()
    await act(() => updateConnections(change))
    await act(() => updateConnections(() => list)) // put back: stopped all the same
    release()
    await act(async () => { expect(await p).toBe('stopped') })
    // and with a change only saved
    vi.restoreAllMocks(); act(() => a().newChat()); act(() => a().selectConnection('c'))
    release = hold()
    await act(async () => { p = a().send('three') })
    await settle()
    await db.putConnections(change(list))
    release()
    await act(async () => { expect(await p).toBe('blocked') })
    expect(sent()).toHaveLength(1)
  })

  it.each([
    ['removed', (l: Connection[]) => l.slice(1)], ['key', (l: Connection[]) => l.map((c) => ({ ...c, key: 'another-key-1' }))],
    ['origin', (l: Connection[]) => l.map((c) => ({ ...c, baseUrl: 'https://b.example.com' }))], ['consent', (l: Connection[]) => l.map((c) => ({ ...c, consentHost: undefined }))],
  ])('a look-up re-reads the connection (%s): nothing is read and the answer stops', async (_n, change) => {
    const list = [cloud({ consentHost: 'models.example.com' })]
    await mount(list)
    rust.answers.push('hang', says('must not be asked'))
    await send('look')
    await waitFor(() => expect(sent()).toHaveLength(1))
    await db.putConnections(change(list)) // nobody hears of it
    await act(async () => { emit(0)({ kind: 'chunk', base64: b64(calls('list_requests', {})) }); emit(0)({ kind: 'end' }) })
    await idle()
    expect(a().ended).toBe('stopped')
    expect(sent()).toHaveLength(1)
    expect(JSON.stringify(a().chat!.messages)).not.toContain('Shop/')
  })

  it('nothing starts after unmounting', async () => {
    await mount([cloud()])
    await send('hi')
    const { allowConsent, send: late } = a()
    await act(async () => { const p = allowConsent(); h.unmount(); expect(await p).not.toBe('sent') })
    expect(await late('again')).toBe('stopped')
    await settle()
    expect(sent()).toEqual([])
  })

  it('works under StrictMode', async () => {
    await db.putConnections([local()])
    const s = renderHook(() => useAssistant(world()), { reactStrictMode: true })
    await waitFor(() => expect(s.result.current.ready).toBe(true))
    rust.answers.push(says('ok'))
    await act(async () => { expect(await s.result.current.send('hi')).toBe('sent') })
    await waitFor(() => expect(s.result.current.chat?.messages).toHaveLength(2))
  })
})

describe('names and chats', () => {
  it('a secret in the open request’s or the workspace’s name is hidden', async () => {
    const v = 'plant-name-8888'
    await mount([local()], world({ allEnvironments: [{ ...newEnvironment('e'), workspaceId: 'two', variables: [{ ...kv('s', v), secret: true }] }], draft: { ...items, name: `Req ${v}` }, spaces: [{ id: 'default', name: `Space ${v}` }] }))
    await ask('hi', says('ok'))
    expect(bodyOf(0).messages[0].content).toContain('Req <hidden>')
    expect(bodyOf(0).messages[0].content).toContain('Space <hidden>')
  })

  it('opening a chat waits for its own answer to be kept, also one left for a new chat', async () => {
    await mount([local()])
    await ask('one', says('1'))
    const id = a().chat!.id
    rust.answers.push('hang')
    await send('two')
    await waitFor(() => expect(sent()).toHaveLength(2))
    await act(async () => { a().newChat(); await a().openChat(id) })
    expect(texts()).toEqual(['one', '1', 'two'])
  })
})

describe('what a summary sends', () => {
  it('what was said, not what was looked up, without a key added since', async () => {
    const NEW = 'added-later-KEY-55'
    await mount([local()])
    await ask(`my value is ${NEW}`, calls('get_request', { name: 'Shop/Items' }), says('It is Items.', 9))
    expect(sent()[1].body).toContain('x.test')
    await act(() => updateConnections((l) => [...l, cloud({ key: NEW })]))
    rust.answers.push(says('sum', 50))
    await act(() => a().summarise().then(() => {}))
    const body = sent()[2].body!
    expect(body).toContain('It is Items.')
    expect(body).not.toContain('x.test')
    expect(body).not.toContain('<<data')
    expect(body).not.toContain(NEW)
    expect(a().usage).toMatchObject({ input: 9, totalInput: 59, totalOutput: 10 })
  })

  it('is cut between characters', async () => {
    await mount([local({ contextTokens: 10 })])
    await ask('hi', says('😀'.repeat(40) + 'x'))
    rust.answers.push(says('sum'))
    await act(() => a().summarise().then(() => {}))
    const content = bodyOf(1).messages[1].content as string
    expect(/\p{Cs}/u.test(content)).toBe(false)
  })

  it('without consent nothing is sent: it asks, and a yes summarises', async () => {
    await mount([cloud({ consentHost: 'models.example.com' })])
    await ask('one', says('1'))
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, consentHost: undefined }))))
    await act(async () => { expect(await a().summarise()).toBe('consent') })
    expect(sent()).toHaveLength(1)
    expect(a().pendingConsent).toMatchObject({ kind: 'summary', host: 'models.example.com' })
    rust.answers.push(says('sum'))
    await act(async () => { await a().allowConsent() })
    expect(a().summary).toContain('sum')
    expect(texts()).toEqual(['one', '1'])
  })

  it.each([
    ['removed', (l: Connection[]) => l.filter((c) => c.id !== 'l')], ['another model', (l: Connection[]) => l.map((c) => (c.id === 'l' ? { ...c, model: 'm2' } : c))],
    ['another origin', (l: Connection[]) => l.map((c) => (c.id === 'l' ? { ...c, baseUrl: 'http://localhost:9/v1' } : c))],
  ])('a summary is dropped when its connection is %s, and is never sent elsewhere', async (_n, change) => {
    const list = [local(), local({ id: 'l2', name: 'Two' })]
    await mount(list)
    await ask('one', says('1'))
    rust.answers.push(says('sum'))
    await act(() => a().summarise().then(() => {}))
    await db.putConnections(change(list)) // unnoticed
    await act(async () => { expect(await a().startFromSummary('sum')).toBe('blocked') })
    expect(sent()).toHaveLength(2)
    expect(a().summary).not.toBeNull()
    await act(() => updateConnections((l) => l))
    expect(a().summary).toBeNull()
  })

  it('a change or a workspace switch while it is made drops the result', async () => {
    await mount([local()])
    await ask('one', says('1'))
    rust.answers.push('hang', 'hang')
    let p!: Promise<unknown>
    await act(async () => { p = a().summarise() })
    await waitFor(() => expect(sent()).toHaveLength(2))
    h.rerender({ ws: world({ activeSpaceId: 'two' }) })
    await act(async () => { emit(1)({ kind: 'chunk', base64: b64(says('late')) }); await p })
    expect(a().summary).toBeNull()
    h.rerender({ ws: world() })
    await act(async () => { p = a().summarise() })
    await waitFor(() => expect(sent()).toHaveLength(3))
    await moveTo('http://localhost:9/v1')
    await act(async () => { emit(2)({ kind: 'chunk', base64: b64(says('late')) }); await p })
    expect(a().summary).toBeNull()
  })

  it('the summary and the chat stay until the new chat is really sent', async () => {
    await mount([cloud({ consentHost: 'models.example.com' })])
    await ask('one', says('1'))
    const old = a().chat!.id
    rust.answers.push(says('sum'))
    await act(() => a().summarise().then(() => {}))
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, consentHost: undefined }))))
    await act(async () => { expect(await a().startFromSummary('mine')).toBe('consent') })
    expect(a().summary).not.toBeNull()
    expect(a().chat!.id).toBe(old)
    act(() => a().declineConsent())
    await act(async () => { await a().startFromSummary('mine') })
    rust.answers.push(says('go'))
    await act(async () => { expect(await a().allowConsent()).toBe('sent') })
    await idle()
    expect(a().summary).toBeNull()
    expect(texts()).toEqual(['mine', 'go'])
  })
})
