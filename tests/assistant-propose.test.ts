/** From a model's edit call to a proposal: nothing written, no secret shown or lost, risks named. */
import { describe, expect, it, vi } from 'vitest'
import { cleaner } from '../src/core/assistant/clean'
import { newConnection } from '../src/core/assistant/connections'
import { ParameterBatches } from '../src/core/assistant/parameters'
import type { Proposal } from '../src/core/assistant/proposal'
import { propose, proposalOf, type ProposeContext } from '../src/core/assistant/propose'
import { allSecrets } from '../src/core/assistant/tools'
import type { McpServeOptions } from '../src/core/mcpHandler'
import { newSchedule, type Schedule } from '../src/core/schedules'
import type { Transport } from '../src/core/transport'
import { type Collection, defaultSettings, emptyAuth, emptyBody, type Folder, kv, newCollection, newEnvironment, newFolder, newRequest, type RequestDef } from '../src/core/types'

const secretVar = (k: string, v: string) => kv(k, v, true, { secret: true })
const P = { env: 'plant-env-AAAA1', auth: 'plant-auth-BBBB2', header: 'plant-header-CCCC3', body: 'plant-body-DDDD4', script: 'abcSECRET99', other: 'plant-other-EEEE5', key: 'plant-key-FFFF6', coll: 'plant-coll-GGGG7' }
const noSecrets = (x: unknown) => { const t = JSON.stringify(x); for (const s of Object.values(P)) expect(t).not.toContain(s) }
const transport: Transport = { label: 't', unrestricted: true, send: vi.fn(async () => { throw new Error('must not send') }) }
const col = (name: string, over: Partial<Collection> = {}): Collection => ({ ...newCollection(name), ...over })
const req = (name: string, c: Collection, over: Partial<RequestDef> = {}) => newRequest({ name, collectionId: c.id, url: 'https://shop.test/x', sort: 1, ...over })

interface W { collections?: Collection[]; folders?: Folder[]; requests?: RequestDef[]; schedules?: Schedule[]; unsaved?: string[]; environments?: ReturnType<typeof newEnvironment>[]; active?: ReturnType<typeof newEnvironment>; globals?: ReturnType<typeof kv>[]; space?: string; secrets?: string[] }
const setup = (o: W = {}) => {
  const ws = { source: 'dispatch' as const, collections: o.collections ?? [], folders: o.folders ?? [], requests: o.requests ?? [], environments: o.environments ?? [], flows: [], warnings: [] }
  const world: McpServeOptions = { ws, environment: o.active ?? null, globals: o.globals ?? [], settings: { ...defaultSettings, activeSpaceId: o.space ?? 'default' }, transport, pipeline: {}, allowMethods: [], version: 't', allCollections: true }
  const conn = { ...newConnection('compatible'), name: 'Mine', model: 'm', tools: 'yes' as const, readLogs: false, key: P.key }
  const ctx: ProposeContext = {
    world: () => world, conn, signal: new AbortController().signal, spaceId: o.space ?? 'default',
    secrets: () => [...(o.secrets ?? []), ...allSecrets({ environments: ws.environments, globals: world.globals, collections: ws.collections, folders: ws.folders, requests: ws.requests, connections: [conn], signIns: [], cookies: [], clientCerts: [] })],
    batches: new ParameterBatches(),
    unsaved: (id) => (o.unsaved ?? []).includes(id), schedules: async () => o.schedules ?? [],
  }
  return { world, ctx, run: (name: string, input: Record<string, unknown>) => propose(name, input, ctx) }
}
const good = async (p: ReturnType<typeof propose>): Promise<Proposal> => { const r = await p; if ('refused' in r) throw new Error(r.refused); return r }
const refused = async (p: ReturnType<typeof propose>): Promise<string> => { const r = await p; if (!('refused' in r)) throw new Error(`not refused: ${r.title}`); return r.refused }
const field = (p: Proposal, label: string) => p.fields.find((f) => f.label === label)
const added = (p: Proposal, label: string) => field(p, label)?.lines.filter((l) => l.type === 'add').map((l) => l.text)
const removed = (p: Proposal, label: string) => field(p, label)?.lines.filter((l) => l.type === 'del').map((l) => l.text)
const afterOf = <T,>(p: Proposal, i = 0) => p.changes[i].after as unknown as T
const card = (p: Proposal) => ({ ...p, changes: undefined })

const SCRIPT_RISK = 'Scripts run when this is sent. They can read variables, including secrets, and send requests.'
const SCHEDULED = 'The schedule “Nightly” sends this while Dispatch is open.'

