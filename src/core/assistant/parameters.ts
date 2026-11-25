/**
 * Moving values into variables without the model seeing them: it is told what could move (suggest_parameters), picks by
 * id, and the value goes from the request to the variable here. Also environment variables in general.
 *
 * Which values match, and which places change, must not tell what is hidden: a plain value matches and is replaced only
 * where the model can read it anyway, and nothing is replaced when that would leave a part of a secret readable.
 */
import { FAKE } from '../fake'
import type { McpServeOptions } from '../mcpHandler'
import { type AssistantChanges, AUTH_FIELDS, AUTH_SECRETS, BODY_LIMIT, HIDDEN, hide, hideInText, shownText } from '../mcpWorkspace'
import { knownSecrets, Redactor } from '../mcpLogs'
import { addVariables, type KnownVar, knownVars, suggest, type Suggestion } from '../parameterize'
import { effectiveAuth, pathVarNames, pathVarsFromUrl, prepare, scopeFor } from '../prepare'
import { folderChain } from '../runtime'
import { SECRET_NAME } from '../share'
import { type Auth, type Collection, emptyAuth, emptyBody, type Environment, kv, type KV, type RequestDef } from '../types'
import { paramsFromUrl, splitUrl } from '../url'
import { interpolate } from '../vars'
import type { Found, ParameterBatches } from './batches'
import { cleaner, cleanerOf } from './clean'
import { canonical, type Change } from './proposal'
import { badVariables, BODY_FIELDS, type Cleaner, cleanWorld, type Draft, held, inStep, light, lost, oneLine, type ProposeContext, type Refused } from './propose'
export { ParameterBatches } from './batches'

const text = { type: 'string' }
export function parameterTools() {
  return [
    {
      name: 'suggest_parameters',
      description: 'List what is written into a saved request and could be moved into {{variables}} (base URL, tokens, API keys, passwords, IDs in the path, values that a variable already has), one per line: id · what · the variable · new or existing · secret. No values are shown. Use the ids and the batch with apply_parameters.',
      inputSchema: { type: 'object', properties: { name: { ...text, description: 'The path from list_requests.' } }, required: ['name'] },
    },
    {
      name: 'apply_parameters',
      description: 'Move values that suggest_parameters listed into variables. Dispatch moves the values itself, also the ones you can’t see; tokens, keys and passwords become secret variables. The person decides.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { ...text, description: 'The request, as for suggest_parameters.' }, batch: { ...text, description: 'The batch suggest_parameters gave.' },
          choose: { type: 'object', additionalProperties: text, description: 'The ids to move, each with the name for its variable, or "" for the suggested name.' },
          where: { type: 'string', enum: ['environment', 'collection', 'globals'], description: 'Where new variables go: the active environment, the request’s collection, or the globals.' },
        },
        required: ['name', 'batch', 'choose', 'where'],
      },
    },
    {
      name: 'set_environment_variables',
      description: 'Set or remove variables of an environment. Secret ones can’t be set or removed, and a new one with a secret’s name (token, password, key …) is made secret and empty for the person to fill in. The person decides.',
      inputSchema: {
        type: 'object',
        properties: {
          environment: { ...text, description: 'The environment; leave out for the active one.' },
          variables: { type: 'object', additionalProperties: text, description: 'Names and values to set.' },
          remove: { type: 'array', items: text, description: 'Names to remove.' },
        },
      },
    },
  ]
}

/** What a request's {{names}} come from, as it is sent now. */
interface Tables { environment: Environment | null; collection: Collection | null; globals: KV[]; handoff: KV[] }
const tablesOf = (r: RequestDef, w: McpServeOptions, active: Environment | null): Tables =>
  ({ environment: active, collection: w.ws.collections.find((c) => c.id === r.collectionId) ?? null, globals: w.globals, handoff: r.handoff?.variables ?? [] })
