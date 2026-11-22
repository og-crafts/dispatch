/**
 * Linked folders (desktop): a workspace or a single collection kept as files, for git. The app's own storage stays
 * the working copy; the folder mirrors it. A file changed outside the app since the app last saw it is never
 * overwritten or deleted: it is reported as a conflict until the user picks a side. See
 * docs/DESIGN-linked-workspaces.md.
 */
import { useEffect, useRef, useState } from 'react'
import * as db from '../core/db'
import { type FileEntry, collectionToFiles, filesToCollection, literalSecrets } from '../core/fileFormat'
import { type Incoming, applyIncoming, describeIncoming, fileId, planIncoming, textHash } from '../core/folderMerge'
import { VaultError, applySecrets, canonical, collectSecrets, deriveKeys, openVault, sealVault, vaultHeader, type VaultPayload } from '../core/secretsVault'
import { type WorkspaceContent, filesToWorkspace, reIdTaken, workspaceHeader, workspaceToFiles } from '../core/workspaceFiles'
import { type Collection, DEFAULT_SPACE, type Space, folderIdOf, spaceOf } from '../core/types'
import type { FolderStatus, WorkspaceApi } from './useWorkspace'

const yaml = () => import('yaml')
const dump = async () => { const { stringify } = await yaml(); return (v: unknown) => stringify(v, { lineWidth: 0 }) }

/** The file operations linking needs; the desktop app's are below, tests pass their own. */
export interface FolderApi {
  pick(): Promise<string | null>
  /** Dispatch files under the folder (empty when it doesn't exist). */
  read(root: string): Promise<{ path: string; text: string; hash: string }[]>
  /** Writes `files`, leaving anything changed outside the app alone (`known: null` = overwrite regardless). */
  sync(root: string, files: FileEntry[], known: Record<string, string> | null): Promise<{ known: Record<string, string>; conflicts: string[] }>
  /** The hash `read` and `sync` use for a file's text. */
  hash(text: string): string
  /** Copies of Dispatch files that `read` skips (e.g. `a.req (conflicted copy).yaml`). */
  strays?(root: string): Promise<string[]>
  /** Calls `onChange` when files in these folders change (debounced). Returns a function that stops watching. */
  watch?(roots: string[], onChange: (roots: string[]) => void): Promise<() => void>
  /** The encrypted secrets file (secrets.dispatch-vault), or null. */
  readVault?(root: string): Promise<{ text: string; hash: string } | null>
  /** Writes it (null deletes) only over `known` (its last-seen hash, null = no file); rejects with "changed" otherwise. */
  putVault?(root: string, text: string | null, known: string | null): Promise<string | null>
}