describe('what each tool proposes', () => {
  const shop = col('Shop', { variables: [kv('base', 'https://shop.test'), kv('plain', 'old')] })
  const admin = newFolder(shop.id, 'Admin')
  const order = req('Create order', shop, { folderId: admin.id, scripts: { pre: '', post: 'one\ntwo' } })
  const make = (o: W = {}) => setup({ collections: [shop], folders: [admin], requests: [order], ...o })

  it('update_request: one change, the stored record before, the store untouched, the script drawn', async () => {
    const { run, world } = make()
    const was = structuredClone(world.ws)
    const p = await good(run('update_request', { name: 'Shop/Admin/Create order', testScript: 'one\nthree' }))
    expect(p).toMatchObject({ spaceId: 'default', tool: 'update_request', cls: 'edit', title: 'Change “Create order”' })
    expect(p.changes).toHaveLength(1)
    expect(p.changes[0]).toMatchObject({ kind: 'request', id: order.id })
    expect(p.changes[0].before).toEqual(order)
    expect(afterOf<RequestDef>(p)).toEqual({ ...order, scripts: { pre: '', post: 'one\nthree' }, updatedAt: expect.any(Number) })
    expect(p.fields.map((f) => f.label)).toEqual(['After-response script'])
    expect(field(p, 'After-response script')!.lines).toEqual([{ type: 'same', text: 'one' }, { type: 'del', text: 'two' }, { type: 'add', text: 'three' }])
    expect(world.ws).toEqual(was)
  })
  it('set_scripts on a folder', async () => {
    const p = await good(make().run('set_scripts', { path: 'Shop/Admin', preRequestScript: 'dx.vars.set("a", 1)' }))
    expect(p.changes).toMatchObject([{ kind: 'folder', id: admin.id, before: admin }])
    expect(added(p, 'Pre-request script')).toEqual(['dx.vars.set("a", 1)'])
  })
  it('set_variables sets, adds and removes', async () => {
    const p = await good(make().run('set_variables', { collection: 'Shop', variables: { base: 'https://new.test', extra: '1' }, remove: ['plain'] }))
    expect(p.changes).toMatchObject([{ kind: 'collection', id: shop.id, before: shop }])
    expect(afterOf<Collection>(p).variables.map((v) => [v.key, v.value])).toEqual([['base', 'https://new.test'], ['extra', '1']])
    expect(added(p, 'Variables')).toEqual(['base = https://new.test', 'extra = 1'])
    expect(removed(p, 'Variables')).toEqual(['base = https://shop.test', 'plain = old'])
  })
  it('keeps a variable’s alternatives in step with its value', async () => {
    const c = col('Shop', { variables: [kv('base', 'a', true, { options: [{ id: '1', name: 'lb', value: 'a' }, { id: '2', name: 'pod', value: 'b' }], active: 'lb' })] })
    const p = await good(setup({ collections: [c] }).run('set_variables', { collection: 'Shop', variables: { base: 'z' } }))
    expect(afterOf<Collection>(p).variables[0]).toMatchObject({ value: 'z', active: 'lb', options: [{ value: 'z' }, { value: 'b' }] })
  })
  it('a variable that isn’t named stays as it is, alternatives and all', async () => {
    const odd = kv('odd', 'new', true, { options: [{ id: '1', name: 'lb', value: 'a' }, { id: '2', name: 'pod', value: 'b' }], active: 'lb' })
    const c = col('Shop', { variables: [odd, kv('n', '1')] })
    const s = setup({ collections: [c], requests: [req('R', c)] })
    for (const [n, i] of [['set_scripts', { path: 'Shop', testScript: 'x' }], ['set_variables', { collection: 'Shop', variables: { n: '2' } }], ['copy_request', { from: 'R', to: 'Fresh' }]] as const) expect(afterOf<Collection>(await good(s.run(n, i as Record<string, unknown>))).variables[0]).toEqual(odd)
  })
  it('one row per entry, whatever is in it', async () => {
    const p = await good(make().run('set_variables', { collection: 'Shop', variables: { extra: '1\nbase = https://fake.test' } }))
    expect(added(p, 'Variables')).toEqual(['extra = 1\\u{A}base = https://fake.test'])
    const q = await good(make().run('update_request', { name: 'Create order', headers: { 'A\nB: 1': 'x\nC: 2' } }))
    expect(added(q, 'Headers')).toEqual(['A\\u{A}B: 1: x\\u{A}C: 2'])
    const a = req('A', shop, { auth: { ...emptyAuth('basic'), username: 'me\npassword: x' } })
    expect(removed(await good(make({ requests: [a] }).run('delete_request', { name: 'A' })), 'Auth')).toEqual(['basic', 'username: me\\u{A}password: x'])
  })
  it('create_request with a new collection and two folders: four creations', async () => {
    const p = await good(make().run('create_request', { folder: 'New/A/B', name: 'Ping', url: 'https://x.test', headers: { Accept: '*/*' } }))
    expect(p.changes.map((c) => [c.kind, c.before])).toEqual([['collection', null], ['folder', null], ['folder', null], ['request', null]])
    expect(afterOf<Collection>(p).workspaceId).toBe('default')
    expect(afterOf<RequestDef>(p, 3)).toMatchObject({ name: 'Ping', url: 'https://x.test', collectionId: p.changes[0].id, folderId: p.changes[2].id })
    expect(added(p, 'New collection')).toEqual(['New'])
    expect(p.fields.filter((f) => f.label === 'New folder').map((f) => f.lines[0].text)).toEqual(['New / A', 'New / A / B'])
    expect(added(p, 'URL')).toEqual(['https://x.test'])
  })
  it('delete_request: after null', async () => {
    const p = await good(make().run('delete_request', { name: 'Create order' }))
    expect(p).toMatchObject({ cls: 'delete', title: 'Delete “Create order”', changes: [{ kind: 'request', id: order.id, before: order, after: null }] })
    expect(removed(p, 'URL')).toEqual(['https://shop.test/x'])
  })
  it('move_request draws the new place, and to where it already is changes nothing', async () => {
    const p = await good(make().run('move_request', { name: 'Create order', to: 'Shop' }))
    expect(p.changes).toHaveLength(1)
    expect(afterOf<RequestDef>(p).folderId).toBeNull()
    expect([removed(p, 'In'), added(p, 'In')]).toEqual([['Shop / Admin'], ['Shop']])
    expect(await refused(make().run('move_request', { name: 'Create order', to: 'Shop/Admin' }))).toBe('This wouldn’t change anything. Nothing was changed.')
  })
  it('refuses what isn’t an edit, a stopped job and another open workspace', async () => {
    for (const n of ['get_request', 'send_request', 'made_up', 'constructor']) expect(await refused(make().run(n, {}))).toContain('no such tool')
    const { ctx } = make()
    expect(await refused(propose('delete_request', { name: 'Create order' }, { ...ctx, spaceId: 'x' }))).toContain('another workspace')
  })
  it('a body or fields given as they already are change nothing', async () => {
    const r = req('R', shop, { url: 'https://shop.test/x?a=1%202', params: [kv('a', '1 2'), kv('off', 'z', false)], headers: [kv('A', '1'), kv('B', '2', false)], body: { ...emptyBody('xml'), text: '<a/>' }, docs: 'd' })
    expect(await refused(setup({ collections: [shop], requests: [r] }).run('update_request', { name: 'R', newName: 'R', method: 'GET', url: r.url, headers: { A: '1', B: '2' }, body: '<a/>', docs: 'd', testScript: '' }))).toContain('wouldn’t change anything')
  })
  it('a URL given as it is leaves the params alone', async () => {
    const r = req('R', shop, { url: 'https://shop.test/x?a=1', params: [] })
    expect(await refused(setup({ collections: [shop], requests: [r] }).run('update_request', { name: 'R', url: r.url }))).toContain('wouldn’t change anything')
  })
  it('a header that is off stays off, and its other settings stay', async () => {
    const r = req('R', shop, { headers: [kv('A', '1'), kv('B', '2', false, { description: 'why' })] })
    const p = await good(setup({ collections: [shop], requests: [r] }).run('update_request', { name: 'R', headers: { A: '1', b: '3' } }))
    expect(afterOf<RequestDef>(p).headers).toEqual([r.headers[0], { ...r.headers[1], key: 'b', value: '3' }])
    expect(added(p, 'Headers')).toEqual(['(off) b: 3'])
  })
  it('bodyType alone shows the kind and the text it brings back', async () => {
    const r = req('R', shop, { body: { ...emptyBody('none'), text: 'stale' } })
    const p = await good(setup({ collections: [shop], requests: [r] }).run('update_request', { name: 'R', bodyType: 'json' }))
    expect(added(p, 'Body type')).toEqual(['json'])
    expect(added(p, 'Body')).toEqual(['stale'])
  })
  it('a changed URL keeps the params that are off and every path variable', async () => {
    const r = req('R', shop, { url: 'https://shop.test/:id?a=1', params: [kv('a', '1'), kv('off', 'z', false)], pathVars: [kv('id', '7')] })
    const a = afterOf<RequestDef>(await good(setup({ collections: [shop], requests: [r] }).run('update_request', { name: 'R', url: 'https://shop.test/:key?b=2' })))
    expect(a.pathVars).toEqual(r.pathVars)
    expect(a.params.map((p) => [p.key, p.value, p.enabled])).toEqual([['b', '2', true], ['off', 'z', false]])
  })
})

