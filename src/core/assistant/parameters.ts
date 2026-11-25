/**
 * Moving values into variables without the model seeing them: it is told what could move (suggest_parameters), picks by
 * id, and the value goes from the request to the variable here. Also environment variables in general.
 *
 * Which values match, and which places change, must not tell what is hidden: a plain value matches and is replaced only
 * where the model can read it anyway, and nothing is replaced when that would leave a part of a secret readable.
 */
import { FAKE } from '../fake'
import type { McpServeOptions } from '../mcpHandler'
import { AUTH_SECRETS, HIDDEN, hide, hideInText } from '../mcpWorkspace'
import { knownSecrets, Redactor } from '../mcpLogs'
import { addVariables, applySuggestions, knownVars, suggest, type Suggestion } from '../parameterize'
import { pathVarNames, prepare } from '../prepare'
import { folderChain } from '../runtime'
import { SECRET_NAME } from '../share'
import { type Auth, type Collection, type Environment, kv, type KV, type RequestDef } from '../types'
import { paramsFromUrl } from '../url'
import { cleaner } from './clean'
import type { ToolContext } from './gate'
import { canonical, type Change } from './proposal'
import { badVariables, BODY_FIELDS, type Cleaner, cleanWorld, type Draft, held, inStep, light, lost, oneLine, type ProposeContext, type Refused } from './propose'

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

interface Batch { code: string; at: string; suggestions: Suggestion[] }
const KEPT = 10
/** What was suggested lately, in memory only: ids mean something only while the request and the tables are as they were. */
export class ParameterBatches {
  private list: Batch[] = []
  add(at: string, suggestions: Suggestion[]): string {
    const code = globalThis.crypto.randomUUID()
    this.list = [...this.list, { code, at, suggestions }].slice(-KEPT)
    return code
  }
  find(code: string): Batch | undefined { return this.list.find((b) => b.code === code) }
}

/** What a request's {{names}} come from, as it is sent now. */
interface Tables { environment: Environment | null; collection: Collection | null; globals: KV[]; handoff: KV[] }
const tablesOf = (r: RequestDef, w: McpServeOptions, active: Environment | null): Tables =>
  ({ environment: active, collection: w.ws.collections.find((c) => c.id === r.collectionId) ?? null, globals: w.globals, handoff: r.handoff?.variables ?? [] })
const rowsOf = (t: Tables) => [...(t.environment?.variables ?? []), ...(t.collection?.variables ?? []), ...t.handoff, ...t.globals]
/** The state a batch belongs to. Holds real values, so it stays here. */
const stateOf = (r: RequestDef, t: Tables) => JSON.stringify([canonical(r), t.environment?.id, ...[t.environment?.variables, t.collection?.variables, t.globals].map((l) => canonical(l ?? []))])

const named = (v: KV) => !!v.secret || SECRET_NAME.test(v.key)
/** Shorter ones aren't hidden where they are in a text. */
const KNOWN = 6
const NAME = /^[^{}\s]+$/
const IS_VAR = /^\s*\{\{[^{}]+\}\}\s*$/

/**
 * What could move, as suggest() has it for the open request, less what would tell the model something about a value it
 * can't see. `clean` is what hides secrets from it; without one, every secret in `w` is hidden.
 */