const rowsOf = (t: Tables) => [...(t.environment?.variables ?? []), ...(t.collection?.variables ?? []), ...t.handoff, ...t.globals]
/** The state a batch belongs to. Holds real values, so it stays here. */
const stateOf = (r: RequestDef, t: Tables) => JSON.stringify([canonical(r), t.environment?.id, ...[t.environment?.variables, t.collection?.variables, t.globals].map((l) => canonical(l ?? []))])

/**
 * A text of a request as the one who asks sees it. The first is what counts as read, and only that is replaced; the others
 * are the other ways it is shown, where nothing more may come out either.
 */
type View = (s: string, at: 'url' | 'username' | 'text' | 'graphql' | 'header' | 'field', key?: string) => string[]
const chatView = (cl: Cleaner): View => (s, _at, key) => [key === undefined ? cl.clean(s) : cl.deep({ key, value: s }).value]
/** For an outside assistant: get_request shows fewer texts, and hides by pattern and name only. */
const outsideView = (r: RequestDef, cl: Cleaner): View => (s, at, key) => {
  const kind = r.body.kind, form = BODY_FIELDS.includes(kind)
  const unseen = at === 'graphql' || (at === 'field' && !form) || (at === 'text' && (form || kind === 'none' || kind === 'binary' || s.length > BODY_LIMIT)) || (at === 'username' && !AUTH_FIELDS[r.auth.kind]?.includes('username'))
  // A long body is shown only up to a point, which would move with the text before it.
  return [unseen ? HIDDEN : chatView(cl)(s, at, key)[0], at === 'header' ? hideInText(hide(key!, s)) : at === 'field' ? hide(key!, s) : at === 'text' ? shownText(s) : at === 'url' ? hideInText(s) : s]
}

const named = (v: KV) => !!v.secret || SECRET_NAME.test(v.key)
/** Shorter ones aren't hidden where they are in a text. */
const KNOWN = 6
const NAME = /^[^{}\s]+$/
const IS_VAR = /^\s*\{\{[^{}]+\}\}\s*$/

/**
 * What could move. Which lines there are, their order, names and ids tell nothing about a hidden value but this: that a
 * variable marked secret is in the request. Everything else comes from what can be read (`clean` is what hides secrets
 * from the model; without one, every secret in `w` is hidden), or from a credential's place alone.
 * With `outside`, for an assistant that sees a request so and can give any variable a value, also a marked one: those match
 * nothing then, and a base URL that holds a secret stays, as get_request would show it in its variable.
 */
