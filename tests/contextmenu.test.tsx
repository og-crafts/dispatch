/** Right-click menus: Postman's tab menu, and a sidebar row's ⋯ menu at the pointer. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

const tabs = () => within(screen.getByRole('tablist', { name: 'Open requests' })).getAllByRole('tab').map((t) => t.textContent)
const tabEl = (i: number) => within(screen.getByRole('tablist', { name: 'Open requests' })).getAllByRole('tab')[i].closest('.reqTab')!
const menu = () => screen.getByRole('menu', { name: /Tab actions|More for/ })
const items = () => within(menu()).getAllByRole('menuitem').map((b) => [b.textContent, (b as HTMLButtonElement).disabled])
const pick = async (label: RegExp) => { await act(async () => { fireEvent.click(within(menu()).getByRole('menuitem', { name: label })) }) }

async function threeTabs() {
  render(<App transport={transport} />)
  await screen.findByLabelText('URL')
  // Name each tab by typing a URL (the name stays "New request"; the URL tells them apart in the title).
  for (let i = 0; i < 2; i++) fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
  expect(tabs()).toHaveLength(3)
}

describe('tab right-click menu', () => {
  it('offers Postman’s tab actions, greying out what doesn’t apply', async () => {
    await threeTabs()
    fireEvent.contextMenu(tabEl(0))
    expect(items()).toEqual([
      ['Duplicate tab', false], ['Close tabCtrl+W', false], ['Close other tabs', false],
      ['Close tabs to the left', true], ['Close tabs to the right', false], ['Close all tabs', false],
    ])
    fireEvent.keyDown(menu(), { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: /Tab actions/ })).toBeNull()
  })

  it('duplicates a tab with its edits, right after it', async () => {
    await threeTabs()
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Open requests' })).getAllByRole('tab')[0])
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/one' } })
    fireEvent.contextMenu(tabEl(0))
    await pick(/^Duplicate tab/)
    expect(tabs()).toEqual(['GETNew request', 'GETNew request copy', 'GETNew request', 'GETNew request'])
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://api.test/one')
  })

  it('closes to the right, the others, and all (asking once about unsaved changes)', async () => {
    await threeTabs()
    fireEvent.contextMenu(tabEl(1))
    await pick(/^Close tabs to the right/)
    expect(tabs()).toHaveLength(2)
    fireEvent.contextMenu(tabEl(1))
    await pick(/^Close other tabs/)
    expect(tabs()).toHaveLength(1)
    // Two edited tabs, then Close all tabs: one question for both.
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://a.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://b.test' } })
    fireEvent.contextMenu(tabEl(0))
    expect(items().map(([l]) => l)).toContain('Force close all tabs')
    await pick(/^Close all tabs/)
    const ask = await screen.findByRole('dialog')
    expect(ask.textContent).toContain('unsaved changes in 2 tabs')
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: 'Discard' })) })
    expect(tabs()).toHaveLength(1)
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('')
  })
})

describe('sidebar right-click', () => {
  it('opens the row’s ⋯ menu at the pointer, and its items work', async () => {
    render(<App transport={transport} />)
    await screen.findByLabelText('URL')
    const file = new File([JSON.stringify({
      info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Items', request: { method: 'GET', url: 'https://s.test/items' } }],
    })], 'shop.json', { type: 'application/json' })
    await act(async () => { fireEvent.change(document.querySelector('input[aria-label="Import file"]')!, { target: { files: [file] } }) })
    await screen.findByText(/Imported 1 collection/)
    const side = within(screen.getByRole('complementary', { name: 'Library' }))
    fireEvent.contextMenu(side.getByRole('button', { name: /^GET Items$/ }), { clientX: 40, clientY: 120 })
    expect(screen.getByRole('menu', { name: 'More for Items' })).toBeTruthy()
    expect(items().map(([l]) => l)).toEqual(expect.arrayContaining(['Rename', 'Duplicate', 'Move to…', 'Delete']))
    await pick(/^Duplicate$/)
    await side.findByRole('button', { name: /^GET Items copy/ })
    expect(side.getAllByRole('button', { name: /^GET Items/ }).map((b) => b.textContent)).toEqual(['GETItems', 'GETItems copy'])
    // On a collection header too.
    fireEvent.contextMenu(side.getByRole('button', { name: 'Shop' }))
    expect(items().map(([l]) => l)).toEqual(expect.arrayContaining(['New request', 'Run collection…', 'Delete']))
  })
})
