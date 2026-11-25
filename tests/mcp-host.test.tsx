import { describe, expect, it, vi } from 'vitest'
import { ParameterBatches } from '../src/core/assistant/batches'
import { handleMcp, type McpServeOptions } from '../src/core/mcpHandler'
import type { Transport } from '../src/core/transport'
import { ASSISTANT_SPACE, type Collection, type Environment, type KV, type RequestDef, defaultSettings, emptyAuth, emptyBody, kv, newCollection, newEnvironment, newFolder, newRequest } from '../src/core/types'
import { type AssistantChanges, hide, hideInText } from '../src/core/mcpWorkspace'

/** The desktop app's MCP endpoint serves every collection in the workspace and saves what a send changed. */
describe('MCP handler for the desktop app', () => {
  const a = newCollection('Auth')
  const b = newCollection('Shop')
  const login = newRequest({ name: 'Login', method: 'POST', url: 'https://api.test/login', collectionId: a.id })
  const loginB = newRequest({ name: 'Login', method: 'POST', url: 'https://shop.test/login', collectionId: b.id })
  const items = newRequest({ name: 'Items', method: 'GET', url: 'https://shop.test/items', collectionId: b.id })
  const sent: string[] = []
  const transport: Transport = {
    label: 'test', unrestricted: true,
    send: async (p) => { sent.push(`${p.method} ${p.url}`); return { status: 200, statusText: 'OK', headers: [], body: '{"ok":true}', binary: false, size: 11, timeMs: 1 } },
  }
  const base = (over = {}) => ({
    ws: { source: 'dispatch' as const, collections: [a, b], folders: [], requests: [login, loginB, items], environments: [], flows: [], warnings: [] },
    environment: null, globals: [], settings: defaultSettings, transport, pipeline: {}, allowMethods: [], version: 'test', allCollections: true, ...over,
  })
  const call = (name: string, args: object, o = base()) => handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, o)

  it('lists requests from every collection with the collection name first', async () => {
    const r = await call('list_requests', {})
    expect(r.result.content[0].text).toContain('POST   Auth/Login')
    expect(r.result.content[0].text).toContain('GET    Shop/Items')
  })

  it('asks for the full path when a name is in several collections', async () => {
    const r = await call('send_request', { name: 'Login' })
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toContain('Auth/Login, Shop/Login')
  })

  it('sends by path or unique name and calls afterSend so the app can save changes', async () => {
    const afterSend = vi.fn(async () => {})
    const r = await call('send_request', { name: 'Shop/Login' }, base({ hooks: { afterSend } }))
    expect(r.result.isError).toBeUndefined()
    expect(sent).toContain('POST https://shop.test/login')
    expect(afterSend).toHaveBeenCalledOnce()
    expect((afterSend.mock.calls[0] as any[])[1].collection.id).toBe(b.id)
    // The request sent goes along too, so the app can add it to History.
    expect((afterSend.mock.calls[0] as any[])[2]).toMatchObject({ name: 'Login', method: 'POST' })
    await call('send_request', { name: 'Items' })
    expect(sent).toContain('GET https://shop.test/items')
  })

  it('keeps the allowed-methods limit', async () => {
    const r = await call('send_request', { name: 'Auth/Login' }, base({ allowMethods: ['GET', 'HEAD'] }))
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toContain('aren’t allowed')
  })

  it('needs a collection or folder to run', async () => {
    expect((await call('run_collection', {})).result.isError).toBe(true)
    const r = await call('run_collection', { folder: 'Shop' }, base({ allowMethods: ['GET'] }))
    expect(r.result.content[0].text).toContain('POST Login')
  })

  it('serves only the first collection for the CLI, as before', async () => {
    const r = await call('list_requests', {}, base({ allCollections: false }))
    expect(r.result.content[0].text).toBe('POST   Login  https://api.test/login')
  })
})

/** The endpoint restarts when the port changes, so the port applies on blur or Enter, never per keystroke. */
describe('MCP endpoint port setting', () => {
  it('applies the port once, on blur, clamped', async () => {
    const { render, fireEvent, screen } = await import('@testing-library/react')
    const { SettingsView } = await import('../src/ui/SettingsView')
    const setSettings = vi.fn()
    const ws = { settings: { ...defaultSettings, mcpHostEnabled: true }, transport: { unrestricted: true }, setSettings } as any
    render(<SettingsView ws={ws} notify={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'AI assistants' }))
    const port = screen.getByLabelText('MCP port') as HTMLInputElement
    for (const v of ['4', '43', '432', '4321']) fireEvent.change(port, { target: { value: v } })
    expect(setSettings).not.toHaveBeenCalled()
    fireEvent.blur(port)
    expect(setSettings).toHaveBeenCalledOnce()
    expect(setSettings).toHaveBeenCalledWith({ mcpHostPort: 4321 })
    fireEvent.change(port, { target: { value: '80' } })
    fireEvent.keyDown(port, { key: 'Enter' })
    expect(setSettings).toHaveBeenLastCalledWith({ mcpHostPort: 1024 })
    expect(port.value).toBe('1024')
  })
})

