/**
 * The clean copy: what the model may see of the workspace. `clean` redacts a text, `deep` a whole record (values by the
 * name they sit under, secret-marked values always). Built from every secret Dispatch knows, not only the open workspace's.
 */
import type { McpServeOptions } from '../mcpHandler'
import { Redactor } from '../mcpLogs'
import { HIDDEN } from '../mcpWorkspace'
import type { ToolContext } from './gate'
import { allSecrets } from './tools'

export function cleaner(ctx: ToolContext, w: McpServeOptions): { clean(s: string): string; deep<T>(v: T): T } {
  const history = ctx.conn.readLogs ? w.logs?.history() ?? [] : []
  const redact = new Redactor([
    ...ctx.secrets(),
    ...allSecrets({
      environments: [...w.ws.environments, ...(w.environment ? [w.environment] : [])], globals: w.globals, collections: w.ws.collections, folders: w.ws.folders,
      requests: w.ws.requests, history,
      connections: [ctx.conn], signIns: [], cookies: [], clientCerts: w.settings.clientCerts, hostToken: w.settings.mcpHostToken,
    }),
  ])
  const clean = (s: string) => redact.clean(s)
  const deep = <T>(v: T, key = ''): T => {
    if (typeof v === 'string') return (/^(id|kind|method)$|Id$/.test(key) ? v : clean(v)) as T
    if (Array.isArray(v)) {
      const header = key === 'headers' && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string'
      return (header ? [clean(v[0]), redact.named(v[0], v[1])] : v.map((x) => deep(x, key))) as T
    }
    if (!v || typeof v !== 'object') return v
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, k)]))
    const item = v as { key?: unknown; value?: unknown; secret?: unknown; options?: { value: string }[] }
    if (typeof item.key === 'string' && typeof item.value === 'string') {
      // the name as it really is decides, so before it is cleaned itself
      const show = (x: string) => (item.secret && x ? HIDDEN : redact.named(item.key as string, x))
      out.value = show(item.value)
      if (item.options) out.options = item.options.map((x) => ({ ...deep(x), value: show(x.value) }))
    }
    return out as T
  }
  return { clean, deep: (v) => deep(v) }
}
