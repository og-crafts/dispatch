/**
 * "Share as HTML": a request, folder or collection as one self-contained, interactive page (shareHtml.ts), with
 * the request, a sample response and curl. Everything that goes in is sanitized first: values under secret-looking
 * names (tokens, passwords, cookies, API keys…) and secret-looking values (JWTs, bearer tokens, AWS keys) are
 * replaced, emails and IP addresses become example values, the server address can be swapped for {{baseUrl}}, and
 * long lists and strings are cut down to a sample. Variables stay as {{name}}: their values are never included.
 */
import { generateCode } from './codegen'
import { prepare } from './prepare'
import { collectItems } from './runner'
import { folderChain } from './runtime'
import type { Collection, Folder, HistoryEntry, HttpResponse, PreparedRequest, RequestDef } from './types'

export interface ShareMeta {
  title: string
  version: string
  author: string
  description: string
  /** Where to ask questions: an email, a channel, a link. Shown as text. */
  contact: string
}

export interface ShareOptions {
  /** Replace the scheme and host of every URL with this ("" keeps the real address). */
  serverAs: string
  /** Shorten arrays to 3 items and strings to 300 characters in bodies. */
  trim: boolean
  includeResponses: boolean
}

export const defaultShareOptions: ShareOptions = { serverAs: '{{baseUrl}}', trim: true, includeResponses: true }

export interface SharedResponse { label: string; status: number; statusText: string; timeMs: number | null; headers: [string, string][]; body: string }
export interface SharedRequest {
  id: string
  name: string
  /** Folders from the collection down, e.g. ["Orders", "Admin"]. */
  path: string[]
  method: string
  url: string
  docs: string
  headers: [string, string][]
  body: string | null
  bodyKind: string
  curl: string
  responses: SharedResponse[]
}
export interface ShareDoc {
  meta: ShareMeta
  scope: 'request' | 'folder' | 'collection'
  collection: string
  generatedAt: string
  /** How many values were replaced. */
  redactions: number
  options: { trimmed: boolean; server: string }
  requests: SharedRequest[]
  /** The tab the page opens on (shared from the response: its Response tab). */
  open?: 'response'
}

export const SECRET_NAME = /(authorization|cookie|token|secret|passw(?:or)?d|(?:^|[-_])pwd$|api[-_]?key|session|credential|signature|private[-_]?key|otp|cvv|ssn|card[-_]?number)/i
export const isSecretName = (name: string) => SECRET_NAME.test(name)
const IS_VAR = /^\s*\{\{[^{}]+\}\}\s*$/
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token)\s+(?!<)(?!\{\{)[A-Za-z0-9._~+/=-]{8,}/g
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
const KEY_VALUE = /([?&;\s,]|^)([\w.-]*(?:token|secret|passw(?:or)?d|api[-_]?key|session|signature)[\w.-]*)=([^&;\s,]+)/gi
const REDACTED = '<redacted>'
const MAX_BODY = 20_000

/** Replaces secrets and personal data, counting what it replaced. */
export class Sanitizer {
  count = 0
  constructor(private o: ShareOptions) {}

  /** Free text: secret-looking values and personal data anywhere in it. */
  text(s: string): string {
    const hit = (to: string) => () => { this.count++; return to }
    return s
      .replace(JWT, hit('<jwt>'))
      .replace(AUTH_SCHEME, (_m, scheme: string) => { this.count++; return `${scheme} ${REDACTED}` })
      .replace(AWS_KEY, hit('<aws-access-key>'))
      .replace(KEY_VALUE, (m, pre: string, k: string, v: string) => (IS_VAR.test(v) || v === REDACTED ? m : (this.count++, `${pre}${k}=${REDACTED}`)))
      .replace(EMAIL, (m) => (m.endsWith('@example.com') ? m : (this.count++, 'user@example.com')))
      .replace(IPV4, (m) => (/^(127\.|0\.0\.0\.0$|203\.0\.113\.)/.test(m) ? m : (this.count++, '203.0.113.10')))
  }

  /** A named value (header, query parameter, JSON key): hidden outright when the name looks secret. */
  value(name: string, v: string): string {
    if (SECRET_NAME.test(name) && v && !IS_VAR.test(v) && v !== REDACTED) {
      this.count++
      const scheme = /^(Bearer|Basic|Digest|Token)\s/i.exec(v)
      return scheme ? `${scheme[1]} ${REDACTED}` : REDACTED
    }
    return this.text(v)
  }

  headers(list: [string, string][]): [string, string][] { return list.map(([k, v]) => [k, this.value(k, v)]) }

  url(u: string): string {
    // A URL that starts with a variable gets a scheme added when it's prepared; show it as written.
    let url = u.replace(/^https?:\/\/(?=\{\{)/i, '')
    if (this.o.serverAs) {
      const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(url)
      if (m && !m[0].includes('{{')) url = this.o.serverAs.replace(/\/+$/, '') + url.slice(m[0].length)
    }
    const q = url.indexOf('?')
    if (q < 0) return this.text(url)
    const [query, hash = ''] = url.slice(q + 1).split('#')
    const params = query.split('&').map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      const k = pair.slice(0, eq)
      let name = k
      try { name = decodeURIComponent(k) } catch { /* keep as is */ }
      return `${k}=${this.value(name, pair.slice(eq + 1))}`
    })
    return `${this.text(url.slice(0, q))}?${params.join('&')}${hash ? `#${hash}` : ''}`
  }

  /** JSON: secret keys hidden, strings cleaned, and (with trim) a sample of long lists and strings. */
  json(v: unknown, key = ''): unknown {
    if (typeof v === 'string') {
      const s = key && SECRET_NAME.test(key) ? this.value(key, v) : this.text(v)
      return this.o.trim && s.length > 300 ? `${s.slice(0, 300)}…` : s
    }
    if (typeof v === 'number' && key && SECRET_NAME.test(key)) { this.count++; return 0 }
    if (Array.isArray(v)) return (this.o.trim ? v.slice(0, 3) : v).map((x) => this.json(x, key))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.json(x, k)]))
    return v
  }

  body(s: string): string {
    const t = s.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return JSON.stringify(this.json(JSON.parse(t)), null, 2) } catch { /* not JSON after all */ }
    }
    const out = this.text(s)
    return out.length > MAX_BODY ? `${out.slice(0, MAX_BODY)}\n… (cut)` : out
  }
}

