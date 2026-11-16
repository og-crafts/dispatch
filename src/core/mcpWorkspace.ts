/**
 * The assistant's own workspace. With it on (desktop Settings), MCP assistants can create, change, copy and
 * delete requests, but only in the "AI assistant" workspace. The user's workspaces stay list-and-send only, and
 * the user moves what they want to keep into their own workspace (collection menu → Move to …).
 * Paths in the assistant workspace start with "assistant/", like "assistant/Orders/Admin/Create order".
 */
import { effectiveAuth } from './prepare'
import { folderChain } from './runtime'
import type { RunItem } from './runner'
import {
  ASSISTANT_SPACE, type BodyKind, type Collection, type Folder, type KV, METHODS, type RequestDef,
  kv, newCollection, newFolder, newRequest, uid,
} from './types'
import { paramsFromUrl } from './url'

export const ASSISTANT_PREFIX = 'assistant/'
const BODY_KINDS: BodyKind[] = ['json', 'text', 'xml', 'html', 'graphql']

/** New or changed items, all in the assistant workspace. */
export interface AssistantChanges { collections: Collection[]; folders: Folder[]; requests: RequestDef[] }

/** What the host gives the handler when the assistant workspace is on. */
export interface AssistantWorkspace {
  /** The collections in the assistant workspace. */
  collections: Collection[]
  save(c: AssistantChanges): Promise<void>
  remove(requestIds: string[]): Promise<void>
}

export const WORKSPACE_TOOL_NAMES = ['create_request', 'update_request', 'copy_request', 'delete_request']

const where = 'a path in your workspace like "assistant/Orders" or "assistant/Orders/Admin": the first part is the collection; collections and folders that don’t exist yet are made'
const fields = {
  method: { type: 'string', enum: [...METHODS] },
  url: { type: 'string', description: 'The full URL with any query string; {{variables}} are fine.' },
  headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Header names and values (replaces all headers).' },
  body: { type: 'string', description: 'The request body as text.' },
  bodyType: { type: 'string', enum: BODY_KINDS, description: 'Defaults to json when the body is JSON, otherwise text.' },
  docs: { type: 'string', description: 'Notes shown with the request (Markdown).' },
}

export function workspaceTools() {
  return [
    {
      name: 'create_request',
      description: 'Save a new HTTP request in your own workspace ("assistant/…"). It is not sent; use send_request for that. You can’t write to the user’s workspaces; they move what they want to keep.',
      inputSchema: {
        type: 'object',
        properties: { folder: { type: 'string', description: `Where to save it: ${where}.` }, name: { type: 'string' }, ...fields, method: { ...fields.method, description: 'Defaults to GET.' } },
        required: ['folder', 'name', 'url'],
      },
    },
    {
      name: 'update_request',
      description: 'Change a request in your own workspace ("assistant/…"). Only the fields given change. The user’s saved requests can’t be changed: copy_request one first and change the copy.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Its path, like "assistant/Orders/Create order".' }, newName: { type: 'string', description: 'Rename it.' }, ...fields },
        required: ['name'],
      },
    },
    {
      name: 'copy_request',
      description: 'Copy a request (the user’s or your own) into your workspace, with its auth, scripts and settings, so you can change and send the copy.',
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
      name: 'delete_request',
      description: 'Delete a request from your own workspace ("assistant/…"). The user can undo it in the app.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Its path, like "assistant/Orders/Create order".' } }, required: ['name'] },
    },
  ]
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

