/** The Cookies screen, the upgrade from one shared list, and what deleting does. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useWorkspace, type WorkspaceApi } from '../src/ui/useWorkspace'
import { CookiesView } from '../src/ui/SettingsView'
import { InlineEngine } from '../src/core/scriptPipeline'
import * as db from '../src/core/db'
import type { StoredCookie } from '../src/core/cookies'
import { DEFAULT_SPACE, newEnvironment, newRequest } from '../src/core/types'
import type { PreparedRequest, Environment } from '../src/core/types'

const NONE = `none:${DEFAULT_SPACE.id}`
const c = (name: string): StoredCookie => ({ host: 'a.test', name, value: 'v', path: '/', expiresAt: null })
let sent: PreparedRequest[] = []
const transport = { label: 'F', unrestricted: true, send: async (p: PreparedRequest) => { sent.push(p); return { status: 200, statusText: 'OK', headers: [['Set-Cookie', `s${sent.length}=1; Path=/`]] as [string, string][], body: '{}', binary: false, size: 2, timeMs: 1 } } }
let A: Environment, B: Environment
beforeEach(async () => {
  await db.resetForTests(); localStorage.clear(); sent = []
  A = newEnvironment('staging'); B = newEnvironment('prod'); await db.putEnvironment(A); await db.putEnvironment(B)
})
afterEach(() => cleanup())
const activate = async (id: string | null) => db.putSettings({ ...(await db.getSettings()), activeEnvId: id })

let ws!: WorkspaceApi
const notes: string[] = []
function Screen() {
  ws = useWorkspace({ transport, engine, cookies: true })
  return ws.ready ? <CookiesView ws={ws} notify={(m) => notes.push(m)} /> : null
}
const engine = new InlineEngine()
const open = async () => { render(<Screen />); await screen.findByRole('heading', { level: 1 }) }
const names = () => screen.queryAllByLabelText(/^Name of/).map((e) => (e as HTMLInputElement).value)
const title = () => screen.getByRole('heading', { level: 1 }).textContent

describe('the Cookies screen', () => {
  it('shows the active environment’s cookies and follows a switch', async () => {
    await db.putCookieJars({ [A.id]: [c('a')], [B.id]: [c('b')], [NONE]: [c('n')] }); await activate(A.id); await open()
    expect([title(), names()]).toEqual(['Cookies for staging', ['a']])
    expect(screen.getByText(/Each environment keeps its own cookies/)).toBeTruthy()
    act(() => ws.setSettings({ activeEnvId: B.id })); expect([title(), names()]).toEqual(['Cookies for prod', ['b']])
    act(() => ws.setSettings({ activeEnvId: null })); expect([title(), names()]).toEqual(['Cookies for No environment', ['n']])
  })
  it('shows each environment’s own value of the same cookie', async () => {
    await db.putCookieJars({ [A.id]: [{ ...c('sid'), value: 'stg' }], [B.id]: [{ ...c('sid'), value: 'prd' }] }); await activate(A.id); await open()
    act(() => ws.setSettings({ activeEnvId: B.id }))
    const field = screen.getByLabelText('Value of sid') as HTMLInputElement
    expect(field.value).toBe('prd'); fireEvent.blur(field)
    expect(ws.cookieJar()!.entries()[0].value).toBe('prd')
  })
  it('updates when a send brings a cookie', async () => {
    await activate(A.id); await open(); expect(names()).toEqual([])
    act(() => ws.openRequest(newRequest({ url: 'https://a.test/x' }))); await act(async () => { await ws.send() })
    expect(names()).toEqual(['s1'])
  })
  it('clears only the jar on screen, and says which', async () => {
    await db.putCookieJars({ [A.id]: [c('a')], [B.id]: [c('b')] }); await activate(A.id); await open()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(names()).toEqual([]); expect(notes.at(-1)).toBe('All cookies for staging cleared.')
    await waitFor(async () => expect(await db.getCookieJars('x')).toEqual({ [B.id]: [c('b')] }))
  })
})

async function hook() {
  const h = renderHook(() => useWorkspace({ transport, engine, cookies: true }))
  await waitFor(() => expect(h.result.current.ready).toBe(true))
  return h
}

describe('storage', () => {
  it.each([['the active environment', true], ['"No environment"', false]] as const)('moves the old shared list to %s, at once', async (_n, env) => {
    await db.putLegacyCookiesForTests([c('old')]); await activate(env ? A.id : null); await hook()
    await waitFor(async () => expect(await db.getCookieJars('unused')).toEqual({ [env ? A.id : NONE]: [c('old')] }))
  })
  it('an active environment that no longer exists counts as none', async () => {
    await db.putLegacyCookiesForTests([c('old')]); await activate('gone'); await hook()
    await waitFor(async () => expect(await db.getCookieJars('unused')).toEqual({ [NONE]: [c('old')] }))
  })
  it('deleting an environment deletes its cookies, and the app goes on without one', async () => {
    await db.putCookieJars({ [A.id]: [c('a')], [NONE]: [c('n')] }); await activate(A.id)
    const h = await hook(); expect(h.result.current.cookieJar()!.entries()).toEqual([c('a')])
    await act(async () => { await h.result.current.removeEnvironment(A.id) })
    expect(h.result.current.cookieJar()!.entries()).toEqual([c('n')])
    await waitFor(async () => expect(await db.getCookieJars('x')).toEqual({ [NONE]: [c('n')] }))
  })
  it('Undo brings an environment back with its cookies', async () => {
    await db.putCookieJars({ [A.id]: [c('a')] }); await activate(A.id); const h = await hook()
    await act(async () => { await h.result.current.removeEnvironment(A.id) })
    await act(async () => { await h.result.current.undoDelete() })
    act(() => h.result.current.setSettings({ activeEnvId: A.id }))
    expect(h.result.current.cookieJar()!.entries()).toEqual([c('a')])
  })
  it('cookies of environments that no longer exist are dropped', async () => {
    await db.putCookieJars({ gone: [c('x')], [A.id]: [c('a')] }); await hook()
    await waitFor(async () => expect(await db.getCookieJars('x')).toEqual({ [A.id]: [c('a')] }))
  })
  it('each workspace has its own "No environment" cookies', async () => {
    await db.putCookieJars({ [NONE]: [c('n')] }); const h = await hook()
    await act(async () => { const s = await h.result.current.addSpace('Two'); h.result.current.switchSpace((s as { id: string }).id) })
    expect(h.result.current.cookieJar()!.entries()).toEqual([])
  })
  it('closing soon after a change still saves it', async () => {
    const h = await hook()
    act(() => { h.result.current.cookieJar()!.set(c('late')) ; window.dispatchEvent(new Event('pagehide')) })
    await new Promise((r) => setTimeout(r, 100)) // sooner than the usual 300 ms
    expect(await db.getCookieJars('x')).toEqual({ [NONE]: [c('late')] })
  })
})
