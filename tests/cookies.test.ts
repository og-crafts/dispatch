/** A cookie jar per environment: storage, and which jar a send uses. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieJars, cookieKey, jarKey, type StoredCookie } from '../src/core/cookies'
import { CookieTransport, type SendOptions } from '../src/core/transport'
import { execute } from '../src/core/runtime'
import { runCollection } from '../src/core/runner'
import { runFlow, newFlow, newNode } from '../src/core/flows'
import { InlineEngine, scriptPipeline } from '../src/core/scriptPipeline'
import { authPipeline } from '../src/core/auth'
import { browserHook } from '../src/core/browserPipeline'
import * as db from '../src/core/db'
import { type PreparedRequest, defaultSettings, emptyAuth, newCollection, newEnvironment, newRequest } from '../src/core/types'

// A browser login that ends with one cookie.
vi.mock('../src/core/browser', async (orig) => ({ ...(await orig<object>()), runBrowserSteps: async () => ({ ok: true, finalUrl: '', extracted: {}, cookies: [{ name: 'sid', value: 'v', domain: 'a.test', path: '/', expires: -1, secure: false, httpOnly: false }], steps: [], logs: [] }) }))
beforeEach(() => db.resetForTests())
const cookie = (name: string): StoredCookie => ({ host: 'a.test', name, value: 'v', path: '/', expiresAt: null })
const opts: SendOptions = { timeoutMs: 1000, followRedirects: true, insecureTls: false }

describe('jars', () => {
  it('are named by environment, or by workspace without one', () => {
    expect([jarKey('e1', 'w'), jarKey(null, 'w')]).toEqual(['e1', 'none:w'])
    const c = { ...newCollection('C'), workspaceId: 'w2' }, e = newEnvironment('E')
    expect(cookieKey({ environment: e, collection: c })).toBe(e.id)
    expect(cookieKey({ environment: null, collection: c })).toBe('none:w2')
    expect(cookieKey({ environment: null, collection: null })).toBeUndefined()
  })
  it('don’t share, report changes, and can be deleted', () => {
    const j = new CookieJars(); j.onChange = vi.fn()
    j.get('a').set(cookie('x'))
    expect(j.onChange).toHaveBeenCalledTimes(1)
    expect([j.get('a').entries().length, j.get('b').entries().length]).toEqual([1, 0])
    expect(Object.keys(j.entries())).toEqual(['a']) // empty jars aren't kept
    const gone = j.get('a'); j.delete('a'); gone.set(cookie('late'))
    expect(j.entries()).toEqual({})
  })
  it('load what was saved', () => {
    const j = new CookieJars(); j.load({ a: [cookie('x')], bad: 'nonsense' as never })
    expect(j.get('a').entries()).toEqual([cookie('x')]); expect(j.get('bad').entries()).toEqual([])
  })
})

describe('storage', () => {
  it('round-trips, sealed', async () => {
    await db.putCookieJars({ e1: [cookie('sid')] })
    expect(await db.getCookieJars('x')).toEqual({ e1: [cookie('sid')] })
    expect(JSON.stringify(await db.getMeta('cookies'))).not.toContain('sid')
  })
  it('takes the old single list as one jar', async () => {
    await db.putCookieJars([cookie('old')] as never)
    expect(await db.getCookieJars('e1')).toEqual({ e1: [cookie('old')] })
  })
  it('gives nothing for data it can’t read, and leaves it there', async () => {
    await db.putMeta('cookies', 'garbage')
    expect(await db.getCookieJars('e1')).toEqual({})
    expect(await db.getMeta('cookies')).toBe('garbage')
  })
})

describe('sends', () => {
  const A = newEnvironment('A'), B = newEnvironment('B'), col = { ...newCollection('C'), workspaceId: 'w1' }
  function setup() {
    let active = 'none:w9', on = true
    const sent: PreparedRequest[] = [], during: (() => void)[] = []
    const inner = { label: 'f', unrestricted: true, send: async (p: PreparedRequest) => {
      sent.push(p); during.shift()?.()
      return { status: 200, statusText: 'OK', headers: [['Set-Cookie', `c${sent.length}=1; Path=/`]] as [string, string][], body: '{"access_token":"t"}', binary: false, size: 1, timeMs: 1 }
    } }
    const jars = new CookieJars()
    const t = new CookieTransport(inner, (k) => jars.get(k ?? active), () => on)
    const names = (k: string) => jars.get(k).entries().map((c) => c.name)
    const cookies = (i: number) => sent[i].headers.find(([k]) => k === 'Cookie')?.[1]
    return { t, jars, sent, during, names, cookies, setActive: (k: string) => { active = k }, setOn: (v: boolean) => { on = v } }
  }
  const req = newRequest({ name: 'R', url: 'https://a.test/x', collectionId: col.id })
  const ctx = (environment: typeof A | null, collection: typeof col | null = col) => ({ collection, folders: [], environment, globals: [] })
  const script = (t: CookieTransport) => scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => opts })

  it('keep one environment’s cookies from another', async () => {
    const s = setup()
    await execute(req, ctx(A), s.t, opts); await execute(req, ctx(B), s.t, opts); await execute(req, ctx(null), s.t, opts); await execute(req, ctx(A), s.t, opts)
    expect([0, 1, 2, 3].map(s.cookies)).toEqual([undefined, undefined, undefined, 'c1=1'])
    expect(s.names('none:w1')).toEqual(['c3'])
  })
  it('without environment or collection use the active jar, unless told which', async () => {
    const s = setup()
    await execute(req, ctx(null, null), s.t, opts); await execute(req, ctx(null, null), s.t, { ...opts, jar: 'picked' })
    expect([s.names('none:w9'), s.names('picked')]).toEqual([['c1'], ['c2']])
  })
  it('keep the jar they started with when the environment is switched meanwhile', async () => {
    const s = setup(); s.setActive(A.id); s.during.push(() => s.setActive(B.id))
    await s.t.send({ method: 'GET', url: 'https://a.test', headers: [], body: null, unresolved: [] }, opts)
    expect([s.names(A.id), s.names(B.id)]).toEqual([['c1'], []])
  })
  it('in a run or flow, use the run’s environment', async () => {
    const s = setup(); s.setActive(B.id)
    await runCollection({ items: [{ request: req, path: '' }], delayMs: 0, stopOnFailure: false, iterations: 2, data: null, environment: A, collections: [col], folders: [], globals: [], settings: defaultSettings } as never, s.t, {})
    expect(s.cookies(1)).toBe('c1=1')
    const f = newFlow('F'); const n = { ...newNode('request', 0, 0), config: { requestId: req.id } }
    f.nodes.push(n); f.edges.push({ id: 'e', from: f.nodes[0].id, port: 'next', to: n.id })
    await runFlow(f, { collections: [col], folders: [], requests: [req], environment: A, globals: [], settings: defaultSettings }, s.t, {}, new InlineEngine())
    expect(s.cookies(2)).toContain('c1=1'); expect(s.names(B.id)).toEqual([])
  })
  it('from scripts, use the request’s environment', async () => {
    const s = setup(); s.setActive(B.id)
    await execute({ ...req, scripts: { pre: "await dx.send('https://a.test/login')", post: '' } }, ctx(A), s.t, opts, script(s.t))
    expect(s.cookies(1)).toBe('c1=1'); expect(s.names(B.id)).toEqual([])
  })
  it('to refresh a token, use the request’s environment', async () => {
    const s = setup(); s.setActive(B.id)
    const auth = { ...emptyAuth('oauth2'), accessToken: 'old', refreshToken: 'r', expiresAt: 1, tokenUrl: 'https://a.test/token' }
    await execute({ ...req, auth }, ctx(A), s.t, opts, authPipeline({}, s.t))
    expect(s.sent).toHaveLength(2); expect(s.names(B.id)).toEqual([]); expect(s.names(A.id)).toEqual(['c1', 'c2'])
  })
  it('of a retried request use the same jar', async () => {
    const s = setup(); s.setActive(B.id)
    await execute(req, ctx(A), s.t, opts, { retry: async (p, _r, _q, _c, send) => ({ sent: p, response: await send(p) }) })
    expect(s.cookies(1)).toBe('c1=1'); expect(s.names(B.id)).toEqual([])
  })
  it('of a browser login keep its cookies in the request’s environment', async () => {
    const s = setup()
    const jar = vi.fn((c: Parameters<typeof cookieKey>[0]) => s.jars.get(cookieKey(c)!))
    await execute({ ...req, protocol: 'browser' }, ctx(A), s.t, opts, { browser: browserHook({} as never, jar) })
    expect(s.names(A.id)).toEqual(['sid'])
  })
  it('send and keep none when cookies are off', async () => {
    const s = setup(); s.jars.get(A.id).set(cookie('x')); s.setOn(false)
    await execute(req, ctx(A), s.t, opts)
    expect(s.cookies(0)).toBeUndefined(); expect(s.names(A.id)).toEqual(['x'])
  })
})