export function suggestionsFor(r: RequestDef, w: McpServeOptions, clean: (s: string) => string = defaultClean(w), active: Environment | null = w.environment, outside?: View): Found[] {
  const t = tablesOf(r, w, active)
  const b = r.body
  const url = clean(r.url)
  const see: View = outside ?? ((s, _at, key) => [clean(key === undefined ? s : hide(key, s))])
  const shown = [
    url, ...r.headers.map((h) => see(h.value, 'header', h.key)[0]), see(r.auth.username, 'username')[0],
    ...(b.kind === 'none' || b.kind === 'binary' ? [] : BODY_FIELDS.includes(b.kind) ? b.fields.map((f) => see(f.value, 'field', f.key)[0]) : [see(b.text, 'text')[0], ...(b.kind === 'graphql' ? [see(b.graphqlVariables, 'graphql')[0]] : [])]),
  ].join('\n')
  const all = [r.url, ...r.headers.map((h) => h.value), b.text, ...b.fields.map((f) => f.value), r.auth.token, r.auth.value, r.auth.username, r.auth.password].join('\n')
  const rows = rowsOf(t).filter((v) => v.enabled)
  const row = (k: KnownVar) => rows.filter((v) => v.key.trim() === k.key && v.value === k.value)
  const usable = knownVars(t.environment, t.collection, t.globals, t.handoff).filter((k) => k.value.length >= 4 && !IS_VAR.test(k.value) && NAME.test(k.key))
  // One with a secret's name that isn't marked is never offered: the model may have set it, to try a guess.
  const marked = outside ? [] : usable.filter((k) => row(k).some((v) => v.secret) && k.value.trim().length >= KNOWN && all.includes(k.value))
  const plain = usable.filter((k) => !row(k).some(named) && shown.includes(k.value))
  const existing = usable.filter((k) => marked.includes(k) || plain.includes(k)).map((k): Found => ({ id: '', kind: 'existing', title: '', detail: '', varName: k.key, value: k.value, create: false, secret: marked.includes(k) }))

  const taken = [...rowsOf(t).map((v) => v.key.trim()), ...pathNames(r)]
  const ask = (part: Partial<RequestDef>, known: KnownVar[]) => {
    const got = suggest({ ...r, url: '', headers: [], pathVars: [], auth: emptyAuth('none'), body: emptyBody('none'), ...part }, known, taken).filter((s) => s.kind !== 'existing')
    taken.push(...got.map((s) => s.varName))
    return got
  }
  const origin = /^https?:\/\/[^/{}]+/i.exec(splitUrl(r.url).base)?.[0]
  const inUrl = ask({ url }, plain)
  const base = origin && !plain.some((k) => url.startsWith(k.value)) ? inUrl.filter((s) => s.kind === 'baseUrl').map((s): Found => ({ ...s, value: origin, secret: hideInText(origin) !== origin || !url.includes(origin) })) : []
  // Each place by itself, so that equal ones don't show as such.
  const credentials = [...r.headers.flatMap((h, header) => ask({ headers: [h] }, marked).map((s): Found => ({ ...s, header }))), ...ask({ auth: r.auth }, marked)]
  return [...existing, ...base.filter((s) => !outside || !s.secret), ...credentials, ...inUrl.filter((s) => s.kind === 'pathId')].map((s, i) => ({ ...s, id: `${s.kind}:${i}` }))
}
const defaultClean = (w: McpServeOptions) => {
  const known = new Redactor(knownSecrets({ environments: [...w.ws.environments, ...(w.environment ? [w.environment] : [])], globals: w.globals, collections: w.ws.collections, folders: w.ws.folders, requests: w.ws.requests, extra: [w.settings.mcpHostToken] }))
  return (s: string) => known.clean(s)
}
const pathNames = (r: RequestDef) => [...pathVarNames(r.url), ...r.pathVars.map((p) => p.key)]
/** Its lines, made here: the titles and details of suggest() hold values. */
export function suggestionLines(r: RequestDef, list: Found[]): string[] {
  const what = (s: Found) => {
    switch (s.kind) {
      case 'existing': return 'a value that a variable already has'
      case 'baseUrl': return 'base URL'
      case 'bearer': return 'bearer token'
      case 'apiKeyHeader': return s.header === undefined ? 'API key of the sign-in' : `API key in the header ${r.headers[s.header].key}`
      case 'basic': return 'sign-in password'
      case 'pathId': return 'ID in the path'
    }
  }
  return list.map((s) => oneLine([s.id, what(s), s.kind === 'pathId' ? `:${s.varName}` : `{{${s.varName}}}`, s.kind === 'existing' ? 'existing' : 'new', ...(s.secret ? ['secret'] : [])].join(' · ')))
}

const NOTHING = 'Nothing to move: no base URL, sign-in, key or ID written into it, and no value that a variable has.'

/** The suggest_parameters tool. The gate hides, cuts and marks what it answers. */
export function suggestParameters(input: Record<string, unknown>, ctx: ProposeContext, w: McpServeOptions): { text: string; isError: boolean } {
  const cl = cleaner(ctx, w)
  const { real, lookup } = cleanWorld(w, ctx.spaceId, cl)
  const found = lookup(String(input.name ?? ''))
  if ('error' in found) return { text: found.error, isError: true }
  const r = real.requests.find((x) => x.id === found.it.request.id)!
  const list = suggestionsFor(r, w, cl.clean, real.active)
  if (!list.length) return { text: NOTHING, isError: false }
  return { text: [`batch: ${ctx.batches.add(stateOf(r, tablesOf(r, w, real.active)), list)}`, ...suggestionLines(r, list)].join('\n'), isError: false }
}

