/** Values moved into variables by id: the model never sees one, none is lost, and what is sent stays the same. */
import { describe, expect, it, vi } from 'vitest'
import { newConnection } from '../src/core/assistant/connections'
import { runTool } from '../src/core/assistant/gate'
import { ParameterBatches, suggestionsFor } from '../src/core/assistant/parameters'
import type { Proposal } from '../src/core/assistant/proposal'
import { propose, type ProposeContext } from '../src/core/assistant/propose'
import { allSecrets } from '../src/core/assistant/tools'
import type { McpServeOptions } from '../src/core/mcpHandler'
import { prepare } from '../src/core/prepare'
import { newSchedule, type Schedule } from '../src/core/schedules'
import type { Transport } from '../src/core/transport'
import { type Collection, defaultSettings, emptyAuth, emptyBody, type Environment, type KV, kv, newCollection, newEnvironment, newFolder, newRequest, type RequestDef } from '../src/core/types'

const TOKEN = 'plant-token-AAAA1', KEY = 'plant-apikey-BBBB2'
const secretVar = (k: string, v: string) => kv(k, v, true, { secret: true })
const transport: Transport = { label: 't', unrestricted: true, send: vi.fn(async () => { throw new Error('must not send') }) }
const col = (over: Partial<Collection> = {}, name = 'Shop'): Collection => ({ ...newCollection(name), ...over })
const envOf = (variables: KV[], name = 'Dev', over: Partial<Environment> = {}): Environment => ({ ...newEnvironment(name), variables, ...over })
const req = (c: Collection, over: Partial<RequestDef> = {}) => newRequest({ name: 'Create order', collectionId: c.id, url: 'https://shop.test/x', sort: 1, ...over })
const typical = (c: Collection, over: Partial<RequestDef> = {}) => req(c, { url: 'https://shop.test/users/12345/orders', headers: [kv('Authorization', `Bearer ${TOKEN}`), kv('X-API-Key', KEY), kv('Accept', '*/*')], ...over })

interface W { collections?: Collection[]; requests?: RequestDef[]; environments?: Environment[]; active?: Environment | null; globals?: KV[]; schedules?: Schedule[]; unsaved?: string[]; secrets?: string[]; folders?: ReturnType<typeof newFolder>[] }
const setup = (o: W) => {
  const ws = { source: 'dispatch' as const, collections: o.collections ?? [], folders: o.folders ?? [], requests: o.requests ?? [], environments: o.environments ?? (o.active ? [o.active] : []), flows: [], warnings: [] }
  const world: McpServeOptions = { ws, environment: o.active ?? null, globals: o.globals ?? [], settings: { ...defaultSettings, activeSpaceId: 'default' }, transport, pipeline: {}, allowMethods: [], version: 't', allCollections: true }
  const conn = { ...newConnection('compatible'), name: 'Mine', model: 'm', tools: 'yes' as const, readLogs: false, key: 'plant-conn-key-9' }
  const ctx: ProposeContext = {
    world: () => world, conn, signal: new AbortController().signal, spaceId: 'default', batches: new ParameterBatches(),
    secrets: () => [...(o.secrets ?? []), ...allSecrets({ environments: ws.environments, globals: world.globals, collections: ws.collections, folders: ws.folders, requests: ws.requests, connections: [conn], signIns: [], cookies: [], clientCerts: [] })],
    unsaved: (id) => (o.unsaved ?? []).includes(id), schedules: async () => o.schedules ?? [],
  }
  const suggest = async (name = 'Shop/Create order') => {
    const r = await runTool('suggest_parameters', { name }, ctx)
    const lines = r.text.split('\n').filter((l) => l.includes(' · ')).map((l) => l.split(' · '))
    return { ...r, lines, batch: /batch: (\S+)/.exec(r.text)?.[1] ?? '', id: (what: string) => lines.find((l) => l.slice(0, 3).join(' ').includes(what))?.[0] ?? `no ${what}` }
  }
  const run = (name: string, input: Record<string, unknown>) => propose(name, input, ctx)
  /** Suggests and proposes the ones named (by any part of their line), with the suggested or given names. */
  const move = async (what: Record<string, string>, where = 'environment') => { const s = await suggest(); return run('apply_parameters', { name: 'Shop/Create order', batch: s.batch, choose: Object.fromEntries(Object.entries(what).map(([w, n]) => [s.id(w), n])), where }) }
  return { world, ctx, suggest, run, move }
}
const good = async (p: ReturnType<typeof propose>): Promise<Proposal> => { const r = await p; if ('refused' in r) throw new Error(r.refused); return r }
const refused = async (p: ReturnType<typeof propose>): Promise<string> => { const r = await p; if (!('refused' in r)) throw new Error(`not refused: ${r.title}`); return r.refused }
const field = (p: Proposal, label: string) => p.fields.find((f) => f.label === label)
const added = (p: Proposal, label: string) => field(p, label)?.lines.filter((l) => l.type === 'add').map((l) => l.text)
const removed = (p: Proposal, label: string) => field(p, label)?.lines.filter((l) => l.type === 'del').map((l) => l.text)
const reqOf = (p: Proposal) => p.changes.find((c) => c.kind === 'request')!.after as RequestDef
const varsOf = (p: Proposal) => { const a = p.changes.find((c) => c.kind !== 'request')?.after; return !a ? [] : Array.isArray(a) ? a : (a as Environment).variables }
const card = (p: Proposal) => JSON.stringify({ ...p, changes: undefined })
/** No run of six characters of it, so no part either. */
const without = (text: string, secret: string) => { for (let i = 0; i + 6 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 6)) }
const CHANGED = 'The request changed. Look at the suggestions again. Nothing was changed.'

