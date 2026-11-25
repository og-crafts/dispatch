/** Holds the chat for the app: the icon in the top bar and the panel. An answer's pieces draw only this, not the whole app. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icons'
import type { WorkspaceApi } from '../useWorkspace'
import { Boundary } from './Boundary'
import AssistantPanel from './AssistantPanel'
import { useAssistant } from './useAssistant'

export function AssistantHost({ ws, slot, open, onOpen }: { ws: WorkspaceApi; slot: HTMLElement | null; open: boolean; onOpen: (open: boolean) => void }) {
  const a = useAssistant(ws)
  const icon = useRef<HTMLButtonElement>(null)
  const none = a.connections.length === 0
  /** Once opened it stays, hidden, so nothing typed is lost. */
  const [used, setUsed] = useState(false)
  useEffect(() => { if (open) setUsed(true) }, [open])
  useEffect(() => { if (a.ready && none) { setUsed(false); if (open) onOpen(false) } }, [a.ready, none, open, onOpen])
  if (none) return null
  const close = () => { onOpen(false); icon.current?.focus() }
  const busy = a.status !== 'idle'
  return <>
    {slot && createPortal(
      <button ref={icon} type="button" className={`btn small ghost aiIcon ${open ? 'on' : ''}`} aria-label={busy ? 'Assistant, answering' : 'Assistant'} title="Assistant" aria-expanded={open} aria-controls={open ? 'assistant-panel' : undefined}
        onClick={() => (open ? close() : onOpen(true))}><Icon name="chat" />{busy && <span className="spin" aria-hidden="true" />}</button>, slot)}
    {(open || used) && <Boundary resetKey={`${a.chat?.id} ${open}`} fallback={open ? <aside className="assistant" aria-label="Assistant"><p className="warnLine">The assistant couldn’t be shown. The rest of Dispatch works as before; restart Dispatch to try again.</p>
      <div className="actions"><button type="button" className="btn small" onClick={close}>Close</button></div></aside> : null}>
      <AssistantPanel a={a} ws={ws} open={open} onClose={close} />
    </Boundary>}
  </>
}
