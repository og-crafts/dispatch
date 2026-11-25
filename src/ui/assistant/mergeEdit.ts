import type { Connection } from '../../core/assistant/connections'
import { AssistantError } from '../../core/assistant/providers/shared'
import { originOf } from './binding'

/** Puts what the dialog changed (from `initial` to `edited`) onto the connection as it is saved now. */
export function mergeEdit(now: Connection[], initial: Connection, edited: Connection): Connection[] {
  const cur = now.find((c) => c.id === initial.id)
  if (!cur) throw new AssistantError('This connection was removed meanwhile. Close this and add it again.')
  // a key typed here was meant for the address seen here
  if (originOf(cur.baseUrl) !== originOf(initial.baseUrl)) throw new AssistantError('This connection’s address was changed meanwhile. Close this and open it again.')
  const next = { ...cur } as Record<string, unknown>, from = initial as unknown as Record<string, unknown>, to = edited as unknown as Record<string, unknown>
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (from[k] === to[k]) continue
    if (to[k] === undefined) delete next[k]
    else next[k] = to[k]
  }
  const out = next as unknown as Connection
  const moved = originOf(out.baseUrl) !== originOf(cur.baseUrl)
  if (moved) { out.key = edited.key; delete out.keyLost } // a newer key was for the old address
  if (moved || (out.readLogs && !cur.readLogs)) delete out.consentHost // the yes was for the old address, or without the console
  if (moved || out.model !== cur.model) out.tools = 'unknown'
  return now.map((c) => (c.id === out.id ? out : c))
}
