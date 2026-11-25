/** Applying and undoing what the assistant proposed: the only way a proposal becomes a write to the person's data. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { type WorkspaceApi, useWorkspace } from '../src/ui/useWorkspace'
import { CollectionEditor, EnvironmentEditor, FolderEditor } from '../src/ui/Editors'
import { workspaceToFiles } from '../src/core/workspaceFiles'
import { type FolderApi, linkSpace, takeFile, useFolderSync } from '../src/ui/linkedDirs'
import type { Change, Proposal } from '../src/core/assistant/proposal'
import { InlineEngine } from '../src/core/scriptPipeline'
import { ruleLine } from '../src/core/extract'
import * as db from '../src/core/db'
import { secretsOf } from '../src/core/vault'
import { ASSISTANT_SPACE, DEFAULT_SPACE, type Collection, type Environment, type Folder, type KV, type RequestDef, kv, newCollection, newEnvironment, newFolder, newRequest, uid } from '../src/core/types'
import type { Transport } from '../src/core/transport'

beforeEach(async () => { await db.resetForTests(); localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const transport: Transport = { label: 'fake', unrestricted: true, send: async () => ({ status: 200, statusText: 'OK', headers: [], body: '{"t":"new"}', binary: false, size: 2, timeMs: 1 }) }
const proposal = (changes: Change[], over: Partial<Proposal> = {}): Proposal =>
  structuredClone({ id: uid(), spaceId: DEFAULT_SPACE.id, tool: 'x', cls: 'edit', title: 'x', fields: [], warnings: [], changes, reply: 'done', ...over })
const edit = <T extends Collection | Folder | RequestDef | Environment>(kind: Change['kind'], r: T, patch: Partial<T>): Change => ({ kind, id: r.id, before: r, after: { ...r, ...patch } })
const create = (kind: Change['kind'], r: Collection | Folder | RequestDef): Change => ({ kind, id: r.id, before: null, after: r })
const remove = (r: RequestDef): Change => ({ kind: 'request', id: r.id, before: r, after: null })

async function seed() {
  const c = { ...newCollection('Shop'), variables: [kv('base', 'https://a.test'), kv('token', 'sec-ret-1', true, { secret: true })] }
  const f = newFolder(c.id, 'Orders')
  const r = newRequest({ name: 'Create order', url: 'https://a.test/orders', collectionId: c.id, folderId: f.id, sort: 1, auth: { ...newRequest().auth, kind: 'bearer', token: 'sec-ret-2' } })
  const r2 = newRequest({ name: 'Other', url: 'https://a.test/other', collectionId: c.id, sort: 2 })
  const e = { ...newEnvironment('Staging'), variables: [kv('id', '1')] }
  await db.putMany({ collections: [c], folders: [f], requests: [r, r2], environments: [e] })
  await db.putGlobals([kv('g', '1')])
  await db.putSettings({ ...(await db.getSettings()), activeEnvId: e.id })
  const loaded = { c: (await db.listCollections())[0], f: (await db.listFolders())[0], e: (await db.listEnvironments())[0], g: await db.getGlobals(), rs: await db.listRequests() }
  return { ...loaded, r: loaded.rs.find((x) => x.id === r.id)!, r2: loaded.rs.find((x) => x.id === r2.id)! }
}
async function mount() {
  const engine = new InlineEngine()
  const h = renderHook(() => useWorkspace({ transport, engine }))
  await waitFor(() => expect(h.result.current.ready).toBe(true))
  return h.result
}
type H = Awaited<ReturnType<typeof mount>>
const apply = (h: H, p: Proposal) => act(() => h.current.applyProposal(p))
const undo = (h: H, p: Proposal) => act(() => h.current.undoProposal(p))
const ok = { ok: true }
const refused = (reason: string) => expect.objectContaining({ ok: false, reason, text: expect.stringMatching(/\w/) })
const everything = async () => JSON.stringify([await db.listCollections(), await db.listFolders(), (await db.listRequests()), await db.listEnvironments(), await db.getGlobals()])
const storedRequest = async (id: string) => (await db.listRequests()).find((x) => x.id === id)
const scripts = (post: string) => ({ pre: '', post })
/** Runs `then` in the moment a transaction that writes `store` has been opened for an apply. */
function whileCommitting(store: string, then: () => void) {
  const real = IDBDatabase.prototype.transaction
  let once = false
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, o) {
    const t = real.call(this, names as string[], mode, o)
    if (!once && mode === 'readwrite' && Array.isArray(names) && names.includes(store)) { once = true; then() }
    return t
  })
}

