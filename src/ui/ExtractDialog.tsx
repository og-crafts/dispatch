import { useState } from 'react'
import type { Scope, Source } from '../core/extract'
import { isSecretName } from '../core/share'
import type { KV } from '../core/types'
import { useModal } from './PrivacyDialogs'

export interface ExtractTarget { scope: Scope; label: string; rows: KV[]; disabled?: boolean }
export interface ExtractChoice { scope: Scope; name: string; secret: boolean }

const DOTS = '••••••••'
const short = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s)

/** Asks what to call a value taken from a response and where to keep it. */
export function ExtractDialog({ source, targets, onExtract, onClose }: {
  source: Extract<Source, { ok: true }>; targets: ExtractTarget[]
  onExtract: (c: ExtractChoice) => Promise<void>; onClose: () => void
}) {
  const ref = useModal()
  const [name, setName] = useState(source.name)
  const [scope, setScope] = useState<Scope>(targets.find((t) => !t.disabled)!.scope)
  /** Until it's ticked by hand, Secret follows the variable that exists, or the name. */
  const [ticked, setTicked] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const key = name.trim()
  const row = key ? targets.find((t) => t.scope === scope)!.rows.filter((r) => r.key.trim() === key).pop() : undefined
  const secret = ticked ?? (row ? !!row.secret : isSecretName(key) || isSecretName(source.expr))
  const ok = !!key && !/[{}]/.test(key)
  const close = () => { ref.current?.close?.(); onClose() }
  const submit = async () => {
    if (!ok || busy) return
    setBusy(true)
    await onExtract({ scope, name: key, secret })
    close()
  }
  return (
    <dialog ref={ref} className="dialog extractDialog" aria-labelledby="extract-title" onClose={onClose} onCancel={onClose}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <h2 id="extract-title">Extract into variable</h2>
        <pre className="code mono out extractValue" aria-label="Value found">{secret ? DOTS : short(source.value)}</pre>
        <p className="small muted">Taken on every send with <code className="extractExpr">{secret ? source.expr.replace(source.value, DOTS) : source.expr}</code></p>
        {!source.unique && <p className="small warnLine">The text around this appears more than once in the response, so the first match is used. Select something more specific if that isn’t the one you want.</p>}
        <label className="field"><span>Name</span>
          <input className="mono" value={name} aria-label="Name" autoFocus spellCheck={false} autoComplete="off" onChange={(e) => setName(e.target.value)} /></label>
        {row && <p className="small muted">Replaces the current value{row.secret || secret ? '' : <>: <code>{short(row.value) || '(empty)'}</code></>}.</p>}
        {!!key && !ok && <p className="small warnLine">A name can’t contain braces.</p>}
        <label className="field"><span>Save to</span>
          <select aria-label="Save to" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            {targets.map((t) => <option key={t.scope} value={t.scope} disabled={t.disabled}>{t.label}</option>)}
          </select></label>
        <label className="toggle"><input type="checkbox" aria-label="Secret" checked={secret} onChange={(e) => setTicked(e.target.checked)} /> Secret (hidden on screen and left out of backups)</label>
        <div className="actions end">
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!ok || busy}>Extract</button>
        </div>
      </form>
    </dialog>
  )
}