describe('suggest_parameters', () => {
  it('names what can move and shows no value, nor a part of one', async () => {
    const c = col(), r = typical(c, { auth: { ...emptyAuth('basic'), username: 'ann', password: 'plant-pass-CCCC3' } })
    const s = await setup({ collections: [c], requests: [r], active: envOf([]) }).suggest()
    expect(s.isError).toBe(false)
    expect(s.text).toMatch(/<<data /)
    for (const v of [TOKEN, KEY, 'plant-pass-CCCC3']) without(s.text, v)
    expect(s.text).not.toContain('12345')
    expect(s.lines.map((l) => l.slice(1))).toEqual([
      ['base URL', '{{baseUrl}}', 'new'], ['bearer token', '{{token}}', 'new', 'secret'], ['API key in the header X-API-Key', '{{apiKey}}', 'new', 'secret'],
      ['sign-in password', '{{password}}', 'new', 'secret'], ['ID in the path', ':userId', 'new'],
    ])
    expect(s.batch).toMatch(/^[0-9a-f-]{20,}$/)
  })
  it('an existing variable, plain or secret, and a subscription key', async () => {
    const c = col(), r = req(c, { url: 'https://shop.test/acme-prod', headers: [kv('Authorization', `Bearer ${TOKEN}`), kv('Ocp-Apim-Subscription-Key', 'plant-ocp-DDDD4')] })
    const s = await setup({ collections: [c], requests: [r], active: envOf([kv('tenant', 'acme-prod'), secretVar('tok', TOKEN)]) }).suggest()
    expect(s.lines.map((l) => l.slice(1))).toEqual([
      ['a value that a variable already has', '{{tok}}', 'existing', 'secret'], ['a value that a variable already has', '{{tenant}}', 'existing'], ['base URL', '{{baseUrl}}', 'new'],
      ['API key in the header Ocp-Apim-Subscription-Key', '{{apiKey}}', 'new', 'secret'],
    ])
    without(s.text, 'plant-ocp-DDDD4'); without(s.text, TOKEN)
  })
  it('a name made from a hidden part of the path isn’t used', async () => {
    const c = col(), r = req(c, { url: 'https://shop.test/plant-seg-EEEE5/12345/a/67890' })
    const s = await setup({ collections: [c], requests: [r], secrets: ['plant-seg-EEEE5'] }).suggest()
    expect(s.lines.filter((l) => l[1].includes('path')).map((l) => l[2])).toEqual([':itemId', ':itemId2'])
    expect(s.text.toLowerCase()).not.toContain('eeee5')
  })
  it.each<[string, KV, Partial<RequestDef>]>([
    ['a plain value that is a part of a hidden one', kv('guess', 'plant-tok'), { headers: [kv('Authorization', `Bearer ${TOKEN}`)] }],
    ['a part of a hidden one, under a secret’s name', kv('guessToken', 'plant-tok'), { headers: [kv('Authorization', `Bearer ${TOKEN}`)] }],
    ['a short secret the model can see in the request', secretVar('pin', '4821'), { body: { ...emptyBody('text'), text: '4821 4822' } }],
    ['what a secret variable stands for', secretVar('alias', '{{other}}'), { body: { ...emptyBody('text'), text: '{{other}}' } }],
    ['a part of a short password', kv('guess', '4821'), { auth: { ...emptyAuth('basic'), username: 'ann', password: '4821' } }],
  ])('tells nothing about %s', async (_n, v, over) => {
    const c = col(), r = req(c, over)
    const lines = async (value: string) => (await setup({ collections: [c], requests: [r], active: envOf([{ ...v, value }]) }).suggest()).lines
    expect(await lines(v.value)).toEqual(await lines('something-else'))
  })
  it('leaves out a value that name doesn’t have here', async () => {
    const c = col({ variables: [kv('tenant', 'acme-prod')] }), r = req(c, { url: 'https://shop.test/acme-prod' })
    const s = await setup({ collections: [c], requests: [r], active: envOf([kv('tenant', 'acme-test')]) }).suggest()
    expect(s.text).not.toContain('tenant')
  })
  it('one line per suggestion, whatever a variable is called, and none for a name {{…}} can’t hold', async () => {
    const c = col(), r = req(c, { url: 'https://shop.test/acme-prod/other-1' })
    const s = await setup({ collections: [c], requests: [r], active: envOf([kv('a\nbearer:9 · x', 'acme-prod'), kv('b\u202Ec', 'other-1')]) }).suggest()
    expect(s.lines.map((l) => [l[0], l[2]])).toEqual([['existing:0', '{{b\\u{202E}c}}'], ['baseUrl:1', '{{baseUrl}}']])
  })
  it('a secret in a variable’s name is hidden', async () => {
    const c = col(), r = req(c, { url: 'https://shop.test/acme-prod' })
    const s = await setup({ collections: [c], requests: [r], active: envOf([kv('k-plant-name-FFFF6', 'acme-prod')]), secrets: ['plant-name-FFFF6'] }).suggest()
    expect(s.lines[0][2]).toBe('{{k-<hidden>}}')
  })
  it('nothing to suggest, and a request that isn’t there', async () => {
    const c = col(), far = col({ workspaceId: 'other' }, 'Far')
    const s = setup({ collections: [c, far], requests: [req(c, { url: '{{base}}/x' }), req(far, { name: 'Far one' })] })
    const r = await s.suggest()
    expect(r).toMatchObject({ isError: false, batch: '' })
    expect(r.text).toContain('Nothing to move')
    expect((await s.suggest('Far/Far one')).isError).toBe(true)
  })
  it('a userinfo in the base URL makes it secret', () => {
    const c = col(), s = setup({ collections: [c], requests: [req(c, { url: 'https://me:pw123@shop.test/x' })] })
    expect(suggestionsFor(s.world.ws.requests[0], s.world)).toMatchObject([{ kind: 'baseUrl', secret: true }])
  })
})

