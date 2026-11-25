/**
 * From a model's edit call to a Proposal. Nothing is written here: the edit code works on the open workspace with cleaned
 * names, what it would save is captured, the real names are put back, and what is left is checked (nothing outside the
 * workspace, no value the model wasn't shown replaced or removed) and drawn for the person, with its risks.
 */
import { diffLines, withContext } from '../diff'
import { FAKE } from '../fake'
import { finder, type McpServeOptions } from '../mcpHandler'
import { ASSISTANT_PREFIX, AUTH_FIELDS, AUTH_SECRETS, type AssistantChanges, HIDDEN, workspaceCall } from '../mcpWorkspace'
import { effectiveAuth, scopeFor } from '../prepare'
import { collectItems } from '../runner'
import { folderChain } from '../runtime'
import type { Schedule } from '../schedules'
import { SECRET_NAME } from '../share'
import { type Auth, type Collection, type Environment, type Folder, type KV, type RequestDef, spaceOf, uid } from '../types'
import { splitUrl, withScheme } from '../url'
import { namesIn } from '../vars'
import { cleaner } from './clean'
import type { ToolContext } from './gate'
import { applyParameters, setEnvironmentVariables } from './parameters'
import { canonical, type Change, type Field, type Line, type Proposal, type Rec } from './proposal'
import { allSecrets, toolClass } from './tools'

/** What proposing needs: everything but the person's answer. */
export type ProposeContext = Omit<ToolContext, 'decide' | 'job'>

export type Cleaner = ReturnType<typeof cleaner>
interface World { collections: Collection[]; folders: Folder[]; requests: RequestDef[]; environments: Environment[]; globals: KV[]; active: Environment | null }
/** What the model itself supplied, so it is shown exactly. `headers` (names in lower case) and `variables` with the values it gave. */
interface Exact { name?: boolean; url?: boolean; body?: boolean; docs?: boolean; pre?: boolean; post?: boolean; headers?: Map<string, string>; variables?: Map<string, string> }
export interface Draft { tool: string; title: string; changes: Change[]; reply: string; exact?: Exact; sources?: Map<string, RequestDef>
  /** What the card says besides the risks. */
  notes?: string[]
  /** Variables by name, with the value each took the place of in the request. */
  moved?: Map<string, string>
  /** Hides more than the usual one: what moves. */
  cleaner?: Cleaner }
export type Refused = { refused: string }

/** Stands for the open workspace while the edit code runs: what it makes for its own ("assistant") can't be mistaken for it. */
const OPEN = '(open)'
/** The fields that name something which may already be there, as the model was shown it. */
const PATHS: Record<string, string[]> = { create_request: ['folder'], update_request: ['name'], copy_request: ['from', 'to'], move_request: ['name', 'to'], delete_request: ['name'], set_variables: ['collection'], set_scripts: ['path'], apply_parameters: ['name'], set_environment_variables: ['environment'] }
/** The ones that are a place (collection and folders), not a request. */
const PLACES: Record<string, string> = { create_request: 'folder', copy_request: 'to', move_request: 'to', set_variables: 'collection', set_scripts: 'path' }
const IS_VAR = /^\s*\{\{[^{}]+\}\}\s*$/
const TEXT_BODIES = ['json', 'text', 'xml', 'html', 'graphql']
export const BODY_FIELDS = ['urlencoded', 'formdata']

const given = (v: unknown) => v !== undefined && v !== null
export const held = (what: string) => `The ${what} holds a secret you weren’t shown, so it can’t be changed or removed here. Ask the person to move the secret into a {{variable}} first.`
const isEmpty = (s: string) => !s.trim()
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