describe('applying', () => {
  it('writes all records of a create-with-folders proposal, sealed, and shows them', async () => {
    await seed(); const h = await mount()
    const c = { ...newCollection('Aaa'), variables: [kv('k', 'plain-secret', true, { secret: true })] }, f1 = newFolder(c.id, 'One'), f2 = newFolder(c.id, 'Two', f1.id)
    const r = newRequest({ name: 'New', collectionId: c.id, folderId: f2.id, updatedAt: 1 })
    const puts = vi.spyOn(IDBObjectStore.prototype, 'put')
    expect(await apply(h, proposal([create('collection', c), create('folder', f1), create('folder', f2), create('request', r)]))).toEqual(ok)
    expect(JSON.stringify(puts.mock.calls)).not.toContain('plain-secret')
    expect((await db.listCollections()).find((x) => x.id === c.id)?.variables[0].value).toBe('plain-secret')
    expect((await db.listFolders()).map((x) => x.id)).toEqual(expect.arrayContaining([f1.id, f2.id]))
    expect((await storedRequest(r.id))!.updatedAt).toBeGreaterThan(1)
    expect(h.current.collections.map((x) => x.name)).toEqual(['Aaa', 'Shop'])
    expect(h.current.requests.some((x) => x.id === r.id)).toBe(true)
    expect(h.current.folders.map((x) => x.name)).toEqual(['Orders', 'One', 'Two'])
  })

  it('stores nothing and leaves the state alone when the second write fails', async () => {
    const { r, r2 } = await seed(); const h = await mount()
    const before = await everything(), state = h.current.requests
    const real = IDBObjectStore.prototype.put
    let n = 0
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, v, k) { if (this.name === 'requests' && ++n === 2) throw new Error('disk full'); return k === undefined ? real.call(this, v) : real.call(this, v, k) })
    const p = proposal([edit('request', r, { url: 'https://b.test' }), edit('request', r2, { url: 'https://b.test' })])
    expect(await apply(h, p)).toEqual(refused('failed'))
    expect(n).toBe(2)
    vi.restoreAllMocks()
    expect(await everything()).toBe(before)
    expect(h.current.requests).toBe(state)
    expect(await undo(h, p)).toEqual(refused('changed'))
    expect(await apply(h, p)).toEqual(ok) // it can be tried again
  })

  it('answers “changed” and writes nothing when a record changed after the proposal', async () => {
    const { r, r2 } = await seed(); const h = await mount()
    await act(() => h.current.renameRequest(r, 'Mine'))
    const before = await everything()
    expect(await apply(h, proposal([edit('request', r2, { url: 'x' }), edit('request', r, { url: 'https://b.test' })]))).toEqual({ ok: false, reason: 'changed', text: 'This changed meanwhile, so nothing was applied.' })
    expect(await everything()).toBe(before)
  })

  it('applies when only updatedAt differs', async () => {
    const { c } = await seed(); const h = await mount()
    await act(() => h.current.updateCollection(h.current.collections[0]))
    expect(await apply(h, proposal([edit('collection', c, { scripts: scripts('a') })]))).toEqual(ok)
  })

  it('lets the second of two in one tick see the first', async () => {
    const { r } = await seed(); const h = await mount()
    const one = proposal([edit('request', r, { url: 'https://one.test' })]), two = proposal([edit('request', r, { url: 'https://two.test' })])
    expect(await act(() => Promise.all([h.current.applyProposal(one), h.current.applyProposal(two)]))).toEqual([ok, refused('changed')])
    expect((await storedRequest(r.id))!.url).toBe('https://one.test')
  })

  it('refuses a second time, and after the workspace was switched', async () => {
    const { r, r2 } = await seed(); const h = await mount()
    const p = proposal([edit('request', r, { url: 'https://one.test' })])
    expect(await act(() => Promise.all([h.current.applyProposal(p), h.current.applyProposal(p)]))).toEqual([ok, refused('changed')])
    const sp = (await act(() => h.current.addSpace('B')))
    const before = await everything()
    // in the same tick: the switch counts before it is drawn
    const late = await act(() => { h.current.switchSpace(sp.id); return h.current.applyProposal(proposal([edit('request', r2, { url: 'x' })])) })
    expect(late).toEqual(refused('gone'))
    expect(await undo(h, p)).toEqual(refused('gone'))
    expect(await everything()).toBe(before)
  })

  it('refuses when the collection or folder is gone or in another workspace', async () => {
    const { c, f, r, r2 } = await seed(); const h = await mount()
    const inFolder = newRequest({ collectionId: c.id, folderId: f.id })
    await act(() => h.current.removeFolder(f.id))
    expect(await apply(h, proposal([create('request', inFolder)]))).toEqual(refused('gone'))
    expect(await apply(h, proposal([edit('request', r, { url: 'x' })]))).toEqual(refused('gone'))
    expect(await apply(h, proposal([create('folder', newFolder(c.id, 'Sub', f.id))]))).toEqual(refused('gone'))
    const sp = await act(() => h.current.addSpace('B'))
    await act(() => h.current.moveToSpace('collection', c.id, sp.id))
    expect(await apply(h, proposal([edit('request', r2, { url: 'x' })]))).toEqual(refused('gone'))
    expect(await apply(h, proposal([remove(r2)], { cls: 'delete' }))).toEqual(refused('gone'))
    await act(() => h.current.removeCollection(c.id))
    const before = await everything()
    expect(await apply(h, proposal([create('request', newRequest({ collectionId: c.id }))]))).toEqual(refused('gone'))
    expect(await everything()).toBe(before)
  })

  it('sees a record the person is just removing or saving as it will be', async () => {
    const { c, r, r2 } = await seed(); const h = await mount()
    const mid = await act(() => { const gone = h.current.removeRequest(r.id); return Promise.all([h.current.applyProposal(proposal([edit('request', r, { url: 'x' })])), gone]) })
    expect(mid[0]).toEqual(refused('gone'))
    const named = await act(() => { const s = h.current.renameRequest(r2, 'Mine'); return Promise.all([h.current.applyProposal(proposal([edit('request', r2, { url: 'x' })])), s]) })
    expect(named[0]).toEqual(refused('changed'))
    const gone = await act(() => { const d = h.current.removeCollection(c.id); return Promise.all([h.current.applyProposal(proposal([create('request', newRequest({ collectionId: c.id }))])), d]) })
    expect(gone[0]).toEqual(refused('gone'))
    expect(await db.listRequests()).toEqual([])
  })

  it('refuses only the table a script changed by itself', async () => {
    const { c, e, g, r } = await seed(); const h = await mount()
    const tables = (): Proposal[] => [proposal([edit('environment', e, { variables: [kv('x', '1')] })]), proposal([edit('collection', c, { variables: [] })]), proposal([{ kind: 'globals', id: 'globals', before: g, after: [...g, kv('h', '2')] }])]
    const ps = tables()
    act(() => h.current.openRequest({ ...r, scripts: scripts(ruleLine('env', 'id', "'2'")) }))
    await act(() => h.current.send())
    expect((await db.listEnvironments())[0].variables[0].value).toBe('2')
    expect(await apply(h, ps[0])).toEqual(refused('changed'))
    expect(await apply(h, ps[1])).toEqual(ok)
    expect(await apply(h, ps[2])).toEqual(ok)
    expect((await db.getGlobals()).map((x) => x.key)).toEqual(['g', 'h'])
    expect(h.current.globals.map((x) => x.key)).toEqual(['g', 'h'])
    expect(await undo(h, ps[2])).toEqual(ok)
    expect(await db.getGlobals()).toEqual(g)
  })
})