describe('apply_parameters', () => {
  const make = (o: W = {}) => { const c = o.collections?.[0] ?? col(); return setup({ collections: [c], requests: [typical(c)], active: envOf([kv('old', '1')]), ...o }) }

  it('one proposal with the request and the table: the variable is secret and holds the real value, the card shows none', async () => {
    const s = make(), was = structuredClone({ ws: s.world.ws, environment: s.world.environment })
    const p = await good(s.move({ 'bearer token': '', 'API key': 'shopKey' }))
    expect(p).toMatchObject({ tool: 'apply_parameters', cls: 'edit', title: 'Move values of “Create order” into variables of the environment “Dev”' })
    expect(p.changes.map((c) => c.kind)).toEqual(['request', 'environment'])
    expect(p.changes.map((c) => c.before)).toEqual([was.ws.requests[0], was.environment])
    expect(varsOf(p)).toMatchObject([{ key: 'old', value: '1' }, { key: 'token', value: TOKEN, secret: true, enabled: true }, { key: 'shopKey', value: KEY, secret: true }])
    expect(reqOf(p).auth).toMatchObject({ kind: 'bearer', token: '{{token}}' })
    expect(reqOf(p).headers.map((h) => [h.key, h.value])).toEqual([['X-API-Key', '{{shopKey}}'], ['Accept', '*/*']])
    expect(removed(p, 'Headers')).toEqual(['Authorization: Bearer <hidden>', 'X-API-Key: <hidden>'])
    expect(added(p, 'Auth')).toEqual(['bearer', 'token: {{token}}'])
    expect(added(p, 'Headers')).toEqual(['X-API-Key: {{shopKey}}'])
    expect(added(p, 'Variables')).toEqual(['token = <hidden>', 'shopKey = <hidden>'])
    expect(card(p)).not.toContain('plant-')
    expect(p.reply).toContain('{{token}}')
    expect(p.warnings).toEqual([])
    expect(s.world.ws).toEqual(was.ws)
  })
  it('a sign-in token in the Auth tab, shown as <hidden> → {{token}}', async () => {
    const c = col(), p = await good(make({ collections: [c], requests: [req(c, { auth: { ...emptyAuth('bearer'), token: 'abc' } })] }).move({ 'bearer token': '' }))
    expect([removed(p, 'Auth'), added(p, 'Auth')]).toEqual([['token: <hidden>'], ['token: {{token}}']])
  })
  it('everything at once still sends exactly the same', async () => {
    const c = col({ variables: [kv('tenant', 'acme-prod')] }), env = envOf([])
    const r = typical(c, { body: { ...emptyBody('json'), text: '{"t":"acme-prod"}' } })
    const s = make({ collections: [c], requests: [r], active: env })
    const p = await good(s.move({ 'base URL': '', 'bearer token': '', 'API key': '', 'ID in the path': 'user', tenant: '' }))
    const after = prepare(reqOf(p), { collection: c, environment: { ...env, variables: varsOf(p) } }), before = prepare(r, { collection: c, environment: env })
    expect([after.url, after.body, after.unresolved]).toEqual([before.url, before.body, []])
    expect(after.headers.sort()).toEqual(before.headers.sort())
    expect(reqOf(p).url).toBe('{{baseUrl}}/users/:user/orders')
    expect(added(p, 'Path variables')).toEqual(['user: 12345'])
    expect(added(p, 'Body')).toEqual(['{"t":"{{tenant}}"}'])
  })
  it('into the collection, the globals, and without an active environment', async () => {
    const c = col()
    const p = await good(make({ collections: [c], active: null }).move({ 'bearer token': '' }, 'collection'))
    expect(p.changes[1]).toMatchObject({ kind: 'collection', id: c.id, before: c })
    expect(p.title).toContain('the collection “Shop”')
    const g = await good(make({ collections: [c], active: null, globals: [kv('g', '1')] }).move({ 'bearer token': '' }, 'globals'))
    expect(g.changes[1]).toMatchObject({ kind: 'globals', id: 'globals' })
    expect(varsOf(g).map((v) => v.key)).toEqual(['g', 'token'])
    expect(g.title).toContain('the globals')
    expect(await refused(make({ collections: [c], active: null }).move({ 'bearer token': '' }))).toBe('No environment is active, so pick the collection or the globals. Nothing was changed.')
    // another workspace's environment isn't it
    expect(await refused(make({ collections: [c], active: envOf([], 'Far', { workspaceId: 'other' }) }).move({ 'bearer token': '' }))).toContain('No environment is active')
  })
  it('a key that wasn’t known to be a secret isn’t on the card either', async () => {
    const c = col(), p = await good(make({ collections: [c], requests: [req(c, { headers: [kv('Ocp-Apim-Subscription-Key', 'plant-ocp-DDDD4')], body: { ...emptyBody('text'), text: 'plant-ocp-DDDD4!' } })] }).move({ 'API key': '' }))
    expect(reqOf(p)).toMatchObject({ headers: [{ value: '{{apiKey}}' }], body: { text: '{{apiKey}}!' } })
    expect(card(p)).not.toContain('plant')
  })
  it('only an existing variable needs no table', async () => {
    const c = col(), p = await good(make({ collections: [c], requests: [req(c, { url: 'https://shop.test/acme-prod' })], active: null, globals: [kv('tenant', 'acme-prod')] }).move({ tenant: '' }))
    expect(p.changes).toHaveLength(1)
    expect(reqOf(p).url).toBe('https://shop.test/{{tenant}}')
  })
  it.each<[string, (w: McpServeOptions) => void]>([
    ['the request', (w) => { w.ws.requests[0] = { ...w.ws.requests[0], docs: 'new' } }], ['the environment', (w) => { w.environment = w.ws.environments[0] = { ...w.ws.environments[0], variables: [kv('n', '1')] } }],
    ['the active environment', (w) => { w.ws.environments.push(envOf([], 'Two')); w.environment = w.ws.environments[1] }], ['the collection’s variables', (w) => { w.ws.collections[0] = { ...w.ws.collections[0], variables: [kv('n', '1')] } }],
    ['the globals', (w) => { w.globals = [kv('n', '1')] }],
  ])('a batch from before %s changed', async (_n, change) => {
    const s = make(), g = await s.suggest()
    change(s.world)
    expect(await refused(s.run('apply_parameters', { name: 'Shop/Create order', batch: g.batch, choose: { [g.id('bearer')]: '' }, where: 'globals' }))).toBe(CHANGED)
  })
  it('updatedAt alone doesn’t matter; an unknown batch, id, or another request’s batch does', async () => {
    const s = make(), g = await s.suggest()
    s.world.ws.requests[0] = { ...s.world.ws.requests[0], updatedAt: 5 }
    const call = (over: object) => s.run('apply_parameters', { name: 'Shop/Create order', batch: g.batch, choose: { [g.id('bearer')]: '' }, where: 'environment', ...over })
    await good(call({}))
    expect(await refused(call({ batch: 'made-up' }))).toBe(CHANGED)
    expect(await refused(call({ choose: { 'bearer:99': '' } }))).toContain('no suggestion “bearer:99”')
    expect(await refused(call({ choose: {} }))).toContain('Choose at least one')
    expect(await refused(call({ where: 'anywhere' }))).toContain('Nothing was changed.')
    s.world.ws.requests.push({ ...s.world.ws.requests[0], id: 'two', name: 'Two' })
    expect(await refused(call({ name: 'Shop/Two' }))).toBe(CHANGED)
  })
  it('the last ten batches are kept', async () => {
    const s = make(), first = await s.suggest(), second = await s.suggest()
    for (let i = 0; i < 9; i++) await s.suggest()
    const call = (g: typeof first) => s.run('apply_parameters', { name: 'Shop/Create order', batch: g.batch, choose: { [g.id('bearer')]: '' }, where: 'environment' })
    expect(await refused(call(first))).toBe(CHANGED)
    await good(call(second))
  })
  it('another chat’s batch isn’t known', async () => {
    const s = make(), g = await s.suggest()
    expect(await refused(propose('apply_parameters', { name: 'Shop/Create order', batch: g.batch, choose: { [g.id('bearer')]: '' }, where: 'environment' }, { ...s.ctx, batches: new ParameterBatches() }))).toBe(CHANGED)
  })
  it.each(['token 2', '{{x}}', 'old', 'off', 'inColl', 'inGlobals', '$guid', '<hidden>', ' '])('the name %j is refused', async (n) => {
    const c = col({ variables: [kv('inColl', '1')] })
    expect(await refused(make({ collections: [c], active: envOf([kv('old', '1'), kv(' off ', '1', false)]), globals: [kv('inGlobals', '1')] }).move({ 'bearer token': n }))).toContain('Nothing was changed.')
  })
  it('names: twice the same, another one for an existing variable, and what a path variable can’t be called', async () => {
    const c = col(), r = typical(c, { url: 'https://shop.test/:shop/users/12345', pathVars: [kv('shop', '1')] })
    const s = make({ collections: [c], requests: [r], globals: [kv('any', '*/*x')] })
    expect(await refused(s.move({ 'bearer token': 'same', 'API key': 'same' }))).toContain('“same”')
    const two = make({ collections: [c], requests: [req(c, { url: 'https://shop.test/users/12345/orders/67890' })] }), g = await two.suggest()
    expect(await refused(two.run('apply_parameters', { name: 'Shop/Create order', batch: g.batch, choose: Object.fromEntries(g.lines.filter((l) => l[1].includes('path')).map((l) => [l[0], 'same'])), where: 'globals' }))).toContain('“same” is already used')
    expect(await refused(s.move({ 'bearer token': '$guid' }))).toContain('can’t be a name')
    for (const n of ['shop', 'a-é', '1a']) expect(await refused(s.move({ 'ID in the path': n }))).toContain('Nothing was changed.')
    const t = make({ collections: [c], requests: [req(c, { url: 'https://shop.test/acme-prod' })], globals: [kv('tenant', 'acme-prod')] })
    expect(await refused(t.move({ tenant: 'other' }))).toContain('already a variable')
    await good(t.move({ tenant: 'tenant' }))
  })
  it('unsaved edits are refused like for update_request', async () => {
    const c = col(), r = typical(c)
    expect(await refused(make({ collections: [c], requests: [r], unsaved: [r.id] }).move({ 'bearer token': '' }))).toBe('Save or discard your changes to “Create order” first. Nothing was changed.')
  })
  it('a name that holds a secret is found by its cleaned form', async () => {
    const c = col({}, 'Shop'), r = typical(c, { name: 'Get plant-name-FFFF6' }), s = make({ collections: [c], requests: [r], secrets: ['plant-name-FFFF6'] })
    // the gate takes no <hidden> for reads, so the batch is made under its bare words here
    const t = make({ collections: [c], requests: [{ ...r, name: 'G' }] })
    expect((await t.suggest('G')).batch).not.toBe('')
    expect(await refused(s.run('apply_parameters', { name: 'Shop/Get <hidden>', batch: 'x', choose: { a: '' }, where: 'globals' }))).toBe(CHANGED)
    expect(await refused(s.run('apply_parameters', { name: `Shop/${r.name}`, batch: 'x', choose: { a: '' }, where: 'globals' }))).toContain('No request')
  })

  describe('shows no hidden value by taking a part of it away', () => {
    it('a plain value is replaced only where it was shown', async () => {
      const c = col(), secret = 'prod-secret-2024'
      const r = req(c, { url: 'https://shop.test/2024', headers: [kv('X-Api-Key', 'k2024k')], auth: { ...emptyAuth('basic'), username: 'me2024', password: '2024' }, body: { ...emptyBody('text'), text: `2024 and ${secret} and 2024` } })
      const p = await good(make({ collections: [c], requests: [r], globals: [kv('year', '2024')], secrets: [secret] }).move({ year: '' }))
      expect(reqOf(p)).toMatchObject({ url: 'https://shop.test/{{year}}', body: { text: `{{year}} and ${secret} and {{year}}` }, auth: { username: 'me{{year}}', password: '2024' } })
      expect(reqOf(p).headers[0].value).toBe('k2024k')
      expect(card(p)).not.toContain('prod-secret')
    })
    it('a short secret isn’t replaced where the model can read it', async () => {
      const c = col(), r = req(c, { auth: { ...emptyAuth('basic'), username: 'ann', password: 'a' }, body: { ...emptyBody('text'), text: 'data' } })
      const p = await good(make({ collections: [c], requests: [r] }).move({ 'sign-in password': '' }))
      expect(reqOf(p)).toMatchObject({ auth: { username: 'ann', password: '{{password}}' }, body: { text: 'data' } })
    })
    it('nor is what hides the text next to it', async () => {
      const c = col(), r = req(c, { url: 'https://shop.test/word-of-token?token=zzz1', docs: '' })
      const p = await good(make({ collections: [c], requests: [r], globals: [kv('w', 'token')] }).move({ 'base URL': '', '{{w}}': '' }))
      expect(reqOf(p).url).toBe('{{baseUrl}}/word-of-token?token=zzz1')
    })
    it('nor a secret inside a longer one', async () => {
      const c = col(), r = req(c, { headers: [kv('X-Trace', 'abcdef-LONGER-77')], body: { ...emptyBody('text'), text: 'abcdef' } })
      const p = await good(make({ collections: [c], requests: [r], globals: [secretVar('a', 'abcdef')], secrets: ['abcdef-LONGER-77'] }).move({ '{{a}}': '' }))
      expect(reqOf(p)).toMatchObject({ headers: [{ value: 'abcdef-LONGER-77' }], body: { text: '{{a}}' } })
    })
    it('a base URL that holds the start of one is secret, and stays where the rest would show', async () => {
      const c = col(), s = make({ collections: [c], requests: [req(c, { url: 'https://abcSEC/RET99x/y' })], secrets: ['abcSEC/RET99x'] })
      expect(await refused(s.move({ 'base URL': '' }))).toContain('Nothing was changed.')
    })
    it('an ID that is a part of one stays', async () => {
      const c = col(), s = make({ collections: [c], requests: [req(c, { url: '{{base}}/abc/123456/y' })], secrets: ['abc/123456'] })
      expect(await refused(s.move({ 'ID in the path': '' }))).toContain('Nothing was changed.')
    })
  })
  describe('loses nothing, and changes nothing that is sent', () => {
    it('another sign-in kept on the request', async () => {
      const c = col(), s = make({ collections: [c], requests: [typical(c, { auth: { ...emptyAuth('basic'), username: 'me', password: 'plant-old-GGGG7' } })] })
      const t = await refused(s.move({ 'bearer token': '' }))
      expect(t).toContain('holds a secret')
      expect(t).not.toContain('plant')
    })
    it('an inherited sign-in that is sent too', async () => {
      const c = col({ auth: { ...emptyAuth('apikey'), key: 'X-K', value: 'k1' } })
      expect(await refused(make({ collections: [c], requests: [typical(c)] }).move({ 'bearer token': '' }))).toBe('That would change what this request sends. Nothing was changed.')
    })
    it('a hidden path variable that isn’t in the URL', async () => {
      const c = col(), s = make({ collections: [c], requests: [typical(c, { pathVars: [kv('token', 'stale-1')] })] })
      expect(await refused(s.move({ 'ID in the path': '' }))).toContain('path variables')
    })
    it('a body that waits for the name', async () => {
      const c = col(), s = make({ collections: [c], requests: [typical(c, { body: { ...emptyBody('text'), text: '{{leak}}' } })] })
      expect(await refused(s.move({ 'bearer token': 'leak' }))).toContain('change what this request sends')
    })
    it('a name inside {{…}} stays whole', async () => {
      const c = col(), p = await good(make({ collections: [c], requests: [req(c, { url: '{{tenant1}}/tenant' })], globals: [kv('w', 'tenant'), kv('tenant1', 'zz')] }).move({ '{{w}}': '' }))
      expect(reqOf(p).url).toBe('{{tenant1}}/{{w}}')
    })
  })

  describe('warnings', () => {
    const NEW = (h: string) => `Its sign-in would go to a new address: ${h}.`
    it('none for a base URL and a token that go where they went', async () => {
      const c = col(), o = { collections: [c], requests: [typical(c)], active: envOf([]) }
      expect((await good(make({ ...o, environments: [o.active, envOf([], 'Prod')] }).move({ 'base URL': '', 'bearer token': '' }))).warnings).toEqual([])
      expect((await good(make(o).move({ 'base URL': 'authToken' }, 'collection'))).warnings).toEqual([])
    })
    it('an existing secret where it was', async () => {
      const c = col(), p = await good(make({ collections: [c], requests: [typical(c)], active: envOf([secretVar('tok', TOKEN)]) }).move({ tok: '' }))
      expect(p.warnings).toEqual([])
    })
    it('another environment sends it elsewhere, or sends another secret', async () => {
      const c = col(), dev = envOf([]), bad = envOf([kv('baseUrl', 'https://evil.example'), secretVar('t', 'other-token-1')], 'Prod')
      const p = await good(make({ collections: [c], active: dev, environments: [dev, bad] }).move({ 'base URL': 'baseUrl', 'bearer token': 't' }))
      expect(p.warnings).toEqual([NEW('evil.example'), 'Uses {{t}}, which is secret.'])
    })
    it('a place of this or another request that waits for the name', async () => {
      const c = col(), t = typical(c, { headers: [kv('X-API-Key', KEY)], auth: { ...emptyAuth('oauth2'), tokenUrl: 'https://shop.test/t', clientId: '{{leak}}' } }), other = req(c, { name: 'Other', url: 'https://evil.example/?t={{spill}}', sort: 2 })
      expect((await good(make({ collections: [c], requests: [t] }).move({ 'API key': 'leak' }))).warnings).toEqual(['Uses {{leak}}, which is secret.', 'Used by 1 request.'])
      expect((await good(make({ collections: [c], requests: [typical(c), other] }).move({ 'bearer token': 'spill' }, 'globals'))).warnings).toEqual(['Uses {{spill}}, which is secret.', 'Used by 1 request.'])
    })
    it('a schedule that sends it', async () => {
      const c = col()
      expect((await good(make({ collections: [c], schedules: [{ ...newSchedule(c.id, 'Nightly'), name: 'Nightly' }] }).move({ 'bearer token': '' }))).warnings).toEqual(['The schedule “Nightly” sends this while Dispatch is open.'])
    })
  })
})

