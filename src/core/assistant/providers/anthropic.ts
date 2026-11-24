/**
 * Anthropic's Messages API through its SDK. Events are put together here, not by the SDK's helper: the helper reads tool
 * input tolerantly and gives up the whole answer when it can't.
 */
import Anthropic, { APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'
import type { Connection } from '../connections'
import { abortError, AssistantError, assertUsable, blockCall, cutShort, httpError, limited, matchCalls, parseCall, runTurn, scrub, unreadable } from './shared'
import type { Call, Provider, Turn, TurnRequest } from './types'

type Event = Anthropic.Beta.Messages.BetaRawMessageStreamEvent
type Block = Anthropic.Beta.Messages.BetaRawContentBlockStartEvent['content_block']

const MAX_TOKENS = 32_000

const STOPS = new Map<string, Turn['stop']>(Object.entries({
  end_turn: 'end', stop_sequence: 'end', tool_use: 'tools', max_tokens: 'length', model_context_window_exceeded: 'length', refusal: 'refused',
}))
/** Errors reported inside a stream name a type, not a status. */
const STATUS = new Map(Object.entries({
  authentication_error: 401, billing_error: 402, permission_error: 403, not_found_error: 404, request_too_large: 413,
  rate_limit_error: 429, api_error: 500, timeout_error: 504, overloaded_error: 529,
}))

const isOfficial = (url: string) => { try { return new URL(url).host === 'api.anthropic.com' } catch { return false } }

/** Any SDK failure as a plain one; nothing of the original is kept (it can hold headers and bodies). */
function plain(e: unknown, conn: Connection): AssistantError {
  if (e instanceof AssistantError) return e
  if (e instanceof APIConnectionTimeoutError) return new AssistantError(scrub(`${conn.name} took too long to answer. Try again.`, conn))
  if (e instanceof APIError) {
    if (e.cause instanceof AssistantError) return e.cause
    const status = e.status ?? STATUS.get(e.type ?? '')
    if (status || e.error) return httpError(conn, status, e.error, e.headers?.get('retry-after'))
  }
  return unreadable(conn)
}

/** One content block as it comes in; `json` is the tool input's text so far. */
interface Part { block: Block; json: string; closed: boolean }

export function anthropicProvider(conn: Connection, unlimited: typeof globalThis.fetch): Provider {
  const fetch = limited(conn, unlimited)
  // Made per use: assertUsable comes first, because the SDK's own complaints about a key would quote it.
  // The credentials, address and log level are given so that nothing comes from the environment.
  const client = () => new Anthropic({ apiKey: conn.key.trim(), authToken: null, webhookKey: null, baseURL: conn.baseUrl.trim(), fetch, dangerouslyAllowBrowser: true, maxRetries: 0, logLevel: 'off' })

  async function attempt(t: TurnRequest, began: () => void): Promise<Turn> {
    const params = {
      model: conn.model, max_tokens: MAX_TOKENS, stream: true as const, system: t.system, thinking: { type: 'adaptive' as const },
      messages: t.messages as Anthropic.Beta.Messages.BetaMessageParam[] & Anthropic.Messages.MessageParam[],
      ...(t.tools.length ? { tools: t.tools.map((x) => ({ name: x.name, description: x.description, input_schema: x.inputSchema as Anthropic.Messages.Tool.InputSchema })), tool_choice: { type: 'auto' as const } } : {}),
    }
    const stream = isOfficial(conn.baseUrl)
      ? await client().beta.messages.create({ ...params, cache_control: { type: 'ephemeral' }, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] }, { signal: t.signal })
      : await client().messages.create(params, { signal: t.signal })

    const parts: Part[] = []
    let model = '', reason: string | null = null, done = false, fellBack = false
    const used = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    const count = (u: Partial<Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number | null>> & { iterations?: { type: string }[] | null }) => {
      used.input = u.input_tokens ?? used.input
      used.cacheRead = u.cache_read_input_tokens ?? used.cacheRead
      used.cacheWrite = u.cache_creation_input_tokens ?? used.cacheWrite
      used.output = u.output_tokens ?? used.output
      if (u.iterations?.some((x) => x.type === 'fallback_message')) fellBack = true
    }

    for await (const ev of stream as AsyncIterable<Event>) {
      if (ev.type === 'message_start') { model = ev.message.model; count(ev.message.usage) }
      else if (ev.type === 'content_block_start') {
        began()
        const block = { ...ev.content_block }
        parts[ev.index] = { block, json: '', closed: false }
        if (block.type === 'fallback') { fellBack = true; model = block.to.model }
        if (block.type === 'text' && block.text && !t.signal.aborted) t.onText(block.text)
      } else if (ev.type === 'content_block_delta') {
        const part = parts[ev.index]
        if (!part) throw unreadable(conn)
        const { block } = part, d = ev.delta
        if (d.type === 'text_delta' && block.type === 'text') { block.text += d.text; if (!t.signal.aborted) t.onText(d.text) }
        else if (d.type === 'thinking_delta' && block.type === 'thinking') block.thinking += d.thinking
        else if (d.type === 'signature_delta' && block.type === 'thinking') block.signature = d.signature
        else if (d.type === 'citations_delta' && block.type === 'text') block.citations = [...(block.citations ?? []), d.citation]
        else if (d.type === 'input_json_delta') part.json += d.partial_json
      } else if (ev.type === 'content_block_stop') { if (parts[ev.index]) parts[ev.index].closed = true }
      else if (ev.type === 'message_delta') { reason = ev.delta.stop_reason; count(ev.usage) }
      else if (ev.type === 'message_stop') { done = true; break }
    }
    if (!done || !reason) throw cutShort(conn)
    const stop = STOPS.get(reason)
    if (!stop) throw unreadable(conn)

    // Before the last fallback block only text may be sent back: the rest belongs to the model that declined.
    const lastFallback = parts.map((p) => p?.block.type).lastIndexOf('fallback')
    const kept = parts.filter((p, i) => p && (i > lastFallback || p.block.type === 'text' || p.block.type === 'fallback'))
    const calls: Call[] = []
    // the API refuses empty and blank text
    const content = kept.filter((p) => p.block.type !== 'text' || p.block.text.trim() !== '').map(({ block, json, closed }) => {
      if (block.type !== 'tool_use') return block
      let call = parseCall(block.id, block.name, json || JSON.stringify(block.input ?? {}))
      if (!closed) call = { id: call.id, name: call.name, input: undefined, invalid: 'The arguments weren’t finished. Nothing was run.' }
      calls.push(stop === 'length' || stop === 'refused' ? blockCall(call, stop) : call)
      // input must be an object; what wasn't one can't be sent back as it was
      return { ...block, input: call.invalid ? {} : call.input }
    })
    return {
      message: { role: 'assistant', content },
      text: kept.map((p) => (p.block.type === 'text' ? p.block.text : '')).join(''),
      calls, stop: matchCalls(stop, calls.length),
      usage: { input: used.input + used.cacheRead + used.cacheWrite, output: used.output },
      ...(fellBack && stop !== 'refused' && model ? { fallbackModel: model } : {}),
    }
  }

  return {
    connectionId: conn.id,
    turn: (t) => runTurn(t.signal, async (began) => {
      assertUsable(conn)
      try { return await attempt(t, began) } catch (e) {
        if (t.signal.aborted) throw abortError()
        throw plain(e, conn)
      }
    }),
    toolResults: (calls) => (calls.length ? [{ role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: c.text, is_error: c.isError })) }] : []),
    async listModels() {
      assertUsable(conn)
      try {
        const ids: string[] = []
        for await (const m of client().models.list({ limit: 100 })) ids.push(m.id)
        return ids
      } catch (e) { throw plain(e, conn) }
    },
  }
}