// ---- moving ----

/** Replaced, but not inside a {{name}}. */
const outside = (s: string, from: string, to: string) =>
  (from.includes('{{') ? s.split(from).join(to) : s.split(/(\{\{[^{}]*\}\})/).map((p, i) => (i % 2 ? p : p.split(from).join(to))).join(''))

/** Replaced only in the parts that `shown` shows of `s`. */
function inShown(s: string, shown: string, from: string, to: string): string {
  const parts = shown.split(HIDDEN)
  let out = '', at = 0
  for (const [i, p] of parts.entries()) {
    const start = i === 0 ? 0 : i === parts.length - 1 ? s.length - p.length : s.indexOf(p, at + 1)
    if (start < at || !s.startsWith(p, start)) return s
    out += s.slice(at, start) + outside(p, from, to)
    at = start + p.length
  }
  return out
}

/** Whether `now` shows no more of a text than `was` did, variables and path names aside. */
function showsNoMore(was: string, now: string): boolean {
  let at = 0
  return now.split(/<hidden>|\{\{[^{}]*\}\}|(?<=\/):[A-Za-z_][\w-]*(?=\/|$|[?#])/).every((p) => {
    const i = was.indexOf(p, at)
    at = i + p.length
    return i >= 0
  })
}

/** `s` with the value replaced, or as it is where that would show something. */
function swapped(s: string, show: (x: string) => string[], from: Suggestion): string {
  const shown = show(s), to = `{{${from.varName}}}`
  const next = from.secret ? outside(s, from.value, to) : inShown(s, shown[0], from.value, to)
  return next !== s && show(next).every((x, i) => showsNoMore(shown[i], x)) ? next : s
}

/** The URL with the ID replaced by its name, the first time it can be read. */
function withPathName(url: string, shown: string, value: string, name: string): string {
  const parts = shown.split(HIDDEN)
  const end = (i: number) => (i === parts.length - 1 ? '(?=[/?#]|$)' : '(?=[/?#])')
  const i = parts.findIndex((p, n) => new RegExp(`/${value}${end(n)}`).test(p))
  if (i < 0) return url
  const mark = `/:${name}`
  const next = parts.map((p, n) => (n === i ? p.replace(new RegExp(`/${value}${end(n)}`), mark) : p))
  let out = '', at = 0
  for (const [n, p] of parts.entries()) {
    const start = n === 0 ? 0 : n === parts.length - 1 ? url.length - p.length : url.indexOf(p, at + 1)
    if (start < at || !url.startsWith(p, start)) return url
    out += url.slice(at, start) + next[n]
    at = start + p.length
  }
  return out
}

/**
 * The request with the chosen values moved, and the variables to make. Only those that moved anything. `signIn` is the
 * sign-in that applies: a bearer header goes to the Auth tab only where there is none and nothing kept there.
 */
export function parameterize(r: RequestDef, chosen: Found[], cl: Cleaner, signIn: Auth | null, view: View = chatView(cl)): { request: RequestDef; create: KV[]; done: Found[] } {
  const done: Found[] = [], create: KV[] = []
  let out = r
  const did = (s: Found) => { done.push(s); if (s.create) create.push(kv(s.varName, s.value, true, s.secret ? { secret: true } : {})) }
  // Credentials, each in its place. Headers keep their number until all are done.
  let headers: (KV | null)[] = [...r.headers]
  let auth: Auth = r.auth
  const clear = () => [...AUTH_SECRETS].every((k) => !(auth as unknown as Record<string, unknown>)[k])
  for (const s of chosen.filter(credential)) {
    const to = `{{${s.varName}}}`
    if (s.header === undefined) auth = { ...auth, [s.kind === 'bearer' ? 'token' : s.kind === 'basic' ? 'password' : 'value']: to }
    else {
      const bearer = s.kind === 'bearer' && clear() && (!signIn || ['none', 'bearer'].includes(signIn.kind))
      if (bearer) auth = { ...emptyAuth('bearer'), token: to }
      headers = headers.map((h, i) => (i !== s.header || !h ? h : bearer ? null : { ...h, value: s.kind === 'bearer' ? h.value.replace(/\S+$/, to) : to }))
    }
    did(s)
  }
  out = { ...out, auth, headers: headers.filter((h) => h !== null) }
  for (const s of chosen.filter((x) => x.kind === 'pathId')) {
    const shown = cl.clean(out.url), url = withPathName(out.url, shown, s.value, s.varName)
    const was = view(out.url, 'url')
    if (url === out.url || !showsNoMore(shown, cl.clean(url)) || !view(url, 'url').every((x, n) => showsNoMore(was[n], x))) continue
    out = { ...out, url, pathVars: pathVarsFromUrl(url, [...out.pathVars, kv(s.varName, s.value)]), params: paramsFromUrl(url, out.params) }
    did(s)
  }
  for (const s of chosen.filter((x) => x.kind === 'existing' || x.kind === 'baseUrl').sort((a, b) => b.value.length - a.value.length)) {
    const row = (at: 'header' | 'field') => (x: KV): KV => { const value = swapped(x.value, (v) => view(v, at, x.key), s); return value === x.value ? x : { ...x, value } }
    const free = (v: string, at: 'url' | 'username' | 'text' | 'graphql') => swapped(v, (y) => view(y, at), s)
    const auth: Auth = { ...out.auth, username: free(out.auth.username, 'username') }
    if (s.secret) for (const k of ['token', 'value', 'password'] as const) auth[k] = outside(auth[k], s.value, `{{${s.varName}}}`)
    const next: RequestDef = {
      ...out, url: free(out.url, 'url'), headers: out.headers.map(row('header')), auth,
      body: { ...out.body, text: free(out.body.text, 'text'), graphqlVariables: free(out.body.graphqlVariables, 'graphql'), fields: out.body.fields.map(row('field')) },
    }
    if (canonical(next) === canonical(out)) continue
    out = { ...next, params: next.url === out.url ? out.params : paramsFromUrl(next.url, out.params) }
    did(s)
  }
  return { request: out, create, done }
}

const credential = (s: Suggestion) => s.kind === 'bearer' || s.kind === 'apiKeyHeader' || s.kind === 'basic'
const signInOf = (r: RequestDef, t: Tables, w: McpServeOptions) => effectiveAuth(r, t.collection, folderChain(w.ws.folders, r.folderId))

/** What a request sends, to compare: names of headers in lower case and one spelling of Bearer, dynamic names as they are. */
function sent(r: RequestDef, t: Tables, w: McpServeOptions): string {
  const p = prepare(light(r), { ...t, folders: folderChain(w.ws.folders, r.folderId), locals: new Map(Object.keys(FAKE).map((n) => [n, n])) })
  const headers = p.headers.map(([k, v]) => `${k.toLowerCase()}: ${k.toLowerCase() === 'authorization' ? v.replace(/^bearer\s+/i, 'Bearer ') : v}`).sort()
  // what signs it comes after prepare()
  const a = signInOf(r, t, w), scope = scopeFor(t)
  const signed = a && ['digest', 'jwt', 'awsv4', 'oauth2'].includes(a.kind) ? Object.entries(a).map(([k, v]) => [k, typeof v === 'string' ? interpolate(v, scope) : v]) : null
  return JSON.stringify([signed, p.method, p.url, headers, p.body, p.multipart])
}

const CHANGED = 'The request changed. Look at the suggestions again.'

type Where = 'environment' | 'collection' | 'globals'
interface Asked {
  r: RequestDef; t: Tables; w: McpServeOptions; batches: ParameterBatches; batch: unknown; choose: unknown; where: Where; cl: Cleaner
  /** The cleaner that hides these too. */
  widen(more: string[]): Cleaner
  view?(cl: Cleaner): View
  /** Why this one can't have this name, beyond what always holds. */
  badName?(s: Found, name: string): string | null
}
interface Moved { request: RequestDef; create: KV[]; done: Found[]; after: Tables; safe: Cleaner }

/** What was chosen, moved, or why not: the checks for every assistant. The refusals hold no values. */
function moveValues(x: Asked): Moved | Refused {
  const refuse = (refused: string): Refused => ({ refused })
  const { r, t, w, cl, where } = x
  const batch = x.batches.find(String(x.batch ?? ''))
  if (!batch || batch.at !== stateOf(r, t)) return refuse(CHANGED)
  if (!['environment', 'collection', 'globals'].includes(where)) return refuse('Say where: environment, collection or globals.')

  const taken = new Set([...rowsOf(t).map((v) => v.key.trim()), ...pathNames(r)])
  const chosen: Found[] = []
  for (const [id, as] of Object.entries((x.choose as Record<string, string>) ?? {})) {
    const s = batch.suggestions.find((x) => x.id === id)
    if (!s) return refuse(`There is no suggestion “${id}”. Look at the suggestions again.`)
    const name = as === '' ? s.varName : String(as)
    if (s.kind === 'existing') {
      if (name !== s.varName) return refuse(`“${id}” is already a variable, so it keeps its name: choose it with "".`)
    } else {
      if (!NAME.test(name) || name in FAKE || (s.kind === 'pathId' && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))) return refuse(`“${name}” can’t be a name here: no spaces or braces, not empty, and in the path only letters, digits, _ and -.`)
      const bad = x.badName?.(s, name)
      if (bad) return refuse(bad)
      if (taken.has(name)) return refuse(`“${name}” is already used there. Choose another name.`)
      taken.add(name)
    }
    chosen.push({ ...s, varName: name })
  }
  if (!chosen.length) return refuse('Choose at least one suggestion.')
  if (where === 'environment' && !t.environment && chosen.some((s) => s.create)) return refuse('No environment is active, so pick the collection or the globals.')

  // What moves is hidden from here on, also where it wasn't known to be a secret before.
  const safe = x.widen(chosen.filter((s) => s.secret).map((s) => s.value))
  const { request, create, done } = parameterize(r, chosen, safe, signInOf(r, t, w), x.view?.(safe))
  if (!done.length) return refuse('These can’t be moved here without showing a secret.')
  // Rule: a hidden value may move, but none is lost. What was swapped is put back before comparing.
  const values = new Map(done.map((s) => [s.varName, s.value]))
  const back = (s: string) => s.replace(/\{\{([^{}\s]+)\}\}/g, (m, n: string) => values.get(n) ?? m)
  const auth = Object.fromEntries(Object.entries(request.auth).map(([k, v]) => [k, AUTH_SECRETS.has(k) ? back(String(v)) : v])) as unknown as Auth
  const gone = lost({ ...r, auth: mapped(r.auth, back) }, { ...r, auth, pathVars: request.pathVars }, cl)
  if (gone) return refuse(held(gone))

  const after: Tables = { ...t }
  if (create.length) {
    const rows = where === 'environment' ? t.environment!.variables : where === 'collection' ? t.collection!.variables : t.globals
    const got = addVariables(rows, create)
    if ('taken' in got) return refuse(`“${got.taken}” is already used there. Choose another name.`)
    if (where === 'environment') after.environment = { ...t.environment!, variables: got.rows, updatedAt: Date.now() }
    else if (where === 'collection') after.collection = { ...t.collection!, variables: got.rows, updatedAt: Date.now() }
    else after.globals = got.rows
  }
  if (sent(request, after, w) !== sent(r, t, w)) return refuse('That would change what this request sends.')
  return { request: { ...request, updatedAt: Date.now() }, create, done, after, safe }
}

