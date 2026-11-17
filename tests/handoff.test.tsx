/** Handing a request to the AI assistant from the app, and letting assistants edit a workspace of yours. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import * as db from '../src/core/db'
import { defaultSettings, type HttpResponse } from '../src/core/types'
import type { Transport } from '../src/core/transport'

const transport: Transport = {
  label: 'Fake', unrestricted: true,
  send: async (): Promise<HttpResponse> => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }),
}

beforeEach(async () => { await db.resetForTests() })
afterEach(() => cleanup())

const side = () => within(screen.getByRole('complementary', { name: 'Library' }))

async function start(assistantWorkspace: boolean) {
  await db.putSettings({ ...defaultSettings, mcpHostWorkspace: assistantWorkspace })
  render(<App transport={transport} />)
  await screen.findByLabelText('URL')
  const file = new File([JSON.stringify({
    info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] },
    variable: [{ key: 'base', value: 'https://s.test' }],
    item: [{ name: 'Box', item: [{ name: 'Items', request: { method: 'GET', url: '{{base}}/items' } }] }],
  })], 'shop.json', { type: 'application/json' })
  await act(async () => { fireEvent.change(document.querySelector('input[aria-label="Import file"]')!, { target: { files: [file] } }) })
  await screen.findByText(/Imported 1 collection/)
}
const menuItems = () => side().getAllByRole('menuitem', { hidden: true }).map((b) => b.textContent)

describe('Hand to AI assistant', () => {
  it('is only offered with the assistant’s workspace on', async () => {
    await start(false)
    expect(menuItems()).not.toContain('Hand to AI assistant…')
  })

  it('puts a copy with the note and inherited auth in the assistant’s Inbox, leaving the original', async () => {
    await start(true)
    fireEvent.click(side().getByRole('menuitem', { name: 'Hand to AI assistant…', hidden: true }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Make the host a variable' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Hand over' })) })
    await screen.findByText(/Handed “Items” to the AI assistant/)

    const data = { collections: await db.listCollections(), requests: await db.listRequests() }
    const inbox = data.collections.find((c) => c.name === 'Inbox')!
    expect(inbox.workspaceId).toBe('assistant')
    const copy = data.requests.find((r) => r.collectionId === inbox.id)!
    expect(copy).toMatchObject({ name: 'Items', url: '{{base}}/items', folderId: null })
    expect(copy.auth).toMatchObject({ kind: 'bearer', token: '{{tok}}' })
    expect(copy.handoff).toMatchObject({ note: 'Make the host a variable', from: 'Shop/Box/Items' })
    expect(copy.handoff!.variables!.map((v) => v.key)).toEqual(['base'])
    const original = data.requests.find((r) => r.id !== copy.id && r.name === 'Items')!
    expect(original.handoff).toBeUndefined()
    expect(original.auth.kind).toBe('inherit')
  })

  it('lets you tick “AI can edit” per workspace on the Workspaces page', async () => {
    await start(true)
    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }))
    const box = await screen.findByRole('checkbox', { name: 'AI assistants can edit My workspace' })
    expect((box as HTMLInputElement).checked).toBe(false)
    fireEvent.click(box)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('change pre-request and test scripts')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'OK' })) })
    await screen.findByText(/AI assistants can now edit “My workspace”/)
    expect((screen.getByRole('checkbox', { name: 'AI assistants can edit My workspace' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'AI assistants can edit My workspace' }))
    await screen.findByText(/only list and send in “My workspace” again/)
    expect((screen.getByRole('checkbox', { name: 'AI assistants can edit My workspace' }) as HTMLInputElement).checked).toBe(false)
  })
})
