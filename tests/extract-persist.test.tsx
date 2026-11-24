/** Variables an after-response script sets are kept, whichever way the request was sent. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import { mcpOptions } from '../src/ui/mcpHost'
import { useWorkspace } from '../src/ui/useWorkspace'
import { InlineEngine } from '../src/core/scriptPipeline'
import { ruleLine, type Scope } from '../src/core/extract'
import { handleMcp } from '../src/core/mcpHandler'
import { newFlow, newNode } from '../src/core/flows'
import * as db from '../src/core/db'
import { kv, newCollection, newEnvironment, newRequest } from '../src/core/types'
import type { PreparedRequest } from '../src/core/types'

const SCOPES: Scope[] = ['env', 'collection', 'globals']
let body = '{"token":"new"}'
let sent: PreparedRequest[] = []
const transport = { label: 'Fake', unrestricted: true, send: async (p: PreparedRequest) => { sent.push(p); return { status: 200, statusText: 'OK', headers: [], body, binary: false, size: 2, timeMs: 1 } } }
beforeEach(async () => { await db.resetForTests(); localStorage.clear(); body = '{"token":"new"}'; sent = [] })
afterEach(() => cleanup())

async function seed(scope: Scope) {
  const token = { ...kv('token', 'old'), secret: true }
  const c = { ...newCollection('Shop'), variables: [{ ...token }] }
  const e = { ...newEnvironment('Staging'), variables: [{ ...token }] }
  const login = newRequest({ name: 'Login', url: 'https://s.test/login', collectionId: c.id, sort: 1, scripts: { pre: '', post: ruleLine(scope, 'token', "dx.response.json('token')") } })
  const use = newRequest({ name: 'Use', url: 'https://s.test/use?t={{token}}', collectionId: c.id, sort: 2 })
  await db.putCollection(c); await db.putEnvironment(e); await db.putGlobals([{ ...token }]); await db.putRequest(login); await db.putRequest(use)
  await db.putSettings({ ...(await db.getSettings()), activeEnvId: e.id })
  return { c, e, login, use }
}
const stored = async (scope: Scope) => {
  const rows = scope === 'env' ? (await db.listEnvironments())[0].variables : scope === 'collection' ? (await db.listCollections())[0].variables : await db.getGlobals()
  const r = rows.find((x) => x.key === 'token')!
  return [r.value, r.secret]
}
async function hook() {
  const engine = new InlineEngine()
  const h = renderHook(() => useWorkspace({ transport, engine }))
  await waitFor(() => expect(h.result.current.ready).toBe(true))
  return h.result
}
function flowOf(ids: string[]) {
  const f = newFlow('F')
  let last = f.nodes[0]
  for (const requestId of ids) {
    const n = { ...newNode('request', 0, 0), config: { requestId } }
    f.edges.push({ id: n.id, from: last.id, port: last.type === 'start' ? 'next' : 'ok', to: n.id }); f.nodes.push(n); last = n
  }
  return f
}

describe.each(SCOPES)('%s variables', (scope) => {
  it('are kept after Send, still secret', async () => {
    const { login } = await seed(scope); const h = await hook()
    act(() => h.current.openRequest(login)); await act(async () => { await h.current.send() })
    expect(await stored(scope)).toEqual(['new', true])
  })
  it('keep the old value when the response has no such field', async () => {
    const { login } = await seed(scope); const h = await hook()
    body = '{"error":"x"}'
    act(() => h.current.openRequest(login)); await act(async () => { await h.current.send() })
    expect(await stored(scope)).toEqual(['old', true])
  })
  it('are kept after a flow, and seen by its next request', async () => {
    const { login, use } = await seed(scope); const h = await hook()
    const f = flowOf([login.id, use.id])
    // The narrower scopes hide the others, so leave only the one being tested.
    if (scope !== 'env') await act(async () => { await h.current.updateEnvironment({ ...h.current.environments[0], variables: [] }) })
    if (scope === 'globals') await act(async () => { await h.current.updateCollection({ ...h.current.collections[0], variables: [] }) })
    await act(async () => { await h.current.runFlowNow(f, () => {}) })
    expect(sent.at(-1)!.url).toBe('https://s.test/use?t=new')
    expect(await stored(scope)).toEqual(['new', true])
  })
  it('are kept after an assistant runs a collection', async () => {
    await seed(scope); const h = await hook()
    await act(async () => { await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_collection', arguments: { folder: 'Shop' } } }, { ...mcpOptions(h.current), allowMethods: [] } as never) })
    expect(sent.length).toBe(2)
    expect(await stored(scope)).toEqual(['new', true])
  })
  it('are kept after a run on the Runner page', async () => {
    await seed(scope)
    render(<App transport={transport} engine={new InlineEngine()} />)
    await screen.findByTitle('Shop')
    const menu = screen.getByLabelText('More for Shop').closest('details') as HTMLElement
    fireEvent.click(within(menu).getByText('Run collection…'))
    const run = await screen.findByRole('button', { name: /^(▶ )?Run\b/ })
    await act(async () => { fireEvent.click(run) })
    await waitFor(async () => expect(await stored(scope)).toEqual(['new', true]))
  })
})

it('a flow that changes a collection keeps a rename made while it ran', async () => {
  const { login } = await seed('collection'); const h = await hook()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const send = transport.send
  transport.send = async (p) => { await gate; return send(p) }
  try {
    let run!: Promise<unknown>
    act(() => { run = h.current.runFlowNow(flowOf([login.id]), () => {}) })
    await act(async () => { await h.current.updateCollection({ ...h.current.collections[0], name: 'Renamed' }) })
    await act(async () => { release(); await run })
  } finally { transport.send = send }
  expect((await db.listCollections())[0].name).toBe('Renamed')
  expect(await stored('collection')).toEqual(['new', true])
})

it('an open collection editor doesn’t bring back variables a run changed meanwhile', async () => {
  const { c } = await seed('collection')
  let ws!: ReturnType<typeof useWorkspace>
  const { CollectionEditor } = await import('../src/ui/Editors')
  function Host() {
    ws = useWorkspace({ transport, engine: useEngine })
    const col = ws.collections.find((x) => x.id === c.id)
    return col ? <CollectionEditor ws={ws} confirm={async () => true} collection={col} /> : null
  }
  const useEngine = new InlineEngine()
  render(<Host />)
  await screen.findByLabelText('Collection name')
  await act(async () => { await ws.keepVars({ collections: [{ id: c.id, before: c.variables, after: [{ ...c.variables[0], value: 'new' }] }] }) })
  await act(async () => { fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'Shop 2' } }) })
  expect(await stored('collection')).toEqual(['new', true])
})

/** Runs something with its sends held back, lets `meanwhile` happen, then lets them through. */
async function heldBack(start: () => Promise<unknown>, meanwhile: () => Promise<unknown>) {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const send = transport.send
  transport.send = async (p) => { await gate; return send(p) }
  try {
    let run!: Promise<unknown>
    act(() => { run = start() })
    await act(async () => { await meanwhile() })
    await act(async () => { release(); await run })
  } finally { transport.send = send }
}

