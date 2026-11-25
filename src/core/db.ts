import type { StoredCookie } from './cookies'
import type { Collection, Environment, Folder, HistoryEntry, KV, RequestDef, Settings } from './types'
import type { Change } from './assistant/proposal'
import { defaultSettings, normalizeCollection, normalizeFolder, normalizeRequest } from './types'
import { resetVaultForTests, secretsOf, seal, unseal, vaultKey } from './vault'

/** Everything lives in this device's IndexedDB; nothing is sent anywhere except the requests you send. */
const NAME = 'dispatch'
const VERSION = 4
export const HISTORY_LIMIT = 200
let opening: Promise<IDBDatabase> | null = null

export function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION)
    req.onupgradeneeded = (ev) => {
      const db = req.result
      // v1: the first stores. v2: folders. Old records are upgraded when read (normalize*).
      if (ev.oldVersion < 1) {
        db.createObjectStore('requests', { keyPath: 'id' })
        db.createObjectStore('collections', { keyPath: 'id' })
        db.createObjectStore('environments', { keyPath: 'id' })
        db.createObjectStore('history', { keyPath: 'id' }).createIndex('at', 'at')
        db.createObjectStore('meta')
      }
      if (ev.oldVersion < 2) db.createObjectStore('folders', { keyPath: 'id' })
      if (ev.oldVersion < 3) db.createObjectStore('backups', { keyPath: 'id' }).createIndex('at', 'at')
      if (ev.oldVersion < 4) db.createObjectStore('flows', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return opening
}

/** For tests: forget the open connection and delete the database. */
export async function resetForTests() {
  if (opening) (await opening).close()
  opening = null
  resetVaultForTests()
  await new Promise<void>((res) => { const r = indexedDB.deleteDatabase(NAME); r.onsuccess = r.onerror = r.onblocked = () => res() })
}

const wrap = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error) })
async function all<T>(store: string): Promise<T[]> { const db = await open(); return wrap<T[]>(db.transaction(store).objectStore(store).getAll()) }
async function put(store: string, v: unknown, key?: string) { const db = await open(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(v, key); await done(t) }
async function del(store: string, key: string) { const db = await open(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); await done(t) }

// Secrets are sealed on the way in and unsealed on the way out (see vault.ts).
const key = () => vaultKey({
  get: async () => { const db = await open(); return wrap(db.transaction('meta').objectStore('meta').get('vaultKey')) },
  set: (v) => put('meta', v, 'vaultKey'),
})
const sealer = async () => { const k = await key(); return (s: string) => seal(k, s) }
const unsealer = async () => { const k = await key(); return (s: string) => unseal(k, s) }

export const listRequests = async () => { const f = await unsealer(); return Promise.all((await all<RequestDef>('requests')).map((r) => secretsOf.request(normalizeRequest(r), f))) }
export const listCollections = async () => { const f = await unsealer(); return Promise.all((await all<Collection>('collections')).map((c) => secretsOf.collection(normalizeCollection(c), f))) }
export const listFolders = async () => { const f = await unsealer(); return Promise.all((await all<Folder>('folders')).map((x) => secretsOf.folder(normalizeFolder(x), f))) }
export const listEnvironments = async () => { const f = await unsealer(); return Promise.all((await all<Environment>('environments')).map((e) => secretsOf.environment(e, f))) }
/** Record writes that have started and not finished: sealing takes a moment, so a later write could overtake them. */
const writing = new Set<Promise<unknown>>()
function inFlight<A extends unknown[], T>(write: (...a: A) => Promise<T>) {
  return (...a: A): Promise<T> => {
    const p = write(...a)
    const end = () => { writing.delete(p) }
    writing.add(p); p.then(end, end)
    return p
  }
}
export const putFolder = inFlight(async (x: Folder) => put('folders', await secretsOf.folder(x, await sealer())))
export const putRequest = inFlight(async (r: RequestDef) => put('requests', await secretsOf.request(r, await sealer())))
export const putCollection = inFlight(async (c: Collection) => put('collections', await secretsOf.collection(c, await sealer())))
export const putEnvironment = inFlight(async (e: Environment) => put('environments', await secretsOf.environment(e, await sealer())))
export const deleteRequest = (id: string) => del('requests', id)
export const deleteEnvironment = (id: string) => del('environments', id)

/** Deletes a collection and every request saved in it. */
export async function deleteCollection(id: string) {
  const db = await open()
  const t = db.transaction(['collections', 'requests', 'folders'], 'readwrite')
  t.objectStore('collections').delete(id)
  deleteWhere(t.objectStore('folders'), (f: Folder) => f.collectionId === id)
  deleteWhere(t.objectStore('requests'), (r: RequestDef) => r.collectionId === id)
  await done(t)
}

function deleteWhere<T>(store: IDBObjectStore, test: (v: T) => boolean) {
  const cursor = store.openCursor()
  cursor.onsuccess = () => {
    const c = cursor.result
    if (!c) return
    if (test(c.value as T)) c.delete()
    c.continue()
  }
}

/** Deletes folders (a folder and its subfolders) and the requests in them. */
export async function deleteFolders(ids: string[]) {
  const set = new Set(ids)
  const db = await open()
  const t = db.transaction(['folders', 'requests'], 'readwrite')
  ids.forEach((id) => t.objectStore('folders').delete(id))
  deleteWhere(t.objectStore('requests'), (r: RequestDef) => !!r.folderId && set.has(r.folderId))
  await done(t)
}

/** Global variables (available in every request). */
export async function getGlobals(): Promise<KV[]> {
  const db = await open()
  return secretsOf.globals((await wrap<KV[] | undefined>(db.transaction('meta').objectStore('meta').get('globals'))) ?? [], await unsealer())
}
export const putGlobals = inFlight(async (g: KV[]) => put('meta', await secretsOf.globals(g, await sealer()), 'globals'))

/**
 * Writes and removes records in one transaction: all of them or none. Everything is sealed first (waiting would end the
 * transaction), and writes that started earlier are let finish, so none of them lands on top. `check` runs right before
 * the transaction, in the same moment; what it throws stops it.
 */
export async function applyRecords(puts: Change[], deletes: Change[], check: () => void = () => {}): Promise<void> {
  const f = await sealer()
  const sealed = await Promise.all(puts.map((c): Promise<unknown> => {
    if (c.kind === 'globals') return secretsOf.globals(c.after as KV[], f)
    return (secretsOf[c.kind] as (r: unknown, f: (s: string) => Promise<string>) => Promise<unknown>)(c.after, f)
  }))
  const stores = { collection: 'collections', folder: 'folders', request: 'requests', environment: 'environments', globals: 'meta' } as const
  const names = [...new Set([...puts, ...deletes].map((c) => stores[c.kind]))]
  if (!names.length) return
  const db = await open()
  while (writing.size) await Promise.allSettled([...writing])
  check()
  const t = db.transaction(names, 'readwrite')
  const finished = done(t)
  try {
    puts.forEach((c, i) => { const s = t.objectStore(stores[c.kind]); if (c.kind === 'globals') s.put(sealed[i], 'globals'); else s.put(sealed[i]) })
    deletes.forEach((c) => t.objectStore(stores[c.kind]).delete(c.id))
  } catch (e) { finished.catch(() => {}); t.abort(); throw e }
  await finished
}

/** Small UI state kept between sessions (open tabs...). */
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await open()
  return wrap<T | undefined>(db.transaction('meta').objectStore('meta').get(key))
}
export const putMeta = (key: string, v: unknown) => put('meta', v, key)