describe('secrets aren’t shown', () => {
  const far = col('Far', { workspaceId: 'other', variables: [secretVar('t', P.other)] })
  const env = { ...newEnvironment('Env'), variables: [secretVar('token', P.env), secretVar('s', P.script)] }
  const shop = col(`Shop ${P.env}`, { auth: { ...emptyAuth('bearer'), token: P.auth }, variables: [secretVar('cv', P.coll), kv(`k-${P.env}`, 'fine')] })
  const full = req('Full', shop, {
    url: `https://shop.test/${P.other}`, headers: [kv('X-Api-Key', P.header), kv('X-Plain', P.env)], auth: { ...emptyAuth('basic'), username: 'me', password: P.auth },
    body: { ...emptyBody('json'), text: `{"password":"${P.body}"}` }, scripts: { pre: `const k = '${P.script}'`, post: `// ${P.key}` }, docs: P.env, pathVars: [kv('token', P.body)],
  })
  const bearer = req('Short', shop, { auth: { ...emptyAuth('basic'), username: 'me', password: '4821' } })
  const plain = req('Plain', shop)
  const make = (o: W = {}) => setup({ collections: [shop, far], requests: [full, bearer, plain, req('Far one', far)], environments: [env], active: env, secrets: [P.body], ...o })
  const at = 'Shop <hidden>'

  it.each<[string, Record<string, unknown>]>([
    ['delete_request', { name: `${at}/Full` }], ['copy_request', { from: 'Full', to: at, name: 'Two' }], ['copy_request', { from: 'Full', to: 'Fresh/Folder' }], ['move_request', { name: 'Full', to: 'Fresh' }],
    ['update_request', { name: 'Full', method: 'POST' }], ['update_request', { name: 'Full', headers: { 'X-Api-Key': '{{token}}', 'X-Plain': '{{x}}', New: '1' } }],
    ['set_variables', { collection: at, variables: { a: 'b' } }], ['set_scripts', { path: at, testScript: 'x' }], ['create_request', { folder: at, name: 'N', url: 'https://evil.example' }],
  ])('%s %j', async (name, input) => {
    noSecrets(card(await good(make().run(name, input))))
  })
  it('copy_request keeps the auth it hides', async () => {
    const p = await good(make().run('copy_request', { from: 'Full', to: 'Fresh' }))
    const c = afterOf<RequestDef>(p, 1)
    expect(c.auth).toEqual(full.auth)
    expect(c.headers).toEqual(full.headers)
    expect(c.scripts).toEqual(full.scripts)
    expect(added(p, 'Auth')).toEqual(['basic', 'username: me', 'password: <hidden>'])
    // the new collection's variables are the real ones, names too
    expect(afterOf<Collection>(p).variables).toEqual(shop.variables)
  })
  it('a second, hidden header of the same name stays hidden', async () => {
    const r = req('Twice', shop, { headers: [kv('X-Api-Key', P.header), kv('x-api-key', P.body)] })
    const p = await good(make({ requests: [r] }).run('update_request', { name: 'Twice', headers: { 'X-Api-Key': '{{k}}' } }))
    expect(afterOf<RequestDef>(p).headers.map((h) => h.value)).toEqual(['{{k}}', P.body])
    noSecrets(card(p))
  })
  it('a field the tool doesn’t take shows nothing more', async () => {
    noSecrets(card(await good(make().run('copy_request', { from: 'Full', to: 'Fresh', url: 'x', body: 'x', docs: 'x', testScript: 'x', preRequestScript: 'x', newName: 'x', headers: { 'X-Plain': P.env.slice(0, 5) } }))))
  })
  it('the reply is cleaned, whatever the model put in it, and a folder keeps its real name', async () => {
    const f = newFolder(shop.id, `F ${P.env}`)
    const s = make({ folders: [f] })
    noSecrets((await good(s.run('create_request', { folder: at, name: P.env, url: 'https://x.test' }))).reply)
    expect(afterOf<Folder>(await good(s.run('set_scripts', { path: `${at}/F <hidden>`, testScript: 'x' }))).name).toBe(f.name)
  })
  it('hides a short password too', async () => {
    expect(JSON.stringify(card(await good(make().run('delete_request', { name: 'Short' }))))).not.toContain('4821')
  })
  it.each<[string, Record<string, unknown>]>([
    ['update_request', { name: `Shop ${P.env}/Plain`, method: 'PUT' }], ['update_request', { name: 'Full', url: 'x' }], ['update_request', { name: 'Full', body: '{}' }], ['update_request', { name: 'Full', testScript: '' }],
    ['update_request', { name: 'Full', headers: { A: '1' } }], ['update_request', { name: 'Full', docs: '' }], ['copy_request', { from: 'Plain', to: at }], ['set_variables', { collection: at, remove: ['cv'] }],
    ['set_variables', { collection: `Shop ${P.env}`, variables: { a: 'b' } }], ['set_scripts', { path: `${at}/None`, testScript: 'x' }],
  ])('nor in the refusal of %s %j', async (name, input) => { noSecrets(await refused(make().run(name, input))) })
  it('another workspace’s request and collection aren’t there', async () => {
    expect(await refused(make().run('update_request', { name: 'Far/Far one', method: 'PUT' }))).toContain('No request')
    expect(await refused(make().run('delete_request', { name: 'Far one' }))).toContain('No request')
    expect(await refused(make().run('set_variables', { collection: 'Far', variables: { a: 'b' } }))).toContain('No collection')
    const p = await good(make().run('create_request', { folder: 'Far', name: 'N', url: 'https://x.test' }))
    expect(p.changes[0]).toMatchObject({ kind: 'collection', before: null, after: { workspaceId: 'default' } })
  })
  it('a name that holds a secret is found by its cleaned form only, and is kept', async () => {
    const r = req(`Get ${P.env}`, shop, { handoff: { note: 'n', from: 'x', at: 1, variables: [secretVar('h', 'zz')] } })
    const s = make({ requests: [r] })
    expect(await refused(s.run('update_request', { name: r.name, method: 'PUT' }))).toContain('No request')
    const p = await good(s.run('update_request', { name: `${at}/Get <hidden>`, method: 'PUT' }))
    expect(p.changes[0].before).toEqual(r)
    expect(afterOf<RequestDef>(p)).toEqual({ ...r, method: 'PUT', updatedAt: expect.any(Number) })
    expect(p.title).toBe('Change “Get <hidden>”')
    for (const [n, i] of [['move_request', { name: 'Get <hidden>', to: 'Fresh' }], ['copy_request', { from: 'Get <hidden>', to: 'Fresh' }]] as const) expect(afterOf<RequestDef>(await good(s.run(n, i)), 1).name).toBe(r.name)
    expect(afterOf<Collection>(await good(s.run('set_scripts', { path: at, testScript: 'x' })))).toEqual({ ...shop, scripts: { pre: '', post: 'x' }, updatedAt: expect.any(Number) })
    expect(afterOf<Collection>(await good(s.run('set_variables', { collection: at, variables: { a: 'b' } }))).variables.slice(0, 2)).toEqual(shop.variables)
  })
  it('names of variables with the same id, as copies have them, each come back as they are', async () => {
    const a = col('A', { variables: [{ ...kv(`a-${P.env}`, '1'), id: 'same' }, { ...kv(`b-${P.env}`, '2'), id: 'same' }] })
    const b = col('B', { variables: [{ ...kv(`a-${P.coll}`, '3'), id: 'same' }] })
    for (const list of [[a, b], [b, a]]) {
      const s = setup({ collections: list, requests: [req('In a', a), req('In b', b)], secrets: [P.env, P.coll] })
      for (const c of [a, b]) {
        expect(afterOf<Collection>(await good(s.run('set_scripts', { path: c.name, testScript: 'x' }))).variables).toEqual(c.variables)
        expect(afterOf<Collection>(await good(s.run('copy_request', { from: `In ${c.name.toLowerCase()}`, to: 'Fresh' }))).variables).toEqual(c.variables)
      }
    }
  })
  it('the redacted text is never written', async () => {
    for (const [n, i] of [
      ['update_request', { name: 'Plain', newName: 'Get <hidden>' }], ['update_request', { name: 'Plain', docs: '<hidden>' }], ['move_request', { name: 'Plain', to: at, newName: '<hidden>' }], ['copy_request', { from: 'Plain', to: 'Fresh', name: '<hidden>' }],
      ['create_request', { folder: 'New <hidden>', name: 'n', url: 'https://x.test' }], ['create_request', { folder: `${at}/<hidden>`, name: 'n', url: 'https://x.test' }], ['create_request', { folder: at, name: '<hidden>', url: 'https://x.test' }],
      ['set_variables', { collection: at, variables: { '<hidden>': 'x' } }], ['set_variables', { collection: at, remove: ['k-<hidden>'] }],
    ] as const) expect(await refused(make().run(n, i as Record<string, unknown>))).toContain('<hidden> stands for a secret')
  })
})

