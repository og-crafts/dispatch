import { beforeEach, describe, expect, it } from 'vitest'
import { exportWorkspace } from '../src/core/backup'
import * as db from '../src/core/db'
import { seal } from '../src/core/vault'
import { newCollection } from '../src/core/types'
import { needsKey, newConnection, reach, validateAddress, withBaseUrl, type Connection } from '../src/core/assistant/connections'

beforeEach(() => db.resetForTests())

describe('reach', () => {
  it('local only for localhost and loopback literals', () => {
    for (const u of ['http://localhost:11434/v1', 'http://LOCALHOST', 'https://localhost', 'http://127.0.0.1:1234', 'http://127.9.9.9', 'http://[::1]:1',
      'http://[::ffff:127.0.0.1]/x', 'http://2130706433:1234/', 'http://0x7f.1/']) expect(reach(u), u).toBe('local')
  })
  it('network for private literals', () => {
    for (const u of ['http://10.1.2.3', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.5:8000', 'http://169.254.1.1', 'http://[fd00::1]',
      'http://[fc00::1]', 'http://[fe80::1]', 'http://[febf::1]', 'http://[::ffff:192.168.1.1]']) expect(reach(u), u).toBe('network')
  })
  it('cloud for everything else, including look-alikes and junk', () => {
    for (const u of ['https://api.anthropic.com', 'http://localhost.evil.com', 'http://localhost.', 'http://172.32.0.1', 'http://172.15.0.1', 'http://8.8.8.8',
      'http://[2001:db8::1]', 'http://[::ffff:8.8.8.8]', 'http://[fec0::1]', 'http://my-nas.local', 'not a url', '', 'http://134744072/']) expect(reach(u), u).toBe('cloud')
  })
})

describe('validateAddress', () => {
  it('accepts what Rust accepts', () => {
    for (const u of ['https://api.example.com/v1', 'http://localhost:11434/v1', 'http://192.168.1.5:8000', 'http://[::1]:1', 'https://10.0.0.1']) expect(validateAddress(u), u).toBeNull()
  })
  it('refuses what Rust refuses, with plain text', () => {
    for (const u of ['http://api.example.com', 'http://8.8.8.8', 'ftp://x.com', 'file:///etc/passwd', 'https://user:pw@api.example.com', 'https://127.0.0.1@evil.com@x.com',
      'https://{{host}}/v1', 'https://api.example.com/{{path}}', 'not a url', '', 'http://localhost.evil.com']) {
      const e = validateAddress(u)
      expect(typeof e, u).toBe('string')
      expect(e!.length).toBeGreaterThan(5)
    }
  })
  it('refuses a query or fragment (a key pasted there would be stored in clear)', () => {
    for (const u of ['https://api.example.com/v1?key=sk-123', 'https://api.example.com/v1#sk-123', 'http://localhost:1/v1?']) {
      const e = validateAddress(u)
      expect(typeof e, u).toBe('string')
      expect(e).not.toContain('sk-123')
    }
  })
  it('never repeats the address back (it may hold a secret)', () => {
    expect(validateAddress('https://user:hunter2@api.example.com')).not.toContain('hunter2')
  })
})

describe('newConnection', () => {
  it('a local model reads the console by default; the clouds do not', () => {
    const c = newConnection('compatible')
    expect(c.baseUrl).toBe('http://localhost:11434/v1')
    expect(c.readLogs).toBe(true)
    expect(c.key).toBe('')
    expect(c.tools).toBe('unknown')
    expect(newConnection('anthropic').readLogs).toBe(false)
    expect(newConnection('openai').readLogs).toBe(false)
  })
  it('fixed official addresses and the suggested Anthropic model', () => {
    expect(newConnection('anthropic').baseUrl).toBe('https://api.anthropic.com')
    expect(newConnection('anthropic').model).toBe('claude-opus-5-5')
    expect(newConnection('openai').baseUrl).toBe('https://api.openai.com/v1')
    expect(newConnection('anthropic').id).not.toBe(newConnection('anthropic').id)
  })
  it('only a compatible connection has an editable address', () => {
    const a = { ...newConnection('anthropic'), key: 'k' }
    expect(withBaseUrl(a, 'http://localhost:1/v1')).toEqual(a)
    expect(needsKey(a)).toBe(true)
    expect(needsKey(newConnection('openai'))).toBe(true)
    expect(needsKey(newConnection('compatible'))).toBe(false)
  })
})

