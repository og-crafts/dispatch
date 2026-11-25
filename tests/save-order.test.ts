/** Saves land in the order they were made: sealing the secrets in one takes a moment, and a later one must not overtake it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../src/core/db'
import { defaultSettings, type HistoryEntry, kv, newCollection, newEnvironment, newFolder, newRequest, type RequestDef } from '../src/core/types'

beforeEach(async () => { await db.resetForTests(); await db.putGlobals([kv('k', 'warm', true, { secret: true })]) })
afterEach(() => { vi.restoreAllMocks() })

/** The next sealing takes long; the ones after it are quick. */
function slowFirst() {
  const real = crypto.subtle.encrypt.bind(crypto.subtle)
  let first = true
  const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...a) => {
    if (first) { first = false; await new Promise((r) => setTimeout(r, 60)) }
    return real(...a)
  })
  return () => expect(spy).toHaveBeenCalled()
}
const secret = (value: string) => [kv('token', value, true, { secret: true })]
const auth = (token: string) => ({ ...newRequest().auth, kind: 'bearer' as const, token })
const col = newCollection('Shop'), env = newEnvironment('Dev'), folder = newFolder(col.id, 'F'), req = newRequest({ name: 'R', collectionId: col.id })

const saves: [string, (v: string) => Promise<unknown>, () => Promise<unknown>][] = [
  ['a collection', (v) => db.putCollection({ ...col, variables: secret(v) }), async () => (await db.listCollections())[0].variables[0].value],
  ['an environment', (v) => db.putEnvironment({ ...env, variables: secret(v) }), async () => (await db.listEnvironments())[0].variables[0].value],
  ['a folder', (v) => db.putFolder({ ...folder, auth: auth(v) }), async () => (await db.listFolders())[0].auth.token],
  ['a request', (v) => db.putRequest({ ...req, auth: auth(v) }), async () => (await db.listRequests())[0].auth.token],
  ['globals', (v) => db.putGlobals(secret(v)), async () => (await db.getGlobals())[0].value],
  ['settings', (v) => db.putSettings({ ...defaultSettings, mcpHostToken: v }), async () => (await db.getSettings()).mcpHostToken],
  ['open tabs', (v) => db.putOpenTabs([{ ...req, auth: auth(v) }], 0), async () => (await db.getOpenTabs())!.tabs[0].auth.token],
  ['cookies', (v) => db.putCookieJars({ a: [{ name: v } as never] }), async () => (await db.getCookieJars('x')).a[0].name],
  ['sign-ins', (v) => db.putMcpSignIns([{ url: v } as never]), async () => (await db.getMcpSignIns() as unknown as { url: string }[])[0].url],
  ['a synced secrets record', (v) => db.putVaultRecord('s', { last: v }), async () => (await db.getVaultRecord('s'))!.last],
  ['an import, then an edit', (v) => (v === 'older' ? db.putMany({ requests: [{ ...req, auth: auth(v) }] }) : db.putRequest({ ...req, auth: auth(v) })), async () => (await db.listRequests())[0].auth.token],
  ['an edit, then an import', (v) => (v === 'older' ? db.putRequest({ ...req, auth: auth(v) }) : db.putMany({ requests: [{ ...req, auth: auth(v) }] })), async () => (await db.listRequests())[0].auth.token],
  ['a restore, then an edit', (v) => (v === 'older' ? db.replaceAll({ collections: [], folders: [], requests: [{ ...req, auth: auth(v) }], environments: [], globals: [] }) : db.putRequest({ ...req, auth: auth(v) })), async () => (await db.listRequests())[0].auth.token],
]
describe('the newer save stays', () => {
  it.each(saves)('%s', async (_what, save, read) => {
    const slowed = slowFirst()
    await Promise.all([save('older'), save('newer')])
    slowed()
    expect(await read()).toBe('newer')
  })
  it('one changed by apply_records', async () => {
    await db.putRequest(req)
    const slowed = slowFirst()
    await Promise.all([
      db.applyRecords([{ kind: 'request', id: req.id, before: req, after: { ...req, auth: auth('older') } }], []),
      db.putRequest({ ...req, auth: auth('newer') }),
    ])
    slowed()
    expect((await db.listRequests())[0].auth.token).toBe('newer')
  })
})

describe('what was deleted stays deleted', () => {
  const full = { ...req, folderId: folder.id, auth: auth('t') } as RequestDef
  it.each([
    ['a request', () => db.putRequest(full), () => db.deleteRequest(full.id), () => db.listRequests()],
    ['a collection', () => db.putCollection({ ...col, variables: secret('t') }), () => db.deleteCollection(col.id), () => db.listCollections()],
    ['a collection’s request', () => db.putRequest(full), () => db.deleteCollection(col.id), () => db.listRequests()],
    ['a folder’s request', () => db.putRequest(full), () => db.deleteFolders([folder.id]), () => db.listRequests()],
    ['an environment', () => db.putEnvironment({ ...env, variables: secret('t') }), () => db.deleteEnvironment(env.id), () => db.listEnvironments()],
    ['the history', () => db.addHistory({ id: 'h', at: 1, request: full, sent: { method: 'GET', url: 'u', headers: [], body: null, unresolved: [] }, response: null, error: null } as HistoryEntry), () => db.clearHistory(), () => db.listHistory()],
    ['a synced secrets record', () => db.putVaultRecord('s', { last: 'x' }), () => db.putVaultRecord('s', undefined), async () => [await db.getVaultRecord('s')].filter(Boolean)],
    ['a request, by a restore', () => db.putRequest(full), () => db.replaceAll({ collections: [], folders: [], requests: [], environments: [], globals: [] }), () => db.listRequests()],
  ] as [string, () => Promise<unknown>, () => Promise<unknown>, () => Promise<unknown[]>][])('%s', async (_what, save, del, list) => {
    const slowed = slowFirst()
    await Promise.all([save(), del()])
    slowed()
    expect(await list()).toEqual([])
  })
})

it('a save that fails doesn’t stop the ones after it', async () => {
  vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('no'))
  const first = db.putCollection({ ...col, variables: secret('a') })
  const second = db.putCollection({ ...col, variables: secret('b') })
  await expect(first).rejects.toThrow('no')
  await second
  expect((await db.listCollections())[0].variables[0].value).toBe('b')
})