describe('a value that wasn’t shown can’t be replaced or removed', () => {
  const shop = col('Shop', { variables: [secretVar('pin', '4821'), kv('password', 'longer-value'), kv('note', 'plain'), kv(' spaced ', 'v', true, { secret: true }), secretVar('empty', '')], scripts: { pre: "const k = 'abcSECRET99'", post: '' } })
  const r = req('R', shop, { scripts: { pre: "const k = 'abcSECRET99'", post: 'fine' }, headers: [kv('X-Trace', 'abcSECRET99'), kv('X-Api-Key', 'k1'), kv('Plain', 'p')], docs: 'see abcSECRET99', url: 'https://shop.test/a' })
  const u = req('U', shop, { url: 'https://me:4821@shop.test/a' })
  const b = req('B', shop, { body: { ...emptyBody('urlencoded'), fields: [kv('f', 'abcSECRET99')] } })
  const t = req('T', shop, { body: { ...emptyBody('json'), text: 'abcSECRET99' } })
  const { run } = setup({ collections: [shop], requests: [r, u, b, t], secrets: ['abcSECRET99'] })
  const HELD = 'holds a secret you weren’t shown'

  it('a script that holds a known secret: rewriting it is refused, editing the URL isn’t', async () => {
    expect(await refused(run('update_request', { name: 'R', preRequestScript: 'const k = 1' }))).toContain(HELD)
    expect(await refused(run('set_scripts', { path: 'Shop', preRequestScript: '' }))).toContain(HELD)
    expect(afterOf<RequestDef>(await good(run('update_request', { name: 'R', url: 'https://shop.test/b' }))).scripts).toEqual(r.scripts)
    await good(run('update_request', { name: 'R', testScript: 'other' }))
    await good(run('set_scripts', { path: 'Shop', testScript: 'other' }))
  })
  it('headers: only a lone variable may replace it, and leaving it out doesn’t remove it', async () => {
    expect(await refused(run('update_request', { name: 'R', headers: { 'X-Trace': 'x', Plain: 'p' } }))).toContain(HELD)
    expect(await refused(run('update_request', { name: 'R', headers: { 'X-Trace': 'a{{x}}', Plain: 'p' } }))).toContain(HELD)
    expect(await refused(run('update_request', { name: 'R', headers: { 'X-Trace': '{{a}}', 'X-Api-Key': 'k1' } }))).toContain(HELD)
    expect(await refused(run('update_request', { name: 'R', headers: { Plain: 'p' } }))).toContain(HELD)
    const p = await good(run('update_request', { name: 'R', headers: { 'X-Trace': '{{a}}', Plain: 'q' } }))
    expect(afterOf<RequestDef>(p).headers.map((h) => [h.key, h.value])).toEqual([['X-Trace', '{{a}}'], ['X-Api-Key', 'k1'], ['Plain', 'q']])
    expect(removed(p, 'Headers')).toEqual(['X-Trace: <hidden>', 'Plain: p'])
  })
  it('body, docs and the URL', async () => {
    for (const i of [{ name: 'B', body: 'x' }, { name: 'B', bodyType: 'json' }, { name: 'T', body: 'x' }, { name: 'R', docs: '' }, { name: 'U', url: 'https://shop.test' }]) expect(await refused(run('update_request', i))).toContain(HELD)
  })
  it('a guess gets the same answer, right or wrong', async () => {
    for (const [n, right, wrong] of [
      ['update_request', { name: 'U', url: u.url }, { name: 'U', url: 'https://me:0000@shop.test/a' }], ['update_request', { name: 'R', docs: r.docs }, { name: 'R', docs: 'x' }],
      ['update_request', { name: 'T', body: 'abcSECRET99' }, { name: 'T', body: 'x' }], ['update_request', { name: 'R', headers: { 'X-Api-Key': 'k1' } }, { name: 'R', headers: { 'X-Api-Key': 'k2' } }],
      ['set_variables', { collection: 'Shop', variables: { pin: '4821' } }, { collection: 'Shop', variables: { pin: '0000' } }], ['set_scripts', { path: 'Shop', preRequestScript: shop.scripts.pre }, { path: 'Shop', preRequestScript: 'x' }],
    ] as const) expect(await refused(run(n, right as Record<string, unknown>))).toBe(await refused(run(n, wrong as Record<string, unknown>)))
  })
  it('secret variables, short and empty ones too', async () => {
    for (const k of ['pin', 'password', 'empty', 'spaced', ' spaced ']) {
      expect(await refused(run('set_variables', { collection: 'Shop', variables: { [k]: 'x' } }))).toContain('secret')
      expect(await refused(run('set_variables', { collection: 'Shop', remove: [k] }))).toContain('secret')
    }
    expect(await refused(run('set_variables', { collection: 'Shop', variables: { 'pin ': 'x' } }))).toContain('Nothing was changed.')
    expect(await refused(run('set_variables', { collection: 'Shop', variables: { note: 'x' }, remove: ['note'] }))).toContain('Nothing was changed.')
    await good(run('set_variables', { collection: 'Shop', variables: { note: 'x' } }))
  })
  it('a move that would drop a sign-in kept on the request', async () => {
    const c = col('C', { auth: { ...emptyAuth('bearer'), token: 'x1' } })
    const s = req('S', c, { auth: { ...emptyAuth('inherit'), token: '4821' } })
    expect(await refused(setup({ collections: [c, shop], requests: [s] }).run('move_request', { name: 'S', to: 'Shop' }))).toContain(HELD)
  })
})

