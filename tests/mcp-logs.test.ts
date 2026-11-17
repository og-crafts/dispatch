/** MCP log tools: console, history and environments, read-only, with every known secret hidden. */
import { describe, expect, it } from 'vitest'
import { handleMcp } from '../src/core/mcpHandler'
import type { Transport } from '../src/core/transport'
import { defaultSettings, type HistoryEntry, kv, type LogLine, newCollection, newEnvironment, newRequest } from '../src/core/types'

const transport: Transport = { label: 'test', unrestricted: true, send: async () => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }) }

const shop = { ...newCollection('Shop'), auth: { ...newCollection().auth, kind: 'bearer' as const, token: 'coll-token-ABCDEF' }, variables: [kv('base', 'https://shop.test')] }
const other = newCollection('Elsewhere') // another workspace's collection: not served
const items = newRequest({ name: 'Items', url: '{{base}}/items', collectionId: shop.id, headers: [kv('X-Api-Key', 'hdr-key-123456')] })
const staging = { ...newEnvironment('Staging'), variables: [kv('host', 'https://staging.test'), { ...kv('pin', '4242-9999'), secret: true }, kv('password', 'env-pass-777')] }
const prod = { ...newEnvironment('Prod'), variables: [kv('host', 'https://prod.test')] }
const TOKEN = 'mcp-token-0123456789abcdef'

const lines: LogLine[] = [
  { level: 'log', at: Date.UTC(2026, 10, 17, 9, 0, 0), source: 'script', text: 'token is env-pass-777 and pin 4242-9999' },
  { level: 'info', at: Date.UTC(2026, 10, 17, 9, 0, 1), source: 'network', text: 'GET https://shop.test/items → 200' },
  { level: 'error', at: Date.UTC(2026, 10, 17, 9, 0, 2), source: 'script', text: 'TypeError: x is undefined' },
  { level: 'warn', at: Date.UTC(2026, 10, 17, 9, 0, 3), source: 'mcp', text: `AI assistant: send_request → failed; Authorization: Bearer ${TOKEN}` },
]
const entry = (id: string, collectionId: string | null, status: number | null, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id, at: Date.UTC(2026, 10, 17, 10, 0, 0), request: { ...items, collectionId },
  sent: { method: 'GET', url: 'https://shop.test/items?api_key=q-secret-55555', headers: [['Authorization', 'Bearer coll-token-ABCDEF'], ['X-Api-Key', 'hdr-key-123456'], ['Accept', '*/*']], body: null, unresolved: [] },
  response: status === null ? null : { status, statusText: status === 200 ? 'OK' : 'Error', headers: [['Set-Cookie', 'sid=abc123456789'], ['Content-Type', 'application/json'], ['Access-Control-Allow-Credentials', 'true']], body: '{"access_token":"resp-tok-99999","user":"me","url":"https://shop.test/items?api_key=q-secret-55555","n":1}', binary: false, size: 40, timeMs: 12 },
  error: status === null ? 'connect refused' : null,
  ...extra,
})
const history: HistoryEntry[] = [
  entry('aaaa1111-new', shop.id, 500, { tests: [{ name: 'is ok', passed: false, error: 'expected 500 to be 200' }] }),
  entry('bbbb2222-mid', null, null),
  entry('cccc3333-old', shop.id, 200, { tests: [{ name: 'is ok', passed: true }] }),
  entry('dddd4444-elsewhere', other.id, 200),
]

function setup(logs = true) {
  const o = {
    ws: { source: 'dispatch' as const, collections: [shop], folders: [], requests: [items], environments: [staging, prod], flows: [], warnings: [] },
    environment: staging, globals: [], settings: { ...defaultSettings, mcpHostToken: TOKEN }, transport, pipeline: {}, allowMethods: [], version: 'test', allCollections: true,
    ...(logs ? { logs: { logs: () => lines, history: () => history } } : {}),
  }
  const call = async (name: string, args: object = {}) => {
    const r = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, o)
    return { text: (r.result?.content?.[0]?.text ?? JSON.stringify(r)) as string, isError: !!r.result?.isError }
  }
  const tools = async () => ((await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, o)).result.tools as { name: string; description: string }[]).map((t) => t.name)
  const init = async () => (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, o)).result.instructions as string
  return { call, tools, init }
}
const SECRETS = ['env-pass-777', '4242-9999', TOKEN, 'coll-token-ABCDEF', 'hdr-key-123456', 'q-secret-55555', 'resp-tok-99999', 'abc123456789']
const noSecrets = (t: string) => { for (const s of SECRETS) expect(t).not.toContain(s) }

