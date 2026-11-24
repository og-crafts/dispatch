/**
 * Assistant connections: where the assistant sends its questions, with the key it uses.
 * Address rules mirror src-tauri/src/ai.rs (check_target, host_kind); keys are sealed at rest (db.ts) and never exported.
 */
export type ConnectionKind = 'anthropic' | 'openai' | 'compatible'

export interface Connection {
  id: string
  name: string
  kind: ConnectionKind
  baseUrl: string
  model: string
  key: string
  contextTokens?: number
  /** May the assistant read the console and history. On for loopback, off elsewhere. */
  readLogs: boolean
  tools: 'unknown' | 'yes' | 'no'
  /** The host (with port) the owner agreed to send data to. */
  consentHost?: string
  /** Set on read, never saved: a key was saved but can't be read here (another device's key). */
  keyLost?: true
}

export type Reach = 'local' | 'network' | 'cloud'

export const OFFICIAL_URL: Record<Exclude<ConnectionKind, 'compatible'>, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
}
export const LOCAL_DEFAULT_URL = 'http://localhost:11434/v1'
export const SUGGESTED_MODEL: Partial<Record<ConnectionKind, string>> = { anthropic: 'claude-opus-5-5' }

const parse = (url: string): URL | null => { try { return new URL(url) } catch { return null } }

/** The 8 groups of an IPv6 literal as WHATWG URL spells it (hex groups, optional ::), or null. */
function groups6(h: string): number[] | null {
  const parts = h.split('::')
  if (parts.length > 2) return null
  const side = (s: string) => (s ? s.split(':').map((x) => parseInt(x, 16)) : [])
  const head = side(parts[0]), tail = parts.length === 2 ? side(parts[1]) : []
  const fill = 8 - head.length - tail.length
  if ((parts.length === 1 && fill !== 0) || fill < 0) return null
  const out = [...head, ...Array(parts.length === 2 ? fill : 0).fill(0), ...tail]
  return out.length === 8 && out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null
}

function kind4(a: number, b: number): Reach {
  if (a === 127) return 'local'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'network'
  return 'cloud'
}

/** Whether a host is on this machine, on a private network, or somewhere else. Only literal addresses count. */
export function reach(url: string): Reach {
  const u = parse(url)
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return 'cloud'
  const h = u.hostname.toLowerCase()
  if (h === 'localhost') return 'local'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) return kind4(+v4[1], +v4[2])
  if (h.startsWith('[') && h.endsWith(']')) {
    const g = groups6(h.slice(1, -1))
    if (!g) return 'cloud'
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return kind4(g[6] >> 8, g[6] & 255) // IPv4-mapped
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'local'
    if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) return 'network'
  }
  return 'cloud'
}

export const reachLabel = (r: Reach): string => (r === 'local' ? 'Local' : r === 'network' ? 'Your network' : 'Cloud')

/** Plain text for an address the app would refuse (never repeats the address), or null when it's fine. */
export function validateAddress(url: string): string | null {
  if (url.includes('{{')) return 'The address can’t contain {{variables}}.'
  const u = parse(url.trim())
  if (!u) return 'That isn’t a valid address. Start with https:// (or http:// for a local model).'
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The address must start with https:// (or http:// for a local model).'
  if (u.username || u.password) return 'Addresses with a user name or password in them aren’t allowed.'
  if (!u.hostname) return 'The address has no host.'
  if (u.protocol === 'http:' && reach(url) === 'cloud') return 'Plain http is only allowed for local models (localhost or a private address). Use https.'
  return null
}

export const needsKey = (c: Pick<Connection, 'kind'>): boolean => c.kind !== 'compatible'

export function newConnection(kind: ConnectionKind): Connection {
  const baseUrl = kind === 'compatible' ? LOCAL_DEFAULT_URL : OFFICIAL_URL[kind]
  return {
    id: globalThis.crypto.randomUUID(),
    name: kind === 'anthropic' ? 'Anthropic' : kind === 'openai' ? 'OpenAI' : 'Local model',
    kind, baseUrl, model: SUGGESTED_MODEL[kind] ?? '', key: '',
    readLogs: reach(baseUrl) === 'local', tools: 'unknown',
  }
}

/**
 * Changes the address. The console is only ever on for loopback and never turns itself back on; consent follows the host
 * (with port); a key never travels to another origin. Fixed-address kinds ignore the change.
 */
export function withBaseUrl(c: Connection, url: string): Connection {
  if (c.kind !== 'compatible') return c
  const before = parse(c.baseUrl), after = parse(url)
  const out: Connection = { ...c, baseUrl: url }
  if (reach(url) !== 'local') out.readLogs = false
  if (before?.host.toLowerCase() !== after?.host.toLowerCase() || !after) delete out.consentHost
  if (!before || !after || before.origin !== after.origin || after.origin === 'null') { out.key = ''; delete out.keyLost }
  return out
}

/** What a stored record is trusted to say: fixed kinds keep their official address, only loopback may read the console. */
export function normalizeConnection(c: Connection): Connection {
  const baseUrl = c.kind === 'compatible' ? c.baseUrl : OFFICIAL_URL[c.kind]
  return { ...c, baseUrl, readLogs: c.readLogs === true && reach(baseUrl) === 'local' }
}
