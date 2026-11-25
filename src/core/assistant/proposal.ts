/**
 * What an edit by the chat looks like before anything is written: the records as they were and would be, what the card
 * draws, and how to tell "the same record" apart from "changed meanwhile". Nothing here writes or sends.
 */
import type { Collection, Environment, Folder, KV, RequestDef } from '../types'

export type Kind = 'collection' | 'folder' | 'request' | 'environment' | 'globals'
export type Rec = Collection | Folder | RequestDef | Environment | KV[]
/** before null: created; after null: deleted. Globals: id 'globals', the record is KV[]. */
export interface Change { kind: Kind; id: string; before: Rec | null; after: Rec | null }
export interface Line { type: 'same' | 'add' | 'del' | 'gap'; text: string }
/** What the card draws. */
export interface Field { label: string; lines: Line[] }
export interface Proposal {
  id: string; spaceId: string; tool: string; cls: 'edit' | 'delete'
  title: string; fields: Field[]; warnings: string[]; changes: Change[]
  /** The tool's reply, given to the model only when it was applied. */
  reply: string
  /** What the preview rests on besides its records (basisOf): only for comparing, it holds real values. */
  basis: string
}
export type ApplyResult = { ok: true } | { ok: false; reason: 'changed' | 'unsaved' | 'gone' | 'failed'; text: string }

/** Keys sorted at every depth, so the order records were built in doesn't matter. */
const sorted = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sorted)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sorted(x)]))
}

/** Records without updatedAt, keys in order: equal strings mean the same record. */
export function canonical(r: Rec | null): string {
  if (r && !Array.isArray(r)) { const { updatedAt: _, ...rest } = r as unknown as Record<string, unknown>; return JSON.stringify(sorted(rest)) }
  return JSON.stringify(sorted(r))
}
