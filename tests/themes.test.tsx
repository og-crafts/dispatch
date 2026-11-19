/** Themes: the look reaches the page, survives a restart, and the Grove colours stay readable. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { App } from '../src/ui/App'
import { getSettings, putSettings, resetForTests } from '../src/core/db'
import type { HttpResponse } from '../src/core/types'
import type { Transport } from '../src/core/transport'

const transport = { label: 'Fake', unrestricted: true, send: async (): Promise<HttpResponse> => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }) } as Transport
const look = () => document.documentElement.getAttribute('data-look')
const open = async () => { render(<App transport={transport} />); await screen.findByLabelText('URL') }

beforeEach(async () => { await resetForTests(); try { localStorage.clear() } catch { /* none */ } })
afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-look') })

describe('the look on the page', () => {
  it('follows the choice under Settings, Themes, and Dispatch is the page with no mark', async () => {
    await open()
    expect(look()).toBeNull()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Library' })).getByRole('button', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Themes' }))
    const looks = within(screen.getByRole('radiogroup', { name: 'Theme' }))
    fireEvent.click(looks.getByRole('radio', { name: /^Grove classic/ }))
    await waitFor(() => expect(look()).toBe('grove-classic'))
    fireEvent.click(looks.getByRole('radio', { name: /^Grove(?! classic)/ }))
    await waitFor(() => expect(look()).toBe('grove'))
    fireEvent.click(looks.getByRole('radio', { name: /^Dispatch/ }))
    await waitFor(() => expect(look()).toBeNull())
  })

  it('is still there after Dispatch is closed and opened again', async () => {
    await putSettings({ ...(await getSettings()), look: 'grove' })
    await open()
    await waitFor(() => expect(look()).toBe('grove'))
    cleanup()
    document.documentElement.removeAttribute('data-look')
    await open()
    await waitFor(() => expect(look()).toBe('grove'))
  })

  it('falls back to Dispatch when the saved look is one this version does not know', async () => {
    document.documentElement.setAttribute('data-look', 'grove')
    await putSettings({ ...(await getSettings()), look: 'neon' as never })
    await open()
    await waitFor(() => expect(look()).toBeNull())
  })
})

// WCAG contrast of the Grove tokens, read from the CSS itself: body text needs 4.5:1.
const css = readFileSync('src/ui/app.css', 'utf8')
function tokens(selector: string): Record<string, string> {
  const at = css.indexOf(selector + ' {')
  if (at < 0) throw new Error(`no block for ${selector}`)
  const out: Record<string, string> = {}
  for (const m of css.slice(at, css.indexOf('}', at)).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
function rgb(c: string): [number, number, number, number] {
  const hex = c.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as [number, number, number, number]
  const f = c.match(/^rgba?\(([^)]+)\)$/)
  if (!f) throw new Error(`can't read colour ${c}`)
  const [r, g, b, a = 1] = f[1].split(',').map((x) => parseFloat(x))
  return [r, g, b, a]
}
const over = (top: string, under: string) => { const [r, g, b, a] = rgb(top); const u = rgb(under); return [r, g, b].map((v, i) => v * a + u[i] * (1 - a)) }
const lum = (c: number[]) => { const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

describe.each([
  ['light', ':root[data-look^="grove"]'],
  ['dark', ':root[data-look^="grove"][data-theme="dark"]'],
])('Grove colours, %s', (_name, selector) => {
  // the dark block only restates what changes, so it sits on top of the light one
  const t = { ...tokens(':root[data-look^="grove"]'), ...tokens(selector) }
  const bg = rgb(t['--bg']).slice(0, 3)
  const on = (fg: string, back: string) => ratio(over(t[fg], '#000000'), over(t[back], t['--bg']))
  it.each([
    ['--ink', '--bg'], ['--muted', '--bg'], ['--ink', '--surface'], ['--muted', '--surface'], ['--ink', '--field'], ['--ink', '--raised'],
    ['--link', '--bg'], ['--danger', '--bg'], ['--warn', '--bg'], ['--good', '--bg'],
    ['--m-get', '--surface'], ['--m-post', '--surface'], ['--m-delete', '--surface'],
    ['--on-primary', '--primary-strong'], ['--on-sel', '--sel'], ['--sel-tag', '--sel'], ['--chip-ink', '--chip'],
    ['--cm-keyword', '--field'], ['--cm-string', '--field'], ['--cm-number', '--field'],
  ])('%s on %s reads at 4.5:1 or better', (fg, back) => {
    expect(t[fg], fg).toBeTruthy(); expect(t[back], back).toBeTruthy()
    expect(bg.length).toBe(3)
    expect(on(fg, back)).toBeGreaterThanOrEqual(4.5)
  })
})
