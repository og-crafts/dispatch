/** No approved edit may tell a right guess at a hidden value from a wrong one: the chat can't write what becomes a known secret. */
import { describe, expect, it, vi } from 'vitest'
import { newConnection } from '../src/core/assistant/connections'
import { runTool, type ToolContext } from '../src/core/assistant/gate'
import { ParameterBatches } from '../src/core/assistant/parameters'
import type { Proposal } from '../src/core/assistant/proposal'
import { allSecrets } from '../src/core/assistant/tools'
import type { McpServeOptions } from '../src/core/mcpHandler'
import type { Transport } from '../src/core/transport'
import { type Collection, defaultSettings, emptyBody, type Environment, type KV, kv, newCollection, newEnvironment, newRequest } from '../src/core/types'

const transport: Transport = { label: 't', unrestricted: true, send: vi.fn(async () => { throw new Error('no') }) }
const SECRET = 'Zq7hunter2XyW', RIGHT = SECRET.slice(0, 3), WRONG = 'Qx9'
/** Readable text that a guess is joined to; a known value that covers it and a part of the secret hides it too. */
const LEAD = '{"user": "ann", "password": "'
const URL_LEAD = 'https://ann:'

function mk(over: { variables?: KV[]; env?: KV[]; url?: string; headers?: KV[]; globals?: KV[] } = {}) {
  const shop: Collection = { ...newCollection('Shop'), variables: over.variables ?? [] }
  const env: Environment = { ...newEnvironment('Dev'), variables: over.env ?? [] }
  const login = newRequest({ name: 'Login', collectionId: shop.id, url: 'https://shop.test/login', sort: 1, body: { ...emptyBody('json'), text: `${LEAD}${SECRET}"}` }, docs: `as in ${URL_LEAD}${SECRET}@shop.test` })
  const mine = newRequest({ name: 'Mine', collectionId: shop.id, url: over.url ?? 'https://shop.test/mine', headers: over.headers ?? [], sort: 2 })
  const ws = { source: 'dispatch' as const, collections: [shop], folders: [] as McpServeOptions['ws']['folders'], requests: [login, mine], environments: [env], flows: [], warnings: [] }
  const world: McpServeOptions = { ws, environment: env, globals: over.globals ?? [], settings: { ...defaultSettings, activeSpaceId: 'default' }, transport, pipeline: {}, allowMethods: [], version: 't', allCollections: true }
  const conn = { ...newConnection('compatible'), name: 'Mine', model: 'm', tools: 'yes' as const, readLogs: false, key: 'k-123456789' }
  const cards: Proposal[] = []
  const put = <T extends { id: string }>(l: T[], p: Proposal, kind: string): T[] => {
    const cs = p.changes.filter((c) => c.kind === kind)
    return [...l.filter((x) => !cs.some((c) => c.id === x.id)), ...cs.flatMap((c) => (c.after ? [c.after as unknown as T] : []))]
  }
  const ctx: ToolContext = {
    world: () => world, conn, signal: new AbortController().signal, spaceId: 'default', job: 'ask', batches: new ParameterBatches(),
    secrets: () => allSecrets({ environments: ws.environments, globals: world.globals, collections: ws.collections, folders: ws.folders, requests: ws.requests, connections: [conn], signIns: [], cookies: [], clientCerts: [] }),
    unsaved: () => false, schedules: async () => [],
    decide: async (p) => { // the person approves everything
      cards.push(p)
      ws.collections = put(ws.collections, p, 'collection'); ws.folders = put(ws.folders, p, 'folder'); ws.requests = put(ws.requests, p, 'request'); ws.environments = put(ws.environments, p, 'environment')
      world.environment = ws.environments.find((e) => e.id === env.id) ?? null
      const g = p.changes.find((c) => c.kind === 'globals'); if (g) world.globals = g.after as KV[]
      return { outcome: 'applied' }
    },
  }
  const call = (name: string, input: Record<string, unknown>) => runTool(name, input, ctx)
  const read = async (name = 'Shop/Login') => (await call('get_request', { name })).text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'ID').replace(new RegExp(`${RIGHT}|${WRONG}`, 'g'), 'GUESS')
  const suggest = async (name: string) => {
    const t = (await call('suggest_parameters', { name })).text
    return { batch: /batch: (\S+)/.exec(t)?.[1] ?? '', id: (kind: string) => new RegExp(`^(${kind}:\\d+)`, 'm').exec(t)?.[1] ?? `no ${kind}` }
  }
  return { ws, world, cards, call, read, suggest }
}
type M = ReturnType<typeof mk>
type Step = (m: M, value: string) => Promise<unknown>