/** Newest first. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const f = await unsealer()
  return Promise.all((await all<HistoryEntry>('history')).sort((a, b) => b.at - a.at).map((h) => secretsOf.history(h, f)))
}

/** Adds an entry and trims history to the newest HISTORY_LIMIT entries. */
export async function addHistory(plain: HistoryEntry) {
  const e = await secretsOf.history(plain, await sealer())
  const db = await open()
  const t = db.transaction('history', 'readwrite')
  const store = t.objectStore('history')
  store.put(e)
  const keys = await wrap(store.index('at').getAllKeys())
  const extra = keys.length - HISTORY_LIMIT
  for (let i = 0; i < extra; i++) store.delete(keys[i])
  await done(t)
}

export async function clearHistory() {
  const db = await open(); const t = db.transaction('history', 'readwrite'); t.objectStore('history').clear(); await done(t)
}

export async function getSettings(): Promise<Settings> {
  const db = await open()
  const s = { ...defaultSettings, ...await wrap<Settings | undefined>(db.transaction('meta').objectStore('meta').get('settings')) }
  const f = await unsealer()
  return { ...s, mcpHostToken: s.mcpHostToken ? await f(s.mcpHostToken) : '', clientCerts: await Promise.all((s.clientCerts ?? []).map(async (c) => ({ ...c, key: await f(c.key) }))) }
}
/** Client-certificate private keys and the MCP endpoint token are sealed like other secrets. */
export async function putSettings(s: Settings) {
  const f = await sealer()
  await put('meta', { ...s, mcpHostToken: s.mcpHostToken ? await f(s.mcpHostToken) : '', clientCerts: await Promise.all(s.clientCerts.map(async (c) => ({ ...c, key: await f(c.key) }))) }, 'settings')
}