const code = (c: string) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`
/** Control, zero-width and direction characters as codes, so text can't look like something else. Lines and tabs stay, and
 *  as many marks on one character as scripts use; a pile of them could cover what is next to it. */
const drawn = (s: string) => s.replace(/(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, code)
  .replace(/(\p{M}{4})(\p{M}+)/gu, (_m, some: string, more: string) => some + [...more].map(code).join(''))
/** For one line: a name in a title or a warning. */
export const oneLine = (s: string) => drawn(s).replace(/[\n\t]/g, (c) => `\\u{${c.charCodeAt(0).toString(16).toUpperCase()}}`)

/** Turns an edit call into what the person is asked to approve, or says why not. Writes and sends nothing. */
export async function propose(name: string, input: Record<string, unknown>, ctx: ProposeContext): Promise<Proposal | Refused> {
  const cls = toolClass(name)
  if (!PATHS[name] || (cls !== 'edit' && cls !== 'delete')) return { refused: 'There is no such tool here. Nothing was changed.' }
  if (ctx.signal.aborted) return { refused: 'The person stopped this. Nothing was changed.' }
  const w = ctx.world()
  if (w.settings.activeSpaceId !== ctx.spaceId) return { refused: 'The person opened another workspace, so this chat can’t change anything here now. Nothing was changed.' }
  const cl = cleaner(ctx, w)
  const refuse = (text: string): Refused => ({ refused: `${cl.clean(text)} Nothing was changed.` })
  const hiddenBack = refuse(`${HIDDEN} stands for a secret you weren’t shown, so it can’t be saved.`)
  // A path may hold it (a name with a secret in it is shown so); what would be written may not.
  if (JSON.stringify(Object.entries(input).filter(([k]) => !PATHS[name].includes(k))).includes(HIDDEN)) return hiddenBack

  if (name === 'apply_parameters' || name === 'set_environment_variables') {
    const d = (name === 'apply_parameters' ? applyParameters : setEnvironmentVariables)(input, ctx, w, cl)
    return 'refused' in d ? refuse(d.refused) : proposalOf(ctx, w, d.cleaner ?? cl, d)
  }
  const { real, collections, folders, requests, lookup } = cleanWorld(w, ctx.spaceId, cl)

  const bad = PLACES[name] && badPlace(name, String(input[PLACES[name]] ?? ''), collections, folders)
  if (bad) return refuse(bad)
  let found: RequestDef | undefined
  if (!PLACES[name] || name === 'copy_request' || name === 'move_request') {
    const r = lookup(String(input[PATHS[name][0]] ?? ''))
    if ('error' in r) return refuse(r.error)
    found = real.requests.find((x) => x.id === r.it.request.id)
    if (ctx.unsaved(r.it.request.id)) return refuse(`Save or discard your changes to “${oneLine(r.it.request.name)}” first.`)
  }
  // Before the edit code looks at the values: what it answers could tell a right guess from a wrong one.
  const kept = name === 'update_request' ? heldInRequest(input, found!, cl) : null
  if (kept) return refuse(held(kept))

  let got: AssistantChanges = { collections: [], folders: [], requests: [] }
  let gone: string[] = []
  const [reply, failed] = await workspaceCall(name, input, {
    w: { collections: [], editable: { name: 'the open workspace', workspaceId: OPEN, collections }, save: async (c) => { got = c }, remove: async (ids) => { gone = ids } },
    folders, requests, allCollections: collections, allowMethods: [], lookup,
  })
  if (failed) return refuse(reply)

  // What it would save, with the real names back, and nothing but the open workspace.
  const colOf = byId(real.collections), folderOf = byId(real.folders), requestOf = byId(real.requests)
  const nameBack = (now: string, was: { name: string } | undefined) => (was && now === cl.clean(was.name) ? was.name : now)
  const changes: Change[] = []
  const add = (kind: Change['kind'], id: string, before: Rec | null, after: Rec | null) => { if (canonical(before) !== canonical(after)) changes.push(structuredClone({ kind, id, before, after })) }
  const outside = refuse('That is outside the open workspace.')
  const places = new Set([...real.collections, ...got.collections].map((c) => c.id))
  const inside = [...real.folders, ...got.folders]
  for (const c of got.collections) {
    if (c.workspaceId !== OPEN) return outside
    const was = colOf.get(c.id)
    if (!was && c.name.includes(HIDDEN)) return hiddenBack
    // a new one has the variables of the collection its request comes from
    const pool = [...((was ?? (found && colOf.get(found.collectionId ?? '')))?.variables ?? [])]
    const variables = c.variables.map((v) => {
      const i = pool.findIndex((x) => x.id === v.id && cl.clean(x.key) === v.key)
      const back = i < 0 ? v : { ...v, key: pool.splice(i, 1)[0].key }
      return name === 'set_variables' && Object.hasOwn((input.variables as object) ?? {}, back.key) ? inStep(back) : back
    })
    const keys = new Set(real.collections.flatMap((x) => x.variables).map((v) => v.key))
    if (variables.some((v) => v.key.includes(HIDDEN) && !keys.has(v.key))) return hiddenBack
    add('collection', c.id, was ?? null, { ...c, name: nameBack(c.name, was), workspaceId: was ? was.workspaceId : ctx.spaceId, variables })
  }
  for (const f of got.folders) {
    const was = folderOf.get(f.id)
    if (!places.has(f.collectionId)) return outside
    if (!was && f.name.includes(HIDDEN)) return hiddenBack
    add('folder', f.id, was ?? null, { ...f, name: nameBack(f.name, was) })
  }
  const sources = new Map<string, RequestDef>()
  for (const r of got.requests) {
    const was = requestOf.get(r.id)
    if (!r.collectionId || !places.has(r.collectionId) || (r.folderId && !inside.some((f) => f.id === r.folderId && f.collectionId === r.collectionId))) return outside
    if (!was && found) sources.set(r.id, found)
    add('request', r.id, was ?? null, asItWas({ ...r, name: nameBack(r.name, was ?? found) }, was, given(input.bodyType)))
  }
  for (const id of gone) {
    const was = requestOf.get(id)
    if (!was) return outside
    add('request', id, was, null)
  }
  if (name === 'set_variables') {
    const why = badVariables(input, colOf.get(got.collections[0]?.id)?.variables ?? [], cl)
    if (why) return refuse(why)
  }
  if (name === 'set_scripts') {
    const r = colOf.get(got.collections[0]?.id) ?? folderOf.get(got.folders[0]?.id)
    if (r && ([['preRequestScript', r.scripts.pre], ['testScript', r.scripts.post]] as const).some(([k, s]) => given(input[k]) && cl.clean(s) !== s)) return refuse(held('script'))
  }
  for (const c of changes) {
    const what = c.before && c.after && lost(c.before, c.after, cl)
    if (what) return refuse(held(what))
  }
  const writes = name === 'create_request' || name === 'update_request'
  const pairs = (v: unknown) => Object.entries((v as Record<string, string>) ?? {})
  const exact: Exact = {
    name: name === 'create_request' || (name === 'copy_request' ? !isEmpty(String(input.name ?? '')) : given(input.newName)),
    ...(writes ? { url: given(input.url), body: given(input.body), docs: given(input.docs), headers: new Map(pairs(input.headers).map(([k, v]) => [k.toLowerCase(), v])) } : {}),
    ...(writes || name === 'set_scripts' ? { pre: given(input.preRequestScript), post: given(input.testScript) } : {}),
    ...(name === 'set_variables' ? { variables: new Map(pairs(input.variables)) } : {}),
  }
  return proposalOf(ctx, w, cl, { tool: name, title: titleOf(name, changes, sources), changes, reply, exact, sources })
}

/** Checks done and records final: what the card draws and warns of. */
export async function proposalOf(ctx: ProposeContext, w: McpServeOptions, cl: Cleaner, d: Draft): Promise<Proposal | Refused> {
  const before = openWorld(w, ctx.spaceId)
  const after = applied(before, d.changes)
  const fields: Field[] = []
  for (const c of d.changes) {
    const own = fieldsOf(c, before, after, d, cl)
    if (!own.length) return { refused: 'This change can’t be shown to the person, so it can’t be made here. Nothing was changed.' }
    fields.push(...own)
  }
  if (!d.changes.length) return { refused: 'This wouldn’t change anything. Nothing was changed.' }
  const schedules = await ctx.schedules()
  return {
    id: uid(), spaceId: ctx.spaceId, tool: d.tool, cls: toolClass(d.tool) === 'delete' ? 'delete' : 'edit', title: oneLine(cl.clean(d.title)), fields,
    warnings: [...(d.notes ?? []).map((n) => oneLine(cl.clean(n))), ...warningsOf(d, before, after, schedules, cl)], changes: d.changes, reply: cl.clean(d.reply),
    basis: basisOf(w, ctx.spaceId, schedules),
  }
}

/** What the card and its warnings come from besides the records in the changes. Equal strings: what it says still holds. */
export function basisOf(w: McpServeOptions, spaceId: string, schedules: Schedule[]): string {
  const o = openWorld(w, spaceId)
  const each = (l: unknown[]) => l.map((x) => canonical(x as Rec)).sort()
  return JSON.stringify([
    o.active?.id ?? null, each(o.environments), canonical(o.globals), each(o.collections), each(o.folders),
    each(schedules.filter((s) => s.enabled).map(({ lastRunAt: _, ...s }) => s)),
  ])
}

/** The open workspace, as the edit code gets it: real but for the names, and without what it has no business with. */
export function cleanWorld(w: McpServeOptions, spaceId: string, cl: Cleaner) {
  const real = openWorld(w, spaceId)
  const collections = real.collections.map((c): Collection => ({ ...c, name: cl.clean(c.name), workspaceId: OPEN, variables: c.variables.map((v) => ({ ...v, key: cl.clean(v.key) })) }))
  const folders = real.folders.map((f): Folder => ({ ...f, name: cl.clean(f.name) }))
  const requests = real.requests.map(({ handoff: _, ...r }): RequestDef => ({ ...r, name: cl.clean(r.name) }))
  const find = finder({ ws: { ...w.ws, collections, folders, requests, environments: [] }, allCollections: true })
  const lookup: typeof find.lookup = (path) => {
    if (find.items().filter((it) => find.pathOf(it) === path).length > 1) return { error: `Several requests are at “${path}”. Ask the person to rename one of them.` }
    return find.lookup(path)
  }
  return { real, collections, folders, requests, lookup }
}

const byId = <T extends { id: string }>(l: T[]) => new Map(l.map((x) => [x.id, x]))

function openWorld(w: McpServeOptions, spaceId: string): World {
  const collections = w.ws.collections.filter((c) => spaceOf(c) === spaceId)
  const ids = new Set(collections.map((c) => c.id))
  const environments = w.ws.environments.filter((e) => spaceOf(e) === spaceId)
  return {
    collections, environments, globals: w.globals, active: environments.find((e) => e.id === w.environment?.id) ?? null,
    folders: w.ws.folders.filter((f) => ids.has(f.collectionId)), requests: w.ws.requests.filter((r) => r.collectionId && ids.has(r.collectionId)),
  }
}

function applied(w: World, changes: Change[]): World {
  const put = <T extends { id: string }>(list: T[], kind: Change['kind']): T[] => {
    const cs = changes.filter((c) => c.kind === kind), ids = new Set(cs.map((c) => c.id))
    return [...list.filter((x) => !ids.has(x.id)), ...cs.flatMap((c) => (c.after ? [c.after as unknown as T] : []))]
  }
  const environments = put(w.environments, 'environment')
  const g = changes.find((c) => c.kind === 'globals')
  return {
    collections: put(w.collections, 'collection'), folders: put(w.folders, 'folder'), requests: put(w.requests, 'request'), environments,
    globals: g ? (g.after as KV[] | null) ?? [] : w.globals, active: environments.find((e) => e.id === w.active?.id) ?? null,
  }
}

// ---- checks ----

/** Why this place can't be meant, before the edit code picks the first that fits or makes what isn't there. */
function badPlace(tool: string, path: string, collections: Collection[], folders: Folder[]): string | null {
  const p = path.trim().replace(/^\/+|\/+$/g, '')
  const segs = p.split('/').map((s) => s.trim()).filter(Boolean)
  if (!segs.length || (tool === 'set_variables' && segs.length > 1)) return `Name ${tool === 'set_variables' ? 'one collection' : 'a collection, or a folder in one'}, like “Orders”.`
  if (segs[0] === 'assistant' || p.startsWith(ASSISTANT_PREFIX)) {
    // the edit code takes this for its own workspace, unless it finds the collection and its folder
    const c = collections.find((x) => x.name === 'assistant')
    if (!c || (segs[1] && !folders.some((f) => f.collectionId === c.id && f.parentId === null && f.name === segs[1]))) return `“${path}” isn’t in the open workspace, and can’t be made under that name.`
  }
  const several = (what: string, seg: string) => `There is more than one ${what} “${seg}” there. Ask the person to rename one.`
  const cols = collections.filter((c) => c.name === segs[0])
  if (cols.length > 1) return several('collection', segs[0])
  let parent: string | null = null
  for (const seg of cols.length ? segs.slice(1) : []) {
    const fs: Folder[] = folders.filter((f) => f.collectionId === cols[0].id && f.parentId === parent && f.name === seg)
    if (fs.length > 1) return several('folder', seg)
    if (!fs.length) break
    parent = fs[0].id
  }
  return null
}

/** Without what no tool changes and what can be large. */
export const light = (r: RequestDef): RequestDef => ({ ...r, examples: [], body: { ...r.body, file: null, fields: r.body.fields.map((f) => ({ ...f, file: null })) } })

/** Which of the fields an update names hold something hidden, whether or not it would change. */
function heldInRequest(input: Record<string, unknown>, real: RequestDef, cl: Cleaner): string | null {
  const r = light(real), s = cl.deep(r)
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
  const on = (l: KV[]) => l.filter((p) => p.enabled)
  if (given(input.newName) && s.name !== r.name) return 'name'
  if (given(input.url) && (s.url !== r.url || differs(on(s.params), on(r.params)))) return 'URL'
  if (given(input.docs) && s.docs !== r.docs) return 'docs text'
  if ((given(input.preRequestScript) && s.scripts.pre !== r.scripts.pre) || (given(input.testScript) && s.scripts.post !== r.scripts.post)) return 'script'
  if ((given(input.body) || given(input.bodyType)) && (s.body.text !== r.body.text || (r.body.kind === 'graphql' && s.body.graphqlVariables !== r.body.graphqlVariables) || (BODY_FIELDS.includes(r.body.kind) && differs(s.body.fields, r.body.fields)))) return 'body'
  for (const [k, v] of Object.entries((input.headers as Record<string, string>) ?? {})) {
    const i = r.headers.findIndex((h, n) => h.key.toLowerCase() === k.toLowerCase() && differs(s.headers[n], h))
    if (i >= 0 && !IS_VAR.test(String(v))) return `header “${s.headers[i].key}”`
  }
  return null
}

/** Why these variables can't be set or removed. A secret one never can, whatever its value and the case it is in. */
export function badVariables(input: Record<string, unknown>, vars: KV[], cl: Cleaner): string | null {
  const set = Object.keys((input.variables as object) ?? {}), drop = (input.remove as string[] | undefined) ?? []
  for (const k of [...set, ...drop]) if (vars.some((v) => v.key.trim() === k.trim() && isSecret(v, cl))) return `The variable “${k}” is secret, so it can’t be set or removed here. Ask the person to do it.`
  const odd = set.find((k) => !/^[^{}\s]+$/.test(k))
  if (odd !== undefined) return `“${odd}” can’t be a variable’s name: no spaces or braces, and not empty.`
  if (set.some((k) => drop.includes(k))) return 'A variable can’t be set and removed at once.'
  return null
}

const isSecret = (v: KV, cl: Cleaner) => !!v.secret || JSON.stringify(cl.deep(v)) !== JSON.stringify(v)

const SCRIPT_RISK = 'Scripts run when this is sent. They can read variables, including secrets, and send requests.'
const LABELS: Record<string, string> = { url: 'URL', params: 'URL', docs: 'docs text', scripts: 'script', auth: 'sign-in', headers: 'list of headers', pathVars: 'list of path variables', variables: 'list of variables' }
/** The first part of a record whose hidden text would be replaced or removed, or null. */
export function lost(before: Rec, after: Rec, cl: Cleaner): string | null {
  if (Array.isArray(before)) return hiddenGone(before, cl.deep(before), after, 'variables') ? 'variables' : null
  const b = 'body' in before ? light(before) : before
  const shown = cl.deep(b) as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(b)) if (hiddenGone(v, shown[k], (after as unknown as Record<string, unknown>)[k], k)) return LABELS[k] ?? k
  return null
}
function hiddenGone(b: unknown, shown: unknown, a: unknown, at: string, key = ''): boolean {
  if (typeof b === 'string') return b !== a && (b !== shown || (at === 'auth' && AUTH_SECRETS.has(key) && !!b && !IS_VAR.test(b)))
  if (!b || typeof b !== 'object') return false
  if (Array.isArray(b)) {
    return b.some((x, i) => {
      const id = (x as { id?: unknown } | null)?.id
      const y = !Array.isArray(a) ? undefined : id === undefined ? a[i] : a.find((z) => canonical(z) === canonical(x as Rec)) ?? a.find((z) => z?.id === id) // ids can repeat
      // a header may be replaced by a lone variable
      if (at === 'headers' && y && IS_VAR.test(y.value)) return false
      return hiddenGone(x, (shown as unknown[])[i], y, at)
    })
  }
  return Object.entries(b).some(([k, x]) => hiddenGone(x, (shown as Record<string, unknown>)[k], (a as Record<string, unknown> | undefined)?.[k], at, k))
}

// ---- putting back what a tool didn't mean to change ----

/** With alternatives, the active one follows the value. */
export const inStep = (v: KV): KV => (v.options?.some((o) => o.name === v.active && o.value !== v.value) ? { ...v, options: v.options.map((o) => (o.name === v.active ? { ...o, value: v.value } : o)) } : v)

/** The parts the edit code made anew or left out on the way, as they were. */
function asItWas(r: RequestDef, was: RequestDef | undefined, kindGiven: boolean): RequestDef {
  if (!was) return r
  const out = { ...r, ...(was.handoff ? { handoff: was.handoff } : {}) }
  if (r.url === was.url) out.params = was.params
  if (r.collectionId === was.collectionId && r.folderId === was.folderId) out.sort = was.sort
  // text given as it is, without a kind, keeps its kind
  if (!kindGiven && r.body.text === was.body.text && TEXT_BODIES.includes(was.body.kind) && r.body.kind !== 'none') out.body = was.body
  out.headers = r.headers.map((h) => {
    const b = was.headers.includes(h) ? undefined : was.headers.find((x) => x.key.toLowerCase() === h.key.toLowerCase())
    return b ? { ...b, key: h.key, value: h.value } : h
  })
  return out
}

// ---- the card ----

function titleOf(tool: string, changes: Change[], sources: Map<string, RequestDef>): string {
  const main = changes.at(-1)
  if (!main) return ''
  const n = ((main.before ?? main.after) as { name: string }).name
  switch (tool) {
    case 'create_request': return `New request “${n}”`
    case 'copy_request': return `Copy “${sources.get(main.id)?.name ?? n}”`
    case 'move_request': return `Move “${n}”`
    case 'delete_request': return `Delete “${n}”`
    case 'set_variables': return `Change the variables of “${n}”`
    case 'set_scripts': return `Change the scripts of “${n}”`
    default: return `Change “${n}”`
  }
}

/** Both texts ready to be drawn. */
function diffField(label: string, before: string, after: string): Field | null {
  if (before === after) return null
  const split = (s: string, type: 'add' | 'del') => s.split('\n').map((text): Line => ({ type, text }))
  const lines: Line[] = before === '' ? split(after, 'add') : after === '' ? split(before, 'del')
    : withContext(diffLines(before, after)).map((l) => (l.type === 'gap' ? { type: 'gap', text: plural(l.count, 'unchanged line') } : l))
  return { label, lines }
}

/**
 * What is different now from what was applied, for the card of an undo that was refused: cleaned and drawn as a proposal
 * is, also of the secrets its records held and of `also`. Nothing the model supplied is shown exactly here.
 */
export function changedSince(p: Proposal, w: McpServeOptions, now: (kind: Change['kind'], id: string) => Rec | null, ctx: Parameters<typeof cleaner>[0], also: string[]): Field[] {
  if (w.settings.activeSpaceId !== p.spaceId) return []
  const since = p.changes.map((c): Change => ({ ...c, before: c.after, after: now(c.kind, c.id) }))
  const recs = [...p.changes, ...since].flatMap((c) => [c.before, c.after].map((r) => ({ kind: c.kind, r })))
  const of = <T>(...kinds: Change['kind'][]) => recs.flatMap((x) => (x.r && kinds.includes(x.kind) ? [x.r as T] : []))
  const held = allSecrets({ environments: of('environment'), globals: of<KV[]>('globals').flat(), collections: of('collection'), folders: of('folder'), requests: of('request'), connections: [], signIns: [], cookies: [], clientCerts: [] })
  const cl = cleaner(ctx, w, [...also, ...held])
  const world = openWorld(w, p.spaceId)
  const d: Draft = { tool: p.tool, title: '', changes: [], reply: '' }
  return since.flatMap((c) => fieldsOf(c, applied(world, p.changes), world, d, cl))
}

function fieldsOf(c: Change, before: World, after: World, d: Draft, cl: Cleaner): Field[] {
  const made = new Set(d.changes.filter((x) => !x.before).map((x) => x.id))
  const side = (rec: Rec | null, w: World, exact: Exact): [string, string][] => {
    if (!rec) return []
    if (c.kind === 'request') return requestTexts(rec as RequestDef, w, exact, cl, made)
    if (c.kind === 'globals' || c.kind === 'environment') return [['Variables', variablesText(Array.isArray(rec) ? rec : (rec as Environment).variables, exact, cl)]]
    const x = rec as Collection | Folder
    const fresh = made.has(x.id)
    return [
      ...(!fresh ? [] : c.kind === 'collection' ? [['New collection', x.name] as [string, string]] : [['New folder', placeText(w, (x as Folder).collectionId, x.id, cl, made)] as [string, string]]),
      ...('variables' in x ? [['Variables', variablesText(x.variables, exact, cl)] as [string, string]] : []),
      ['Pre-request script', exact.pre ? x.scripts.pre : cl.clean(x.scripts.pre)], ['After-response script', exact.post ? x.scripts.post : cl.clean(x.scripts.post)],
    ]
  }
  const was = new Map(side(c.before, before, {})), now = new Map(side(c.after, after, d.exact ?? {}))
  return [...new Set([...now.keys(), ...was.keys()])].flatMap((label) => diffField(label, drawn(was.get(label) ?? ''), drawn(now.get(label) ?? '')) ?? [])
}

const placeText = (w: World, collectionId: string | null, folderId: string | null, cl: Cleaner, made: Set<string>) =>
  [...w.collections.filter((c) => c.id === collectionId), ...folderChain(w.folders, folderId).reverse()].map((x) => oneLine(made.has(x.id) ? x.name : cl.clean(x.name))).join(' / ')

/** One row per entry: a line break in one is drawn, so it can't look like another. */
const rows = (l: KV[], shown: KV[], exact: (v: KV) => boolean, sep: string) =>
  l.map((v, i) => { const x = exact(v) ? v : shown[i]; return `${v.enabled === false ? '(off) ' : ''}${oneLine(x.key)}${sep}${oneLine(x.value)}` }).join('\n')
const variablesText = (l: KV[], exact: Exact, cl: Cleaner) => rows(l, cl.deep(l), (v) => !v.secret && exact.variables?.get(v.key) === v.value, ' = ')

function requestTexts(real: RequestDef, w: World, exact: Exact, cl: Cleaner, made: Set<string>): [string, string][] {
  const r = light(real), s = cl.deep(r)
  const b = r.body
  const body = b.kind === 'none' ? '' : b.kind === 'binary' ? `A file: ${cl.clean(real.body.file?.name ?? 'none')}`
    : BODY_FIELDS.includes(b.kind) ? rows(b.fields, s.body.fields, () => false, ': ')
      : [exact.body ? b.text : s.body.text, ...(b.kind === 'graphql' && s.body.graphqlVariables ? [`Variables: ${s.body.graphqlVariables}`] : [])].join('\n')
  return [
    ['Name', exact.name ? r.name : s.name], ['In', placeText(w, r.collectionId, r.folderId, cl, made)], ['Method', r.method], ['URL', exact.url ? r.url : s.url],
    ['Path variables', rows(r.pathVars, s.pathVars, () => false, ': ')], ['Headers', rows(r.headers, s.headers, (h) => exact.headers?.get(h.key.toLowerCase()) === h.value, ': ')],
    ['Auth', authText(r.auth, cl)], ['Body type', b.kind === 'none' ? '' : b.kind], ['Body', body], ['Docs', exact.docs ? r.docs : s.docs],
    ['Pre-request script', exact.pre ? r.scripts.pre : s.scripts.pre], ['After-response script', exact.post ? r.scripts.post : s.scripts.post],
  ]
}

function authText(a: Auth, cl: Cleaner): string {
  if (a.kind === 'inherit') return ''
  const of = a as unknown as Record<string, unknown>
  return [a.kind, ...(AUTH_FIELDS[a.kind] ?? []).filter((k) => of[k]).map((k) => `${k}: ${AUTH_SECRETS.has(k) && !IS_VAR.test(String(of[k])) ? HIDDEN : oneLine(cl.clean(String(of[k])))}`)].join('\n')
}

// ---- warnings ----

const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
const on = (l: KV[]) => l.filter((x) => x.enabled !== false)
const collectionOf = (r: RequestDef, w: World) => w.collections.find((c) => c.id === r.collectionId) ?? null
const authOf = (r: RequestDef, w: World) => { const a = effectiveAuth(r, collectionOf(r, w), folderChain(w.folders, r.folderId)); return a && a.kind !== 'none' && a.kind !== 'inherit' ? a : null }

/** Every text that is filled in when the request is sent, by where it goes. */
function sentTexts(r: RequestDef, w: World): Record<string, string[]> {
  const b = r.body
  const body = b.kind === 'none' || b.kind === 'binary' ? [] : BODY_FIELDS.includes(b.kind) ? on(b.fields).flatMap((f) => [f.key, f.value]) : [b.text, ...(b.kind === 'graphql' ? [b.graphqlVariables] : [])]
  const own = r.protocol === 'socketio' ? r.sio : r.protocol === 'http' || r.protocol === 'sse' ? null : r[r.protocol]
  return { url: [r.url], path: r.pathVars.map((v) => v.value), headers: on(r.headers).flatMap((h) => [h.key, h.value]), body, auth: strings(authOf(r, w)), own: strings(own) }
}

/** The variables a text can come to use, through other variables too, in whichever environment. */
function reach(texts: string[], collectionId: string | null, w: World, r?: RequestDef): Map<string, KV[]> {
  const all = on([...w.globals, ...(r?.handoff?.variables ?? []), ...(w.collections.find((c) => c.id === collectionId)?.variables ?? []), ...w.environments.flatMap((e) => e.variables)])
  const out = new Map<string, KV[]>()
  const queue = texts.flatMap(namesIn)
  for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
    if (out.has(n)) continue
    const vs = all.filter((v) => v.key.trim() === n)
    out.set(n, vs)
    queue.push(...vs.flatMap((v) => [v.value, ...(v.options ?? []).map((o) => o.value)]).flatMap(namesIn))
  }
  return out
}
const usesOf = (r: RequestDef, w: World) => reach(Object.values(sentTexts(r, w)).flat(), r.collectionId, w, r)
/** The secret ones by name, with what tells one `token` from another. */
const secretsIn = (vars: Map<string, KV[]>, cl: Cleaner) =>
  new Map([...vars].flatMap(([n, vs]) => { const s = vs.filter((v) => isSecret(v, cl)); return s.length ? [[n, JSON.stringify(s.map((v) => v.value))] as const] : [] }))

/** The same by place: a secret put where it wasn't is a new use, also when another place has it. */
const secretPlaces = (r: RequestDef, w: World, cl: Cleaner) =>
  new Map(Object.entries(sentTexts(r, w)).flatMap(([place, texts]) => [...secretsIn(reach(texts, r.collectionId, w, r), cl)].map(([n, sig]) => [`${place} ${n}`, { n, sig }] as const)))

const fill = (s: string, scope: Map<string, string>) => {
  let out = s
  // a variable that names itself many times must not grow without end
  for (let i = 0; i < 5 && out.length < 10_000; i++) out = out.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, n: string) => scope.get(n) ?? m)
  return out
}
/**
 * `key` is for comparing only: it can hold secrets. `unset`: all of the authority is one {{name}} that nothing gives a
 * value. Anything else left to fill in still leads somewhere: dynamic names and scripts fill it, and braces can be sent.
 */
interface Address { key: string; source: 'url' | 'tokenUrl' | 'authUrl'; url: string; environment: Environment | null; unset: boolean }
const leadOf = (t: string) => /^[a-z][a-z0-9+.-]*:\/\/[^/\\?#]*/i.exec(t)?.[0] ?? splitUrl(t).base
/** Scheme and host as a URL parser sees them; null when there is something left to fill in or it isn't a URL. */
const parsed = (t: string): { key: string; host: string } | null => {
  if (leadOf(t).includes('{{')) return null
  try { const u = new URL(t); return u.host ? { key: `${u.protocol}//${u.host}`, host: u.host } : null } catch { return null }
}
/** Where a request and its sign-in are sent in an environment, or how the URL starts when that can't be told. */
function addresses(r: RequestDef, w: World, environment: Environment | null): Address[] {
  const a = authOf(r, w)
  const scope = scopeFor({ collection: collectionOf(r, w), environment, globals: w.globals, handoff: r.handoff?.variables ?? null })
  const of = (source: Address['source'], url: string): Address[] => {
    const t = withScheme(fill(url, scope))
    if (!t) return []
    const lead = leadOf(t)
    const only = /^[a-z][a-z0-9+.-]*:\/\/\{\{\s*([^{}\s]+)\s*\}\}$/i.exec(lead)?.[1]
    return [{ key: parsed(t)?.key ?? lead, source, url, environment, unset: only !== undefined && !scope.has(only) && !(only in FAKE) }]
  }
  return [...of('url', r.url), ...(a?.kind === 'oauth2' ? [...of('tokenUrl', a.tokenUrl), ...of('authUrl', a.authUrl)] : [])]
}
/**
 * An address as the person may see it: secret variables stay as {{name}}, and the text is cleaned before a URL parser
 * can change it, because a secret in lower case or cut short isn't recognised any more.
 */