/** The assistant's own workspace: writes go there only; the user's requests stay list-and-send. */
describe('MCP assistant workspace', () => {
  const shop = { ...newCollection('Shop'), auth: { ...newCollection().auth, kind: 'bearer' as const, token: '{{tok}}' }, variables: [kv('base', 'https://shop.test')] }
  const orders = newFolder(shop.id, 'Orders')
  const items = newRequest({ name: 'Items', url: '{{base}}/items', collectionId: shop.id, folderId: orders.id })
  const lab = { ...newCollection('Lab'), workspaceId: ASSISTANT_SPACE.id }
  const probe = newRequest({ name: 'Probe', method: 'POST', url: 'https://lab.test/p', collectionId: lab.id, sort: 5 })
  const sent: string[] = []
  const transport: Transport = { label: 'test', unrestricted: true, send: async (p) => { sent.push(`${p.method} ${p.url}`); return { status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 } } }
  const setup = (withWorkspace = true, own: Collection[] = [lab]) => {
    const saved: AssistantChanges[] = []
    const removed: string[][] = []
    const o = {
      ws: { source: 'dispatch' as const, collections: [shop], folders: [orders], requests: [items, probe], environments: [], flows: [], warnings: [] },
      environment: null, globals: [], settings: defaultSettings, transport, pipeline: {}, allowMethods: ['GET', 'HEAD'], version: 'test', allCollections: true,
      workspace: withWorkspace ? { batches: new ParameterBatches(), collections: own, save: async (c: AssistantChanges) => { saved.push(c) }, remove: async (ids: string[]) => { removed.push(ids) } } : undefined,
    }
    const call = (name: string, args: object) => handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, o)
    const tools = async () => (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, o)).result.tools.map((t: { name: string }) => t.name)
    return { o, call, tools, saved, removed }
  }
  const txt = (r: any) => r.result.content[0].text as string

  it('offers the write tools only with the workspace on', async () => {
    expect(await setup(false).tools()).not.toContain('create_request')
    expect((await setup(false).call('create_request', { folder: 'assistant/X', name: 'A', url: 'https://a.test' })).error.message).toContain('Unknown tool')
    expect(await setup().tools()).toEqual(expect.arrayContaining(['create_request', 'update_request', 'copy_request', 'delete_request']))
  })

  it('lists the assistant workspace under "assistant/" and keeps the method limit for it', async () => {
    const { call } = setup()
    const list = txt(await call('list_requests', {}))
    expect(list).toContain('GET    Shop/Orders/Items')
    expect(list).toContain('POST   assistant/Lab/Probe')
    const r = await call('send_request', { name: 'assistant/Lab/Probe' })
    expect(txt(r)).toContain('aren’t allowed')
    expect(sent).toEqual([])
  })

  it('creates into a new collection and folders, which land in the assistant workspace', async () => {
    const { call, saved } = setup()
    const r = await call('create_request', { folder: 'assistant/Checkout/Cart', name: 'Add', method: 'post', url: 'https://shop.test/cart?x=1', headers: { 'X-A': '1' }, body: '{"q":1}' })
    expect(txt(r)).toContain('Saved POST assistant/Checkout/Cart/Add')
    expect(txt(r)).toContain('POST has to be added')
    const c = saved[0]
    expect(c.collections).toHaveLength(1)
    expect(c.collections[0]).toMatchObject({ name: 'Checkout', workspaceId: ASSISTANT_SPACE.id })
    expect(c.folders.map((f) => f.name)).toEqual(['Cart'])
    expect(c.requests[0]).toMatchObject({ name: 'Add', method: 'POST', collectionId: c.collections[0].id, folderId: c.folders[0].id })
    expect(c.requests[0].body).toMatchObject({ kind: 'json', text: '{"q":1}' })
    expect(c.requests[0].params.map((p) => p.key)).toEqual(['x'])
    expect(c.requests[0].headers.map((h) => [h.key, h.value])).toEqual([['X-A', '1']])
  })

  it('creates in an existing assistant collection, also without the prefix, after what is there', async () => {
    const { call, saved } = setup()
    await call('create_request', { folder: 'Lab', name: 'Ping', url: 'https://lab.test/ping' })
    expect(saved[0].collections).toEqual([])
    expect(saved[0].requests[0]).toMatchObject({ collectionId: lab.id, folderId: null, method: 'GET' })
    expect(saved[0].requests[0].sort).toBeGreaterThan(probe.sort)
    expect(txt(await call('create_request', { folder: 'assistant/Lab', name: 'Probe', url: 'https://x.test' }))).toContain('update_request')
  })

  it('updates only the fields given, in its own workspace', async () => {
    const { call, saved } = setup()
    const r = await call('update_request', { name: 'assistant/Lab/Probe', url: 'https://lab.test/p2?v=2', body: 'plain' })
    expect(txt(r)).toContain('Updated assistant/Lab/Probe (URL, body)')
    const next = saved[0].requests[0]
    expect(next).toMatchObject({ id: probe.id, name: 'Probe', method: 'POST', url: 'https://lab.test/p2?v=2' })
    expect(next.params.map((p) => [p.key, p.value])).toEqual([['v', '2']])
    expect(next.body).toMatchObject({ kind: 'text', text: 'plain' })
    await call('update_request', { name: 'assistant/Lab/Probe', newName: 'Probe 2', method: 'get' })
    expect(saved[1].requests[0]).toMatchObject({ name: 'Probe 2', method: 'GET' })
    expect((await call('update_request', { name: 'assistant/Lab/Probe' })).result.isError).toBe(true)
  })

  it('never changes or deletes the user’s requests', async () => {
    const { call, saved, removed } = setup()
    for (const tool of ['update_request', 'delete_request']) {
      const r = await call(tool, { name: 'Shop/Orders/Items', url: 'https://evil.test' })
      expect(r.result.isError).toBe(true)
      expect(txt(r)).toContain('copy_request')
    }
    // A path naming the user's collection makes a new collection in the assistant workspace, not a write to theirs.
    await call('create_request', { folder: 'Shop/Orders', name: 'Sneaky', url: 'https://x.test' })
    expect(saved[0].collections[0]).toMatchObject({ name: 'Shop', workspaceId: ASSISTANT_SPACE.id })
    expect(saved[0].collections[0].id).not.toBe(shop.id)
    expect(saved[0].requests[0].collectionId).not.toBe(shop.id)
    expect(saved.flatMap((c) => c.requests).some((r) => r.id === items.id)).toBe(false)
    expect(removed).toEqual([])
  })

  it('copies a user request with its inherited auth, and the collection variables into a new collection', async () => {
    const { call, saved } = setup()
    const r = await call('copy_request', { from: 'Shop/Orders/Items', to: 'assistant/Shop copy', name: 'Items v2' })
    expect(txt(r)).toContain('Copied Shop/Orders/Items to assistant/Shop copy/Items v2')
    const c = saved[0]
    const copy = c.requests[0]
    expect(copy.id).not.toBe(items.id)
    expect(copy).toMatchObject({ name: 'Items v2', url: '{{base}}/items', collectionId: c.collections[0].id, folderId: null })
    expect(copy.auth).toMatchObject({ kind: 'bearer', token: '{{tok}}' })
    expect(c.collections[0].variables.map((v) => v.key)).toEqual(['base'])
    expect(items.auth.kind).toBe('inherit')
    expect(items.collectionId).toBe(shop.id)
  })

  it('says nothing about auth when the copied request had none', async () => {
    const { o, call } = setup()
    const plain = newCollection('Plain')
    const ping = newRequest({ name: 'Ping', url: 'https://p.test', collectionId: plain.id })
    ;(o.ws.collections as Collection[]).push(plain); o.ws.requests.push(ping)
    const r = await call('copy_request', { from: 'Plain/Ping', to: 'assistant/Pings' })
    expect(txt(r)).toContain('Copied Plain/Ping to assistant/Pings/Ping')
    expect(txt(r)).not.toMatch(/auth/)
  })

  it('deletes its own requests', async () => {
    const { call, removed } = setup()
    expect(txt(await call('delete_request', { name: 'assistant/Lab/Probe' }))).toContain('Deleted assistant/Lab/Probe')
    expect(removed).toEqual([[probe.id]])
  })
})

/** The Settings checkbox for it, off by default. */
describe('MCP assistant workspace setting', () => {
  it('is off by default and toggles mcpHostWorkspace', async () => {
    expect(defaultSettings.mcpHostWorkspace).toBe(false)
    const { cleanup, render, fireEvent, screen } = await import('@testing-library/react')
    cleanup() // the port test above leaves its Settings rendered
    const { SettingsView } = await import('../src/ui/SettingsView')
    const setSettings = vi.fn()
    const ws = { settings: { ...defaultSettings, mcpHostEnabled: true }, transport: { unrestricted: true }, setSettings } as any
    render(<SettingsView ws={ws} notify={() => {}} />)
    const aiTab = screen.queryByRole('tab', { name: 'AI assistants' }) // Settings may be split into tabs
    if (aiTab) fireEvent.click(aiTab)
    fireEvent.click(screen.getByRole('checkbox', { name: /their own workspace/ }))
    expect(setSettings).toHaveBeenCalledWith({ mcpHostWorkspace: true })
    // Reading the console, history and environments: its own switch, off by default.
    expect(defaultSettings.mcpHostLogs).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: /read the console, history and environments/ }))
    expect(setSettings).toHaveBeenCalledWith({ mcpHostLogs: true })
  })
})

