export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}

export type StatusTone = 'good' | 'info' | 'warn' | 'bad'
export function statusTone(status: number): StatusTone {
  if (status >= 200 && status < 300) return 'good'
  if (status >= 300 && status < 400) return 'info'
  if (status >= 400 && status < 500) return 'warn'
  return 'bad'
}

export function contentType(headers: [string, string][]): string {
  return headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1].toLowerCase() ?? ''
}

/** Pretty-prints JSON bodies; returns null when the body isn't JSON. */
export function prettyJson(body: string): string | null {
  const t = body.trim()
  if (!t || !/^[[{"\d-]|^(true|false|null)$/.test(t)) return null
  try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return null }
}

/**
 * XML indented two spaces per level, or null when the text isn't XML this can lay out safely (unbalanced tags).
 * Text that sits alone inside an element stays on its line (`<name>Rex</name>`); CDATA, comments and processing
 * instructions are kept as they are. Whitespace between tags is dropped; whitespace inside text is kept.
 */
export function prettyXml(body: string): string | null {
  const t = body.trim()
  if (!t.startsWith('<') || t.length > 5_000_000) return null
  const parts = t.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<[^>]+>|[^<]+/g)
  if (!parts) return null
  const out: string[] = []
  const open: string[] = []
  const pad = () => '  '.repeat(open.length)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p.startsWith('<')) { if (p.trim()) out.push(pad() + p.trim()); continue }
    if (/^<\//.test(p)) {
      const name = p.slice(2, -1).trim()
      if (open.pop() !== name) return null
      out.push(pad() + p)
    } else if (/^<[A-Za-z_]/.test(p) && !p.endsWith('/>')) {
      const name = /^<([^\s/>]+)/.exec(p)![1]
      // <a>text</a> on one line.
      const text = parts[i + 1], close = parts[i + 2]
      if (text !== undefined && !text.startsWith('<') && close === `</${name}>`) { out.push(pad() + p + text.trim() + close); i += 2; continue }
      if (text !== undefined && text.startsWith(`</${name}`) && /^<\/[^>]+>$/.test(text) && text.slice(2, -1).trim() === name) { out.push(pad() + p + text); i += 1; continue }
      out.push(pad() + p)
      open.push(name)
    } else out.push(pad() + p)
  }
  return open.length ? null : out.join('\n')
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(at).toLocaleDateString()
}
