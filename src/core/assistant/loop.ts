/**
 * One question to the assistant: ask the model, run what it calls through the gate, and go on until it answers.
 * Messages are only ever added. They can always be sent again: a turn that didn't finish adds nothing, and every call
 * in a turn that did has a result, also after a stop or at a limit.
 */
import { Redactor } from '../mcpLogs'
import { reach, validateAddress, type Connection } from './connections'
import type { ToolResult } from './gate'
import { abortError, AssistantError, assertUsable, scrub } from './providers/shared'
import type { Provider, ToolSpec, Turn } from './providers/types'

export interface LoopEvents {
  text(s: string): void
  toolStart(name: string, input: unknown): void
  toolEnd(name: string, isError: boolean): void
  usage(u: { input: number; output: number }): void
  /** The chosen model declined and this one answered. */
  fallback?(model: string): void
}

export interface AskOptions {
  provider: Provider
  conn: Connection
  system: string
  /** The conversation, ending with what the person just typed. */
  messages: unknown[]
  tools: ToolSpec[]
  /** runTool, with its context. */
  run: (name: string, input: unknown, signal: AbortSignal) => Promise<ToolResult>
  /** Every connection key: hidden in what the person just typed. */
  keys?: () => string[]
  signal: AbortSignal
  on: LoopEvents
}

export interface Answer { messages: unknown[]; ended: 'done' | 'stopped' | 'limit' | 'length' | 'refused' | 'error'; error?: string }

const MAX_CALLS = 25
const MAX_MS = 10 * 60_000

/** Why nothing may be sent to this connection now, or null. The person's yes is for one host. */
function refusal(conn: Connection): string | null {
  const bad = validateAddress(conn.baseUrl)
  if (bad) return scrub(`${conn.name}: ${bad}`, conn)
  try { assertUsable(conn) } catch (e) { return e instanceof AssistantError ? e.message : 'This connection can’t be used. Check its settings.' }
  const { host } = new URL(conn.baseUrl)
  if (reach(conn.baseUrl) !== 'local' && conn.consentHost !== host) return scrub(`Before anything is sent to ${host}, say that ${conn.name} may get it.`, conn)
  return null
}

/** The person's own words, as typed, without connection keys. */
function withoutKeys(message: unknown, keys: string[]): unknown {
  const m = message as { role?: unknown; content?: unknown } | null | undefined
  return m?.role === 'user' && typeof m.content === 'string' ? { ...m, content: new Redactor(keys).known(m.content) } : message
}

/** Some servers refuse a conversation with an empty message, or one that ends in unfinished thinking. */
function canGoBack(t: Turn): boolean {
  const content = (t.message as { content?: unknown } | null)?.content
  const last = Array.isArray(content) ? (content[content.length - 1] as { type?: string } | undefined)?.type ?? '' : ''
  return !t.calls.length && t.text.trim() !== '' && !(t.stop === 'length' && last.includes('thinking'))
}

/** `p`, or a rejection as soon as `signal` aborts. */
function until<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((res, rej) => {
    const stop = () => rej(abortError())
    if (signal.aborted) stop()
    signal.addEventListener('abort', stop, { once: true })
    p.then(res, rej).finally(() => signal.removeEventListener('abort', stop))
  })
}

export async function ask(o: AskOptions): Promise<Answer> {
  const messages = o.messages.map((m, i) => (i === o.messages.length - 1 ? withoutKeys(m, [o.conn.key, ...(o.keys?.() ?? [])]) : m))
  const end = (ended: Answer['ended'], error?: string): Answer => ({ messages, ended, ...(error ? { error } : {}) })
  const no = refusal(o.conn)
  if (no) return end('error', no)
  if (o.signal.aborted) return end('stopped')

  // One signal for both ways to be cut short: the person's stop, and the time limit.
  const ctl = new AbortController()
  const { signal } = ctl
  const stop = () => ctl.abort()
  o.signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, MAX_MS)
  /** Tells the panel, unless this was stopped. What the panel does with it must not break the conversation. */
  const tell = (f: () => void) => { if (!signal.aborted) try { f() } catch { /* the panel's problem */ } }
  const cut = () => (o.signal.aborted ? end('stopped') : end('limit', 'This took 10 minutes, so it was stopped. Send another message to go on.'))
  const tools = o.conn.tools === 'no' ? [] : o.tools
  let used = 0

  try {
    for (;;) {
      let turn: Turn, live = true
      try {
        turn = await until(o.provider.turn({ system: o.system, messages: [...messages], tools, signal, onText: (s) => { if (live) tell(() => o.on.text(s)) } }), signal)
      } finally { live = false }
      if (signal.aborted) return cut()
      const { usage, fallbackModel, calls } = turn
      if (usage) tell(() => o.on.usage(usage))
      if (fallbackModel) tell(() => o.on.fallback?.(fallbackModel))
      if (turn.stop === 'refused') return end('refused')
      if (turn.stop === 'length' || !calls.length) {
        if (canGoBack(turn)) messages.push(turn.message)
        return end(turn.stop === 'length' ? 'length' : 'done')
      }

      const results: { id: string; text: string; isError: boolean }[] = []
      for (const c of calls) {
        let r: ToolResult
        if (signal.aborted) r = { text: o.signal.aborted ? 'The person stopped this. Nothing was run.' : 'Time ran out. Nothing was run.', isError: true }
        else if (used >= MAX_CALLS) r = { text: 'The limit of tool calls for one message was reached. Nothing was run.', isError: true }
        else {
          used++
          tell(() => o.on.toolStart(c.name, c.input))
          try {
            if (c.invalid) r = { text: c.invalid, isError: true }
            else if (!tools.some((t) => t.name === c.name)) r = { text: 'There is no such tool here. Nothing was run.', isError: true }
            else r = await until((async () => o.run(c.name, c.input, signal))(), signal)
          } catch {
            r = { text: !signal.aborted ? 'This tool failed inside Dispatch.' : o.signal.aborted ? 'The person stopped this.' : 'Time ran out.', isError: true }
          }
          const { isError } = r
          tell(() => o.on.toolEnd(c.name, isError))
        }
        results.push({ id: c.id, text: r.text, isError: r.isError })
      }
      messages.push(turn.message, ...o.provider.toolResults(results))
      if (signal.aborted) return cut()
      if (used >= MAX_CALLS) return end('limit', `That was ${MAX_CALLS} look-ups for one message, so it stopped here. Send another message to go on.`)
    }
  } catch (e) {
    if (signal.aborted) return cut()
    return end('error', e instanceof AssistantError ? scrub(e.message, o.conn) : 'Something went wrong in the assistant. Try again.')
  } finally {
    clearTimeout(timer)
    o.signal.removeEventListener('abort', stop)
  }
}
