/** The encrypted secrets file for linked folders (src/core/secretsVault.ts). Fewer PBKDF2 rounds keep the tests quick. */
import { describe, expect, it } from 'vitest'
import { VaultError, applySecrets, canonical, collectSecrets, deriveKeys, openVault, sealVault, vaultHeader } from '../src/core/secretsVault'
import { kv, newCollection, newEnvironment } from '../src/core/types'

const ROUNDS = 1000
const payload = { environments: { env1: { token: 'top-secret', pass: 'p@ss ✈' } }, collections: { col1: { apiKey: 'k-123' } } }

describe('secrets vault', () => {
  it('round-trips, and never contains the secrets in readable form', async () => {
    const k = await deriveKeys('correct horse battery staple', undefined, ROUNDS)
    const text = await sealVault(payload, k)
    expect(text).not.toContain('top-secret')
    expect(text).not.toContain('apiKey')
    expect(vaultHeader(text)?.kdf).toEqual({ name: 'PBKDF2-SHA-256', iterations: ROUNDS, salt: k.salt })
    expect(await openVault(text, k)).toEqual(JSON.parse(canonical(payload)))
  })

  it('gives the same file for the same secrets (no churn in git), and a new one when they change', async () => {
    const k = await deriveKeys('pw-for-tests-1', undefined, ROUNDS)
    const reordered = { collections: { col1: { apiKey: 'k-123' } }, environments: { env1: { pass: 'p@ss ✈', token: 'top-secret' } } }
    expect(await sealVault(reordered, k)).toBe(await sealVault(payload, k))
    expect(await sealVault({ ...payload, collections: { col1: { apiKey: 'k-124' } } }, k)).not.toBe(await sealVault(payload, k))
  })

  it('unlocks on another device with the same passphrase and the file’s salt', async () => {
    const a = await deriveKeys('shared passphrase', undefined, ROUNDS)
    const text = await sealVault(payload, a)
    const h = vaultHeader(text)!
    const b = await deriveKeys('shared passphrase', h.kdf.salt, h.kdf.iterations)
    expect(b.bits).toBe(a.bits)
    expect((await openVault(text, b)).environments.env1.token).toBe('top-secret')
  })

  it('refuses a wrong passphrase, a changed passphrase, a damaged file and a newer format', async () => {
    const a = await deriveKeys('right one', undefined, ROUNDS)
    const text = await sealVault(payload, a)
    const wrong = await deriveKeys('wrong one', a.salt, ROUNDS)
    await expect(openVault(text, wrong)).rejects.toMatchObject({ kind: 'wrong-passphrase' })
    const other = await deriveKeys('right one', undefined, ROUNDS) // the passphrase was set again elsewhere: new salt
    await expect(openVault(text, other)).rejects.toMatchObject({ kind: 'wrong-passphrase', message: expect.stringMatching(/changed on another computer/) })
    await expect(openVault('{"half":', a)).rejects.toBeInstanceOf(VaultError)
    await expect(openVault(text.replace('"format": 1', '"format": 9'), a)).rejects.toMatchObject({ kind: 'newer' })
    const tampered = JSON.parse(text); tampered.data = tampered.data.slice(0, -4) + 'AAAA'
    await expect(openVault(JSON.stringify(tampered), a)).rejects.toMatchObject({ kind: 'wrong-passphrase' })
  })

  it('collects only secret, non-empty values and applies them without emptying anything', () => {
    const env = { ...newEnvironment('Staging'), id: 'env1', variables: [kv('base', 'https://s.test'), kv('token', 'old', true, { secret: true }), kv('pass', '', true, { secret: true }), kv('other', 'keep', true, { secret: true })] }
    const col = { ...newCollection('Shop'), id: 'col1', variables: [kv('apiKey', '', true, { secret: true })] }
    expect(collectSecrets([env], [col])).toEqual({ environments: { env1: { token: 'old', other: 'keep' } }, collections: { col1: {} } })
    const r = applySecrets(payload, [env], [col])
    expect(r.environments[0].variables.map((v) => [v.key, v.value])).toEqual([['base', 'https://s.test'], ['token', 'top-secret'], ['pass', 'p@ss ✈'], ['other', 'keep']])
    expect(r.collections[0].variables[0].value).toBe('k-123')
    expect(applySecrets(payload, [r.environments[0]], [r.collections[0]])).toEqual({ environments: [], collections: [] })
  })
})
