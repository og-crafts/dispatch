/**
 * The clean copy: what the model may see of the workspace. `clean` redacts a text, `deep` a whole record (values by the
 * name they sit under, secret-marked values always). Built from every secret Dispatch knows, not only the open workspace's.
 */
import type { McpServeOptions } from '../mcpHandler'
import { Redactor } from '../mcpLogs'
import { HIDDEN } from '../mcpWorkspace'
import type { ToolContext } from './gate'
import { allSecrets } from './tools'

type From = Pick<ToolContext, 'conn' | 'secrets'>

/** Every secret known now. */
export function secretsNow(ctx: From, w: McpServeOptions): string[] {
  return [
    ...ctx.secrets(),
    ...allSecrets({
      environments: [...w.ws.environments, ...(w.environment ? [w.environment] : [])], globals: w.globals, collections: w.ws.collections, folders: w.ws.folders,
      requests: w.ws.requests, history: ctx.conn.readLogs ? w.logs?.history() ?? [] : [],
      connections: [ctx.conn], signIns: [], cookies: [], clientCerts: w.settings.clientCerts, hostToken: w.settings.mcpHostToken,
    }),
  ]
}

/** `also`: secrets that may not be known any more, such as those from before a change. */
export function cleaner(ctx: From, w: McpServeOptions, also: string[] = []): { clean(s: string): string; deep<T>(v: T): T } {
  const redact = new Redactor([...secretsNow(ctx, w), ...also])
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