const doneReply = (name: string, m: Moved, place: string) =>
  `“${name}” now uses ${m.done.map((s) => (s.kind === 'pathId' ? `:${s.varName}` : `{{${s.varName}}}`)).join(', ')}.${m.create.length ? ` New in ${place}: ${m.create.map((v) => v.key).join(', ')}.` : ''}`

/** An apply_parameters call as a draft, or why not. */
export function applyParameters(input: Record<string, unknown>, ctx: ProposeContext, w: McpServeOptions, cl: Cleaner): Draft | Refused {
  const { real, lookup } = cleanWorld(w, ctx.spaceId, cl)
  const found = lookup(String(input.name ?? ''))
  if ('error' in found) return { refused: found.error }
  const r = real.requests.find((x) => x.id === found.it.request.id)!
  if (ctx.unsaved(r.id)) return { refused: `Save or discard your changes to “${oneLine(found.it.request.name)}” first.` }
  const t = tablesOf(r, w, real.active)
  const where = String(input.where) as Where
  const m = moveValues({ r, t, w, batches: ctx.batches, batch: input.batch, choose: input.choose, where, cl, widen: (more) => cleaner({ ...ctx, secrets: () => [...ctx.secrets(), ...more] }, w) })
  if ('refused' in m) return m
  const { request, create, done, after, safe } = m

  const changes: Change[] = [{ kind: 'request', id: r.id, before: r, after: request }]
  if (create.length) {
    changes.push(where === 'environment' ? { kind: 'environment', id: t.environment!.id, before: t.environment, after: after.environment }
      : where === 'collection' ? { kind: 'collection', id: t.collection!.id, before: t.collection, after: after.collection }
        : { kind: 'globals', id: 'globals', before: t.globals, after: after.globals })
  }
  const place = where === 'environment' ? `variables of the environment “${t.environment?.name}”` : where === 'collection' ? `variables of the collection “${t.collection?.name}”` : 'the globals'
  return {
    tool: 'apply_parameters', title: `Move values of “${r.name}” into ${create.length ? place : 'variables'}`, changes: structuredClone(changes), cleaner: safe,
    reply: doneReply(r.name, m, place),
    // a scheme and a variable, nothing hidden: shown as it is
    exact: { headers: new Map(request.headers.filter((h, i) => h.value !== r.headers[i]?.value && /^bearer \{\{[^{}\s]+\}\}$/i.test(h.value)).map((h) => [h.key.toLowerCase(), h.value])) },
    moved: new Map(done.filter((s) => s.kind !== 'pathId').map((s) => [s.varName, s.value])),
  }
}

