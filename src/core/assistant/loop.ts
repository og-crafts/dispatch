/**
 * One question to the assistant: ask the model, run what it calls through the gate, and go on until it answers.
 * Messages are only ever added. They can always be sent again: a turn that didn't finish adds nothing, and every call
 * in a turn that did has a result, also after a stop or at a limit.
 */
import { Redactor } from '../mcpLogs'
import { reach, validateAddress, type Connection } from './connections'
import { smallContext, type ToolResult } from './gate'
import { AssistantError, assertUsable, scrub, until } from './providers/shared'
import type { Provider, ToolSpec, Turn } from './providers/types'

export interface LoopEvents {
  text(s: string): void
  toolStart(name: string, input: unknown): void
  toolEnd(name: string, isError: boolean): void
  usage(u: { input: number; output: number }): void
  /** The chosen model declined and this one answered. */
  fallback?(model: string): void
}

/** The 10 minutes. They stand still while the person is asked. Once or many times, pausing is the same; it ends with the call. */
export interface Clock { pause(): void; resume(): void }

export interface AskOptions {
  provider: Provider
  conn: Connection
  system: string
  /** The conversation, ending with what the person just typed. */
  messages: unknown[]
  tools: ToolSpec[]
  /** runTool, with its context. */
  run: (name: string, input: unknown, signal: AbortSignal, clock: Clock) => Promise<ToolResult>
  /** Whether this tool's result is awaited even after a stop, because it says what was done. It must come soon after one. */
  settles?: (name: string) => boolean
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
  if (m?.role !== 'user') return message
  const redact = new Redactor(keys)
  if (typeof m.content === 'string') return { ...m, content: redact.known(m.content) }
  if (!Array.isArray(m.content)) return message
  return { ...m, content: m.content.map((b: { type?: unknown; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: redact.known(b.text) } : b)) }
}

/** Some servers refuse a conversation with an empty message, or one that ends in unfinished thinking. */
function canGoBack(t: Turn): boolean {
  const content = (t.message as { content?: unknown } | null)?.content
  const last = Array.isArray(content) ? (content[content.length - 1] as { type?: string } | undefined)?.type ?? '' : ''
  return !t.calls.length && t.text.trim() !== '' && !(t.stop === 'length' && last.includes('thinking'))
}

export async function ask(o: AskOptions): Promise<Answer> {
  const messages = o.messages.map((m, i) => (i === o.messages.length - 1 ? withoutKeys(m, [o.conn.key]) : m))
  const end = (ended: Answer['ended'], error?: string): Answer => ({ messages, ended, ...(error ? { error } : {}) })
  const no = refusal(o.conn)
  if (no) return end('error', no)
  if (o.provider.connectionId !== o.conn.id) return end('error', 'This chat belongs to another connection. Start a new chat.')
  try {
    const keys = o.keys?.() ?? []
    if (messages.length) messages[messages.length - 1] = withoutKeys(messages[messages.length - 1], keys)
  } catch { return end('error', 'Something went wrong in the assistant. Try again.') }
  if (o.signal.aborted) return end('stopped')

  // One signal for both ways to be cut short: the person's stop, and the time limit.
  const ctl = new AbortController()
  const { signal } = ctl
  const stop = () => ctl.abort()
  o.signal.addEventListener('abort', stop, { once: true })
  let left = MAX_MS, since = 0, timer: ReturnType<typeof setTimeout> | undefined
  const go = () => { since = performance.now(); timer = setTimeout(stop, left) }
  const halt = () => { clearTimeout(timer); left = Math.max(0, left - (performance.now() - since)) }
  go()
  /** One for each call, so a call that is over can't touch it. */
  const clockOf = (): Clock & { end(): void } => {
    let over = false, paused = false
    const resume = () => { if (!paused) return; paused = false; go() }
    return { pause: () => { if (over || paused) return; paused = true; halt() }, resume, end: () => { resume(); over = true } }
  }
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
        const kept = canGoBack(turn)
        if (kept) messages.push(turn.message)
        else if (turn.stop !== 'length') return end('error', scrub(`${o.conn.name} sent an empty answer. Try again, or another model.${o.conn.kind === 'compatible' || smallContext(o.conn) ? ' Its context may be too small.' : ''}`, o.conn))
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
          const settles = !!o.settles?.(c.name)
          const clock = clockOf()
          try {
            if (c.invalid) r = { text: c.invalid, isError: true }
            else if (!tools.some((t) => t.name === c.name)) r = { text: 'There is no such tool here. Nothing was run.', isError: true }
            else {
              const p = (async () => o.run(c.name, c.input, signal, clock))()
              r = await (settles ? p : until(p, signal))
            }
          } catch {
            r = { text: !signal.aborted ? 'This tool failed inside Dispatch.' : o.signal.aborted ? 'The person stopped this.' : 'Time ran out.', isError: true }
          } finally { clock.end() }
          const { isError } = r
          // what was done is told also after a stop
          if (settles && !isError) try { o.on.toolEnd(c.name, isError) } catch { /* the panel's problem */ }
          else tell(() => o.on.toolEnd(c.name, isError))
        }
        results.push({ id: c.id, text: r.text, isError: r.isError })
      }
      messages.push(turn.message, ...o.provider.toolResults(results))
      if (signal.aborted) return cut()
      if (used >= MAX_CALLS) return end('limit', `That was ${MAX_CALLS} steps for one message, so it stopped here. Send another message to go on.`)
    }
  } catch (e) {
    if (signal.aborted) return cut()
    return end('error', e instanceof AssistantError ? scrub(e.message, o.conn) : 'Something went wrong in the assistant. Try again.')
  } finally {
    clearTimeout(timer)
    o.signal.removeEventListener('abort', stop)
  }
}
