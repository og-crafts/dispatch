/** The first-launch question about usage and error reports, and the feedback form (GitHub issue or e-mail). */
import { useEffect, useRef, useState } from 'react'
import { version } from '../../package.json'
import { isDesktop } from '../core/transport'
import { CHANNEL, telemetryAvailable, track } from './telemetry'

const PRIVACY_URL = 'https://dispatch.ogcrafts.cloud/privacy/'
const ISSUES_URL = 'https://github.com/og-crafts/dispatch/issues/new'
const EMAIL = 'hello@ogcrafts.cloud'

function useModal() {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const d = ref.current; if (d && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '') } }, [])
  return ref
}

/** Opens a link in the system browser (desktop) or a new tab (web). */
export async function openExternal(url: string) {
  if (isDesktop()) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('open_url', { url }) }
  else window.open(url, '_blank', 'noopener')
}

/** What each choice sends, in the words the person sees (kept in step with the privacy policy). */
export const USAGE_TEXT = 'Anonymous usage: which features are used (for example “sent an HTTP request”, “imported OpenAPI”), the app version, operating system and language. Never your URLs, requests, responses, names or variables. Sent to Aptabase.'
export const ERRORS_TEXT = 'Error reports: when Dispatch itself fails, the error and where in Dispatch’s code it happened, with addresses, e-mails and tokens blanked out. Sent to Sentry.'

/** Asked once, on first launch, in builds that can send something. Both start unticked. */
export function ConsentDialog({ onDone }: { onDone: (c: { shareUsage: boolean; shareErrors: boolean }) => void }) {
  const ref = useModal()
  const [usage, setUsage] = useState(false)
  const [errors, setErrors] = useState(false)
  const finish = (c: { shareUsage: boolean; shareErrors: boolean }) => { ref.current?.close(); onDone(c) }
  return (
    <dialog ref={ref} className="dialog consentDialog" aria-labelledby="consent-title" onCancel={(e) => { e.preventDefault(); finish({ shareUsage: false, shareErrors: false }) }}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); finish({ shareUsage: usage, shareErrors: errors }) }}>
        <h2 id="consent-title">Help make Dispatch better?</h2>
        <p className="muted small">Dispatch keeps your work on this device. If you like, it can also send us a little information so we can find bugs and see what to improve. Nothing is sent unless you tick it, and you can change this any time in Settings.</p>
        {telemetryAvailable.usage && <label className="toggle"><input type="checkbox" checked={usage} onChange={(e) => setUsage(e.target.checked)} /> <span>{USAGE_TEXT}</span></label>}
        {telemetryAvailable.errors && <label className="toggle"><input type="checkbox" checked={errors} onChange={(e) => setErrors(e.target.checked)} /> <span>{ERRORS_TEXT}</span></label>}
        <p className="tiny muted">Details: <a href={PRIVACY_URL} onClick={(e) => { e.preventDefault(); void openExternal(PRIVACY_URL) }}>privacy policy</a>.</p>
        <div className="actions end">
          <button type="button" className="btn ghost" onClick={() => finish({ shareUsage: false, shareErrors: false })}>No thanks</button>
          <button type="submit" className="btn primary">{usage || errors ? 'Share what I ticked' : 'Continue without sharing'}</button>
        </div>
      </form>
    </dialog>
  )
}

type Kind = 'problem' | 'idea' | 'question'
const KIND_LABEL: Record<Kind, string> = { problem: 'Something doesn’t work', idea: 'An idea', question: 'A question' }

/** Builds the text of a feedback message (exported for tests). */
export function feedbackBody(kind: Kind, text: string, withDetails: boolean, ua = navigator.userAgent) {
  const details = withDetails ? `\n\n---\nDispatch ${version} (${CHANNEL}), ${isDesktop() ? 'desktop' : 'web'} app\n${ua}` : ''
  return `${KIND_LABEL[kind]}\n\n${text.trim()}${details}`
}

export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const ref = useModal()
  const [kind, setKind] = useState<Kind>('problem')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [details, setDetails] = useState(true)
  const close = () => { ref.current?.close(); onClose() }
  const subject = title.trim() || KIND_LABEL[kind]
  const body = feedbackBody(kind, text, details)
  const viaGitHub = async () => {
    track('feedback_sent', { via: 'github', kind })
    const labels = kind === 'problem' ? 'bug' : kind === 'idea' ? 'enhancement' : 'question'
    await openExternal(`${ISSUES_URL}?${new URLSearchParams({ title: subject, body, labels })}`); close()
  }
  const viaEmail = async () => {
    track('feedback_sent', { via: 'email', kind })
    await openExternal(`mailto:${EMAIL}?subject=${encodeURIComponent(`Dispatch: ${subject}`)}&body=${encodeURIComponent(body)}`); close()
  }
  return (
    <dialog ref={ref} className="dialog feedbackDialog" aria-labelledby="feedback-title" onClose={onClose} onCancel={onClose}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void viaGitHub() }}>
        <h2 id="feedback-title">Send feedback</h2>
        <p className="muted small">This opens a GitHub issue (public) or an e-mail to {EMAIL}, filled in for you to check and send. Dispatch sends nothing itself. Please leave out secrets and private addresses.</p>
        <label className="field"><span>What is it about?</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={KIND_LABEL[kind]} /></label>
        <label className="field"><span>Tell us more</span><textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'problem' ? 'What did you do, what did you expect, and what happened instead?' : ''} required /></label>
        <label className="toggle"><input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} /> Add the Dispatch version and system details</label>
        <div className="actions end">
          <button type="button" className="btn ghost" onClick={close}>Cancel</button>
          <button type="button" className="btn" disabled={!text.trim()} onClick={() => void viaEmail()}>E-mail</button>
          <button type="submit" className="btn primary" disabled={!text.trim()}>Open a GitHub issue</button>
        </div>
      </form>
    </dialog>
  )
}