const invoke = async <T,>(cmd: string, args: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(cmd, args)
export const desktopFolders: FolderApi = {
  pick: () => invoke<string | null>('pick_folder', {}),
  read: async (root) => (await invoke<[string, string, string][]>('read_folder', { root })).map(([path, text, hash]) => ({ path, text, hash })),
  sync: (root, files, known) => invoke('sync_folder', { root, files: files.map((f) => [f.path, f.text]), known }),
  hash: textHash,
  strays: (root) => invoke<string[]>('folder_strays', { root }),
  watch: async (roots, onChange) => {
    const { listen } = await import('@tauri-apps/api/event')
    const stop = await listen<string[]>('folder-changed', (e) => onChange(e.payload))
    await invoke('watch_folders', { roots })
    return () => { stop(); void invoke('watch_folders', { roots: [] }) }
  },
  readVault: async (root) => { const r = await invoke<[string, string] | null>('read_vault', { root }); return r ? { text: r[0], hash: r[1] } : null },
  putVault: (root, text, known) => invoke<string | null>('put_vault', { root, text, known }),
}

export const spaceKey = (id: string) => `space:${id}`
export const collectionKey = (id: string) => `collection:${id}`

/** What a linked workspace writes: everything in it except collections that have a folder of their own. */
export function spaceContent(ws: WorkspaceApi, space: Space): WorkspaceContent {
  const collections = ws.allCollections.filter((c) => spaceOf(c) === space.id && !c.linkedDir)
  const ids = new Set(collections.map((c) => c.id))
  return {
    space: { id: folderIdOf(space), name: space.name }, collections,
    folders: ws.folders.filter((f) => ids.has(f.collectionId)), requests: ws.requests.filter((r) => !!r.collectionId && ids.has(r.collectionId)),
    environments: ws.allEnvironments.filter((e) => spaceOf(e) === space.id), flows: ws.allFlows.filter((f) => spaceOf(f) === space.id),
  }
}

/** Writes one linked folder and records what happened. Returns the conflicts. */
async function syncOne(ws: WorkspaceApi, fs: FolderApi, key: string, dir: string, files: FileEntry[], force = false, pulled?: Pulled, vault?: FolderStatus['vault']) {
  const state = force ? 'force' : (await db.getFolderState(key)) ?? {}
  try {
    if (state !== 'force') files = await holdBackRenames(fs, dir, files, state)
    const r = await fs.sync(dir, files, state === 'force' ? null : state)
    await db.putFolderState(key, r.known)
    // Copies and unreadable files are listed on their own, not as conflicts.
    const apart = new Set([...(pulled?.copies ?? []), ...(pulled?.unreadable ?? []).map((u) => u.path)])
    const conflicts = r.conflicts.filter((p) => !apart.has(p))
    ws.setFolderStatus(key, { conflicts, at: Date.now(), ...(pulled && !force ? { copies: pulled.copies, strays: pulled.strays, unreadable: pulled.unreadable } : {}), ...(vault ? { vault } : {}) })
    return conflicts
  } catch (e) {
    ws.setFolderStatus(key, { conflicts: [], error: String(e), at: Date.now() })
    throw e
  }
}


/**
 * A rename writes the item under a new file name and deletes the old file. If the old file changed outside the
 * app, it can't be deleted, and writing the new one would leave two files for one item. Until the user picks a
 * side, such renamed files are not written (the old file is reported as a conflict by the sync).
 */
async function holdBackRenames(fs: FolderApi, dir: string, files: FileEntry[], known: Record<string, string>) {
  const wanted = new Set(files.map((f) => f.path))
  const disk = await fs.read(dir)
  const onDisk = new Set(disk.map((f) => f.path))
  const stuck = new Set(disk.filter((f) => !wanted.has(f.path) && known[f.path] !== f.hash).map((f) => fileId(f.text)).filter(Boolean))
  if (!stuck.size) return files
  return files.filter((f) => onDisk.has(f.path) || !stuck.has(fileId(f.text)))
}

export async function syncSpace(ws: WorkspaceApi, fs: FolderApi, space: Space, force = false) {
  if (!space.linkedDir) return []
  return syncOne(ws, fs, spaceKey(space.id), space.linkedDir, workspaceToFiles(spaceContent(ws, space), await dump()), force)
}
export async function syncCollection(ws: WorkspaceApi, fs: FolderApi, c: Collection, force = false) {
  if (!c.linkedDir) return []
  return syncOne(ws, fs, collectionKey(c.id), c.linkedDir, collectionToFiles(c, ws.folders, ws.requests, await dump()), force)
}

const remember = (files: { path: string; hash: string }[]) => Object.fromEntries(files.map((f) => [f.path, f.hash]))

/** "Use the folder's version": the workspace becomes what the folder holds (after a backup). Returns warnings. */
export async function reloadSpace(ws: WorkspaceApi, fs: FolderApi, space: Space, read?: Awaited<ReturnType<FolderApi['read']>>) {
  if (!space.linkedDir) return []
  const files = read ?? await fs.read(space.linkedDir)
  const r = await readSpaceFiles(ws, space, files)
  await ws.backupNow('before-folder')
  const here = <T extends { workspaceId?: string }>(x: T) => ({ ...x, workspaceId: space.id })
  await ws.replaceSpaceContents(space.id, { ...r, collections: r.collections.map(here), environments: r.environments.map(here), flows: r.flows.map(here) })
  await db.putFolderState(spaceKey(space.id), remember(files))
  ws.setFolderStatus(spaceKey(space.id), { conflicts: [], at: Date.now() })
  return r.warnings
}

/** A workspace folder's files as this workspace's items (secrets and ids from this device's own items). */
async function readSpaceFiles(ws: WorkspaceApi, space: Space, files: FileEntry[]) {
  const { parse } = await yaml()
  // Only this workspace's own items may lend their secrets or keep their ids; another workspace's never move here.
  const cols = ws.allCollections.filter((c) => spaceOf(c) === space.id)
  const colIds = new Set(cols.map((c) => c.id))
  const own = {
    collections: cols, folders: ws.folders.filter((f) => colIds.has(f.collectionId)),
    requests: ws.requests.filter((q) => q.collectionId !== null && colIds.has(q.collectionId)),
    environments: ws.allEnvironments.filter((e) => spaceOf(e) === space.id),
  }
  const mine = new Set([...own.collections, ...own.folders, ...own.requests, ...own.environments, ...ws.allFlows.filter((f) => spaceOf(f) === space.id)].map((x) => x.id))
  const taken = new Set([...ws.allCollections, ...ws.folders, ...ws.requests, ...ws.allEnvironments, ...ws.allFlows].map((x) => x.id).filter((x) => !mine.has(x)))
  const r = reIdTaken(filesToWorkspace(files, parse, own), taken)
  if (r.space.id !== folderIdOf(space)) throw new Error(`That folder now holds a different workspace (“${r.space.name}”).`)
  return r
}

/** "Use the folder's version" for a collection with its own folder. */
export async function reloadCollection(ws: WorkspaceApi, fs: FolderApi, c: Collection) {
  const files = await fs.read(c.linkedDir)
  if (!files.some((f) => f.path === 'dispatch.collection.yaml')) throw new Error(`${c.linkedDir} has no dispatch.collection.yaml.`)
  const { parse } = await yaml()
  const r = filesToCollection(files, parse, { collection: c, folders: ws.folders, requests: ws.requests })
  r.collections[0] = { ...r.collections[0], linkedDir: c.linkedDir, workspaceId: c.workspaceId }
  await ws.replaceCollection(r)
  await db.putFolderState(collectionKey(c.id), remember(files))
  ws.setFolderStatus(collectionKey(c.id), { conflicts: [], at: Date.now() })
  return r
}

/** Opens a collection folder (the ☰ menu): adds or updates that collection and keeps it linked. */
export async function openCollectionFolder(ws: WorkspaceApi, fs: FolderApi, dir: string) {
  const files = await fs.read(dir)
  if (!files.some((f) => f.path === 'dispatch.collection.yaml')) throw new Error(`${dir} has no dispatch.collection.yaml.`)
  const { parse } = await yaml()
  const rootId = (parse(files.find((f) => f.path === 'dispatch.collection.yaml')!.text) as { id?: string } | null)?.id
  const local = ws.allCollections.find((c) => c.id === rootId) ?? null
  const r = filesToCollection(files, parse, { collection: local, folders: ws.folders, requests: ws.requests })
  r.collections[0] = { ...r.collections[0], linkedDir: dir, workspaceId: local?.workspaceId ?? ws.activeSpaceId }
  await ws.replaceCollection(r)
  await db.putFolderState(collectionKey(r.collections[0].id), remember(files))
  return r
}

/** Links a collection to a folder ("Save to a folder…"): writes it there, replacing what the folder had. */
export async function linkCollection(ws: WorkspaceApi, fs: FolderApi, c: Collection, dir: string) {
  await syncOne(ws, fs, collectionKey(c.id), dir, collectionToFiles(c, ws.folders, ws.requests, await dump()), true)
  return literalSecrets(c, ws.folders, ws.requests)
}

type Ask = (message: string) => Promise<boolean>

/**
 * "Link to a folder…" on a workspace. An empty folder gets the workspace written into it. A folder that already
 * holds this workspace (linked before) asks which side wins. Anything else is refused. Returns a message for the user.
 */
export async function linkSpace(ws: WorkspaceApi, fs: FolderApi, space: Space, dir: string, confirm: Ask): Promise<string> {
  const other = ws.spaces.find((x) => x.linkedDir === dir && x.id !== space.id)
  if (other) return `That folder is already linked to the workspace “${other.name}”.`
  const files = await fs.read(dir)
  const { parse } = await yaml()
  const head = workspaceHeader(files, parse)
  if (files.length && !head) return 'That folder holds other Dispatch files (a collection folder?). Pick an empty folder, or a folder this workspace was linked to before.'
  if (head && head.id !== folderIdOf(space)) return `That folder holds the workspace “${head.name}”. Use “Open a workspace folder…” to add it.`
  if (space.id === DEFAULT_SPACE.id && !space.folderId) { space = { ...space, folderId: crypto.randomUUID() }; await ws.setSpaceFolderId(space.id, space.folderId!) }

  const own = ws.allCollections.filter((c) => spaceOf(c) === space.id && c.linkedDir)
  let moved = 0
  if (own.length && await confirm(`${own.length === 1 ? `“${own[0].name}” already has` : `${own.length} collections in this workspace already have`} a folder of its own. Move ${own.length === 1 ? 'it' : 'them'} into the workspace folder? The old folders stay as they are.`)) {
    for (const c of own) { await ws.updateCollection({ ...c, linkedDir: '' }); await db.putFolderState(collectionKey(c.id), undefined); ws.setFolderStatus(collectionKey(c.id), null) }
    moved = own.length
  }
  const linked = { ...space, linkedDir: dir }
  if (head) {
    if (await confirm(`This folder already holds “${head.name}”. Use the folder’s version? (A backup is taken first.) Cancel keeps this workspace’s version and overwrites the files.`)) {
      await ws.setSpaceFolder(space.id, dir)
      const warnings = await reloadSpace(ws, fs, linked, files)
      return `Linked to ${dir} and read the folder.${warnings.length ? ` ${warnings[0]}` : ''}`
    }
    await db.putFolderState(spaceKey(space.id), 'force')
  } else {
    await db.putFolderState(spaceKey(space.id), {})
  }
  await ws.setSpaceFolder(space.id, dir) // the folder sync writes it shortly
  return `Linked to ${dir}. Changes are written there as you work${moved ? `; ${moved} collection${moved > 1 ? 's' : ''} moved in` : ''}. Secret values stay on this device.`
}

/** "Open a workspace folder…": adds the workspace a folder holds (or re-links the one this device has) and opens it. */
export async function openSpaceFolder(ws: WorkspaceApi, fs: FolderApi, dir: string, confirm: Ask): Promise<string> {
  const already = ws.spaces.find((x) => x.linkedDir === dir)
  if (already) { ws.switchSpace(already.id); return `“${already.name}” is already linked to that folder.` }
  const files = await fs.read(dir)
  const { parse } = await yaml()
  const head = workspaceHeader(files, parse)
  if (!head) return 'That folder isn’t a Dispatch workspace folder (it has no dispatch.workspace.yaml).'
  const mine = ws.spaces.find((x) => folderIdOf(x) === head.id)
  if (mine && !await confirm(`You already have this workspace (“${mine.name}”). Link it to this folder and use the folder’s version? A backup is taken first.`)) return 'Nothing changed.'
  const space: Space = { ...(mine ?? head), linkedDir: dir }
  await ws.addSpaceFrom(space)
  await ws.setSpaceFolder(space.id, dir)
  const warnings = await reloadSpace(ws, fs, space, files)
  ws.switchSpace(space.id)
  return `Opened “${space.name}” from ${dir}.${warnings.length ? ` ${warnings.length} note${warnings.length > 1 ? 's' : ''}: ${warnings[0]}` : ''}`
}

export async function unlinkSpace(ws: WorkspaceApi, space: Space) {
  await ws.setSpaceFolder(space.id, undefined)
  await db.putFolderState(spaceKey(space.id), undefined)
  ws.setFolderStatus(spaceKey(space.id), null)
}
export async function unlinkCollection(ws: WorkspaceApi, c: Collection) {
  await ws.updateCollection({ ...c, linkedDir: '' })
  await db.putFolderState(collectionKey(c.id), undefined)
  ws.setFolderStatus(collectionKey(c.id), null)
}

// ---------- Secrets that travel with the folder (opt-in, encrypted; src/core/secretsVault.ts) ----------

/** The secret values of a linked workspace's own items, as the secrets file holds them. */
const spaceSecrets = (ws: WorkspaceApi, space: Space) => { const c = spaceContent(ws, space); return collectSecrets(c.environments, c.collections) }

/** Puts the file's secret values into this device's items (never empties a value the file doesn't mention). */
async function applyVault(ws: WorkspaceApi, space: Space, p: VaultPayload) {
  const c = spaceContent(ws, space)
  const r = applySecrets(p, c.environments, c.collections)
  for (const e of r.environments) await ws.updateEnvironment(e)
  for (const col of r.collections) await ws.updateCollection(col)
  return r.environments.length + r.collections.length
}

/**
 * Keeps the secrets file and this device in step, like the other files: changed only in the folder → taken in;
 * changed only here → written; changed in both → a conflict (nothing overwritten). Without the passphrase on this
 * device it does nothing but say so. A wrong passphrase or a damaged file never touches this device's values.
 */
async function syncVault(ws: WorkspaceApi, fs: FolderApi, space: Space): Promise<FolderStatus['vault']> {
  if (!space.syncSecrets || !space.linkedDir || !fs.readVault || !fs.putVault) return undefined
  const rec = (await db.getVaultRecord(space.id)) ?? {}
  const disk = await fs.readVault(space.linkedDir)
  if (!rec.keys) return { state: 'locked', note: disk ? 'This folder has encrypted secrets. Enter the passphrase to use them on this computer.' : 'Set a passphrase to start syncing secrets.' }
  const mine = canonical(spaceSecrets(ws, space))
  if (disk && disk.hash !== rec.fileHash) {
    let theirs: string
    try { theirs = canonical(await openVault(disk.text, rec.keys)) } catch (e) {
      return { state: e instanceof VaultError && e.kind === 'wrong-passphrase' ? 'locked' : 'error', note: e instanceof Error ? e.message : String(e) }
    }
    if (theirs === mine || rec.last === undefined || mine === rec.last) {
      if (theirs !== mine) await applyVault(ws, space, JSON.parse(theirs) as VaultPayload)
      await db.putVaultRecord(space.id, { ...rec, fileHash: disk.hash, last: theirs })
      return { state: 'ok' }
    }
    return { state: 'conflict', note: 'Secret values changed both on this computer and in the folder.' }
  }
  if (!disk || mine !== rec.last) {
    try {
      const hash = await fs.putVault(space.linkedDir, await sealVault(JSON.parse(mine) as VaultPayload, rec.keys), disk?.hash ?? null)
      await db.putVaultRecord(space.id, { ...rec, fileHash: hash, last: mine })
    } catch (e) {
      if (String(e).includes('changed')) return { state: 'conflict', note: 'The secrets file changed in the folder while Dispatch was writing it.' }
      return { state: 'error', note: String(e) }
    }
  }
  return { state: 'ok' }
}

/**
 * "Sync secrets…": a folder without a secrets file gets one, encrypted with this new passphrase. A folder that
 * already has one is unlocked with it (the passphrase is checked first); its values then come into this device.
 */
export async function turnOnSecrets(ws: WorkspaceApi, fs: FolderApi, space: Space, passphrase: string): Promise<string> {
  if (!space.linkedDir || !fs.readVault) throw new Error('Link the workspace to a folder first.')
  return locked(spaceKey(space.id), async () => {
    const disk = await fs.readVault!(space.linkedDir!)
    let keys
    if (disk) {
      const h = vaultHeader(disk.text)
      if (!h) throw new Error('The secrets file in this folder can’t be read (is it complete?).')
      keys = await deriveKeys(passphrase, h.kdf.salt, Number(h.kdf.iterations))
      await openVault(disk.text, keys) // throws on a wrong passphrase, before anything is kept
    } else keys = await deriveKeys(passphrase)
    await db.putVaultRecord(space.id, { keys })
    await ws.setSpaceSecrets(space.id, true)
    checkFolders()
    return disk ? `Unlocked. “${space.name}” now uses the secrets kept in its folder.` : `Secrets sync is on for “${space.name}”. Other computers need the same passphrase.`
  })
}

/** "Change passphrase…": the file is written again with a new passphrase; other computers ask for it once. */
export async function changePassphrase(ws: WorkspaceApi, fs: FolderApi, space: Space, passphrase: string): Promise<string> {
  if (!space.linkedDir || !fs.readVault || !fs.putVault) throw new Error('Link the workspace to a folder first.')
  return locked(spaceKey(space.id), async () => {
    const disk = await fs.readVault!(space.linkedDir!)
    const keys = await deriveKeys(passphrase)
    const mine = canonical(spaceSecrets(ws, space))
    const hash = await fs.putVault!(space.linkedDir!, await sealVault(JSON.parse(mine) as VaultPayload, keys), disk?.hash ?? null)
    await db.putVaultRecord(space.id, { keys, fileHash: hash, last: mine })
    checkFolders()
    return 'Passphrase changed. Other computers will ask for the new one.'
  })
}

/** "Stop syncing secrets": this computer forgets the passphrase; the file stays in the folder for others. */
export async function stopSecrets(ws: WorkspaceApi, space: Space): Promise<string> {
  await db.putVaultRecord(space.id, undefined)
  await ws.setSpaceSecrets(space.id, false)
  ws.setFolderStatus(spaceKey(space.id), ws.folderStatus[spaceKey(space.id)] ? { ...ws.folderStatus[spaceKey(space.id)], vault: undefined } : null)
  checkFolders()
  return `Secrets sync is off on this computer. ${space.linkedDir ? 'The encrypted file stays in the folder for other computers; delete it there if nobody needs it.' : ''}`
}

/** A conflict on the secrets file: take the folder's values, or write this computer's over them. */
export async function resolveVault(ws: WorkspaceApi, fs: FolderApi, space: Space, side: 'folder' | 'mine'): Promise<string> {
  if (!space.linkedDir || !fs.readVault || !fs.putVault) throw new Error('Link the workspace to a folder first.')
  return locked(spaceKey(space.id), async () => {
    const rec = await db.getVaultRecord(space.id)
    if (!rec?.keys) throw new Error('Enter the passphrase first.')
    const disk = await fs.readVault!(space.linkedDir!)
    if (side === 'folder') {
      if (!disk) throw new Error('The folder has no secrets file any more.')
      const p = await openVault(disk.text, rec.keys)
      await applyVault(ws, space, p)
      await db.putVaultRecord(space.id, { ...rec, fileHash: disk.hash, last: canonical(p) })
      checkFolders()
      return 'Took the secret values from the folder.'
    }
    const mine = canonical(spaceSecrets(ws, space))
    const hash = await fs.putVault!(space.linkedDir!, await sealVault(JSON.parse(mine) as VaultPayload, rec.keys), disk?.hash ?? null)
    await db.putVaultRecord(space.id, { ...rec, fileHash: hash, last: mine })
    checkFolders()
    return 'Wrote this computer’s secret values to the folder.'
  })
}

/** One linked folder: what the app would write there, and how files read from it come into the app. */
interface Job { key: string; dir: string; name: string; files: FileEntry[]; space?: Space; apply(files: FileEntry[], label: string): Promise<void> }

function jobsFor(ws: WorkspaceApi, stringify: (v: unknown) => string): Job[] {
  return [
    ...ws.spaces.filter((x) => x.linkedDir).map((x): Job => ({
      key: spaceKey(x.id), dir: x.linkedDir!, name: x.name, files: workspaceToFiles(spaceContent(ws, x), stringify), space: x,
      apply: async (files, label) => {
        const r = await readSpaceFiles(ws, x, files)
        const here = <T extends { workspaceId?: string }>(i: T) => ({ ...i, workspaceId: x.id })
        await ws.replaceSpaceContents(x.id, { ...r, collections: r.collections.map(here), environments: r.environments.map(here), flows: r.flows.map(here) }, { keepEdits: true, trashLabel: label })
      },
    })),
    ...ws.allCollections.filter((c) => c.linkedDir).map((c): Job => ({
      key: collectionKey(c.id), dir: c.linkedDir, name: c.name, files: collectionToFiles(c, ws.folders, ws.requests, stringify),
      apply: async (files, label) => {
        const { parse } = await yaml()
        if (!files.some((f) => f.path === 'dispatch.collection.yaml')) throw new Error(`${c.linkedDir} no longer has dispatch.collection.yaml.`)
        const r = filesToCollection(files, parse, { collection: c, folders: ws.folders, requests: ws.requests })
        r.collections[0] = { ...r.collections[0], linkedDir: c.linkedDir, workspaceId: c.workspaceId }
        await ws.replaceCollection(r, { keepEdits: true, trashLabel: label })
      },
    })),
  ]
}

/** What a pull found, kept for the folder's status line. */
type Pulled = Pick<Incoming, 'copies' | 'unreadable'> & { strays: string[] }

/** One run at a time per folder: a pull, a write and a "keep mine" must never interleave. */
const chains = new Map<string, Promise<unknown>>()
function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  chains.set(key, next)
  return next
}

