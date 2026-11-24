/** The Test button: asks the model to call a tool this test makes up. Nothing from the workspace is sent, so it needs no consent. */
import { validate } from '../../core/assistant/gate'
import type { Connection } from '../../core/assistant/connections'
import type { NetSettings } from '../../core/assistant/nativeFetch'
import { AssistantError } from '../../core/assistant/providers/shared'
import type { ToolSpec, Turn } from '../../core/assistant/providers/types'

export interface TestResult {
  reachable: boolean
  streams: boolean
  answers: boolean
  /** Left out when the test didn't get far enough to know. */
  tools?: 'yes' | 'no'
  error?: string
}

const PING: ToolSpec = { name: 'ping', description: 'Checks that tools work. Returns pong.', inputSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } }
const SYSTEM = 'This is a connection test. Keep it short.'
/** The server got the request and may have refused it because of the tools. */
const aboutTools = (e: unknown) => e instanceof AssistantError && (e.status === 400 || e.status === 422 || e.status === 501)

/** Rejects only when stopped. */
export async function testConnection(conn: Connection, net: NetSettings, signal: AbortSignal): Promise<TestResult> {
  const out: TestResult = { reachable: false, streams: false, answers: false }
  try {
    const { createProvider } = await import('../../core/assistant/providers')
    const provider = await createProvider(conn, net)
    const turn = async (messages: unknown[], tools: ToolSpec[]): Promise<Turn> => {
      const t = await provider.turn({ system: SYSTEM, messages, tools, signal, onText: () => { out.streams = true } })
      out.reachable = true
      if (t.stop === 'refused') throw new AssistantError(`${conn.name} declined to answer the test.`)
      return t
    }
    const plain = async () => {
      out.tools = 'no'
      out.answers = !!(await turn([{ role: 'user', content: 'Say hello in one word.' }], [])).text.trim()
    }
    let stage: 'tools' | 'plain' = 'tools'
    try {
      const messages: unknown[] = [{ role: 'user', content: 'Call the ping tool with the word dispatch. Then say in a few words what it returned.' }]
      const first = await turn(messages, [PING])
      const ok = first.calls.length > 0 && first.calls.every((c) => !c.invalid && c.name === PING.name && !validate(c.input, PING.inputSchema))
      if (!ok) {
        stage = 'plain'
        if (first.calls.length || !first.text.trim()) await plain()
        else { out.tools = 'no'; out.answers = true }
      } else {
        const results = provider.toolResults(first.calls.map((c) => ({ id: c.id, text: 'pong', isError: false })))
        const second = await turn([...messages, first.message, ...results], [PING])
        out.answers = !!second.text.trim()
        if (out.answers) out.tools = 'yes'
        else { stage = 'plain'; await plain() }
      }
    } catch (e) {
      if (signal.aborted || stage === 'plain' || !aboutTools(e)) throw e
      out.reachable = true
      await plain()
    }
    if (!out.answers) { delete out.tools; out.error = `${conn.name} sent an empty answer. Try the test again, or another model.` }
  } catch (e) {
    if (signal.aborted) throw e
    delete out.tools
    if (e instanceof AssistantError && e.status !== undefined) out.reachable = true
    out.error = e instanceof AssistantError ? e.message : 'The test didn’t work. Try again.'
  }
  return out
}