/**
 * The cookie jars (desktop), by environment, sealed as a whole: cookies are often session secrets. Versions up to 0.1
 * kept one list for the whole app; it becomes the jar named by `legacyKey`.
 */
export async function getCookieJars(legacyKey: string): Promise<Record<string, StoredCookie[]>> {
  const read = async (key: string): Promise<unknown> => {
    const sealed = await getMeta<string>(key)
    if (!sealed) return undefined
    try { return JSON.parse(await (await unsealer())(sealed)) } catch { return null }
  }
  const jars = await read('cookieJars')
  if (jars !== undefined) return jars && typeof jars === 'object' ? jars as Record<string, StoredCookie[]> : {}
  const old = await read('cookies')
  return Array.isArray(old) && old.length ? { [legacyKey]: old as StoredCookie[] } : {}
}
/** The old list stays a list (an empty one), so going back to an older version still starts. */
export async function putCookieJars(jars: Record<string, StoredCookie[]>) {
  const f = await sealer()
  await put('meta', await f(JSON.stringify(jars)), 'cookieJars')
  if (await getMeta('cookies')) await put('meta', await f('[]'), 'cookies')
}
export async function putLegacyCookiesForTests(list: StoredCookie[]) { await put('meta', await (await sealer())(JSON.stringify(list)), 'cookies') }

/** Writes a whole workspace (imports) in one transaction. */
async function putManyNow(plain: { collections?: Collection[]; folders?: Folder[]; requests?: RequestDef[]; environments?: Environment[]; flows?: Flow[]; spaces?: Space[] }) {
  if (plain.flows?.length) for (const f of plain.flows) await putFlow(f)
  const f = await sealer()
  const data = {
    collections: plain.collections && await Promise.all(plain.collections.map((c) => secretsOf.collection(c, f))),
    folders: plain.folders && await Promise.all(plain.folders.map((x) => secretsOf.folder(x, f))),
    requests: plain.requests && await Promise.all(plain.requests.map((r) => secretsOf.request(r, f))),
    environments: plain.environments && await Promise.all(plain.environments.map((e) => secretsOf.environment(e, f))),
  }
  const db = await open()
  const t = db.transaction(['collections', 'folders', 'requests', 'environments', ...(plain.spaces ? ['meta'] : [])], 'readwrite')
  const finished = done(t)
  try {
    data.folders?.forEach((f) => t.objectStore('folders').put(f))
    data.collections?.forEach((c) => t.objectStore('collections').put(c))
    data.requests?.forEach((r) => t.objectStore('requests').put(r))
    data.environments?.forEach((e) => t.objectStore('environments').put(e))
    if (plain.spaces) t.objectStore('meta').put(plain.spaces, 'spaces')
  } catch (e) { finished.catch(() => {}); t.abort(); throw e }
  await finished
}

export const putMany = inFlight(putManyNow)

/** Open tabs (drafts included), with their secrets sealed like saved requests. */
export async function putOpenTabs(drafts: RequestDef[], active: number, spaces?: (string | null)[]) {
  const f = await sealer()
  await put('meta', { tabs: await Promise.all(drafts.map((d) => secretsOf.request(d, f))), active, spaces }, 'tabs')
}
/** `spaces[i]` is the workspace tab i belongs to (missing in data saved before workspaces had their own tabs). */
export async function getOpenTabs(): Promise<{ tabs: RequestDef[]; active: number; spaces?: (string | null)[] } | undefined> {
  const saved = await getMeta<{ tabs: RequestDef[]; active: number; spaces?: (string | null)[] }>('tabs')
  if (!saved?.tabs) return saved
  const f = await unsealer()
  return { ...saved, tabs: await Promise.all(saved.tabs.map((d) => secretsOf.request(normalizeRequest(d), f))) }
}

// ---------- local backups ----------