describe('set_environment_variables', () => {
  const layered = kv('base', 'a', true, { options: [{ id: '1', name: 'lb', value: 'a' }, { id: '2', name: 'pod', value: 'b' }], active: 'lb' })
  const env = envOf([layered, kv('plain', 'old'), secretVar('pin', '4821'), kv('password', 'longer-value'), kv('sessionToken', ''), kv(' spaced ', '1')])
  const far = envOf([kv('x', '1')], 'Far', { workspaceId: 'other' })
  const prod = envOf([], 'Prod')
  const c = col()
  const { run, world } = setup({ collections: [c], requests: [req(c, { url: 'https://shop.test/{{plain}}' })], environments: [env, prod, far], active: env })
  const set = (i: Record<string, unknown>) => run('set_environment_variables', i)

  it('sets plain ones and the active layer, adds and removes', async () => {
    const was = structuredClone(world.ws)
    const p = await good(set({ variables: { base: 'z', spaced: '2', fresh: 'n' }, remove: ['plain'] }))
    expect(p).toMatchObject({ title: 'Change the variables of “Dev”', cls: 'edit', changes: [{ kind: 'environment', id: env.id, before: env }] })
    expect(varsOf(p).map((v) => [v.key, v.value])).toEqual([['base', 'z'], ['pin', '4821'], ['password', 'longer-value'], ['sessionToken', ''], [' spaced ', '2'], ['fresh', 'n']])
    expect(varsOf(p)[0]).toMatchObject({ active: 'lb', options: [{ value: 'z' }, { value: 'b' }] })
    expect(p.warnings).toEqual(['Used by 1 request.'])
    expect(card(p)).not.toMatch(/4821|longer-value/)
    expect(p.reply).toContain('set base, spaced, fresh; removed plain')
    expect(world.ws).toEqual(was)
  })
  it('a new one with a secret’s name is secret and empty, whatever value came', async () => {
    const p = await good(set({ environment: 'Prod', variables: { apiToken: 'made-up-value' } }))
    expect(varsOf(p)).toMatchObject([{ key: 'apiToken', value: '', secret: true, enabled: true }])
    expect(p.warnings).toEqual(['Dispatch leaves “apiToken” empty for you to fill in.'])
    expect(JSON.stringify(p)).not.toContain('made-up-value')
    expect(p.reply).toContain('apiToken')
  })
  it('an existing secret one can’t be set or removed, and a guess tells nothing', async () => {
    for (const k of ['pin', 'password', 'sessionToken']) {
      for (const i of [{ variables: { [k]: 'x' } }, { remove: [k] }, { variables: { [`${k} `]: 'x' } }]) expect(await refused(set(i))).toContain('is secret')
    }
    expect(await refused(set({ variables: { pin: '4821' } }))).toBe(await refused(set({ variables: { pin: '0000' } })))
  })
  it('a secret outside of the layer in use isn’t replaced either', async () => {
    const e = envOf([{ ...layered, options: [layered.options![0], { id: '2', name: 'pod', value: 'plant-layer-HHHH8' }] }])
    expect(await refused(setup({ environments: [e], active: e, secrets: ['plant-layer-HHHH8'] }).run('set_environment_variables', { variables: { base: 'z' } }))).toContain('is secret')
  })
  it('only the open workspace’s environments, one of that name, and one that is there', async () => {
    expect(await refused(set({ environment: 'Far', variables: { a: 'b' } }))).toContain('No environment “Far”')
    expect(await refused(setup({ environments: [far], active: far }).run('set_environment_variables', { variables: { a: 'b' } }))).toContain('No environment is active')
    expect(await refused(setup({ environments: [prod, envOf([], 'Prod')] }).run('set_environment_variables', { environment: 'Prod', variables: { a: 'b' } }))).toContain('more than one')
    const named = envOf([], 'E plant-env-IIII9'), s = setup({ environments: [named], secrets: ['plant-env-IIII9'] })
    expect(await refused(s.run('set_environment_variables', { environment: named.name, variables: { a: 'b' } }))).toContain('No environment “E <hidden>”')
    const p = await good(s.run('set_environment_variables', { environment: 'E <hidden>', variables: { a: 'b' } }))
    expect([p.title, (p.changes[0].after as Environment).name]).toEqual(['Change the variables of “E <hidden>”', named.name])
  })
  it('odd names, <hidden>, a missing name, and nothing at all', async () => {
    for (const i of [{ variables: { 'a b': '1' } }, { variables: { '{{a}}': '1' } }, { variables: { '': '1' } }, { variables: { a: '<hidden>' } }, { remove: ['plain', 'none'] }, { variables: { plain: 'x' }, remove: ['plain'] }, {}, { variables: { plain: 'old' } }]) {
      expect(await refused(set(i))).toContain('Nothing was changed.')
    }
  })
  it('warns of a new address, a secret newly used and a schedule', async () => {
    const e = envOf([kv('host', 'shop.test'), secretVar('tok', 'tok-abcdef')]), r = req(c, { url: 'https://{{host}}/x', auth: { ...emptyAuth('bearer'), token: 'literal-1' } })
    const s = setup({ collections: [c], requests: [r], environments: [e], active: e, schedules: [{ ...newSchedule(c.id, 'Nightly'), environmentId: e.id }] })
    expect((await good(s.run('set_environment_variables', { variables: { host: 'evil.example' } }))).warnings).toEqual(['Its sign-in would go to a new address: evil.example.', 'Used by 1 request.', 'The schedule “Nightly” sends this while Dispatch is open.'])
    expect((await good(s.run('set_environment_variables', { variables: { host: 'shop.test/{{tok}}' } }))).warnings).toContain('Uses {{tok}}, which is secret.')
  })
})
