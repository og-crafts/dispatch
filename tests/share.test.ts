// @vitest-environment node
/** Share as HTML: what gets hidden, what the page holds, and that the page works and can't be injected into. */
import { describe, expect, it } from 'vitest'
// @ts-expect-error jsdom is a test-only dependency here and ships no type declarations
import { JSDOM } from 'jsdom'
import { Sanitizer, buildShare, defaultShareOptions, type ShareMeta } from '../src/core/share'
import { renderShareHtml } from '../src/core/shareHtml'
import { type HistoryEntry, emptyAuth, kv, newCollection, newFolder, newRequest } from '../src/core/types'

const meta: ShareMeta = { title: '', version: '2.1.0', author: 'Platform team', description: 'Read me first', contact: '#api-help' }

describe('Sanitizer', () => {
  const s = () => new Sanitizer(defaultShareOptions)

  it('hides values under secret-looking names, keeps variables and ordinary values', () => {
    const x = s()
    expect(x.headers([['Authorization', 'Bearer abc.def.ghijklmnop'], ['X-Api-Key', 'k-123456'], ['Cookie', 'sid=1'], ['Accept', 'application/json'], ['X-Token', '{{token}}']]))
      .toEqual([['Authorization', 'Bearer <redacted>'], ['X-Api-Key', '<redacted>'], ['Cookie', '<redacted>'], ['Accept', 'application/json'], ['X-Token', '{{token}}']])
    expect(x.count).toBe(3)
  })

  it('cleans URLs: the server address, secret query values, and personal data', () => {
    const x = s()
    expect(x.url('https://api.staging.internal.example.net/v3/plans?access_token=zzz&page=2&email=jo@corp.io'))
      .toBe('{{baseUrl}}/v3/plans?access_token=<redacted>&page=2&email=user@example.com')
    expect(x.url('{{base}}/a?apiKey={{key}}')).toBe('{{base}}/a?apiKey={{key}}')
    expect(new Sanitizer({ ...defaultShareOptions, serverAs: '' }).url('https://api.real.test/x')).toBe('https://api.real.test/x')
  })

  it('cleans JSON bodies by key and value, and samples long lists', () => {
    const x = s()
    const out = JSON.parse(x.body(JSON.stringify({
      user: { email: 'ann@corp.io', password: 'hunter2', pin: 1234, profile: { refresh_token: 'r' } },
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl',
      ip: '10.20.30.40',
      items: [1, 2, 3, 4, 5, 6],
      note: 'x'.repeat(400),
    })))
    expect(out.user).toEqual({ email: 'user@example.com', password: '<redacted>', pin: 1234, profile: { refresh_token: '<redacted>' } })
    expect(out.jwt).toBe('<jwt>')
    expect(out.ip).toBe('203.0.113.10')
    expect(out.items).toEqual([1, 2, 3])
    expect(out.note.length).toBe(301)
  })

  it('cleans plain text too: auth schemes, AWS keys, key=value secrets', () => {
    const x = s()
    expect(x.body('Authorization: Bearer abcdefghijkl\nkey AKIAABCDEFGHIJKLMNOP\npassword=hunter2&user=bob'))
      .toBe('Authorization: Bearer <redacted>\nkey <aws-access-key>\npassword=<redacted>&user=bob')
  })
})

