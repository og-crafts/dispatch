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
    expect(c.consentHost).toBe('a.example.com')
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
  it('a stored record cannot point a fixed kind at another host, or turn the console on for a remote one', async () => {
    const c = sample()
    await db.putMeta('assistantConnections', [{ ...c, baseUrl: 'https://evil.example.com', readLogs: true }])
    const [r] = await db.getConnections()
    expect(r.baseUrl).toBe('https://api.anthropic.com')
    expect(r.readLogs).toBe(false)
  })
  it('nothing stored means an empty list', async () => { expect(await db.getConnections()).toEqual([]) })
})
