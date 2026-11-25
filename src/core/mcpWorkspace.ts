/**
 * The assistant's own workspace. With it on (desktop Settings), MCP assistants can create, change, copy, move and
 * delete requests in the "AI assistant" workspace, and also in the open workspace when the user ticked "AI
 * assistants can edit" for it (Workspaces page). Every other workspace stays list-and-send only, and the user moves
 * what they want to keep (collection menu → Move to …).
 * Paths in the assistant workspace start with "assistant/", like "assistant/Orders/Admin/Create order"; paths in
 * the user's workspace have no prefix ("Orders/Admin/Create order").
 *
 * The user can also hand a request to the assistant (request menu → Hand to AI assistant…): a copy lands in
 * "assistant/Inbox" with their note (RequestDef.handoff). list_requests flags it; the assistant reviews it with
 * get_request, fixes it with update_request / set_variables and files it with move_request, which clears the flag.
 */
import { effectiveAuth } from './prepare'
import { folderChain } from './runtime'
import type { RunItem } from './runner'
import { SECRET_NAME } from './share'
import {
  ASSISTANT_SPACE, type Auth, type BodyKind, type Scripts, type Collection, type Folder, type KV, METHODS, type RequestDef,
  kv, newCollection, newFolder, newRequest, uid,
} from './types'
import { paramsFromUrl } from './url'

export const ASSISTANT_PREFIX = 'assistant/'
/** Where requests the user hands over land, in the assistant workspace. */
export const INBOX = 'Inbox'
/** Shown instead of a secret value; never accepted back. */
export const HIDDEN = '<hidden>'
const BODY_KINDS: BodyKind[] = ['json', 'text', 'xml', 'html', 'graphql']

/** New or changed items, all in workspaces the assistant may write to. */
export interface AssistantChanges { collections: Collection[]; folders: Folder[]; requests: RequestDef[] }

/** What the host gives the handler when the assistant workspace is on. */
export interface AssistantWorkspace {
  /** The collections in the assistant workspace. */
  collections: Collection[]
  /** The open workspace, when the user lets assistants edit it. Its collections are among the user's (no prefix). */
  editable?: { name: string; workspaceId: string; collections: Collection[] }
  save(c: AssistantChanges): Promise<void>
  remove(requestIds: string[]): Promise<void>
}

export const WORKSPACE_TOOL_NAMES = ['create_request', 'update_request', 'copy_request', 'move_request', 'delete_request', 'set_variables', 'set_scripts']

const IS_VAR = /^\s*\{\{[^{}]+\}\}\s*$/
/** Pre-request and tests scripts (Dispatch's dx API: dx.env.set, test(), expect(), dx.response.json() …; pm.* also runs). */
function scriptFields(what: string) {
  return {
    preRequestScript: { type: 'string', description: `JavaScript run before ${what === 'request' ? 'it is sent' : `every request in the ${what}`} (dx.vars.set, dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it. get_request shows the current one.` },
    testScript: { type: 'string', description: `JavaScript run after the response${what === 'request' ? '' : ` of every request in the ${what}`} (test("name", () => expect(dx.response.status).to.equal(200)), dx.response.json(), dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it.` },
  }
}
const fields = {
  method: { type: 'string', enum: [...METHODS] },
  url: { type: 'string', description: 'The full URL with any query string; {{variables}} are fine.' },
  headers: { type: 'object', additionalProperties: { type: 'string' }, description: `Header names and values (replaces all headers). Values shown as ${HIDDEN} can't be written back: leave headers out to keep them, or use a {{variable}}.` },
  body: { type: 'string', description: `The request body as text. Values shown as ${HIDDEN} can't be written back.` },
  bodyType: { type: 'string', enum: BODY_KINDS, description: 'Defaults to json when the body is JSON, otherwise text.' },
  docs: { type: 'string', description: 'Notes shown with the request (Markdown).' },
  ...scriptFields('request'),
}

/**
 * `own` false is for the built-in chat, which has no workspace of its own: the texts speak of the open workspace only
 * (`editable` then just says it can be edited) and never of "assistant/" paths.
 */
