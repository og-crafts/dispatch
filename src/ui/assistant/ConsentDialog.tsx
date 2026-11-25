import { type Connection, reachLabel, reach } from '../../core/assistant/connections'
import { useModal } from '../PrivacyDialogs'

/** Asked before the first message to a host that isn't this computer. */
export function ConsentDialog({ connection, onAllow, onDecline }: { connection: Connection; onAllow: () => void; onDecline: () => void }) {
  const ref = useModal()
  const { host } = new URL(connection.baseUrl)
  const finish = (f: () => void) => { ref.current?.close?.(); f() }
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="assistant-consent-title" onCancel={(e) => { e.preventDefault(); finish(onDecline) }}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); finish(onAllow) }}>
        <h2 id="assistant-consent-title">Use {connection.name}? ({reachLabel(reach(connection.baseUrl))})</h2>
        <p>{`${host} will receive what you write and what the assistant reads here: requests, scripts and plain variable values${connection.readLogs ? ', and the console and past responses' : ''}. Known secrets are hidden, but Dispatch can't recognise every secret, and ordinary data in responses is not hidden.`}</p>
        {connection.readLogs && <p>The console covers all your workspaces, not only this one.</p>}
        <div className="actions end">
          <button type="button" className="btn ghost" autoFocus onClick={() => finish(onDecline)}>Not now</button>
          <button type="submit" className="btn primary">Allow {host}</button>
        </div>
      </form>
    </dialog>
  )
}