/** Requests the user hands over, get_request, filing with move_request, and workspaces the user lets it edit. */
describe('MCP assistant inbox and editable workspaces', () => {
  const shop = { ...newCollection('Shop'), workspaceId: 'w1', auth: { ...newCollection().auth, kind: 'bearer' as const, token: 'sk-live-123456789' }, variables: [kv('base', 'https://shop.test'), kv('apiToken', 'abc123secret')] }
  const orders = newFolder(shop.id, 'Orders')
  const items = newRequest({ name: 'Items', url: '{{base}}/items?api_key=zzz999', collectionId: shop.id, folderId: orders.id, headers: [kv('Authorization', 'Bearer abcdefghijkl'), kv('X-Trace', '1')] })
  const inbox = { ...newCollection('Inbox'), workspaceId: ASSISTANT_SPACE.id }
  const handed = newRequest({
    name: 'Login', method: 'POST', url: 'https://qa.shop.test/login', collectionId: inbox.id,
    auth: { ...newCollection().auth, kind: 'bearer' as const, token: '{{tok}}' },
    body: { ...newRequest().body, kind: 'json', text: '{"user":"me","password":"hunter2"}' },
    handoff: { note: 'make the host a variable', from: 'Shop/Login', at: Date.UTC(2026, 10, 17, 9, 30), variables: [kv('base', 'https://shop.test')] },
  })
  const transport: Transport = { label: 'test', unrestricted: true, send: async () => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }) }
  const setup = (editable = false, extraRequests: RequestDef[] = [], extraCollections: Collection[] = []) => {
    const saved: AssistantChanges[] = []
    const removed: string[][] = []
    const o = {
      ws: { source: 'dispatch' as const, collections: [shop, ...extraCollections], folders: [orders], requests: [items, handed, ...extraRequests], environments: [], flows: [], warnings: [] },
      environment: null, globals: [], settings: defaultSettings, transport, pipeline: {}, allowMethods: [], version: 'test', allCollections: true,
      workspace: {
        batches: new ParameterBatches(),
        collections: [inbox], save: async (c: AssistantChanges) => { saved.push(c) }, remove: async (ids: string[]) => { removed.push(ids) },
        ...(editable ? { editable: { name: 'Work', workspaceId: 'w1', collections: [shop, ...extraCollections] } } : {}),
      },
    }
    const call = (name: string, args: object) => handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, o)
    const tools = async () => (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, o)).result.tools as { name: string; description: string }[]
    const init = async () => (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, o)).result.instructions as string
    return { call, tools, init, saved, removed }
  }
  const txt = (r: any) => r.result.content[0].text as string

  it('flags handed-over requests in list_requests and the instructions', async () => {
    const { call, init } = setup()
    const list = txt(await call('list_requests', {}))
    expect(list.split('\n')[0]).toContain('handed you 1 request')
    expect(list).toContain('POST   assistant/Inbox/Login  https://qa.shop.test/login  ← handed to you: make the host a variable')
    expect(list).not.toMatch(/Items.*handed/)
    expect(await init()).toContain('handed you 1 request in assistant/Inbox')
  })

  it('get_request shows a request in full with secrets hidden', async () => {
    const { call } = setup()
    const user = txt(await call('get_request', { name: 'Shop/Orders/Items' }))
    expect(user).toContain('GET Shop/Orders/Items')
    expect(user).toContain('Auth: bearer (inherited) — token: <hidden>')
    expect(user).toContain('Authorization: Bearer <hidden>')
    expect(user).toContain('X-Trace: 1')
    expect(user).toContain('api_key=<hidden>')
    expect(user).toContain('base = https://shop.test, apiToken = <hidden>')
    for (const secret of ['sk-live', 'abcdefghijkl', 'zzz999', 'abc123secret']) expect(user).not.toContain(secret)
    const mine = txt(await call('get_request', { name: 'assistant/Inbox/Login' }))
    expect(mine).toContain('"password":"<hidden>"')
    expect(mine).not.toContain('hunter2')
    expect(mine).toContain('token: {{tok}}')
    expect(mine).toContain('from “Shop/Login”, asking: make the host a variable')
  })

  it('refuses to write a hidden value back', async () => {
    const { call, saved } = setup()
    const r = await call('update_request', { name: 'assistant/Inbox/Login', body: '{"user":"me","password":"<hidden>"}' })
    expect(r.result.isError).toBe(true)
    expect(txt(r)).toContain('can’t be saved')
    expect(saved).toEqual([])
  })

  it('files a handed-over request with move_request: new collection gets the variables, flag cleared', async () => {
    const { call, saved } = setup()
    await call('update_request', { name: 'assistant/Inbox/Login', url: '{{base}}/login' })
    expect(saved[0].requests[0].handoff).toBeDefined()
    const r = await call('move_request', { name: 'assistant/Inbox/Login', to: 'assistant/Shop/Auth', newName: 'Sign in' })
    expect(txt(r)).toContain('Moved assistant/Inbox/Login to assistant/Shop/Auth/Sign in')
    const c = saved[1]
    expect(c.collections[0]).toMatchObject({ name: 'Shop', workspaceId: ASSISTANT_SPACE.id })
    expect(c.collections[0].variables.map((v) => v.key)).toEqual(['base'])
    expect(c.requests[0]).toMatchObject({ id: handed.id, name: 'Sign in', collectionId: c.collections[0].id, folderId: c.folders[0].id })
    expect(c.requests[0].handoff).toBeUndefined()
    expect(c.requests[0].body.text).toContain('hunter2')
  })

  it('never loses a secret it was shown as <hidden> when it rewrites a field', async () => {
    const { call, saved } = setup(true)
    // Headers: leaving out the hidden Authorization keeps it; naming it replaces it.
    const h = txt(await call('update_request', { name: 'Shop/Orders/Items', headers: { 'X-Trace': '2' } }))
    expect(h).toContain('Kept the hidden Authorization header')
    // The kept header keeps its place (it came first).
    expect(saved[0].requests[0].headers.map((y) => [y.key, y.value])).toEqual([['Authorization', 'Bearer abcdefghijkl'], ['X-Trace', '2']])
    await call('update_request', { name: 'Shop/Orders/Items', headers: { authorization: 'Bearer {{token}}' } })
    expect(saved[1].requests[0].headers.map((y) => [y.key, y.value])).toEqual([['authorization', 'Bearer {{token}}']])
    // URL, body and scripts holding a hidden value can't be rewritten (they'd drop it).
    const u = await call('update_request', { name: 'Shop/Orders/Items', url: '{{base}}/items/v2' })
    expect(u.result.isError).toBe(true)
    expect(txt(u)).toContain('The URL holds a secret')
    const b = await call('update_request', { name: 'assistant/Inbox/Login', body: '{"user":"me"}' })
    expect(b.result.isError).toBe(true)
    expect(txt(b)).toContain('The body holds a secret')
    expect(saved).toHaveLength(2)
    // A URL with nothing hidden changes as before.
    expect(txt(await call('update_request', { name: 'assistant/Inbox/Login', url: '{{base}}/login' }))).toContain('(URL)')
  })

  it('hides secrets in docs, URL passwords and the hand-off note too', async () => {
    const docs = { ...items, id: 'docs1', name: 'Docs', url: 'https://bob:pa55word@shop.test/x', docs: 'Call with Authorization: Bearer abcdefghijkl0', handoff: { note: 'token=qq77secret is wrong', from: 'x', at: 0 } }
    const { call } = setup(true, [docs])
    const t = txt(await call('get_request', { name: 'Shop/Orders/Docs' }))
    expect(t).toContain('https://bob:<hidden>@shop.test/x')
    expect(t).toContain('Bearer <hidden>')
    expect(t).toContain('token=<hidden>')
    for (const secret of ['pa55word', 'abcdefghijkl0', 'qq77secret']) expect(t).not.toContain(secret)
    expect(txt(await call('update_request', { name: 'Shop/Orders/Docs', docs: 'new' }))).toContain('The docs text holds a secret')
  })

  it('list_requests and send errors hide secrets too', async () => {
    const login = { ...items, id: 'login1', name: 'Login', url: 'https://bob:pa55word@shop.test/login', handoff: { note: 'use token=qq77secret', from: 'x', at: 0 } }
    const { call } = setup(false, [login])
    const list = txt(await call('list_requests', {}))
    expect(list).toContain('{{base}}/items?api_key=<hidden>')
    expect(list).toContain('https://bob:<hidden>@shop.test/login')
    expect(list).toContain('use token=<hidden>')
    for (const secret of ['zzz999', 'pa55word', 'qq77secret']) expect(list).not.toContain(secret)
    // A transport error that repeats the resolved URL.
    const failing: Transport = { label: 'test', unrestricted: true, send: async (r) => { throw new Error(`builder error for url (${r.url})`) } }
    const o = {
      ws: { source: 'dispatch' as const, collections: [shop], folders: [orders], requests: [items], environments: [], flows: [], warnings: [] },
      environment: null, globals: [], settings: defaultSettings, transport: failing, pipeline: {}, allowMethods: [], version: 'test', allCollections: true,
    }
    const r = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_request', arguments: { name: 'Shop/Orders/Items' } } }, o)
    expect(r.result.isError).toBe(true)
    expect(txt(r)).toContain('api_key=<hidden>')
    expect(txt(r)).not.toContain('zzz999')
  })

  it('bare paths: the assistant’s own collection stays its own, a user collection called “assistant” is reachable', async () => {
    const { call, saved } = setup(true)
    // "Inbox" exists only in the assistant's workspace: a bare path still means that one.
    await call('create_request', { folder: 'Inbox', name: 'Bare', url: 'https://x.test' })
    expect(saved[0].collections).toEqual([])
    expect(saved[0].requests[0].collectionId).toBe(inbox.id)
    // A user collection named "assistant" (the assistant has none called that).
    const theirs = { ...newCollection('assistant'), workspaceId: 'w1' }
    const two = setup(true, [], [theirs])
    expect(txt(await two.call('set_variables', { collection: 'assistant', variables: { a: '1' } }))).toContain('Collection assistant: set a')
    expect(two.saved[0].collections[0].id).toBe(theirs.id)
  })

  it('moving within a collection keeps inheriting when the auth there is the same', async () => {
    const { call, saved } = setup(true)
    const r = txt(await call('move_request', { name: 'Shop/Orders/Items', to: 'Shop/Archive' }))
    expect(r).not.toContain('auth it inherited')
    expect(saved[0].requests[0].auth.kind).toBe('inherit')
    // Out of the collection, into one with other auth: the inherited auth is copied on.
    const r2 = txt(await call('move_request', { name: 'Shop/Orders/Items', to: 'assistant/Lab' }))
    expect(r2).toContain('the bearer auth it inherited was copied onto it')
  })

  it('update_request reviewed:true clears the flag in place', async () => {
    const { call, saved } = setup()
    expect(txt(await call('update_request', { name: 'assistant/Inbox/Login', reviewed: true }))).toContain('marked reviewed')
    expect(saved[0].requests[0].handoff).toBeUndefined()
  })

  it('without edit access the user’s workspace stays list-and-send', async () => {
    const { call, saved } = setup()
    expect((await call('move_request', { name: 'Shop/Orders/Items', to: 'assistant/X' })).result.isError).toBe(true)
    expect(txt(await call('set_variables', { collection: 'Shop', variables: { a: '1' } }))).toContain('can’t change')
    expect(saved).toEqual([])
  })

  it('with edit access it writes to the open workspace by plain paths, and says so', async () => {
    const { call, tools, init, saved, removed } = setup(true)
    expect((await tools()).find((t) => t.name === 'create_request')!.description).toContain('the user’s workspace “Work”')
    expect(await init()).toContain('you may also change the user’s workspace “Work”')
    await call('create_request', { folder: 'Shop/Orders', name: 'Add', url: '{{base}}/items' })
    expect(saved[0].collections).toEqual([])
    expect(saved[0].requests[0]).toMatchObject({ collectionId: shop.id, folderId: orders.id })
    expect(txt(await call('update_request', { name: 'Shop/Orders/Items', method: 'PUT' }))).toContain('Updated Shop/Orders/Items (method)')
    expect(saved[1].requests[0]).toMatchObject({ id: items.id, method: 'PUT' })
    await call('create_request', { folder: 'Billing', name: 'Invoices', url: 'https://b.test' })
    expect(saved[2].collections[0]).toMatchObject({ name: 'Billing', workspaceId: 'w1' })
    expect(txt(await call('set_variables', { collection: 'Shop', variables: { base: 'https://v2.shop.test', region: 'eu' }, remove: ['apiToken'] }))).toContain('Collection Shop: set base, region; removed apiToken')
    expect(saved[3].collections[0].variables.map((v) => [v.key, v.value])).toEqual([['base', 'https://v2.shop.test'], ['region', 'eu']])
    // Filing a handed-over request into the user's workspace.
    expect(txt(await call('move_request', { name: 'assistant/Inbox/Login', to: 'Shop/Orders' }))).toContain('to Shop/Orders/Login')
    expect(saved[4].requests[0]).toMatchObject({ collectionId: shop.id, folderId: orders.id })
    await call('delete_request', { name: 'Shop/Orders/Items' })
    expect(removed).toEqual([[items.id]])
    // The assistant workspace still works by its prefix.
    await call('create_request', { folder: 'assistant/Lab', name: 'Ping', url: 'https://lab.test' })
    expect(saved[5].collections[0]).toMatchObject({ name: 'Lab', workspaceId: ASSISTANT_SPACE.id })
  })
})

