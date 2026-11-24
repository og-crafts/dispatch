/** The update notice's behaviour: when it checks, what it remembers, and that installing is safe to retry. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMeta, putMeta, resetForTests } from '../src/core/db'
import { defaultSettings, type Settings } from '../src/core/types'

const H = 3_600_000
let calls: string[] = []
let on: Record<string, () => unknown> = {}
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (cmd: string) => { calls.push(cmd); return on[cmd]?.() } }))
let offered = false
vi.mock('../src/ui/telemetry', async (orig) => ({ ...(await orig<object>()), telemetryOffered: () => offered }))
const { useUpdates } = await import('../src/ui/useUpdates')

const info = (version: string | null) => ({ current: '0.2.0', version, notes: null, date: null })
const checks = () => calls.filter((c) => c === 'update_check').length
/** Lets promises and IndexedDB (fake-indexeddb runs on setImmediate) settle while the clock is faked. */
const flush = () => act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) })
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms) }); await flush() }

beforeEach(async () => {
  await resetForTests()
  calls = []; offered = false
  on = { update_configured: () => true, update_check: () => info(null), update_install: () => undefined }
  ;(window as any).__TAURI_INTERNALS__ = {}
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-11-24T10:00:00Z'))
})
afterEach(() => { cleanup(); vi.useRealTimers(); delete (window as any).__TAURI_INTERNALS__ })

async function start(o: { settings?: Partial<Settings>; confirm?: (m: string) => Promise<boolean>; seen?: boolean } = {}) {
  if (o.seen) await putMeta('updateState', { noticeAt: Date.now() - 48 * H, noticeAnswered: true })
  const notify = vi.fn()
  const confirm = vi.fn(o.confirm ?? (async () => true))
  const setSettings = vi.fn()
  let settings: Settings = { ...defaultSettings, ...o.settings }
  const ws = () => ({ ready: true, settings, setSettings }) as never
  const h = renderHook(() => useUpdates(ws(), notify, confirm))
  setSettings.mockImplementation((p: Partial<Settings>) => { settings = { ...settings, ...p }; h.rerender() })
  await flush()
  return { h, notify, confirm, setSettings, get: () => h.result.current, settings: () => settings }
}

describe('when it checks', () => {
  it('never in the web app', async () => {
    delete (window as any).__TAURI_INTERNALS__
    const x = await start({ seen: true })
    await wait(25 * H)
    expect(checks()).toBe(0); expect(x.get().noticeOpen).toBe(false)
  })
  it('never in a build without an update key', async () => {
    on.update_configured = () => false
    const x = await start({ seen: true })
    await wait(25 * H)
    expect(checks()).toBe(0); expect(x.get().noticeOpen).toBe(false)
  })
  it('shows the notice first, and checks a day later', async () => {
    const x = await start()
    expect(x.get().noticeOpen).toBe(true)
    expect(await getMeta('updateState')).toMatchObject({ noticeAt: Date.now() })
    expect(checks()).toBe(0)
    await wait(24 * H)
    expect(checks()).toBe(1)
  })
  it('asks nothing on top of the first-launch privacy question', async () => {
    offered = true
    const x = await start()
    expect(x.get().noticeOpen).toBe(false)
    await act(async () => { x.setSettings({ telemetryAsked: true }) }); await flush()
    expect(x.get().noticeOpen).toBe(true)
  })
  it('checks on start once the notice was seen in an earlier run', async () => {
    const x = await start({ seen: true })
    expect(checks()).toBe(1); expect(x.get().noticeOpen).toBe(false)
  })
  it('stays off after Turn off', async () => {
    const x = await start()
    await act(async () => x.get().answerNotice(false)); await flush()
    expect(x.settings().autoUpdateCheck).toBe(false)
    expect(x.get().noticeOpen).toBe(false)
    await wait(25 * H)
    expect(checks()).toBe(0)
  })
  it('drops the result of a check under way when turned off', async () => {
    let done!: (v: unknown) => void
    on.update_check = () => new Promise((r) => { done = r })
    const x = await start({ seen: true })
    await act(async () => { x.setSettings({ autoUpdateCheck: false }) })
    await act(async () => { done(info('0.3.0')) }); await flush()
    expect(x.get().available).toBeNull()
  })
  it('says nothing when an automatic check fails', async () => {
    on.update_check = () => { throw new Error('offline') }
    const x = await start({ seen: true })
    expect(checks()).toBe(1); expect(x.notify).not.toHaveBeenCalled()
  })
})

