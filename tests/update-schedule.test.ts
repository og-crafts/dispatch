/** When the desktop app may look for a new version on its own. */
import { describe, expect, it } from 'vitest'
import { checkDue } from '../src/core/updateSchedule'
import { getSettings, putSettings, resetForTests } from '../src/core/db'
import { defaultSettings } from '../src/core/types'

const H = 3_600_000
const base = { enabled: true, runStartedAt: 1000, now: 2000 }
describe('checkDue', () => {
  it('waits for the notice', () => expect(checkDue(base)).toBe(false))
  it('waits after a notice in this run', () => expect(checkDue({ ...base, noticeAt: 1500 })).toBe(false))
  it('checks 24 h after it', () => expect(checkDue({ ...base, noticeAt: 1500, now: 1500 + 24 * H })).toBe(true))
  it('checks after a restart', () => expect(checkDue({ ...base, noticeAt: 500 })).toBe(true))
  it('not again within 24 h', () => expect(checkDue({ ...base, noticeAt: 500, lastCheckAt: 1500, now: 1500 + 23 * H })).toBe(false))
  it('once after a long sleep', () => {
    const now = 1500 + 48 * H
    expect(checkDue({ ...base, noticeAt: 500, lastCheckAt: 1500, now })).toBe(true)
    expect(checkDue({ ...base, noticeAt: 500, lastCheckAt: now, now: now + 60_000 })).toBe(false)
  })
  it('off', () => expect(checkDue({ ...base, enabled: false, noticeAt: 500 })).toBe(false))
})

it('is on for people whose saved settings say updateCheckOnStart: false', async () => {
  await resetForTests()
  await putSettings({ ...defaultSettings, updateCheckOnStart: false } as never)
  expect((await getSettings()).autoUpdateCheck).toBe(true)
})
