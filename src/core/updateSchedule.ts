/** When the desktop app may look for a new version on its own. */

/** What this device remembers about updates (IndexedDB meta `updateState`; never in backups). */
export interface UpdateState {
  /** When the one-time notice was first shown. */
  noticeAt?: number
  noticeAnswered?: boolean
  /** The version whose button was dismissed. */
  dismissed?: string
}

export const DAY = 24 * 3_600_000

/**
 * The first check waits until the notice has been shown and the app restarted, or a day has passed, so there is time
 * to turn it off. Then once per start and once a day. Wall-clock times, so a long sleep gives one check.
 */
export function checkDue(x: { enabled: boolean; noticeAt?: number; runStartedAt: number; lastCheckAt?: number; now: number }): boolean {
  if (!x.enabled || x.noticeAt === undefined) return false
  if (x.lastCheckAt !== undefined) return x.now - x.lastCheckAt >= DAY
  return x.noticeAt < x.runStartedAt || x.now - x.noticeAt >= DAY
}