/** Scripts: a request's own with update_request, a folder's or collection's with set_scripts. */
describe('MCP assistant scripts', () => {
  const lab = { ...newCollection('Lab'), workspaceId: ASSISTANT_SPACE.id, scripts: { pre: '', post: 'pm.test("ok", () => {})' } }
  const admin = { ...newFolder(lab.id, 'Admin'), scripts: { pre: 'pm.variables.set("t", "Bearer abcdefghijkl")', post: '' } }
  const probe = newRequest({ name: 'Probe', url: 'https://lab.test/p', collectionId: lab.id, folderId: admin.id, scripts: { pre: 'console.log(1)', post: '' } })
  const shop = newCollection('Shop')
  const setup = () => {
    const saved: AssistantChanges[] = []
    const transport: Transport = { label: 'test', unrestricted: true, send: async () => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }) }
    const o = {
      ws: { source: 'dispatch' as const, collections: [shop], folders: [admin], requests: [probe], environments: [], flows: [], warnings: [] },
      environment: null, globals: [], settings: defaultSettings, transport, pipeline: {}, allowMethods: [], version: 'test', allCollections: true,
      workspace: { batches: new ParameterBatches(), collections: [lab], save: async (c: AssistantChanges) => { saved.push(c) }, remove: async () => {} },
    }
    const call = (name: string, args: object) => handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, o)
    return { call, saved }
  }
  const txt = (r: any) => r.result.content[0].text as string

  it('get_request shows its own scripts and the ones its folder and collection add', async () => {
    const t = txt(await setup().call('get_request', { name: 'assistant/Lab/Admin/Probe' }))
    expect(t).toContain('Pre-request script:\nconsole.log(1)')
    expect(t).toContain('Folder “Admin” pre-request script (runs too):\npm.variables.set("t", "Bearer <hidden>")')
    expect(t).toContain('Collection “Lab” tests script (runs too):\npm.test("ok", () => {})')
  })

  it('update_request and create_request set a request’s scripts', async () => {
    const { call, saved } = setup()
    expect(txt(await call('update_request', { name: 'assistant/Lab/Admin/Probe', testScript: 'pm.test("200", () => pm.response.to.have.status(200))' }))).toContain('(tests script)')
    expect(saved[0].requests[0].scripts).toEqual({ pre: 'console.log(1)', post: 'pm.test("200", () => pm.response.to.have.status(200))' })
    await call('update_request', { name: 'assistant/Lab/Admin/Probe', preRequestScript: '' })
    expect(saved[1].requests[0].scripts.pre).toBe('')
    await call('create_request', { folder: 'assistant/Lab', name: 'New', url: 'https://lab.test/n', preRequestScript: 'pm.variables.set("a", 1)' })
    expect(saved[2].requests[0].scripts).toEqual({ pre: 'pm.variables.set("a", 1)', post: '' })
    expect((await call('update_request', { name: 'assistant/Lab/Admin/Probe', preRequestScript: 'x("<hidden>")' })).result.isError).toBe(true)
  })

  it('set_scripts changes a folder’s or collection’s scripts, never the user’s', async () => {
    const { call, saved } = setup()
    expect(txt(await call('set_scripts', { path: 'assistant/Lab/Admin', testScript: 'pm.test("a", () => {})' }))).toContain('Folder assistant/Lab/Admin: updated the tests script')
    expect(saved[0].folders[0]).toMatchObject({ id: admin.id, scripts: { pre: admin.scripts.pre, post: 'pm.test("a", () => {})' } })
    expect(txt(await call('set_scripts', { path: 'assistant/Lab', preRequestScript: 'console.log(2)' }))).toContain('Collection assistant/Lab: updated the pre-request script')
    expect(saved[1].collections[0]).toMatchObject({ id: lab.id, scripts: { pre: 'console.log(2)', post: lab.scripts.post } })
    expect((await call('set_scripts', { path: 'assistant/Lab/Nope', testScript: 'x' })).result.isError).toBe(true)
    expect(txt(await call('set_scripts', { path: 'Shop', testScript: 'x' }))).toContain('can’t change')
    // The folder's pre-request script holds a hidden token: rewriting it would lose it.
    const keep = await call('set_scripts', { path: 'assistant/Lab/Admin', preRequestScript: 'console.log(3)' })
    expect(keep.result.isError).toBe(true)
    expect(txt(keep)).toContain('The script holds a secret')
    expect(saved).toHaveLength(2)
  })
})