describe('a right guess reads like a wrong one', () => {
  const move = async (m: M, kind: string, as: string) => { const s = await m.suggest('Shop/Mine'); return m.call('apply_parameters', { name: 'Shop/Mine', batch: s.batch, choose: { [s.id(kind)]: as }, where: 'collection' }) }
  const ways: [string, string, Step][] = [
    ['a collection variable', LEAD, (m, v) => m.call('set_variables', { collection: 'Shop', variables: { token_a: v } })],
    ['a collection variable under a name with spaces around', LEAD, (m, v) => m.call('set_variables', { collection: 'Shop', variables: { ' token_a ': v } })],
    ['an empty variable of the person', LEAD, (m, v) => m.call('set_variables', { collection: 'Shop', variables: { own_token: v } })],
    ['a variable of the person that was only a reference', LEAD, (m, v) => m.call('set_variables', { collection: 'Shop', variables: { ref_token: v } })],
    ['an environment variable', LEAD, (m, v) => m.call('set_environment_variables', { variables: { token_a: v } })],
    ['a header', LEAD, (m, v) => m.call('update_request', { name: 'Shop/Mine', headers: { 'X-Token': v } })],
    ['a header with a scheme', LEAD, (m, v) => m.call('update_request', { name: 'Shop/Mine', headers: { authorization: `Bearer ${v}` } })],
    ['a Cookie header', LEAD, (m, v) => m.call('update_request', { name: 'Shop/Mine', headers: { Cookie: `a=${v.replace(/;/g, '')}; b=1` } })],
    ['a Cookie header that looks like a variable', 'ann', (m, v) => m.call('update_request', { name: 'Shop/Mine', headers: { Cookie: `{{a=${v}xxx; b}}` } })],
    ['a Set-Cookie header', LEAD, (m, v) => m.call('create_request', { folder: 'Shop', name: 'New', url: 'https://shop.test', headers: { 'Set-Cookie': `a=${v}; Path=/` } })],
    ['a header of a new request', LEAD, (m, v) => m.call('create_request', { folder: 'Shop', name: 'New', url: 'https://shop.test', headers: { 'x-api-key': v } })],
    ['a query parameter', LEAD, (m, v) => m.call('update_request', { name: 'Shop/Mine', url: `https://shop.test/?access_token=${encodeURIComponent(v)}` })],
    ['a query parameter with its name encoded', LEAD, (m, v) => m.call('update_request', { name: 'Shop/Mine', url: `https://shop.test/?t%6Fken=${encodeURIComponent(v)}` })],
    ['a query parameter of a new request', LEAD, (m, v) => m.call('create_request', { folder: 'Shop', name: 'New', url: `https://shop.test/?q=1&cookie=${encodeURIComponent(`a=${v}`)}` })],
    ['a key header under an ordinary name, then moved', LEAD, async (m, v) => { await m.call('update_request', { name: 'Shop/Mine', headers: { 'Ocp-Apim-Subscription-Key': v } }); await move(m, 'apiKeyHeader', '') }],
    ['a base URL, moved to a variable with a secret’s name', URL_LEAD, async (m, v) => { await m.call('update_request', { name: 'Shop/Mine', url: v }); await move(m, 'baseUrl', 'token_a') }],
    ['a base URL with a password, moved', URL_LEAD, async (m, v) => { await m.call('update_request', { name: 'Shop/Mine', url: `${v}@shop.test` }); await move(m, 'baseUrl', '') }],
    ['copied and moved about', LEAD, async (m, v) => {
      await m.call('copy_request', { from: 'Shop/Mine', to: 'Fresh', name: 'Copy' })
      await m.call('update_request', { name: 'Fresh/Copy', headers: { 'X-Session': v }, url: `https://shop.test/?sessionid=${encodeURIComponent(v)}` })
      await m.call('set_variables', { collection: 'Fresh', variables: { own_token: v, ref_token: v, api_key: v } })
      await m.call('move_request', { name: 'Fresh/Copy', to: 'Other/Deep', newName: 'Again' })
      await m.call('set_variables', { collection: 'Other', variables: { own_token: v } })
    }],
  ]
  it.each(ways)('%s', async (_what, lead, step) => {
    const after = async (guess: string) => {
      const m = mk({ variables: [kv('own_token', ''), kv('ref_token', '{{own_token}}')] })
      await step(m, lead + guess)
      return m.read()
    }
    const right = await after(RIGHT)
    expect(right).toBe(await after(WRONG))
    expect(right).toContain('"user": "ann"')
  })
  it('the body of a login can’t be recovered a character at a time', async () => {
    const m = mk()
    const first = await m.read()
    for (const c of 'YZa') await m.call('set_variables', { collection: 'Shop', variables: { [`token_${c}`]: LEAD.slice(0, -1).slice(-9) + '"' + c } })
    expect((await m.read()).split('\n').filter((l) => l.includes('"user"'))).toEqual(first.split('\n').filter((l) => l.includes('"user"')))
  })
  it('an ID in the path can’t be moved under a secret’s name, its own one either', async () => {
    const m = mk({ url: 'https://shop.test/tokens/1234567890' })
    for (const as of ['', 'api_key']) {
      const s = await m.suggest('Shop/Mine')
      const r = await m.call('apply_parameters', { name: 'Shop/Mine', batch: s.batch, choose: { [s.id('pathId')]: as }, where: 'collection' })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('has a secret’s name')
    }
    const s = await m.suggest('Shop/Mine')
    expect((await m.call('apply_parameters', { name: 'Shop/Mine', batch: s.batch, choose: { [s.id('pathId')]: 'itemId' }, where: 'collection' })).isError).toBe(false)
  })
})

