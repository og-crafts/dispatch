/** The top bar's update button, and the one-time notice that Dispatch looks for new versions. */
import type { UpdatesApi } from './useUpdates'

export function UpdateButton({ updates, onDismissed }: { updates: UpdatesApi; onDismissed: () => void }) {
  const v = updates.available?.version
  if (!v) return null
  return (
    <span className="updateBtn">
      <button type="button" className="btn small primary" aria-label={`Update to ${v}`} title={`Update to ${v}`} aria-disabled={updates.busy} onClick={() => void updates.install()}>{updates.busy ? 'Updating…' : <span>Update<span className="updateTo"> to {v}</span></span>}</button>
      <button type="button" className="icon" aria-label={`Dismiss update ${v}`} title="Not now" onClick={() => { updates.dismiss(); onDismissed() }}>×</button>
    </span>
  )
}

export function UpdateNotice({ updates }: { updates: UpdatesApi }) {
  if (!updates.noticeOpen) return null
  return (
    <div className="updateNotice" role="status">
      <span>Dispatch looks for new versions on GitHub. No workspace data is sent.</span>
      <span className="grow" />
      <button type="button" className="btn small ghost" onClick={() => updates.answerNotice(false)}>Turn off</button>
      <button type="button" className="btn small" onClick={() => updates.answerNotice(true)}>OK</button>
    </div>
  )
}