export interface BackupData { collections: Collection[]; folders: Folder[]; requests: RequestDef[]; environments: Environment[]; globals: KV[]; flows?: Flow[] }
export interface BackupInfo { id: string; at: number; reason: 'daily' | 'manual' | 'before-restore' | 'before-folder'; counts: { collections: number; requests: number; environments: number } }
export const BACKUP_KEEP = 10

/** Saves a snapshot of everything (secrets stay sealed) and keeps the newest BACKUP_KEEP. */
export async function addBackup(plain: BackupData, reason: BackupInfo['reason']): Promise<BackupInfo> {
  const f = await sealer()
  const data: BackupData = {
    collections: await Promise.all(plain.collections.map((c) => secretsOf.collection(c, f))),
    folders: await Promise.all(plain.folders.map((x) => secretsOf.folder(x, f))),
    requests: await Promise.all(plain.requests.map((r) => secretsOf.request(r, f))),
    environments: await Promise.all(plain.environments.map((e) => secretsOf.environment(e, f))),
    globals: await secretsOf.globals(plain.globals, f),
    flows: plain.flows ?? [],
  }
  const info: BackupInfo = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), reason,
    counts: { collections: data.collections.length, requests: data.requests.length, environments: data.environments.length } }
  const db = await open()
  const t = db.transaction('backups', 'readwrite')
  const store = t.objectStore('backups')
  store.put({ ...info, data })
  const keys = await wrap(store.index('at').getAllKeys())
  for (let i = 0; i < keys.length - BACKUP_KEEP; i++) store.delete(keys[i])
  await done(t)
  return info
}

export async function listBackups(): Promise<BackupInfo[]> {
  return (await all<BackupInfo & { data: unknown }>('backups')).map(({ data: _d, ...i }) => i).sort((a, b) => b.at - a.at)
}

export async function getBackup(id: string): Promise<BackupData | null> {
  const db = await open()
  const b = await wrap<{ data: BackupData } | undefined>(db.transaction('backups').objectStore('backups').get(id))
  if (!b) return null
  const f = await unsealer()
  return {
    collections: await Promise.all(b.data.collections.map((c) => secretsOf.collection(normalizeCollection(c), f))),
    folders: await Promise.all(b.data.folders.map((x) => secretsOf.folder(normalizeFolder(x), f))),
    requests: await Promise.all(b.data.requests.map((r) => secretsOf.request(normalizeRequest(r), f))),
    environments: await Promise.all(b.data.environments.map((e) => secretsOf.environment(e, f))),
    globals: await secretsOf.globals(b.data.globals ?? [], f),
    flows: b.data.flows ?? [],
  }
}

/** Replaces the whole workspace with `data` in one transaction. */
export async function replaceAll(data: BackupData) {
  const f = await sealer()
  const sealed = {
    collections: await Promise.all(data.collections.map((c) => secretsOf.collection(c, f))),
    folders: await Promise.all(data.folders.map((x) => secretsOf.folder(x, f))),
    requests: await Promise.all(data.requests.map((r) => secretsOf.request(r, f))),
    environments: await Promise.all(data.environments.map((e) => secretsOf.environment(e, f))),
    globals: await secretsOf.globals(data.globals, f),
  }
  const db = await open()
  const t = db.transaction(['collections', 'folders', 'requests', 'environments', 'meta', 'flows'], 'readwrite')
  for (const s of ['collections', 'folders', 'requests', 'environments'] as const) {
    t.objectStore(s).clear()
    for (const x of sealed[s]) t.objectStore(s).put(x)
  }
  t.objectStore('meta').put(sealed.globals, 'globals')
  if (data.flows) { t.objectStore('flows').clear(); for (const x of data.flows) t.objectStore('flows').put(x) }
  await done(t)
}

// ---------- schedules ----------
import type { Schedule, ScheduleRun } from './schedules'
export const getSchedules = async () => (await getMeta<Schedule[]>('schedules')) ?? []
export const putSchedules = (s: Schedule[]) => put('meta', s, 'schedules')
export const getScheduleRuns = async () => (await getMeta<ScheduleRun[]>('scheduleRuns')) ?? []
export const putScheduleRuns = (r: ScheduleRun[]) => put('meta', r, 'scheduleRuns')

