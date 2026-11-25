/** Settings > AI assistants: the connections of the assistant inside Dispatch. */
import { useEffect, useRef, useState } from 'react'
import { type Connection, reach, reachLabel } from '../../core/assistant/connections'
import { useDialogs } from '../Dialogs'
import type { WorkspaceApi } from '../useWorkspace'
import { mergeEdit } from './mergeEdit'
import { ConnectionDialog, KIND_NAMES } from './ConnectionDialog'
import { testConnection, type TestResult } from './connectionTest'
import { removeAllChats, updateConnections, useConnections } from './store'

const CHECKS: ['reachable' | 'streams' | 'tools' | 'answers', string, string][] = [
  ['reachable', 'Reachable', 'Not reached'], ['streams', 'Streams', 'Doesn’t stream'], ['tools', 'Calls tools', 'Doesn’t call tools'], ['answers', 'Answers', 'No answer'],
]

export function AssistantSettings({ ws, notify }: { ws: WorkspaceApi; notify: (m: string) => void }) {
  const connections = useConnections()
  const { confirm, node } = useDialogs()
  const [editing, setEditing] = useState<Connection | 'new' | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const running = useRef<AbortController | null>(null)
  const stop = () => { running.current?.abort(); running.current = null; setTesting(null) }
  useEffect(() => () => running.current?.abort(), [])
  const forget = (id: string) => setResults(({ [id]: _gone, ...rest }) => rest)

  const test = async (c: Connection) => {
    stop()
    const ctl = running.current = new AbortController()
    setTesting(c.id); forget(c.id)
    let r: TestResult
    try { r = await testConnection(c, ws.settings, ctl.signal) } catch { return }
    if (ctl.signal.aborted) return
    running.current = null; setTesting(null); setResults((x) => ({ ...x, [c.id]: r }))
    const { tools } = r
    // only for the connection as it was tested
    if (tools) try {
      await updateConnections((now) => now.map((x) => (x.id === c.id && x.baseUrl === c.baseUrl && x.model === c.model && x.key === c.key ? { ...x, tools } : x)))
    } catch { notify('Couldn’t save the test’s result.') }
  }
  const remove = async (c: Connection) => {
    if (!await confirm(`Delete the connection “${c.name}” and its key from this device? Chats made with it can still be read, but not continued.`)) return
    if (testing === c.id) stop()
    try { await updateConnections((now) => now.filter((x) => x.id !== c.id)) } catch { notify('Couldn’t remove the connection.') }
  }
  const save = async (c: Connection) => {
    await updateConnections((now) => (editing === 'new' ? [...now, c] : mergeEdit(now, editing!, c)))
    forget(c.id)
  }
  const deleteAll = async () => {
    if (!await confirm('Delete all chats in every workspace? This can’t be undone.')) return
    try { await removeAllChats(); notify('All chats deleted') } catch { notify('Couldn’t delete the chats.') }
  }

  return <>
    <h2>Dispatch assistant</h2>
    <p className="muted small">Ask about the workspace you’re working in, right here: why a test fails, what a script does, how to write the next one. Connect a model with your own key, or one that runs on this computer. Nothing is sent until you ask something.</p>
    {connections?.length === 0 && <p className="muted small">No connections yet.</p>}
    {!!connections?.length && <ul className="connections" aria-label="Connections">
      {connections.map((c) => {
        const r = results[c.id]
        return (
          <li key={c.id}>
            <div className="connection">
              <span className="connectionText"><strong>{c.name}</strong> <span className="muted small">{c.kind === 'compatible' ? c.baseUrl : KIND_NAMES[c.kind]} · {c.model}</span></span>
              <span className="pill">{reachLabel(reach(c.baseUrl))}</span>
              {testing === c.id
                ? <button type="button" className="btn small" aria-label={`Stop testing ${c.name}`} onClick={stop}>Stop</button>
                : <button type="button" className="btn small" aria-label={`Test ${c.name}`} onClick={() => void test(c)}>Test</button>}
              <button type="button" className="btn small ghost" aria-label={`Edit ${c.name}`} onClick={() => { if (testing === c.id) stop(); setEditing(c) }}>Edit</button>
              <button type="button" className="btn small danger" aria-label={`Remove ${c.name}`} onClick={() => void remove(c)}>Remove</button>
            </div>
            {c.keyLost && <p className="warnLine small">Enter the key again: the saved one can’t be read on this device.</p>}
            {c.tools === 'no' && !r && <p className="muted small">Works for text questions only: this model can’t look things up here.</p>}
            <div role="status" aria-label={`Test of ${c.name}`} className="small">
              {testing === c.id && 'Testing… this sends a short made-up question, nothing from your workspace.'}
              {r && <>
                {(!r.error || r.reachable) && <span className="connectionChecks">{CHECKS.filter(([k]) => !r.error || k === 'reachable').map(([k, yes, no]) => {
                  const ok = k === 'tools' ? r.tools === 'yes' : r[k]
                  return <span key={k} className={ok ? 'goodText' : 'muted'}>{ok ? yes : no} </span>
                })}</span>}
                {r.error && <span className="badText">{r.error}</span>}
                {!r.error && r.tools === 'no' && <span>Works for text questions only: this model can’t look things up here.</span>}
              </>}
            </div>
          </li>
        )
      })}
    </ul>}
    <div className="actions addConnection"><button type="button" className="btn small" onClick={() => setEditing('new')}>+ Add connection</button></div>
    <div className="auth">
      <label className="toggle"><input type="checkbox" checked={ws.settings.keepChats} onChange={(e) => ws.setSettings({ keepChats: e.target.checked })} /> Keep chats on this device</label>
      <div className="actions"><button type="button" className="btn small danger" onClick={() => void deleteAll()}>Delete all chats</button></div>
    </div>
    {editing && <ConnectionDialog initial={editing === 'new' ? null : editing} net={ws.settings} onSave={save} onClose={() => setEditing(null)} />}
    {node}
  </>
}
