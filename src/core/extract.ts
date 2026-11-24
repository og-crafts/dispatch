/** "Extract into variable": from a value picked in a response to the script line that takes it on every send. */
import { fmt } from './scripts'

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
  else expr = `dx.response.json()${path.map((s, i) => `${i ? '?.' : ''}[${typeof s === 'number' ? s : quote(s)}]`).join('')}`
  const key = [...path].reverse().find((s) => typeof s === 'string' && nameFrom(s) !== 'value') as string | undefined
  return { ok: true, expr, value: fmt(data), name: key ? nameFrom(key) : 'value', unique: true }
}

export function headerSource(name: string, value: string): Source {
  if (!value) return EMPTY
  return { ok: true, expr: `dx.response.headers.get(${quote(name)})`, value, name: nameFrom(name), unique: true }
}

const AROUND = 20
const lit = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const noHalves = (s: string) => s.replace(/^[\uDC00-\uDFFF]/, '').replace(/[\uD800-\uDBFF]$/, '')

export function textSource(body: string, start: number, end: number): Source {
  let from = start, to = end
  while (to > from && /\s/.test(body[to - 1])) to--
  while (from < to && /\s/.test(body[from])) from++
  if (from >= to) return ONE
  const value = body.slice(from, to)
  const before = noHalves(body.slice(Math.max(0, from - AROUND), from))
  const after = noHalves(body.slice(to, to + AROUND))
  const head = (from <= AROUND ? '^' : '') + lit(before)
  const tail = lit(after) + (to + AROUND >= body.length ? '$' : '')
  // What the value may hold: anything but the usual delimiters it doesn't contain itself.
  const not = [['"', '"'], ['<', '<'], ['\\s', /\s/], ['&', '&'], [',', ',']].filter(([, c]) => (typeof c === 'string' ? !value.includes(c) : !c.test(value))).map(([x]) => x as string).join('')
  const shape = not.includes('\\s') ? `[^${not}]+` : '[\\s\\S]+?'
  // The start and end of the body would pin today's reply only, so they are used just where there is no text to go by.
  const open = before ? lit(before) : head
  const shut = after ? lit(after) : tail
  const source = `${open}(${shape})${shut}`
  const re = new RegExp(source, 'g')
  const found: string[] = [] // two are enough to know; places may overlap
  for (let m = re.exec(body); m && found.length < 2; m = re.exec(body)) { found.push(m[1]); re.lastIndex = m.index + 1 }
  const tag = /<([\w:-]+)[^<>]*>\s*$/.exec(body.slice(0, from))?.[1] ?? /([\w-]+)["']?\s*[=:]\s*["']?$/.exec(body.slice(0, from))?.[1]
  return { ok: true, expr: `(dx.response.text().match(/${source}/) || [])[1]`, value, name: tag ? nameFrom(tag) : 'value', unique: found.length === 1 && found[0] === value }
}

/** By content, as the viewer does: JSON when it parses, whatever the Content-Type. */
export function bodySource(text: string, from: number, to: number): Source {
  try { JSON.parse(text) } catch { return textSource(text, from, to) }
  return jsonSource(text, from, to)
}

const MARK = '// extracted'
export const ruleLine = (scope: Scope, name: string, expr: string) =>
  `{ const v = ${expr}; if (v != null) dx.${scope}.set(${quote(name)}, v) } ${MARK}`

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
