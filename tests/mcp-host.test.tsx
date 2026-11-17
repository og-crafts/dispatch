import { describe, expect, it, vi } from 'vitest'
import { handleMcp } from '../src/core/mcpHandler'
import type { Transport } from '../src/core/transport'
import { ASSISTANT_SPACE, type Collection, type RequestDef, defaultSettings, kv, newCollection, newFolder, newRequest } from '../src/core/types'
import type { AssistantChanges } from '../src/core/mcpWorkspace'

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
      workspace: withWorkspace ? { collections: own, save: async (c: AssistantChanges) => { saved.push(c) }, remove: async (ids: string[]) => { removed.push(ids) } } : undefined,
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
      workspace: { collections: [lab], save: async (c: AssistantChanges) => { saved.push(c) }, remove: async () => {} },
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
