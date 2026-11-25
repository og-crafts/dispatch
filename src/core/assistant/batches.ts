/** What suggest_parameters suggested, for apply_parameters. A file of its own: the app holds one from the start. */
import type { Suggestion } from '../parameterize'

/** `header`: which header holds it; without one, a credential is the sign-in's. */
export interface Found extends Suggestion { header?: number }
interface Batch { code: string; at: string; suggestions: Found[] }
const KEPT = 10
/** What was suggested lately, in memory only: ids mean something only while the request and the tables are as they were. */
export class ParameterBatches {
  private list: Batch[] = []
  add(at: string, suggestions: Found[]): string {
    const code = globalThis.crypto.randomUUID()
    this.list = [...this.list, { code, at, suggestions }].slice(-KEPT)
    return code
  }
  /** After a change nobody approved, such as one by an outside assistant. */
  clear() { this.list = [] }
  find(code: string): Batch | undefined { return this.list.find((b) => b.code === code) }
}
