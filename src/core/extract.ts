/** "Extract into variable": from a value picked in a response to the script line that takes it on every send. */
import { fmt } from './scripts'
import { type KV, kv } from './types'

export type Source = { ok: true; expr: string; value: string; name: string; unique: boolean } | { ok: false; reason: string }
export type Scope = 'env' | 'collection' | 'globals'

const ONE: Source = { ok: false, reason: 'Select one value.' }
const EMPTY: Source = { ok: false, reason: 'This value is empty.' }

/** A single-quoted JavaScript string. */
const quote = (s: string) => `'${JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'").replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`

/** A variable name from a key, header or tag: camelCase when it has odd characters. */
function nameFrom(s: string): string {
  if (/^[A-Za-z_][\w]*$/.test(s)) return s
  const words = s.split(/[^A-Za-z0-9_]+/).filter(Boolean)
  const n = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('')
  return /^[A-Za-z_]/.test(n) ? n : 'value'
}

type Step = string | number
/** Paths share their start, so a deep document doesn't copy them. */
interface Path { up: Path | null; step: Step }

const steps = (p: Path | null): Step[] => { const out: Step[] = []; for (let x = p; x; x = x.up) out.push(x.step); return out.reverse() }

/** The innermost value whose span (with its key) holds from..to. The text must be valid JSON. */
function locate(text: string, from: number, to: number): { from: number; to: number; memberFrom: number; path: Path | null; container: boolean } | null {
  interface Open { from: number; memberFrom: number; path: Path | null; array: boolean; index: number; key: string | null; keyFrom: number; wantKey: boolean }
  const stack: Open[] = []
  let best: ReturnType<typeof locate> = null
  const token = /"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g
  const place = (at: number): { path: Path | null; memberFrom: number } => {
    const o = stack[stack.length - 1]
    if (!o) return { path: null, memberFrom: at }
    return o.array ? { path: { up: o.path, step: o.index }, memberFrom: at } : { path: { up: o.path, step: o.key! }, memberFrom: o.keyFrom }
  }
  // Values end innermost first, so the first one that holds the selection is the innermost.
  const close = (n: { from: number; memberFrom: number; path: Path | null; container: boolean }, end: number) => {
    if (n.memberFrom <= from && to <= end) best = { ...n, to: end }
  }
  for (let m = token.exec(text); m && !best; m = token.exec(text)) {
    const t = m[0], at = m.index, o = stack[stack.length - 1]
    if (t === '{' || t === '[') stack.push({ from: at, ...place(at), array: t === '[', index: 0, key: null, keyFrom: 0, wantKey: t === '{' })
    else if (t === '}' || t === ']') { const x = stack.pop(); if (!x) return null; close({ from: x.from, memberFrom: x.memberFrom, path: x.path, container: true }, at + 1) }
    else if (t === ',') { if (o?.array) o.index++; else if (o) o.wantKey = true }
    else if (t === ':') continue
    else if (o?.wantKey) { o.key = JSON.parse(t) as string; o.keyFrom = at; o.wantKey = false }
    else close({ from: at, ...place(at), container: false }, at + t.length)
  }
  return best
}

export function jsonSource(text: string, start: number, end: number): Source {
  // Spaces and a trailing comma often come along with a selection.
  let from = start, to = end
  while (to > from && /[\s,]/.test(text[to - 1])) to--
  while (from < to && /[\s,]/.test(text[from])) from++
  if (from >= to) return ONE
  let data: unknown
  try { data = JSON.parse(text) } catch { return ONE }
  const hit = locate(text, from, to)
  if (!hit) return ONE
  const whole = (from === hit.from && to === hit.to) || (from === hit.memberFrom && to === hit.to)
  // In an object's own key (before its value starts) means that value.
  const inKey = hit.memberFrom !== hit.from && to <= hit.from
  if (hit.container && !whole && !inKey) return ONE
  const path = steps(hit.path)
  for (const s of path) data = (data as Record<Step, unknown>)[s]
  if (data === null || data === '') return EMPTY
  const plain = path.every((s) => typeof s === 'number' || /^[A-Za-z_$][\w$]*$/.test(s))
  let expr: string
  if (!path.length) expr = 'dx.response.json()'
  else if (plain) expr = `dx.response.json(${quote(path.map((s, i) => (typeof s === 'number' ? `[${s}]` : `${i ? '.' : ''}${s}`)).join(''))})`
  else expr = `dx.response.json()${path.map((s) => `?.[${typeof s === 'number' ? s : quote(s)}]`).join('')}`
  const key = [...path].reverse().find((s) => typeof s === 'string' && nameFrom(s) !== 'value') as string | undefined
  return { ok: true, expr, value: fmt(data), name: key ? nameFrom(key) : 'value', unique: true }
}