export function suggestionsFor(r: RequestDef, w: McpServeOptions, clean: (s: string) => string = defaultClean(w), active: Environment | null = w.environment): Suggestion[] {
  const t = tablesOf(r, w, active)
  const b = r.body
  const shown = [
    clean(r.url), ...r.headers.map((h) => clean(hide(h.key, h.value))), clean(r.auth.username),
    ...(b.kind === 'none' || b.kind === 'binary' ? [] : BODY_FIELDS.includes(b.kind) ? b.fields.map((f) => clean(hide(f.key, f.value))) : [clean(b.text), ...(b.kind === 'graphql' ? [clean(b.graphqlVariables)] : [])]),
  ].join('\n')
  const whole = [r.auth.token, r.auth.value, r.auth.password, ...r.headers.flatMap((h) => [h.value, h.value.replace(/^bearer\s+/i, '')])]
  const rows = rowsOf(t).filter((v) => v.enabled)
  const secret = (key: string, value: string) => rows.some((v) => v.key.trim() === key && v.value === value && named(v))
  const known = knownVars(t.environment, t.collection, t.globals, t.handoff).filter((k) => {
    if (IS_VAR.test(k.value) || !NAME.test(k.key)) return false
    if (!secret(k.key, k.value)) return shown.includes(k.value)
    if (k.value.trim().length < KNOWN) return false
    // one that isn't marked may have been set by the model, to find out whether it is a part of something hidden
    return rows.some((v) => v.key.trim() === k.key && v.value === k.value && v.secret) || whole.includes(k.value)
  })
  const list = suggest(r, known, rowsOf(t).map((v) => v.key.trim()))
  const hiddenUrl = clean(r.url) !== r.url
  let n = 0
  return list.map((s) => ({
    ...s,
    secret: s.secret || (s.kind === 'existing' ? secret(s.varName, s.value) : s.kind === 'baseUrl' && (hideInText(s.value) !== s.value || !clean(r.url).includes(s.value))),
    // named after the path before it, which may be hidden
    ...(s.kind === 'pathId' && hiddenUrl ? { varName: freeName('itemId', [...rowsOf(t).map((v) => v.key.trim()), ...pathNames(r)], n++) } : {}),
  }))
}
const defaultClean = (w: McpServeOptions) => {
  const known = new Redactor(knownSecrets({ environments: [...w.ws.environments, ...(w.environment ? [w.environment] : [])], globals: w.globals, collections: w.ws.collections, folders: w.ws.folders, requests: w.ws.requests, extra: [w.settings.mcpHostToken] }))
  return (s: string) => known.clean(s)
}
const pathNames = (r: RequestDef) => [...pathVarNames(r.url), ...r.pathVars.map((p) => p.key)]
/** The nth name like `base` that isn't taken. */
function freeName(base: string, taken: string[], n: number): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}${i}`
    if (!taken.includes(name) && n-- === 0) return name
  }
}

/** Its lines, made here: the titles and details of suggest() hold values. */
export function suggestionLines(r: RequestDef, list: Suggestion[]): string[] {
  const what = (s: Suggestion) => {
    switch (s.kind) {
      case 'existing': return 'a value that a variable already has'
      case 'baseUrl': return 'base URL'
      case 'bearer': return 'bearer token'
      case 'apiKeyHeader': { const h = r.headers.find((x) => x.enabled && x.value === s.value); return h ? `API key in the header ${h.key}` : 'API key of the sign-in' }
      case 'basic': return 'sign-in password'
      case 'pathId': return 'ID in the path'
    }
  }
  return list.map((s) => oneLine([s.id, what(s), s.kind === 'pathId' ? `:${s.varName}` : `{{${s.varName}}}`, s.kind === 'existing' ? 'existing' : 'new', ...(s.secret ? ['secret'] : [])].join(' · ')))
}

/** The suggest_parameters tool. The gate hides, cuts and marks what it answers. */
export function suggestParameters(input: Record<string, unknown>, ctx: ToolContext, w: McpServeOptions): { text: string; isError: boolean } {
  const cl = cleaner(ctx, w)
  const { real, lookup } = cleanWorld(w, ctx.spaceId, cl)
  const found = lookup(String(input.name ?? ''))
  if ('error' in found) return { text: found.error, isError: true }
  const r = real.requests.find((x) => x.id === found.it.request.id)!
  const list = suggestionsFor(r, w, cl.clean, real.active)
  if (!list.length) return { text: 'Nothing to move: no base URL, sign-in, key or ID written into it, and no value that a variable has.', isError: false }
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
function swapped(s: string, show: (x: string) => string, from: Suggestion): string {
  const shown = show(s), to = `{{${from.varName}}}`
  if (from.secret && shown.includes(from.value)) return s // a short one: replacing it in what can be read would tell it
  const next = from.secret ? outside(s, from.value, to) : inShown(s, shown, from.value, to)
  return next !== s && showsNoMore(shown, show(next)) ? next : s
}

/** The request with the chosen values moved, and the variables to make. Only those that moved anything. */
export function parameterize(r: RequestDef, chosen: Suggestion[], cl: Cleaner): { request: RequestDef; create: KV[]; done: Suggestion[] } {
  const make = (s: Suggestion) => kv(s.varName, s.value, true, s.secret ? { secret: true } : {})
  const done: Suggestion[] = [], create: KV[] = []
  let out = r
  // IDs first: they change the URL's shape.
  for (const s of chosen.filter((x) => x.kind === 'pathId')) {
    const next = applySuggestions(out, [s]).request
    if (next.url !== out.url && showsNoMore(cl.clean(out.url), cl.clean(next.url))) { out = next; done.push(s) }
  }
  for (const s of chosen.filter((x) => x.kind === 'bearer')) { out = applySuggestions(out, [s]).request; done.push(s); create.push(make(s)) }
  for (const s of chosen.filter((x) => x.kind !== 'pathId' && x.kind !== 'bearer').sort((a, b) => b.value.length - a.value.length)) {
    const row = (x: KV): KV => { const value = swapped(x.value, (v) => cl.deep({ key: x.key, value: v }).value, s); return value === x.value ? x : { ...x, value } }
    const free = (v: string) => swapped(v, cl.clean, s)
    const auth: Auth = { ...out.auth, username: free(out.auth.username) }
    if (s.secret) for (const k of ['token', 'value', 'password'] as const) auth[k] = outside(auth[k], s.value, `{{${s.varName}}}`)
    const next: RequestDef = {
      ...out, url: free(out.url), headers: out.headers.map(row), auth,
      body: { ...out.body, text: free(out.body.text), graphqlVariables: free(out.body.graphqlVariables), fields: out.body.fields.map(row) },
    }
    if (canonical(next) === canonical(out)) continue
    out = { ...next, params: next.url === out.url ? out.params : paramsFromUrl(next.url, out.params) }
    done.push(s)
    if (s.create) create.push(make(s))
  }
  return { request: out, create, done }
}

/** What a request sends, to compare: names of headers in lower case and one spelling of Bearer, dynamic names as they are. */
function sent(r: RequestDef, t: Tables, w: McpServeOptions): string {
  const p = prepare(light(r), { ...t, folders: folderChain(w.ws.folders, r.folderId), locals: new Map(Object.keys(FAKE).map((n) => [n, n])) })
  const headers = p.headers.map(([k, v]) => `${k.toLowerCase()}: ${k.toLowerCase() === 'authorization' ? v.replace(/^bearer\s+/i, 'Bearer ') : v}`).sort()
  return JSON.stringify([p.method, p.url, headers, p.body, p.multipart, p.unresolved])
}

const CHANGED = 'The request changed. Look at the suggestions again.'

/** An apply_parameters call as a draft, or why not. The refusals hold no values. */
export function applyParameters(input: Record<string, unknown>, ctx: ProposeContext, w: McpServeOptions, cl: Cleaner): Draft | Refused {
  const refuse = (refused: string): Refused => ({ refused })
  const { real, lookup } = cleanWorld(w, ctx.spaceId, cl)
  const found = lookup(String(input.name ?? ''))
  if ('error' in found) return refuse(found.error)
  const r = real.requests.find((x) => x.id === found.it.request.id)!
  if (ctx.unsaved(r.id)) return refuse(`Save or discard your changes to “${oneLine(found.it.request.name)}” first.`)
  const t = tablesOf(r, w, real.active)
  const batch = ctx.batches.find(String(input.batch ?? ''))
  if (!batch || batch.at !== stateOf(r, t)) return refuse(CHANGED)
  const where = String(input.where)
  if (!['environment', 'collection', 'globals'].includes(where)) return refuse('Say where: environment, collection or globals.')

  const taken = new Set([...rowsOf(t).map((v) => v.key.trim()), ...pathNames(r)])
  const chosen: Suggestion[] = []
  for (const [id, as] of Object.entries((input.choose as Record<string, string>) ?? {})) {
    const s = batch.suggestions.find((x) => x.id === id)
    if (!s) return refuse(`There is no suggestion “${id}”. Look at the suggestions again.`)
    const name = as === '' ? s.varName : String(as)
    if (s.kind === 'existing') {
      if (name !== s.varName) return refuse(`“${id}” is already a variable, so it keeps its name: choose it with "".`)
    } else {
      if (!NAME.test(name) || name in FAKE || (s.kind === 'pathId' && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))) return refuse(`“${name}” can’t be a name here: no spaces or braces, not empty, and in the path only letters, digits, _ and -.`)
      if (taken.has(name)) return refuse(`“${name}” is already used there. Choose another name.`)
      taken.add(name)
    }
    chosen.push({ ...s, varName: name })
  }
  if (!chosen.length) return refuse('Choose at least one suggestion.')
  if (where === 'environment' && !t.environment && chosen.some((s) => s.create)) return refuse('No environment is active, so pick the collection or the globals.')

  // What moves is hidden from here on, also where it wasn't known to be a secret before.
  const safe = cleaner({ ...ctx, secrets: () => [...ctx.secrets(), ...chosen.filter((s) => s.secret).map((s) => s.value)] }, w)
  const { request, create, done } = parameterize(r, chosen, safe)
  if (!done.length) return refuse('These can’t be moved here without showing a secret.')
  // Rule: a hidden value may move, but none is lost. What was swapped is put back before comparing.
  const values = new Map(done.map((s) => [s.varName, s.value]))
  const back = (s: string) => s.replace(/\{\{([^{}\s]+)\}\}/g, (m, n: string) => values.get(n) ?? m)
  const auth = Object.fromEntries(Object.entries(request.auth).map(([k, v]) => [k, AUTH_SECRETS.has(k) ? back(String(v)) : v])) as unknown as Auth
  const gone = lost({ ...r, auth: mapped(r.auth, back) }, { ...r, auth, pathVars: request.pathVars }, cl)
  if (gone) return refuse(held(gone))

  const changes: Change[] = [{ kind: 'request', id: r.id, before: r, after: { ...request, updatedAt: Date.now() } }]
  const after: Tables = { ...t }
  if (create.length) {
    const rows = where === 'environment' ? t.environment!.variables : where === 'collection' ? t.collection!.variables : t.globals
    const got = addVariables(rows, create)
    if ('taken' in got) return refuse(`“${got.taken}” is already used there. Choose another name.`)
    if (where === 'environment') after.environment = { ...t.environment!, variables: got.rows, updatedAt: Date.now() }
    else if (where === 'collection') after.collection = { ...t.collection!, variables: got.rows, updatedAt: Date.now() }
    else after.globals = got.rows
    changes.push(where === 'environment' ? { kind: 'environment', id: t.environment!.id, before: t.environment, after: after.environment }
      : where === 'collection' ? { kind: 'collection', id: t.collection!.id, before: t.collection, after: after.collection }
        : { kind: 'globals', id: 'globals', before: t.globals, after: after.globals })
  }
  if (sent(request, after, w) !== sent(r, t, w)) return refuse('That would change what this request sends.')
  const place = where === 'environment' ? `variables of the environment “${t.environment?.name}”` : where === 'collection' ? `variables of the collection “${t.collection?.name}”` : 'the globals'
  const names = done.map((s) => (s.kind === 'pathId' ? `:${s.varName}` : `{{${s.varName}}}`)).join(', ')
  return {
    tool: 'apply_parameters', title: `Move values of “${r.name}” into ${create.length ? place : 'variables'}`, changes: structuredClone(changes), cleaner: safe,
    reply: `“${r.name}” now uses ${names}.${create.length ? ` New in ${place}: ${create.map((v) => v.key).join(', ')}.` : ''}`,
    moved: new Map(done.filter((s) => s.kind !== 'pathId').map((s) => [s.varName, s.value])),
  }
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
  const why = badVariables(input, env.variables.map((v) => ({ ...v, secret: named(v) })), cl)
  if (why) return refuse(why)
  const at = (k: string) => (v: KV) => v.key.trim() === k.trim()
  const none = drop.find((k) => !env.variables.some(at(k)))
  if (none !== undefined) return refuse(`There is no variable “${none}” in that environment.`)

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
