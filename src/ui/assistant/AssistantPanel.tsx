/** The assistant's panel: the chat, what it looked up, and the box. Everything a model wrote is shown as untrusted. */
import { Fragment, memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { reach, reachLabel } from '../../core/assistant/connections'
import { smallContext } from '../../core/assistant/tools'
import { useDialogs } from '../Dialogs'
import { Markdown, type Untrusted } from '../Markdown'
import { openExternal } from '../PrivacyDialogs'
import type { WorkspaceApi } from '../useWorkspace'
import { Boundary } from './Boundary'
import { ChangeCard, outcome } from './ChangeCard'
import { ConsentDialog } from './ConsentDialog'
import { MAX_W, MIN_W, usePanelLayout } from './layout'
import { lastAnswer, plainText, proposed, stateWords, toolLine, turns, type Item, type ToolState } from './transcript'
import type { AssistantApi, SendResult } from './useAssistant'

const WIDTH_KEY = 'dispatch.assistantWidth'
const DEFAULT_W = 380
const clampWish = (n: number) => Math.min(MAX_W, Math.max(MIN_W, Math.round(n)))
function savedWidth(): number { try { const n = Number(localStorage.getItem(WIDTH_KEY)); return n ? clampWish(n) : DEFAULT_W } catch { return DEFAULT_W } }
function keepWidth(n: number) { try { localStorage.setItem(WIDTH_KEY, String(n)) } catch { /* not remembered */ } }

/** While an answer comes, only its end is drawn, as plain text. */
const LIVE = 20_000
const ANNOUNCED = 4000
const AT_END = 32
const NOT_OPENED = 'The link couldn’t be opened. Copy its address into your browser instead.'
/** Delete and Backspace would remove a flow's block, the others act on requests and their tabs; none is meant while in the panel. */
const OWN_KEYS = /^(enter|s|t|w)$/
const Answer = memo(function Answer({ text, untrusted }: { text: string; untrusted: Untrusted }) { return <Markdown text={text} untrusted={untrusted} /> })
const STAYS = 'Changes you already applied stay. Use Undo on their cards.'
const NO_TOOLS: AssistantApi['tools'] = []

/** `still`: it waits for the person, so nothing turns. */
function Lookup({ text, name, state, still }: { text: string; name: string; state?: ToolState; still?: boolean }) {
  return <p className="aiTool muted small">{state === 'running' && !still && <span className="spin" aria-hidden="true" />}<span>{text}{stateWords(name, state)}</span></p>
}

/** One question and what came of it. `tools`: the last message's look-ups. */
const Kept = memo(function Kept({ all, tools, still, untrusted }: { all: Item[]; tools: AssistantApi['tools']; still: boolean; untrusted: Untrusted }) {
  let n = 0
  return <>
    {all.map((i, k) => {
      if (i.kind === 'tool') {
        // they are known better than what the messages say
        const now = tools.length ? tools[n++] : undefined
        return <Lookup key={k} text={i.text} name={i.name} state={now ? now.state : tools.length ? 'stopped' : i.state} still={still} />
      }
      if (i.kind === 'model') return <p key={k} className="aiTool muted small">Answered by {i.text}</p>
      return (
        <div key={k} className={`aiMsg from-${i.kind}`}>
          <h3 className="sr">{i.kind === 'you' ? 'You' : 'Assistant'}</h3>
          {i.kind === 'you' ? <div className="aiText">{i.text}</div> : <Answer text={i.text} untrusted={untrusted} />}
        </div>
      )
    })}
  </>
})

/** Whether the last question changed something that a stop doesn't take back. */
function stays(a: AssistantApi): boolean {
  const start = turns(a.chat?.messages).at(-1)?.start ?? -1
  return a.cards.some((c) => c.state === 'applied' && c.at > start)
}

/** Some providers keep the model that answered in the messages; it is said once. */
function Conversation({ a, open, untrusted }: { a: AssistantApi; open: boolean; untrusted: Untrusted }) {
  const messages = a.chat?.messages
  const asked = useMemo(() => turns(messages), [messages])
  const last = asked.length - 1
  const all = asked[last]?.items ?? []
  const act = useRef(a); act.current = a
  /** The cards of a question, the ones nobody asked for here with the last. */
  const cardsOf = (k: number) => a.cards.filter((c) => c.at > (asked[k]?.start ?? -1) && (k >= last || c.at <= asked[k + 1].start))
  const cards = (k: number) => cardsOf(k).map((c) => <ChangeCard key={c.proposal.id} card={c} open={open} act={act} />)
  const waits = a.cards.some((c) => c.state === 'waiting')
  const answering = a.status === 'answering'
  /** Look-ups that aren't in the messages yet, and the text around them. */
  const now = a.tools.slice(all.filter((i) => i.kind === 'tool').length)
  const from = Math.max(0, a.streamed.length - LIVE)
  const part = (start: number, end: number) => {
    const t = a.streamed.slice(Math.max(start, from), end).trim()
    return t && <div className="aiMsg from-assistant"><h3 className="sr">Assistant</h3><div className="aiText">{start <= from && from ? '…' : ''}{t}</div></div>
  }
  return <>
    {asked.map((t, k) => <Fragment key={t.start}>
      <Kept all={t.items} tools={k === last ? a.tools : NO_TOOLS} still={k === last && waits} untrusted={untrusted} />
      {k !== last && cards(k)}
    </Fragment>)}
    {now.map((t, k) => <Fragment key={t.id}>
      {answering && part(k ? now[k - 1].at ?? 0 : 0, t.at ?? 0)}
      <Lookup text={toolLine(t.name, t.input)} name={t.name} state={t.state} still={waits} />
    </Fragment>)}
    {answering ? part(now[now.length - 1]?.at ?? 0, a.streamed.length)
      : a.streamed && <div className="aiMsg from-assistant"><h3 className="sr">Assistant</h3><Answer text={a.streamed} untrusted={untrusted} /></div>}
    {cards(Math.max(0, last))}
    {answering && !a.streamed && !a.tools.some((t) => t.state === 'running') && <p className="aiTool muted small"><span className="spin" aria-hidden="true" /><span>Answering…</span></p>}
    {a.fallback && !all.some((i) => i.kind === 'model' && i.text === a.fallback) && <p className="aiTool muted small">Answered by {a.fallback}: the chosen model declined.</p>}
    {!answering && a.ended === 'stopped' && <p className="aiTool muted small">Stopped. Send another message to go on.</p>}
    {!answering && a.ended === 'stopped' && stays(a) && <p className="aiTool muted small">{STAYS}</p>}
  </>
}

/** The summary stays as edited until a new chat was started with it. */
function SummaryEditor({ a, onSent }: { a: AssistantApi; onSent: () => void }) {
  const [text, setText] = useState(a.summary ?? '')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { box.current?.focus() }, [])
  const start = async () => { if (await a.startFromSummary(text) === 'sent') onSent() }
  return (
    <div className="aiSummary">
      <label className="field"><span>Summary for the new chat. Read it and change what you like; this is what is sent.</span>
        <textarea ref={box} aria-label="Summary" rows={5} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="actions end">
        <button type="button" className="btn small ghost" onClick={a.dismissSummary}>Cancel</button>
        <button type="button" className="btn small primary" disabled={!text.trim() || a.status !== 'idle'} onClick={() => void start()}>Start new chat</button>
      </div>
    </div>
  )
}