function shownAddress(a: Address, r: RequestDef, w: World, cl: Cleaner): { key: string; host: string } {
  const scope = new Map<string, string>()
  for (const l of [w.globals, r.handoff?.variables ?? [], collectionOf(r, w)?.variables ?? [], a.environment?.variables ?? []]) {
    for (const v of on(l)) { if (isSecret(v, cl)) scope.delete(v.key.trim()); else scope.set(v.key.trim(), v.value) }
  }
  const t = cl.clean(withScheme(fill(a.url, scope)))
  const lead = leadOf(t).replace(/\/\/.*@/s, '//')
  return parsed(t) ?? { key: lead, host: lead.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') }
}

/** Whether something secret goes along: a sign-in, a header by its name, a hidden text, a secret variable. */
function carriesSecret(r: RequestDef, w: World, cl: Cleaner): boolean {
  if (authOf(r, w) || on(r.headers).some((h) => h.value && SECRET_NAME.test(h.key))) return true
  const parts = { url: r.url, headers: on(r.headers), pathVars: r.pathVars, body: light(r).body }
  return JSON.stringify(cl.deep(parts)) !== JSON.stringify(parts) || secretsIn(usesOf(r, w), cl).size > 0
}

/** `moved`: its sign-in is the same as before, only in a variable now. */
function newAddresses(r: RequestDef, was: RequestDef | undefined, before: World, after: World, cl: Cleaner, moved: boolean): string[] {
  const signIn = authOf(r, after)
  const same = (a: Auth | null) => canonical(a as unknown as Rec | null) === canonical(signIn as unknown as Rec | null)
  // each environment against itself before the change, the active one first
  const environments = [after.active, ...[null, ...after.environments].filter((e) => e !== after.active)]
  const fresh: { a: Address; known: { x: RequestDef; a: Address }[] }[] = environments.flatMap((e) => {
    const old = e && (before.environments.find((x) => x.id === e.id) ?? null)
    // a new request: where its sign-in (or, without one, anything here) goes already
    const from = was ? (!moved && signIn && !same(authOf(was, before)) ? [] : [was]) : before.requests.filter((x) => !signIn || same(authOf(x, before)))
    const known = from.flatMap((x) => addresses(x, before, old).flatMap((a) => [
      a,
      // it has no address here so far: what the active environment makes of the same URL isn't new
      ...(a.unset ? addresses(x, before, before.active).filter((b) => b.source === a.source) : []),
    ].map((b) => ({ x, a: b }))))
    return addresses(r, after, e).filter((a) => (!a.unset || e === after.active) && !known.some((k) => k.a.source === a.source && k.a.key === a.key)).map((a) => ({ a, known }))
  })
  if (!fresh.length || !carriesSecret(r, after, cl)) return []
  return fresh.map(({ a, known }) => {
    const s = shownAddress(a, r, after, cl)
    // the same host on another scheme is named with it
    return known.some((k) => k.a.source === a.source && shownAddress(k.a, k.x, before, cl).host === s.host) ? s.key : s.host
  })
}

function warningsOf(d: Draft, before: World, after: World, schedules: Schedule[], cl: Cleaner): string[] {
  const out = new Set<string>()
  const safe = (s: string) => oneLine(cl.clean(s))
  const was = byId(before.requests)
  const origin = (r: RequestDef) => was.get(r.id) ?? d.sources?.get(r.id)

  let ran: Set<string> | null = null
  for (const c of d.changes) {
    if (c.kind !== 'request' && c.kind !== 'collection' && c.kind !== 'folder') continue
    const now = c.after as Collection | Folder | RequestDef | null
    if (!now) continue
    const old = (c.before ?? (c.kind === 'request' ? d.sources?.get(c.id) : null)) as typeof now | null | undefined
    const changed = (['pre', 'post'] as const).filter((k) => now.scripts[k] !== (old?.scripts[k] ?? ''))
    if (changed.some((k) => !isEmpty(now.scripts[k]))) out.add(SCRIPT_RISK)
    if (changed.length && c.kind !== 'request') ran = new Set([...(ran ?? []), ...itemsOf(after, c.kind === 'folder' ? (now as Folder).collectionId : c.id, c.kind === 'folder' ? c.id : null)])
  }
  if (ran) out.add(`Runs for ${plural(ran.size, 'request')}.`)

  // Moved or copied to where other scripts run for it.
  const runsFor = (r: RequestDef, w: World) => [...folderChain(w.folders, r.folderId), ...w.collections.filter((c) => c.id === r.collectionId)].filter((x) => !isEmpty(x.scripts.pre) || !isEmpty(x.scripts.post)).map((x) => x.id)
  for (const r of after.requests) {
    const o = d.changes.some((c) => c.id === r.id) && origin(r)
    if (o && (o.collectionId !== r.collectionId || o.folderId !== r.folderId) && runsFor(r, after).some((id) => !runsFor(o, before).includes(id))) out.add(SCRIPT_RISK)
  }

  // A change of anything else than requests can reach them all.
  const tables = d.changes.filter((c) => c.kind === 'collection' || c.kind === 'environment' || c.kind === 'globals')
  const ids = new Set(d.changes.map((c) => c.id))
  const reached = after.requests.filter((r) => tables.length || ids.has(r.id))
  for (const r of reached) for (const host of newAddresses(r, origin(r), before, after, cl, !!d.moved && ids.has(r.id))) out.add(`Its sign-in would go to a new address: ${safe(host)}.`)

  const uses = (n: string) => out.add(`Uses {{${safe(n)}}}, which is secret.`)
  for (const r of reached) {
    const o = origin(r)
    const old = o && secretPlaces(o, before, cl)
    const texts = o && d.moved && ids.has(r.id) ? sentTexts(o, before) : null
    // a bearer token goes from its header to the sign-in
    if (texts) texts.auth.push(...on(o!.headers).filter((h) => h.key.toLowerCase() === 'authorization').map((h) => h.value))
    for (const [place, { n, sig }] of secretPlaces(r, after, cl)) {
      if (old?.get(place)?.sig === sig) continue
      // moved: the value was there already, and there is no other by that name
      const value = d.moved?.get(n)
      if (value !== undefined && texts?.[place.slice(0, place.indexOf(' '))].some((t) => t.includes(value)) && (JSON.parse(sig) as string[]).every((v) => v === value)) continue
      uses(n)
    }
  }
  const changedNames: { name: string; collectionId: string | null }[] = []
  for (const c of tables) {
    const list = (r: Rec | null): KV[] => (!r ? [] : Array.isArray(r) ? r : (r as Collection).variables)
    const collectionId = c.kind === 'collection' ? c.id : null
    const old = list(c.before), now = list(c.after)
    if (!c.before && c.kind === 'collection') continue // a new collection has the variables of the one its request comes from
    for (const name of new Set([...old, ...now].map((v) => v.key.trim()))) {
      const at = (l: KV[]) => JSON.stringify(l.filter((v) => v.key.trim() === name && v.enabled !== false).map((v) => v.value))
      if (at(old) === at(now)) continue
      changedNames.push({ name, collectionId })
      const texts = (l: KV[]) => l.filter((v) => v.key.trim() === name).map((v) => v.value)
      const had = secretsIn(reach(texts(old), collectionId, before), cl)
      for (const n of secretsIn(reach(texts(now), collectionId, after), cl).keys()) if (!had.has(n)) uses(n)
    }
  }
  const users = changedNames.length ? before.requests.filter((r) => { const u = usesOf(r, before); return changedNames.some((x) => u.has(x.name) && (!x.collectionId || x.collectionId === r.collectionId)) }).length : 0
  if (users) out.add(`Used by ${plural(users, 'request')}.`)

  for (const s of schedules) if (s.enabled && d.changes.some((c) => usedBy(s, c, before, after))) out.add(`The schedule “${safe(s.name)}” sends this while Dispatch is open.`)
  return [...out]
}

/** The requests a run of a collection or folder sends. */
const itemsOf = (w: World, collectionId: string, folderId: string | null): string[] => {
  const c = w.collections.find((x) => x.id === collectionId)
  return c ? collectItems(c, folderId, w.folders, w.requests).map((it) => it.request.id) : []
}

/** Whether a schedule sends what is changed, or sends with it, before or after. */
function usedBy(s: Schedule, c: Change, before: World, after: World): boolean {
  switch (c.kind) {
    case 'globals': return true
    case 'environment': return s.environmentId === c.id
    case 'collection': return s.collectionId === c.id
    case 'request': return [before, after].some((w) => itemsOf(w, s.collectionId, s.folderId).includes(c.id))
    case 'folder': return [before, after].some((w) => {
      const f = w.folders.find((x) => x.id === c.id)
      if (!f || f.collectionId !== s.collectionId) return false
      const start = w.folders.find((x) => x.id === s.folderId) // a folder that is gone means the whole collection
      return !start || folderChain(w.folders, f.id).includes(start) || folderChain(w.folders, start.id).includes(f)
    })
  }
}
