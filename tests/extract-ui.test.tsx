/** Extract into variable: the right-click menu on a response and its dialog. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import { InlineEngine } from '../src/core/scriptPipeline'
import * as db from '../src/core/db'
import { kv, newCollection, newEnvironment, newRequest } from '../src/core/types'

const LINE = "{ const v = dx.response.json('data.token'); if (v != null && v !== '') dx.env.set('token', v) } // extracted"
let body = ''
const transport = { label: 'Fake', unrestricted: true, send: async () => ({ status: 200, statusText: 'OK', headers: [['X-Request-Id', 'r-1'], ['Set-Cookie', 'a=b']] as [string, string][], body, binary: false, size: 2, timeMs: 1 }) }
beforeEach(async () => { await db.resetForTests(); localStorage.clear(); body = '{"data":{"token":"abc"},"id":7}' })
afterEach(() => cleanup())

async function start({ env = true, vars = [] as ReturnType<typeof kv>[], inCollection = true } = {}) {
  const c = newCollection('Shop')
  const e = { ...newEnvironment('Staging'), variables: vars }
  await db.putCollection(c); await db.putEnvironment(e)
  await db.putRequest(newRequest({ name: 'Login', url: 'https://s.test/login', collectionId: inCollection ? c.id : null, scripts: { pre: '', post: 'first()' } }))
  await db.putSettings({ ...(await db.getSettings()), activeEnvId: env ? e.id : null })
  render(<App transport={transport} engine={new InlineEngine()} />)
  fireEvent.click(await screen.findByRole('button', { name: /^GET Login/ }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Send/ })) })
  await screen.findByLabelText('Response body')
}
const res = () => within(screen.getByRole('region', { name: 'Response' }))
const area = () => screen.getByLabelText('Response body') as HTMLTextAreaElement
/** Selects a text in the response body (nothing when empty) and right-clicks it. */
function rightClick(pick: string) {
  const i = area().value.indexOf(pick)
  area().setSelectionRange(i, i + pick.length)
  fireEvent.contextMenu(area(), { clientX: 5, clientY: 5 })
}
const menu = () => document.querySelector('.ctxMenu') as HTMLElement
const item = () => within(menu()).getByRole('menuitem', { name: /^Extract into variable…/ }) as HTMLButtonElement
const open = (pick: string) => { rightClick(pick); fireEvent.click(item()); return within(screen.getByRole('dialog')) }
const nameOf = (d: ReturnType<typeof within>) => d.getByLabelText('Name') as HTMLInputElement
const extract = async (d: ReturnType<typeof within>) => { await act(async () => { fireEvent.click(d.getByRole('button', { name: 'Extract' })) }) }
const envRow = async (k = 'token') => (await db.listEnvironments())[0].variables.find((v) => v.key === k)
const script = async () => {
  fireEvent.click(screen.getByRole('tab', { name: /^Scripts/ }))
  fireEvent.click(await screen.findByRole('tab', { name: /^After response/ }))
  return (await screen.findByLabelText('Post-response script') as HTMLTextAreaElement).value
}

describe('the menu', () => {
  it('needs a selection', async () => {
    await start(); rightClick('')
    expect(item().disabled).toBe(true); expect(item().textContent).toContain('Select a value first')
  })
  it('is off while a JSON filter is on', async () => {
    await start()
    fireEvent.change(screen.getByLabelText('JSON filter'), { target: { value: '$.data' } })
    rightClick('abc')
    expect(item().disabled).toBe(true); expect(item().textContent).toContain('Clear the filter first')
  })
  it('says why a selection can’t be taken', async () => {
    await start(); rightClick('"abc"\n  },\n  "id"')
    fireEvent.click(item())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('Select one value.')).toBeTruthy()
  })
  it('works on header rows, and offers Copy', async () => {
    await start(); fireEvent.click(res().getByRole('tab', { name: /^Headers/ }))
    fireEvent.contextMenu(res().getByText('r-1'))
    expect(within(menu()).getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
    fireEvent.click(item())
    expect(nameOf(within(screen.getByRole('dialog'))).value).toBe('xRequestId')
    expect(screen.getByRole('dialog').textContent).toContain("dx.response.headers.get('X-Request-Id')")
  })
  it('isn’t on the Sent tab', async () => {
    await start(); fireEvent.click(res().getByRole('tab', { name: 'Sent' }))
    fireEvent.contextMenu(res().getByText(/GET https:/)); expect(menu()).toBeNull()
  })
})