export default function AssistantPanel({ a, ws, open, onClose }: { a: AssistantApi; ws: WorkspaceApi; open: boolean; onClose: () => void }) {
  const { confirm, node } = useDialogs()
  const id = useId()
  const [text, setText] = useState('')
  const [said, setSaid] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const panel = useRef<HTMLElement>(null)
  const chatsMenu = useRef<HTMLDetailsElement>(null)
  const openNow = useRef(open); openNow.current = open
  const focusBox = () => { if (openNow.current) box.current?.focus() }
  const { over, most } = usePanelLayout(panel, open)
  useEffect(() => { if (open) focusBox(); else setSaid('') }, [open])

  // A focused button that goes away (or can't be used any more) gives its focus to the box.
  const focused = useRef<Element | null>(null)
  useLayoutEffect(() => {
    const f = focused.current, at = document.activeElement
    if (!open || !f || (f.isConnected && !f.matches(':disabled'))) return
    focused.current = null
    if (at === f || at === document.body || !at) focusBox()
  })

  const [linkError, setLinkError] = useState('')
  useEffect(() => setLinkError(''), [a.chat?.id, a.status])
  const untrusted = useMemo<Untrusted>(() => ({
    open: (url) => { setLinkError(''); openExternal(url).catch(() => { setLinkError(NOT_OPENED); setSaid(NOT_OPENED) }) },
  }), [])

  const busy = a.status !== 'idle'
  const spaceId = a.chat?.spaceId ?? ws.activeSpaceId
  const space = ws.spaces.find((s) => s.id === spaceId)
  const keyLost = !a.blocked && a.connection?.keyLost === true
  const why = a.blocked ?? (keyLost ? `Enter the key again for ${a.connection!.name}: the saved one can’t be read on this device.` : null)

  // Said once, when it's finished; the text as it comes is never live.
  const was = useRef<{ status: AssistantApi['status']; chat: AssistantApi['chat'] }>({ status: 'idle', chat: null })
  useEffect(() => {
    const before = was.current
    if (a.status !== 'idle') {
      if (before.status === 'idle') { was.current = { status: a.status, chat: a.chat }; setSaid('') }
      return
    }
    was.current = { status: 'idle', chat: null }
    if (!open) return
    let now = a.error
    if (before.status === 'summarising') now ||= a.summary ? 'The summary is ready to read.' : ''
    else if (before.status === 'answering' && a.ended && a.chat !== before.chat) {
      const answer = a.ended === 'done' || a.ended === 'length' ? plainText(lastAnswer(a.chat?.messages)) : ''
      now = [answer.length > ANNOUNCED ? `${answer.slice(0, ANNOUNCED)}… The rest is in the panel.` : answer, a.ended === 'stopped' ? 'Stopped.' : '', a.ended === 'stopped' && stays(a) ? STAYS : '', a.error].filter(Boolean).join('\n')
    }
    setSaid(now)
  }, [a.status, a.error]) // eslint-disable-line react-hooks/exhaustive-deps

  // Each card is announced once, when it can be seen; then what came of it.
  const told = useRef(new Map<string, string>())
  useEffect(() => {
    if (!open) return
    for (const c of a.cards) {
      const { id, title, tool, cls } = c.proposal
      const before = told.current.get(id), words = outcome(c)
      if (before === words) continue
      told.current.set(id, words)
      const name = /“(.*)”/s.exec(title)?.[1] ?? title
      if (c.state === 'waiting') setSaid(`The assistant proposes ${proposed(tool, name.length > 200 ? `${name.slice(0, 200)}…` : name)}. ${cls === 'delete' ? 'Delete' : 'Apply'} or reject it in the panel.`)
      else if (before !== undefined && c.state !== 'stopped' && c.state !== 'rejected' && c.state !== 'applying') setSaid(words)
    }
  }, [a.cards, open])

  // Follows the answer only while the person is at its end.
  const log = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const shownChat = useRef(a.chat?.id)
  useLayoutEffect(() => {
    if (shownChat.current !== a.chat?.id) { shownChat.current = a.chat?.id; atEnd.current = true }
    const l = log.current
    if (!open || !l || !atEnd.current) return
    l.scrollTop = l.scrollHeight
    // a card is read from its start
    const c = [...l.querySelectorAll<HTMLElement>('.aiCard.waiting')].pop()
    if (c && c.offsetHeight > l.clientHeight) l.scrollTop += c.getBoundingClientRect().top - l.getBoundingClientRect().top - 8
  }, [open, a.chat, a.streamed, a.tools, a.cards, a.status, a.ended])

  /** Runs what sends, and takes the message out of the box when it was sent. */
  const sendWith = async (f: () => Promise<SendResult>, message: string) => {
    atEnd.current = true
    if (await f() === 'sent') setText((t) => (t === message ? '' : t))
  }
  const submit = () => { if (!busy && !why && text.trim()) void sendWith(() => a.send(text), text) }
  const allow = async () => {
    if (a.pendingConsent?.kind === 'message') await sendWith(a.allowConsent, text)
    else await a.allowConsent()
    focusBox()
  }
  const closeChats = () => { if (chatsMenu.current) chatsMenu.current.open = false }
  const remove = async (chatId: string, title: string) => {
    if (await confirm(`Delete the chat “${title}”? This can’t be undone.`)) await a.deleteChat(chatId)
    focusBox()
  }

  const [wished, setWidth] = useState(savedWidth)
  const clampW = (n: number) => Math.min(most, clampWish(n))
  /** A wish that doesn't fit now is kept for a wider window. */
  const width = clampW(wished)
  const setW = (n: number) => { const w = clampW(n); setWidth(w); keepWidth(w) }
  const drag = useRef<{ x: number; w: number } | null>(null)
  const dragged = () => { if (!drag.current) return; drag.current = null; document.body.classList.remove('resizing'); keepWidth(width) }

  return <>
    <aside ref={panel} id="assistant-panel" className="assistant" aria-label="Assistant" hidden={!open} style={{ '--ai-w': `${width}px` } as React.CSSProperties}
      onFocus={(e) => { focused.current = e.target }} onBlur={() => { focused.current = null }}
      onKeyDown={(e) => {
        const key = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey
        if (key === 'delete' || key === 'backspace') e.stopPropagation()
        else if (mod && (OWN_KEYS.test(key) || (e.altKey && key === 'n'))) { e.stopPropagation(); if (key !== 'enter') e.preventDefault() }
        if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return
        if (document.querySelector('dialog[open], details.menu[open], .ctxMenu')) return
        e.preventDefault(); onClose()
      }}>
      <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize the assistant" tabIndex={0}
        aria-valuemin={MIN_W} aria-valuemax={most} aria-valuenow={width} title="Drag to resize; double-click to reset"
        onPointerDown={(e) => {
          e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          drag.current = { x: e.clientX, w: panel.current?.offsetWidth || width }; document.body.classList.add('resizing')
        }}
        onPointerMove={(e) => { if (drag.current) setWidth(clampW(drag.current.w + drag.current.x - e.clientX)) }}
        onPointerUp={dragged} onPointerCancel={dragged} onLostPointerCapture={dragged}
        onDoubleClick={() => setW(DEFAULT_W)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 64 : 16
          const to = e.key === 'ArrowLeft' ? width + step : e.key === 'ArrowRight' ? width - step : e.key === 'Home' ? MIN_W : e.key === 'End' ? most : null
          if (to !== null) { e.preventDefault(); setW(to) }
        }} />

      <header className="aiHead">
        <div className="aiTitle">
          <h2>Assistant · {!space ? 'removed workspace' : /\bworkspace$/i.test(space.name) ? space.name : `${space.name} workspace`}</h2>
          {!a.paused && <span className="muted small">{ws.environment ? ws.environment.name : 'No environment'}</span>}
        </div>
        <button type="button" className="icon" aria-label="Close the assistant" title="Close (Esc)" onClick={onClose}>×</button>
        <div className="aiBar">
          <details ref={chatsMenu} className="menu">
            <summary className="btn small ghost">Chats</summary>
            <div className="menuList aiChats">
              {!a.chats.length && <p className="muted small pad">No kept chats in this workspace.</p>}
              <ul>{a.chats.map((c) => {
                const title = c.title.trim() || 'Untitled chat'
                return <li key={c.id}>
                  <button type="button" className="aiChat" aria-current={c.id === a.chat?.id || undefined} onClick={() => { closeChats(); void a.openChat(c.id).then(focusBox) }}>{title}</button>
                  <button type="button" className="icon" aria-label={`Delete chat ${title}`} title="Delete" onClick={() => { closeChats(); void remove(c.id, title) }}>×</button>
                </li>
              })}</ul>
            </div>
          </details>
          <button type="button" className="btn small ghost" onClick={() => { a.newChat(); focusBox() }}>New chat</button>
          <span className="grow" />
          {a.connections.length > 1 && <select aria-label="Connection" title="Another connection starts a new chat" value={a.connection?.id ?? ''} onChange={(e) => a.selectConnection(e.target.value)}>
            {!a.connection && <option value="" disabled>Removed connection</option>}
            {a.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>}
        </div>
      </header>
      <div className="aiMiddle">
      <p className="aiNote small">It can read, and propose changes. Nothing changes until you apply it. It can’t send or run anything.</p>

      <div ref={log} className="aiLog" role="group" aria-label="Conversation" tabIndex={0}
        onScroll={(e) => { const l = e.currentTarget; atEnd.current = l.scrollHeight - l.scrollTop - l.clientHeight < AT_END }}>
        <Boundary resetKey={a.chat} fallback={<p className="warnLine small">This chat can’t be shown. Start a new chat.</p>}>
          <Conversation a={a} open={open} untrusted={untrusted} />
        </Boundary>
        {!a.chat && !a.streamed && !busy && <p className="aiEmpty muted">Ask why a test fails, what a script does, or how to write the next one.</p>}
      </div>

      <div className="aiNotices">
        {a.error && <p className="errorBox small">{a.error}</p>}
        {linkError && <p className="errorBox small">{linkError}</p>}
        {why && <div className="aiWhy"><p id={`${id}-why`} className="warnLine small">{why}</p>
          {a.paused && space && <button type="button" className="btn small" onClick={() => { ws.switchSpace(space.id); focusBox() }}>Open {space.name}</button>}
          {keyLost && <button type="button" className="btn small" onClick={() => { ws.setView({ kind: 'settings' }); if (over) onClose() }}>Open Settings</button>}
        </div>}
        {!why && a.connection?.tools === 'no' && <p className="muted small">Works for text questions only: this model can’t look things up here.</p>}
        {a.summary !== null
          ? <SummaryEditor a={a} onSent={focusBox} />
          : a.nearFull && !why && <div className="aiWhy"><p className="warnLine small">This chat is nearly full. Go on in a new one, with a summary you can read and change first.</p>
              <button type="button" className="btn small" disabled={busy} onClick={() => void a.summarise()}>{a.status === 'summarising' ? 'Summarising…' : 'Summarise for a new chat'}</button></div>}
      </div>

      </div>
      <div className="aiBottom">
      {a.connection && smallContext(a.connection) && <label className="aiJob small"><span>Help with</span>
        <select value={a.job} onChange={(e) => a.setJob(e.target.value as AssistantApi['job'])}><option value="ask">Questions</option><option value="scripts">Scripts and variables</option></select></label>}
      <form className="aiAsk" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <textarea ref={box} rows={2} aria-label="Message to the assistant" placeholder="Ask about this workspace…" aria-describedby={why ? `${id}-why` : undefined} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
            e.preventDefault(); submit()
          }} />
        <button type="submit" className="btn primary" disabled={busy || !!why || !text.trim()} aria-describedby={why ? `${id}-why` : undefined}>Send</button>
      </form>
      <footer className="aiFoot muted small">
        <div className="aiWho"><span>{a.connection ? `${a.connection.name} · ${reachLabel(reach(a.connection.baseUrl))} · sees what it reads here` : 'No connection'}</span>
        {a.usage && <span className="aiUsage" title="Tokens used in this chat since it was opened">{a.usage.totalInput.toLocaleString('en')} tokens in · {a.usage.totalOutput.toLocaleString('en')} out</span>}</div>
        {busy && <button type="button" className="btn small" onClick={() => { a.stop(); focusBox() }}>Stop</button>}
      </footer>
      </div>
      <div className="sr" aria-live="polite" data-testid="assistant-said">{said}</div>
    </aside>
    {/* outside the panel, so it shows when the panel was closed meanwhile */}
    {a.pendingConsent && <ConsentDialog connection={a.pendingConsent.connection} onAllow={() => void allow()} onDecline={() => { a.declineConsent(); focusBox() }} />}
    {node}
  </>
}