const strip = (p: string) => p.trim().replace(/^\/+|\/+$/g, '').replace(/^assistant\//, '')

/** Runs one of WORKSPACE_TOOL_NAMES. Returns the reply text and whether it failed. */
export async function workspaceCall(name: string, args: any, x: WorkspaceCallContext): Promise<[string, boolean]> {
  const made: AssistantChanges = { collections: [], folders: [], requests: [] }
  const cols = () => [...x.w.collections, ...made.collections]
  const folders = () => [...x.folders, ...made.folders]
  const mine = new Set(x.w.collections.map((c) => c.id))

  /** The parent for a path in the assistant workspace, making the collection and folders it needs. */
  const placeAt = (path: string): { collection: Collection; folderId: string | null; fresh: boolean } | string => {
    const segs = strip(String(path ?? '')).split('/').map((s) => s.trim()).filter(Boolean)
    if (!segs.length) return 'Say where: a collection in your workspace, like "assistant/My tests".'
    let collection = cols().find((c) => c.name === segs[0])
    const fresh = !collection
    if (!collection) { collection = { ...newCollection(segs[0]), workspaceId: ASSISTANT_SPACE.id }; made.collections.push(collection) }
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
    const c = cols().find((y) => y.id === r.collectionId)
    return ASSISTANT_PREFIX + [c?.name ?? '?', ...folderChain(folders(), r.folderId).reverse().map((f) => f.name), r.name].join('/')
  }
  /** A request in the assistant workspace by path; explains when the path is the user's. */
  const own = (path: string): RequestDef | string => {
    const found = x.lookup(String(path ?? ''))
    if ('error' in found) return found.error
    if (!mine.has(found.it.request.collectionId ?? '')) return `“${found.path}” is one of the user’s saved requests, which you can’t change. Use copy_request to copy it into your workspace and change the copy.`
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

  if (name === 'create_request') {
    const rname = String(args.name ?? '').trim()
    const url = String(args.url ?? '').trim()
    if (!rname || !url) return ['Give the request a name and a URL.', true]
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
    })
    await x.w.save({ ...made, requests: [r] })
    return [`Saved ${method} ${label(r)} → ${url}${body.kind !== 'none' ? ` (${body.kind} body)` : ''}.${sendNote(method)}`, false]
  }

  if (name === 'update_request') {
    const r = own(args.name)
    if (typeof r === 'string') return [r, true]
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
    if (args.url !== undefined) { next.url = String(args.url).trim(); next.params = paramsFromUrl(next.url, r.params); changed.push('URL') }
    if (args.headers !== undefined) {
      const h = headersOf(args.headers)
      if (!h) return ['headers must be an object of names and values.', true]
      next.headers = h; changed.push('headers')
    }
    if (args.body !== undefined || args.bodyType !== undefined) {
      const b = bodyOf(args, r.body)
      if (typeof b === 'string') return [b, true]
      next.body = b; changed.push('body')
    }
    if (args.docs !== undefined) { next.docs = String(args.docs); changed.push('docs') }
    if (!changed.length) return ['Nothing to change: give newName, method, url, headers, body, bodyType or docs.', true]
    await x.w.save({ ...made, requests: [next] })
    return [`Updated ${label(next)} (${changed.join(', ')}).${sendNote(next.method)}`, false]
  }

  if (name === 'copy_request') {
    const found = x.lookup(String(args.from ?? ''))
    if ('error' in found) return [found.error, true]
    const src = found.it.request
    const at = placeAt(args.to)
    if (typeof at === 'string') return [at, true]
    const rname = String(args.name ?? '').trim() || src.name
    if (siblingsOf(at.collection.id, at.folderId).some((r) => r.name === rname)) return [`That folder already has “${rname}”; give the copy another name.`, true]
    const copy: RequestDef = { ...structuredClone(src), id: uid(), name: rname, collectionId: at.collection.id, folderId: at.folderId, sort: nextSort(at.collection.id, at.folderId), updatedAt: Date.now() }
    const notes: string[] = []
    const srcCol = x.allCollections.find((c) => c.id === src.collectionId) ?? null
    if (!mine.has(src.collectionId ?? '')) {
      // The copy no longer sits under the original's folders and collection, so take the auth it inherited.
      const auth = effectiveAuth(src, srcCol, folderChain(x.folders, src.folderId))
      if (src.auth.kind === 'inherit' && auth) { copy.auth = structuredClone(auth); notes.push(`its inherited ${auth.kind} auth was copied onto it`) }
      if (srcCol?.variables.length) {
        if (at.fresh) { at.collection.variables = structuredClone(srcCol.variables); notes.push(`the new collection got “${srcCol.name}”’s variables`) }
        else notes.push(`“${srcCol.name}”’s collection variables weren’t copied`)
      }
    }
    await x.w.save({ ...made, requests: [copy] })
    return [`Copied ${found.path} to ${label(copy)}${notes.length ? `; ${notes.join('; ')}` : ''}.${sendNote(copy.method)}`, false]
  }

  if (name === 'delete_request') {
    const r = own(args.name)
    if (typeof r === 'string') return [r, true]
    await x.w.remove([r.id])
    return [`Deleted ${label(r)}. The user can undo it in Dispatch.`, false]
  }
  return [`Unknown tool ${name}`, true]
}
