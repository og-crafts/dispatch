/** Linked workspaces (docs/DESIGN-linked-workspaces.md), against an in-memory folder with the same rules as sync_folder. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useWorkspace } from '../src/ui/useWorkspace'
import { type FolderApi, changePassphrase, checkFolders, keepMineFile, linkSpace, openSpaceFolder, reloadSpace, resolveVault, takeFile, turnOnSecrets, useFolderSync } from '../src/ui/linkedDirs'
import { getVaultRecord, resetForTests } from '../src/core/db'
import { sealVault } from '../src/core/secretsVault'
import { kv, newCollection, newRequest } from '../src/core/types'
import { newFlow, newNode } from '../src/core/flows'
import type { Transport } from '../src/core/transport'

/** Folders in memory. The "hash" is the text itself; the compare-before-write rules match the Rust side. */
class MemFolders implements FolderApi {
  dirs = new Map<string, Map<string, string>>()
  dir(root: string) { if (!this.dirs.has(root)) this.dirs.set(root, new Map()); return this.dirs.get(root)! }
  async pick() { return null }
  hash(text: string) { return text }
  vaults = new Map<string, string>()
  async readVault(root: string) { const t = this.vaults.get(root); return t === undefined ? null : { text: t, hash: t } }
  async putVault(root: string, text: string | null, known: string | null) {
    if ((this.vaults.get(root) ?? null) !== known) throw new Error('changed')
    if (text === null) { this.vaults.delete(root); return null }
    this.vaults.set(root, text); return text
  }
  async read(root: string) { return [...this.dir(root)].sort().map(([path, text]) => ({ path, text, hash: text })) }
  async sync(root: string, files: { path: string; text: string }[], known: Record<string, string> | null) {
    const d = this.dir(root), out: Record<string, string> = {}, conflicts: string[] = []
    for (const f of files) {
      const disk = d.get(f.path)
      if (disk === f.text) { out[f.path] = f.text; continue }
      if (known && disk !== known[f.path]) { conflicts.push(f.path); if (known[f.path] !== undefined) out[f.path] = known[f.path]; continue }
      d.set(f.path, f.text); out[f.path] = f.text
    }
    for (const [p, text] of [...d]) {
      if (files.some((f) => f.path === p)) continue
      if (!known || text === known[p]) d.delete(p); else { conflicts.push(p); if (known[p] !== undefined) out[p] = known[p] }
    }
    return { known: out, conflicts: conflicts.sort() }
  }
}

const desktop: Transport = { label: 'fake', unrestricted: true, send: async () => { throw new Error('no network') } }
const yes = async () => true
let fs: MemFolders
beforeEach(async () => { await resetForTests(); fs = new MemFolders() })
afterEach(() => cleanup())

function mount() {
  const notes: string[] = []
  const h = renderHook(() => { const ws = useWorkspace({ transport: desktop }); useFolderSync(ws, (m) => notes.push(m), fs); return ws })
  return { h, notes }
}
const filesIn = (root: string) => [...fs.dir(root).keys()].sort()

