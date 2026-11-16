import { useEffect, useMemo, useRef, useState } from 'react'
import { type ShareMeta, type ShareOptions, type ShareTarget, buildShare, defaultShareOptions } from '../core/share'
import { renderShareHtml } from '../core/shareHtml'
import { saveTextFile } from './files'
import type { WorkspaceApi } from './useWorkspace'

const AUTHOR_KEY = 'dispatch.shareAuthor'
const remembered = (k: string) => { try { return localStorage.getItem(k) ?? '' } catch { return '' } }
const remember = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private window */ } }
const slug = (s: string) => s.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'api'

/** "Share as HTML…": who it's from and what version, how much to include, then save one interactive page. */
export function ShareDialog({ ws, target, onClose, notify }: { ws: WorkspaceApi; target: ShareTarget; onClose: () => void; notify: (m: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const d = ref.current; if (d && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '') } }, [])

  const src = { collections: ws.allCollections, folders: ws.folders, requests: ws.requests, history: ws.history }
  const defaultTitle = target.kind === 'request' ? (target.draft ?? ws.requests.find((r) => r.id === target.requestId))?.name ?? 'Request'
    : target.kind === 'folder' ? ws.folders.find((f) => f.id === target.folderId)?.name ?? 'Folder'
    : ws.allCollections.find((c) => c.id === target.collectionId)?.name ?? 'Collection'
  const [meta, setMeta] = useState<ShareMeta>({ title: defaultTitle, version: '1.0.0', author: remembered(AUTHOR_KEY), description: '', contact: '' })
  const [opts, setOpts] = useState<ShareOptions>(defaultShareOptions)
  const doc = useMemo(() => buildShare(target, src, meta, opts), [target, meta, opts, ws.requests, ws.history, ws.folders, ws.allCollections]) // eslint-disable-line react-hooks/exhaustive-deps
  const responses = doc.requests.reduce((n, r) => n + r.responses.length, 0)
  const setM = (p: Partial<ShareMeta>) => setMeta((m) => ({ ...m, ...p }))
  const setO = (p: Partial<ShareOptions>) => setOpts((o) => ({ ...o, ...p }))

  const save = async () => {
    remember(AUTHOR_KEY, meta.author.trim())
    const name = `${slug(doc.meta.title)}${doc.meta.version ? `-${slug(doc.meta.version)}` : ''}.html`
    try {
      if (await saveTextFile(name, renderShareHtml(doc), 'text/html')) { notify(`Saved ${name}. Open it in any browser; it works offline.`); onClose() }
    } catch (e) { notify(`Couldn’t save: ${String(e)}`) }
  }

  return (
    <dialog ref={ref} className="dialog shareDialog" aria-labelledby="share-title" onClose={onClose} onCancel={onClose}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <h2 id="share-title">Share as an HTML page</h2>
        <p className="muted small">One file anyone can open in a browser, with no account and no internet needed: each request, a sample response and curl, which they can search and copy from.</p>
        <div className="shareGrid">
          <label className="field wide"><span>Title</span><input value={meta.title} onChange={(e) => setM({ title: e.target.value })} required /></label>
          <label className="field"><span>Version</span><input value={meta.version} placeholder="1.0.0" onChange={(e) => setM({ version: e.target.value })} /></label>
          <label className="field"><span>Author or team</span><input value={meta.author} placeholder="Platform team" onChange={(e) => setM({ author: e.target.value })} /></label>
          <label className="field wide"><span>Contact (optional)</span><input value={meta.contact} placeholder="email, chat channel or link" onChange={(e) => setM({ contact: e.target.value })} /></label>
          <label className="field wide"><span>Description (optional)</span><textarea rows={3} value={meta.description} placeholder="What this is for, how to get access, anything the reader should know first" onChange={(e) => setM({ description: e.target.value })} /></label>
        </div>
        <fieldset className="shareOpts">
          <legend className="small muted">What goes in</legend>
          <label className="field"><span>Show the server address as</span>
            <input className="mono" value={opts.serverAs} placeholder="(the real address)" aria-describedby="share-server-hint" onChange={(e) => setO({ serverAs: e.target.value })} />
          </label>
          <p id="share-server-hint" className="tiny muted">Leave empty to keep the real address. <code>{'{{baseUrl}}'}</code> keeps internal host names out of the file.</p>
          <label className="toggle"><input type="checkbox" checked={opts.includeResponses} onChange={(e) => setO({ includeResponses: e.target.checked })} /> Include sample responses (the last one received, and saved examples)</label>
          <label className="toggle"><input type="checkbox" checked={opts.trim} onChange={(e) => setO({ trim: e.target.checked })} /> Shorten long lists to 3 items and long texts to 300 characters</label>
        </fieldset>
        <p className="shareSummary small" role="status">
          <b>{doc.requests.length}</b> request{doc.requests.length === 1 ? '' : 's'}{opts.includeResponses ? <>, <b>{responses}</b> sample response{responses === 1 ? '' : 's'}</> : null}.{' '}
          {doc.redactions ? <><b>{doc.redactions}</b> value{doc.redactions === 1 ? '' : 's'} that look secret or personal (tokens, passwords, cookies, keys, emails, IPs) will be replaced.</> : 'Nothing secret-looking was found.'}{' '}
          Variables stay as <code>{'{{name}}'}</code>; their values aren’t included.
        </p>
        <p className="tiny muted">Checks are automatic and can miss things: look the page over before sending it outside your team.</p>
        <div className="actions end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!doc.requests.length}>Save HTML file</button>
        </div>
      </form>
    </dialog>
  )
}
