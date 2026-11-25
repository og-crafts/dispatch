/** A server-sent events (text/event-stream) parser, fed text as it arrives. */
export interface SseEvent { event: string; data: string; id: string | null; retry: number | null }

/** One event's data went over the parser's limit. */
export class SseTooLarge extends Error { constructor() { super('The event is too large.') } }

export class SseParser {
  private size = 0
  private buf = ''
  private skipLf = false
  private data: string[] = []
  private event = ''
  private id: string | null = null
  private retry: number | null = null
  lastEventId: string | null = null

  /** `maxEvent`: the most characters of data one event may have (unlimited unless given). */
  constructor(private readonly maxEvent = Infinity) {}

  /** Feeds a chunk; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    // A CR ends its line at once; an LF that opens the next chunk is the rest of that CRLF.
    const text = this.skipLf && chunk.startsWith('\n') ? chunk.slice(1) : chunk
    if (chunk) this.skipLf = false
    let at = 0
    const out: SseEvent[] = []
    // Only the new text is searched: what's kept has no line end.
    for (const m of text.matchAll(/\r\n|\r|\n/g)) {
      const line = this.buf + text.slice(at, m.index)
      this.buf = ''
      at = m.index + m[0].length
      if (m[0] === '\r' && at === text.length) this.skipLf = true
      if (line === '') {
        if (this.data.length) {
          out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id, retry: this.retry })
          if (this.id !== null) this.lastEventId = this.id
        }
        this.data = []; this.size = 0; this.event = ''; this.retry = null
        continue
      }
      if (line.startsWith(':')) continue // comment / keep-alive
      const i = line.indexOf(':')
      const field = i >= 0 ? line.slice(0, i) : line
      let value = i >= 0 ? line.slice(i + 1) : ''
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') {
        this.size += value.length + (this.data.length ? 1 : 0) // 1: the line end it is joined with
        if (this.size > this.maxEvent) throw new SseTooLarge()
        this.data.push(value)
      }
      else if (field === 'event') this.event = value
      else if (field === 'id' && !value.includes('\0')) this.id = value
      else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value)
    }
    this.buf += text.slice(at)
    if (this.size + this.buf.length > this.maxEvent + 8) throw new SseTooLarge() // 8: room for the field name
    return out
  }
}
