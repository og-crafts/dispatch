import { toolClass } from '../../core/assistant/tools'

/** What the panel shows of a chat's messages. They are a provider's own, or a model's words: every part is checked before it's used. */
export type ToolState = 'running' | 'ok' | 'failed' | 'stopped'
export type Item =
  | { kind: 'you' | 'assistant' | 'model'; text: string }
  | { kind: 'tool'; text: string; name: string; state?: ToolState }

type Bag = Record<string, unknown>
const bag = (x: unknown): Bag => (x && typeof x === 'object' ? x as Bag : {})
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const str = (x: unknown): string => (typeof x === 'string' ? x : '')
/** One short line of something a model wrote: nothing invisible, nothing that turns the text around. */
const line = (x: unknown, most = 80): string => {
  const t = str(x).slice(0, 1000).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return t.length > most ? `${[...t].slice(0, most).join('')}…` : t
}

/** Where a tool's input names what it changes; a path shows its last part. */
const NAMED: Record<string, [field: string, otherwise: string]> = { copy_request: ['from', 'a request'], set_variables: ['collection', 'a collection'], set_scripts: ['path', 'a collection'], set_environment_variables: ['environment', 'the environment'] }
/** A proposed change in words that go on from "Proposed" and "The assistant proposes". */
export function proposed(tool: string, name: string): string {
  switch (tool) {
    case 'create_request': return `a new request ${name}`
    case 'copy_request': return `a copy of ${name}`
    case 'move_request': return `to move ${name}`
    case 'delete_request': return `to delete ${name}`
    default: return `a change to ${name}`
  }
}
const changes = (name: unknown) => { const c = toolClass(str(name)); return c === 'edit' || c === 'delete' }
/** What is added to a tool's line. A change that didn't come about wasn't applied. */
export const stateWords = (name: string, state?: ToolState): string =>
  (state !== 'failed' && state !== 'stopped' ? '' : changes(name) ? ' (not applied)' : state === 'failed' ? ' (didn’t work)' : ' (stopped)')

/** A look-up, or a change that was proposed, in plain words. */
export function toolLine(name: unknown, input: unknown): string {
  const i = bag(input)
  if (changes(name)) {
    const [field, otherwise] = NAMED[str(name)] ?? ['name', 'a request']
    return `Proposed ${proposed(str(name), line(str(i[field]).slice(0, 10_000).split('/').filter((x) => x.trim()).pop()) || otherwise)}`
  }
  switch (name) {
    case 'suggest_parameters': return `Looked for values to parameterize in ${line(i.name) || 'a request'}`
    case 'get_request': return `Read ${line(i.name) || 'a request'}`
    case 'list_requests': return 'Listed the requests'
    case 'get_environment': return line(i.name) ? `Read the environment ${line(i.name)}` : 'Read the environment'
    case 'get_logs': return 'Read the console'
    case 'list_history': return 'Listed recent sends'
    case 'get_history_entry': return 'Read a past send'
    default: return `Tried ${line(name, 40) || 'a tool that isn’t here'}`
  }
}

const json = (s: unknown): unknown => { try { return JSON.parse(str(s)) } catch { return undefined } }

/** The chat as lines to show; tool results and thinking are left out. */
export function items(messages: unknown): Item[] {
  const out: Item[] = []
  const say = (kind: 'you' | 'assistant', text: string) => { if (text.trim()) out.push({ kind, text }) }
  const failed = new Map<string, boolean>()
  for (const m of list(messages)) for (const b of list(bag(m).content)) {
    const r = bag(b)
    if (r.type === 'tool_result' && str(r.tool_use_id)) failed.set(str(r.tool_use_id), r.is_error === true)
  }
  const all = list(messages)
  for (const [at, m] of all.entries()) {
    const { role, content, tool_calls: calls } = bag(m)
    if (role !== 'user' && role !== 'assistant') continue
    const who = role === 'user' ? 'you' : 'assistant'
    if (typeof content === 'string') say(who, content)
    let text = ''
    for (const raw of list(content)) {
      const b = bag(raw)
      if (b.type === 'text') { text += str(b.text); continue }
      if (who === 'you') continue
      if (b.type === 'fallback') { say(who, text); text = ''; const to = line(bag(b.to).model); if (to) out.push({ kind: 'model', text: to }) }
      if (b.type === 'tool_use') {
        say(who, text); text = ''
        const bad = failed.get(str(b.id))
        out.push({ kind: 'tool', name: line(b.name, 40), text: toolLine(b.name, b.input), ...(bad === undefined ? {} : { state: bad ? 'failed' : 'ok' }) })
      }
    }
    say(who, text)
    if (who === 'assistant') for (const [n, c] of list(calls).entries()) {
      const f = bag(bag(c).function)
      // results come right after, in order; some servers use the same ids again
      const r = bag(all[at + 1 + n]), bad = changes(f.name) && r.role === 'tool' ? str(r.content).startsWith('Error: ') : undefined
      out.push({ kind: 'tool', name: line(f.name, 40), text: toolLine(f.name, json(f.arguments)), ...(bad === undefined ? {} : { state: bad ? 'failed' : 'ok' }) })
    }
  }
  return out
}

/** The chat by question: what was asked and all that came of it. `start`: the question's place in the messages. */
export function turns(messages: unknown): { start: number; items: Item[] }[] {
  const all = list(messages)
  const asks = all.flatMap((m, i) => (bag(m).role === 'user' && items([m]).length ? [i] : []))
  if (all.length && asks[0] !== 0) asks.unshift(0)
  return asks.map((start, k) => ({ start, items: items(all.slice(start, asks[k + 1])) }))
}

/** The last thing the assistant said, for screen readers. */
export function lastAnswer(messages: unknown): string {
  const all = items(messages)
  const last = all[all.length - 1]
  return last?.kind === 'assistant' ? last.text : ''
}

/** A model's Markdown as words to be read out. */
export const plainText = (s: string): string => s.slice(0, 20_000)
  .replace(/^[ \t]*`{3,}.*$\n?/gm, '')
  .replace(/^[ \t|:-]+$\n?/gm, (l) => (l.includes('|') && l.includes('-') ? '' : l))
  .replace(/^ {0,3}(?:#{1,6}|>|[-*+])[ \t]+/gm, '')
  .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_l, row: string) => row.split('|').map((c) => c.trim()).join(', '))
  .replace(/!\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, 'image: $1')
  .replace(/\[([^\]\n]{1,500})\]\(([^)\s]{0,2000})\)/g, '$1 ($2)')
  .replace(/\*\*([^*\n]{1,2000})\*\*/g, '$1').replace(/\*([^*\s][^*\n]{0,2000})\*/g, '$1').replace(/`([^`\n]{1,2000})`/g, '$1')