describe('only the open workspace', () => {
  const shop = col('Shop')
  const r = req('R', shop)
  it('assistant/ paths make nothing', async () => {
    const { run } = setup({ collections: [shop], requests: [r] })
    for (const p of ['assistant/New/x', 'assistant', '/assistant/New', 'assistant/']) {
      for (const [n, i] of [['create_request', { folder: p, name: 'n', url: 'https://x.test' }], ['copy_request', { from: 'R', to: p }], ['move_request', { name: 'R', to: p }]] as const) expect(await refused(run(n, i as Record<string, unknown>))).toContain('Nothing was changed.')
    }
    for (const n of ['set_variables', 'set_scripts']) expect(await refused(run(n, { collection: 'assistant/Shop', path: 'assistant/Shop', variables: { a: 'b' }, testScript: 'x' }))).toContain('Nothing was changed.')
  })
  it('a collection really named “assistant” is reached, but nothing new is made through it', async () => {
    const a = col('assistant'), f = newFolder(a.id, 'Old')
    const { run } = setup({ collections: [a], folders: [f], requests: [req('R', a)] })
    expect((await good(run('create_request', { folder: 'assistant/Old/Sub', name: 'n', url: 'https://x.test' }))).changes.map((c) => c.kind)).toEqual(['folder', 'request'])
    expect(await refused(run('create_request', { folder: 'assistant/New/x', name: 'n', url: 'https://x.test' }))).toContain('Nothing was changed.')
    await good(run('set_scripts', { path: 'assistant', testScript: 'x' }))
  })
  it('the assistant’s own workspace, when open, is like any other', async () => {
    const c = col('Inbox', { workspaceId: 'assistant' })
    const { run } = setup({ space: 'assistant', collections: [c, shop], requests: [req('One', c), r] })
    const p = await good(run('create_request', { folder: 'New', name: 'n', url: 'https://x.test' }))
    expect(afterOf<Collection>(p).workspaceId).toBe('assistant')
    expect(p.reply).not.toContain('assistant/')
    expect((await good(run('set_variables', { collection: 'Inbox', variables: { a: 'b' } }))).changes[0].before).toEqual(c)
    expect(await refused(run('create_request', { folder: 'assistant/New/x', name: 'n', url: 'https://x.test' }))).toContain('Nothing was changed.')
    expect(await refused(run('delete_request', { name: 'R' }))).toContain('No request')
  })
  it('refuses when a path means more than one thing', async () => {
    const a = col('Key abcSECRET99'), b = col('Key xyzSECRET11'), f1 = newFolder(shop.id, 'F'), f2 = newFolder(shop.id, 'F')
    const { run } = setup({ collections: [a, b, shop], folders: [f1, f2], requests: [req('One', a), req('One', b), req('Same', shop), req('Same', shop)], secrets: ['abcSECRET99', 'xyzSECRET11'] })
    for (const [n, i] of [
      ['set_variables', { collection: 'Key <hidden>', variables: { a: 'b' } }], ['set_scripts', { path: 'Key <hidden>', testScript: 'x' }], ['create_request', { folder: 'Key <hidden>', name: 'n', url: 'x' }], ['create_request', { folder: 'Shop/F', name: 'n', url: 'x' }],
      ['set_scripts', { path: 'Shop/F', testScript: 'x' }], ['delete_request', { name: 'Key <hidden>/One' }], ['delete_request', { name: 'One' }], ['delete_request', { name: 'Shop/Same' }],
    ] as const) expect(await refused(run(n, i as Record<string, unknown>))).toMatch(/more than one|Several requests/)
  })
  it('Review Focus 2: unsaved edits are refused, for copying from it too', async () => {
    const o = req('Create order', shop)
    const { run } = setup({ collections: [shop], requests: [o], unsaved: [o.id] })
    for (const [n, i] of [['update_request', { name: 'Create order', method: 'PUT' }], ['move_request', { name: 'Create order', to: 'X' }], ['delete_request', { name: 'Create order' }], ['copy_request', { from: 'Create order', to: 'X' }]] as const) {
      expect(await refused(run(n, i))).toBe('Save or discard your changes to “Create order” first. Nothing was changed.')
    }
    await good(run('set_scripts', { path: 'Shop', testScript: 'x' }))
  })
})