/** `earlier`: the headers above it; only the first of a name can be read by a script. */
export function headerSource(name: string, value: string, earlier: [string, string][] = []): Source {
  if (!value) return EMPTY
  if (earlier.some(([k]) => k.toLowerCase() === name.toLowerCase())) return { ok: false, reason: `The response has several “${name}” headers, and only the first can be taken.` }
  return { ok: true, expr: `dx.response.headers.get(${quote(name)})`, value, name: nameFrom(name), unique: true }
}

const AROUND = 40
const NOT_HERE: Source = { ok: false, reason: 'This isn’t in the response as it came. Turn on Raw and select it there.' }
const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
/** Text around a value as a pattern: line breaks match loosely, and ids, dates and tokens match any other. */
const around = (s: string) => s.split(/([\w-]+|\s*\n\s*|\t)/).map((p) =>
  /\n/.test(p) ? '\\s*' : p === '\t' ? '\\t' : /^[\w-]+$/.test(p) && (/\d/.test(p) || p.length > 16) ? '[\\w-]{1,64}' : esc(p)).join('')
const noHalves = (s: string) => s.replace(/^[\uDC00-\uDFFF]/, '').replace(/[\uD800-\uDBFF]$/, '')

/** Ways to say where the value starts, shortest first. */
function heads(text: string, from: number): string[] {
  const near = text.slice(Math.max(0, from - 200), from)
  const out: string[] = []
  const tag = /<([\w:-]{1,60})(?:\s[^<>]*)?>\s*$/.exec(near)
  const key = /([\w.-]{1,60})(["']?\s*[=:]\s*["']?)$/.exec(near)
  if (tag) out.push(`<${esc(tag[1])}(?:\\s[^<>]*)?>\\s*`)
  if (key) out.push(`${/^\w/.test(key[1]) ? '\\b' : ''}${esc(key[1])}${around(key[2])}`)
  const line = /[^\n&<>]{1,20}$/.exec(near)?.[0]
  if (line) out.push(around(noHalves(line)))
  if (near) for (const n of [20, AROUND]) out.push(around(noHalves(near.slice(-n))))
  else out.push('^\\s*')
  return [...new Set(out)]
}

/** Ways to say where it ends, shortest first. */
function tails(text: string, to: number): string[] {
  const rest = text.slice(to, to + AROUND)
  if (!rest.trim()) return ['', '\\s*$']
  const out = ['']
  if (/^[^\S\n]*\n/.test(rest)) out.push('\\s*[\\r\\n]')
  else out.push(/^<\/[\w:-]+>/.exec(rest) ? esc(/^<\/[\w:-]+>/.exec(rest)![0]) : esc(noHalves(rest[0])))
  out.push(around(noHalves(rest.slice(0, 20))))
  return out
}

/** `real` is the body as it came, when `body` is a tidied view of it (the rule runs on the real one). */
export function textSource(body: string, start: number, end: number, real = body): Source {
  let from = start, to = end
  while (to > from && /\s/.test(body[to - 1])) to--
  while (from < to && /\s/.test(body[from])) from++
  if (from >= to) return ONE
  // Part of a word means the word; its other half must not end up in the script as "text around it".
  const word = /[\w-]/
  if (word.test(body[from])) while (from > 0 && word.test(body[from - 1])) from--
  if (word.test(body[to - 1])) while (to < body.length && word.test(body[to])) to++
  const value = body.slice(from, to)
  // The same place in the body as it came: the same occurrence of the value, counted from the top.
  const text = real.replace(/\r\n?/g, '\n')
  if (text !== body) {
    let nth = 0
    for (let i = body.indexOf(value); i >= 0 && i < from; i = body.indexOf(value, i + 1)) nth++
    let at = text.indexOf(value)
    while (nth-- > 0 && at >= 0) at = text.indexOf(value, at + 1)
    if (at < 0) return NOT_HERE
    from = at; to = at + value.length
  }
  // What the value may hold: anything but the usual delimiters it doesn't contain itself.
  const not = ['"', "'", '<', '&', ',', ';'].filter((c) => !value.includes(c)).join('')
  const room = Math.max(200, value.length * 4) // a bound, so a big body stays quick to search
  const shape = value.includes('\n') ? `[\\s\\S]{1,${room}}?` : /\s/.test(value) ? `[^${not}\\r\\n]{1,${room}}?` : `[^${not}\\s]{1,8192}`
  const name = /<([\w:-]{1,60})(?:\s[^<>]*)?>\s*$/.exec(text.slice(Math.max(0, from - 200), from))?.[1]
    ?? /([\w-]{1,60})["']?\s*[=:]\s*["']?$/.exec(text.slice(Math.max(0, from - 200), from))?.[1]
  let repeated: string | null = null
  const lazy = shape.endsWith('?')
  const ends = tails(text, to).filter((t) => !lazy || t)
  for (const h of heads(text, from)) for (const t of ends) {
    const source = `${h}(${shape})${t}`
    const re = new RegExp(source, 'g')
    const first = re.exec(text)
    if (!first || first[1] !== value) { repeated ??= source; continue }
    re.lastIndex = first.index + 1
    const again = re.exec(text)
    if (!again) return { ok: true, expr: `(dx.response.text().match(/${source}/) || [])[1]`, value, name: name ? nameFrom(name) : 'value', unique: true }
    if (repeated === null || !new RegExp(repeated).exec(text) || new RegExp(repeated).exec(text)![1] !== value) repeated = source
  }
  if (!repeated || !new RegExp(repeated).test(text)) return NOT_HERE
  return { ok: true, expr: `(dx.response.text().match(/${repeated}/) || [])[1]`, value, name: name ? nameFrom(name) : 'value', unique: false }
}

/** By content, as the viewer does: JSON when it parses, whatever the Content-Type. */
export function bodySource(text: string, from: number, to: number, real = text): Source {
  try { JSON.parse(text) } catch { return textSource(text, from, to, real) }
  return jsonSource(text, from, to)
}

/** The row of a table that requests use for a name: the last one that's on, or else the last. */
export function rowFor(rows: KV[], name: string): KV | undefined {
  const same = rows.filter((r) => r.key.trim() === name)
  return same.filter((r) => r.enabled).pop() ?? same.pop()
}

/** Sets a variable in a table: the row requests use, or a new one. */
export function setVar(rows: KV[], name: string, value: string, secret: boolean): { rows: KV[]; undo: (rows: KV[]) => KV[] } {
  const old = rowFor(rows, name)
  if (!old) {
    const added: KV = { ...kv(name, value), secret }
    return { rows: [...rows, added], undo: (now) => now.filter((r) => r.id !== added.id) }
  }
  const options = old.options?.map((o) => (o.name === old.active ? { ...o, value } : o))
  const next: KV = { ...old, value, secret, enabled: true, ...(options ? { options } : {}) }
  return { rows: rows.map((r) => (r === old ? next : r)), undo: (now) => now.map((r) => (r.id === old.id ? old : r)) }
}

const MARK = '// extracted'
export const ruleLine = (scope: Scope, name: string, expr: string) =>
  `{ const v = ${expr}; if (v != null && v !== '') dx.${scope}.set(${quote(name)}, v) } ${MARK}`

const TARGET = /^.*\bdx\.(env|collection|globals)\.set\((['"])((?:(?!\2)[^\\]|\\.)*)\2\s*,.*\/\/ extracted\s*$/
function target(line: string): { scope: Scope; name: string } | null {
  const m = TARGET.exec(line)
  if (!m) return null
  return { scope: m[1] as Scope, name: m[3].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) => (e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e)) }
}

/** The marked line that sets this variable, if the script has one. */
export const ruleFor = (script: string, scope: Scope, name: string) =>
  script.split('\n').find((l) => { const t = target(l); return t?.scope === scope && t.name === name }) ?? null

/** Adds the rule, or replaces the marked one for the same variable. Other lines stay as they are. */
export function withRule(script: string, scope: Scope, name: string, expr: string): string {
  const line = ruleLine(scope, name, expr)
  const old = ruleFor(script, scope, name)
  if (old !== null) return script.split('\n').map((l) => (l === old ? line : l)).join('\n')
  const s = script.replace(/\s+$/, '')
  return s ? `${s}\n${line}` : line
}

/** Takes the rule out again (Undo), putting back the line it replaced. Anything else edited since stays. */
export function withoutRule(script: string, scope: Scope, name: string, expr: string, before: string | null): string {
  const line = ruleLine(scope, name, expr)
  return script.split('\n').flatMap((l) => (l !== line ? [l] : before === null ? [] : [before])).join('\n')
}

/** The variables a script's marked lines set. */
export function extractedTargets(script: string): { scope: Scope; name: string }[] {
  const out: { scope: Scope; name: string }[] = []
  for (const l of script.split('\n')) {
    const t = target(l)
    if (t && !out.some((x) => x.scope === t.scope && x.name === t.name)) out.push(t)
  }
  return out
}