export function workspaceTools(editable?: string, own = true) {
  const ex = (p: string) => (own ? `assistant/${p}` : p)
  const where = !own ? 'a path like "Orders" or "Orders/Admin": the first part is the collection; collections and folders that don’t exist yet are made'
    : `a path like "assistant/Orders" or "assistant/Orders/Admin"${editable ? `, or "Orders/Admin" for the user’s workspace “${editable}”, which they let you edit` : ''}: the first part is the collection; collections and folders that don’t exist yet are made`
  const yours = !own ? 'the open workspace' : editable ? `your own workspace ("assistant/…") or the user’s workspace “${editable}”` : 'your own workspace ("assistant/…")'
  return [
    {
      name: 'create_request',
      description: `Save a new HTTP request in ${yours}. It is not sent${own ? '; use send_request for that' : ''}.${editable || !own ? '' : ' You can’t write to the user’s workspaces; they move what they want to keep.'}`,
      inputSchema: {
        type: 'object',
        properties: { folder: { type: 'string', description: `Where to save it: ${where}.` }, name: { type: 'string' }, ...fields, method: { ...fields.method, description: 'Defaults to GET.' } },
        required: ['folder', 'name', 'url'],
      },
    },
    {
      name: 'update_request',
      description: `Change a request in ${yours}. Only the fields given change.${editable || !own ? '' : ' The user’s saved requests can’t be changed: copy_request one first and change the copy.'}`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: `Its path, like "${ex('Orders/Create order')}".` }, newName: { type: 'string', description: 'Rename it.' }, ...fields,
          reviewed: { type: 'boolean', description: 'true clears the “handed to you” flag without moving it (move_request clears it too).' },
        },
        required: ['name'],
      },
    },
    {
      name: 'copy_request',
      description: `Copy a request ${own ? '(the user’s or your own) ' : ''}into ${yours}, with its auth, scripts and settings, so you can change ${own ? 'and send ' : ''}the copy.`,
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'The path from list_requests.' },
          to: { type: 'string', description: `Where to put the copy: ${where}.` },
          name: { type: 'string', description: 'A name for the copy; defaults to the original’s.' },
        },
        required: ['from', 'to'],
      },
    },
    {
      name: 'move_request',
      description: `Move (and optionally rename) a request within ${yours}, e.g. to file one the user handed you ${own ? `from assistant/${INBOX} ` : ''}into a proper collection. Its auth comes along, and a collection made for it gets the original collection’s variables. Clears the “handed to you” flag.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: `Its path, like "${own ? `assistant/${INBOX}` : 'Orders'}/Create order".` },
          to: { type: 'string', description: `Where to: ${where}.` },
          newName: { type: 'string', description: 'Rename it on the way.' },
        },
        required: ['name', 'to'],
      },
    },
    {
      name: 'delete_request',
      description: `Delete a request from ${yours}. The user can undo it in the app.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: `Its path, like "${ex('Orders/Create order')}".` } }, required: ['name'] },
    },
    {
      name: 'set_variables',
      description: `Set or remove collection variables (used as {{name}} in its requests) on a collection in ${yours}, e.g. a {{baseUrl}} after replacing a hard-coded host.`,
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: `The collection, like "${ex('Orders')}".` },
          variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'Names and values to set.' },
          remove: { type: 'array', items: { type: 'string' }, description: 'Names to remove.' },
        },
        required: ['collection'],
      },
    },
    {
      name: 'set_scripts',
      description: `Set the pre-request or tests script of a collection or folder in ${yours}; it runs for every request inside. For one request's own scripts use update_request.`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: `The collection or folder, like "${ex('Orders')}" or "${ex('Orders/Admin')}".` }, ...scriptFields('collection or folder') },
        required: ['path'],
      },
    },
  ]
}

/** The read-only tool for looking at one request in full; offered whenever list_requests is. */
export function getRequestTool() {
  return {
    name: 'get_request',
    description: `Show one saved request in full: method, URL, headers, body, auth (as it applies, inherited or not), scripts, docs, the collection’s variables, and the user’s note if they handed it to you. Secret values show as ${HIDDEN}.`,
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The path from list_requests.' } }, required: ['name'] },
  }
}

export interface WorkspaceCallContext {
  w: AssistantWorkspace
  folders: Folder[]
  requests: RequestDef[]
  /** Collections the user's requests live in (for copying their auth and variables). */
  allCollections: Collection[]
  allowMethods: string[]
  /** Finds any request by the path list_requests shows (user's or assistant's). */
  lookup(path: string): { it: RunItem; path: string } | { error: string }
}