describe('while other writes are on their way', () => {
  it('an earlier write that is still being sealed can’t land on top', async () => {
    const { c } = await seed(); const h = await mount()
    const real = secretsOf.collection
    let first = true
    vi.spyOn(secretsOf, 'collection').mockImplementation(async (x, f) => { if (first) { first = false; await new Promise((res) => setTimeout(res, 40)) } return real(x, f) })
    await act(async () => {
      const slow = h.current.updateCollection(h.current.collections[0])
      expect(await h.current.applyProposal(proposal([edit('collection', c, { scripts: scripts('applied') })]))).toEqual(ok)
      await slow
    })
    expect((await db.listCollections())[0].scripts.post).toBe('applied')
  })

  it('a change that comes while it is sealed stops it', async () => {
    const { c } = await seed(); const h = await mount()
    const real = secretsOf.collection
    vi.spyOn(secretsOf, 'collection').mockImplementationOnce(async (x, f) => { void h.current.updateCollection({ ...c, docs: 'typed' }); return real(x, f) })
    expect(await apply(h, proposal([edit('collection', c, { scripts: scripts('applied') })]))).toEqual(refused('changed'))
    await waitFor(async () => expect((await db.listCollections())[0]).toMatchObject({ docs: 'typed', scripts: scripts('') }))
  })

  it('what the person types while it commits stays, with the change under it', async () => {
    const { c } = await seed(); const h = await mount()
    const v2 = [{ ...c.variables[0], value: 'applied' }, c.variables[1]]
    whileCommitting('collections', () => { void h.current.updateCollection({ ...c, docs: 'typed', variables: [...c.variables, kv('mine', '1')], scripts: { pre: 'typed', post: '' } }) })
    expect(await apply(h, proposal([edit('collection', c, { scripts: scripts('applied'), variables: v2 })]))).toEqual(ok)
    const want = { docs: 'typed', scripts: { pre: 'typed', post: 'applied' } }
    expect(h.current.collections[0]).toMatchObject(want)
    const stored = (await db.listCollections())[0]
    expect(stored).toMatchObject(want)
    expect(stored.variables.map((v) => [v.key, v.value])).toEqual([['base', 'applied'], ['token', 'sec-ret-1'], ['mine', '1']])
  })

  it('also when the person’s write takes longer to store than the change put onto it', async () => {
    const { c } = await seed(); const h = await mount()
    const real = secretsOf.collection
    whileCommitting('collections', () => {
      vi.spyOn(secretsOf, 'collection').mockImplementationOnce(async (x, f) => { await new Promise((res) => setTimeout(res, 40)); return real(x, f) })
      void h.current.updateCollection({ ...c, docs: 'typed' })
    })
    expect(await apply(h, proposal([edit('collection', c, { scripts: scripts('applied') })]))).toEqual(ok)
    await new Promise((res) => setTimeout(res, 80))
    expect((await db.listCollections())[0]).toMatchObject({ docs: 'typed', scripts: scripts('applied') })
  })

  it('a collection removed while it commits takes the new request with it', async () => {
    const { c, r } = await seed(); const h = await mount()
    let gone!: Promise<void>
    whileCommitting('requests', () => { gone = h.current.removeCollection(c.id) })
    await apply(h, proposal([create('request', newRequest({ collectionId: c.id })), edit('request', r, { url: 'x' })]))
    await act(() => gone)
    expect(h.current.requests).toEqual([])
    expect(await db.listRequests()).toEqual([])
  })

  it('a token refreshed by a send that started before keeps what was applied', async () => {
    const { c, r, r2 } = await seed(); const h = await mount()
    const old = h.current
    expect(await apply(h, proposal([edit('collection', c, { scripts: scripts('a') }), edit('request', r, { url: 'https://b.test' })]))).toEqual(ok)
    await act(async () => { await old.applyAuthUpdate({ owner: 'collection', id: c.id, patch: { accessToken: 't' } } as never); await old.applyAuthUpdate({ owner: 'request', id: r.id, patch: { accessToken: 't' } } as never) })
    expect((await db.listCollections())[0]).toMatchObject({ scripts: scripts('a'), auth: { accessToken: 't' } })
    expect(await storedRequest(r.id)).toMatchObject({ url: 'https://b.test', auth: { accessToken: 't' } })
    // nor do a move or a rename that were started on the old record
    expect(await apply(h, proposal([edit('request', r2, { url: 'https://b.test' })]))).toEqual(ok)
    await act(() => old.moveRequest(r2, c.id, null))
    expect((await storedRequest(r2.id))!.url).toBe('https://b.test')
  })

  it('a save that fails leaves the saved version as it was', async () => {
    const { r } = await seed(); const h = await mount()
    vi.spyOn(secretsOf, 'request').mockRejectedValueOnce(new Error('no'))
    await act(async () => { await expect(h.current.renameRequest(r, 'New')).rejects.toThrow('no') })
    expect(h.current.requests.find((x) => x.id === r.id)!.name).toBe('Create order')
  })
})