describe('the button', () => {
  it('goes away for a dismissed version, not for a newer one', async () => {
    on.update_check = () => info('0.3.0')
    const x = await start({ seen: true })
    expect(x.get().available?.version).toBe('0.3.0')
    await act(async () => x.get().dismiss()); await flush()
    expect(x.get().available).toBeNull()
    await wait(24 * H)
    expect(checks()).toBe(2); expect(x.get().available).toBeNull()
    on.update_check = () => info('0.4.0')
    await wait(24 * H)
    expect(x.get().available?.version).toBe('0.4.0')
  })
  it('comes back, and asks, when the person checks', async () => {
    on.update_check = () => info('0.3.0')
    const x = await start({ seen: true, confirm: async () => false })
    await act(async () => x.get().dismiss()); await flush()
    await act(async () => { await x.get().checkNow() }); await flush()
    expect(x.get().available?.version).toBe('0.3.0')
    expect(x.confirm).toHaveBeenCalledTimes(1)
    expect((await getMeta<{ dismissed?: string }>('updateState'))?.dismissed).toBeUndefined()
  })
})

describe('installing', () => {
  it('can be tried again after a failure', async () => {
    on.update_check = () => info('0.3.0')
    const x = await start({ seen: true })
    on.update_install = () => { throw new Error('Couldn’t install the update') }
    await act(async () => { await x.get().install() }); await flush()
    expect(x.notify).toHaveBeenLastCalledWith('Couldn’t install the update', expect.objectContaining({ label: 'Open download page' }))
    expect(x.get().available?.version).toBe('0.3.0')
    on.update_install = () => undefined
    calls = []
    await act(async () => { await x.get().install() })
    expect(calls).toEqual(['update_check', 'update_install'])
  })
  it('asks again when a newer version appeared meanwhile', async () => {
    on.update_check = () => info('0.3.0')
    let n = 0
    const x = await start({ seen: true, confirm: async () => ++n === 1 })
    on.update_check = () => info('0.4.0')
    await act(async () => { await x.get().install() })
    expect(x.confirm).toHaveBeenCalledTimes(2)
    expect(x.confirm.mock.calls[1][0]).toContain('Install Dispatch 0.4.0?')
    expect(calls).not.toContain('update_install')
  })
  it('clears the button when nothing newer is left', async () => {
    on.update_check = () => info('0.3.0')
    const x = await start({ seen: true })
    on.update_check = () => info(null)
    await act(async () => { await x.get().install() })
    expect(x.get().available).toBeNull()
    expect(x.notify).toHaveBeenLastCalledWith('You have the newest version (0.2.0).')
  })
  it('once, however often it is clicked', async () => {
    on.update_check = () => info('0.3.0')
    const x = await start({ seen: true })
    await act(async () => { await Promise.all([x.get().install(), x.get().install()]) })
    expect(x.confirm).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c === 'update_install')).toHaveLength(1)
  })
})

describe('Check for updates', () => {
  it('says when this is the newest version, and why a check failed', async () => {
    const x = await start({ settings: { autoUpdateCheck: false }, seen: true })
    await act(async () => { await x.get().checkNow() })
    expect(x.notify).toHaveBeenLastCalledWith('You have the newest version (0.2.0).')
    on.update_check = () => { throw 'This build can’t update itself.' }
    await act(async () => { await x.get().checkNow() })
    expect(x.notify).toHaveBeenLastCalledWith('This build can’t update itself.')
  })
})
