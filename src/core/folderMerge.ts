/**
 * Linked folders, phase 2 (docs/DESIGN-linked-workspaces.md): what to do with files that changed in the folder.
 * Every file is compared three ways: what the folder holds now, what the app would write, and what the app last saw
 * there (`known`, a hash per path). Nothing here touches the disk or the app; it only decides.
 *
 *   folder = last seen                 nothing came in (the app may still have changes to write)
 *   folder = what the app would write  both sides agree; remember it
 *   app    = last seen                 changed only in the folder: take it into the app
 *   otherwise                          changed on both sides: a conflict, nothing is overwritten
 */
import type { FileEntry } from './fileFormat'

/** FNV-1a 64 of the text's UTF-8 bytes, as 16 hex digits. Must match `text_hash` in src-tauri/src/lib.rs. */
export function textHash(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const b of new TextEncoder().encode(text)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn }
  return h.toString(16).padStart(16, '0')
}

/** An item file's own id (its top-level `id:` line). */
export const fileId = (text: string) => /^id: *["']?([^"'\n]+?)["']?\s*$/m.exec(text)?.[1]

/**
 * Copies that cloud drives and sync tools make of a file that changed in two places, or that a person makes in a
 * file manager: `a (Laptop's conflicted copy).req.yaml`, `a.sync-conflict-….req.yaml`, `a - Copy.req.yaml`,
 * `a (1).req.yaml`. Read as items, they would quietly add duplicates.
 */
export function isCopyName(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return /conflicted copy|sync-conflict|\s-\s?copy\b|\bcopy of\b|\s\(\d+\)\./i.test(name)
}

export interface DiskFile { path: string; text: string; hash: string }

export interface Incoming {
  /** Files to take into the app: their text, or null when the folder no longer has them. */
  incoming: { path: string; text: string | null }[]
  /** Paths where the folder and the app already agree: the new "last seen" (null = gone on both sides). */
  adopt: Record<string, string | null>
  /** Changed in the folder and in the app since the app last saw it. */
  conflicts: string[]
  /** Files that are copies of another file in the folder (by name, or a new file with another file's id). */
  copies: string[]
  /** Files that changed in the folder but can't be read (e.g. git conflict markers). */
  unreadable: { path: string; error: string }[]
}

/**
 * Decides what came in from the folder. `take` forces paths to come in even when the app changed them too ("use the
 * file's version" on a conflict). `parse` is the YAML reader; a file that fails it is reported, not taken.
 */
export function planIncoming(disk: DiskFile[], app: FileEntry[], known: Record<string, string>, hash: (text: string) => string,
  opts: { parse: (text: string) => unknown; take?: Set<string> }): Incoming {
  const out: Incoming = { incoming: [], adopt: {}, conflicts: [], copies: [], unreadable: [] }
  const appText = new Map(app.map((f) => [f.path, f.text]))
  // A new file that carries the id of a file the folder already had is a copy (a renamed file's old name is gone).
  const oldIds = new Map<string, string>()
  for (const f of disk) { const id = known[f.path] !== undefined ? fileId(f.text) : undefined; if (id) oldIds.set(id, f.path) }
  const onDisk = new Map<string, DiskFile>()
  for (const f of disk) {
    const isNew = known[f.path] === undefined && !appText.has(f.path)
    const id = isNew ? fileId(f.text) : undefined
    if (isCopyName(f.path) || (id && oldIds.has(id) && oldIds.get(id) !== f.path)) out.copies.push(f.path)
    else onDisk.set(f.path, f)
  }
  const paths = [...new Set([...onDisk.keys(), ...appText.keys(), ...Object.keys(known)])].filter((p) => !out.copies.includes(p)).sort()
  for (const p of paths) {
    const d = onDisk.get(p), k = known[p], text = appText.get(p)
    const a = text === undefined ? undefined : hash(text)
    if (opts.take?.has(p)) { out.incoming.push({ path: p, text: d?.text ?? null }); continue }
    if (d?.hash === k) continue
    if (d?.hash === a) { out.adopt[p] = d?.hash ?? null; continue }
    if (a === k) out.incoming.push({ path: p, text: d?.text ?? null })
    else out.conflicts.push(p)
  }
  // Files that can't be read stay out of the app (and are never overwritten) until they can be read again.
  const readable = (path: string, text: string) => {
    try { opts.parse(text); return true } catch (e) { out.unreadable.push({ path, error: e instanceof Error ? e.message.split('\n')[0] : String(e) }); return false }
  }
  out.incoming = out.incoming.filter((f) => f.text === null || readable(f.path, f.text))
  out.conflicts = out.conflicts.filter((p) => { const d = onDisk.get(p); return !d || readable(p, d.text) })
  out.copies.sort()
  return out
}

/** The app's files with the incoming ones applied (added, replaced or removed). */
export function applyIncoming(app: FileEntry[], incoming: Incoming['incoming']): FileEntry[] {
  const m = new Map(app.map((f) => [f.path, f.text]))
  for (const f of incoming) { if (f.text === null) m.delete(f.path); else m.set(f.path, f.text) }
  return [...m].map(([path, text]) => ({ path, text }))
}

/** "Updated from the folder: 2 requests, 1 flow" — what the incoming files were. */
export function describeIncoming(incoming: Incoming['incoming']): string {
  const n = { request: 0, environment: 0, flow: 0, other: 0 }
  for (const f of incoming) {
    if (f.path.endsWith('.req.yaml')) n.request++
    else if (f.path.endsWith('.env.yaml')) n.environment++
    else if (f.path.endsWith('.flow.yaml')) n.flow++
    else n.other++
  }
  const parts = [[n.request, 'request'], [n.environment, 'environment'], [n.flow, 'flow'], [n.other, 'other file']]
    .filter(([c]) => c).map(([c, w]) => `${c} ${w}${c === 1 ? '' : 's'}`)
  return parts.join(', ')
}
