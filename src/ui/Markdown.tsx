import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'

/**
 * A small Markdown renderer that builds React elements (never raw HTML), so docs from an imported collection can't
 * inject scripts. Supports headings, paragraphs, **bold**, *italic*, `code`, [links](https://…), lists, > quotes,
 * fenced code blocks, tables and horizontal rules.
 *
 * `untrusted` is for a model's output: images are never loaded (their words and address show as text), a link is its
 * whole address and goes nowhere but to `open`, on a click, and code has a Copy button. Very long text stays plain.
 */
export interface Untrusted { open: (url: string) => void }
export function Markdown({ text, untrusted }: { text: string; untrusted?: Untrusted }) {
  if (untrusted && text.length > LONG_TEXT) return <div className="markdown plain">{text}</div>
  return <div className="markdown">{blocks(text, untrusted)}</div>
}

const LONG_TEXT = 100_000, LONG_LINE = 4000, DEEPEST = 20

/** The address as it would be opened (look-alike letters and odd characters encoded), or null when it isn't one to open. */
function openable(address: string): string | null {
  try {
    const u = new URL(address)
    return /^https?:\/\//i.test(address) || u.protocol === 'mailto:' ? u.href : null
  } catch { return null }
}

/** The whole address, with nothing to follow, drag or open in a new window (a button couldn't wrap with the text). */
const address = (href: string, u: Untrusted, key: number) => (
  <span key={key} role="link" tabIndex={0} className="linkBtn address" onClick={() => u.open(href)}
    onKeyDown={(e) => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); u.open(href) } }}>{href}</span>
)

function CodeBlock({ code }: { code: string }) {
  const [said, setSaid] = useState('Copy')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    let next = 'Copied'
    try { await navigator.clipboard.writeText(code) } catch { next = 'Couldn’t copy' }
    setSaid(next); clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaid('Copy'), 2000)
  }
  return <div className="codeBlock"><button type="button" className="btn small" aria-label={said === 'Copy' ? 'Copy code' : said} onClick={() => void copy()}>{said}</button><pre><code>{code}</code></pre></div>
}

/** Bounded, so that no line takes long. In order: code, image (also inside a link), link, bold, italic, bare address. */
const TARGET = String.raw`\(<?([^)\s>]{0,2000})>?(?:\s+"[^"]{0,500}")?\)`
const UNTRUSTED = new RegExp(String.raw`(`+'`[^`]+`'+String.raw`)|(\[?!\[([^\]]{0,500})\]`+TARGET+String.raw`(?:\]`+TARGET+String.raw`)?)|(\[([^\]]{1,500})\]`+TARGET+String.raw`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_(?!\w))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*\]])`, 'g')

function untrustedInline(s: string, u: Untrusted, key = 0): ReactNode[] {
  if (s.length > LONG_LINE) return [s]
  const out: ReactNode[] = []
  let last = 0, k = key
  for (const m of s.matchAll(UNTRUSTED)) {
    if (m.index! > last) out.push(s.slice(last, m.index))
    last = m.index! + m[0].length
    const [t, code, image, alt, src, around, link, label, href, bold, italic] = m
    if (code) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (image) out.push(<span key={k++} className="muted">{`[image not shown: ${alt ? `${alt}, ` : ''}${src}]${around ? ` (${around})` : ''}`}</span>)
    else if (link) {
      const to = openable(href)
      if (to && label !== to && label !== href) out.push(`${label} `)
      out.push(to ? address(to, u, k++) : `${label} (${href})`)
    } else if (bold) out.push(<strong key={k++}>{untrustedInline(t.slice(2, -2), u, k * 100)}</strong>)
    else if (italic && italic[0] === '_' && /\w/.test(s[m.index! - 1] ?? '')) out.push(t) // part of a name
    else if (italic) out.push(<em key={k++}>{untrustedInline(t.slice(1, -1), u, k * 100)}</em>)
    else { const to = openable(t); out.push(to ? address(to, u, k++) : t) }
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

function inline(s: string, key = 0, u?: Untrusted): ReactNode[] {
  if (u) return untrustedInline(s, u, key)
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = key
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++}>{inline(t.slice(2, -2), k * 100)}</strong>)
    else if (m[3]) out.push(<em key={k++}>{inline(t.slice(1, -1), k * 100)}</em>)
    else if (m[4]) {
      const lm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!
      const href = safeHref(lm[2])
      out.push(href ? <a key={k++} href={href} target="_blank" rel="noreferrer noopener">{inline(lm[1], k * 100)}</a> : lm[1])
    } else if (m[5]) out.push(<a key={k++} href={t} target="_blank" rel="noreferrer noopener">{t}</a>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

const safeHref = (h: string) => (/^(https?:|mailto:|#)/i.test(h) ? h : null)

function blocks(text: string, u?: Untrusted, depth = 0): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    // a pathological line would keep the patterns below busy
    if (u && line.length > LONG_LINE) { out.push(<p key={k++}>{line}</p>); i++; continue }
    const open = u && line.match(/^(\s*)(`{3,})[^`]*$/)
    if (open) {
      const body: string[] = [], end = new RegExp(`^\\s*\`{${open[2].length},}\\s*$`), indent = new RegExp(`^\\s{0,${open[1].length}}`)
      i++
      while (i < lines.length && !end.test(lines[i])) body.push(lines[i++].replace(indent, ''))
      i++
      out.push(<CodeBlock key={k++} code={body.join('\n')} />)
      continue
    }
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      out.push(<pre key={k++}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const level = Math.min(4, h[1].length + 1) // a doc's "#" sits under the page title
      const content = inline(h[2], 0, u)
      out.push(level === 2 ? <h2 key={k++}>{content}</h2> : level === 3 ? <h3 key={k++}>{content}</h3> : <h4 key={k++}>{content}</h4>)
      i++
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push(<hr key={k++} />); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(<table key={k++}><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, 0, u)}</th>)}</tr></thead><tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, n) => <td key={n}>{inline(c, 0, u)}</td>)}</tr>)}</tbody></table>)
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))
      const lis = items.map((it, j) => <li key={j}>{inline(it, 0, u)}</li>)
      out.push(ordered ? <ol key={k++} start={u ? parseInt(line, 10) || undefined : undefined}>{lis}</ol> : <ul key={k++}>{lis}</ul>)
      continue
    }
    if (line.startsWith('>') && depth < DEEPEST) {
      const q: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''))
      out.push(<blockquote key={k++}>{blocks(q.join('\n'), u, depth + 1)}</blockquote>)
      continue
    }
    // Always take the current line, so a line no other rule wanted can't stall the loop.
    const para: string[] = [lines[i++]]
    while (i < lines.length && lines[i].trim() && !(u ? /^(#{1,4}\s|\s*```|>|\s*([-*+]|\d+[.)])\s+|\s*\|)/ : /^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+|\s*\|)/).test(lines[i])) para.push(lines[i++])
    out.push(<p key={k++}>{para.map((p, j) => <Fragment key={j}>{j > 0 && ' '}{inline(p, j * 1000, u)}</Fragment>)}</p>)
  }
  return out
}