describe('buildShare', () => {
  const col = { ...newCollection('Shop'), auth: { ...emptyAuth('bearer'), token: 'real-secret-token-value' }, variables: [kv('base', 'https://internal.corp')] }
  const orders = newFolder(col.id, 'Orders')
  const list = newRequest({ name: 'List orders', url: '{{base}}/orders?limit=5', collectionId: col.id, folderId: orders.id, sort: 1 })
  const create = newRequest({
    name: 'Create order', method: 'POST', url: 'https://shop.internal.corp/orders', collectionId: col.id, folderId: orders.id, sort: 2,
    body: { kind: 'json', text: '{"qty":2,"card_number":"4111111111111111"}', fields: [], graphqlVariables: '', file: null },
    examples: [{ id: 'e', name: 'Created', status: 201, headers: [['Content-Type', 'application/json']], body: '{"id":7,"owner":"ann@corp.io"}' }],
  })
  const ping = newRequest({ name: 'Ping', url: 'https://shop.internal.corp/ping', collectionId: col.id, sort: 0 })
  const history: HistoryEntry[] = [{
    id: 'h', at: 1, request: list, sent: { method: 'GET', url: '', headers: [], body: null, unresolved: [] }, error: null,
    response: { status: 200, statusText: 'OK', headers: [['Set-Cookie', 'sid=abc']], body: '[{"id":1},{"id":2},{"id":3},{"id":4}]', binary: false, size: 10, timeMs: 42 },
  }]
  const src = { collections: [col], folders: [orders], requests: [create, list, ping], history }

  it('covers a collection in order with folder paths, sample responses and curl, with nothing secret left', () => {
    const doc = buildShare({ kind: 'collection', collectionId: col.id }, src, meta, defaultShareOptions, new Date('2026-11-16T10:00:00Z'))
    expect(doc.meta).toMatchObject({ title: 'Shop', version: '2.1.0', author: 'Platform team' })
    expect(doc.requests.map((r) => [r.path.join('/'), r.name])).toEqual([['', 'Ping'], ['Orders', 'List orders'], ['Orders', 'Create order']])
    const [, l, c] = doc.requests
    expect(l.url).toBe('{{base}}/orders?limit=5') // variables are not filled in
    expect(l.headers).toContainEqual(['Authorization', 'Bearer <redacted>'])
    expect(l.responses[0]).toMatchObject({ label: 'Last response', status: 200, timeMs: 42, headers: [['Set-Cookie', '<redacted>']] })
    expect(JSON.parse(l.responses[0].body)).toHaveLength(3)
    expect(c.url).toBe('{{baseUrl}}/orders')
    expect(JSON.parse(c.body!)).toEqual({ qty: 2, card_number: '<redacted>' })
    expect(c.responses[0]).toMatchObject({ label: 'Created', status: 201 })
    expect(c.curl).toMatch(/-X POST[\s\S]*'\{\{baseUrl\}\}\/orders'/)
    expect(c.curl).toContain('Bearer <redacted>')
    const all = JSON.stringify(doc)
    for (const secret of ['real-secret-token-value', 'internal.corp', '4111111111111111', 'ann@corp.io', 'sid=abc']) expect(all).not.toContain(secret)
    expect(doc.redactions).toBeGreaterThan(5)
  })

  it('covers one folder, or one request with the response on screen', () => {
    expect(buildShare({ kind: 'folder', folderId: orders.id }, src, meta, defaultShareOptions).requests.map((r) => r.name)).toEqual(['List orders', 'Create order'])
    const one = buildShare({ kind: 'request', requestId: ping.id, draft: { ...ping, name: 'Ping (edited)' }, lastResponse: { status: 204, statusText: 'No Content', headers: [], body: '', binary: false, size: 0, timeMs: 3 } }, src, meta, { ...defaultShareOptions, trim: false })
    expect(one.scope).toBe('request')
    expect(one.meta.title).toBe('Ping (edited)')
    expect(one.requests[0].responses[0]).toMatchObject({ status: 204, statusText: 'No Content' })
    expect(buildShare({ kind: 'request', requestId: ping.id }, src, meta, { ...defaultShareOptions, includeResponses: false }).requests[0].responses).toEqual([])
  })
})

