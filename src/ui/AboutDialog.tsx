/** Menu → About Dispatch: the version this copy runs, where it comes from, and every release's changes. */
import { RELEASES, inlineParts } from '../core/changelog'
import { VERSION } from '../core/version'
import { isDesktop } from '../core/transport'
import { openExternal, useModal } from './PrivacyDialogs'
import { CHANNEL } from './telemetry'

const LINKS: [string, string][] = [
  ['Website', 'https://dispatch.ogcrafts.cloud/'],
  ['Source code', 'https://github.com/og-crafts/dispatch'],
  ['Privacy', 'https://dispatch.ogcrafts.cloud/privacy/'],
  ['Licence (MIT)', 'https://github.com/og-crafts/dispatch/blob/main/LICENSE'],
]

const CHANNEL_LABEL: Record<string, string> = { snapshot: 'snapshot', dev: 'development build', release: '' }

/** "Dispatch 0.1.0 (snapshot), desktop app": what a bug report needs. */
export function versionLine(channel: string = CHANNEL, desktop = isDesktop()) {
  const c = CHANNEL_LABEL[channel] ?? channel
  return `Dispatch ${VERSION}${c ? ` (${c})` : ''}, ${desktop ? 'desktop' : 'web'} app`
}

function Inline({ text }: { text: string }) {
  return <>{inlineParts(text).map((p, i) => p.kind === 'code' ? <code key={i}>{p.text}</code> : p.kind === 'bold' ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>)}</>
}

export function AboutDialog({ onClose, notify }: { onClose: () => void; notify: (m: string) => void }) {
  const ref = useModal()
  const close = () => { ref.current?.close?.(); onClose() }
  const copy = async () => {
    try { await navigator.clipboard.writeText(versionLine()); notify('Version copied.') } catch { notify(versionLine()) }
  }
  const channel = CHANNEL_LABEL[CHANNEL] ?? CHANNEL
  return (
    <dialog ref={ref} className="dialog aboutDialog" aria-labelledby="about-title" onClose={onClose} onCancel={onClose}>
      <div className="aboutHead">
        <img src="./icon.svg" alt="" width="48" height="48" />
        <div>
          <h2 id="about-title">Dispatch</h2>
          <p className="aboutVersion">Version <b>{VERSION}</b>{channel && <span className="muted"> · {channel}</span>}<span className="muted"> · {isDesktop() ? 'desktop' : 'web'} app</span></p>
        </div>
        <button type="button" className="btn small ghost" onClick={() => void copy()} title="Copy the version for a bug report">Copy</button>
      </div>
      <p className="muted small">A local-first API client by OGCrafts. Your requests, responses and secrets stay on this computer.</p>
      <p className="aboutLinks small">
        {LINKS.map(([label, url]) => <button key={url} type="button" className="linkBtn" onClick={() => void openExternal(url)}>{label}</button>)}
      </p>
      <h3 className="aboutWhatsNew">What’s new</h3>
      <div className="aboutReleases" tabIndex={0} aria-label="Changes in each release">
        {RELEASES.map((r, i) => (
          <details key={r.version} open={i === 0} className="aboutRelease">
            <summary><b>{r.version}</b> <span className="muted small">{r.date}</span>{r.version === VERSION && <span className="aboutYours small">this version</span>}</summary>
            <p className="small">{r.title}</p>
            <ul className="small">{r.changes.map((c) => <li key={c}><Inline text={c} /></li>)}</ul>
          </details>
        ))}
      </div>
      <div className="actions end">
        <button type="button" className="btn primary" onClick={close} autoFocus>Close</button>
      </div>
    </dialog>
  )
}