/** The hiding every MCP tool uses: secrets go, the text around them stays intact. */
describe('hiding secrets in text', () => {
  it('keeps JSON intact around a hidden name=value secret', () => {
    const json = '{\n  "url": "https://httpbin.org/anything?api_key=QS555",\n  "n": 1\n}'
    const out = hideInText(json)
    expect(out).toBe('{\n  "url": "https://httpbin.org/anything?api_key=<hidden>",\n  "n": 1\n}')
    expect(() => JSON.parse(out)).not.toThrow()
    expect(hideInText("curl 'https://x.test/?token=abc123'")).toBe("curl 'https://x.test/?token=<hidden>'")
    expect(hideInText('<a href=https://x.test/?password=pw99>')).toBe('<a href=https://x.test/?password=<hidden>>')
    expect(hideInText('a=1&secret=s3cr3t&b=2')).toBe('a=1&secret=<hidden>&b=2')
  })

  it('leaves CORS headers alone even though they mention credentials', () => {
    expect(hide('access-control-allow-credentials', 'true')).toBe('true')
    expect(hide('Access-Control-Allow-Headers', 'Authorization, X-Api-Key')).toBe('Authorization, X-Api-Key')
    expect(hide('Authorization', 'Bearer abc123456')).toBe('Bearer <hidden>')
    expect(hide('X-Credentials', 'abc')).toBe('<hidden>')
  })
})

