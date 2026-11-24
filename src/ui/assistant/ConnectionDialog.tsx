import { useEffect, useRef, useState } from 'react'
import { type Connection, type ConnectionKind, needsKey, newConnection, reach, validateAddress, withBaseUrl } from '../../core/assistant/connections'
import type { NetSettings } from '../../core/assistant/nativeFetch'
import { AssistantError } from '../../core/assistant/providers/shared'
import { useModal } from '../PrivacyDialogs'

export const KIND_NAMES: Record<ConnectionKind, string> = { anthropic: 'Anthropic', openai: 'OpenAI', compatible: 'OpenAI-compatible address' }
const MOST_MODELS = 500
const MOVED = 'The address changed, so its key, context size and console access were taken off. Enter the key for the new address if it needs one.'

/** Adds or edits a connection. The address changes only through withBaseUrl, when it is finished (not per keystroke). */
export function ConnectionDialog({ initial, net, onSave, onClose }: { initial: Connection | null; net: NetSettings; onSave: (c: Connection) => Promise<void>; onClose: () => void }) {
  const ref = useModal()
  /** A saved key stays in `draft.key` and is never put in a field; `key` is only what is typed here. */
  const [draft, setDraft] = useState<Connection>(() => initial ?? newConnection('anthropic'))
  const [key, setKey] = useState('')
  const [address, setAddress] = useState(draft.baseUrl)
  const [context, setContext] = useState(draft.contextTokens ? String(draft.contextTokens) : '')
  const [named, setNamed] = useState(!!initial)
  const [error, setErrorText] = useState('')
  const [badAddress, setBadAddress] = useState(false)
  const setError = (text: string, address = false) => { setErrorText(text); setBadAddress(address) }
  const [note, setNote] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  /** The list being loaded; a late one for another address or key is dropped. */
  const load = useRef(0)
  const loadCtl = useRef<AbortController | null>(null)
  /** A key typed here was taken off with the address; saving stops once, so it's noticed (the click on Save also leaves the address field). */
  const keyDropped = useRef(false)
  useEffect(() => () => { load.current++; loadCtl.current?.abort() }, [])
  const dropList = () => { load.current++; loadCtl.current?.abort(); setLoading(false); setModels([]) }
  const set = (patch: Partial<Connection>) => setDraft((d) => ({ ...d, ...patch }))
  const compatible = draft.kind === 'compatible'
  const close = () => { ref.current?.close?.(); onClose() }

  const pickKind = (kind: ConnectionKind) => {
    const next = newConnection(kind)
    setDraft({ ...next, ...(named ? { name: draft.name } : {}) })
    setAddress(next.baseUrl); setKey(''); setContext(''); setError(''); setNote(''); keyDropped.current = false; dropList()
  }

  /** The draft with the address as typed, or null when it can't be used yet. */
  const commit = (): { draft: Connection; key: string; context: string } | null => {
    if (!compatible || address.trim() === draft.baseUrl) return { draft, key, context }
    const bad = validateAddress(address)
    if (bad) { setError(bad, true); return null }
    const next = withBaseUrl(draft, address)
    const moved = new URL(next.baseUrl).origin !== (() => { try { return new URL(draft.baseUrl).origin } catch { return '' } })()
    if (moved) {
      if (key.trim()) keyDropped.current = true
      if (key.trim() || draft.key || draft.keyLost || (draft.readLogs && !next.readLogs) || context) setNote(MOVED)
      setKey(''); setContext('')
    }
    setDraft(next); setAddress(next.baseUrl); setError(''); dropList()
    return moved ? { draft: next, key: '', context: '' } : { draft: next, key, context }
  }

  /** What would be saved. */
  const built = ({ draft: d, key, context }: { draft: Connection; key: string; context: string }): Connection => {
    const c: Connection = { ...d, name: d.name.trim(), model: d.model.trim() }
    if (key.trim()) { c.key = key.trim(); delete c.keyLost }
    const n = Math.floor(Number(context))
    if (compatible && context.trim() && n > 0) c.contextTokens = n
    else delete c.contextTokens
    if (initial && initial.model !== c.model) c.tools = 'unknown'
    if (initial && !initial.readLogs && c.readLogs) delete c.consentHost // it was given without the console
    return c
  }

  const loadModels = async () => {
    const done = commit()
    if (!done) return
    loadCtl.current?.abort()
    const ctl = loadCtl.current = new AbortController()
    const mine = ++load.current
    setLoading(true); setError(''); setModels([])
    try {
      const { createProvider } = await import('../../core/assistant/providers')
      const list = await (await createProvider(built(done), net)).listModels(ctl.signal)
      if (load.current !== mine) return
      setModels(list)
      if (!list.length) setError('The server listed no models. Type the model’s name.')
    } catch (e) {
      if (load.current === mine) setError(e instanceof AssistantError ? e.message : 'Couldn’t load the list. Type the model’s name.')
    }
    if (load.current === mine) setLoading(false)
  }

  const save = async () => {
    if (busy) return
    const done = commit()
    if (!done) return
    if (keyDropped.current) { keyDropped.current = false; setError('The address changed. Enter the key for it, or save without one.'); return }
    const c = built(done)
    const bad = compatible ? validateAddress(c.baseUrl) : null
    if (bad || !c.name || !c.model) { setError(bad ?? (!c.name ? 'Give it a name.' : 'Enter the model to use, or load the list.')); return }
    setBusy(true)
    try { await onSave(c) } catch (e) { setBusy(false); setError(e instanceof AssistantError ? e.message : 'Couldn’t save the connection. Try again.'); return }
    close()
  }

  return (
    <dialog ref={ref} className="dialog connectionDialog" aria-labelledby="connection-title" onCancel={(e) => { e.preventDefault(); close() }}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <h2 id="connection-title">{initial ? 'Edit connection' : 'Add connection'}</h2>
        <label className="field"><span>Kind</span>
          <select aria-label="Kind" value={draft.kind} disabled={!!initial} onChange={(e) => pickKind(e.target.value as ConnectionKind)}>
            {(Object.keys(KIND_NAMES) as ConnectionKind[]).map((k) => <option key={k} value={k}>{KIND_NAMES[k]}</option>)}
          </select></label>
        <label className="field"><span>Name</span>
          <input aria-label="Name" value={draft.name} onChange={(e) => { setNamed(true); set({ name: e.target.value }) }} /></label>
        {compatible && <>
          <label className="field"><span>Address</span>
            <input className="mono" aria-label="Address" aria-invalid={badAddress || undefined} aria-describedby={badAddress ? 'connection-error' : undefined} value={address} spellCheck={false} autoComplete="off" onChange={(e) => setAddress(e.target.value)} onBlur={() => { commit() }} /></label>
          {reach(draft.baseUrl) === 'network' && draft.baseUrl.startsWith('http:') && <p className="warnLine small">Plain http on your network: other devices there could read the key and everything you send. Use https if the server offers it.</p>}
        </>}
        <label className="field"><span>Key{needsKey(draft) ? '' : ' (if the server needs one)'}</span>
          <input className="mono" type="password" aria-label="Key" value={key} autoComplete="off" spellCheck={false} placeholder={draft.key ? 'Type a new key to replace it' : ''} onChange={(e) => { setKey(e.target.value); keyDropped.current = false; dropList() }} /></label>
        {draft.keyLost && !key && <p className="warnLine small">Enter the key again</p>}
        {(draft.key || draft.keyLost) && !key && <div className="row-h">
          <span className="small muted">{draft.key ? 'Saved' : ''}</span>
          <button type="button" className="btn small ghost" onClick={() => { const { keyLost: _lost, ...rest } = draft; setDraft({ ...rest, key: '' }); dropList() }}>Remove key</button>
        </div>}
        <label className="field"><span>Model</span>
          <input className="mono" aria-label="Model" value={draft.model} spellCheck={false} autoComplete="off" onChange={(e) => set({ model: e.target.value })} /></label>
        {models.length > 0 && <label className="field"><span>Models offered</span>
          <select aria-label="Models offered" value={models.includes(draft.model) ? draft.model : ''} onChange={(e) => set({ model: e.target.value })}>
            <option value="" disabled>Pick a model</option>
            {models.slice(0, MOST_MODELS).map((m) => <option key={m} value={m}>{m}</option>)}
          </select></label>}
        {models.length > MOST_MODELS && <p className="muted small">Only the first {MOST_MODELS} are listed; type the name of another.</p>}
        <div className="row-h"><button type="button" className="btn small" disabled={loading} onClick={() => void loadModels()}>{loading ? 'Loading…' : 'Load models'}</button></div>
        {compatible && <>
          <label className="field"><span>Context size in tokens (empty if you don’t know)</span>
            <input type="number" min={1} aria-label="Context size" value={context} onChange={(e) => setContext(e.target.value)} /></label>
          <p className="muted small">Ollama reads 4,096 tokens unless you tell it otherwise, and forgets the rest. To give it more, set <code>OLLAMA_CONTEXT_LENGTH</code> (for example 32768) where Ollama runs, restart it, and enter the same number here.</p>
        </>}
        <label className="toggle"><input type="checkbox" aria-label="May read the console and send history (responses included)" checked={draft.readLogs} onChange={(e) => set({ readLogs: e.target.checked })} /> <span>May read the console and send history (responses included)</span></label>
        <p className="muted small">The console covers all your workspaces. History is only the open workspace’s.</p>
        <div className="connectionMessage">
          {error ? <p id="connection-error" className="warnLine small" role="alert">{error}</p> : note && <p className="warnLine small" role="status">{note}</p>}
        </div>
        {/* a click on a button doesn't leave the field first: that could move the button from under the pointer */}
        <div className="actions end" onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className="btn ghost" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>Save</button>
        </div>
      </form>
    </dialog>
  )
}