// ---- outside assistants (mcpWorkspace.ts): no one approves, so nothing may come out of it but the move itself ----

/** `w` has the assistant's own collections too. `label`: the request's path. `known`: every secret the endpoint hides. */
export interface Outside { r: RequestDef; label: string; w: McpServeOptions; known: string[]; batches: ParameterBatches; save(c: AssistantChanges): Promise<void> }

/** The two tools of an outside assistant, for a request it may write to. New variables go to the request's collection. */
export async function outsideParameters(name: string, args: Record<string, unknown>, x: Outside): Promise<[string, boolean]> {
  const cl = cleanerOf(x.known)
  const { r, w } = x
  const t = tablesOf(r, w, w.environment)
  if (name === 'suggest_parameters') {
    const list = suggestionsFor(r, w, cl.clean, w.environment, outsideView(r, cl))
    return [list.length ? [`batch: ${x.batches.add(stateOf(r, t), list)}`, ...suggestionLines(r, list).map(cl.clean)].join('\n') : NOTHING, false]
  }
  const choose = args.choose ?? {}
  if (typeof choose !== 'object' || Array.isArray(choose) || Object.values(choose).some((v) => typeof v !== 'string')) return ['“choose” must be an object of ids, each with a name or "".', true]
  if (JSON.stringify(choose).includes(HIDDEN)) return [`${HIDDEN} stands for a secret you weren’t shown, so it can’t be a name.`, true]
  const m = moveValues({
    r, t, w, batches: x.batches, batch: args.batch, choose, where: 'collection', cl, widen: (more) => cleanerOf([...x.known, ...more]), view: (safe) => outsideView(r, safe),
    // get_request hides a variable by its name
    badName: (s, n) => (s.secret && hide(n, 'x') !== HIDDEN ? `“${n}” holds a secret, so it needs a name that says so, with token, password, secret or apiKey in it.` : null),
  })
  if ('refused' in m) return [cl.clean(m.refused), true]
  await x.save({ collections: m.create.length ? [m.after.collection!] : [], folders: [], requests: [m.request] })
  return [m.safe.clean(doneReply(x.label, m, `the variables of the collection “${t.collection!.name}”`)), false]
}
const mapped = (a: Auth, f: (s: string) => string) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, AUTH_SECRETS.has(k) ? f(String(v)) : v])) as unknown as Auth