describe('open tabs', () => {
  it('a tab with unsaved edits refuses apply and undo; a clean tab shows the new version', async () => {
    const { r } = await seed(); const h = await mount()
    act(() => h.current.openRequest(r))
    act(() => h.current.setDraft((d) => ({ ...d, url: 'https://mine.test' })))
    expect(h.current.isUnsaved(r.id)).toBe(true)
    const p = proposal([edit('request', r, { url: 'https://b.test' })])
    const before = await everything()
    expect(await apply(h, p)).toEqual({ ok: false, reason: 'unsaved', text: 'Save or discard your changes to “Create order” first. Nothing was applied.' })
    expect(await apply(h, proposal([remove(r)], { cls: 'delete' }))).toEqual(refused('unsaved'))
    expect(await everything()).toBe(before)
    act(() => h.current.setDraft(r))
    expect(h.current.isUnsaved(r.id)).toBe(false)
    expect(await apply(h, p)).toEqual(ok)
    expect(h.current.draft.url).toBe('https://b.test')
    expect(h.current.dirty).toBe(false)
    // edited in the same tick as Undo
    const late = await act(() => { h.current.setDraft((d) => ({ ...d, url: 'https://mine.test' })); return h.current.undoProposal(p) })
    expect(late).toEqual({ ok: false, reason: 'unsaved', text: 'Save or discard your changes to “Create order” first. Nothing was undone.' })
    expect((await storedRequest(r.id))!.url).toBe('https://b.test')
    act(() => h.current.setDraft((d) => ({ ...d, url: 'https://b.test' })))
    expect(await undo(h, p)).toEqual(ok)
    expect(h.current.draft.url).toBe('https://a.test/orders')
    expect(h.current.dirty).toBe(false)
  })

  it('an edit made while the change commits stays in the tab, unsaved', async () => {
    const { r } = await seed(); const h = await mount()
    act(() => h.current.openRequest(r))
    const { setDraft } = h.current
    whileCommitting('requests', () => setDraft((d) => ({ ...d, url: 'https://mine.test' })))
    expect(await apply(h, proposal([edit('request', r, { docs: 'applied' })]))).toEqual(ok)
    expect(h.current.draft.url).toBe('https://mine.test')
    expect(h.current.dirty).toBe(true)
    expect((await storedRequest(r.id))).toMatchObject({ docs: 'applied', url: r.url })
  })

  it('a deleted request’s clean tab stays as an unsaved draft', async () => {
    const { r } = await seed(); const h = await mount()
    act(() => h.current.openRequest(r))
    expect(await apply(h, proposal([remove(r)], { cls: 'delete' }))).toEqual(ok)
    expect(h.current.draft.id).not.toBe(r.id)
    expect(h.current.draft.url).toBe(r.url)
    expect(h.current.saved).toBeNull()
  })
})

describe('undo', () => {
  it('restores what was there, once', async () => {
    const { c, f, r, e } = await seed(); const h = await mount()
    const p = proposal([edit('collection', c, { scripts: scripts('1') }), edit('folder', f, { scripts: scripts('2') }), edit('request', r, { scripts: scripts('3') }), edit('environment', e, { variables: [] })])
    expect(await apply(h, p)).toEqual(ok)
    expect(await undo(h, p)).toEqual(ok)
    for (const [now, was] of [[(await db.listCollections())[0], c], [(await db.listFolders())[0], f], [await storedRequest(r.id), r], [(await db.listEnvironments())[0], e]] as const) expect({ ...now, updatedAt: 0 }).toEqual({ ...was, updatedAt: 0 })
    expect(await undo(h, p)).toEqual(refused('changed'))
    expect(await apply(h, p)).toEqual(refused('changed'))
  })

  it('refuses what was never applied', async () => {
    const { r } = await seed(); const h = await mount()
    expect(await undo(h, proposal([edit('request', r, { url: 'x' })]))).toEqual(refused('changed'))
  })

  it('answers “changed” after a later edit by the person and writes nothing', async () => {
    const { r } = await seed(); const h = await mount()
    const p = proposal([edit('request', r, { url: 'https://b.test' })])
    await apply(h, p)
    await act(() => h.current.renameRequest(r, 'Mine'))
    const before = await everything()
    expect(await undo(h, p)).toEqual({ ok: false, reason: 'changed', text: 'This changed meanwhile, so nothing was undone.' })
    expect(await everything()).toBe(before)
  })

  it('takes a created collection, folder and request away again, but not with something else inside', async () => {
    await seed(); const h = await mount()
    const c = newCollection('New'), f = newFolder(c.id, 'F'), r = newRequest({ collectionId: c.id, folderId: f.id })
    const p = proposal([create('collection', c), create('folder', f), create('request', r)])
    const before = await everything()
    await apply(h, p)
    const mine = newRequest({ collectionId: c.id, folderId: f.id, name: 'Mine' })
    await act(() => h.current.importWorkspace({ collections: [], folders: [], requests: [mine], environments: [] }))
    const mid = await everything()
    expect(await undo(h, p)).toEqual(refused('changed'))
    expect(await everything()).toBe(mid)
    await act(() => h.current.removeRequest(mine.id))
    const sub = await act(() => h.current.addFolder(c.id, 'Sub', f.id))
    expect(await undo(h, p)).toEqual(refused('changed'))
    await act(() => h.current.removeFolder(sub.id))
    act(() => { h.current.startNew(c.id, f.id); h.current.setView({ kind: 'collection', id: c.id }) })
    expect(await undo(h, p)).toEqual(ok)
    expect(await everything()).toBe(before)
    expect(h.current.collections.map((x) => x.name)).toEqual(['Shop'])
    expect(h.current.view.kind).toBe('request')
    expect([h.current.draft.collectionId, h.current.draft.folderId]).toEqual([null, null])
  })

  it('refuses to put a request back whose folder is gone', async () => {
    const { f, r } = await seed(); const h = await mount()
    const p = proposal([remove(r)], { cls: 'delete' })
    await apply(h, p)
    await act(() => h.current.removeFolder(f.id))
    expect(await undo(h, p)).toEqual(refused('gone'))
    expect(h.current.trash.map((t) => t.label)).toEqual(['“Create order”', '“Orders”']) // still on the list
  })

  it('shares the undo list: once on it, and only one of the two puts it back', async () => {
    const { r, r2 } = await seed(); const h = await mount()
    const p = proposal([remove(r)], { cls: 'delete' })
    await act(() => h.current.removeRequest(r2.id))
    await apply(h, p)
    expect(h.current.trash.map((t) => t.label)).toEqual(['“Other”', '“Create order”'])
    expect(new Set(h.current.trash.map((t) => t.id)).size).toBe(2)
    expect(await undo(h, p)).toEqual(ok)
    expect(h.current.trash.map((t) => t.label)).toEqual(['“Other”'])
    expect(h.current.requests.map((x) => x.id)).toEqual([r.id])

    const q = proposal([remove(h.current.requests[0])], { cls: 'delete' })
    await apply(h, q)
    // both in one tick: the list is first
    const both = await act(() => { const l = h.current.undoDelete(); return Promise.all([l, h.current.undoProposal(q)]) })
    expect(both).toEqual(['“Create order”', refused('changed')])
    expect(h.current.requests.map((x) => x.id)).toEqual([r.id])
    // the person deleted it again: the list owns it now, the card doesn't
    await act(() => h.current.removeRequest(r.id))
    expect(await undo(h, q)).toEqual(refused('changed'))
    expect(h.current.requests).toEqual([])

    await act(async () => { await h.current.undoDelete() })
    const z = proposal([remove(h.current.requests[0])], { cls: 'delete' })
    await apply(h, z)
    const card = await act(() => { const u = h.current.undoProposal(z); return Promise.all([u, Promise.resolve().then(() => h.current.undoDelete())]) })
    expect(card[0]).toEqual(ok)
    expect(h.current.requests.filter((x) => x.id === r.id)).toHaveLength(1)
  })
})