/**
 * Brings changes made in the folder (another device, `git pull`, an editor) into the app, before anything is
 * written. Files changed on both sides stay as conflicts. Returns what came in, or null for a folder that is being
 * (re)written from scratch.
 */
async function pullOne(fs: FolderApi, job: Job, take?: Set<string>): Promise<(Pulled & { incoming: Incoming['incoming'] }) | null> {
  const state = await db.getFolderState(job.key)
  if (!state || state === 'force') return null
  const disk = await fs.read(job.dir)
  const { parse } = await yaml()
  const plan = planIncoming(disk, job.files, state, (t) => fs.hash(t), { parse, take })
  const strays = (await fs.strays?.(job.dir).catch(() => [])) ?? []
  if (plan.incoming.length) await job.apply(applyIncoming(job.files, plan.incoming), `what the folder ${job.dir} no longer has`)
  const hashOf = new Map(disk.map((f) => [f.path, f.hash]))
  const known = { ...state }
  for (const f of plan.incoming) { if (f.text === null) delete known[f.path]; else known[f.path] = hashOf.get(f.path)! }
  for (const [p, h] of Object.entries(plan.adopt)) { if (h === null) delete known[p]; else known[p] = h }
  if (plan.incoming.length || Object.keys(plan.adopt).length) await db.putFolderState(job.key, known)
  return { incoming: plan.incoming, copies: plan.copies, unreadable: plan.unreadable, strays }
}