describe('edits made while requests are on their way are kept', () => {
  const edit = (h: { current: ReturnType<typeof useWorkspace> }) => async () => {
    const e = h.current.environments[0], c = h.current.collections[0]
    await h.current.updateEnvironment({ ...e, name: 'New env', variables: [...e.variables, kv('mine', 'm')] })
    await h.current.updateCollection({ ...c, name: 'New col', variables: [...c.variables, kv('mine', 'm')] })
    await h.current.setGlobals([...h.current.globals, kv('mine', 'm')])
  }
  const check = async (scope: Scope) => {
    const e = (await db.listEnvironments())[0], c = (await db.listCollections())[0], g = await db.getGlobals()
    expect([e.name, c.name]).toEqual(['New env', 'New col'])
    for (const v of [e.variables, c.variables, g]) expect(v.find((x) => x.key === 'mine')?.value).toBe('m')
    expect(await stored(scope)).toEqual(['new', true])
  }
  it.each(SCOPES)('Send (%s)', async (scope) => {
    const { login } = await seed(scope); const h = await hook(); act(() => h.current.openRequest(login))
    await heldBack(() => h.current.send(), edit(h)); await check(scope)
  })
  it.each(SCOPES)('a flow (%s)', async (scope) => {
    const { login } = await seed(scope); const h = await hook()
    await heldBack(() => h.current.runFlowNow(flowOf([login.id]), () => {}), edit(h)); await check(scope)
  })
  it.each(SCOPES)('an assistant’s run (%s)', async (scope) => {
    await seed(scope); const h = await hook()
    await heldBack(() => handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_collection', arguments: { folder: 'Shop' } } }, { ...mcpOptions(h.current), allowMethods: [] } as never), edit(h))
    await check(scope)
  })
})
