/**
 * The MCP tools Dispatch offers to AI assistants: list_requests, send_request, run_collection, and run_flow when
 * there are flows, and get_request; with the assistant's own workspace on (desktop), also create/update/copy/move/
 * delete_request and set_variables there, and in the open workspace when the user lets assistants edit it
 * (mcpWorkspace.ts). Transport-free (one JSON-RPC message in, one reply out), so the same handler serves
 * `dispatch-run mcp` over stdio and the desktop app's local MCP endpoint over HTTP.
 */
import type { ImportResult } from './backup'
import type { Collection, Environment, KV, RequestDef, Settings } from './types'
import type { Transport } from './transport'
import { type Execution, type Pipeline, type RunContext, execute, sendOptions } from './runtime'
import { collectItems, failed, runCollection, type RunItem, type RunSummary } from './runner'
import { type Flow, type FlowRun, runFlow } from './flows'
import type { ScriptEngine } from './scriptPipeline'
import { knownSecrets, LOG_TOOL_NAMES, logCall, logTools, type McpLogSource, Redactor } from './mcpLogs'
import { ASSISTANT_PREFIX, AUTH_SECRETS, type AssistantWorkspace, describeRequest, getRequestTool, hideInText, INBOX, WORKSPACE_TOOL_NAMES, workspaceCall, workspaceTools } from './mcpWorkspace'

export interface McpServeOptions {
  ws: ImportResult
  environment: Environment | null
  globals: KV[]
  settings: Settings
  transport: Transport
  pipeline: Pipeline
  /** Methods the assistant may send; empty = all. */
  allowMethods: string[]
  version: string
  /** Runs If/Script blocks in flows. */
  engine?: ScriptEngine
  /** Serve every collection in `ws` (names become the first path segment); otherwise only the first. */
  allCollections?: boolean
  /** The assistant's own workspace, where it may write (paths "assistant/…"). Needs allCollections. */
  workspace?: AssistantWorkspace
  /** Read-only console, history and environments (Settings → AI assistants; mcpLogs.ts). */
  logs?: McpLogSource
  /** The desktop app saves what a send or run changed (variables set by scripts, refreshed tokens). */
  hooks?: {
    /** `request` is what was sent; the desktop app adds it to History. */
    afterSend?: (x: Execution, ctx: RunContext, request?: RequestDef) => Promise<void>
    afterRun?: (s: RunSummary) => Promise<void>
    runFlow?: (f: Flow) => Promise<FlowRun>
  }
}

const BODY_LIMIT = 20_000