describe('linked workspaces', () => {
  it('writes the workspace, leaves outside edits alone, and takes the folder’s version on request', async () => {
    const { h, notes } = mount()
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    await act(async () => {
      await h.result.current.addCollection('Shop API')
      const env = await h.result.current.addEnvironment('Staging')
      await h.result.current.updateEnvironment({ ...env, variables: [kv('base', 'https://s.test'), kv('token', 'top-secret', true, { secret: true })] })
      await h.result.current.addFlow('Smoke')
    })
    const space = h.result.current.spaces[0]
    let msg = ''
    await act(async () => { msg = await linkSpace(h.result.current, fs, space, '/repo', yes) })
    expect(msg).toMatch(/^Linked to \/repo/)

    await waitFor(() => expect(filesIn('/repo')).toContain('flows/smoke.flow.yaml'), { timeout: 3000 })
    expect(filesIn('/repo')).toEqual(['collections/shop-api/dispatch.collection.yaml', 'dispatch.workspace.yaml', 'environments/staging.env.yaml', 'flows/smoke.flow.yaml'])
    expect([...fs.dir('/repo').values()].join('\n')).not.toContain('top-secret')

    // Someone edits the flow outside the app (git pull), then the app edits it too.
    const outside = fs.dir('/repo').get('flows/smoke.flow.yaml')!.replace('name: Smoke', 'name: Smoke from git')
    fs.dir('/repo').set('flows/smoke.flow.yaml', outside)
    await act(async () => { const f = h.result.current.allFlows[0]; await h.result.current.updateFlow({ ...f, name: 'Smoke edited here' }) })
    await waitFor(() => expect(h.result.current.folderStatus['space:' + space.id]?.conflicts).toEqual(['flows/smoke.flow.yaml']), { timeout: 3000 })
    expect(fs.dir('/repo').get('flows/smoke.flow.yaml')).toBe(outside) // left alone
    expect(filesIn('/repo').filter((p) => p.startsWith('flows/'))).toEqual(['flows/smoke.flow.yaml']) // the renamed copy is held back
    expect(notes.some((n) => n.includes('changed both there and in Dispatch'))).toBe(true)

    // "Use the folder's version": the app now has git's flow; the device's secret survives.
    await act(async () => { await reloadSpace(h.result.current, fs, h.result.current.spaces[0]) })
    expect(h.result.current.allFlows.map((f) => f.name)).toEqual(['Smoke from git'])
    expect(h.result.current.folderStatus['space:' + space.id]?.conflicts).toEqual([])
    expect(h.result.current.allEnvironments[0].variables.find((v) => v.key === 'token')?.value).toBe('top-secret')
    expect(h.result.current.backups[0]?.reason).toBe('before-folder')
  })

  it('opens a workspace folder on another device, without secrets', async () => {
    // Device A links and writes.
    const a = mount()
    await waitFor(() => expect(a.h.result.current.ready).toBe(true))
    await act(async () => {
      const env = await a.h.result.current.addEnvironment('Staging')
      await a.h.result.current.updateEnvironment({ ...env, variables: [kv('token', 'top-secret', true, { secret: true })] })
      await a.h.result.current.renameSpace(a.h.result.current.spaces[0].id, 'Payments')
    })
    await act(async () => { await linkSpace(a.h.result.current, fs, a.h.result.current.spaces[0], '/repo', yes) })
    await waitFor(() => expect(filesIn('/repo')).toContain('environments/staging.env.yaml'), { timeout: 3000 })
    a.h.unmount()

    // Device B: fresh storage, same folder (a clone).
    await resetForTests()
    fs.dirs.set('/clone', new Map(fs.dir('/repo')))
    const b = mount()
    await waitFor(() => expect(b.h.result.current.ready).toBe(true))
    let msg = ''
    await act(async () => { msg = await openSpaceFolder(b.h.result.current, fs, '/clone', yes) })
    expect(msg).toMatch(/^Opened “Payments”/)
    // Its own workspace, not device B's first one (every device's first workspace has the id "default").
    const opened = b.h.result.current.spaces.find((x) => x.linkedDir === '/clone')!
    expect(opened.name).toBe('Payments')
    expect(opened.id).not.toBe('default')
    expect(b.h.result.current.spaces.find((x) => x.id === 'default')?.name).toBe('My workspace')
    expect(b.h.result.current.activeSpaceId).toBe(opened.id)
    const env = b.h.result.current.allEnvironments.find((e) => e.name === 'Staging')!
    expect(env.variables.map((v) => [v.key, v.value, !!v.secret])).toEqual([['token', '', true]])
  })

  it('opens a copied folder with a new workspace id as copies, leaving the original workspace alone', async () => {
    // Windows round 3: a copy of a linked folder, with only the workspace id edited, moved the original's records
    // (and their secrets) into the new workspace, because the record ids matched.
    const { h } = mount()
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    const col = newCollection('Shop API')
    const req = newRequest({ name: 'Orders', collectionId: col.id, url: 'https://s.test/orders' })
    const flow = newFlow('Smoke')
    const node = { ...newNode('request', 200, 140), config: { requestId: req.id } }
    await act(async () => {
      await h.result.current.importWorkspace({ collections: [col], folders: [], requests: [req], environments: [], flows: [{ ...flow, nodes: [...flow.nodes, node], edges: [{ id: 'e1', from: flow.nodes[0].id, port: 'next', to: node.id }] }] })
      const env = await h.result.current.addEnvironment('Staging')
      await h.result.current.updateEnvironment({ ...env, variables: [kv('token', 'top-secret', true, { secret: true })] })
    })
    const original = h.result.current.spaces[0]
    await act(async () => { await linkSpace(h.result.current, fs, original, '/repo', yes) })
    await waitFor(() => expect(filesIn('/repo')).toContain('flows/smoke.flow.yaml'), { timeout: 3000 })

    // The copy: same files, but someone gave the workspace a new id and name.
    const copy = new Map(fs.dir('/repo'))
    const head = copy.get('dispatch.workspace.yaml')!
    copy.set('dispatch.workspace.yaml', head.replace(/^id: .*$/m, 'id: copied-workspace').replace(/^name: .*$/m, 'name: Copy'))
    fs.dirs.set('/copy', copy)
    let msg = ''
    await act(async () => { msg = await openSpaceFolder(h.result.current, fs, '/copy', yes) })
    expect(msg).toMatch(/^Opened “Copy”/)

    const ws = h.result.current
    const copySpace = ws.spaces.find((x) => x.linkedDir === '/copy')!
    const inSpace = (id: string) => ({
      cols: ws.allCollections.filter((c) => (c.workspaceId ?? 'default') === id),
      envs: ws.allEnvironments.filter((e) => (e.workspaceId ?? 'default') === id),
      flows: ws.allFlows.filter((f) => (f.workspaceId ?? 'default') === id),
    })
    // The original keeps everything, with its secret and its own ids.
    const a = inSpace(original.id)
    expect([a.cols.length, a.envs.length, a.flows.length]).toEqual([1, 1, 1])
    expect(a.cols[0].id).toBe(col.id)
    expect(a.envs[0].variables[0].value).toBe('top-secret')
    expect(ws.requests.filter((r) => r.collectionId === col.id).map((r) => r.id)).toEqual([req.id])
    // The copy has its own records, no secret values, and its flow points at its own request.
    const b = inSpace(copySpace.id)
    expect([b.cols.length, b.envs.length, b.flows.length]).toEqual([1, 1, 1])
    expect(b.cols[0].id).not.toBe(col.id)
    expect(b.envs[0].id).not.toBe(a.envs[0].id)
    expect(b.envs[0].variables.map((v) => [v.key, v.value])).toEqual([['token', '']])
    const copyReqs = ws.requests.filter((r) => r.collectionId === b.cols[0].id)
    expect(copyReqs.map((r) => r.name)).toEqual(['Orders'])
    expect(copyReqs[0].id).not.toBe(req.id)
    expect(b.flows[0].id).not.toBe(a.flows[0].id)
    expect(b.flows[0].nodes.find((n) => n.type === 'request')?.config.requestId).toBe(copyReqs[0].id)
    expect(a.flows[0].nodes.find((n) => n.type === 'request')?.config.requestId).toBe(req.id)
  })

  it('refuses folders that hold something else', async () => {
    const { h } = mount()
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    fs.dir('/col').set('dispatch.collection.yaml', 'name: A\n')
    expect(await linkSpace(h.result.current, fs, h.result.current.spaces[0], '/col', yes)).toMatch(/other Dispatch files/)
    expect(await openSpaceFolder(h.result.current, fs, '/col', yes)).toMatch(/isn’t a Dispatch workspace folder/)
    expect(h.result.current.spaces[0].linkedDir).toBeUndefined()
  })
})