/** A set_environment_variables call as a draft, or why not. */
export function setEnvironmentVariables(input: Record<string, unknown>, ctx: ProposeContext, w: McpServeOptions, cl: Cleaner): Draft | Refused {
  const refuse = (refused: string): Refused => ({ refused })
  const { real } = cleanWorld(w, ctx.spaceId, cl)
  const wanted = input.environment === undefined ? null : String(input.environment)
  const list = wanted === null ? (real.active ? [real.active] : []) : real.environments.filter((e) => cl.clean(e.name) === wanted)
  if (!list.length) return refuse(wanted === null ? 'No environment is active: name one.' : `No environment “${wanted}”. Use get_environment.`)
  if (list.length > 1) return refuse(`There is more than one environment “${wanted}”. Ask the person to rename one.`)
  const env = list[0]
  const set = Object.entries((input.variables as Record<string, string>) ?? {}), drop = ((input.remove as string[] | undefined) ?? []).map((k) => k.trim())
  if (!set.length && !drop.length) return refuse('Give variables to set or names to remove.')
  // One with a secret's name is the person's, also while it is empty.
  const why = badVariables({ ...input, remove: drop }, env.variables.map((v) => ({ ...v, secret: named(v) })), cl)
  if (why) return refuse(why)
  const at = (k: string) => (v: KV) => v.key.trim() === k.trim()
  const none = drop.find((k) => !env.variables.some(at(k)))
  if (none !== undefined) return refuse(`There is no variable “${none}” in that environment.`)

  const lower = [...real.collections.flatMap((c) => c.variables), ...real.globals, ...real.requests.flatMap((x) => x.handoff?.variables ?? [])]
  const hides = set.map(([k]) => k).find((k) => SECRET_NAME.test(k) && !env.variables.some(at(k)) && lower.some(at(k)))
  if (hides !== undefined) return refuse(`There is a “${hides}” in a collection or the globals already, and an empty one here would hide it. Ask the person to add it.`)

  const empty: string[] = []
  let variables = env.variables.filter((v) => !drop.includes(v.key.trim()))
  for (const [k, value] of set) {
    if (variables.some(at(k))) variables = variables.map((v) => (at(k)(v) ? inStep({ ...v, value }) : v))
    else if (SECRET_NAME.test(k)) { empty.push(k); variables = [...variables, kv(k, '', true, { secret: true })] }
    else variables = [...variables, kv(k, value)]
  }
  const after: Environment = { ...env, variables, updatedAt: Date.now() }
  const what = lost(env, after, cl)
  if (what) return refuse(held(what))
  const done = set.map(([k]) => k).filter((k) => !empty.includes(k))
  return {
    tool: 'set_environment_variables', title: `Change the variables of “${env.name}”`,
    changes: canonical(env) === canonical(after) ? [] : structuredClone([{ kind: 'environment' as const, id: env.id, before: env, after }]),
    reply: `Environment “${env.name}”: ${[done.length ? `set ${done.join(', ')}` : '', empty.length ? `made ${empty.join(', ')}, secret and empty for the person to fill in` : '', drop.length ? `removed ${drop.join(', ')}` : ''].filter(Boolean).join('; ')}.`,
    exact: { variables: new Map(set) }, notes: empty.map((k) => `Dispatch leaves “${k}” empty for you to fill in.`),
  }
}