const statusText = (r: HttpResponse) => r.statusText || ''

export interface ShareSource {
  collections: Collection[]
  folders: Folder[]
  requests: RequestDef[]
  history: HistoryEntry[]
}

export type ShareTarget = { kind: 'request'; requestId: string; draft?: RequestDef; lastResponse?: HttpResponse | null; open?: 'response' } | { kind: 'folder'; folderId: string } | { kind: 'collection'; collectionId: string }

/** The requests a target covers, in collection order, with their folder path. */
function targetItems(t: ShareTarget, src: ShareSource): { request: RequestDef; path: string[]; collection: Collection | null }[] {
  if (t.kind === 'request') {
    const r = t.draft ?? src.requests.find((x) => x.id === t.requestId)
    if (!r) return []
    const col = src.collections.find((c) => c.id === r.collectionId) ?? null
    return [{ request: r, path: folderChain(src.folders, r.folderId).reverse().map((f) => f.name), collection: col }]
  }
  const folder = t.kind === 'folder' ? src.folders.find((f) => f.id === t.folderId) : undefined
  const col = src.collections.find((c) => c.id === (t.kind === 'collection' ? t.collectionId : folder?.collectionId))
  if (!col) return []
  return collectItems(col, folder?.id ?? null, src.folders, src.requests)
    .filter((x) => x.request.protocol === 'http')
    .map((x) => ({ request: x.request, path: x.path.split(' / ').slice(1), collection: col }))
}

/** Builds the sanitized data for the page. Nothing unsanitized leaves this function. */
export function buildShare(t: ShareTarget, src: ShareSource, meta: ShareMeta, o: ShareOptions, now = new Date()): ShareDoc {
  const s = new Sanitizer(o)
  const items = targetItems(t, src)
  const requests: SharedRequest[] = items.map(({ request: r, path, collection }) => {
    // Variables stay as {{name}}: no environment, no globals, and the collection's variables left out.
    const p: PreparedRequest = prepare(r, { collection: collection ? { ...collection, variables: [] } : null, folders: folderChain(src.folders, r.folderId), environment: null, globals: [] })
    const clean: PreparedRequest = {
      ...p,
      url: s.url(p.url),
      headers: s.headers(p.headers),
      body: p.body == null ? null : s.body(p.body),
      // Form fields are cleaned like headers; file parts keep only their name (never their bytes).
      multipart: p.multipart ? p.multipart.map((part) => (part.file ? { name: part.name, file: { ...part.file, base64: '' } } : { ...part, value: s.value(part.name, part.value ?? '') })) : p.multipart,
      bodyFile: p.bodyFile ? { ...p.bodyFile, base64: '' } : p.bodyFile,
    }
    const responses: SharedResponse[] = []
    if (o.includeResponses) {
      const latest = t.kind === 'request' && t.lastResponse ? t.lastResponse : src.history.find((h) => h.request.id === r.id && h.response)?.response
      if (latest) {
        responses.push({
          label: 'Last response', status: latest.status, statusText: statusText(latest), timeMs: latest.timeMs ?? null, headers: s.headers(latest.headers),
          body: latest.binary ? `(binary, ${latest.size} bytes)` : s.body(latest.body),
        })
      }
      for (const e of r.examples) responses.push({ label: e.name || 'Example', status: e.status, statusText: '', timeMs: null, headers: s.headers(e.headers), body: s.body(e.body) })
    }
    return {
      id: r.id, name: r.name, path, method: r.method, url: clean.url, docs: s.text(r.docs ?? ''),
      headers: clean.headers, body: clean.body, bodyKind: r.body.kind, curl: generateCode('curl', clean), responses,
    }
  })
  const first = items[0]
  return {
    meta: {
      title: meta.title.trim() || (t.kind === 'request' ? first?.request.name ?? 'Request' : first?.collection?.name ?? 'API'),
      version: meta.version.trim(), author: meta.author.trim(), description: meta.description.trim(), contact: meta.contact.trim(),
    },
    scope: t.kind,
    collection: first?.collection?.name ?? '',
    generatedAt: now.toISOString(),
    redactions: s.count,
    options: { trimmed: o.trim, server: o.serverAs },
    requests,
    ...(t.kind === 'request' && t.open ? { open: t.open } : {}),
  }
}