describe('withBaseUrl', () => {
  const local: Connection = { ...newConnection('compatible'), key: 'sk-local', consentHost: 'localhost:11434' }
  it('moving to a cloud address resets readLogs, clears consent and the key', () => {
    const c = withBaseUrl(local, 'https://api.example.com/v1')
    expect(c.baseUrl).toBe('https://api.example.com/v1')
    expect(c.readLogs).toBe(false)
    expect(c.consentHost).toBeUndefined()
    expect(c.key).toBe('')
  })
  it('moving to a private address also turns the console off', () => {
    expect(withBaseUrl(local, 'http://192.168.1.5:8000/v1').readLogs).toBe(false)
  })
  it('coming back to loopback does not turn it on again', () => {
    const back = withBaseUrl(withBaseUrl(local, 'https://api.example.com/v1'), 'http://localhost:11434/v1')
    expect(back.readLogs).toBe(false)
  })
  it('a path change on the same host keeps consent and key', () => {
    const c = withBaseUrl(local, 'http://localhost:11434/other')
    expect(c.consentHost).toBe('localhost:11434')
    expect(c.key).toBe('sk-local')
    expect(c.readLogs).toBe(true)
  })
  it('a port change clears consent and the key', () => {
    const c = withBaseUrl(local, 'http://localhost:1234/v1')
    expect(c.consentHost).toBeUndefined()
    expect(c.key).toBe('')
    expect(c.readLogs).toBe(true)
  })
  it('a scheme change clears the key (the origin changed)', () => {
    const cloud = { ...newConnection('compatible'), baseUrl: 'https://a.example.com/v1', key: 'k', consentHost: 'a.example.com' }
    const c = withBaseUrl(cloud, 'http://a.example.com/v1')
    expect(c.key).toBe('')
    expect(c.consentHost).toBeUndefined()
  })
  it('https to http on a private address (same host text) clears consent', () => {
    const c = withBaseUrl({ ...newConnection('compatible'), baseUrl: 'https://192.168.1.5', consentHost: '192.168.1.5', key: 'k' }, 'http://192.168.1.5')
    expect(c.consentHost).toBeUndefined()
    expect(c.key).toBe('')
  })
  it('the same origin keeps a ticked console on a network or cloud address', () => {
    const n = { ...newConnection('compatible'), baseUrl: 'http://192.168.1.5:8000/v1', readLogs: true, tools: 'yes' as const, contextTokens: 8000 }
    const c = withBaseUrl(n, 'http://192.168.1.5:8000/other')
    expect(c.readLogs).toBe(true)
    expect(c.tools).toBe('yes')
    expect(c.contextTokens).toBe(8000)
  })
  it('a changed origin resets tools and drops contextTokens', () => {
    const c = withBaseUrl({ ...local, tools: 'yes', contextTokens: 8000 }, 'http://localhost:1234/v1')
    expect(c.tools).toBe('unknown')
    expect(c.contextTokens).toBeUndefined()
  })
  it('stores the trimmed address', () => {
    expect(withBaseUrl(local, '  http://localhost:11434/v1  ').baseUrl).toBe('http://localhost:11434/v1')
  })
  it('an unparseable address is treated as cloud', () => {
    const c = withBaseUrl(local, 'htt')
    expect(c.readLogs).toBe(false)
    expect(c.key).toBe('')
  })
})