describe('what the card warns of', () => {
  const env = { ...newEnvironment('Env'), variables: [kv('base', 'https://shop.test'), secretVar('token', 'tok-abcdef')] }
  const shop = col('Shop', { auth: { ...emptyAuth('bearer'), token: '{{token}}' }, variables: [kv('host', 'shop.test'), kv('idp', 'https://idp.test')] })
  const free = col('Free')
  const admin = newFolder(shop.id, 'Admin')
  const deep = newFolder(shop.id, 'Deep', admin.id)
  const one = req('One', shop, { url: '{{base}}/one', folderId: admin.id })
  const make = (o: W = {}) => setup({ collections: [shop, free], folders: [admin, deep], requests: [one], environments: [env], active: env, ...o })
  const warns = async (name: string, input: Record<string, unknown>, o: W = {}) => (await good(make(o).run(name, input))).warnings
  const NEW = (h: string) => `Its sign-in would go to a new address: ${h}.`
  const USES = 'Uses {{token}}, which is secret.'

  it('scripts', async () => {
    expect(await warns('update_request', { name: 'One', testScript: 'x' })).toEqual([SCRIPT_RISK])
    expect(await warns('update_request', { name: 'One', method: 'PUT' })).toEqual([])
    expect(await warns('create_request', { folder: 'Free', name: 'n', url: 'https://x.test', preRequestScript: 'x' })).toEqual([SCRIPT_RISK])
    const many = Array.from({ length: 12 }, (_, i) => req(`r${i}`, shop, { folderId: i % 2 ? deep.id : admin.id }))
    expect(await warns('set_scripts', { path: 'Shop/Admin', testScript: 'x' }, { requests: many })).toEqual([SCRIPT_RISK, 'Runs for 12 requests.'])
    expect(await warns('set_scripts', { path: 'Shop', testScript: 'x' })).toEqual([SCRIPT_RISK, 'Runs for 1 request.'])
  })
  it('a new host under auth, inherited too; not the same host written another way', async () => {
    expect(await warns('update_request', { name: 'One', url: 'https://evil.example/one' })).toEqual([NEW('evil.example')])
    expect(await warns('update_request', { name: 'One', url: 'https://shop.test/two' })).toEqual([])
    expect(await warns('update_request', { name: 'One', url: 'https://shop.test@evil.example/' })).toEqual([NEW('evil.example')])
    expect(await warns('update_request', { name: 'One', url: 'https://evil.example\\@shop.test/' })).toEqual([NEW('evil.example')])
    expect(await warns('update_request', { name: 'One', url: 'http://shop.test/one' })).toEqual([NEW('http://shop.test')])
    expect(await warns('update_request', { name: 'One', url: '{{nowhere}}/one' })).toEqual([NEW('{{nowhere}}')])
    expect(await warns('update_request', { name: 'One', url: 'https://{{host}}/one' })).toEqual([])
    const plain = req('Plain', free)
    expect(await warns('update_request', { name: 'Plain', url: 'https://evil.example' }, { requests: [plain] })).toEqual([])
  })
  it('a new host under a secret that is no sign-in of Dispatch', async () => {
    for (const r of [req('K', free, { headers: [kv('X-Api-Key', 'k')] }), req('K', free, { headers: [kv('X', '{{token}}')] }), req('K', free, { pathVars: [kv('token', 'zz')] })]) {
      expect(await warns('update_request', { name: 'K', url: 'https://evil.example' }, { requests: [r] })).toEqual([NEW('evil.example')])
    }
  })
  it('a variable made of itself doesn’t hang it', async () => {
    const r = req('V', shop, { url: 'https://{{host}}/x' })
    expect((await good(make({ requests: [r] }).run('set_variables', { collection: 'Shop', variables: { host: '{{host}}'.repeat(1000) } }))).warnings.length).toBeGreaterThan(0)
  })
  it('a variable that moves the host, also in an environment that isn’t active', async () => {
    const r = req('V', shop, { url: 'https://{{host}}/x' })
    expect(await warns('set_variables', { collection: 'Shop', variables: { host: 'evil.example' } }, { requests: [r] })).toEqual([NEW('evil.example'), 'Used by 1 request.'])
    const covered = { ...env, variables: [...env.variables, kv('host', 'shop.test')] }
    expect(await warns('set_variables', { collection: 'Shop', variables: { host: 'evil.example' } }, { requests: [r], environments: [covered, newEnvironment('Other')], active: covered })).toContain(NEW('evil.example'))
    const o = req('O', shop, { url: 'https://shop.test', auth: { ...emptyAuth('oauth2'), tokenUrl: '{{idp}}/token', clientSecret: 'cs' } })
    expect(await warns('set_variables', { collection: 'Shop', variables: { idp: 'https://evil.example' } }, { requests: [o] })).toContain(NEW('evil.example'))
  })
  it('a new request under a sign-in: only an address it doesn’t go to yet', async () => {
    expect(await warns('create_request', { folder: 'Shop', name: 'n', url: '{{base}}/n' })).toEqual([USES])
    expect(await warns('create_request', { folder: 'Shop', name: 'n', url: 'https://evil.example' })).toEqual([NEW('evil.example'), USES])
    // another request going there without this sign-in doesn't count
    expect(await warns('create_request', { folder: 'Shop', name: 'n', url: 'https://else.test' }, { requests: [one, req('Else', free, { url: 'https://else.test' })] })).toContain(NEW('else.test'))
  })
  it('shows no part of a secret in an address, however the URL changes it', async () => {
    const vars = [secretVar('tok', 'Tok-ABCDEF99'), secretVar('pin', '4821'), secretVar('slash', 'abcSECRET/xyz99'), secretVar('enc', 'a%62cDEF9'), kv('via', '{{tok}}'), kv('password', 'PWabc1')]
    const c = { ...shop, variables: [...shop.variables, ...vars] }
    for (const [url, host] of [
      ['https://{{tok}}.evil.example/', '{{tok}}.evil.example'], ['https://{{pin}}.evil.example/', '{{pin}}.evil.example'], ['https://{{slash}}', '{{slash}}'], ['https://{{enc}}.evil.example', '{{enc}}.evil.example'],
      ['https://{{via}}.evil.example', '{{tok}}.evil.example'], ['https://{{password}}.evil.example', '{{password}}.evil.example'], ['https://me:{{nope}}4821@{{pin}}.evil.example', '{{pin}}.evil.example'], ['http://{{pin}}.shop.test', '{{pin}}.shop.test'],
    ]) {
      const w = await warns('update_request', { name: 'One', url }, { collections: [c, free] })
      expect(w[0]).toBe(NEW(host))
      expect(JSON.stringify(w).toLowerCase()).not.toMatch(/tok-abc|4821|abcsecret|xyz99|cdef9|pwabc1/)
    }
    expect((await warns('update_request', { name: 'One', url: 'https://Tok-ABCDEF99.evil.example/' }, { collections: [c, free] }))[0]).toBe(NEW('<hidden>.evil.example'))
    // only the scheme moved: the named address is built from the shown form too
    const q = req('Q', c, { url: 'https://{{pin}}.shop.test' })
    expect((await warns('update_request', { name: 'Q', url: 'http://{{pin}}.shop.test' }, { collections: [c, free], requests: [q] }))[0]).toBe(NEW('http://{{pin}}.shop.test'))
  })
  it('a secret it uses already, put in another place', async () => {
    expect(await warns('update_request', { name: 'One', url: '{{base}}/one?x={{token}}' })).toEqual([USES])
    expect(await warns('update_request', { name: 'One', headers: { X: '{{token}}' } })).toEqual([USES])
    const o = req('O', free, { auth: { ...emptyAuth('oauth2'), clientSecret: '{{token}}' } })
    expect(await warns('update_request', { name: 'O', body: '{{token}}' }, { requests: [o] })).toEqual([USES])
    const b = req('B', free, { body: { ...emptyBody('text'), text: '{{token}}' } })
    expect(await warns('update_request', { name: 'B', body: 'again {{token}}' }, { requests: [b] })).toEqual([])
  })
  it('a host that is new only in another environment', async () => {
    const c = { ...shop, variables: [kv('h', 'shop.test')] }, r = req('R', c, { url: 'https://shop.test/a' })
    const other = { ...newEnvironment('P'), variables: [kv('h', 'evil.example')] }
    const o = { collections: [c, free], requests: [r], environments: [env, other] }
    expect(await warns('update_request', { name: 'R', url: 'https://{{h}}/a' }, o)).toEqual([NEW('evil.example')])
    expect(await warns('create_request', { folder: 'Shop', name: 'n', url: 'https://{{h}}/a' }, o)).toContain(NEW('evil.example'))
    // the active one's first
    const active = { ...env, variables: [...env.variables, kv('h', 'first.example')] }
    expect(await warns('update_request', { name: 'R', url: 'https://{{h}}/a' }, { ...o, environments: [other, active], active })).toEqual([NEW('first.example'), NEW('evil.example')])
    // an environment that doesn't have the variable sends nothing
    expect(await warns('update_request', { name: 'R', url: '{{base}}/a' }, o)).toEqual([])
  })
  describe('an address that isn’t all known is still an address', () => {
    const envP = (...vars: ReturnType<typeof kv>[]) => ({ ...newEnvironment('P'), variables: vars })
    it.each(['{{$guid}}.evil.example', '{{$randomInt}}.evil.example', '{{$timestamp}}.evil.example', '{{q}}.evil.example', '{{q}}evil.example', '{{a b}}.evil.example', '{{$randomDomainName}}', '{{constructor}}', '{{q}}{{z}}', '{{q}}:8080'])('a variable set to %s, in the active environment and outside it', async (h) => {
      const r = req('V', shop, { url: 'https://{{host}}/x' })
      const covered = { ...env, variables: [...env.variables, kv('host', 'shop.test')] }
      for (const o of [{}, { environments: [covered], active: covered }]) expect(await warns('set_variables', { collection: 'Shop', variables: { host: h } }, { requests: [r], ...o })).toContain(NEW(h))
    })
    it('userinfo is not the host, and may hide one', async () => {
      const r = req('V', shop, { url: 'https://{{host}}/x' })
      const covered = { ...env, variables: [...env.variables, kv('host', 'shop.test')] }
      for (const h of ['{{q}}@evil.example', '{{$guid}}:x@evil.example', 'me:pw@evil.example']) expect(await warns('set_variables', { collection: 'Shop', variables: { host: h } }, { requests: [r], environments: [covered], active: covered })).toContain(NEW('evil.example'))
      expect(await warns('update_request', { name: 'One', url: 'https://{{q}}@shop.test/one' })).toContain(NEW('https://shop.test')) // what {{q}} holds can end the host
    })
    it('a URL that leads to a dynamic name in another environment', async () => {
      const p = envP(kv('z', '{{$guid}}.evil.example'))
      expect(await warns('update_request', { name: 'One', url: 'https://{{z}}/a' }, { environments: [env, p] })).toContain(NEW('{{$guid}}.evil.example'))
    })
    const oauth = (over: object) => ({ ...emptyAuth('oauth2'), clientSecret: '{{token}}', ...over })
    it('a token URL that isn’t known excuses nothing else', async () => {
      const o = req('O', free, { url: 'https://{{h}}/a', auth: oauth({ tokenUrl: 'https://{{idp}}/t' }) })
      const e = { ...env, variables: [env.variables[1], kv('h', 'dev.test'), kv('idp', 'idp.test')] }, p = envP(kv('h', 'prod.test'))
      expect(await warns('update_request', { name: 'O', url: 'https://dev.test/a' }, { requests: [o], environments: [e, p], active: e })).toEqual([NEW('dev.test')])
      // nor does the one's address count for the other
      expect(await warns('update_request', { name: 'O', url: 'https://idp.test/a' }, { requests: [o], environments: [e], active: e })).toContain(NEW('idp.test'))
    })
    it.each([['{{$guid}}.evil.example', '{{$guid}}.evil.example'], ['{{q}}@evil.example', 'evil.example'], ['{{q}}.evil.example', '{{q}}.evil.example'], ['me@evil.example', 'evil.example']])('a token or sign-in URL moved to %s', async (idp, host) => {
      for (const field of ['tokenUrl', 'authUrl']) {
        const o = req('O', shop, { auth: oauth({ [field]: 'https://{{idp}}/t' }) })
        const covered = { ...env, variables: [...env.variables, kv('idp', 'idp.test')] }
        for (const x of [{}, { environments: [covered], active: covered }]) expect(await warns('set_variables', { collection: 'Shop', variables: { idp } }, { requests: [o], ...x })).toContain(NEW(host))
      }
    })
    it('an address known in full hides none that isn’t, the active one’s first', async () => {
      const e = { ...env, variables: [...env.variables, kv('h', '{{$guid}}.evil.example')] }
      expect(await warns('update_request', { name: 'One', url: 'https://{{h}}/a' }, { environments: [envP(kv('h', 'ok.example')), e], active: e })).toEqual([NEW('{{$guid}}.evil.example'), NEW('ok.example')])
      expect(await warns('update_request', { name: 'One', url: 'https://{{h}}/a' }, { environments: [env, envP(kv('h', 'ok.example'))] })).toEqual([NEW('{{h}}'), NEW('ok.example')])
      expect(await warns('update_request', { name: 'One', url: 'https://{{h}}/a' }, { environments: [envP(kv('h', '{{q}}.lit.example')), { ...newEnvironment('Q'), variables: [kv('h', 'ok.example')] }, e], active: e })).toEqual(['{{$guid}}.evil.example', '{{q}}.lit.example', 'ok.example'].map(NEW))
    })
  })
  it('scripts of the place a request is moved or copied into', async () => {
    const f = { ...newFolder(free.id, 'S'), scripts: { pre: 'x', post: '' } }
    const c = col('Runs', { scripts: { pre: '', post: 'y' } })
    const r = req('R', free), inside = req('In', free, { folderId: f.id })
    const o = { collections: [shop, free, c], folders: [f], requests: [r, inside] }
    for (const to of ['Free/S', 'Runs']) {
      expect(await warns('move_request', { name: 'R', to }, o)).toEqual([SCRIPT_RISK])
      expect(await warns('copy_request', { from: 'R', to, name: 'Two' }, o)).toEqual([SCRIPT_RISK])
    }
    expect(await warns('copy_request', { from: 'In', to: 'Free/S', name: 'Two' }, o)).toEqual([])
    expect(await warns('move_request', { name: 'In', to: 'Free' }, o)).toEqual([])
  })
  it('a move that gives it another sign-in', async () => {
    const f = req('F', free, { auth: emptyAuth('inherit') })
    const open = { ...free, auth: emptyAuth('inherit') }
    expect(await warns('move_request', { name: 'F', to: 'Shop' }, { collections: [shop, open], requests: [f] })).toEqual([NEW('shop.test'), USES])
    // what it inherited comes along, so nothing new
    expect(await warns('move_request', { name: 'One', to: 'Free' })).toEqual([])
    // the same {{token}} is another secret there
    const two = col('Two', { variables: [secretVar('token', 'other-token-1')] })
    expect(await warns('move_request', { name: 'One', to: 'Two' }, { collections: [shop, two] })).toContain(USES)
  })
  it('a newly used secret variable, also through another variable', async () => {
    const r = req('P', free)
    expect(await warns('update_request', { name: 'P', url: 'https://shop.test/x?t={{token}}' }, { requests: [r] })).toEqual([USES])
    expect(await warns('update_request', { name: 'P', body: '{"t":"{{ token }}"}' }, { requests: [r] })).toEqual([USES])
    expect(await warns('update_request', { name: 'One', body: '{{token}}' })).toEqual([USES]) // its sign-in uses it, its body didn't
    const v = req('V', free, { url: 'https://shop.test/{{x}}' }), c = { ...free, variables: [kv('x', '1')] }
    expect(await warns('set_variables', { collection: 'Free', variables: { x: '{{token}}' } }, { collections: [c], requests: [v] })).toEqual([USES, 'Used by 1 request.'])
    expect(await warns('set_variables', { collection: 'Free', variables: { y: '{{token}}' } })).toEqual([USES])
    // a secret of an environment that isn't active counts
    expect(await warns('update_request', { name: 'P', docs: 'x', url: 'https://shop.test/{{token}}' }, { requests: [r], active: undefined })).toEqual([USES])
  })
  it('how many requests a changed variable reaches', async () => {
    const rs = [...Array.from({ length: 5 }, (_, i) => req(`h${i}`, shop, { headers: [kv('X', '{{ host }}')], url: 'https://shop.test' })), req('not', shop), req('elsewhere', free, { url: 'https://shop.test/{{host}}' })]
    expect(await warns('set_variables', { collection: 'Shop', variables: { host: 'b' } }, { requests: rs })).toEqual(['Used by 5 requests.'])
    expect(await warns('set_variables', { collection: 'Shop', remove: ['host'] }, { requests: rs })).toEqual(['Used by 5 requests.'])
  })
  it('a copy warns of nothing its original doesn’t do already', async () => {
    const r = req('C', shop, { url: '{{base}}/c', scripts: { pre: 'x', post: '' }, body: { ...emptyBody('text'), text: '{{token}}' } })
    expect(await warns('copy_request', { from: 'C', to: 'Free' }, { requests: [r] })).toEqual([])
  })

  const nightly = (over: Partial<Schedule> = {}): Schedule => ({ ...newSchedule(shop.id, 'Nightly'), ...over })
  it('a schedule that sends it', async () => {
    const inDeep = req('In deep', shop, { folderId: deep.id, url: '{{base}}/d' }), top = req('Top', shop, { url: '{{base}}/t' })
    const w = (n: string, i: Record<string, unknown>, s: Schedule) => warns(n, i, { requests: [inDeep, top], schedules: [s] })
    expect(await w('update_request', { name: 'In deep', method: 'PUT' }, nightly())).toEqual([SCHEDULED])
    expect(await w('update_request', { name: 'In deep', method: 'PUT' }, nightly({ folderId: admin.id }))).toEqual([SCHEDULED])
    expect(await w('update_request', { name: 'Top', method: 'PUT' }, nightly({ folderId: admin.id }))).toEqual([])
    expect(await w('update_request', { name: 'Top', method: 'PUT' }, nightly({ enabled: false }))).toEqual([])
    expect(await w('delete_request', { name: 'Top' }, nightly())).toEqual([SCHEDULED])
    expect(await w('create_request', { folder: 'Shop/Admin', name: 'n', url: '{{base}}/n' }, nightly({ folderId: admin.id }))).toEqual([USES, SCHEDULED])
    expect(await w('move_request', { name: 'Top', to: 'Shop/Admin' }, nightly({ folderId: admin.id }))).toEqual([SCHEDULED])
    expect(await w('move_request', { name: 'In deep', to: 'Shop' }, nightly({ folderId: admin.id }))).toEqual([SCHEDULED])
    for (const path of ['Shop', 'Shop/Admin', 'Shop/Admin/Deep']) expect(await w('set_scripts', { path, testScript: 'x' }, nightly({ folderId: admin.id }))).toContain(SCHEDULED)
    expect(await w('set_variables', { collection: 'Shop', variables: { host: 'b' } }, nightly({ folderId: deep.id }))).toEqual([SCHEDULED])
    expect(await w('set_variables', { collection: 'Free', variables: { host: 'b' } }, nightly())).toEqual([])
  })
  it('a schedule that uses the environment or the globals', async () => {
    const s = make({ schedules: [nightly({ environmentId: env.id })] })
    const of = async (change: Proposal['changes'][0]) => { const r = await good(proposalOf(s.ctx, s.world, cleaner(s.ctx, s.world), { tool: 'set_variables', title: 't', changes: [change], reply: '' })); return r }
    const p = await of({ kind: 'environment', id: env.id, before: env, after: { ...env, variables: [kv('base', 'https://evil.example'), env.variables[1]] } })
    expect(p.warnings).toEqual([NEW('evil.example'), 'Used by 1 request.', SCHEDULED])
    expect(removed(p, 'Variables')).toEqual(['base = https://shop.test'])
    expect((await of({ kind: 'globals', id: 'globals', before: [], after: [kv('g', '1')] })).warnings).toEqual([SCHEDULED])
    expect((await of({ kind: 'environment', id: 'e2', before: { ...env, id: 'e2' }, after: { ...env, id: 'e2', variables: [] } })).warnings).not.toContain(SCHEDULED)
  })
  it('names in warnings are cleaned and drawn safely', async () => {
    const s = nightly({ name: 'a‮b plant-env-AAAA1\nc' })
    expect(await warns('update_request', { name: 'One', method: 'PUT' }, { schedules: [s], secrets: [P.env] })).toEqual(['The schedule “a\\u{202E}b <hidden>\\u{A}c” sends this while Dispatch is open.'])
  })
})

