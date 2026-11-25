import type { Connection } from '../../core/assistant/connections'

export const hostOf = (url: string) => { try { return new URL(url).host } catch { return '' } }
export const originOf = (url: string) => { try { return new URL(url).origin } catch { return '' } }

/** What everything that can be sent is bound to: a chat, a waiting consent question, a summary, a running job. */
export interface Binding { connectionId: string; model: string; origin?: string }
export const bindingOf = (c: Connection): Binding => ({ connectionId: c.id, model: c.model, origin: originOf(c.baseUrl) })
/** The saved connection this may be sent to, if it still is the one. */
export const bound = (list: Connection[], b: Binding): Connection | undefined =>
  list.find((c) => c.id === b.connectionId && c.model === b.model && !!b.origin && originOf(c.baseUrl) === b.origin)