describe('an open editor', () => {
  let ws!: WorkspaceApi
  function Host({ pick }: { pick: 'c' | 'f' | 'e' }) {
    const w = useWorkspace({ transport })
    useEffect(() => { ws = w })
    ws = w
    const props = { ws: w, confirm: async () => true }
    if (!w.ready) return null
    return pick === 'c' ? <CollectionEditor {...props} collection={w.collections[0]} /> : pick === 'f' ? <FolderEditor {...props} folder={w.folders[0]} /> : <EnvironmentEditor {...props} environment={w.environments[0]} />
  }
  const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })
  async function open(pick: 'c' | 'f' | 'e', label: string) { render(<Host pick={pick} />); return await screen.findByLabelText<HTMLInputElement>(label) }

  it('of a collection keeps an applied script and table when the docs, or the other script, are typed in next', async () => {
    const { c } = await seed()
    const docs = await open('c', 'Docs (Markdown)')
    type(docs, 'a')
    const now = ws.collections[0]
    const vars = [{ ...now.variables[0], value: 'https://b.test' }, now.variables[1]]
    await act(async () => { expect(await ws.applyProposal(proposal([edit('collection', now, { scripts: scripts('applied'), variables: vars })]))).toEqual(ok) })
    expect(screen.getByLabelText<HTMLTextAreaElement>('collection post-response script').value).toBe('applied')
    type(docs, 'ab')
    type(screen.getByLabelText('collection pre-request script'), 'mine')
    type(screen.getByLabelText('Collection name'), 'Shop 2')
    await waitFor(async () => expect((await db.listCollections())[0]).toMatchObject({ id: c.id, name: 'Shop 2', docs: 'ab', scripts: { pre: 'mine', post: 'applied' }, variables: [{ value: 'https://b.test' }, {}] }))
  })

  it('never writes the older version back, even if the keystroke comes before the change is drawn', async () => {
    await seed()
    const docs = await open('c', 'Docs (Markdown)')
    const now = ws.collections[0]
    // Not awaited by React: the write and the keystroke in one batch.
    await act(async () => { void ws.updateCollection({ ...now, scripts: scripts('outside') }); type(docs, 'typed') })
    await act(async () => { void ws.updateCollection({ ...ws.collections[0], scripts: scripts('outside 2') }); type(screen.getByLabelText('collection pre-request script'), 'mine') })
    await waitFor(async () => expect((await db.listCollections())[0]).toMatchObject({ docs: 'typed', scripts: { pre: 'mine', post: 'outside 2' } }))
  })

  it('of a folder keeps an applied script', async () => {
    const { f } = await seed()
    const docs = await open('f', 'Docs (Markdown)')
    await act(async () => { expect(await ws.applyProposal(proposal([edit('folder', f, { scripts: scripts('applied') })]))).toEqual(ok) })
    type(docs, 'typed')
    await waitFor(async () => expect((await db.listFolders())[0]).toMatchObject({ docs: 'typed', scripts: scripts('applied') }))
  })

  it('of an environment keeps applied variables', async () => {
    const { e } = await seed()
    const name = await open('e', 'Environment name')
    await act(async () => { expect(await ws.applyProposal(proposal([edit('environment', e, { variables: [{ ...e.variables[0], value: '2' }, kv('more', '3')] })]))).toEqual(ok) })
    type(name, 'Staging 2')
    await waitFor(async () => expect((await db.listEnvironments())[0]).toMatchObject({ name: 'Staging 2', variables: [{ value: '2' }, { key: 'more' }] }))
  })

  it('never moves the cursor or loses a letter while saves are pending', async () => {
    await seed()
    const name = await open('c', 'Collection name')
    const real = secretsOf.collection
    vi.spyOn(secretsOf, 'collection').mockImplementation(async (x, f) => { await new Promise((res) => setTimeout(res, 10)); return real(x, f) })
    name.focus()
    let text = 'Shop'
    for (const ch of 'abcdefgh') {
      text = `S${ch}${text.slice(1)}` // typing in the middle
      type(name, text)
      name.setSelectionRange(2, 2)
      await act(async () => { await new Promise((res) => setTimeout(res, 4)) })
      expect(name.value).toBe(text)
      expect([name.selectionStart, name.selectionEnd]).toEqual([2, 2])
    }
    await act(async () => { await new Promise((res) => setTimeout(res, 60)) })
    expect(name.value).toBe(text)
    expect((await db.listCollections())[0].name).toBe(text)
  })
})