describe('linked workspaces: changes made in the folder (phase 2)', () => {
  async function linked() {
    const m = mount()
    const { h } = m
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    await act(async () => {
      const env = await h.result.current.addEnvironment('Staging')
      await h.result.current.updateEnvironment({ ...env, variables: [kv('base', 'https://s.test'), kv('token', 'top-secret', true, { secret: true })] })
      await h.result.current.addFlow('Smoke')
    })
    const space = h.result.current.spaces[0]
    await act(async () => { await linkSpace(h.result.current, fs, space, '/repo', yes) })
    await waitFor(() => expect(filesIn('/repo')).toContain('flows/smoke.flow.yaml'), { timeout: 3000 })
    await waitFor(() => expect(h.result.current.folderStatus['space:' + space.id]).toBeTruthy(), { timeout: 3000 })
    return { ...m, key: 'space:' + space.id }
  }
  const env = 'environments/staging.env.yaml'
  const check = async () => { await act(async () => { checkFolders() }) }

  it('takes in a change made only in the folder, keeping this device’s secret', async () => {
    const { h, notes, key } = await linked()
    fs.dir('/repo').set(env, fs.dir('/repo').get(env)!.replace('https://s.test', 'https://new.test'))
    await check()
    await waitFor(() => expect(h.result.current.allEnvironments[0].variables.find((v) => v.key === 'base')?.value).toBe('https://new.test'), { timeout: 3000 })
    expect(h.result.current.allEnvironments[0].variables.find((v) => v.key === 'token')?.value).toBe('top-secret')
    expect(notes.some((n) => n.startsWith('Updated from /repo: 1 environment'))).toBe(true)
    await waitFor(() => expect(h.result.current.folderStatus[key]?.conflicts).toEqual([]), { timeout: 3000 })
    expect(fs.dir('/repo').get(env)).toContain('https://new.test')
    expect(fs.dir('/repo').get(env)).not.toContain('top-secret')
  })

  it('takes in files added and removed in the folder; a removed item can be undone', async () => {
    const { h } = await linked()
    fs.dir('/repo').delete('flows/smoke.flow.yaml')
    fs.dir('/repo').set('environments/prod.env.yaml', 'id: prod-env\nname: Prod\nvariables:\n  - key: base\n    value: https://p.test\n')
    await check()
    await waitFor(() => expect(h.result.current.allEnvironments.map((e) => e.name).sort()).toEqual(['Prod', 'Staging']), { timeout: 3000 })
    expect(h.result.current.allFlows).toEqual([])
    expect(h.result.current.trash.at(-1)?.data.flows?.map((f) => f.name)).toEqual(['Smoke'])
  })

  it('sets a cloud drive’s copy aside instead of adding a duplicate, and removes it on “keep mine”', async () => {
    const { h, key } = await linked()
    const copy = "environments/staging (Laptop's conflicted copy).env.yaml"
    fs.dir('/repo').set(copy, fs.dir('/repo').get(env)!.replace('https://s.test', 'https://laptop.test'))
    await check()
    await waitFor(() => expect(h.result.current.folderStatus[key]?.copies).toEqual([copy]), { timeout: 3000 })
    expect(h.result.current.folderStatus[key]?.conflicts).toEqual([])
    expect(h.result.current.allEnvironments.map((e) => e.name)).toEqual(['Staging'])
    expect(fs.dir('/repo').has(copy)).toBe(true) // never deleted without asking
    await act(async () => { await keepMineFile(fs, key, '/repo', copy) })
    await waitFor(() => expect(fs.dir('/repo').has(copy)).toBe(false), { timeout: 3000 })
  })

  it('leaves a file it can’t read alone and says why', async () => {
    const { h, key } = await linked()
    fs.dir('/repo').set(env, 'id: x\n<<<<<<< HEAD\nname: A\n=======\nname: B\n>>>>>>> main\n  bad: [\n')
    await check()
    await waitFor(() => expect(h.result.current.folderStatus[key]?.unreadable?.map((u) => u.path)).toEqual([env]), { timeout: 3000 })
    expect(h.result.current.allEnvironments[0].variables.find((v) => v.key === 'base')?.value).toBe('https://s.test')
    expect(fs.dir('/repo').get(env)).toContain('<<<<<<<')
  })

  it('resolves one conflict at a time: the file’s version, or mine', async () => {
    const { h, key } = await linked()
    // Both sides change the environment and the flow's docs.
    fs.dir('/repo').set(env, fs.dir('/repo').get(env)!.replace('https://s.test', 'https://folder.test'))
    const flowPath = 'flows/smoke.flow.yaml'
    fs.dir('/repo').set(flowPath, fs.dir('/repo').get(flowPath)!.replace('name: Smoke', 'name: Smoke\ndocs: from the folder'))
    await act(async () => {
      const e = h.result.current.allEnvironments[0]
      await h.result.current.updateEnvironment({ ...e, variables: e.variables.map((v) => (v.key === 'base' ? { ...v, value: 'https://app.test' } : v)) })
      const f = h.result.current.allFlows[0]
      await h.result.current.updateFlow({ ...f, docs: 'from the app' })
    })
    await waitFor(() => expect(h.result.current.folderStatus[key]?.conflicts).toEqual([env, flowPath]), { timeout: 3000 })
    await act(async () => { await takeFile(h.result.current, fs, key, env) })
    await waitFor(() => expect(h.result.current.allEnvironments[0].variables.find((v) => v.key === 'base')?.value).toBe('https://folder.test'), { timeout: 3000 })
    await act(async () => { await keepMineFile(fs, key, '/repo', flowPath) })
    await waitFor(() => expect(fs.dir('/repo').get(flowPath)).toContain('from the app'), { timeout: 3000 })
    await waitFor(() => expect(h.result.current.folderStatus[key]?.conflicts).toEqual([]), { timeout: 3000 })
    expect(h.result.current.allFlows[0].docs).toBe('from the app')
    expect(h.result.current.allEnvironments[0].variables.find((v) => v.key === 'token')?.value).toBe('top-secret')
  })
})

