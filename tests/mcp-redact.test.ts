/** What the sending tools hand back to an AI assistant: secrets in responses, tests and errors are hidden. */
import { describe, expect, it } from 'vitest'
import { handleMcp } from '../src/core/mcpHandler'
import { type HttpResponse, defaultSettings, kv, newCollection, newRequest } from '../src/core/types'
import type { Transport } from '../src/core/transport'
import type { Environment } from '../src/core/types'

const SECRET = 'planted-secret-9z'
const setup = (res: Partial<HttpResponse> = {}, error?: string) => {
  const col = newCollection('Shop')
  const req = newRequest({ name: 'Login', method: 'GET', url: 'https://shop.test/login', collectionId: col.id })
  const env = { id: 'e', name: 'Staging', variables: [{ ...kv('pin', SECRET), secret: true }], updatedAt: 0 } as unknown as Environment
  const transport: Transport = { label: 't', unrestricted: true, send: async () => {
    if (error) throw new Error(error)
    return { status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1, ...res }
  } }
  const o = { ws: { source: 'dispatch' as const, collections: [col], folders: [], requests: [req], environments: [env], flows: [], warnings: [] },
    environment: env, globals: [], settings: defaultSettings, transport, pipeline: {}, allowMethods: [], version: 't', allCollections: true }
  return async (name: string, args: object) => (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, o)).result.content[0].text as string
}

describe('send_request', () => {
  it('hides tokens and cookies in the response', async () => {
    const t = await setup({ headers: [['Set-Cookie', 'sid=abcdef123456'], ['X-Api-Key', 'k-abcdef123'], ['Content-Type', 'application/json']], body: '{"access_token":"fresh-token-1","name":"Ada"}' })('send_request', { name: 'Login' })
    expect(t).not.toMatch(/abcdef123|fresh-token-1/)
    expect(t).toContain('Content-Type: application/json')
    expect(t).toContain('"name":"Ada"')
  })
  it('hides a secret Dispatch knows, plain or encoded', async () => {
    const t = await setup({ body: `hello ${SECRET} there` })('send_request', { name: 'Login' })
    expect(t).not.toContain(SECRET)
    expect(t).toContain('hello <hidden> there')
  })
  it('hides it across the cut', async () => {
    const t = await setup({ body: 'x'.repeat(19_990) + SECRET })('send_request', { name: 'Login' })
    expect(t).not.toContain('planted-se')
  })
  it('hides saved refresh and session tokens', async () => {
    const { knownSecrets } = await import('../src/core/mcpLogs')
    const col = { ...newCollection('A'), auth: { ...newCollection('A').auth, refreshToken: 'refresh-123', sessionToken: 'session-123' } } as never
    expect(knownSecrets({ environments: [], globals: [], collections: [col], folders: [], requests: [] })).toEqual(expect.arrayContaining(['refresh-123', 'session-123']))
  })
  it('hides it in an error', async () => {
    expect(await setup({}, `refused for ${SECRET}`)('send_request', { name: 'Login' })).not.toContain(SECRET)
  })
  it('hides a secret value as JSON and URL text write it', async () => {
    const { Redactor } = await import('../src/core/mcpLogs')
    const r = new Redactor(['pa"ss w/rd'])
    expect(r.text('{"x":"pa\\"ss w/rd"}')).toBe('{"x":"<hidden>"}')
    expect(r.text('https://a.test/?x=pa%22ss%20w%2Frd')).toBe('https://a.test/?x=<hidden>')
  })
})

it('run_collection hides a known secret in failures', async () => {
  const t = await setup({}, `refused for ${SECRET}`)('run_collection', { folder: 'Shop' })
  expect(t).toContain('✗ Login')
  expect(t).not.toContain(SECRET)
})