describe('a linked folder', () => {
  class MemFolder implements FolderApi {
    files = new Map<string, string>()
    onRead: (() => void) | null = null
    async pick() { return null }
    hash(t: string) { return t }
    async read() { const out = [...this.files].sort().map(([path, text]) => ({ path, text, hash: text })); const f = this.onRead; this.onRead = null; f?.(); return out }
    async sync(_: string, files: { path: string; text: string }[], known: Record<string, string> | null) {
      const out: Record<string, string> = {}, conflicts: string[] = []
      for (const f of files) {
        const disk = this.files.get(f.path)
        if (disk !== f.text && known && disk !== known[f.path]) { conflicts.push(f.path); continue }
        this.files.set(f.path, f.text); out[f.path] = f.text
      }
      for (const p of [...this.files.keys()]) if (!files.some((f) => f.path === p)) this.files.delete(p)
      return { known: out, conflicts }
    }
    text() { return [...this.files.values()].join('\n') }
  }
  async function linked() {
    const s = await seed()
    const fs = new MemFolder()
    const engine = new InlineEngine()
    const h = renderHook(() => { const ws = useWorkspace({ transport, engine }); useFolderSync(ws, () => {}, fs); return ws })
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    await act(async () => { await linkSpace(h.result.current, fs, h.result.current.spaces[0], '/repo', async () => true) })
    await waitFor(() => expect(fs.text()).toContain('a.test/other'), { timeout: 4000 })
    return { ...s, fs, h: h.result }
  }
  const check = () => act(async () => { globalThis.dispatchEvent(new Event('dispatch-check-folders')) })

  it('gets the applied change', async () => {
    const { r2, fs, h } = await linked()
    expect(await apply(h, proposal([edit('request', r2, { scripts: scripts('applied-script') })]))).toEqual(ok)
    await waitFor(() => expect(fs.text()).toContain('applied-script'), { timeout: 4000 })
  }, 15000)

  it('a sync that changed the record in between gives “changed”', async () => {
    const { r2, fs, h } = await linked()
    const path = [...fs.files].find(([, t]) => t.includes('a.test/other'))![0]
    fs.files.set(path, fs.files.get(path)!.replace('a.test/other', 'a.test/from-git'))
    await check()
    await waitFor(() => expect(h.current.requests.some((x) => x.url.includes('from-git'))).toBe(true), { timeout: 4000 })
    expect(await apply(h, proposal([edit('request', r2, { scripts: scripts('x') })]))).toEqual(refused('changed'))
  }, 15000)

  it('a sync that was already reading doesn’t put the old version back over an applied change', async () => {
    const { r, r2, fs, h } = await linked()
    const path = [...fs.files].find(([, t]) => t.includes('a.test/other'))![0]
    fs.files.set(path, fs.files.get(path)!.replace('a.test/other', 'a.test/from-git'))
    let applied!: Promise<unknown>
    const real = fs.read.bind(fs)
    // The check has worked out what it would write; the change is applied before it takes the folder's version in.
    let once = true
    fs.read = async () => { const out = await real(); if (once) { once = false; applied = h.current.applyProposal(proposal([edit('request', r, { scripts: scripts('applied-script') })])); await applied } return out }
    await check()
    await waitFor(() => expect(h.current.requests.some((x) => x.url.includes('from-git'))).toBe(true), { timeout: 6000 })
    expect(await applied).toEqual(ok)
    expect(h.current.requests.find((x) => x.id === r.id)!.scripts.post).toBe('applied-script')
    await waitFor(() => expect(fs.text()).toContain('applied-script'), { timeout: 4000 })
    expect(h.current.requests.find((x) => x.id === r2.id)!.url).toContain('from-git')
  }, 20000)
})

