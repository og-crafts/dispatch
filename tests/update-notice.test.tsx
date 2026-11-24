/** What people see of updates in the app. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getSettings, putMeta, resetForTests } from '../src/core/db'
import type { Transport } from '../src/core/transport'

let version: string | null = '0.3.0'
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (cmd: string) => {
  if (cmd === 'update_configured') return true
  if (cmd === 'update_check') return { current: '0.2.0', version, notes: null, date: null }
  return undefined
} }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
const { App } = await import('../src/ui/App')

const transport: Transport = { label: 'Fake', unrestricted: true, send: async () => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }) }
beforeEach(async () => { await resetForTests(); version = '0.3.0'; (window as any).__TAURI_INTERNALS__ = {} })
afterEach(() => { cleanup(); delete (window as any).__TAURI_INTERNALS__ })
const seen = () => putMeta('updateState', { noticeAt: 1, noticeAnswered: true })

it('shows a lasting button that outlives other messages', async () => {
  await seen()
  render(<App transport={transport} />)
  await screen.findByRole('button', { name: 'Update to 0.3.0' }, { timeout: 5000 })
  const file = new File(['not json'], 'x.json', { type: 'application/json' })
  await act(async () => { fireEvent.change(document.querySelector('input[aria-label="Import file"]')!, { target: { files: [file] } }) })
  await waitFor(() => expect(document.querySelector('.toast')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Update to 0.3.0' })).toBeTruthy()
})

it('asks before installing', async () => {
  await seen()
  render(<App transport={transport} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.3.0' }, { timeout: 5000 }))
  await screen.findByText(/Install Dispatch 0\.3\.0\? You have 0\.2\.0\./)
})

it('dismisses one version and moves focus to the menu', async () => {
  await seen()
  render(<App transport={transport} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss update 0.3.0' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Update to 0.3.0' })).toBeNull())
  expect(document.activeElement).toBe(screen.getByLabelText('Menu'))
})

it('tells people once, and OK keeps checks on', async () => {
  render(<App transport={transport} />)
  const text = await screen.findByText('Dispatch looks for new versions on GitHub. No workspace data is sent.')
  expect(text.closest('[role="status"]')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  await waitFor(() => expect(screen.queryByText(/Dispatch looks for new versions/)).toBeNull())
  expect((await getSettings()).autoUpdateCheck).toBe(true)
})

it('Turn off unticks the setting', async () => {
  render(<App transport={transport} />)
  await screen.findByText(/Dispatch looks for new versions/)
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  await waitFor(async () => expect((await getSettings()).autoUpdateCheck).toBe(false))
  fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
  fireEvent.click(await screen.findByRole('tab', { name: 'General' }).catch(() => screen.getByRole('button', { name: 'General' })))
  const box = await screen.findByLabelText('Check for new versions automatically (asks GitHub when Dispatch starts and once a day; nothing is installed without asking)')
  expect((box as HTMLInputElement).checked).toBe(false)
})
