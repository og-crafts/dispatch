/**
 * MCP tools that let an AI assistant see what happened, read-only: the console (script output, network lines, runs,
 * MCP calls), the send history with responses, and the environments. Turned on separately in Settings → AI
 * assistants ("Let them read the console, history and environments").
 *
 * Everything shown goes through `Redactor`: the pattern hiding get_request uses (URL passwords, JWTs, auth-scheme
 * values, secret-named fields), plus every secret value Dispatch knows (secret or secret-named variables, auth fields,
 * sensitive headers, the MCP token), wherever it appears, e.g. a script that logged a token.
 */
import { AUTH_SECRETS, HIDDEN, hide, hideInText } from './mcpWorkspace'
import { SECRET_NAME } from './share'
import type { Collection, Environment, Folder, HistoryEntry, KV, LogLine, RequestDef } from './types'

export const LOG_TOOL_NAMES = ['get_logs', 'list_history', 'get_history_entry', 'get_environment']

/** What the log tools read; the desktop app passes live getters. */
export interface McpLogSource {
  logs: () => LogLine[]
  /** Newest first, as the app keeps it. */
  history: () => HistoryEntry[]
}

const LOG_MAX = 500
const HISTORY_MAX = 100
const BODY_LIMIT = 20_000
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i
const IS_VAR = /^\s*\{\{[^{}]+\}\}\s*$/

export function logTools(envNames: string[]) {
  return [
    {
      name: 'get_logs',
      description: 'Read Dispatch’s console: script output (console.log), network lines, collection and flow run summaries, and your own MCP calls, oldest first. Secret values show as <hidden>.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: `How many of the newest lines (default 100, at most ${LOG_MAX}).` },
          level: { type: 'string', enum: ['error', 'warn', 'info', 'log'], description: 'Only this level and worse (error < warn < info < log).' },
          source: { type: 'string', description: 'Only lines from this source, e.g. "script", "network", "flow", "mcp".' },
          contains: { type: 'string', description: 'Only lines containing this text (case-insensitive).' },
        },
      },
    },
    {
      name: 'list_history',
      description: 'List recent sends (by the user or by you) from the open workspace, newest first: id, time, method, URL, status or error, time taken and test results. Use get_history_entry for one in full.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: `How many (default 20, at most ${HISTORY_MAX}).` },
          failed: { type: 'boolean', description: 'Only sends that errored, got a 4xx/5xx status, or failed a test.' },
          request: { type: 'string', description: 'Only requests whose name contains this text (case-insensitive).' },
        },
      },
    },
    {
      name: 'get_history_entry',
      description: 'One send from list_history in full: what was sent (URL, headers, body) and what came back (status, headers, body, tests, error). Secret values show as <hidden>.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id list_history shows (its first 8 characters are enough).' } }, required: ['id'] },
    },
    {
      name: 'get_environment',
      description: `Show an environment’s variables (secret values as <hidden>), and which environment is active.${envNames.length ? ` Environments: ${envNames.join(', ')}.` : ''}`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The environment; leave out for the active one.' } } },
    },
  ]
}

/** Hides secret-looking patterns and every known secret value. */
export class Redactor {
  private values: string[]
  constructor(values: Iterable<string>) {
    // Longest first, so a value that contains another is hidden whole.
    this.values = [...new Set([...values].map((v) => v.trim()).filter((v) => v.length >= 6 && !IS_VAR.test(v)))].sort((a, b) => b.length - a.length)
  }
  text(s: string): string {
    let out = hideInText(s)
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(HIDDEN)
    return out
  }
}

/** Every secret value in what the assistant may see, for `Redactor`. */
export function knownSecrets(x: { environments: Environment[]; globals: KV[]; collections: Collection[]; folders: Folder[]; requests: RequestDef[]; extra?: string[] }): string[] {
  const out: string[] = [...(x.extra ?? [])]
  const vars = (list: KV[]) => { for (const v of list) if (v.value && (v.secret || SECRET_NAME.test(v.key))) out.push(v.value, ...(v.options ?? []).map((o) => o.value)) }
  const auth = (a: object | undefined) => {
    for (const [k, v] of Object.entries(a ?? {})) if (typeof v === 'string' && v && AUTH_SECRETS.has(k)) out.push(v)
  }
  const headers = (hs: KV[]) => {
    for (const h of hs) if (h.value && (SENSITIVE_HEADER.test(h.key) || SECRET_NAME.test(h.key))) out.push(h.value, h.value.replace(/^(Bearer|Basic|Digest|Token)\s+/i, ''))
  }
  for (const e of x.environments) vars(e.variables)
  vars(x.globals)
  for (const c of x.collections) { vars(c.variables); auth(c.auth) }
  for (const f of x.folders) auth(f.auth)
  for (const r of x.requests) { auth(r.auth); headers(r.headers); vars(r.handoff?.variables ?? []) }
  return out
}

export interface LogCallContext {
  src: McpLogSource
  redact: Redactor
  environment: Environment | null
  environments: Environment[]
  /** Collections the assistant can see; history from other workspaces stays out. */
  collectionIds: Set<string>
}

const LEVELS: LogLine['level'][] = ['error', 'warn', 'info', 'log']
const clamp = (n: unknown, def: number, max: number) => Math.max(1, Math.min(max, Math.floor(Number(n) || def)))
const time = (at: number) => new Date(at).toISOString().replace('T', ' ').slice(0, 19)
const cut = (s: string) => (s.length > BODY_LIMIT ? `${s.slice(0, BODY_LIMIT)}\n… (cut at ${BODY_LIMIT} characters)` : s)
const failedEntry = (h: HistoryEntry) => !!h.error || !h.response || h.response.status >= 400 || !!h.tests?.some((t) => !t.passed)