// ---------- workspaces ----------
import { DEFAULT_SPACE, type Space } from './types'
export const getSpaces = async (): Promise<Space[]> => { const s = await getMeta<Space[]>('spaces'); return s?.length ? s : [DEFAULT_SPACE] }
export const putSpaces = (s: Space[]) => put('meta', s, 'spaces')

/**
 * Linked folders: the hash of each file as the app last wrote or read it (path → hash), so it can tell its own
 * files from ones changed outside it. 'force' means the next write overwrites ("keep mine"). Keyed by
 * `space:<id>` or `collection:<id>`.
 */
/**
 * What this device keeps for a workspace's synced secrets file (src/core/secretsVault.ts): the keys made from the
 * passphrase, the file's hash as last seen and the secrets as last synced. Sealed with the device key, like every
 * other secret at rest.
 */
export interface VaultRecord { keys?: import('./secretsVault').VaultKeys; fileHash?: string | null; last?: string }
export async function getVaultRecord(spaceId: string): Promise<VaultRecord | undefined> {
  const v = await getMeta<string>(`secretsVault:${spaceId}`)
  if (!v) return undefined
  try { return JSON.parse(await unseal(await key(), v)) as VaultRecord } catch { return undefined }
}
export async function putVaultRecord(spaceId: string, rec: VaultRecord | undefined) {
  await put('meta', rec ? await seal(await key(), JSON.stringify(rec)) : undefined, `secretsVault:${spaceId}`)
}
export type FolderState = Record<string, string> | 'force'
export const getFolderState = (key: string) => getMeta<FolderState>(`folder:${key}`)
export const putFolderState = (key: string, v: FolderState | undefined) => put('meta', v, `folder:${key}`)

// ---------- flows ----------
import type { Flow } from './flows'
export const listFlows = () => all<Flow>('flows')
export const putFlow = (f: Flow) => put('flows', f)
export const deleteFlow = (id: string) => del('flows', id)

// ---------- MCP sign-ins (tokens; sealed, never exported) ----------
import type { McpSignIn } from './mcpAuth'
export async function getMcpSignIns(): Promise<McpSignIn[]> {
  const sealedList = await getMeta<string>('mcpSignIns')
  if (!sealedList) return []
  try { return JSON.parse(await (await unsealer())(sealedList)) } catch { return [] }
}
export async function putMcpSignIns(list: McpSignIn[]) { await put('meta', await (await sealer())(JSON.stringify(list)), 'mcpSignIns') }

// ---------- assistant connections (keys sealed like other secrets, never exported) ----------
import { normalizeConnection, type Connection } from './assistant/connections'
const CONNECTIONS = 'assistantConnections'
export async function getConnections(): Promise<Connection[]> {
  const stored = await getMeta<unknown[]>(CONNECTIONS)
  if (!Array.isArray(stored)) return []
  const f = await unsealer()
  const out: Connection[] = []
  for (const x of stored) {
    if (!x || typeof x !== 'object') continue
    const c = x as Connection
    if (c.kind !== 'anthropic' && c.kind !== 'openai' && c.kind !== 'compatible') continue
    if (typeof c.id !== 'string' || typeof c.baseUrl !== 'string') continue
    const key = typeof c.key === 'string' ? await f(c.key) : ''
    // A saved key that won't open (another device's key) reads as '' and is flagged; it is never sent blank as if set.
    const { keyLost: _drop, ...rest } = c
    out.push(normalizeConnection({ ...rest, key, ...(c.key && !key ? { keyLost: true as const } : {}) }))
  }
  return out
}
export async function putConnections(list: Connection[]) {
  const f = await sealer()
  const stored = await getMeta<unknown[]>(CONNECTIONS)
  const old = new Map<string, string>()
  if (Array.isArray(stored)) for (const x of stored) { const o = x as Connection | null; if (o && typeof o.id === 'string' && typeof o.key === 'string' && o.key) old.set(o.id, o.key) }
  await put('meta', await Promise.all(list.map(async ({ keyLost, ...c }) => ({
    ...c,
    // An unreadable key keeps its stored ciphertext until a key is set or removed on purpose.
    key: keyLost && !c.key ? (old.get(c.id) ?? '') : await f(c.key),
  }))), CONNECTIONS)
}

