/** Variables and secrets are two tables over one list. */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import { VariablesEditor } from '../src/ui/VariablesEditor'
import * as db from '../src/core/db'
import { type KV, kv, newCollection, newEnvironment } from '../src/core/types'

beforeEach(async () => { await db.resetForTests(); localStorage.clear() })
afterEach(() => cleanup())
const s = (k: string, v = `${k}-value`): KV => ({ ...kv(k, v), secret: true })
let rows: KV[] = []
function Host({ initial }: { initial: KV[] }) {
  const [r, setR] = useState(initial); rows = r
  return <VariablesEditor label="Environment" rows={r} onChange={setR} />
}
const show = (...initial: KV[]) => render(<Host initial={initial} />)
const table = (n: 'variables' | 'secrets') => within(screen.getByRole('table', { name: `Environment ${n}` }))
const keys = (n: 'variables' | 'secrets') => table(n).getAllByLabelText(new RegExp(`^Environment ${n} Variable`)).map((e) => (e as HTMLInputElement).value).filter(Boolean)
const value = (n: 'variables' | 'secrets', i: number) => table(n).getByLabelText(`Environment ${n} Value ${i}`) as HTMLInputElement
const pick = (key: string, label: string) => {
  fireEvent.click(screen.getByRole('button', { name: `More for ${key}` }))
  fireEvent.click(within(document.querySelector('.ctxMenu') as HTMLElement).getByText(label))
}
const all = () => rows.map((r) => `${r.key}${r.secret ? '*' : ''}`)

describe('variables and secrets', () => {
  it('are two tables, each in its own order, with a note and no checkbox column', () => {
    show(kv('a'), s('x'), kv('b'), s('y'))
    expect(keys('variables')).toEqual(['a', 'b']); expect(keys('secrets')).toEqual(['x', 'y'])
    expect(screen.getByText('Hidden on screen, left out of backups, and only synced in the encrypted secrets file if you turn that on.')).toBeTruthy()
    expect(screen.queryByLabelText(/is secret$/)).toBeNull()
  })
  it('a row added under Secrets is secret; one added under Variables isn’t', () => {
    show()
    fireEvent.change(table('secrets').getByLabelText('Environment secrets Variable 1'), { target: { value: 'pw' } })
    fireEvent.change(table('variables').getByLabelText('Environment variables Variable 1'), { target: { value: 'host' } })
    expect(all()).toEqual(['pw*', 'host'])
    expect(value('secrets', 1).type).toBe('password')
  })
  it('edits and removals keep every row’s place in the list', () => {
    show(kv('a'), s('x'), kv('b'), s('y'), kv('c'))
    fireEvent.change(value('variables', 2), { target: { value: 'B' } })
    expect(all()).toEqual(['a', 'x*', 'b', 'y*', 'c']); expect(rows[2].value).toBe('B')
    fireEvent.click(screen.getByRole('button', { name: 'Remove x' }))
    expect(all()).toEqual(['a', 'b', 'y*', 'c'])
  })
  it('shows one value at a time, and masks it again when it comes back', () => {
    const { unmount } = show(s('x'), s('y'))
    fireEvent.click(screen.getByRole('button', { name: 'Show x' }))
    expect(value('secrets', 1).tagName).toBe('TEXTAREA'); expect(value('secrets', 1).value).toBe('x-value')
    expect(value('secrets', 2).type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Hide x' })); expect(value('secrets', 1).type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Show x' })); unmount(); show(s('x'))
    expect(value('secrets', 1).type).toBe('password')
  })
  it('Make secret and Make plain move a row to the end of the other table, with no question', () => {
    show(kv('a'), s('x'), kv('b'), s('y'))
    pick('a', 'Make secret'); expect(keys('secrets')).toEqual(['x', 'y', 'a']); expect(keys('variables')).toEqual(['b'])
    expect(value('secrets', 3).type).toBe('password')
    pick('x', 'Make plain'); expect(keys('variables')).toEqual(['b', 'x']); expect(keys('secrets')).toEqual(['y', 'a'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('a secret shown, made plain and made secret again is masked', () => {
    show(s('x')); fireEvent.click(screen.getByRole('button', { name: 'Show x' }))
    pick('x', 'Make plain'); pick('x', 'Make secret')
    expect(value('secrets', 1).type).toBe('password')
  })
  it('a secret-looking name is only pointed out', () => {
    show(kv('api_token', 'v'), kv('host'))
    expect(keys('variables')).toEqual(['api_token', 'host'])
    fireEvent.click(screen.getByRole('button', { name: 'Looks like a secret: make it secret?' }))
    expect(keys('secrets')).toEqual(['api_token']); expect(screen.queryByText(/^Looks like/)).toBeNull()
  })
  it('a row with options keeps them when moved', () => {
    const o = { ...kv('u', '1'), active: 'a', options: [{ id: '1', name: 'a', value: '1' }] }
    show(o); pick('u', 'Make secret')
    expect(rows[0]).toMatchObject({ secret: true, options: o.options, active: 'a' })
  })
})

it.each(['environment', 'collection', 'globals'] as const)('the %s editor has both and saves', async (kind) => {
  const vars = [kv('a', '1'), s('x')]
  const c = { ...newCollection('Shop'), variables: kind === 'collection' ? vars : [] }
  await db.putCollection(c); await db.putEnvironment({ ...newEnvironment('Staging'), variables: kind === 'environment' ? vars : [] })
  if (kind === 'globals') await db.putGlobals(vars)
  render(<App transport={{ label: 'F', unrestricted: false, send: async () => { throw new Error('no') } }} />)
  fireEvent.click(await screen.findByTitle('Shop'))
  if (kind !== 'collection') {
    fireEvent.click(screen.getByRole('tab', { name: 'Environments' }))
    fireEvent.click(screen.getByRole('button', { name: kind === 'globals' ? /^Globals/ : /^Staging/ }))
  }
  const name = { environment: 'Environment', collection: 'Collection', globals: 'Global' }[kind]
  const t = await screen.findByRole('table', { name: `${name} secrets` })
  expect(screen.getByRole('table', { name: `${name} variables` })).toBeTruthy()
  await act(async () => { fireEvent.change(within(t).getByLabelText(`${name} secrets Value 1`), { target: { value: 'changed' } }) })
  await waitFor(async () => {
    const got = kind === 'globals' ? await db.getGlobals() : kind === 'collection' ? (await db.listCollections())[0].variables : (await db.listEnvironments())[0].variables
    expect(got.map((r) => [r.key, r.value, !!r.secret])).toEqual([['a', '1', false], ['x', 'changed', true]])
  })
})

it('alternatives of a secret variable are masked', async () => {
  await db.putEnvironment({ ...newEnvironment('Staging'), variables: [{ ...s('x', '1'), active: 'a', options: [{ id: '1', name: 'a', value: '1' }] }] })
  render(<App transport={{ label: 'F', unrestricted: false, send: async () => { throw new Error('no') } }} />)
  await screen.findByLabelText('URL')
  fireEvent.click(screen.getByRole('tab', { name: 'Environments' })); fireEvent.click(screen.getByRole('button', { name: /^Staging/ }))
  expect((await screen.findByLabelText('x alternative 1 value') as HTMLInputElement).type).toBe('password')
})