describe('storage', () => {
  const sample = (): Connection => ({ ...newConnection('anthropic'), key: 'sk-ant-SECRET-123', consentHost: 'api.anthropic.com' })
  it('round-trips with the key', async () => {
    const c = sample()
    await db.putConnections([c])
    const [r] = await db.getConnections()
    expect(r).toEqual(c)
    expect(r.keyLost).toBeUndefined()
  })
  it('raw IndexedDB never holds the key', async () => {
    await db.putConnections([sample()])
    expect(JSON.stringify(await db.getMeta('assistantConnections'))).not.toContain('SECRET')
  })
  it('a backup export never holds the key', async () => {
    await db.putConnections([sample()])
    const out = exportWorkspace({ collections: [newCollection('C')], folders: [], requests: [], environments: [], globals: [] })
    expect(out).not.toContain('SECRET')
    expect(out).not.toContain('assistantConnections')
  })
  it('a key sealed by another device reads as empty and is flagged lost', async () => {
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const c = sample()
    await db.putConnections([c])
    await db.putMeta('assistantConnections', [{ ...c, key: await seal(other, 'sk-ant-FOREIGN') }])
    const [r] = await db.getConnections()
    expect(r.key).toBe('')
    expect(r.keyLost).toBe(true)
  })
  it('a never-set key is not flagged lost, and keyLost is never written', async () => {
    const c = newConnection('compatible')
    await db.putConnections([{ ...c, keyLost: true }])
    expect(JSON.stringify(await db.getMeta('assistantConnections'))).not.toContain('keyLost')
    const [r] = await db.getConnections()
    expect(r.key).toBe('')
    expect(r.keyLost).toBeUndefined()
  })
  it('a stored record cannot point a fixed kind at another host', async () => {
    await db.putMeta('assistantConnections', [{ ...sample(), baseUrl: 'https://evil.example.com' }])
    expect((await db.getConnections())[0].baseUrl).toBe('https://api.anthropic.com')
  })
  it('a ticked console on a cloud or network connection round-trips as true', async () => {
    const a = { ...sample(), readLogs: true }
    const b = { ...newConnection('compatible'), baseUrl: 'http://192.168.1.5:8000/v1', readLogs: true }
    await db.putConnections([a, b])
    expect((await db.getConnections()).map((c) => c.readLogs)).toEqual([true, true])
  })
  it('malformed elements are skipped, not fatal', async () => {
    await db.putMeta('assistantConnections', [null, 5, 'x', { kind: 'weird', baseUrl: 'x' }, { ...sample(), key: '' }])
    const list = await db.getConnections()
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe('anthropic')
  })
  describe('an unreadable key survives get then put', () => {
    const foreign = async (c: Connection) => {
      const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await db.putMeta('assistantConnections', [{ ...c, key: await seal(other, 'sk-FOREIGN') }])
      return (await db.getMeta<Connection[]>('assistantConnections'))![0].key
    }
    for (const kind of ['anthropic', 'compatible'] as const) {
      it(kind, async () => {
        const c = { ...newConnection(kind), key: 'x' }
        const cipher = await foreign(c)
        const [r] = await db.getConnections()
        expect(r.keyLost).toBe(true)
        await db.putConnections([{ ...r, name: 'renamed' }])
        const stored = (await db.getMeta<Connection[]>('assistantConnections'))![0]
        expect(stored.key).toBe(cipher)
        const [again] = await db.getConnections()
        expect(again.keyLost).toBe(true)
        expect(again.key).toBe('')
        expect(again.name).toBe('renamed')
      })
    }
    it('editing another connection in between keeps it', async () => {
      const a = { ...newConnection('anthropic'), key: 'x' }
      const b = { ...newConnection('openai'), key: 'sk-B' }
      const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await db.putConnections([a, b])
      const cur = (await db.getMeta<Connection[]>('assistantConnections'))!
      await db.putMeta('assistantConnections', [{ ...cur[0], key: await seal(other, 'sk-F') }, cur[1]])
      const cipher = (await db.getMeta<Connection[]>('assistantConnections'))![0].key
      const [ra, rb] = await db.getConnections()
      await db.putConnections([ra, { ...rb, name: 'edited' }])
      expect((await db.getMeta<Connection[]>('assistantConnections'))![0].key).toBe(cipher)
      expect((await db.getConnections())[1].key).toBe('sk-B')
    })
    it('setting a key, or removing it explicitly, replaces it', async () => {
      const c = { ...newConnection('compatible'), key: 'x' }
      await foreign(c)
      const [r] = await db.getConnections()
      await db.putConnections([{ ...r, key: 'sk-NEW' }])
      expect((await db.getConnections())[0]).toMatchObject({ key: 'sk-NEW' })
      expect((await db.getConnections())[0].keyLost).toBeUndefined()
      await foreign(c)
      const [r2] = await db.getConnections()
      const { keyLost: _k, ...cleared } = r2
      await db.putConnections([{ ...cleared, key: '' }])
      const [after] = await db.getConnections()
      expect(after.key).toBe('')
      expect(after.keyLost).toBeUndefined()
    })
  })
  it('nothing stored means an empty list', async () => { expect(await db.getConnections()).toEqual([]) })
})
