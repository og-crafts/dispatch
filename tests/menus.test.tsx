/** Dropdown menus (<details class="menu">) close on a click elsewhere, Escape, or when another menu opens. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App } from '../src/ui/App'
import { resetForTests } from '../src/core/db'
import type { HttpResponse } from '../src/core/types'
import type { Transport } from '../src/core/transport'

const transport: Transport = {
  label: 'Fake', unrestricted: true,
  send: async (): Promise<HttpResponse> => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }),
}
beforeEach(async () => { await resetForTests() })
afterEach(() => cleanup())

const mainMenu = () => screen.getByLabelText('Menu').closest('details')!
const openIt = (d: HTMLDetailsElement) => act(() => { d.open = true })

describe('dropdown menus', () => {
  it('close on a click outside, but not on a click inside', async () => {
    render(<App transport={transport} />)
    const url = await screen.findByLabelText('URL')
    const d = mainMenu(); openIt(d)
    fireEvent.pointerDown(d.querySelector('[role="menu"]')!)
    expect(d.open).toBe(true)
    fireEvent.pointerDown(url)
    expect(d.open).toBe(false)
  })

  it('close on Escape and give focus back to the menu button', async () => {
    render(<App transport={transport} />)
    await screen.findByLabelText('URL')
    const d = mainMenu(); openIt(d)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(d.open).toBe(false)
    expect(document.activeElement).toBe(screen.getByLabelText('Menu'))
  })

  it('opening one menu closes another', async () => {
    render(<App transport={transport} />)
    await screen.findByLabelText('URL')
    const all = [...document.querySelectorAll<HTMLDetailsElement>('details.menu')]
    expect(all.length).toBeGreaterThan(1)
    const [a, b] = [mainMenu(), all.find((x) => x !== mainMenu())!]
    openIt(a)
    fireEvent.pointerDown(b.querySelector('summary')!)
    expect(a.open).toBe(false)
  })
})
