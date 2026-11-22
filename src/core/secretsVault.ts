/**
 * Secrets that travel with a linked workspace folder, opt-in (docs/DESIGN-linked-workspaces.md, "Sync decision").
 *
 * Every other file in the folder leaves secret values empty. When the person turns on "Sync secrets", the workspace's
 * secret variable values (environments and collection variables) go into one file, `secrets.dispatch-vault`,
 * encrypted with a key made from a passphrase they choose:
 *
 *   PBKDF2-SHA-256 (600 000 rounds, random 16-byte salt) → 64 bytes: 32 for AES-256-GCM, 32 for HMAC-SHA-256
 *   IV = the first 12 bytes of HMAC(payload)
 *
 * The IV comes from the content, so the same secrets always give the same file: it doesn't change on every save
 * (no git noise, no sync loops). The only thing that leaks is whether two versions hold the same secrets. Literal
 * secrets typed into auth fields are not included (they stay on the device; files only keep {{variable}} refs).
 */
import type { Collection, Environment } from './types'

export const VAULT_FILE = 'secrets.dispatch-vault'
export const VAULT_FORMAT = 1
export const VAULT_ITERATIONS = 600_000

/** Secret values by item id, then variable key. */
export interface VaultPayload { environments: Record<string, Record<string, string>>; collections: Record<string, Record<string, string>> }
/** What a device keeps to open and write the file without asking again: the salt, rounds and the derived bits. */
export interface VaultKeys { salt: string; iterations: number; bits: string }

export class VaultError extends Error {
  constructor(public kind: 'wrong-passphrase' | 'damaged' | 'newer', message: string) { super(message) }
}

const subtle = () => globalThis.crypto.subtle
const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const utf8 = (s: string) => new TextEncoder().encode(s)

/** Makes the keys from a passphrase: a new random salt, or the salt of an existing file (to unlock it). */
export async function deriveKeys(passphrase: string, salt?: string, iterations = VAULT_ITERATIONS): Promise<VaultKeys> {
  const s = salt ? unb64(salt) : globalThis.crypto.getRandomValues(new Uint8Array(16))
  const base = await subtle().importKey('raw', utf8(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: s, iterations }, base, 512))
  return { salt: b64(s), iterations, bits: b64(bits) }
}

async function cryptoKeys(k: VaultKeys) {
  const bits = unb64(k.bits)
  return {
    enc: await subtle().importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']),
    mac: await subtle().importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  }
}

/** The payload as stable text: keys sorted at every level, empty items left out. */
export function canonical(p: VaultPayload): string {
  const sortObj = (o: Record<string, Record<string, string>>) => Object.fromEntries(Object.keys(o).sort()
    .map((id) => [id, Object.fromEntries(Object.keys(o[id]).sort().map((k) => [k, o[id][k]]))] as const)
    .filter(([, v]) => Object.keys(v).length))
  return JSON.stringify({ collections: sortObj(p.collections), environments: sortObj(p.environments) })
}

/** The file's text for these secrets. Same secrets and keys → same text. */
export async function sealVault(p: VaultPayload, k: VaultKeys): Promise<string> {
  const { enc, mac } = await cryptoKeys(k)
  const plain = utf8(canonical(p))
  const iv = new Uint8Array(await subtle().sign('HMAC', mac, plain)).slice(0, 12)
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, enc, plain))
  return JSON.stringify({
    about: 'Dispatch secrets for this workspace, encrypted with a passphrase. See https://dispatch.ogcrafts.cloud/',
    format: VAULT_FORMAT, kdf: { name: 'PBKDF2-SHA-256', iterations: k.iterations, salt: k.salt }, cipher: 'AES-256-GCM', iv: b64(iv), data: b64(data),
  }, null, 2) + '\n'
}

interface Header { format: number; kdf: { iterations: number; salt: string }; iv: string; data: string }
/** The salt and rounds a file was written with (to unlock it), or null when it isn't a vault file. */
export function vaultHeader(text: string): Header | null {
  try {
    const h = JSON.parse(text) as Header
    return typeof h?.kdf?.salt === 'string' && typeof h.iv === 'string' && typeof h.data === 'string' && Number(h.kdf.iterations) > 0 ? h : null
  } catch { return null }
}

/** Opens a file with keys. Throws VaultError: another passphrase (or salt), a damaged file, or a newer format. */
export async function openVault(text: string, k: VaultKeys): Promise<VaultPayload> {
  const h = vaultHeader(text)
  if (!h) throw new VaultError('damaged', `${VAULT_FILE} can’t be read (is it complete?).`)
  if (Number(h.format) > VAULT_FORMAT) throw new VaultError('newer', `${VAULT_FILE} was written by a newer Dispatch. Update Dispatch to use it.`)
  if (h.kdf.salt !== k.salt || Number(h.kdf.iterations) !== k.iterations) throw new VaultError('wrong-passphrase', 'The passphrase for these secrets was changed on another computer. Enter the new one.')
  let plain: ArrayBuffer
  try { plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(h.iv) }, (await cryptoKeys(k)).enc, unb64(h.data)) } catch {
    throw new VaultError('wrong-passphrase', 'That passphrase doesn’t open these secrets.')
  }
  try {
    const p = JSON.parse(new TextDecoder().decode(plain)) as Partial<VaultPayload>
    return { environments: p.environments ?? {}, collections: p.collections ?? {} }
  } catch { throw new VaultError('damaged', `${VAULT_FILE} opened but its content can’t be read.`) }
}

/** The secret values a workspace has now (only variables marked secret, only non-empty values). */
export function collectSecrets(environments: Environment[], collections: Collection[]): VaultPayload {
  const pick = (rows: { key: string; value: string; secret?: boolean }[]) => Object.fromEntries(rows.filter((v) => v.secret && v.key.trim() && v.value !== '').map((v) => [v.key, v.value]))
  return {
    environments: Object.fromEntries(environments.map((e) => [e.id, pick(e.variables)])),
    collections: Object.fromEntries(collections.map((c) => [c.id, pick(c.variables)])),
  }
}

/**
 * The items whose secret values change when `p` is applied: secret variables this device has get the file's
 * value. Variables the file doesn't mention are left as they are (never emptied).
 */
export function applySecrets(p: VaultPayload, environments: Environment[], collections: Collection[]) {
  const fill = <T extends { id: string; variables: { key: string; value: string; secret?: boolean }[] }>(items: T[], from: Record<string, Record<string, string>>) => items.flatMap((x) => {
    const vals = from[x.id]
    if (!vals) return []
    let changed = false
    const variables = x.variables.map((v) => (v.secret && v.key in vals && vals[v.key] !== v.value ? (changed = true, { ...v, value: vals[v.key] }) : v))
    return changed ? [{ ...x, variables }] : []
  })
  return { environments: fill(environments, p.environments), collections: fill(collections, p.collections) }
}
