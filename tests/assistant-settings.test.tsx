/** Settings > AI assistants > Dispatch assistant: connections, their test, and the consent question. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../src/core/db'
import { listChats, saveChat } from '../src/core/assistant/chats'
import { newConnection, type Connection } from '../src/core/assistant/connections'
import { defaultSettings } from '../src/core/types'
import { updateConnections } from '../src/ui/assistant/store'
import { SettingsView } from '../src/ui/SettingsView'
import { ConsentDialog } from '../src/ui/assistant/ConsentDialog'

type Answer = { status?: number; body: string } | 'hang'
type Req = { url: string; body: string | null; headers: [string, string][] }
const rust = vi.hoisted(() => ({ answers: [] as unknown[], sent: [] as unknown[], cancelled: 0 }))
vi.mock('@tauri-apps/api/core', () => {
  class Channel { onmessage: (e: unknown) => void; constructor(cb?: (e: unknown) => void) { this.onmessage = cb ?? (() => {}) } }
  return {
    Channel,
    invoke: async (cmd: string, args: { req: Req; onEvent: Channel }) => {
      if (cmd === 'ai_cancel') { rust.cancelled++; return }
      if (cmd !== 'ai_stream') return
      rust.sent.push(args.req)
      const a = rust.answers.shift() as Answer | undefined
      if (!a) throw new Error('offline')
      if (a === 'hang') return
      await Promise.resolve()
      args.onEvent.onmessage({ kind: 'head', status: a.status ?? 200, headers: [] })
      args.onEvent.onmessage({ kind: 'chunk', base64: Buffer.from(a.body).toString('base64') })
      args.onEvent.onmessage({ kind: 'end' })
    },
  }
})
const sse = (objs: object[]) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n'
const says = (text: string): Answer => ({ body: sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]) })
const calls = (name: string, args: string): Answer => ({ body: sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: args } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]) })
const sent = () => rust.sent as Req[]
const bodyOf = (i: number) => JSON.parse(sent()[i].body!)

const KEY = 'planted-KEY-123456'
const local = (over: Partial<Connection> = {}): Connection => ({ ...newConnection('compatible'), id: 'l', name: 'My computer', model: 'qwen', ...over })
const cloud = (over: Partial<Connection> = {}): Connection => ({ ...newConnection('anthropic'), id: 'a', name: 'Work key', key: KEY, consentHost: 'api.anthropic.com', ...over })

const setSettings = vi.fn()
async function open(list: Connection[] = [], settings: object = {}, expected = list[0]?.name as string | undefined) {
  if (list.length) await db.putConnections(list)
  const ws = { settings: { ...defaultSettings, ...settings }, transport: { unrestricted: true }, setSettings } as never
  const r = render(<SettingsView ws={ws} notify={() => {}} />)
  fireEvent.click(screen.getByRole('tab', { name: 'AI assistants' }))
  if (expected) await screen.findByText(expected)
  else await screen.findByText(/No connections yet/)
  return r
}
const dialog = () => screen.getByRole('dialog', { hidden: true })
const field = (label: string | RegExp) => within(dialog()).getByLabelText(label) as HTMLInputElement
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })
const press = (name: string | RegExp) => fireEvent.click(within(dialog()).getByRole('button', { name, hidden: true }))
const edit = (name = 'Work key') => fireEvent.click(screen.getByRole('button', { name: `Edit ${name}` }))
const saved = async () => { await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()); return db.getConnections() }
const addNew = (kind: string) => { fireEvent.click(screen.getByRole('button', { name: '+ Add connection' })); type(field('Kind'), kind) }

beforeEach(async () => { await db.resetForTests(); rust.answers.length = 0; rust.sent.length = 0; rust.cancelled = 0; setSettings.mockClear() })
afterEach(() => cleanup())

describe('connections', () => {
  it('sits above the outside-assistant section and sends nothing', async () => {
    await open()
    const h = screen.getAllByRole('heading', { level: 2 }).map((x) => x.textContent)
    expect(h.indexOf('Dispatch assistant')).toBeGreaterThanOrEqual(0)
    expect(h.indexOf('Dispatch assistant')).toBeLessThan(h.indexOf('AI assistants (MCP)'))
    expect(sent()).toEqual([])
  })

  it('lists name, kind or address, model and label', async () => {
    await open([cloud(), local(), local({ id: 'n', name: 'Box', baseUrl: 'http://192.168.1.5:1234/v1' })])
    const rows = within(screen.getByRole('list', { name: 'Connections' })).getAllByRole('listitem').map((x) => x.textContent!)
    expect(rows[0]).toMatch(/Work key.*Anthropic.*claude-opus-5-5.*Cloud/)
    expect(rows[1]).toMatch(/My computer.*http:\/\/localhost:11434\/v1.*qwen.*Local/)
    expect(rows[2]).toContain('Your network')
    expect(document.body.innerHTML).not.toContain(KEY)
  })

  it('adds one, with the suggested model, and loads no list by itself', async () => {
    await open()
    addNew('anthropic')
    expect(field('Model').value).toBe('claude-opus-5-5')
    expect(field('Key').type).toBe('password')
    expect(within(dialog()).queryByLabelText('Address')).toBeNull()
    type(field('Key'), KEY)
    press('Save')
    const [c] = await saved()
    expect(c).toMatchObject({ kind: 'anthropic', key: KEY, baseUrl: 'https://api.anthropic.com', readLogs: false })
    expect(c.consentHost).toBeUndefined()
    expect(sent()).toEqual([])
  })

  it('refuses a bad address and says why, without saving', async () => {
    await open()
    addNew('compatible')
    type(field('Model'), 'm')
    type(field('Address'), 'http://models.example.com/v1')
    press('Save')
    expect(within(dialog()).getByRole('alert', { hidden: true }).textContent).toMatch(/Plain http is only allowed/)
    expect(await db.getConnections()).toEqual([])
  })

  it('an address on another host drops the key, consent, context size and console tick; a half-typed one does nothing', async () => {
    await open([local({ key: KEY, baseUrl: 'https://one.example.com/v1', consentHost: 'one.example.com', readLogs: true, contextTokens: 8000, tools: 'yes' })])
    edit('My computer')
    for (const v of ['https://t', 'https://tw', 'https://one.example.com/v2']) type(field('Address'), v)
    fireEvent.blur(field('Address'))
    expect(within(dialog()).getByText('Saved')).toBeTruthy() // same origin
    type(field('Address'), 'https://two.example.com/v1')
    fireEvent.blur(field('Address'))
    expect(within(dialog()).getByText(/address changed/i)).toBeTruthy()
    press('Save')
    const [c] = await saved()
    expect(c).toMatchObject({ baseUrl: 'https://two.example.com/v1', key: '', readLogs: false, tools: 'unknown' })
    expect(c.consentHost).toBeUndefined()
    expect(c.contextTokens).toBeUndefined()
  })

  it.each([false, true])('a key typed for one host never goes to another: save stops and asks for it again (blur first: %s)', async (blur) => {
    await open([local({ baseUrl: 'https://one.example.com/v1' })])
    edit('My computer')
    type(field('Key'), KEY)
    type(field('Address'), 'https://two.example.com/v1')
    if (blur) fireEvent.blur(field('Address'))
    press('Save')
    expect(within(dialog()).getByRole('alert', { hidden: true }).textContent).toMatch(/Enter the key for it/)
    expect(field('Key').value).toBe('')
    expect((await db.getConnections())[0].baseUrl).toBe('https://one.example.com/v1')
    press('Save')
    expect((await saved())[0]).toMatchObject({ baseUrl: 'https://two.example.com/v1', key: '' })
  })

  it('shows only “Saved” for a key, keeps it on save, and can remove it', async () => {
    await open([cloud()])
    edit()
    expect(field('Key').value).toBe('')
    expect(document.body.innerHTML).not.toContain(KEY)
    type(field('Name'), 'Renamed')
    press('Save')
    expect((await saved())[0]).toMatchObject({ name: 'Renamed', key: KEY, consentHost: 'api.anthropic.com' })
    await screen.findByText('Renamed')
    edit('Renamed')
    press('Remove key')
    expect(within(dialog()).queryByText('Saved')).toBeNull()
    press('Save')
    expect((await saved())[0].key).toBe('')
  })

  it('asks for a lost key again, and a save without it keeps what was stored', async () => {
    await db.putConnections([cloud()])
    const raw = (await db.getMeta<{ key: string }[]>('assistantConnections'))!
    const stored = `${raw[0].key.slice(0, -6)}AAAAAA`
    await db.putMeta('assistantConnections', [{ ...raw[0], key: stored }])
    if (!(await db.getConnections())[0].keyLost) throw new Error('the key was not lost')
    await open([], {}, 'Work key')
    edit()
    expect(within(dialog()).getByText('Enter the key again')).toBeTruthy()
    type(field('Name'), 'Two'); press('Save'); await saved()
    expect((await db.getMeta<{ key: string }[]>('assistantConnections'))![0].key).toBe(stored)
    await screen.findByText('Two')
    edit('Two'); type(field('Key'), 'new-key-9999'); press('Save')
    expect((await saved())[0]).toMatchObject({ key: 'new-key-9999' })
  })

  it('turning the console tick on after consent asks again; says it covers all workspaces', async () => {
    await open([cloud()])
    edit()
    expect(dialog().textContent).toMatch(/console covers all your workspaces/i)
    fireEvent.click(field(/May read the console and send history \(responses included\)/))
    press('Save')
    const [c] = await saved()
    expect(c.readLogs).toBe(true)
    expect(c.consentHost).toBeUndefined()
  })

  it('a new model is not known to call tools', async () => {
    await open([cloud({ tools: 'yes' })])
    edit(); type(field('Model'), 'other'); press('Save')
    expect((await saved())[0]).toMatchObject({ model: 'other', tools: 'unknown' })
  })

  it('loads the model list on a click, from the address shown; errors hold no key', async () => {
    await open([local({ key: KEY })])
    edit('My computer')
    expect(dialog().textContent).toContain('OLLAMA_CONTEXT_LENGTH')
    expect(dialog().textContent).toContain('4,096')
    rust.answers.push({ body: JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }) })
    press('Load models')
    type(await within(dialog()).findByLabelText('Models offered'), 'm-two')
    expect(field('Model').value).toBe('m-two')
    expect(sent().map((r) => r.url)).toEqual(['http://localhost:11434/v1/models'])
    rust.answers.push({ status: 401, body: JSON.stringify({ error: { message: `bad ${KEY}` } }) })
    press('Load models')
    expect((await within(dialog()).findByRole('alert', { hidden: true })).textContent).toMatch(/didn’t accept the key/)
    expect(dialog().textContent).not.toContain(KEY)
  })

  it('loading the list right after changing the address sends no key there, and a save right after drops the context size', async () => {
    await open([local({ key: 'saved-KEY-777777', baseUrl: 'https://one.example.com/v1', contextTokens: 8000 })])
    edit('My computer')
    type(field('Key'), KEY)
    type(field('Address'), 'https://two.example.com/v1')
    rust.answers.push({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    press('Load models')
    await within(dialog()).findByLabelText('Models offered')
    expect(sent()[0].url).toBe('https://two.example.com/v1/models')
    expect(JSON.stringify(sent())).not.toMatch(/KEY/)
    press('Cancel')
    edit('My computer')
    type(field('Address'), 'https://two.example.com/v1')
    press('Save')
    expect((await saved())[0].contextTokens).toBeUndefined()
  })

  it('a save changes only what was edited, and never brings back a removed connection', async () => {
    await open([cloud({ consentHost: undefined, tools: 'unknown' })])
    edit()
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, tools: 'yes', consentHost: 'api.anthropic.com', key: 'newer-KEY-999' }))))
    type(field('Name'), 'Renamed'); press('Save')
    expect((await saved())[0]).toMatchObject({ name: 'Renamed', tools: 'yes', consentHost: 'api.anthropic.com', key: 'newer-KEY-999' })
    await screen.findByText('Renamed')
    edit('Renamed')
    await act(() => updateConnections(() => []))
    press('Save')
    expect((await within(dialog()).findByRole('alert', { hidden: true })).textContent).toMatch(/removed/)
    expect(await db.getConnections()).toEqual([])
  })

  it('a yes given meanwhile does not survive a new address or a new console tick', async () => {
    await open([local({ baseUrl: 'https://one.example.com/v1', readLogs: false })])
    edit('My computer')
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, consentHost: 'one.example.com' }))))
    fireEvent.click(field(/May read the console/))
    press('Save')
    expect((await saved())[0].consentHost).toBeUndefined()
  })

  it('a bad address is marked on its field', async () => {
    await open([local()])
    edit('My computer')
    expect(field('Address').getAttribute('aria-invalid')).not.toBe('true')
    type(field('Address'), 'nope'); fireEvent.blur(field('Address'))
    expect(field('Address').getAttribute('aria-invalid')).toBe('true')
    const alert = within(dialog()).getByRole('alert', { hidden: true })
    expect(field('Address').getAttribute('aria-describedby')).toBe(alert.id)
    expect(alert.parentElement!.className).toBe('connectionMessage')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    within(dialog()).getByRole('button', { name: 'Save', hidden: true }).dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true) // the field isn't left before the click lands
  })

  it('closing cancels a model list on its way; a long list is cut at 500', async () => {
    await open([local()])
    edit('My computer')
    rust.answers.push('hang')
    press('Load models')
    await waitFor(() => expect(sent()).toHaveLength(1))
    press('Cancel')
    await waitFor(() => expect(rust.cancelled).toBe(1))
    edit('My computer')
    rust.answers.push({ body: JSON.stringify({ data: Array.from({ length: 700 }, (_, i) => ({ id: `m${i}` })) }) })
    press('Load models')
    const offered = await within(dialog()).findByLabelText('Models offered') as HTMLSelectElement
    expect([...offered.options].filter((o) => o.value)).toHaveLength(500)
    expect(dialog().textContent).toMatch(/first 500/)
  })

  it('closing cancels a list of Anthropic’s too', async () => {
    await open([cloud()])
    edit()
    rust.answers.push('hang')
    press('Load models')
    await waitFor(() => expect(sent()).toHaveLength(1))
    press('Cancel')
    await waitFor(() => expect(rust.cancelled).toBe(1))
  })

  it('warns about plain http on a private network, not on this computer', async () => {
    await open([local()])
    edit('My computer')
    expect(dialog().textContent).not.toMatch(/could read/)
    type(field('Address'), 'http://192.168.1.5:11434/v1'); fireEvent.blur(field('Address'))
    expect(dialog().textContent).toMatch(/Plain http.*could read/)
  })

  it('removes one after asking', async () => {
    await open([cloud(), local()])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work key' }))
    press('Cancel')
    await act(async () => {})
    expect(await db.getConnections()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work key' }))
    press('Delete')
    await waitFor(async () => expect((await db.getConnections()).map((c) => c.id)).toEqual(['l']))
  })

  it('keep-chats tick and delete all chats', async () => {
    await saveChat({ id: 'x', spaceId: 'default', connectionId: 'a', model: 'm', title: 't', messages: [], updatedAt: 1 })
    await open()
    fireEvent.click(screen.getByLabelText('Keep chats on this device'))
    expect(setSettings).toHaveBeenCalledWith({ keepChats: false })
    fireEvent.click(screen.getByRole('button', { name: 'Delete all chats' }))
    expect(await listChats('default')).toHaveLength(1)
    press('Delete')
    await waitFor(async () => expect(await listChats('default')).toEqual([]))
  })
})

describe('Test', () => {
  const run = (name = 'My computer') => fireEvent.click(screen.getByRole('button', { name: `Test ${name}` }))
  const result = (name = 'My computer') => screen.findByRole('status', { name: `Test of ${name}` })

  it('reachable, streams, calls its own tool, answers: tools yes, saved; sends no workspace data', async () => {
    await open([local()])
    rust.answers.push(calls('ping', '{"word":"dispatch"}'), says('pong it is'))
    run()
    await waitFor(async () => expect((await result()).textContent).toMatch(/Reachable.*Streams.*Calls tools.*Answers/))
    expect((await db.getConnections())[0].tools).toBe('yes')
    expect(bodyOf(0).tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['ping'])
    expect(bodyOf(1).messages.at(-1)).toMatchObject({ role: 'tool', content: 'pong' })
  })

  it('needs no consent', async () => {
    await open([local({ baseUrl: 'https://models.example.com/v1', key: KEY })])
    rust.answers.push(calls('ping', '{"word":"dispatch"}'), says('pong'))
    run()
    await waitFor(async () => expect((await db.getConnections())[0].tools).toBe('yes'))
  })

  it.each([
    ['never calls it', [says('hello there')]],
    ['calls it with input that does not fit', [calls('ping', '{"word":7}'), says('hello')]],
    ['calls a tool that is not there', [calls('get_request', '{"name":"x"}'), says('hello')]],
    ['refuses tools', [{ status: 400, body: JSON.stringify({ error: { message: 'does not support tools' } }) }, says('hello')]],
  ] as [string, Answer[]][])('a model that %s: text questions only', async (_n, answers) => {
    await open([local({ tools: 'yes' })])
    rust.answers.push(...answers)
    run()
    await waitFor(async () => expect((await result()).textContent).toMatch(/text questions only/))
    expect((await db.getConnections())[0].tools).toBe('no')
    expect(rust.answers).toEqual([])
  })

  it('a failure is plain, without the key, and leaves the setting alone', async () => {
    await open([local({ tools: 'yes', key: KEY })])
    rust.answers.push({ status: 401, body: JSON.stringify({ error: { message: `nope ${KEY}` } }) })
    run()
    await waitFor(async () => expect((await result()).textContent).toMatch(/didn’t accept the key/))
    expect(document.body.innerHTML).not.toContain(KEY)
    expect((await db.getConnections())[0].tools).toBe('yes')
  })

  it('Stop cancels, and so does leaving', async () => {
    const r = await open([local()])
    rust.answers.push('hang', 'hang')
    run()
    await waitFor(() => expect(sent()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Stop testing My computer' }))
    await waitFor(() => expect(rust.cancelled).toBe(1))
    await screen.findByRole('button', { name: 'Test My computer' })
    run()
    await waitFor(() => expect(sent()).toHaveLength(2))
    r.unmount()
    await waitFor(() => expect(rust.cancelled).toBe(2))
    expect((await db.getConnections())[0].tools).toBe('unknown')
  })
})

describe('consent', () => {
  const base = "models.example.com:8443 will receive what you write and what the assistant reads here: requests, scripts and plain variable values. Known secrets are hidden, but Dispatch can't recognise every secret, and ordinary data in responses is not hidden."
  const conn = (readLogs: boolean) => local({ baseUrl: 'https://models.example.com:8443/v1', readLogs })
  it('says it exactly', () => {
    const allow = vi.fn(), not = vi.fn()
    render(<ConsentDialog connection={conn(false)} onAllow={allow} onDecline={not} />)
    expect(within(dialog()).getByText(base)).toBeTruthy()
    expect(dialog().textContent).not.toMatch(/all your workspaces/)
    press('Not now'); expect(not).toHaveBeenCalledOnce()
    press('Allow models.example.com:8443'); expect(allow).toHaveBeenCalledOnce()
  })
  it('with the console: the clause, and that it covers all workspaces', () => {
    render(<ConsentDialog connection={conn(true)} onAllow={() => {}} onDecline={() => {}} />)
    expect(within(dialog()).getByText(base.replace('variable values.', 'variable values, and the console and past responses.'))).toBeTruthy()
    expect(dialog().textContent).toMatch(/The console covers all your workspaces/)
  })
})
