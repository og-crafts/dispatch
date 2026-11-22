import { useEffect, useMemo, useRef, useState } from 'react'
import { contentType, formatBytes, formatMs, prettyJson, prettyXml, statusTone } from '../core/format'
import { toCurl } from '../core/curl'
import { queryJson } from '../core/jsonpath'
import { parseSetCookie } from '../core/cookies'
import { uid } from '../core/types'
import type { WorkspaceApi } from './useWorkspace'
import { CodeArea } from './CodeArea'
import { Icon } from './Icons'
import type { Editor, Lang } from './editor/codemirror'
import { ResponseHistory, useRequestHistory } from './ResponseHistory'

type Tab = 'body' | 'preview' | 'visualize' | 'headers' | 'cookies' | 'tests' | 'history' | 'sent'

/** Shows long bodies in full only on request, so a huge response doesn't freeze the page. */
/** Bodies up to this size open in the code viewer (colours, matching brackets, folding); it only draws what's on screen. */
const VIEWER_LIMIT = 5_000_000
/** Bigger bodies show their start as plain text until "Show all". */
const PREVIEW_LIMIT = 200_000

export interface FileSaver { (fileName: string, data: { text?: string; base64?: string }, type: string): Promise<boolean> }

const extFor = (ct: string) => ct.includes('json') ? 'json' : ct.includes('html') ? 'html' : ct.includes('xml') ? 'xml' : ct.includes('png') ? 'png'
  : ct.includes('jpeg') ? 'jpg' : ct.includes('gif') ? 'gif' : ct.includes('pdf') ? 'pdf' : ct.includes('csv') ? 'csv' : ct.startsWith('text/') ? 'txt' : 'bin'