/** suggest_parameters and apply_parameters: what "AI can edit" already allows, and nobody approves each change. */
describe('MCP parameter tools', () => {
  const TOKEN = 'plant-token-AAAA1', KEY = 'plant-apikey-BBBB2'
  const secretVar = (k: string, v: string) => kv(k, v, true, { secret: true })
  const shop = (over: Partial<Collection> = {}) => ({ ...newCollection('Shop'), workspaceId: 'w1', ...over })
  const req = (c: Collection, over: Partial<RequestDef> = {}) => newRequest({ name: 'Order', url: 'https://shop.test/users/12345/x', collectionId: c.id, sort: 1, headers: [kv('Authorization', `Bearer ${TOKEN}`), kv('X-API-Key', KEY)], ...over })
  interface O { collections?: Collection[]; own?: Collection[]; requests?: RequestDef[]; env?: Environment | null; globals?: KV[]; edit?: boolean; workspace?: boolean; all?: boolean; transport?: Transport; folders?: ReturnType<typeof newFolder>[] }
  /** Like the app: what is saved is there for the next call. */
  const setup = (x: O) => {
    const saved: AssistantChanges[] = []
    const all = x.collections ?? [], own = x.own ?? []
    const transport: Transport = x.transport ?? { label: 't', unrestricted: true, send: async () => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }) }
    const put = <T extends { id: string }>(list: T[], add: T[]) => { for (const a of add) { const i = list.findIndex((y) => y.id === a.id); if (i < 0) list.push(a); else list[i] = a } }
    const workspace: McpServeOptions['workspace'] = {
      batches: new ParameterBatches(), collections: own, editable: x.edit === false ? undefined : { name: 'Work', workspaceId: 'w1', collections: all },
      save: async (c) => { saved.push(c); for (const y of c.collections) put(own.some((z) => z.id === y.id) || y.workspaceId === ASSISTANT_SPACE.id ? own : all, [y]); put(o.ws.folders, c.folders); put(o.ws.requests, c.requests) },
      remove: async () => {},
    }
    const o: McpServeOptions = {
      ws: { source: 'dispatch', collections: all, folders: x.folders ?? [], requests: x.requests ?? [], environments: x.env ? [x.env] : [], flows: [], warnings: [] },
      environment: x.env ?? null, globals: x.globals ?? [], settings: defaultSettings, transport, pipeline: {}, allowMethods: [], version: 't', allCollections: x.all ?? true,
      workspace: x.workspace === false ? undefined : workspace,
    }
    const raw = (name: string, args: object) => handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, o)
    const call = async (name: string, args: object) => { const r = await raw(name, args); return { text: r.result?.content[0].text as string, bad: !!r.result?.isError } }
    const tools = async () => (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, o)).result.tools as { name: string; description: string; inputSchema: { properties: object } }[]
    const suggest = async (name = 'Shop/Order') => {
      const r = await call('suggest_parameters', { name })
      const lines = r.text.split('\n').filter((l) => l.includes(' · ')).map((l) => l.split(' · '))
      return { ...r, lines, batch: /batch: (\S+)/.exec(r.text)?.[1] ?? '', id: (what: string) => lines.find((l) => l.slice(0, 3).join(' ').includes(what))?.[0] ?? `no ${what}` }
    }
    const move = async (what: Record<string, string>, name = 'Shop/Order') => {
      const s = await suggest(name)
      return call('apply_parameters', { name, batch: s.batch, choose: Object.fromEntries(Object.entries(what).map(([w, n]) => [s.id(w), n])) })
    }
    return { o, workspace, saved, raw, call, tools, suggest, move }
  }
  const NAMES = ['suggest_parameters', 'apply_parameters']

  it('are offered only with the workspace on, and never to dispatch-run mcp', async () => {
    const c = shop(), r = req(c)
    expect((await setup({ collections: [c], requests: [r] }).tools()).map((t) => t.name)).toEqual(expect.arrayContaining(NAMES))
    for (const off of [{ workspace: false }, { workspace: false, all: false }, { all: false }]) {
      const s = setup({ collections: [c], requests: [r], ...off })
      const names = (await s.tools()).map((t) => t.name)
      for (const n of [...NAMES, 'set_environment_variables']) {
        expect(names).not.toContain(n)
        expect((await s.raw(n, { name: 'Shop/Order' })).error.message).toContain('Unknown tool')
      }
    }
    const on = setup({ collections: [c], requests: [r] })
    expect((await on.tools()).map((t) => t.name)).not.toContain('set_environment_variables')
    expect((await on.raw('set_environment_variables', {})).error.message).toContain('Unknown tool')
    expect(Object.keys((await on.tools()).find((t) => t.name === 'apply_parameters')!.inputSchema.properties)).toEqual(['name', 'batch', 'choose'])
    expect((await on.tools()).find((t) => t.name === 'apply_parameters')!.description).not.toContain('person decides')
  })

  it('move what was picked to the collection, in one save, with no value in any reply', async () => {
    const c = shop(), r = req(c, { auth: { ...emptyAuth('basic'), username: 'ann', password: 'plant-pass-CCCC3' }, headers: [kv('X-API-Key', KEY)] })
    const { suggest, move, saved } = setup({ collections: [c], requests: [r], env: newEnvironment('Dev') })
    const s = await suggest()
    expect(s.bad).toBe(false)
    expect(s.lines.map((l) => l.slice(1))).toEqual([['base URL', '{{baseUrl}}', 'new'], ['API key in the header X-API-Key', '{{apiKey}}', 'new', 'secret'], ['sign-in password', '{{password}}', 'new', 'secret'], ['ID in the path', ':userId', 'new']])
    const a = await move({ 'base URL': '', X: 'shopApiKey', password: '', ID: '' })
    expect(a).toMatchObject({ bad: false, text: '“Shop/Order” now uses {{shopApiKey}}, {{password}}, :userId, {{baseUrl}}. New in the variables of the collection “Shop”: shopApiKey, password, baseUrl.' })
    for (const v of [KEY, 'plant-pass-CCCC3', '12345']) { expect(s.text).not.toContain(v); expect(a.text).not.toContain(v) }
    expect(saved).toHaveLength(1)
    expect(saved[0].folders).toEqual([])
    expect(saved[0].collections).toHaveLength(1)
    expect(saved[0].collections[0].variables.map((v) => [v.key, v.value, !!v.secret])).toEqual([['shopApiKey', KEY, true], ['password', 'plant-pass-CCCC3', true], ['baseUrl', 'https://shop.test', false]])
    expect(saved[0].requests).toHaveLength(1)
    expect(saved[0].requests[0]).toMatchObject({ id: r.id, url: '{{baseUrl}}/users/:userId/x', headers: [{ value: '{{shopApiKey}}' }], auth: { password: '{{password}}' } })
    expect(saved[0].requests[0].updatedAt).toBeGreaterThanOrEqual(r.updatedAt)
  })

  it('what moved stays hidden in get_request, list_requests and an echoing send, also in a copy', async () => {
    const echo: Transport = { label: 't', unrestricted: true, send: async (p) => ({ status: 200, statusText: 'OK', headers: p.headers, body: JSON.stringify(p), binary: false, size: 2, timeMs: 1 }) }
    const c = shop(), r = req(c)
    const { move, call } = setup({ collections: [c], requests: [r], transport: echo })
    expect((await move({ bearer: '', X: 'mySecret' })).bad).toBe(false)
    await call('create_request', { folder: 'Shop', name: 'Leak', url: 'https://e.test/{{token}}?x={{mySecret}}' })
    await call('copy_request', { from: 'Shop/Order', to: 'assistant/Lab' })
    for (const [tool, args] of [['get_request', { name: 'Shop/Order' }], ['get_request', { name: 'assistant/Lab/Order' }], ['list_requests', {}], ['send_request', { name: 'Shop/Order' }], ['send_request', { name: 'Shop/Leak' }], ['set_variables', { collection: 'Shop', variables: { other: '1' } }]] as const) {
      const t = (await call(tool, args)).text
      expect(t).not.toContain(TOKEN); expect(t).not.toContain(KEY)
    }
  })

  it('a secret needs a variable name that get_request hides', async () => {
    const c = shop(), r = req(c, { headers: [kv('X-API-Key', KEY)] })
    const { move, saved } = setup({ collections: [c], requests: [r] })
    for (const n of ['foo', 'access-control-token']) {
      const t = await move({ X: n })
      expect(t.bad).toBe(true)
      expect(t.text).toContain('needs a name that says so')
    }
    expect(saved).toEqual([])
    expect((await move({ 'base URL': 'foo' })).bad).toBe(false)
  })

  it('a base URL with a password in it isn’t offered: the variable would show it', async () => {
    const c = shop(), r = req(c, { url: 'https://bob:pa55word@shop.test/x', headers: [] })
    expect((await setup({ collections: [c], requests: [r] }).suggest()).text).toContain('Nothing to move')
  })

  it('refuse what the assistant may not write to', async () => {
    const c = shop(), r = req(c)
    const s = setup({ collections: [c], requests: [r], edit: false })
    for (const n of NAMES) {
      const t = await s.call(n, { name: 'Shop/Order', batch: 'x', choose: { 'baseUrl:0': '' } })
      expect(t.bad).toBe(true)
      expect(t.text).toContain('which you can’t change')
    }
    expect((await s.call('suggest_parameters', { name: 'Shop/Nope' })).text).toContain('No request named')
    // turned off between the two
    const on = setup({ collections: [c], requests: [r] })
    const got = await on.suggest()
    on.workspace!.editable = undefined
    expect((await on.call('apply_parameters', { name: 'Shop/Order', batch: got.batch, choose: { [got.id('base')]: '' } })).text).toContain('which you can’t change')
    expect([...s.saved, ...on.saved]).toEqual([])
  })

  it('work in the assistant’s own workspace, with its own collection', async () => {
    const lab = { ...newCollection('Lab'), workspaceId: ASSISTANT_SPACE.id, variables: [kv('tenant', 'acme-prod')] }
    const other = shop(), r = req(lab, { name: 'Probe', url: 'https://lab.test/acme-prod' })
    const { suggest, move, saved } = setup({ collections: [other], own: [lab], requests: [r], edit: false })
    expect((await suggest('assistant/Lab/Probe')).lines.map((l) => l[2])).toEqual(['{{tenant}}', '{{baseUrl}}', '{{token}}', '{{apiKey}}'])
    expect((await move({ bearer: '', tenant: '' }, 'assistant/Lab/Probe')).text).toContain('“assistant/Lab/Probe” now uses')
    expect(saved[0].collections.map((c) => [c.id, c.workspaceId])).toEqual([[lab.id, ASSISTANT_SPACE.id]])
    expect(saved[0].collections[0].variables.map((v) => v.key)).toEqual(['tenant', 'token'])
    expect(saved[0].requests[0].url).toBe('https://lab.test/{{tenant}}')
  })

  it('only existing variables: the collection isn’t saved', async () => {
    const c = shop({ variables: [kv('tenant', 'acme-prod')] }), r = req(c, { url: 'https://shop.test/acme-prod', headers: [] })
    const { move, saved } = setup({ collections: [c], requests: [r] })
    expect((await move({ tenant: '' })).text).toBe('“Shop/Order” now uses {{tenant}}.')
    expect(saved[0].collections).toEqual([])
  })

  it('a stale batch, another request’s batch and an unknown one are refused', async () => {
    const c = shop(), r = req(c), r2 = req(c, { name: 'Other' })
    const s = setup({ collections: [c], requests: [r, r2] })
    const got = await s.suggest()
    const apply = (over: object = {}) => s.call('apply_parameters', { name: 'Shop/Order', batch: got.batch, choose: { [got.id('base')]: '' }, ...over })
    const CHANGED = 'The request changed. Look at the suggestions again.'
    expect(await apply({ name: 'Shop/Other' })).toEqual({ bad: true, text: CHANGED })
    expect(await apply({ batch: 'nope' })).toEqual({ bad: true, text: CHANGED })
    s.o.ws.requests[0] = { ...r, url: 'https://shop.test/y' }
    expect(await apply()).toEqual({ bad: true, text: CHANGED })
    expect(s.saved).toEqual([])
    s.o.ws.requests[0] = r
    s.o.environment = { ...newEnvironment('E'), variables: [kv('a', 'b')] }
    expect(await apply()).toEqual({ bad: true, text: CHANGED })
  })

  it('a batch ends with any change the assistant makes: it can’t try whether a guess puts things back', async () => {
    const c = shop({ variables: [secretVar('pin', '4711')] }), r = req(c)
    const s = setup({ collections: [c], requests: [r] })
    const got = await s.suggest()
    await s.call('set_variables', { collection: 'Shop', variables: { pin: '0000' } })
    const answer = async (pin: string) => { await s.call('set_variables', { collection: 'Shop', variables: { pin } }); return s.call('apply_parameters', { name: 'Shop/Order', batch: got.batch, choose: { none: '' } }) }
    expect(await answer('4711')).toEqual(await answer('1234'))
  })

  it('bad input is refused, and <hidden> is never a name', async () => {
    const c = shop(), r = req(c)
    const s = setup({ collections: [c], requests: [r] })
    const got = await s.suggest()
    for (const choose of [undefined, null, 'x', ['x'], {}, { [got.id('base')]: 1 }, { [got.id('base')]: null }, { [got.id('base')]: 'a b' }, { 'nope:9': '' }, { [got.id('base')]: '<hidden>' }]) {
      const t = await s.call('apply_parameters', { name: 'Shop/Order', batch: got.batch, choose })
      expect(t.bad).toBe(true)
    }
    expect(s.saved).toEqual([])
  })

  it('a save that fails changes nothing and says so', async () => {
    const c = shop(), r = req(c)
    const s = setup({ collections: [c], requests: [r] })
    s.workspace!.save = async () => { throw new Error('disk full') }
    await expect(s.move({ bearer: '' })).rejects.toThrow('disk full')
    expect(c.variables).toEqual([])
  })

  it('in the app: one batch list per session, and the request and its collection are stored together', async () => {
    const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react')
    const db = await import('../src/core/db')
    const { useWorkspace } = await import('../src/ui/useWorkspace')
    const { mcpOptions } = await import('../src/ui/mcpHost')
    await db.resetForTests()
    const c = newCollection('Shop'), r = req(c)
    await db.putCollection(c); await db.putRequest(r)
    await db.putSettings({ ...(await db.getSettings()), mcpHostWorkspace: true })
    const transport: Transport = { label: 't', unrestricted: true, send: async () => { throw new Error('must not send') } }
    const h = renderHook(() => useWorkspace({ transport })).result
    await waitFor(() => expect(h.current.ready).toBe(true))
    await act(() => h.current.setSpaceAi(h.current.activeSpaceId, true))
    const call = async (name: string, args: object) => { let t: any; await act(async () => { t = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, mcpOptions(h.current) as McpServeOptions) }); return t.result.content[0].text as string }
    const s = await call('suggest_parameters', { name: 'Shop/Order' })
    const id = /^bearer:\d+/m.exec(s)![0], batch = /batch: (\S+)/.exec(s)![1]
    const put = vi.spyOn(db, 'putMany')
    put.mockRejectedValueOnce(new Error('disk full'))
    const choose = { [id]: '' }
    await expect(call('apply_parameters', { name: 'Shop/Order', batch, choose })).rejects.toThrow('disk full')
    expect([h.current.collections[0].variables, h.current.requests[0].headers]).toEqual([[], r.headers])
    expect(await call('apply_parameters', { name: 'Shop/Order', batch, choose })).toContain('now uses {{token}}')
    expect(put).toHaveBeenCalledTimes(2)
    expect((await db.listCollections()).find((x) => x.id === c.id)!.variables).toMatchObject([{ key: 'token', value: TOKEN, secret: true }])
    expect((await db.listRequests())[0].auth).toMatchObject({ kind: 'bearer', token: '{{token}}' })
    expect(await call('apply_parameters', { name: 'Shop/Order', batch, choose })).toBe('The request changed. Look at the suggestions again.')
    await act(() => h.current.setSpaceAi(h.current.activeSpaceId, false))
    expect(await call('suggest_parameters', { name: 'Shop/Order' })).toContain('which you can’t change')
    put.mockRestore(); cleanup()
  })

  describe('tell nothing about hidden values', () => {
    /** The answers to every try are the same, whatever the hidden value is. */
    const same = async (f: (hidden: string) => Promise<unknown>, a: string, b: string) => expect(await f(a)).toEqual(await f(b))
    const bare = (t: string) => t.replace(/batch: \S+/, 'batch')

    it('a secret variable the assistant sets to a guess matches nothing hidden', async () => {
      // set_variables keeps the secret mark, so it can choose the value of a marked one
      for (const place of [(v: string) => ({ headers: [kv('X-API-Key', v)] }), (v: string) => ({ headers: [kv('X-Session', v)] }), (v: string) => ({ auth: { ...emptyAuth('bearer'), token: v }, headers: [] }), (v: string) => ({ headers: [], body: { ...emptyBody('json'), text: `{"password":"${v}"}` } })]) {
        await same(async (hidden) => {
          const c = shop({ variables: [secretVar('mark', 'old-old-old')] }), r = req(c, { url: '{{u}}', ...place(hidden) })
          const s = setup({ collections: [c], requests: [r], env: { ...newEnvironment('E'), variables: [secretVar('envMark', 'guess-a')] }, globals: [secretVar('gMark', 'guess-a')] })
          await s.call('set_variables', { collection: 'Shop', variables: { mark: 'guess-a' } })
          return bare((await s.suggest()).text)
        }, 'guess-a-and-more', 'something-else-x')
      }
    })

    it('a plain one neither, also where get_request shows nothing', async () => {
      for (const place of [
        (v: string) => ({ headers: [kv('X-API-Key', v)] }),
        (v: string) => ({ body: { ...emptyBody('graphql'), text: '{ a }', graphqlVariables: `{"x":"${v}"}` } }),
        (v: string) => ({ body: { ...emptyBody('none'), text: v } }),
        (v: string) => ({ body: { ...emptyBody('json'), text: '{}', fields: [kv('x', v)] } }),
        (v: string) => ({ auth: { ...emptyAuth('bearer'), token: '{{t}}', username: v } }),
        (v: string) => ({ body: { ...emptyBody('text'), text: 'a'.repeat(20_000) + v } }),
        (v: string) => ({ params: [kv('x', v, false)], body: { ...emptyBody('urlencoded'), fields: [kv('password', v)] } }),
      ]) {
        for (const url of ['https://shop.test/guess-a', 'https://shop.test/']) await same(async (hidden) => {
          const c = shop({ variables: [kv('guess', 'guess-a')] }), r = req(c, { url, headers: [], ...place(hidden) })
          const s = setup({ collections: [c], requests: [r] })
          const text = bare((await s.suggest()).text)
          const a = await s.move({ guess: '' })
          return [text, a, (await s.call('get_request', { name: 'Shop/Order' })).text]
        }, 'guess-a-and-more', 'something-else-x')
      }
    })

    it('what can’t be read isn’t replaced', async () => {
      const c = shop({ variables: [kv('guess', 'guess-a')] })
      const r = req(c, { url: 'https://shop.test/guess-a', headers: [], body: { ...emptyBody('graphql'), text: '{ a }', graphqlVariables: '{"x":"guess-a"}' }, auth: { ...emptyAuth('bearer'), username: 'guess-a' } })
      const { move, saved } = setup({ collections: [c], requests: [r] })
      expect((await move({ guess: '' })).bad).toBe(false)
      expect(saved[0].requests[0]).toMatchObject({ url: 'https://shop.test/{{guess}}', body: { graphqlVariables: '{"x":"guess-a"}' }, auth: { username: 'guess-a' } })
      // left over from another body type
      for (const kind of ['json', 'none', 'binary', 'urlencoded'] as const) {
        const form = kind === 'urlencoded', c2 = shop({ variables: [kv('guess', 'guess-a')] })
        const body = { ...emptyBody(kind), text: kind === 'json' ? '{}' : 'guess-a', fields: form ? [] : [kv('x', 'guess-a')] }
        const s = setup({ collections: [c2], requests: [req(c2, { url: 'https://shop.test/guess-a', headers: [], body })] })
        expect((await s.move({ guess: '' })).bad).toBe(false)
        expect(s.saved[0].requests[0].body).toEqual(body)
      }
    })

    it('a value Dispatch knows as a secret, here or in the assistant’s own workspace, isn’t offered or shown', async () => {
      const lab = { ...newCollection('Lab'), workspaceId: ASSISTANT_SPACE.id, variables: [secretVar('s2', 'known-secret-8')] }
      const c = shop({ variables: [kv('p', 'known-secret-9'), kv('q', 'known-secret-8'), kv('r', 'plain-9')] }), r = req(c, { url: 'https://shop.test/known-secret-9/known-secret-8/plain-9', headers: [] })
      const s = await setup({ collections: [c], own: [lab], requests: [r], globals: [secretVar('g', 'known-secret-9')] }).suggest()
      expect(s.lines.map((l) => l[2])).toEqual(['{{r}}', '{{baseUrl}}'])
    })

    it('replacing text around a secret never uncovers it, also one Dispatch knows from elsewhere', async () => {
      // With the name in front gone, get_request (which hides by name) would show the value.
      for (const place of [
        { url: 'https://shop.test/a?token=known-secret-9' },
        { url: 'https://shop.test/', headers: [kv('X-Note', 'a token=known-secret-9')] },
        { url: 'https://shop.test/', headers: [], body: { ...emptyBody('text'), text: 'token=known-secret-9' } },
        { url: 'https://shop.test/', headers: [], body: { ...emptyBody('json'), text: '{"token=": 1, "token":"known-secret-9"}' } },
      ]) {
        const c = shop({ variables: [kv('cut', 'token='), kv('cut2', '"token"')] })
        const r = req(c, { headers: [], ...place })
        const { suggest, call } = setup({ collections: [c], requests: [r], globals: [secretVar('g', 'known-secret-9')] })
        const s = await suggest()
        expect(s.lines.length).toBeGreaterThan(0)
        await call('apply_parameters', { name: 'Shop/Order', batch: s.batch, choose: Object.fromEntries(s.lines.filter((l) => l[2].startsWith('{{cut')).map((l) => [l[0], ''])) })
        for (const t of [await call('get_request', { name: 'Shop/Order' }), await call('list_requests', {})]) expect(t.text).not.toContain('known-secret-9')
      }
    })

    it('a long body isn’t shifted past where get_request cuts it', async () => {
      const body = `${'a'.repeat(19_985)} short "password":"plant-long-FFFF6"`
      const c = shop({ variables: [kv('aVeryLongNameForAShortValue', 'short')] }), r = req(c, { headers: [], url: 'https://short.test/', body: { ...emptyBody('text'), text: body } })
      const { move, saved } = setup({ collections: [c], requests: [r] })
      await move({ aVeryLong: '' })
      expect(saved[0].requests[0].body.text).toBe(body)
      // and one that would grow past it
      const grows = `${'a'.repeat(19_950)} short "password":"plant-long-FFFF6"`
      const r2 = req(c, { headers: [], url: 'https://short.test/', body: { ...emptyBody('text'), text: grows } })
      const two = setup({ collections: [c], requests: [r2] })
      await two.move({ aVeryLong: '' })
      expect(two.saved[0].requests[0].body.text).toBe(grows)
    })

    it('suggestions work out from what get_request shows, not what it hides', async () => {
      const c = shop({ variables: [kv('tenant', 'acme-prod')] }), r = req(c, { url: 'https://shop.test/acme-prod', headers: [kv('X-Token', 'acme-prod-1'), kv('X-Tenant', 'acme-prod')] })
      const { move, saved } = setup({ collections: [c], requests: [r] })
      await move({ tenant: '' })
      expect(saved[0].requests[0].headers.map((h) => h.value)).toEqual(['acme-prod-1', '{{tenant}}'])
    })
  })
})