describe('linked workspaces: secrets that travel with the folder (opt-in, encrypted)', () => {
  const secretOf = (ws: ReturnType<typeof useWorkspace>) => ws.allEnvironments.find((e) => e.name === 'Staging')?.variables.find((v) => v.key === 'token')?.value
  const check = async () => { await act(async () => { checkFolders() }) }

  it('syncs secret values between two computers with a passphrase, and never in readable form', { timeout: 60_000 }, async () => {
    // Computer A: a workspace with a secret, linked, secrets sync turned on.
    const a = mount()
    await waitFor(() => expect(a.h.result.current.ready).toBe(true))
    await act(async () => {
      const env = await a.h.result.current.addEnvironment('Staging')
      await a.h.result.current.updateEnvironment({ ...env, variables: [kv('base', 'https://s.test'), kv('token', 'top-secret', true, { secret: true })] })
    })
    await act(async () => { await linkSpace(a.h.result.current, fs, a.h.result.current.spaces[0], '/repo', yes) })
    await waitFor(() => expect(filesIn('/repo')).toContain('environments/staging.env.yaml'), { timeout: 3000 })
    let msg = ''
    await act(async () => { msg = await turnOnSecrets(a.h.result.current, fs, a.h.result.current.spaces[0], 'correct horse battery') })
    expect(msg).toMatch(/Secrets sync is on/)
    await waitFor(() => expect(fs.vaults.get('/repo')).toBeTruthy(), { timeout: 5000 })
    expect(fs.vaults.get('/repo')).not.toContain('top-secret')
    expect([...fs.dir('/repo').values()].join('\n')).not.toContain('top-secret')
    a.h.unmount()

    // Computer B: opens a copy of the folder; no secret until it unlocks; a wrong passphrase is refused.
    await resetForTests()
    fs.dirs.set('/clone', new Map(fs.dir('/repo'))); fs.vaults.set('/clone', fs.vaults.get('/repo')!)
    const b = mount()
    await waitFor(() => expect(b.h.result.current.ready).toBe(true))
    await act(async () => { await openSpaceFolder(b.h.result.current, fs, '/clone', yes) })
    expect(secretOf(b.h.result.current)).toBe('')
    const space = () => b.h.result.current.spaces.find((x) => x.linkedDir === '/clone')!
    await expect(turnOnSecrets(b.h.result.current, fs, space(), 'wrong passphrase')).rejects.toThrow(/doesn’t open/)
    expect(space().syncSecrets).toBeFalsy()
    await act(async () => { msg = await turnOnSecrets(b.h.result.current, fs, space(), 'correct horse battery') })
    expect(msg).toMatch(/^Unlocked/)
    await waitFor(() => expect(secretOf(b.h.result.current)).toBe('top-secret'), { timeout: 5000 })
    const key = 'space:' + space().id
    await waitFor(() => expect(b.h.result.current.folderStatus[key]?.vault?.state).toBe('ok'), { timeout: 5000 })

    // B changes the secret: the file changes, and still doesn't show it.
    const before = fs.vaults.get('/clone')
    await act(async () => {
      const e = b.h.result.current.allEnvironments.find((x) => x.name === 'Staging')!
      await b.h.result.current.updateEnvironment({ ...e, variables: e.variables.map((v) => (v.key === 'token' ? { ...v, value: 'rotated' } : v)) })
    })
    await waitFor(() => expect(fs.vaults.get('/clone')).not.toBe(before), { timeout: 5000 })
    expect(fs.vaults.get('/clone')).not.toContain('rotated')

    // Someone else writes the file with yet another value while B changes it too: a conflict, nothing overwritten.
    const theirs = fs.vaults.get('/clone')!
    fs.vaults.set('/clone', theirs.replace(/"iv": "[^"]*"/, '"iv": "AAAAAAAAAAAAAAAA"')) // changed on disk (and can't be opened)
    await check()
    await waitFor(() => expect(b.h.result.current.folderStatus[key]?.vault?.state).toBe('locked'), { timeout: 5000 })
    expect(secretOf(b.h.result.current)).toBe('rotated') // a file that doesn't open never touches this computer's values
    fs.vaults.set('/clone', theirs)
    await check()
    await waitFor(() => expect(b.h.result.current.folderStatus[key]?.vault?.state).toBe('ok'), { timeout: 5000 })

    // Another computer writes a new value while this one changes it too: a conflict; nothing is overwritten.
    const rec = (await getVaultRecord(space().id))!
    fs.vaults.set('/clone', await sealVault({ environments: { [b.h.result.current.allEnvironments.find((x) => x.name === 'Staging')!.id]: { token: 'from-laptop' } }, collections: {} }, rec.keys!))
    await act(async () => {
      const e = b.h.result.current.allEnvironments.find((x) => x.name === 'Staging')!
      await b.h.result.current.updateEnvironment({ ...e, variables: e.variables.map((v) => (v.key === 'token' ? { ...v, value: 'from-desktop' } : v)) })
    })
    await waitFor(() => expect(b.h.result.current.folderStatus[key]?.vault?.state).toBe('conflict'), { timeout: 5000 })
    expect(secretOf(b.h.result.current)).toBe('from-desktop')
    await act(async () => { msg = await resolveVault(b.h.result.current, fs, space(), 'folder') })
    expect(msg).toMatch(/from the folder/)
    await waitFor(() => expect(secretOf(b.h.result.current)).toBe('from-laptop'), { timeout: 5000 })
    await waitFor(() => expect(b.h.result.current.folderStatus[key]?.vault?.state).toBe('ok'), { timeout: 5000 })

    // A new passphrase set here: the file is written again (another salt), and this computer keeps working.
    const old = fs.vaults.get('/clone')
    await act(async () => { msg = await changePassphrase(b.h.result.current, fs, space(), 'a brand new passphrase') })
    expect(msg).toMatch(/Passphrase changed/)
    expect(fs.vaults.get('/clone')).not.toBe(old)
    await check()
    await waitFor(() => expect(b.h.result.current.folderStatus[key]?.vault?.state).toBe('ok'), { timeout: 5000 })
  })
})