export function ResponsePane({ ws, notify, saveFile, onShare }: { ws: WorkspaceApi; notify: (m: string) => void; saveFile?: FileSaver; onShare?: () => void }) {
  const { result, sending } = ws
  const earlier = useRequestHistory(ws)
  const [showEarlier, setShowEarlier] = useState(false)
  const [tab, setTab] = useState<Tab>('body')
  const [raw, setRaw] = useState(false)
  const [full, setFull] = useState(false)
  const [filter, setFilter] = useState('')
  const res = result?.response ?? null
  useEffect(() => setFull(false), [result])
  const ct = res ? contentType(res.headers) : ''
  const pretty = useMemo(() => (res && !res.binary ? prettyJson(res.body) : null), [res])
  const filtered = useMemo(() => {
    if (!filter.trim() || !res || pretty == null) return null
    try { return { text: JSON.stringify(queryJson(JSON.parse(res.body), filter), null, 2), error: null } } catch (e) { return { text: '', error: e instanceof Error ? e.message : String(e) } }
  }, [filter, res, pretty])
  const isXml = !!res && !res.binary && pretty == null && (/[/+]xml\b/.test(ct) || /^\s*<\?xml/.test(res.body.slice(0, 100)))
  const prettyX = useMemo(() => (isXml && res ? prettyXml(res.body) : null), [isXml, res])
  const shown = !res ? '' : filtered && !filtered.error ? filtered.text : raw ? res.body : pretty ?? prettyX ?? res.body
  // The language the viewer colours and folds by; Raw shows the body exactly as it came, as plain text.
  const lang: Lang = raw ? 'text' : (filtered && !filtered.error) || pretty != null ? 'json' : isXml ? 'xml' : ct.includes('html') ? 'html' : /javascript|ecmascript/.test(ct) ? 'javascript' : 'text'
  const huge = shown.length > VIEWER_LIMIT
  const truncated = huge && shown.length > PREVIEW_LIMIT && !full
  const viewer = useRef<Editor | null>(null)
  const foldable = !huge && lang !== 'text'
  const cookies = useMemo(() => (res ? res.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => parseSetCookie(v)) : []), [res])
  const tests = result?.tests ?? []
  const passed = tests.filter((t) => t.passed).length
  const isHtml = ct.includes('html')
  const isImage = ct.startsWith('image/') && !!res?.base64
  const canPreview = !!res && (isHtml || isImage)

  // Keep the chosen tab when it exists for this response; otherwise fall back.
  // The newest history entry is usually this very response; leave it out of "earlier".
  const older = earlier.filter((h) => !(res && h.response && h.response.timeMs === res.timeMs && h.response.size === res.size && h.response.status === res.status && h === earlier[0]))
  const avail: Tab[] = res ? ['body', ...(result?.visualizer ? ['visualize' as Tab] : []), ...(canPreview ? ['preview' as Tab] : []), 'headers', ...(cookies.length ? ['cookies' as Tab] : []), ...(tests.length ? ['tests' as Tab] : []), ...(older.length ? ['history' as Tab] : []), 'sent'] : [...(tests.length ? ['tests' as Tab] : []), 'sent']
  const current: Tab = avail.includes(tab) ? tab : avail[0]

  const saveBody = async () => {
    if (!res || !saveFile) return
    try { if (await saveFile(`response.${extFor(ct)}`, res.binary ? { base64: res.base64 } : { text: res.body }, ct || 'application/octet-stream')) notify('Response saved.') } catch (e) { notify(`Couldn’t save: ${String(e)}`) }
  }
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); notify(`${what} copied.`) } catch { notify('Couldn’t reach the clipboard.') }
  }

  if (sending) return <section className="response empty" aria-label="Response" aria-busy="true"><p className="pulse">Sending…</p></section>
  if (!result) {
    return (
      <section className="response empty" aria-label="Response">
        <div className="emptyInner">
          <p className="lead">Send a request to see the response here.</p>
          <p className="muted small">Tip: paste a curl command into the URL bar to import it.</p>
          {earlier.length > 0 && <>
            <button type="button" className="btn small" onClick={() => setShowEarlier(!showEarlier)}>{showEarlier ? 'Hide' : 'Show'} earlier responses ({earlier.length})</button>
            {showEarlier && <ResponseHistory ws={ws} entries={earlier} current={null} />}
          </>}
        </div>
      </section>
    )
  }

  const label: Record<Tab, React.ReactNode> = {
    body: 'Body', preview: 'Preview', visualize: 'Visualize', headers: <>Headers<span className="badge">{res?.headers.length}</span></>,
    cookies: <>Cookies<span className="badge">{cookies.length}</span></>,
    history: <>History<span className="badge">{older.length}</span></>,
    tests: <>Tests<span className={`badge ${passed === tests.length ? 'goodBadge' : 'badBadge'}`}>{passed}/{tests.length}</span></>, sent: 'Sent',
  }

  return (
    <section className="response" aria-label="Response">
      <div className="resHead">
        {res ? <span className={`postmark ${statusTone(res.status)}`}>
          <span className={`status ${statusTone(res.status)}`}>{res.status} {res.statusText}</span>
          <span className="metric" title={res.timings ? `Waiting for first byte ${formatMs(res.timings.ttfbMs)}, download ${formatMs(res.timings.downloadMs)}` : 'Time'}>
            {formatMs(res.timeMs)}{res.timings && <span className="muted"> (first byte {formatMs(res.timings.ttfbMs)})</span>}
          </span>
          <span className="metric" title="Size">{formatBytes(res.size)}</span>
        </span> : <span className="status bad">{result.error?.startsWith('Skipped') ? 'Skipped' : 'Not sent'}</span>}
        {tests.length > 0 && <span className={`metric ${passed === tests.length ? 'goodText' : 'badText'}`}>{passed}/{tests.length} tests passed</span>}
        <span className="grow" />
        {res && onShare && <button type="button" className="btn ghost small withIcon" onClick={onShare} title="Save the request and this response as one HTML page anyone can open: tabs, copy buttons, foldable JSON. Secrets and personal values are left out.">
          <Icon name="share" size={14} /> Share</button>}
        <button type="button" className="btn ghost small" onClick={() => copy(toCurl(result.sent), 'curl command')}>Copy as curl</button>
        {res && !res.binary && <button type="button" className="btn ghost small" onClick={() => copy(res.body, 'Body')}>Copy body</button>}
        {res && saveFile && <button type="button" className="btn ghost small" onClick={() => void saveBody()}>Save to file</button>}
        {res && !res.binary && <button type="button" className="btn ghost small" onClick={() => {
          ws.setDraft((d) => ({ ...d, examples: [...d.examples, { id: uid(), name: `${res.status} ${res.statusText}`.trim(), status: res.status, headers: res.headers, body: res.body }] }))
          notify('Saved as an example on this request (save the request to keep it).')
        }}>Save as example</button>}
      </div>
      {result.error && <p className="errorBox" role="alert">{result.error}</p>}
      <div className="tabs" role="tablist" aria-label="Response parts">
        {avail.map((t) => <button key={t} type="button" role="tab" aria-selected={current === t} className={current === t ? 'on' : ''} onClick={() => setTab(t)}>{label[t]}</button>)}
        {res && current === 'body' && !res.binary && res.body !== '' && <span className="bodyTools">
          {pretty != null && <input className="mono jsonFilter" placeholder="Filter: $.items[*].id" aria-label="JSON filter" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          {foldable && <>
            <button type="button" className="btn small ghost" onClick={() => viewer.current?.collapseAll()} title="Fold every block to its first line">Collapse all</button>
            <button type="button" className="btn small ghost" onClick={() => viewer.current?.expandAll()}>Expand all</button>
          </>}
          {(pretty != null || prettyX != null) && <label className="toggle small"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw</label>}
        </span>}
      </div>
      <div className="tabBody" role="tabpanel">
        {res && current === 'body' && (res.binary
          ? <p className="muted">Binary body ({ct || 'unknown type'}, {formatBytes(res.size)}). {canPreview ? 'See Preview, or save it to a file.' : 'Save it to a file to open it.'}</p>
          : res.body === '' ? <p className="muted">Empty body.</p>
          : <>
              {filtered?.error && <p className="warnLine small">Filter: {filtered.error}</p>}
              {huge && <div className="bigBody small" role="status">
                <span>{truncated ? <>Showing the first {formatBytes(PREVIEW_LIMIT)} of {formatBytes(shown.length)}, as plain text.</> : <>All {formatBytes(shown.length)}, as plain text (too big to colour and fold).</>}{pretty != null && !filtered ? ' The filter can narrow it down.' : ''}</span>
                {truncated && <button type="button" className="btn small" onClick={() => setFull(true)}>Show all</button>}
                {saveFile && <button type="button" className="btn small ghost" onClick={() => void saveBody()}>Save to file</button>}
              </div>}
              {huge
                ? <pre className="code mono out">{truncated ? shown.slice(0, PREVIEW_LIMIT) : shown}</pre>
                : <CodeArea key={`${res.timeMs}-${res.size}-${lang}`} label="Response body" lang={lang} readOnly value={shown} onChange={() => {}} rows={20} editorRef={viewer} />}
            </>)}
        {res && current === 'preview' && (isImage
          ? <img className="imgPreview" alt="Response image" src={`data:${ct};base64,${res.base64}`} />
          : <>
              <p className="muted small">Shown in a sandbox: scripts, forms and links in the page don’t run.</p>
              <iframe className="htmlPreview" title="Response preview" sandbox="" srcDoc={res.body} />
            </>)}
        {current === 'visualize' && result.visualizer && <>
          <p className="muted small">Made by <code>dx.visualize()</code> in a script, shown in a sandbox{ws.transport.unrestricted ? ' (scripts inside the template run in the web version only)' : ''}.</p>
          <iframe className="htmlPreview" title="Visualization" sandbox="allow-scripts" srcDoc={result.visualizer.html} />
        </>}
        {res && current === 'headers' && (
          <table className="kv readonly" aria-label="Response headers">
            <tbody>{res.headers.map(([k, v], i) => <tr key={i}><th className="mono">{k}</th><td className="mono">{v}</td></tr>)}</tbody>
          </table>
        )}
        {res && current === 'cookies' && (
          <table className="kv readonly" aria-label="Response cookies">
            <thead><tr><th>Name</th><td className="small muted">Value · attributes</td></tr></thead>
            <tbody>{cookies.map((c, i) => <tr key={i}><th className="mono">{c.name}</th><td className="mono">{c.value}<span className="muted small">{[c.domain && ` · domain ${c.domain}`, c.path && ` · path ${c.path}`, c.expires && ` · expires ${c.expires}`, c.httpOnly && ' · HttpOnly', c.secure && ' · Secure', c.sameSite && ` · SameSite=${c.sameSite}`].filter(Boolean).join('')}</span></td></tr>)}</tbody>
          </table>
        )}
        {current === 'tests' && (
          <ul className="testList" aria-label="Test results">
            {tests.map((t, i) => (
              <li key={i} className={t.passed ? 'pass' : 'fail'}>
                <span className="testMark" aria-label={t.passed ? 'passed' : 'failed'}>{t.passed ? '✓' : '✗'}</span>
                <span>{t.name}{t.error && <span className="testErr mono small">{t.error}</span>}</span>
              </li>
            ))}
          </ul>
        )}
        {current === 'history' && <ResponseHistory ws={ws} entries={older} current={res} />}
        {current === 'sent' && (
          <div>
            <p className="muted small">Exactly what was sent, after scripts, variables and auth.</p>
            <pre className="code mono out">{`${result.sent.method} ${result.sent.url}\n${result.sent.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}${result.sent.body ? `\n\n${result.sent.body}` : result.sent.multipart ? `\n\n[form-data: ${result.sent.multipart.map((p) => p.file ? `${p.name}=<${p.file.name}>` : `${p.name}=${p.value}`).join(', ')}]` : result.sent.bodyFile ? `\n\n[file: ${result.sent.bodyFile.name}]` : ''}`}</pre>
          </div>
        )}
      </div>
    </section>
  )
}