describe('MCP log tools', () => {
  it('are offered only when turned on, and the instructions mention them', async () => {
    expect(await setup(false).tools()).not.toContain('get_logs')
    expect((await setup(false).call('get_logs')).text).toContain('Unknown tool get_logs')
    const on = setup()
    expect(await on.tools()).toEqual(expect.arrayContaining(['get_logs', 'list_history', 'get_history_entry', 'get_environment']))
    expect(await on.init()).toContain('get_logs (the console)')
  })

  it('get_logs reads the console with filters, and hides secret values wherever they appear', async () => {
    const { call } = setup()
    const all = (await call('get_logs')).text
    expect(all).toContain('4 lines (UTC)')
    expect(all).toContain('2026-11-17 09:00:00 log   [script] token is <hidden> and pin <hidden>')
    expect(all).toContain('Bearer <hidden>')
    noSecrets(all)
    expect((await call('get_logs', { level: 'warn' })).text.split('\n').slice(1).map((l) => l.split(' ')[2])).toEqual(['error', 'warn'])
    expect((await call('get_logs', { source: 'network' })).text).toContain('GET https://shop.test/items → 200')
    expect((await call('get_logs', { contains: 'typeerror' })).text).toContain('x is undefined')
    expect((await call('get_logs', { limit: 1 })).text).toContain('Last 1 of 4 lines')
    expect((await call('get_logs', { level: 'loud' })).isError).toBe(true)
  })

  it('list_history shows the open workspace’s sends, newest first, and filters failures', async () => {
    const { call } = setup()
    const t = (await call('list_history')).text
    expect(t).toContain('3 sends, newest first')
    expect(t.split('\n')[1]).toMatch(/^aaaa1111 {2}2026-11-17 10:00:00 {2}GET https:\/\/shop\.test\/items\?api_key=<hidden> {2}“Items” → 500 Error \(12 ms\), tests 0\/1 passed$/)
    expect(t).toContain('bbbb2222')
    expect(t).toContain('→ error: connect refused')
    expect(t).not.toContain('dddd4444')
    noSecrets(t)
    const bad = (await call('list_history', { failed: true })).text
    expect(bad).toContain('aaaa1111')
    expect(bad).toContain('bbbb2222')
    expect(bad).not.toContain('cccc3333')
    expect((await call('list_history', { request: 'nope' })).text).toBe('No sends match.')
  })

  it('get_history_entry shows one send in full with secrets hidden', async () => {
    const { call } = setup()
    const t = (await call('get_history_entry', { id: 'aaaa' })).text
    expect(t).toContain('“Items” sent 2026-11-17 10:00:00 UTC')
    expect(t).toContain('Authorization: Bearer <hidden>')
    expect(t).toContain('X-Api-Key: <hidden>')
    expect(t).toContain('Accept: */*')
    expect(t).toContain('→ 500 Error (12 ms, 40 bytes)')
    expect(t).toContain('Set-Cookie: <hidden>')
    // The echoed URL keeps its closing quote: the body is still JSON. CORS headers show as they are.
    const body = t.split('Response body:\n')[1].split('\nTests:')[0]
    expect(JSON.parse(body)).toEqual({ access_token: '<hidden>', user: 'me', url: 'https://shop.test/items?api_key=<hidden>', n: 1 })
    expect(t).toContain('Access-Control-Allow-Credentials: true')
    expect(t).toContain('✗ is ok — expected 500 to be 200')
    noSecrets(t)
    expect((await call('get_history_entry', { id: 'dddd' })).isError).toBe(true)
    expect((await call('get_history_entry', { id: 'zzzz' })).text).toContain('Use list_history')
  })

  it('get_environment shows variables with secret ones hidden', async () => {
    const { call } = setup()
    const t = (await call('get_environment')).text
    expect(t).toContain('Environment “Staging” (active). All: Staging (active), Prod.')
    expect(t).toContain('host = https://staging.test')
    expect(t).toContain('pin = <hidden>')
    expect(t).toContain('password = <hidden>')
    noSecrets(t)
    expect((await call('get_environment', { name: 'Prod' })).text).toContain('host = https://prod.test')
    expect((await call('get_environment', { name: 'Nope' })).isError).toBe(true)
  })
})
