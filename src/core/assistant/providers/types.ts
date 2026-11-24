/** What the chat loop needs from a model, whatever the kind of connection. */
export interface ToolSpec { name: string; description: string; inputSchema: object }

/** `input` is only there when the arguments were one complete JSON object; otherwise `invalid` says why and nothing may run. */
export interface Call { id: string; name: string; input: unknown; invalid?: string }

export interface Turn {
  /**
   * The assistant's message as the provider wants it back: append it and never change it. After `refused` it may be
   * empty or partial, so don't send it back. After `length` it can be empty or end in thinking: check before sending it.
   */
  message: unknown
  text: string
  /** After `length` or `refused` every call is `invalid`. */
  calls: Call[]
  stop: 'end' | 'tools' | 'length' | 'refused'
  usage?: { input: number; output: number }
  /** Set when the chosen model declined and another one answered (server-side fallback): the person is told. */
  fallbackModel?: string
}

export interface TurnRequest { system: string; messages: unknown[]; tools: ToolSpec[]; signal: AbortSignal; onText(s: string): void }

export interface Provider {
  /** The connection it was made for. */
  readonly connectionId: string
  turn(t: TurnRequest): Promise<Turn>
  toolResults(calls: { id: string; text: string; isError: boolean }[]): unknown[]
  listModels(signal?: AbortSignal): Promise<string[]>
}
