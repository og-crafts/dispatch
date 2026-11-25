import { useMemo, useState } from 'react'
import { addVariables, applySuggestions, knownVars, type Suggestion, suggest } from '../core/parameterize'
import type { WorkspaceApi } from './useWorkspace'

/** Suggests turning hard-coded parts of the open request into variables, and applies the chosen ones. */
export function ParameterizePanel({ ws, notify, onClose }: { ws: WorkspaceApi; notify: (m: string) => void; onClose: () => void }) {
  const suggestions = useMemo(() => {
    const names = [...(ws.environment?.variables ?? []), ...(ws.collection?.variables ?? []), ...ws.globals].map((v) => v.key.trim())
    return suggest(ws.draft, knownVars(ws.environment, ws.collection, ws.globals), names)
  }, [ws.draft, ws.environment, ws.collection, ws.globals])
  const [off, setOff] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<string>(() => (ws.environment ? `env:${ws.environment.id}` : ws.collection ? 'collection' : 'new-env'))
  const chosen = suggestions.filter((s) => !off.has(s.id))
  const creating = chosen.filter((s) => s.create)

  const apply = async () => {
    const { request, create } = applySuggestions(ws.draft, chosen)
    if (create.length) {
      const e = ws.environments.find((x) => `env:${x.id}` === target)
      const rows = target.startsWith('env:') ? e?.variables : target === 'collection' ? ws.collection?.variables : target === 'globals' ? ws.globals : []
      const got = rows && addVariables(rows, create)
      if (!got) { notify('That place isn’t there any more. Choose another one. Nothing was changed.'); return }
      if ('taken' in got) { notify(`“${got.taken}” is already there. Choose another place, or rename that one first. Nothing was changed.`); return }
      if (e) await ws.updateEnvironment({ ...e, variables: got.rows })
      else if (target === 'collection') await ws.updateCollection({ ...ws.collection!, variables: got.rows })
      else if (target === 'globals') await ws.setGlobals(got.rows)
      else {
        const fresh = await ws.addEnvironment('Default')
        await ws.updateEnvironment({ ...fresh, variables: create })
        ws.setSettings({ activeEnvId: fresh.id })
      }
    }
    ws.setDraft(() => request)
    notify(`Parameterized: ${chosen.length} change${chosen.length === 1 ? '' : 's'}${create.length ? `, ${create.length} new variable${create.length === 1 ? '' : 's'}` : ''}.`)
    onClose()
  }

  return (
    <div className="paramPanel" role="dialog" aria-label="Parameterize">
      <div className="row-h"><strong>Turn hard-coded values into variables</strong><button type="button" className="icon" aria-label="Close" onClick={onClose}>×</button></div>
      {!suggestions.length ? <p className="muted small">Nothing to change: no hard-coded base URL, credentials or IDs, and no values that match your variables.</p> : <>
        <ul className="paramList">
          {suggestions.map((s: Suggestion) => (
            <li key={s.id}>
              <label className="toggle">
                <input type="checkbox" checked={!off.has(s.id)} onChange={(e) => setOff((o) => { const n = new Set(o); if (e.target.checked) n.delete(s.id); else n.add(s.id); return n })} />
                <span><b>{s.title}</b> <span className="muted small">{s.detail}</span></span>
              </label>
            </li>
          ))}
        </ul>
        {creating.length > 0 && (
          <label className="field inline"><span>Create {creating.map((s) => s.varName).join(', ')} in</span>
            <select aria-label="Where to create variables" value={target} onChange={(e) => setTarget(e.target.value)}>
              {ws.environments.map((e) => <option key={e.id} value={`env:${e.id}`}>{e.name} (environment)</option>)}
              {ws.collection && <option value="collection">{ws.collection.name} (collection)</option>}
              <option value="globals">Globals</option>
              <option value="new-env">A new environment “Default”</option>
            </select>
          </label>
        )}
        {creating.some((s) => s.secret) && <p className="small muted">Tokens and keys are created as secret variables (hidden, encrypted, left out of exports).</p>}
        <div className="actions"><button type="button" className="btn primary" disabled={!chosen.length} onClick={() => void apply()}>Apply {chosen.length}</button></div>
      </>}
    </div>
  )
}
