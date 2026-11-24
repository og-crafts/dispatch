/** Rename in place in the sidebar: double-click, F2 or the ⋯ menu. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import * as db from '../src/core/db'
import { newCollection, newEnvironment, newFolder, newRequest } from '../src/core/types'
import { newFlow } from '../src/core/flows'

const transport = { label: 'Fake', unrestricted: true, send: async () => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }) }
const KINDS = ['request', 'folder', 'collection', 'flow', 'environment'] as const
type Kind = (typeof KINDS)[number]
const NAMES: Record<Kind, string> = { request: 'Items', folder: 'Admin', collection: 'Shop', flow: 'Log in flow', environment: 'Staging' }

beforeEach(async () => { await db.resetForTests(); localStorage.clear() })
afterEach(() => cleanup())
const side = () => within(screen.getByRole('complementary', { name: 'Library' }))

async function start(kind: Kind) {
  const c = newCollection('Shop')
  const f = newFolder(c.id, 'Admin')
  await db.putCollection(c); await db.putFolder(f)
  await db.putRequest(newRequest({ name: 'Items', url: 'https://s.test/items', collectionId: c.id }))
  await db.putRequest(newRequest({ name: 'Inside', url: 'https://s.test/in', collectionId: c.id, folderId: f.id }))
  await db.putEnvironment(newEnvironment('Staging')); await db.putFlow(newFlow('Log in flow'))
  render(<App transport={transport} />)
  await screen.findByLabelText('URL'); await screen.findByTitle('Shop')
  if (kind === 'flow') fireEvent.click(side().getByRole('tab', { name: 'Flows' }))
  if (kind === 'environment') fireEvent.click(side().getByRole('tab', { name: 'Environments' }))
}
const span = (name: string) => side().getByText(name, { selector: '.rowName, .rowTitle' })
const row = (name: string) => span(name).closest('button')!
const has = (name: string) => side().queryByText(name, { selector: '.rowName, .rowTitle' })
/** What the browser sends for a double-click: two clicks, then dblclick. */
const dbl = (el: Element) => { fireEvent.click(el); fireEvent.click(el); fireEvent.doubleClick(el) }
const field = (name: string) => side().getByLabelText(`Rename ${name}`) as HTMLInputElement
const type = (el: HTMLInputElement, value: string) => fireEvent.change(el, { target: { value } })
const key = async (el: Element, k: string) => { await act(async () => { fireEvent.keyDown(el, { key: k }) }) }

describe.each(KINDS)('rename a %s', (kind) => {
  const name = NAMES[kind]
  it('by double-click: name selected, Enter saves it trimmed', async () => {
    await start(kind); dbl(row(name))
    const el = field(name)
    expect(document.activeElement).toBe(el)
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, name.length])
    type(el, '  New name '); await key(el, 'Enter')
    await waitFor(() => expect(has('New name')).toBeTruthy())
    expect(has(name)).toBeNull()
    const lists = { request: db.listRequests, folder: db.listFolders, collection: db.listCollections, flow: db.listFlows, environment: db.listEnvironments }
    const saved = await lists[kind]()
    expect((saved as { name: string }[]).map((x) => x.name)).toContain('New name')
  })
  it('from F2 and from the menu, without a dialog', async () => {
    await start(kind)
    await key(row(name), 'F2'); await key(field(name), 'Escape')
    expect(document.activeElement).toBe(row(name)) // focus goes back to the row
    const menu = side().getByLabelText(`More for ${name}`).closest('details')!
    fireEvent.click(within(menu as HTMLElement).getByText('Rename'))
    expect(field(name)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('rename in place', () => {
  it('Escape keeps the old name, even though the field then loses focus', async () => {
    await start('request'); dbl(row('Items'))
    const el = field('Items'); type(el, 'Other'); await key(el, 'Escape')
    expect(has('Items')).toBeTruthy(); expect(has('Other')).toBeNull()
  })
  it('leaving the field saves; only spaces cancels', async () => {
    await start('request'); dbl(row('Items'))
    type(field('Items'), 'Things'); await act(async () => { fireEvent.blur(field('Items')) })
    await waitFor(() => expect(has('Things')).toBeTruthy())
    dbl(row('Things')); type(field('Things'), '   '); await key(field('Things'), 'Enter')
    expect(has('Things')).toBeTruthy()
  })
  it('an unchanged name is not written again', async () => {
    await start('request'); const before = (await db.listRequests()).find((r) => r.name === 'Items')!
    dbl(row('Items')); await key(field('Items'), 'Enter')
    expect((await db.listRequests()).find((r) => r.name === 'Items')!.updatedAt).toBe(before.updatedAt)
  })
  it('a folder keeps its open or closed state', async () => {
    await start('folder'); dbl(row('Admin')); await key(field('Admin'), 'Escape')
    expect(has('Inside')).toBeTruthy()
    fireEvent.click(side().getByLabelText('Collapse Admin'))
    dbl(row('Admin')); await key(field('Admin'), 'Escape')
    expect(has('Inside')).toBeNull()
  })
  it('the row can’t be dragged meanwhile, and Space stays in the field', async () => {
    await start('request'); expect(span('Items').closest('li')!.getAttribute('draggable')).toBe('true')
    dbl(row('Items'))
    const el = field('Items')
    expect(el.closest('li')!.getAttribute('draggable')).toBe('false')
    expect(el.closest('button')).toBeNull()
  })
  it.each(['collection', 'folder', 'environment', 'flow'] as const)('an open %s editor keeps the new name on its next edit', async (kind) => {
    await start(kind); dbl(row(NAMES[kind])) // the first click opens its editor
    const el = field(NAMES[kind]); type(el, 'Renamed'); await key(el, 'Enter')
    await waitFor(() => expect(has('Renamed')).toBeTruthy())
    const label = `${kind[0].toUpperCase()}${kind.slice(1)} name`
    await waitFor(() => expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('Renamed'))
    await act(async () => { fireEvent.change(screen.getByLabelText(label), { target: { value: 'Renamed!' } }) })
    await waitFor(() => expect(has('Renamed!')).toBeTruthy())
  })
})