export function mcpTools(flowNames: string[] = [], multi = false, ownWorkspace = false, editable?: string, envNames?: string[]) {
  return [
    {
      name: 'list_requests',
      description: `List the saved requests${multi ? ' in every collection' : ' in this collection'}: their names, folders, methods and URLs (with {{variables}}).${ownWorkspace ? ` Paths starting with "assistant/" are in your own workspace, where you can create, change and delete; ${editable ? `the rest are in the user\u2019s workspace \u201c${editable}\u201d, which they let you edit too` : 'the rest are the user\u2019s, which you can only send'}. Requests marked \u201chanded to you\u201d are ones the user gave you to review and file.` : ''}`,
      inputSchema: { type: 'object', properties: {} },
    },
    getRequestTool(),
    {
      name: 'send_request',
      description: 'Send one saved request (with its auth, scripts and tests) and return the status, headers, body and test results.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: multi ? 'The path from list_requests, like "Collection/Folder/Request", or just the request name when it is unique.' : 'The request name, or "Folder/Sub/Request" when names repeat.' },
          variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for {{variables}}, overriding the environment for this call.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'run_collection',
      description: `Run every request in ${multi ? 'a collection' : 'the collection'} (or one folder) in order, with tests, and return a summary with any failures.`,
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: multi ? 'A collection, or a folder path like "Collection/Orders/Admin".' : 'A folder path like "Orders/Admin"; leave out for the whole collection.' },
          data: { type: 'array', items: { type: 'object' }, description: 'Optional data rows: one run per row, the keys become {{variables}}.' },
        },
        ...(multi ? { required: ['folder'] } : {}),
      },
    },
    ...(flowNames.length ? [{
      name: 'run_flow',
      description: `Run a flow (requests chained with conditions and loops) and return each step. Flows: ${flowNames.join(', ')}.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', enum: flowNames, description: 'The flow to run.' } }, required: ['name'] },
    }] : []),
    ...(ownWorkspace ? workspaceTools(editable) : []),
    ...(envNames ? logTools(envNames) : []),
  ]
}

/** What the tools can find, and by which paths (the ones list_requests shows). */
export function finder(o: Pick<McpServeOptions, 'ws' | 'allCollections' | 'workspace'>) {
  const cols: Collection[] = o.allCollections ? o.ws.collections : o.ws.collections.slice(0, 1)
  const multi = !!o.allCollections
  const col = cols[0]
  const own = multi && o.workspace ? o.workspace.collections : []
  const ownIds = new Set(own.map((c) => c.id))
  const items = (): RunItem[] => [...cols, ...own].flatMap((c) => collectItems(c, null, o.ws.folders, o.ws.requests))
  const pathOf = (it: RunItem) => (ownIds.has(it.request.collectionId ?? '') ? ASSISTANT_PREFIX : '') + [...it.path.split(' / ').slice(multi ? 0 : 1), it.request.name].join('/')
  const colOf = (it: RunItem) => [...cols, ...own].find((c) => c.id === it.request.collectionId) ?? col
  /** A request by the path list_requests shows, or by its name when that is unique. */
  const lookup = (want: string): { it: RunItem; path: string } | { error: string } => {
    const all = items()
    const named = all.filter((x) => x.request.name === want)
    const exact = all.filter((x) => pathOf(x) === want)
    // A user collection named "assistant" can give two requests the same path: say so rather than pick one.
    if (exact.length > 1) return { error: `“${want}” names a request in your own workspace and one in the user’s collection “assistant”; ask the user to rename one of them.` }
    const it = exact[0] ?? (named.length === 1 || !multi ? named[0] : undefined)
    if (!it) return { error: named.length > 1 ? `Several requests are named “${want}”: ${named.map(pathOf).join(', ')}. Use the full path.` : `No request named “${want}”. Use list_requests.` }
    return { it, path: pathOf(it) }
  }
  return { cols, multi, col, own, items, pathOf, colOf, lookup }
}

/** Handles one JSON-RPC message; returns the reply (or null for notifications). */
export async function handleMcp(msg: any, o: McpServeOptions): Promise<any | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  const text = (t: string, isError = false) => reply({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })
  if (msg.id === undefined) return null
  const { cols, multi, col, own, items, pathOf, colOf, lookup } = finder(o)
  /** Hides secrets in what goes back: every one Dispatch knows, plus any this send or run just made. */
  const redactor = (fresh: { vars?: (KV[] | null | undefined)[]; auth?: object } = {}) => new Redactor([
    ...knownSecrets({
      environments: [...o.ws.environments, ...(o.environment ? [o.environment] : [])], globals: [...o.globals, ...(fresh.vars ?? []).flatMap((v) => v ?? [])],
      collections: [...o.ws.collections, ...own], folders: o.ws.folders, requests: o.ws.requests, extra: [o.settings.mcpHostToken],
    }),
    ...Object.entries(fresh.auth ?? {}).flatMap(([k, v]) => (typeof v === 'string' && AUTH_SECRETS.has(k) ? [v] : [])),
  ])
  const canFlow = !!(o.engine || o.hooks?.runFlow)
  const editable = multi ? o.workspace?.editable?.name : undefined
  let handedList: RunItem[] | null = null
  const handed = () => (handedList ??= items().filter((it) => it.request.handoff))
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'dispatch', version: o.version },
        instructions: `${multi ? `Requests from Dispatch (collections: ${cols.map((c) => `“${c.name}”`).join(', ') || 'none'})` : `Requests from the Dispatch collection “${col?.name ?? '(none)'}”`}${o.environment ? ` with environment “${o.environment.name}”` : ''}. Use list_requests to see what's there, and get_request to look at one in full.${o.logs ? ' To see what happened, use get_logs (the console), list_history and get_history_entry (sends and their responses), and get_environment.' : ''}${multi && o.workspace ? ` You also have your own workspace (paths starting with "assistant/") where you can create, change, copy, move and delete requests; ${editable ? `you may also change the user\u2019s workspace \u201c${editable}\u201d (paths without a prefix), and the user\u2019s other requests can only be listed and sent` : 'the user\u2019s requests can only be listed and sent, and the user moves what they want to keep'}.${handed().length ? ` The user handed you ${handed().length} request${handed().length > 1 ? 's' : ''} in assistant/${INBOX} to review: look at each with get_request, fix it, and file it with move_request.` : ''}` : ''}`,
      })
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools: mcpTools(canFlow ? (o.ws.flows ?? []).map((f) => f.name) : [], multi, !!(multi && o.workspace), editable, o.logs ? o.ws.environments.map((e) => e.name) : undefined) })
    case 'tools/call': {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      if (name === 'list_requests') {
        const list = items().map((it) => `${it.request.method.padEnd(6)} ${pathOf(it)}  ${hideInText(it.request.url)}${it.request.handoff ? `  ← handed to you${it.request.handoff.note ? `: ${hideInText(it.request.handoff.note)}` : ''}` : ''}`)
        const n = handed().length
        const head = n ? `The user handed you ${n} request${n > 1 ? 's' : ''} to review (marked below): get_request, fix, then move_request to file ${n > 1 ? 'them' : 'it'}.\n\n` : ''
        return text(list.length ? head + list.join('\n') : 'No requests.')
      }
      if (name === 'get_request') {
        const found = lookup(String(args.name ?? ''))
        if ('error' in found) return text(found.error, true)
        return text(describeRequest(found, { allCollections: [...cols, ...own], folders: o.ws.folders }))
      }
      if (name === 'send_request') {
        const found = lookup(String(args.name ?? ''))
        if ('error' in found) return text(found.error, true)
        const { it } = found
        if (o.allowMethods.length && !o.allowMethods.includes(it.request.method)) return text(`${it.request.method} requests aren’t allowed here (allowed: ${o.allowMethods.join(', ')}).`, true)
        const locals = new Map(Object.entries(args.variables ?? {}).map(([k, v]) => [k, String(v)]))
        const ctx: RunContext = { collection: colOf(it), folders: o.ws.folders, environment: o.environment, globals: o.globals, locals }
        const x = await execute(it.request, ctx, o.transport, sendOptions(it.request, o.settings), o.pipeline)
        await o.hooks?.afterSend?.(x, ctx, it.request)
        const R = redactor({ vars: [x.changes.environment, x.changes.collection, x.changes.globals], auth: x.authUpdate?.patch })
        if (x.error && !x.response) return text(`Not sent: ${R.text(x.error)}`, true)
        const r = x.response!
        // Hidden before it is cut, so no secret is left half shown at the cut.
        const full = r.binary ? `(binary, ${r.size} bytes)` : R.text(r.body)
        const body = full.length > BODY_LIMIT ? `${full.slice(0, BODY_LIMIT)}\n… (cut at ${BODY_LIMIT} characters)` : full
        const tests = x.tests.length ? `\n\nTests:\n${x.tests.map((t) => `${t.passed ? '✓' : '✗'} ${R.text(t.name)}${t.error ? ` — ${R.text(t.error)}` : ''}`).join('\n')}` : ''
        return text(`${x.sent.method} ${R.text(x.sent.url)}\n→ ${r.status} ${r.statusText} (${r.timeMs} ms)\n${r.headers.map(([k, v]) => `${k}: ${R.header(k, v)}`).join('\n')}\n\n${body}${tests}`, r.status >= 400 || x.tests.some((t) => !t.passed))
      }
      if (name === 'run_collection') {
        let list = items()
        if (args.folder) {
          const prefix = `${String(args.folder).replace(/^\/|\/$/g, '')}/`
          list = list.filter((x) => pathOf(x).startsWith(prefix))
          if (!list.length) return text(`No ${multi ? 'collection or folder' : 'folder'} “${args.folder}”.`, true)
        } else if (multi) return text('Name a collection (or a folder in one) to run.', true)
        if (o.allowMethods.length) {
          const blocked = list.filter((x) => !o.allowMethods.includes(x.request.method))
          if (blocked.length) return text(`This run includes ${blocked.map((b) => `${b.request.method} ${b.request.name}`).join(', ')}, which aren’t allowed here.`, true)
        }
        const data = Array.isArray(args.data) ? args.data.map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))) : null
        const s = await runCollection({ items: list, iterations: data ? 0 : 1, data, delayMs: 0, stopOnFailure: false, environment: o.environment, collections: o.ws.collections, folders: o.ws.folders, globals: o.globals, settings: o.settings }, o.transport, o.pipeline)
        await o.hooks?.afterRun?.(s)
        const bad = s.results.filter(failed)
        const R = redactor({ vars: [s.finalEnvironment, s.finalGlobals, ...Object.values(s.finalCollections)] })
        return text([
          `${s.requests} requests in ${s.iterations} iteration(s): ${s.testsPassed} tests passed, ${s.testsFailed} failed, ${s.failedRequests} errors, avg ${s.avgTimeMs} ms.`,
          ...bad.slice(0, 20).map((r) => `✗ ${r.name}: ${R.text(r.error || r.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error ?? 'failed'}`).join('; '))}`),
        ].join('\n'), bad.length > 0)
      }
      if (name === 'run_flow' && canFlow) {
        const f = (o.ws.flows ?? []).find((x) => x.name === args.name)
        if (!f) return text(`No flow named “${args.name}”.`, true)
        if (o.allowMethods.length) {
          const blocked = f.nodes.flatMap((n) => (n.type === 'request' ? o.ws.requests.filter((r) => r.id === n.config.requestId && !o.allowMethods.includes(r.method)) : []))
          if (blocked.length) return text(`This flow sends ${blocked.map((b) => `${b.method} ${b.name}`).join(', ')}, which aren’t allowed here.`, true)
        }
        const r = o.hooks?.runFlow
          ? await o.hooks.runFlow(f)
          : await runFlow(f, { collections: o.ws.collections, folders: o.ws.folders, requests: o.ws.requests, environment: o.environment, globals: o.globals, settings: o.settings }, o.transport, o.pipeline, o.engine!)
        const R = redactor({ vars: [r.environment, r.globals, ...Object.values(r.collections)] })
        return text([
          `${r.ok ? 'Passed' : `Failed: ${R.text(String(r.error))}`} (${r.steps.length} steps, ${r.durationMs} ms)`,
          ...r.steps.filter((x) => x.status !== 'running').slice(0, 100).map((x) => `${x.status === 'ok' ? '✓' : x.status === 'failed' ? '✗' : '·'} ${x.label}${x.status_code !== undefined ? ` ${x.status_code}` : ''}${x.port ? ` → ${x.port}` : ''} ${R.text(String(x.detail ?? ''))}`),
        ].join('\n'), !r.ok)
      }
      if (LOG_TOOL_NAMES.includes(name) && o.logs) {
        const shown = [...cols, ...own]
        const redact = new Redactor(knownSecrets({
          environments: o.ws.environments, globals: o.globals, collections: shown, folders: o.ws.folders, requests: o.ws.requests,
          extra: [o.settings.mcpHostToken],
        }))
        const [t, isError] = logCall(name, args, { src: o.logs, redact, environment: o.environment, environments: o.ws.environments, collectionIds: new Set(shown.map((c) => c.id)) })
        return text(t, isError)
      }
      if (WORKSPACE_TOOL_NAMES.includes(name) && multi && o.workspace) {
        const [t, isError] = await workspaceCall(name, args, { w: o.workspace, folders: o.ws.folders, requests: o.ws.requests, allCollections: [...cols, ...own], allowMethods: o.allowMethods, lookup })
        return text(t, isError)
      }
      return fail(-32602, `Unknown tool ${name}`)
    }
    default: return fail(-32601, `Method not found: ${msg.method}`)
  }
}
