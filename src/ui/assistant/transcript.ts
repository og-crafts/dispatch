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

/** A look-up in plain words. */
export function toolLine(name: unknown, input: unknown): string {
  const i = bag(input)
  switch (name) {
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
  for (const m of list(messages)) {
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
    if (who === 'assistant') for (const c of list(calls)) {
      const f = bag(bag(c).function)
      out.push({ kind: 'tool', name: line(f.name, 40), text: toolLine(f.name, json(f.arguments)) })
    }
  }
  return out
}

/** The last thing the assistant said, for screen readers. */
export function lastAnswer(messages: unknown): string {
  const all = items(messages)
  const last = all[all.length - 1]
  return last?.kind === 'assistant' ? last.text : ''
}
