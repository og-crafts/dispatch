/** The app shell: the rail, Home, pages as tabs, and the resizable, foldable library panel. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import { resetForTests } from '../src/core/db'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'

class FakeTransport implements Transport {
  readonly label = 'Fake'
  readonly unrestricted = true
  async send(_p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    return { status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }
  }
}

beforeEach(async () => { await resetForTests(); try { localStorage.clear() } catch { /* none */ } })
afterEach(() => cleanup())

const side = () => within(screen.getByRole('complementary', { name: 'Library' }))

async function start() {
  render(<App transport={new FakeTransport()} />)
  await screen.findByLabelText('URL')
  const file = new File([JSON.stringify({
    info: { name: 'A collection with a very long name that would wrap', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Get things', request: { method: 'GET', url: 'https://s.test/things' } }],
  })], 'c.json', { type: 'application/json' })
  await act(async () => { fireEvent.change(document.querySelector('input[aria-label="Import file"]')!, { target: { files: [file] } }) })
  await screen.findByText(/Imported 1 collection/)
}

describe('app shell', () => {
  it('opens Home from the rail and the logo, with the collections and first steps', async () => {
    await start()
    fireEvent.click(side().getByRole('button', { name: 'Home' }))
    const home = await screen.findByRole('region', { name: 'Home' })
    expect(within(home).getByText('1 request')).toBeTruthy()
    fireEvent.click(within(home).getByRole('button', { name: /A collection with a very long name/ }))
    expect(screen.queryByRole('region', { name: 'Home' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Dispatch$/ }))
    expect(await screen.findByRole('region', { name: 'Home' })).toBeTruthy()
    // New request from Home goes straight to an editor.
    fireEvent.click(within(screen.getByRole('region', { name: 'Home' })).getAllByRole('button', { name: 'New request' })[0])
    expect(screen.getByLabelText('URL')).toBeTruthy()
  })

  it('lists a blank new request under "Pick up where you left off"', async () => {
    render(<App transport={new FakeTransport()} />)
    await screen.findByLabelText('URL')
    fireEvent.click(side().getByRole('button', { name: 'Home' }))
    const home = await screen.findByRole('region', { name: 'Home' })
    const card = within(home).getByRole('heading', { name: 'Pick up where you left off' }).closest('section')!
    expect(within(card as HTMLElement).getByRole('button', { name: /New request/ })).toBeTruthy()
    expect(within(card as HTMLElement).queryByText(/No open requests/)).toBeNull()
  })

  it('keeps each workspace’s tabs to itself', async () => {
    await start()
    fireEvent.click(side().getByRole('button', { name: /^GET Get things$/ }))
    const bar = () => within(screen.getByRole('tablist', { name: 'Open requests' }))
    expect(bar().getByRole('tab', { name: /Get things/ })).toBeTruthy()
    const pick = () => screen.getByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement
    fireEvent.change(pick(), { target: { value: '__manage' } })
    fireEvent.click(within(await screen.findByRole('region', { name: 'Workspaces' })).getByRole('button', { name: '+ New workspace' }))
    const d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByLabelText('New workspace'), { target: { value: 'Work' } })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    await waitFor(() => expect(pick().selectedOptions[0].textContent).toBe('Work'))
    // Work starts with one new request, not the other workspace's tabs.
    await waitFor(() => expect(bar().queryByRole('tab', { name: /Get things/ })).toBeNull())
    expect(bar().getAllByRole('tab', { name: /New request/ })).toHaveLength(1)
    // Back home: its tabs return, on the one last used.
    const homeId = within(pick()).getByRole('option', { name: 'My workspace' }).getAttribute('value')!
    fireEvent.change(pick(), { target: { value: homeId } })
    await waitFor(() => expect(bar().getByRole('tab', { name: /Get things/, selected: true })).toBeTruthy())
  })

  it('shows a page as a tab, so a request is one click away', async () => {
    await start()
    fireEvent.click(side().getByRole('button', { name: 'Settings' }))
    const bar = within(screen.getByRole('tablist', { name: 'Open requests' }))
    expect(bar.getByRole('tab', { name: 'Settings', selected: true })).toBeTruthy()
    fireEvent.click(bar.getByRole('tab', { name: /New request/ }))
    expect(screen.getByLabelText('URL')).toBeTruthy()
    // The page stays as a tab while the request is open, and brings the page back.
    fireEvent.click(bar.getByRole('tab', { name: 'Settings', selected: false }))
    expect(bar.getByRole('tab', { name: 'Settings', selected: true })).toBeTruthy()
    fireEvent.click(bar.getByRole('tab', { name: /New request/ }))
    // Closing the page tab goes back to the request and removes the tab.
    fireEvent.click(side().getByRole('button', { name: 'Workspaces' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Workspaces' }))
    expect(screen.getByLabelText('URL')).toBeTruthy()
    expect(bar.queryByRole('tab', { name: 'Workspaces' })).toBeNull()
  })

  it('folds the panel when its section is picked again, and the rail stays', async () => {
    await start()
    const collections = side().getByRole('tab', { name: 'Collections' })
    expect(collections.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(collections)
    expect(document.querySelector('.sidePanel')).toBeNull()
    expect(side().getByRole('tab', { name: 'Flows' })).toBeTruthy()
    fireEvent.click(side().getByRole('tab', { name: 'Flows' }))
    expect(side().getByRole('heading', { name: 'Flows' })).toBeTruthy()
    // Ctrl+K brings the collections back with the search focused.
    fireEvent.click(side().getByRole('button', { name: 'Hide the sidebar' }))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(side().getByRole('heading', { name: 'Collections' })).toBeTruthy()
  })

  it('resizes the panel with the keyboard, within limits, and remembers it', async () => {
    await start()
    const handle = side().getByRole('separator', { name: 'Resize the sidebar' })
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('316')
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(handle.getAttribute('aria-valuenow')).toBe('380')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(handle.getAttribute('aria-valuenow')).toBe('640')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle.getAttribute('aria-valuenow')).toBe('200')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe('200')
    // Remembered where storage exists (this test environment may have none; the app works without it).
    if (globalThis.localStorage) expect(localStorage.getItem('dispatch.sideWidth')).toBe('200')
    fireEvent.doubleClick(handle)
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
  })
})

describe('settings tabs', () => {
  it('splits Settings into General, Themes, Network, Certificates and AI assistants on the desktop', async () => {
    const { SettingsView } = await import('../src/ui/SettingsView')
    const { defaultSettings } = await import('../src/core/types')
    const ws = { settings: defaultSettings, transport: { unrestricted: true }, setSettings: () => {} } as any
    render(<SettingsView ws={ws} notify={() => {}} />)
    const tabs = within(screen.getByRole('tablist', { name: 'Settings sections' }))
    expect(screen.getByLabelText('Timeout (seconds)')).toBeTruthy()
    expect(screen.queryByText(/Proxy URL/)).toBeNull()
    fireEvent.click(tabs.getByRole('tab', { name: 'Network' }))
    expect(screen.getByText(/Proxy URL/)).toBeTruthy()
    expect(screen.queryByLabelText('Timeout (seconds)')).toBeNull()
    fireEvent.click(tabs.getByRole('tab', { name: 'Certificates' }))
    expect(screen.getByRole('button', { name: '+ Add certificate' })).toBeTruthy()
    fireEvent.click(tabs.getByRole('tab', { name: 'AI assistants' }))
    expect(tabs.getByRole('tab', { name: 'AI assistants', selected: true })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /Let AI assistants use Dispatch/ })).toBeTruthy()
  })

  it('shows only General and Themes in the browser, where the network settings don’t apply', async () => {
    const { SettingsView } = await import('../src/ui/SettingsView')
    const { defaultSettings } = await import('../src/core/types')
    render(<SettingsView ws={{ settings: defaultSettings, transport: { unrestricted: false }, setSettings: () => {} } as any} notify={() => {}} />)
    const tabs = within(screen.getByRole('tablist', { name: 'Settings sections' }))
    expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Themes'])
    expect(screen.getByText(/for the desktop app/)).toBeTruthy()
  })

  it('lets you pick a look and light or dark under Themes', async () => {
    const { SettingsView } = await import('../src/ui/SettingsView')
    const { defaultSettings } = await import('../src/core/types')
    const saved: object[] = []
    render(<SettingsView ws={{ settings: defaultSettings, transport: { unrestricted: true }, setSettings: (p: object) => saved.push(p) } as any} notify={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))
    const looks = within(screen.getByRole('radiogroup', { name: 'Theme' }))
    expect(looks.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['dispatch', 'grove', 'grove-classic'])
    expect((looks.getByRole('radio', { name: /^Dispatch/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(looks.getByRole('radio', { name: /^Grove classic/ }))
    fireEvent.change(screen.getByLabelText('Light or dark'), { target: { value: 'dark' } })
    expect(saved).toEqual([{ look: 'grove-classic' }, { theme: 'dark' }])
  })
})

describe('request toolbar', () => {
  it('keeps Save, variables and code in view and puts the occasional actions in one ⋯ menu', async () => {
    await start()
    const bar = document.querySelector('.request .titleRow') as HTMLElement
    const shown = [...bar.querySelectorAll(':scope > button, :scope > details > summary')].map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(shown).toEqual(['Variables', 'Code', 'More request actions', 'Save Ctrl S'])
    const more = screen.getByLabelText('More request actions').closest('details')!
    expect(within(more).getAllByRole('menuitem').map((b) => b.getAttribute('aria-label') ?? b.textContent))
      .toEqual(['Save as…', 'Share as HTML…', 'Parameterize…'])
    fireEvent.click(screen.getByLabelText('More request actions'))
    fireEvent.click(within(more).getByRole('menuitem', { name: 'Parameterize…' }))
    expect(more.open).toBe(false)
    expect(await screen.findByRole('dialog', { name: 'Parameterize' })).toBeTruthy()
  })
})

describe('save as', () => {
  it('saves an edited request as a new one and leaves the original as it was', async () => {
    await start()
    fireEvent.click(side().getByRole('button', { name: /^GET Get things$/ }))
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://s.test/things?v=2' } })
    fireEvent.click(screen.getByLabelText('More request actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as…' }))
    const d = await screen.findByRole('dialog', { hidden: true })
    expect(within(d).getByText('Save as')).toBeTruthy()
    const name = within(d).getAllByRole('textbox', { hidden: true })[0] as HTMLInputElement
    expect(name.value).toBe('Get things copy')
    fireEvent.change(name, { target: { value: 'Get things v2' } })
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Save', hidden: true })) })
    await screen.findByText('Saved as “Get things v2”.')
    const rows = [...document.querySelectorAll('.tree .rowMain')].map((b) => b.getAttribute('title'))
    expect(rows).toContain('Get things\nhttps://s.test/things')
    expect(rows).toContain('Get things v2\nhttps://s.test/things?v=2')
    // The tab now holds the copy, saved.
    expect(screen.getByRole('tab', { name: /Get things v2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close Get things v2' }).textContent).toBe('×')
  })

  it('opens with Ctrl+Shift+S', async () => {
    await start()
    fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true })
    const d = await screen.findByRole('dialog', { hidden: true })
    expect(within(d).getByText('Save as')).toBeTruthy()
  })
})

describe('request / response divider', () => {
  it('moves with the keyboard within limits and resets on double-click', async () => {
    await start()
    const bar = screen.getByRole('separator', { name: 'Resize the request and response' })
    expect(bar.getAttribute('aria-orientation')).toBe('horizontal')
    expect(bar.getAttribute('aria-valuenow')).toBe('50')
    fireEvent.keyDown(bar, { key: 'ArrowDown' })
    expect(bar.getAttribute('aria-valuenow')).toBe('53')
    fireEvent.keyDown(bar, { key: 'ArrowUp', shiftKey: true })
    expect(bar.getAttribute('aria-valuenow')).toBe('43')
    fireEvent.keyDown(bar, { key: 'End' })
    expect(bar.getAttribute('aria-valuenow')).toBe('85')
    fireEvent.keyDown(bar, { key: 'Home' })
    expect(bar.getAttribute('aria-valuenow')).toBe('15')
    // The request gets the share it was given: the grid rows follow the divider.
    expect((bar.parentElement as HTMLElement).style.gridTemplateRows).toContain('0.15fr')
    fireEvent.doubleClick(bar)
    expect(bar.getAttribute('aria-valuenow')).toBe('50')
  })
})
