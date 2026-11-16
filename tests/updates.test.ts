/** In-app updates: what the person is told, and that nothing installs without a yes. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string) => invoke(cmd) }))
const { runUpdateCheck } = await import('../src/ui/updates')

const info = (version: string | null) => ({ current: '0.5.2', version, notes: version ? 'Faster sends.' : null, date: null })
beforeEach(() => invoke.mockReset())

describe('runUpdateCheck', () => {
  it('says when this is the newest version', async () => {
    invoke.mockResolvedValueOnce(info(null))
    const notify = vi.fn()
    await runUpdateCheck(notify, vi.fn())
    expect(notify).toHaveBeenCalledWith('You have the newest version (0.5.2).')
  })

  it('asks before installing, and installs on yes', async () => {
    invoke.mockResolvedValueOnce(info('0.6.0')).mockResolvedValueOnce(undefined)
    const confirm = vi.fn(async (_m: string) => true)
    await runUpdateCheck(vi.fn(), confirm)
    expect(confirm.mock.calls[0][0]).toMatch(/Install Dispatch 0\.6\.0\? You have 0\.5\.2\.[\s\S]*Faster sends\./)
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['update_check', 'update_install'])
  })

  it('installs nothing on no', async () => {
    invoke.mockResolvedValueOnce(info('0.6.0'))
    await runUpdateCheck(vi.fn(), async () => false)
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['update_check'])
  })

  it('stays quiet on start unless there is an update, then offers it', async () => {
    const notify = vi.fn()
    invoke.mockRejectedValueOnce(new Error('offline'))
    await runUpdateCheck(notify, vi.fn(), true)
    invoke.mockResolvedValueOnce(info(null))
    await runUpdateCheck(notify, vi.fn(), true)
    expect(notify).not.toHaveBeenCalled()
    invoke.mockResolvedValueOnce(info('0.6.0'))
    await runUpdateCheck(notify, vi.fn(), true)
    expect(notify).toHaveBeenCalledWith('Dispatch 0.6.0 is available.', expect.objectContaining({ label: 'Install…' }))
  })

  it('shows why a check failed', async () => {
    invoke.mockRejectedValueOnce('This build can’t update itself.')
    const notify = vi.fn()
    await runUpdateCheck(notify, vi.fn())
    expect(notify).toHaveBeenCalledWith('This build can’t update itself.')
  })
})