/** Asks every linked folder to check for changes now (after a choice on a conflict, or when the window gets focus). */
export function checkFolders() { globalThis.dispatchEvent?.(new Event('dispatch-check-folders')) }

const jobFor = async (ws: WorkspaceApi, key: string) => {
  const j = jobsFor(ws, await dump()).find((x) => x.key === key)
  if (!j) throw new Error('That folder isn’t linked any more.')
  return j
}

/** "Use the file's version" for one file in conflict (or any file): the folder's copy comes into the app. */
export async function takeFile(ws: WorkspaceApi, fs: FolderApi, key: string, path: string) {
  const job = await jobFor(ws, key)
  await locked(key, () => pullOne(fs, job, new Set([path])))
  checkFolders()
}

/**
 * "Keep mine" for one file: the app's version is written over the folder's (or the file is deleted, when the app
 * doesn't have it; that's also how a copy made by a cloud drive is removed).
 */
export async function keepMineFile(fs: FolderApi, key: string, dir: string, path: string) {
  await locked(key, async () => {
    const state = await db.getFolderState(key)
    if (!state || state === 'force') return
    const disk = (await fs.read(dir)).find((f) => f.path === path)
    const known = { ...state }
    if (disk) known[path] = disk.hash; else delete known[path]
    await db.putFolderState(key, known)
  })
  checkFolders()
}

