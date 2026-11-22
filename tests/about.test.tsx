/** Menu → About Dispatch, and the changelog it shows (the same file builds the site's changelog page). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { App } from '../src/ui/App'
import { resetForTests } from '../src/core/db'
import { RELEASES, inlineParts } from '../src/core/changelog'
import { versionLine } from '../src/ui/AboutDialog'
import type { HttpResponse } from '../src/core/types'
import type { Transport } from '../src/core/transport'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version as string
const transport: Transport = {
  label: 'Fake', unrestricted: true,
  send: async (): Promise<HttpResponse> => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }),
}
beforeEach(async () => { await resetForTests() })
afterEach(() => cleanup())

describe('changelog.json', () => {
  it('has an entry for this version at the top (add one with every release)', () => {
    expect(RELEASES[0].version).toBe(pkg)
  })
  it('lists each release once, newest first, with a date and at least one change', () => {
    const versions = RELEASES.map((r) => r.version)
    expect(new Set(versions).size).toBe(versions.length)
    const num = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number)
    for (let i = 1; i < RELEASES.length; i++) {
      const [a, b] = [num(RELEASES[i - 1].version), num(RELEASES[i].version)]
      expect(a[0] * 1e6 + a[1] * 1e3 + a[2]).toBeGreaterThan(b[0] * 1e6 + b[1] * 1e3 + b[2])
      expect(RELEASES[i - 1].date >= RELEASES[i].date).toBe(true)
    }
    for (const r of RELEASES) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r.changes.length).toBeGreaterThan(0)
    }
  })
  it('splits `code` and **bold** and leaves other text alone', () => {
    expect(inlineParts('Use `dx.send` **now**, a*b')).toEqual([
      { kind: 'text', text: 'Use ' }, { kind: 'code', text: 'dx.send' }, { kind: 'text', text: ' ' },
      { kind: 'bold', text: 'now' }, { kind: 'text', text: ', a*b' },
    ])
  })
})

describe('About Dispatch', () => {
  it('opens from the menu with the version, links and every release', async () => {
    render(<App transport={transport} />)
    await screen.findByLabelText('URL')
    fireEvent.click(screen.getByLabelText('Menu'))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'About Dispatch…' })) })
    const d = screen.getByRole('dialog', { name: 'Dispatch', hidden: true })
    expect(d.textContent).toContain(`Version ${pkg}`)
    for (const l of ['Website', 'Source code', 'Privacy', 'Licence (MIT)']) expect(within(d).getByRole('button', { name: l, hidden: true })).toBeTruthy()
    const releases = d.querySelectorAll('details.aboutRelease')
    expect(releases.length).toBe(RELEASES.length)
    expect((releases[0] as HTMLDetailsElement).open).toBe(true)
    expect(releases[0].textContent).toContain('this version')
    expect(d.querySelectorAll('details.aboutRelease li').length).toBe(RELEASES.reduce((n, r) => n + r.changes.length, 0))
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Close', hidden: true })) })
    expect(screen.queryByRole('dialog', { name: 'Dispatch', hidden: true })).toBeNull()
  })
  it('gives a version line for bug reports', () => {
    expect(versionLine('snapshot', true)).toBe(`Dispatch ${pkg} (snapshot), desktop app`)
    expect(versionLine('release', false)).toBe(`Dispatch ${pkg}, web app`)
  })
})