describe('what the chat may still write under a secret’s name', () => {
  it('a new variable is made secret and left empty, and the card and the model hear it', async () => {
    const m = mk()
    const r = await m.call('set_variables', { collection: 'Shop', variables: { api_token: 'made-up-value', plain: '1', ref_token: '{{plain}}' } })
    expect(r.isError).toBe(false)
    expect(r.text).not.toContain('made-up-value')
    expect(r.text).toContain('secret and empty for the person to fill in')
    expect(m.ws.collections[0].variables).toMatchObject([{ key: 'api_token', value: '', secret: true }, { key: 'plain', value: '1' }, { key: 'ref_token', value: '{{plain}}' }])
    expect(m.cards[0].warnings).toContain('Dispatch leaves “api_token” empty for you to fill in.')
    expect(JSON.stringify({ ...m.cards[0], basis: '' })).not.toContain('made-up-value')
  })
  it('one that is there is the person’s to fill in, whatever its value', async () => {
    const m = mk({ variables: [kv('own_token', ''), kv('ref_token', '{{own_token}}')] })
    const texts = []
    for (const k of ['own_token', 'ref_token']) { const r = await m.call('set_variables', { collection: 'Shop', variables: { [k]: 'made-up' } }); expect(r.isError).toBe(true); texts.push(r.text) }
    expect(texts[0]).toContain('only the person')
    expect((await m.call('set_variables', { collection: 'Shop', variables: { own_token: '{{other}}' } })).isError).toBe(false)
    expect(m.cards).toHaveLength(1)
  })
  it('an empty one that would hide a globals one isn’t made', async () => {
    const m = mk({ globals: [kv('api_token', 'g', true, { secret: true })] })
    expect((await m.call('set_variables', { collection: 'Shop', variables: { api_token: 'x' } })).isError).toBe(true)
    expect(m.cards).toEqual([])
  })
  it.each([['{{tok}}', true], ['Bearer {{tok}}', true], ['Basic {{tok}}', true], ['', true], ['sid={{tok}}', false], ['{{a}}{{b}}', false], ['Zq7 {{tok}}', false], ['{{a=b; c}}', false], ['x', false]])('a header with “%s”: %s', async (v, fine) => {
    for (const k of ['Authorization', 'X-Session-Id', 'ocp-apim-subscription-key']) {
      const m = mk()
      expect([k, (await m.call('update_request', { name: 'Shop/Mine', headers: { [k]: v, Accept: 'x' } })).isError]).toEqual([k, !fine])
    }
  })
  it.each([['?token={{tok}}&q=1', true], ['?token=&q=1', true], ['?token=abc', false], ['?token={{a}}b', false], ['', true], ['@x', true]])('a URL with “%s”: %s', async (q, fine) => {
    const m = mk()
    expect((await m.call('create_request', { folder: 'Shop', name: 'N', url: `https://shop.test/${q}` })).isError).toBe(!fine)
  })
  it.each([['https://ann:pw123@shop.test', false], ['https://ann:{{pw}}@shop.test', true], ['https://shop.test/Bearer abcdefgh1', false]])('the URL %s: %s', async (url, fine) => {
    const m = mk()
    expect((await m.call('update_request', { name: 'Shop/Mine', url })).isError).toBe(!fine)
  })
  it('a key the person wrote that can be read may be given back as it is', async () => {
    const m = mk({ headers: [kv('Ocp-Apim-Subscription-Key', 'readable-1'), kv('A', '1')] })
    expect((await m.call('update_request', { name: 'Shop/Mine', headers: { 'Ocp-Apim-Subscription-Key': 'readable-1', A: '2' } })).isError).toBe(false)
    expect((await m.call('update_request', { name: 'Shop/Mine', headers: { 'Ocp-Apim-Subscription-Key': 'readable-2', A: '2' } })).isError).toBe(true)
  })
  it('a refusal says the same to a right and a wrong value', async () => {
    const m = mk({ headers: [kv('X-Token', SECRET)] })
    const say = async (v: string) => { const r = await m.call('update_request', { name: 'Shop/Mine', headers: { 'X-Token': v } }); expect(r.isError).toBe(true); return r.text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'ID') }
    expect(await say(SECRET)).toBe(await say('something else'))
  })
})