/** Runs one of LOG_TOOL_NAMES. Returns the reply text and whether it failed. */
export function logCall(name: string, args: any, x: LogCallContext): [string, boolean] {
  const R = (s: string) => x.redact.text(s)

  if (name === 'get_logs') {
    let lines = x.src.logs()
    if (args.level) {
      const worst = LEVELS.indexOf(args.level)
      if (worst < 0) return [`level must be one of ${LEVELS.join(', ')}.`, true]
      lines = lines.filter((l) => LEVELS.indexOf(l.level) <= worst)
    }
    if (args.source) lines = lines.filter((l) => (l.source ?? '') === String(args.source))
    if (args.contains) { const q = String(args.contains).toLowerCase(); lines = lines.filter((l) => l.text.toLowerCase().includes(q)) }
    const total = lines.length
    lines = lines.slice(-clamp(args.limit, 100, LOG_MAX))
    if (!lines.length) return [total ? 'No lines match.' : 'The console is empty.', false]
    const head = total > lines.length ? `Last ${lines.length} of ${total} lines (UTC):\n` : `${lines.length} line${lines.length > 1 ? 's' : ''} (UTC):\n`
    return [head + lines.map((l) => `${time(l.at)} ${l.level.padEnd(5)} ${l.source ? `[${l.source}] ` : ''}${R(l.text)}`).join('\n'), false]
  }

  const visible = () => x.src.history().filter((h) => !h.request.collectionId || x.collectionIds.has(h.request.collectionId))

  if (name === 'list_history') {
    let list = visible()
    if (args.failed === true) list = list.filter(failedEntry)
    if (args.request) { const q = String(args.request).toLowerCase(); list = list.filter((h) => h.request.name.toLowerCase().includes(q)) }
    list = list.slice(0, clamp(args.limit, 20, HISTORY_MAX))
    if (!list.length) return ['No sends match.', false]
    return [`${list.length} send${list.length > 1 ? 's' : ''}, newest first (UTC):\n` + list.map((h) => {
      const what = h.response ? `${h.response.status} ${h.response.statusText} (${h.response.timeMs} ms)` : `error: ${R(h.error ?? 'no response')}`
      const tests = h.tests?.length ? `, tests ${h.tests.filter((t) => t.passed).length}/${h.tests.length} passed` : ''
      return `${h.id.slice(0, 8)}  ${time(h.at)}  ${h.sent.method} ${R(h.sent.url)}  “${h.request.name}” → ${what}${tests}`
    }).join('\n'), false]
  }

  if (name === 'get_history_entry') {
    const id = String(args.id ?? '').trim()
    if (!id) return ['Give the id from list_history.', true]
    const hits = visible().filter((h) => h.id.startsWith(id))
    if (!hits.length) return [`No send “${id}” in the open workspace’s history. Use list_history.`, true]
    if (hits.length > 1) return [`“${id}” matches ${hits.length} sends; give more of the id.`, true]
    const h = hits[0]
    const hdr = (k: string, v: string) => `  ${k}: ${SENSITIVE_HEADER.test(k) ? hide('authorization', v) : R(hide(k, v))}`
    const lines = [
      `“${h.request.name}” sent ${time(h.at)} UTC`,
      `${h.sent.method} ${R(h.sent.url)}`,
      h.sent.headers.length ? `Request headers:\n${h.sent.headers.map(([k, v]) => hdr(k, v)).join('\n')}` : 'Request headers: none',
    ]
    if (h.sent.body) lines.push(`Request body:\n${R(cut(h.sent.body))}`)
    if (h.sent.unresolved.length) lines.push(`Unresolved variables: ${h.sent.unresolved.map((v) => `{{${v}}}`).join(', ')}`)
    if (h.error) lines.push(`Error: ${R(h.error)}`)
    if (h.response) {
      const r = h.response
      lines.push(`→ ${r.status} ${r.statusText} (${r.timeMs} ms, ${r.size} bytes)`)
      lines.push(r.headers.length ? `Response headers:\n${r.headers.map(([k, v]) => hdr(k, v)).join('\n')}` : 'Response headers: none')
      lines.push(r.binary ? `Response body: binary, ${r.size} bytes` : `Response body:\n${R(cut(r.body))}`)
    }
    if (h.tests?.length) lines.push(`Tests:\n${h.tests.map((t) => `  ${t.passed ? '✓' : '✗'} ${t.name}${t.error ? ` — ${R(t.error)}` : ''}`).join('\n')}`)
    return [lines.join('\n'), false]
  }

  if (name === 'get_environment') {
    const names = x.environments.map((e) => `${e.name}${e.id === x.environment?.id ? ' (active)' : ''}`)
    const e = args.name ? x.environments.find((y) => y.name === String(args.name)) : x.environment
    if (!e) return [args.name ? `No environment “${args.name}”. Environments: ${names.join(', ') || 'none'}.` : `No environment is active. Environments: ${names.join(', ') || 'none'}.`, !!args.name]
    const vars = e.variables.filter((v) => v.key.trim())
    const show = (v: KV) => (v.secret ? HIDDEN : R(hide(v.key, v.value)))
    return [[
      `Environment “${e.name}”${e.id === x.environment?.id ? ' (active)' : ''}. All: ${names.join(', ')}.`,
      vars.length ? vars.map((v) => `  ${v.enabled ? '' : '(off) '}${v.key} = ${show(v)}`).join('\n') : '  No variables.',
    ].join('\n'), false]
  }

  return [`Unknown tool ${name}`, true]
}