describe('a folder’s version that was worked out earlier', () => {
  /** Links the workspace to a folder that already holds it with only “Plain”, answering yes to every question. */
  async function link(answer: (h: H, message: string) => Promise<void> = async () => {}) {
    const plain = newCollection('Plain'), own = { ...newCollection('Own'), linkedDir: '/own' }
    await db.putMany({ collections: [plain, own], requests: [newRequest({ name: 'mine', collectionId: own.id })] })
    const h = await mount()
    await act(() => h.current.setSpaceFolderId(DEFAULT_SPACE.id, 'fid'))
    const { stringify } = await import('yaml')
    const files = workspaceToFiles({ space: { id: 'fid', name: h.current.spaces[0].name }, collections: [plain], folders: [], requests: [], environments: [], flows: [] }, stringify)
    const fs: FolderApi = { pick: async () => null, hash: (t) => t, read: async () => files.map((f) => ({ ...f, hash: f.text })), sync: async () => ({ known: {}, conflicts: [] }) }
    await act(async () => { await linkSpace(h.current, fs, h.current.spaces[0], '/repo', async (m) => { await answer(h, m); return true }) })
    return h
  }
  it('keeps the collections that were just moved in', async () => {
    const h = await link()
    expect(h.current.collections.map((c) => c.name)).toEqual(['Own', 'Plain'])
    expect((await db.listCollections()).map((c) => c.name).sort()).toEqual(['Own', 'Plain'])
    expect((await db.listRequests()).map((x) => x.name)).toEqual(['mine'])
  })
  it('keeps what was added while it asked', async () => {
    const h = await link(async (w, m) => { if (m.includes('already holds')) await act(async () => { await w.current.addCollection('Added'); await w.current.addEnvironment('Env added') }) })
    expect(h.current.collections.map((c) => c.name)).toEqual(['Added', 'Own', 'Plain'])
    expect(h.current.environments.map((x) => x.name)).toEqual(['Env added'])
    expect((await db.listCollections()).length).toBe(3)
    expect((await db.listEnvironments()).length).toBe(1)
    // and the backup taken first has it all
    const saved = await db.getBackup(h.current.backups[0].id)
    expect(saved!.collections.map((c) => c.name).sort()).toEqual(['Added', 'Own', 'Plain'])
  })
  it('does not remove a collection that has moved to another workspace meanwhile', async () => {
    const { c } = await seed(); const h = await mount()
    const sp = await act(() => h.current.addSpace('B'))
    const old = h.current
    await act(() => h.current.moveToSpace('collection', c.id, sp.id))
    await act(async () => { await old.replaceSpaceContents(DEFAULT_SPACE.id, { collections: [], folders: [], requests: [], environments: [], flows: [] }) })
    expect((await db.listCollections()).map((x) => x.id)).toEqual([c.id])
    expect((await db.listRequests()).length).toBe(2)
  })
  it('of one collection is not taken in over a later write', async () => {
    const { c, r2 } = await seed(); const h = await mount()
    const old = h.current
    expect(await apply(h, proposal([edit('request', r2, { url: 'https://applied.test' })]))).toEqual(ok)
    expect(await act(() => old.replaceCollection({ collections: [c], folders: [], requests: [r2], environments: [] }, { keepEdits: true, trashLabel: 'x', ifUnchanged: true }))).toBe(false)
    expect((await storedRequest(r2.id))!.url).toBe('https://applied.test')
    expect(h.current.trash).toEqual([])
  })
  it('“Use the file’s version” says so when something changed meanwhile, and changes nothing', async () => {
    const { r, r2 } = await seed(); const h = await mount()
    const { stringify } = await import('yaml')
    await act(() => h.current.setSpaceFolder(DEFAULT_SPACE.id, '/repo'))
    const ws = h.current, ids = new Set(ws.collections.map((c) => c.id))
    const files = workspaceToFiles({ space: { id: DEFAULT_SPACE.id, name: ws.spaces[0].name }, collections: ws.collections, folders: ws.folders, requests: ws.requests.filter((x) => ids.has(x.collectionId!)), environments: ws.environments, flows: [] }, stringify)
    await db.putFolderState(`space:${DEFAULT_SPACE.id}`, Object.fromEntries(files.map((f) => [f.path, f.text])))
    const path = files.find((f) => f.text.includes('a.test/other'))!.path
    const disk = files.map((f) => ({ path: f.path, text: f.text.replace('a.test/other', 'a.test/from-git') }))
    const fs: FolderApi = { pick: async () => null, hash: (t) => t, sync: async () => ({ known: {}, conflicts: [] }), read: async () => { await h.current.applyProposal(proposal([edit('request', r, { docs: 'applied' })])); return disk.map((f) => ({ ...f, hash: f.text })) } }
    await act(async () => { await expect(takeFile(ws, fs, `space:${DEFAULT_SPACE.id}`, path)).rejects.toThrow('Try again') })
    expect((await storedRequest(r.id))!.docs).toBe('applied')
    expect((await storedRequest(r2.id))!.url).toBe(r2.url)
  })
  it('an import queued before a switch still lands where it was asked for', async () => {
    await seed(); const h = await mount()
    const sp = await act(() => h.current.addSpace('B'))
    await act(async () => { const p = h.current.importWorkspace({ collections: [newCollection('Imported')], folders: [], requests: [], environments: [] }); h.current.switchSpace(sp.id); await p })
    expect((await db.listCollections()).find((x) => x.name === 'Imported')!.workspaceId).toBe(DEFAULT_SPACE.id)
  })
})