/** A named value, hidden when the name looks secret (an auth scheme in front stays). */
export const hide = (name: string, v: string) => {
  // CORS headers (access-control-allow-credentials…) name secrets without holding any.
  if (!v || IS_VAR.test(v) || !SECRET_NAME.test(name) || /^access-control-/i.test(name)) return v
  const scheme = /^(Bearer|Basic|Digest|Token)\s+(?!\{\{)/i.exec(v)
  return scheme ? `${scheme[0]}${HIDDEN}` : HIDDEN
}
export const AUTH_SECRETS = new Set(['password', 'token', 'value', 'clientSecret', 'accessToken', 'secret', 'accessKey', 'secretKey', 'refreshToken', 'sessionToken'])
/** The auth fields that matter for each kind, in order. */
export const AUTH_FIELDS: Partial<Record<Auth['kind'], string[]>> = {
  basic: ['username', 'password'], digest: ['username', 'password'], bearer: ['token'], apikey: ['key', 'value', 'in'],
  oauth2: ['grant', 'tokenUrl', 'authUrl', 'clientId', 'clientSecret', 'scope', 'accessToken'],
  jwt: ['algorithm', 'secret', 'headerPrefix'], awsv4: ['accessKey', 'secretKey', 'region', 'service'],
}
const AUTH_SCHEME = /\b((?:Bearer|Basic|Digest|Token)\s+)(?!\{\{)[A-Za-z0-9._~+/=-]{8,}/g

/** A part of a text: from, up to (not including). */
export type Span = [number, number]

/** Where JWTs are: /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, but linear (that regex takes minutes on "-eyJaaaaa" × 1 MB). */
function jwtSpans(s: string): Span[] {
  const out: Span[] = []
  for (const run of s.matchAll(/[\w.-]+/g)) {
    const segs = run[0].split('.')
    let at = run.index // where segs[i] begins
    for (let i = 0; i + 2 < segs.length; i++) {
      const seg = segs[i]
      // the first word-starting eyJ has the most after it, so only that one can matter
      const p = segs[i + 1].length >= 5 && segs[i + 2].length >= 5 ? seg.search(/\beyJ/) : -1
      if (p >= 0 && seg.length - p - 3 >= 5) {
        const end = at + seg.length + 1 + segs[i + 1].length + 1 + segs[i + 2].length
        out.push([at + p, end])
        at = end + 1
        i += 2
      } else at += seg.length + 1
    }
  }
  return out
}

/** The hidden part of each match of `re`: `part` gives its offset and length in the match, or null to leave the match. */
const spansOf = (re: RegExp, part: (m: RegExpMatchArray) => [number, number] | null) => (s: string): Span[] => {
  const out: Span[] = []
  for (const m of s.matchAll(re)) {
    const x = part(m)
    if (x) out.push([m.index! + x[0], m.index! + x[0] + x[1]])
  }
  return out
}

/** What looks secret, each looked for in what the one before it left. */
export const SECRET_PATTERNS: ((s: string) => Span[])[] = [
  // user:password@host in URLs
  spansOf(/(\/\/[^/\s:@{}]+:)(?!\{\{)([^@/\s]+)@/g, (m) => [m[1].length, m[2].length]),
  jwtSpans,
  spansOf(AUTH_SCHEME, (m) => [m[1].length, m[0].length - m[1].length]),
  // "secret": "…"
  spansOf(/("([^"\\]+)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (m) => (m[3] && !IS_VAR.test(m[3]) && SECRET_NAME.test(m[2]) ? [m[1].length + 1, m[3].length] : null)),
  // secret=…
  spansOf(/([?&;\s]|^)([\w.-]+)=([^&;?\s"'<>,]+)/g, (m) => (!IS_VAR.test(m[3]) && SECRET_NAME.test(m[2]) ? [m[1].length + m[2].length + 1, m[3].length] : null)),
]

/** `s` with each span (in order, not overlapping) as <hidden>. */
export function hideSpans(s: string, spans: Span[]): string {
  if (!spans.length) return s
  let out = '', at = 0
  for (const [a, b] of spans) { out += s.slice(at, a) + HIDDEN; at = b }
  return out + s.slice(at)
}

/** Free text with secret-looking values hidden: URL passwords, JWTs, auth-scheme values, and "secret": "…" / secret=… pairs. */
export const hideInText = (s: string): string => SECRET_PATTERNS.reduce((t, find) => hideSpans(t, find(t)), s)
const hasHidden = (...xs: unknown[]) => xs.some((x) => x !== undefined && x !== null && JSON.stringify(x).includes(HIDDEN))
/** True when get_request showed part of this text as <hidden>, so the assistant can't rewrite it without losing that part. */
const hasSecretText = (t: string) => hideInText(t) !== t
const headerHidden = (h: KV) => hideInText(hide(h.key, h.value)) !== h.value
const bodyHasSecret = (b: RequestDef['body']) =>
  b.kind === 'urlencoded' || b.kind === 'formdata' ? b.fields.some((f) => hide(f.key, f.value) !== f.value) : b.kind !== 'none' && b.kind !== 'binary' && hasSecretText(b.text)
/** Refusal when a change would overwrite a value the assistant was only shown as <hidden>. */
const keepsSecret = (what: string) => `The ${what} holds a secret you were shown as ${HIDDEN}; rewriting it would lose that secret, so it was left as it is. Ask the user to move the secret into a {{variable}} first, then change it.`

/** get_request: one request in full, secrets hidden. */
export function describeRequest(found: { it: RunItem; path: string }, x: { allCollections: Collection[]; folders: Folder[] }): string {
  const r = found.it.request
  const col = x.allCollections.find((c) => c.id === r.collectionId) ?? null
  const auth = effectiveAuth(r, col, folderChain(x.folders, r.folderId))
  const authLine = (a: Auth | null) => {
    if (!a || a.kind === 'none') return 'none'
    const shown = (AUTH_FIELDS[a.kind] ?? []).map((k) => [k, (a as unknown as Record<string, unknown>)[k]] as const).filter(([, v]) => typeof v === 'string' && v)
      .map(([k, v]) => `${k}: ${AUTH_SECRETS.has(k) && !IS_VAR.test(v as string) ? HIDDEN : v}`)
    return `${a.kind}${r.auth.kind === 'inherit' ? ' (inherited)' : ''}${shown.length ? ` — ${shown.join(', ')}` : ''}`
  }
  const lines = [`${r.method} ${found.path}`, `URL: ${hideInText(r.url)}`]
  if (r.pathVars.length) lines.push(`Path variables: ${r.pathVars.map((p) => `${p.key}=${hide(p.key, p.value)}`).join(', ')}`)
  lines.push(`Auth: ${authLine(auth)}`)
  const hs = r.headers.filter((h) => h.key)
  lines.push(hs.length ? `Headers:\n${hs.map((h) => `  ${h.enabled === false ? '(off) ' : ''}${h.key}: ${hideInText(hide(h.key, h.value))}`).join('\n')}` : 'Headers: none')
  const b = r.body
  if (b.kind === 'none') lines.push('Body: none')
  else if (b.kind === 'urlencoded' || b.kind === 'formdata') lines.push(`Body (${b.kind}):\n${b.fields.map((f) => `  ${f.key}=${hide(f.key, f.value)}`).join('\n')}`)
  else if (b.kind === 'binary') lines.push('Body: a file')
  else lines.push(`Body (${b.kind}):\n${hideInText(b.text.length > 20_000 ? `${b.text.slice(0, 20_000)}\n… (cut)` : b.text)}`)
  if (r.scripts.pre.trim()) lines.push(`Pre-request script:\n${hideInText(r.scripts.pre)}`)
  if (r.scripts.post.trim()) lines.push(`Tests script:\n${hideInText(r.scripts.post)}`)
  // Scripts that also run for it, from its folders and collection (change them with set_scripts).
  const owners = [...folderChain(x.folders, r.folderId).reverse().map((f) => [`Folder “${f.name}”`, f.scripts] as const), ...(col ? [[`Collection “${col.name}”`, col.scripts] as const] : [])]
  for (const [owner, sc] of owners) {
    if (sc.pre.trim()) lines.push(`${owner} pre-request script (runs too):\n${hideInText(sc.pre)}`)
    if (sc.post.trim()) lines.push(`${owner} tests script (runs too):\n${hideInText(sc.post)}`)
  }
  if (r.docs.trim()) lines.push(`Docs:\n${hideInText(r.docs)}`)
  if (col?.variables.length) lines.push(`Collection “${col.name}” variables: ${col.variables.map((v) => `${v.key} = ${hide(v.key, v.value)}`).join(', ')}`)
  if (r.handoff) {
    const h = r.handoff
    lines.push(`Handed to you by the user (${new Date(h.at).toISOString().slice(0, 16).replace('T', ' ')}) from “${h.from}”${h.note ? `, asking: ${hideInText(h.note)}` : ''}.`)
    if (h.variables?.length) lines.push(`Its original collection’s variables: ${h.variables.map((v) => `${v.key} = ${hide(v.key, v.value)}`).join(', ')} (given to a new collection you move it into).`)
    if (/^\/\/ From the (collection|folder) “/m.test(r.scripts.pre + '\n' + r.scripts.post)) lines.push('Its scripts include the collection and folder scripts it ran with (each marked “// From the …”): remove those parts if you file it back under that collection or folder, or they run twice.')
    lines.push('Review it, fix what needs fixing (update_request, set_variables), then file it with move_request.')
  }
  return lines.join('\n')
}

/** New scripts from preRequestScript / testScript, and which changed. */
function scriptsOf(args: any, cur: Scripts): { scripts: Scripts; changed: string[] } {
  const scripts = { ...cur }
  const changed: string[] = []
  if (args.preRequestScript !== undefined && args.preRequestScript !== null) { scripts.pre = String(args.preRequestScript); changed.push('pre-request script') }
  if (args.testScript !== undefined && args.testScript !== null) { scripts.post = String(args.testScript); changed.push('tests script') }
  return { scripts, changed }
}

/** Runs one of WORKSPACE_TOOL_NAMES. Returns the reply text and whether it failed. */
export async function workspaceCall(name: string, args: any, x: WorkspaceCallContext): Promise<[string, boolean]> {
  const made: AssistantChanges = { collections: [], folders: [], requests: [] }
  const ed = x.w.editable
  const assistantCols = () => [...x.w.collections, ...made.collections.filter((c) => c.workspaceId === ASSISTANT_SPACE.id)]
  const userCols = () => (ed ? [...ed.collections, ...made.collections.filter((c) => c.workspaceId === ed.workspaceId)] : [])
  const folders = () => [...x.folders, ...made.folders]
  const mine = new Set(x.w.collections.map((c) => c.id))
  const writable = new Set([...mine, ...(ed?.collections ?? []).map((c) => c.id)])
  const isAssistantCol = (id: string | null) => !!id && (mine.has(id) || made.collections.some((c) => c.id === id && c.workspaceId === ASSISTANT_SPACE.id))

  /** Which workspace a path means, and its segments. Without "assistant/" it's the user's when they allow edits. */
  const rootOf = (path: unknown): { assistant: boolean; segs: string[] } => {
    const p = String(path ?? '').trim().replace(/^\/+|\/+$/g, '')
    const prefixed = p === 'assistant' || p.startsWith(ASSISTANT_PREFIX)
    const split = (t: string) => t.split('/').map((y) => y.trim()).filter(Boolean)
    const segs = split(prefixed ? p.slice(ASSISTANT_PREFIX.length) : p)
    if (!ed) return { assistant: true, segs }
    const ownHas = (name: string | undefined) => !!name && assistantCols().some((c) => c.name === name)
    const userHas = (name: string | undefined) => !!name && userCols().some((c) => c.name === name)
    if (!prefixed) {
      // Before edit access, bare paths meant the assistant's own workspace: a bare name of one of its collections that
      // the user's workspace doesn't have still means that one, so the old habit never writes into the user's.
      return { assistant: ownHas(segs[0]) && !userHas(segs[0]), segs }
    }
    // A user collection really named "assistant" is reachable when the assistant's workspace has no such collection.
    const userAssistant = userCols().find((c) => c.name === 'assistant')
    if (userAssistant && !ownHas(segs[0]) && (!segs.length || folders().some((f) => f.collectionId === userAssistant.id && f.parentId === null && f.name === segs[0]))) {
      return { assistant: false, segs: split(p) }
    }
    return { assistant: true, segs }
  }
  /** The parent for a path, making the collection and folders it needs. */
  const placeAt = (path: unknown): { collection: Collection; folderId: string | null; fresh: boolean } | string => {
    const { assistant, segs } = rootOf(path)
    if (!segs.length) return `Say where: a collection, like "assistant/My tests"${ed ? ` or a collection in “${ed.name}”` : ''}.`
    let collection = (assistant ? assistantCols() : userCols()).find((c) => c.name === segs[0])
    const fresh = !collection
    if (!collection) { collection = { ...newCollection(segs[0]), workspaceId: assistant ? ASSISTANT_SPACE.id : ed!.workspaceId }; made.collections.push(collection) }
    let parent: string | null = null
    for (const s of segs.slice(1)) {
      let f = folders().find((y) => y.collectionId === collection!.id && y.parentId === parent && y.name === s)
      if (!f) { f = newFolder(collection.id, s, parent); made.folders.push(f) }
      parent = f.id
    }
    return { collection, folderId: parent, fresh }
  }
  const siblingsOf = (collectionId: string, folderId: string | null) => x.requests.filter((r) => r.collectionId === collectionId && r.folderId === folderId)
  const nextSort = (collectionId: string, folderId: string | null) =>
    Math.max(0, ...siblingsOf(collectionId, folderId).map((r) => r.sort), ...folders().filter((f) => f.collectionId === collectionId && f.parentId === folderId).map((f) => f.sort)) + 1
  const label = (r: RequestDef) => {
    const c = [...assistantCols(), ...userCols(), ...x.allCollections].find((y) => y.id === r.collectionId)
    return (isAssistantCol(r.collectionId) ? ASSISTANT_PREFIX : '') + [c?.name ?? '?', ...folderChain(folders(), r.folderId).reverse().map((f) => f.name), r.name].join('/')
  }
  const refused = (path: string) => `“${path}” is one of the user’s saved requests, which you can’t change${ed ? ` (only “${ed.name}” and your own workspace are open to you)` : ''}. Use copy_request to copy it into your workspace and change the copy.`
  /** A request you may write to, by path; explains when you may not. */
  const own = (path: unknown): RequestDef | string => {
    const found = x.lookup(String(path ?? ''))
    if ('error' in found) return found.error
    if (!writable.has(found.it.request.collectionId ?? '')) return refused(found.path)
    return found.it.request
  }
  const methodOf = (m: unknown): string | null => {
    const v = String(m).toUpperCase()
    return (METHODS as readonly string[]).includes(v) ? v : null
  }
  const bodyOf = (args: any, current: RequestDef['body'] | null): RequestDef['body'] | string => {
    if (args.bodyType !== undefined && !BODY_KINDS.includes(args.bodyType)) return `Unknown bodyType “${args.bodyType}”; use one of ${BODY_KINDS.join(', ')}.`
    const base = current ?? newRequest().body
    if (args.body === undefined || args.body === null) return args.bodyType && current ? { ...base, kind: args.bodyType } : base
    const text = typeof args.body === 'string' ? args.body : JSON.stringify(args.body, null, 2)
    if (!text) return { ...base, kind: 'none', text: '' }
    const kind: BodyKind = args.bodyType ?? (() => { try { JSON.parse(text); return 'json' as const } catch { return 'text' as const } })()
    return { ...base, kind, text }
  }
  const headersOf = (h: unknown): KV[] | null => (h && typeof h === 'object' && !Array.isArray(h) ? Object.entries(h).map(([k, v]) => kv(k, String(v))) : null)
  const sendNote = (method: string) => (x.allowMethods.length && !x.allowMethods.includes(method) ? ` To send it, ${method} has to be added to the allowed methods in Dispatch (now ${x.allowMethods.join(', ')}).` : '')
  const hiddenBack = `${HIDDEN} stands for a secret you weren’t shown, so it can’t be saved. Leave that field out to keep the real value, or use a {{variable}}.`
  /** Auth to carry when a request leaves its collection or folders: what it inherited, made its own. */
  const carryAuth = (r: RequestDef, to: { collectionId: string; folderId: string | null }, notes: string[]) => {
    if (r.auth.kind !== 'inherit' || (r.collectionId === to.collectionId && r.folderId === to.folderId)) return r.auth
    const colById = (id: string | null) => [...x.allCollections, ...assistantCols(), ...userCols()].find((c) => c.id === id) ?? null
    const auth = effectiveAuth(r, colById(r.collectionId), folderChain(folders(), r.folderId))
    if (!auth) return r.auth
    // Where it lands gives it the same auth: it keeps inheriting, so later changes up the tree still reach it.
    const there = effectiveAuth({ ...r, collectionId: to.collectionId, folderId: to.folderId }, colById(to.collectionId), folderChain(folders(), to.folderId))
    if (there && JSON.stringify(there) === JSON.stringify(auth)) return r.auth
    // "No auth" needs no mention.
    if (auth.kind !== 'none') notes.push(`the ${auth.kind} auth it inherited was copied onto it`)
    return structuredClone(auth)
  }

  if (name === 'create_request') {
    const rname = String(args.name ?? '').trim()
    const url = String(args.url ?? '').trim()
    if (!rname || !url) return ['Give the request a name and a URL.', true]
    if (hasHidden(url, args.headers, args.body, args.preRequestScript, args.testScript)) return [hiddenBack, true]
    const method = methodOf(args.method ?? 'GET')
    if (!method) return [`Unknown method “${args.method}”; use one of ${METHODS.join(', ')}.`, true]
    const at = placeAt(args.folder)
    if (typeof at === 'string') return [at, true]
    if (siblingsOf(at.collection.id, at.folderId).some((r) => r.name === rname)) return [`That folder already has “${rname}”. Use update_request to change it, or pick another name.`, true]
    const body = bodyOf(args, null)
    if (typeof body === 'string') return [body, true]
    const r = newRequest({
      name: rname, method: method as RequestDef['method'], url, params: paramsFromUrl(url, []), headers: headersOf(args.headers) ?? [], body,
      collectionId: at.collection.id, folderId: at.folderId, sort: nextSort(at.collection.id, at.folderId), docs: typeof args.docs === 'string' ? args.docs : '',
      scripts: scriptsOf(args, newRequest().scripts).scripts,
    })
    await x.w.save({ ...made, requests: [r] })
    return [`Saved ${method} ${label(r)} → ${url}${body.kind !== 'none' ? ` (${body.kind} body)` : ''}.${sendNote(method)}`, false]
  }

  if (name === 'update_request') {
    const r = own(args.name)
    if (typeof r === 'string') return [r, true]
    if (hasHidden(args.url, args.headers, args.body, args.preRequestScript, args.testScript)) return [hiddenBack, true]
    const next: RequestDef = { ...r, updatedAt: Date.now() }
    const changed: string[] = []
    if (args.newName !== undefined) {
      const n = String(args.newName).trim()
      if (!n) return ['newName can’t be empty.', true]
      if (n !== r.name && siblingsOf(r.collectionId!, r.folderId).some((y) => y.name === n)) return [`That folder already has “${n}”.`, true]
      next.name = n; changed.push('name')
    }
    if (args.method !== undefined) {
      const m = methodOf(args.method)
      if (!m) return [`Unknown method “${args.method}”; use one of ${METHODS.join(', ')}.`, true]
      next.method = m as RequestDef['method']; changed.push('method')
    }
    if (args.url !== undefined) {
      const u = String(args.url).trim()
      if (u !== r.url && hasSecretText(r.url)) return [keepsSecret('URL'), true]
      next.url = u; next.params = paramsFromUrl(next.url, r.params); changed.push('URL')
    }
    const kept: string[] = []
    if (args.headers !== undefined) {
      const h = headersOf(args.headers)
      if (!h) return ['headers must be an object of names and values.', true]
      // Headers whose value was hidden stay unless the assistant names them: leaving one out must not delete it.
      // The original order stays: each header keeps its place, replaced by the assistant's value when it names it;
      // headers it leaves out go, except hidden ones; new ones go at the end.
      const given = new Map(h.map((y) => [y.key.toLowerCase(), y]))
      const merged: KV[] = []
      for (const y of r.headers) {
        const g = y.key ? given.get(y.key.toLowerCase()) : undefined
        if (g) { merged.push(g); given.delete(y.key.toLowerCase()) }
        else if (y.key && headerHidden(y)) { merged.push(y); kept.push(y.key) }
      }
      next.headers = [...merged, ...given.values()]; changed.push('headers')
    }
    if (args.body !== undefined || args.bodyType !== undefined) {
      if (bodyHasSecret(r.body)) return [keepsSecret('body'), true]
      const b = bodyOf(args, r.body)
      if (typeof b === 'string') return [b, true]
      next.body = b; changed.push('body')
    }
    if (args.docs !== undefined) {
      if (String(args.docs) !== r.docs && hasSecretText(r.docs)) return [keepsSecret('docs text'), true]
      next.docs = String(args.docs); changed.push('docs')
    }
    if ((args.preRequestScript !== undefined && hasSecretText(r.scripts.pre)) || (args.testScript !== undefined && hasSecretText(r.scripts.post))) return [keepsSecret('script'), true]
    const sc = scriptsOf(args, r.scripts)
    if (sc.changed.length) { next.scripts = sc.scripts; changed.push(...sc.changed) }
    if (args.reviewed === true && r.handoff) { delete next.handoff; changed.push('marked reviewed') }
    if (!changed.length) return ['Nothing to change: give newName, method, url, headers, body, bodyType, docs, preRequestScript, testScript or reviewed.', true]
    await x.w.save({ ...made, requests: [next] })
    return [`Updated ${label(next)} (${changed.join(', ')}).${kept.length ? ` Kept the hidden ${kept.join(', ')} header${kept.length > 1 ? 's' : ''}; name ${kept.length > 1 ? 'them' : 'it'} with a {{variable}} value to replace ${kept.length > 1 ? 'them' : 'it'}.` : ''}${sendNote(next.method)}`, false]
  }

  if (name === 'copy_request') {
    const found = x.lookup(String(args.from ?? ''))
    if ('error' in found) return [found.error, true]
    const src = found.it.request
    const at = placeAt(args.to)
    if (typeof at === 'string') return [at, true]
    const rname = String(args.name ?? '').trim() || src.name
    if (siblingsOf(at.collection.id, at.folderId).some((r) => r.name === rname)) return [`That folder already has “${rname}”; give the copy another name.`, true]
    const notes: string[] = []
    const copy: RequestDef = { ...structuredClone(src), id: uid(), name: rname, collectionId: at.collection.id, folderId: at.folderId, sort: nextSort(at.collection.id, at.folderId), updatedAt: Date.now() }
    delete copy.handoff
    if (src.collectionId !== at.collection.id) {
      // The copy no longer sits under the original's folders and collection, so take the auth it inherited.
      copy.auth = carryAuth(src, { collectionId: at.collection.id, folderId: at.folderId }, notes)
      const srcCol = x.allCollections.find((c) => c.id === src.collectionId) ?? null
      if (srcCol?.variables.length) {
        if (at.fresh) { at.collection.variables = structuredClone(srcCol.variables); notes.push(`the new collection got “${srcCol.name}”’s variables`) }
        else notes.push(`“${srcCol.name}”’s collection variables weren’t copied`)
      }
    }
    await x.w.save({ ...made, requests: [copy] })
    return [`Copied ${found.path} to ${label(copy)}${notes.length ? `; ${notes.join('; ')}` : ''}.${sendNote(copy.method)}`, false]
  }

  if (name === 'move_request') {
    const r = own(args.name)
    if (typeof r === 'string') return [r, true]
    const from = label(r)
    const at = placeAt(args.to)
    if (typeof at === 'string') return [at, true]
    const rname = args.newName !== undefined ? String(args.newName).trim() : r.name
    if (!rname) return ['newName can’t be empty.', true]
    if (siblingsOf(at.collection.id, at.folderId).some((y) => y.name === rname && y.id !== r.id)) return [`That folder already has “${rname}”; pick another name with newName.`, true]
    const notes: string[] = []
    const next: RequestDef = { ...r, name: rname, collectionId: at.collection.id, folderId: at.folderId, sort: nextSort(at.collection.id, at.folderId), updatedAt: Date.now() }
    next.auth = carryAuth(r, { collectionId: at.collection.id, folderId: at.folderId }, notes)
    if (r.collectionId !== at.collection.id) {
      const vars = r.handoff?.variables ?? x.allCollections.find((c) => c.id === r.collectionId)?.variables ?? []
      if (vars.length && at.fresh) { at.collection.variables = structuredClone(vars); notes.push('the new collection got the original collection’s variables') }
    }
    if (r.handoff) { delete next.handoff; notes.push('marked reviewed') }
    await x.w.save({ ...made, requests: [next] })
    return [`Moved ${from} to ${label(next)}${notes.length ? `; ${notes.join('; ')}` : ''}.`, false]
  }

  if (name === 'delete_request') {
    const r = own(args.name)
    if (typeof r === 'string') return [r, true]
    await x.w.remove([r.id])
    return [`Deleted ${label(r)}. The user can undo it in Dispatch.`, false]
  }

  if (name === 'set_variables') {
    const { assistant, segs } = rootOf(args.collection)
    if (segs.length !== 1) return ['Name one collection, like "assistant/Orders".', true]
    const c = (assistant ? assistantCols() : userCols()).find((y) => y.name === segs[0])
    if (!c) {
      const theirs = x.allCollections.some((y) => y.name === segs[0] && !writable.has(y.id))
      return [theirs ? `“${segs[0]}” is the user’s collection, which you can’t change.` : `No collection “${String(args.collection)}” you can change. Use list_requests.`, true]
    }
    const set = args.variables && typeof args.variables === 'object' && !Array.isArray(args.variables) ? Object.entries(args.variables).map(([k, v]) => [k, String(v)] as const) : []
    const drop: string[] = Array.isArray(args.remove) ? args.remove.map(String) : []
    if (!set.length && !drop.length) return ['Give variables to set or names to remove.', true]
    if (set.some(([, v]) => v.includes(HIDDEN))) return [hiddenBack, true]
    let vars = c.variables.filter((v) => !drop.includes(v.key))
    for (const [k, v] of set) vars = vars.some((y) => y.key === k) ? vars.map((y) => (y.key === k ? { ...y, value: v } : y)) : [...vars, kv(k, v)]
    await x.w.save({ collections: [{ ...c, variables: vars, updatedAt: Date.now() }], folders: [], requests: [] })
    const prefix = c.workspaceId === ASSISTANT_SPACE.id ? ASSISTANT_PREFIX : ''
    return [`Collection ${prefix}${c.name}: ${[set.length ? `set ${set.map(([k]) => k).join(', ')}` : '', drop.length ? `removed ${drop.join(', ')}` : ''].filter(Boolean).join('; ')}.`, false]
  }
  if (name === 'set_scripts') {
    const { assistant, segs } = rootOf(args.path)
    if (!segs.length) return ['Name a collection or folder, like "assistant/Orders/Admin".', true]
    const c = (assistant ? assistantCols() : userCols()).find((y) => y.name === segs[0])
    if (!c) {
      const theirs = x.allCollections.some((y) => y.name === segs[0] && !writable.has(y.id))
      return [theirs ? `“${segs[0]}” is the user’s collection, which you can’t change.` : `No collection “${segs[0]}” you can change. Use list_requests.`, true]
    }
    let folder: Folder | undefined
    let parent: string | null = null
    for (const seg of segs.slice(1)) {
      folder = x.folders.find((y) => y.collectionId === c.id && y.parentId === parent && y.name === seg)
      if (!folder) return [`No folder “${seg}” in ${String(args.path)}.`, true]
      parent = folder.id
    }
    if (hasHidden(args.preRequestScript, args.testScript)) return [hiddenBack, true]
    const cur = (folder ?? c).scripts
    if ((args.preRequestScript !== undefined && hasSecretText(cur.pre)) || (args.testScript !== undefined && hasSecretText(cur.post))) return [keepsSecret('script'), true]
    const sc = scriptsOf(args, cur)
    if (!sc.changed.length) return ['Give preRequestScript or testScript.', true]
    if (folder) await x.w.save({ collections: [], folders: [{ ...folder, scripts: sc.scripts, updatedAt: Date.now() }], requests: [] })
    else await x.w.save({ collections: [{ ...c, scripts: sc.scripts, updatedAt: Date.now() }], folders: [], requests: [] })
    const prefix = c.workspaceId === ASSISTANT_SPACE.id ? ASSISTANT_PREFIX : ''
    return [`${folder ? 'Folder' : 'Collection'} ${prefix}${segs.join('/')}: updated the ${sc.changed.join(' and ')}.`, false]
  }
  return [`Unknown tool ${name}`, true]
}