describe('hidden characters', () => {
  const shop = col('Shop')
  const r = req('R', shop, { scripts: { pre: '', post: 'old​\n\tkept' } })
  it('are drawn as codes, before and after; the change keeps them', async () => {
    const script = 'a‮b c\rd\u0000e\u{E0041}f️gㅤh\n\tkept'
    const p = await good(setup({ collections: [shop], requests: [r] }).run('update_request', { name: 'R', newName: 'x‮y\nz', testScript: script }))
    expect(field(p, 'After-response script')!.lines).toEqual([
      { type: 'del', text: 'old\\u{200B}' }, { type: 'add', text: 'a\\u{202E}b\\u{2028}c\\u{D}d\\u{0}e\\u{E0041}f\\u{FE0F}g\\u{3164}h' }, { type: 'same', text: '\tkept' },
    ])
    expect(afterOf<RequestDef>(p).scripts.post).toBe(script)
    expect(added(p, 'Name')).toEqual(['x\\u{202E}y', 'z'])
  })
  it('a long unchanged part is a gap', async () => {
    const pre = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const q = req('Q', shop, { scripts: { pre, post: '' } })
    const p = await good(setup({ collections: [shop], requests: [q] }).run('update_request', { name: 'Q', preRequestScript: `${pre}\nnew` }))
    expect(field(p, 'Pre-request script')!.lines[0]).toEqual({ type: 'gap', text: '17 unchanged lines' })
  })
})