describe('renderShareHtml', () => {
  const col = newCollection('Shop')
  const evil = newRequest({ name: '</script><img src=x onerror="window.hacked=1">', url: 'https://x.test/a', collectionId: col.id, sort: 0 })
  const b = newRequest({ name: 'Second', method: 'POST', url: 'https://x.test/b', collectionId: col.id, sort: 1, body: { kind: 'json', text: '{"a":true}', fields: [], graphqlVariables: '', file: null } })
  const doc = buildShare({ kind: 'collection', collectionId: col.id }, { collections: [col], folders: [], requests: [evil, b], history: [] }, { ...meta, title: '<b>Shop</b>' }, defaultShareOptions)
  const html = renderShareHtml(doc)

  it('is one self-contained file that can’t be injected into', () => {
    expect(html).toContain("Content-Security-Policy")
    expect(html).not.toMatch(/<(link|img)\b[^>]*(src|href)=["']?https?:/i)
    expect(html.match(/<\/script>/g)).toHaveLength(2) // only the page's own two script tags close
    expect(html).toContain('<title>&lt;b&gt;Shop&lt;/b&gt; 2.1.0</title>')
  })

  it('opens on the Response tab when shared from the response', () => {
    const r = newRequest({ name: 'Dogs', url: 'https://x.test/dogs', collectionId: col.id, sort: 0 })
    const shared = buildShare({ kind: 'request', requestId: r.id, draft: r, open: 'response', lastResponse: { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json']], body: '{"data":[{"id":1}]}', binary: false, size: 19, timeMs: 5 } },
      { collections: [col], folders: [], requests: [r], history: [] }, meta, defaultShareOptions)
    expect(shared.open).toBe('response')
    const dom = new JSDOM(renderShareHtml(shared), { runScripts: 'dangerously', url: 'https://share.test/dogs.html' })
    const d = dom.window.document
    expect(d.querySelector('.tabs button[aria-selected=true]')!.textContent).toBe('Response')
    expect(d.querySelector('main .jtree')!.textContent).toContain('"data"')
    dom.window.close()
  })

  it('works when opened: list, tabs, curl, and data shown as text', async () => {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://share.test/page.html' })
    const w = dom.window
    const d = w.document
    expect((w as unknown as { hacked?: number }).hacked).toBeUndefined()
    expect(d.querySelectorAll('nav a')).toHaveLength(2)
    expect(d.querySelector('main h2')!.textContent).toBe(evil.name)
    expect(d.querySelector('main img')).toBeNull()
    expect(d.querySelector('header h1')!.textContent).toBe('<b>Shop</b>')
    expect(d.querySelector('.chip.v')!.textContent).toBe('v2.1.0')
    // Open the second request and its curl tab.
    w.location.hash = '#r2'
    w.dispatchEvent(new w.HashChangeEvent('hashchange'))
    expect(d.querySelector('main h2')!.textContent).toBe('Second')
    expect(d.querySelector('main .k')!.textContent).toBe('"a"') // JSON body shown as a coloured tree
    // Every object folds; Collapse all keeps only the top level open, Expand all opens everything again.
    const tree = d.querySelector('main .jtree')!
    const btn = (t: string) => [...d.querySelectorAll('main .btns button')].find((x) => x.textContent === t) as HTMLButtonElement
    btn('Collapse all').click()
    expect([...tree.querySelectorAll('details')].map((x) => (x as HTMLDetailsElement).open)).toEqual([true, ...[...tree.querySelectorAll('details')].slice(1).map(() => false)])
    btn('Expand all').click()
    expect([...tree.querySelectorAll('details')].every((x) => (x as HTMLDetailsElement).open)).toBe(true)
    const curlTab = [...d.querySelectorAll('.tabs button')].find((x) => x.textContent === 'curl') as HTMLButtonElement
    curlTab.click()
    expect(d.querySelector('main pre')!.textContent).toMatch(/^curl[\s\S]*-X POST[\s\S]*'\{\{baseUrl\}\}\/b'/)
    // Search narrows the list.
    const search = d.querySelector('nav input') as HTMLInputElement
    search.value = 'second'; search.dispatchEvent(new w.Event('input'))
    expect([...d.querySelectorAll('nav li')].filter((li) => !(li as HTMLElement).hidden)).toHaveLength(1)
    w.close()
  })
})

describe('the shared page look', () => {
  it('uses the Dispatch look: graphite and amber, no glass or gradients', async () => {
    const { renderShareHtml } = await import('../src/core/shareHtml')
    const html = renderShareHtml({ scope: 'request', collection: 'Shop', meta: { title: 'Orders' }, requests: [], generatedAt: new Date(0).toISOString() } as never)
    expect(html).toContain('#FFB020')
    expect(html).not.toMatch(/radial-gradient|backdrop-filter|#6247F0|text-transform:uppercase/i)
  })
})