// ---------- assistant chats (one sealed record per chat; this device only, never exported or backed up) ----------
const CHAT_INDEX = 'assistantChatIndex'
const chatKey = (id: string) => `assistantChat:${id}`
/** What can be listed without opening any chat: ids, workspace and time are not secret; the title and messages are sealed. */
export interface ChatIndexEntry { id: string; spaceId: string; updatedAt: number }
export const sealText = async (s: string) => (await sealer())(s)
export const unsealText = async (s: string) => (await unsealer())(s)
async function readIndex(store: IDBObjectStore): Promise<ChatIndexEntry[]> {
  const v = await wrap<unknown>(store.get(CHAT_INDEX))
  if (!Array.isArray(v)) return []
  // A bad time reads as the oldest, so the record stays findable (and is the first to go), never orphaned.
  return v.filter((e): e is ChatIndexEntry => !!e && typeof (e as ChatIndexEntry).id === 'string' && typeof (e as ChatIndexEntry).spaceId === 'string')
    .map((e) => ({ id: e.id, spaceId: e.spaceId, updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : 0 }))
}
export const getChatIndex = async (): Promise<ChatIndexEntry[]> => { const db = await open(); return readIndex(db.transaction('meta').objectStore('meta')) }
export const getChatRecord = (id: string) => getMeta<string>(chatKey(id))
const CHAT_KEYS = IDBKeyRange.bound('assistantChat:', 'assistantChat:\uffff')
/**
 * Stores one sealed chat and trims the workspace to `keep` newest, in one transaction (the text is sealed before,
 * since sealing is async). Returns whether the chat is stored afterwards: false when the workspace no longer exists
 * (so a late save can't bring chats back), the id belongs to another workspace, or it is older than the `keep` kept.
 */
export async function putChatRecord(entry: ChatIndexEntry, sealed: string, keep: number): Promise<boolean> {
  const db = await open()
  const t = db.transaction('meta', 'readwrite')
  const store = t.objectStore('meta')
  try {
    const spaces = await wrap<Space[] | undefined>(store.get('spaces'))
    const known = entry.spaceId === DEFAULT_SPACE.id || (Array.isArray(spaces) && spaces.some((x) => x.id === entry.spaceId))
    const all = await readIndex(store)
    if (!known || all.some((e) => e.id === entry.id && e.spaceId !== entry.spaceId)) { t.abort(); await done(t).catch(() => {}); return false }
    entry = { ...entry, updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0 }
    const index = all.filter((e) => e.id !== entry.id)
    index.push(entry)
    store.put(sealed, chatKey(entry.id))
    const mine = index.filter((e) => e.spaceId === entry.spaceId).sort((a, b) => b.updatedAt - a.updatedAt)
    const drop = new Set(mine.slice(keep).map((e) => e.id))
    drop.forEach((id) => store.delete(chatKey(id)))
    store.put(index.filter((e) => !drop.has(e.id)), CHAT_INDEX)
    await done(t)
    return !drop.has(entry.id)
  } catch (e) { try { t.abort() } catch { /* already finished */ } throw e }
}
/**
 * Removes chats the test picks, whether or not their records can be read. With `everything`, every chat key is
 * removed by a key-range scan too, so a damaged index can't leave records behind.
 */
export async function removeChatRecords(test: (e: ChatIndexEntry) => boolean, everything = false) {
  const db = await open()
  const t = db.transaction('meta', 'readwrite')
  const store = t.objectStore('meta')
  const index = await readIndex(store)
  if (everything) { store.delete(CHAT_KEYS); store.put([], CHAT_INDEX) } else {
    for (const e of index) if (test(e)) store.delete(chatKey(e.id))
    store.put(index.filter((e) => !test(e)), CHAT_INDEX)
  }
  await done(t)
}
/** Removes chats whose workspace is no longer listed. Does nothing when the list can't be read. */
export async function removeChatsOfMissingSpaces() {
  const db = await open()
  const t = db.transaction('meta', 'readwrite')
  const store = t.objectStore('meta')
  const spaces = await wrap<unknown>(store.get('spaces'))
  if (!Array.isArray(spaces) || !spaces.length || !spaces.every((x) => x && typeof (x as Space).id === 'string')) { await done(t); return }
  const ids = new Set([DEFAULT_SPACE.id, ...(spaces as Space[]).map((x) => x.id)])
  const index = await readIndex(store)
  const gone = index.filter((e) => !ids.has(e.spaceId))
  if (gone.length) { gone.forEach((e) => store.delete(chatKey(e.id))); store.put(index.filter((e) => ids.has(e.spaceId)), CHAT_INDEX) }
  await done(t)
}