describe('the dialog', () => {
  it('suggests a name, the active environment and Secret', async () => {
    await start(); const d = open('abc')
    expect(nameOf(d).value).toBe('token')
    expect((d.getByLabelText('Save to') as HTMLSelectElement).value).toBe('env')
    expect((d.getByLabelText('Secret') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('dialog').textContent).not.toContain('abc') // masked
    fireEvent.click(d.getByLabelText('Secret')); expect(screen.getByRole('dialog').textContent).toContain('abc')
  })
  it('without an environment saves to the collection; without both, to globals', async () => {
    await start({ env: false }); let d = open('abc')
    expect((d.getByLabelText('Save to') as HTMLSelectElement).value).toBe('collection')
    expect((d.getByRole('option', { name: /No environment selected/ }) as HTMLOptionElement).disabled).toBe(true)
    cleanup(); await db.resetForTests()
    await start({ env: false, inCollection: false }); d = open('abc')
    expect((d.getByLabelText('Save to') as HTMLSelectElement).value).toBe('globals')
  })
  it('follows an existing variable, without showing its secret value', async () => {
    await start({ vars: [{ ...kv('id', 'old-secret'), secret: true }] }); const d = open('7')
    expect((d.getByLabelText('Secret') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('dialog').textContent).toContain('Replaces the current value')
    expect(screen.getByRole('dialog').textContent).not.toContain('old-secret')
    fireEvent.change(nameOf(d), { target: { value: 'other' } })
    expect((d.getByLabelText('Secret') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('dialog').textContent).not.toContain('Replaces')
  })
  it.each(['', '  ', 'a{{b', 'my token'])('won’t take %j as a name', async (n) => {
    await start(); const d = open('abc'); fireEvent.change(nameOf(d), { target: { value: n } })
    expect((d.getByRole('button', { name: 'Extract' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('warns when other text repeats, and still extracts', async () => {
    body = '<i>a</i><i>b</i>'.repeat(6); await start()
    const i = area().value.indexOf('b', 60); area().setSelectionRange(i, i + 1); fireEvent.contextMenu(area()); fireEvent.click(item())
    const d = within(screen.getByRole('dialog'))
    expect(d.getByText(/appears more than once/)).toBeTruthy()
    fireEvent.change(nameOf(d), { target: { value: 'x' } }); await extract(d)
    await waitFor(async () => expect((await envRow('x'))?.value).toBe('b'))
  })
})

describe('extracting', () => {
  it('saves the value, adds the rule to the unsaved request, and says so', async () => {
    await start(); await extract(open('abc'))
    await waitFor(async () => expect(await envRow()).toMatchObject({ value: 'abc', secret: true }))
    expect(await screen.findByText('Saved {{token}}. Every send of this request refreshes it. Save the request to keep the rule.')).toBeTruthy()
    expect((await db.listRequests())[0].scripts.post).toBe('first()')
    expect(await script()).toBe(`first()\n${LINE}`)
  })
  it('Undo puts back the value and takes out only the rule', async () => {
    await start({ vars: [{ ...kv('token', 'old'), secret: false }] }); await extract(open('abc'))
    const s = await script()
    fireEvent.change(screen.getByLabelText('Post-response script'), { target: { value: `${s}\nlater()` } })
    const undo = await screen.findByRole('button', { name: 'Undo' }); await act(async () => { fireEvent.click(undo) })
    await waitFor(async () => expect(await envRow()).toMatchObject({ value: 'old', secret: false }))
    expect(await script()).toBe('first()\nlater()')
  })
  it('Undo removes a new variable, also after looking at another tab', async () => {
    await start(); await extract(open('abc'))
    await screen.findByRole('button', { name: 'Undo' }); fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    const undo = await screen.findByRole('button', { name: 'Undo' }); await act(async () => { fireEvent.click(undo) })
    await waitFor(async () => expect(await envRow()).toBeUndefined())
    fireEvent.click(screen.getByRole('button', { name: /^GET Login/ }))
    expect(await script()).toBe('first()')
  })
  it('saves to the collection or globals when picked', async () => {
    await start(); const d = open('abc')
    fireEvent.change(d.getByLabelText('Save to'), { target: { value: 'globals' } }); await extract(d)
    await waitFor(async () => expect((await db.getGlobals())[0]).toMatchObject({ key: 'token', value: 'abc' }))
    expect(await envRow()).toBeUndefined()
    expect(await script()).toContain("dx.globals.set('token', v)")
  })
  it('shows what the request sets, and leads to the script', async () => {
    await start(); expect(screen.queryByText(/^Sets/)).toBeNull()
    await extract(open('abc'))
    fireEvent.click(await screen.findByRole('button', { name: 'Sets {{token}}' }))
    expect(await screen.findByLabelText('Post-response script')).toBeTruthy()
  })
})
