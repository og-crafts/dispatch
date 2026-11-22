import { useState } from 'react'
import { useModal } from './PrivacyDialogs'

/**
 * Asks for the passphrase that encrypts a workspace's synced secrets (src/core/secretsVault.ts). `new` asks twice and
 * says plainly that there is no recovery; `unlock` asks once. `run` does the work (it can take a moment: the key is
 * made slowly on purpose) and returns a message, or throws to show an error and let the person try again.
 */
export function PassphraseDialog({ mode, workspace, run, onClose }: {
  mode: 'new' | 'unlock' | 'change'; workspace: string
  run: (passphrase: string) => Promise<string>; onClose: (message?: string) => void
}) {
  const ref = useModal()
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const asking = mode !== 'unlock'
  const short = asking && pass.length > 0 && pass.length < 10
  const mismatch = asking && again.length > 0 && again !== pass
  const ok = pass.length >= (asking ? 10 : 1) && (!asking || again === pass)
  const close = (m?: string) => { ref.current?.close?.(); onClose(m) }
  const submit = async () => {
    if (!ok || busy) return
    setBusy(true); setError(null)
    try { close(await run(pass)) } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }
  const title = mode === 'new' ? 'Sync secrets with the folder' : mode === 'change' ? 'Change the secrets passphrase' : 'Unlock the folder’s secrets'
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="pass-title" onClose={() => onClose()} onCancel={() => onClose()}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <h2 id="pass-title">{title}</h2>
        {mode === 'unlock'
          ? <p className="muted small">The folder of “{workspace}” has secret values encrypted with a passphrase. Enter it to use them on this computer. You only do this once here.</p>
          : <p className="muted small">The secret values of “{workspace}” (secret variables in its environments and collections) go into one file in the folder, <code>secrets.dispatch-vault</code>, encrypted with this passphrase. Every computer that opens the folder needs it once. <b>If it’s forgotten, it can’t be recovered</b>: the secrets would have to be entered again.</p>}
        <label className="field"><span>Passphrase</span>
          <input type="password" autoComplete={asking ? 'new-password' : 'current-password'} value={pass} onChange={(e) => setPass(e.target.value)} autoFocus aria-invalid={short || undefined} />
        </label>
        {short && <p className="small warnLine">Use at least 10 characters; a few words are easier to remember than symbols.</p>}
        {asking && <label className="field"><span>Again</span>
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch || undefined} />
        </label>}
        {mismatch && <p className="small warnLine">The two don’t match.</p>}
        {error && <p className="small badText" role="alert">{error}</p>}
        <div className="actions end">
          <button type="button" className="btn ghost" onClick={() => close()} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!ok || busy}>{busy ? 'Working…' : mode === 'unlock' ? 'Unlock' : mode === 'change' ? 'Change passphrase' : 'Start syncing secrets'}</button>
        </div>
      </form>
    </dialog>
  )
}