describe('writes that fail', () => {
  it('a hand-off that can’t be stored leaves nothing behind, and the next one works', async () => {
    const { r } = await seed(); const h = await mount()
    vi.spyOn(secretsOf, 'collection').mockRejectedValueOnce(new Error('no'))
    await act(async () => { await expect(h.current.handToAssistant(r, 'a')).rejects.toThrow('no') })
    expect(h.current.requests.length).toBe(2)
    expect(h.current.spaces.map((x) => x.id)).toEqual([DEFAULT_SPACE.id])
    expect((await db.getSpaces()).map((x) => x.id)).toEqual([DEFAULT_SPACE.id])
    await act(async () => { await h.current.handToAssistant(r, 'b') })
    const inbox = (await db.listCollections()).find((x) => x.workspaceId === ASSISTANT_SPACE.id)!
    expect((await db.listRequests()).filter((x) => x.handoff).map((x) => x.collectionId)).toEqual([inbox.id])
    expect((await db.getSpaces()).map((x) => x.id)).toContain(ASSISTANT_SPACE.id)
  })
  it('an assistant’s change that can’t be stored puts request, folder and tab back', async () => {
    const { c, f, r } = await seed(); const h = await mount()
    await act(async () => { await h.current.setSpaceAi(DEFAULT_SPACE.id, true) })
    act(() => h.current.openRequest(r))
    const real = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, v, k) { if (this.name === 'requests') throw new Error('full'); return k === undefined ? real.call(this, v) : real.call(this, v, k) })
    await act(async () => { await expect(h.current.saveAssistant({ collections: [{ ...c, docs: 'n' }], folders: [{ ...f, docs: 'n' }], requests: [{ ...r, url: 'n' }] })).rejects.toThrow('full') })
    vi.restoreAllMocks()
    expect([h.current.collections[0].docs, h.current.folders[0].docs, h.current.draft.url, h.current.dirty]).toEqual(['', '', r.url, false])
    expect([(await db.listCollections())[0].docs, (await db.listFolders())[0].docs, (await storedRequest(r.id))!.url]).toEqual(['', '', r.url])
  })
  it('an assistant’s change still being sealed can’t land on an applied one', async () => {
    const { r } = await seed(); const h = await mount()
    await act(async () => { await h.current.setSpaceAi(DEFAULT_SPACE.id, true) })
    const real = secretsOf.request
    vi.spyOn(secretsOf, 'request').mockImplementationOnce(async (x, f) => { await new Promise((res) => setTimeout(res, 40)); return real(x, f) })
    const mid = { ...r, docs: 'assistant' }
    await act(async () => {
      const slow = h.current.saveAssistant({ collections: [], folders: [], requests: [mid] })
      expect(await h.current.applyProposal(proposal([edit('request', mid, { url: 'https://applied.test' })]))).toEqual(ok)
      await slow
    })
    expect(await storedRequest(r.id)).toMatchObject({ docs: 'assistant', url: 'https://applied.test' })
  })
  it('a hand-off that is still adding its workspace can’t land on an applied change', async () => {
    const { r } = await seed(); const h = await mount()
    await act(async () => { await h.current.setSpaceAi(DEFAULT_SPACE.id, true) })
    // Storing the list of workspaces takes a while.
    const real = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, v, k) {
      const q = k === undefined ? real.call(this, v) : real.call(this, v, k)
      const end = Date.now() + 40
      const hold = () => { if (Date.now() < end) this.get('x').onsuccess = hold }
      if (k === 'spaces') hold()
      return q
    })
    await act(async () => {
      const slow = h.current.saveAssistant({ collections: [], folders: [], requests: [{ ...r, docs: 'a' }] })
      const [a] = await Promise.all([h.current.applyProposal(proposal([edit('request', { ...r, docs: 'a' }, { url: 'https://applied.test' })])), slow])
      expect(a).toEqual(ok)
    })
    expect(await storedRequest(r.id)).toMatchObject({ docs: 'a', url: 'https://applied.test' })
  })
  it('a delete that fails puts everything back', async () => {
    const { c, f, r, e } = await seed(); const h = await mount()
    act(() => h.current.openRequest(r))
    const was = JSON.stringify([h.current.collections, h.current.folders, h.current.environments]), stored = await everything()
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => { throw new Error('full') })
    for (const run of [() => h.current.removeRequest(r.id), () => h.current.removeRequests([r.id]), () => h.current.removeFolder(f.id), () => h.current.removeCollection(c.id), () => h.current.removeEnvironment(e.id)]) {
      await act(async () => { await expect(run()).rejects.toThrow('full') })
      expect(JSON.stringify([h.current.collections, h.current.folders, h.current.environments])).toBe(was)
      expect(h.current.requests.map((x) => x.name).sort()).toEqual(['Create order', 'Other'])
    }
    vi.restoreAllMocks()
    expect(h.current.trash).toEqual([])
    expect(h.current.draft.id).toBe(r.id)
    expect(await everything()).toBe(stored)
  })
})

describe('the undo list and the card', () => {
  it('a card’s undo that is refused leaves the list untouched the whole time', async () => {
    const { f, r } = await seed()
    const lengths: number[] = []
    const h = renderHook(() => { const w = useWorkspace({ transport }); lengths.push(w.trash.length); return w }).result
    await waitFor(() => expect(h.current.ready).toBe(true))
    const p = proposal([remove(r)], { cls: 'delete' })
    await apply(h, p)
    await act(() => h.current.removeFolder(f.id))
    const list = h.current.trash; lengths.length = 0
    expect(await undo(h, p)).toEqual(refused('gone'))
    expect(h.current.trash).toBe(list)
    expect(lengths.filter((n) => n !== 2)).toEqual([])
    expect(await act(() => h.current.undoDelete(list[0].id))).toBe('“Create order”') // the list still can
  })
  it('the toast’s Undo puts back only what it named', async () => {
    await seed()
    const rs = await db.listRequests()
    const h = await mount()
    await act(() => h.current.removeRequest(rs[0].id)); const first = h.current.trash[0]
    await act(() => h.current.removeRequest(rs[1].id)); const second = h.current.trash[1]
    expect(await act(() => h.current.undoDelete(first.id))).toBe(first.label)
    expect(h.current.trash.map((t) => t.id)).toEqual([second.id])
    expect(await act(() => h.current.undoDelete(first.id))).toBeNull()
    expect(h.current.requests.map((x) => x.id)).toEqual([rs[0].id])
  })
  it('a request edited while its delete commits stays and is not on the list', async () => {
    const { r } = await seed(); const h = await mount()
    whileCommitting('requests', () => { void h.current.renameRequest(r, 'Kept') })
    await apply(h, proposal([remove(r)], { cls: 'delete' }))
    expect(h.current.requests.filter((x) => x.id === r.id).map((x) => x.name)).toEqual(['Kept'])
    expect(h.current.trash).toEqual([])
    expect((await storedRequest(r.id))!.name).toBe('Kept')
  })
  it('the backup before a restore has what was applied since the click was drawn', async () => {
    const { r2 } = await seed(); const h = await mount()
    await act(() => h.current.backupNow())
    const id = h.current.backups[0].id, old = h.current
    expect(await apply(h, proposal([edit('request', r2, { url: 'https://applied.test' })]))).toEqual(ok)
    await act(() => old.restoreBackup(id))
    const b = h.current.backups.find((x) => x.reason === 'before-restore')!
    expect((await db.getBackup(b.id))!.requests.map((x) => x.url)).toContain('https://applied.test')
  })
})

describe('records', () => {
  it('applyRecords writes and deletes over every store in one go', async () => {
    const { c, f, r, e } = await seed()
    const g: KV[] = [kv('z', '9')]
    await db.applyRecords([edit('collection', c, { name: 'C2' }), edit('environment', e, { name: 'E2' }), { kind: 'globals', id: 'globals', before: [], after: g }], [remove(r), { kind: 'folder', id: f.id, before: f, after: null }])
    expect([(await db.listCollections())[0].name, (await db.listEnvironments())[0].name, await db.getGlobals(), (await db.listFolders()).length, (await db.listRequests()).map((x) => x.name)]).toEqual(['C2', 'E2', g, 0, ['Other']])
  })
})
