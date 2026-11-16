import { describe, expect, it, vi } from 'vitest'
import { handleMcp } from '../src/core/mcpHandler'
import type { Transport } from '../src/core/transport'
import { ASSISTANT_SPACE, type Collection, defaultSettings, kv, newCollection, newFolder, newRequest } from '../src/core/types'
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