/** The two versions of one file, for "Show differences": the app's (null when it doesn't have it) and the folder's. */
export async function fileVersions(ws: WorkspaceApi, fs: FolderApi, key: string, path: string, against?: string) {
  const job = await jobFor(ws, key)
  const disk = await fs.read(job.dir)
  const theirs = disk.find((f) => f.path === path)?.text ?? null
  // A copy is compared with the file it copies.
  const mine = against ? (disk.find((f) => f.path === against)?.text ?? null) : (job.files.find((f) => f.path === path)?.text ?? null)
  return { mine, theirs }
}

/** For a copy: the file it is a copy of (same id), if the folder has it. */
export async function originalOf(fs: FolderApi, dir: string, path: string) {
  const disk = await fs.read(dir)
  const id = fileId(disk.find((f) => f.path === path)?.text ?? '')
  return id ? disk.find((f) => f.path !== path && fileId(f.text) === id)?.path ?? null : null
}

/**
 * Keeps every linked folder and the app in step. Before each write it brings in what changed in the folder
 * (applied straight away when the app hasn't changed the same file; a conflict when both did). Runs on start, shortly
 * after every edit, when the folder changes (desktop watcher), when the window gets focus, and on `checkFolders()`.
 */
export function useFolderSync(ws: WorkspaceApi, notify: (m: string) => void, fs: FolderApi = desktopFolders) {
  const last = useRef(new Map<string, string>())
  const [tick, setTick] = useState(0)
  const desktop = !!ws.transport.unrestricted && ws.ready
  const dirs = desktop ? [...new Set([...ws.spaces.map((x) => x.linkedDir), ...ws.allCollections.map((c) => c.linkedDir)].filter((d): d is string => !!d))].sort() : []
  const dirsKey = dirs.join('\n')

  // Checks asked for from outside (watcher, focus, a conflict choice) run every folder again.
  useEffect(() => {
    if (!desktop) return
    const check = () => { last.current.clear(); setTick((t) => t + 1) }
    const onFocus = () => check()
    globalThis.addEventListener?.('dispatch-check-folders', check)
    globalThis.addEventListener?.('focus', onFocus)
    return () => { globalThis.removeEventListener?.('dispatch-check-folders', check); globalThis.removeEventListener?.('focus', onFocus) }
  }, [desktop])

  useEffect(() => {
    if (!desktop || !dirs.length || !fs.watch) return
    let stop: (() => void) | null = null, gone = false
    fs.watch(dirs, () => checkFolders()).then((s) => { if (gone) s(); else stop = s }).catch(() => { /* still checked on start and focus */ })
    return () => { gone = true; stop?.() }
  }, [desktop, dirsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!desktop || !dirs.length) return
    const t = setTimeout(() => {
      void (async () => {
        const jobs = jobsFor(ws, await dump())
        for (const j of jobs) {
          // Secret values aren't in the files; with secrets sync on, a changed secret must still trigger a run.
          const sig = `${j.dir}\n${JSON.stringify(j.files)}${j.space?.syncSecrets ? `\n${canonical(spaceSecrets(ws, j.space))}` : ''}`
          if (last.current.get(j.key) === sig) continue
          const before = ws.folderStatus[j.key]?.conflicts.length ?? 0
          try {
            const r = await locked(j.key, async () => {
              const pulled = await pullOne(fs, j)
              // What came in changes the app; the next run (after it re-renders) writes the folder.
              if (pulled?.incoming.length) return { pulled, conflicts: null }
              const vault = j.space ? await syncVault(ws, fs, j.space).catch((e): FolderStatus['vault'] => ({ state: 'error', note: String(e) })) : undefined
              return { pulled, conflicts: await syncOne(ws, fs, j.key, j.dir, j.files, false, pulled ?? undefined, vault) }
            })
            if (r.pulled?.incoming.length) { notify(`Updated from ${j.dir}: ${describeIncoming(r.pulled.incoming)}.`); continue }
            last.current.set(j.key, sig)
            const conflicts = r.conflicts ?? []
            if (conflicts.length && conflicts.length !== before) notify(`${conflicts.length} file${conflicts.length > 1 ? 's' : ''} in ${j.dir} changed both there and in Dispatch, so neither was overwritten. Choose which version to keep on ${j.key.startsWith('space:') ? 'the Workspaces page' : `the “${j.name}” collection page`}.`)
          } catch (e) { notify(`Couldn’t keep ${j.name} in step with ${j.dir}: ${String(e)}`) }
        }
      })()
    }, 800)
    return () => clearTimeout(t)
  }, [ws.ready, tick, ws.spaces, ws.allCollections, ws.folders, ws.requests, ws.allEnvironments, ws.allFlows]) // eslint-disable-line react-hooks/exhaustive-deps
}
