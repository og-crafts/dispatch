/** One proposed change: what would be different, what to know about it, and the person's decision. All of it is plain text. */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Field, Line } from '../../core/assistant/proposal'
import { oneLine } from '../../core/assistant/propose'
import type { AssistantApi, Card } from './useAssistant'

/** How long a card's buttons do nothing after they came: a click or key meant for something else must not decide. */
const ARM_MS = 500
const FOLD_LINES = 200, FOLD_CHARS = 20_000
/** Drawn at once when the rest is shown; more follows, a part at a time. */
const PART_LINES = 2000
const GROUP = 200
/** A longer line is drawn in pieces, which a browser can leave out while they aren't seen. */
const PIECE = 4000
const NAME_MOST = 1000

const SIGN = { same: ' ', add: '+', del: '−' }
const SPOKEN = { add: 'added: ', del: 'removed: ' }
/** Very long names keep their start and their end. */
const short = (s: string) => { const c = [...s.slice(0, 1_000_000)]; return c.length <= NAME_MOST ? s : `${c.slice(0, NAME_MOST / 2).join('')} … ${c.slice(-NAME_MOST / 2).join('')}` }
const count = (n: number) => n.toLocaleString('en')

/** A whole character is never cut in two. */
function cut(s: string, most: number): string {
  const end = /[\uD800-\uDBFF]/.test(s[most - 1] ?? '') ? most - 1 : most
  return s.length <= most ? s : s.slice(0, end)
}
function pieces(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length;) { const p = cut(s.slice(i, i + PIECE + 1), PIECE); out.push(p); i += p.length }
  return out
}

function Row({ l }: { l: Line }) {
  if (l.type === 'gap') return <span className="aiLine gap">{l.text}</span>
  return (
    <span className={`aiLine ${l.type}`}>
      <span className="sign" aria-hidden="true">{SIGN[l.type]}</span>{l.type !== 'same' && <span className="sr">{SPOKEN[l.type]}</span>}
      {l.text.length <= PIECE ? <span className="text">{l.text}</span> : <span className="text">{pieces(l.text).map((p, i) => <span key={i} className="piece">{p}</span>)}</span>}
    </span>
  )
}
const Rows = memo(function Rows({ lines }: { lines: Line[] }) { return <span className="aiRows">{lines.map((l, i) => <Row key={i} l={l} />)}</span> })

interface Part { label: string; groups: Line[][] }
const grouped = (lines: Line[]): Line[][] => { const out: Line[][] = []; for (let i = 0; i < lines.length; i += GROUP) out.push(lines.slice(i, i + GROUP)); return out }
/** The fields' first lines, and whether that is all. */
function firstOf(fields: Field[], most: number, chars: number): Part[] {
  const out: Part[] = []
  for (const f of fields) {
    const lines: Line[] = []
    for (const l of f.lines) {
      if (most <= 0 || chars <= 0) break
      lines.push(l.text.length > chars ? { ...l, text: `${cut(l.text, chars)}…` } : l)
      most--; chars -= l.text.length
    }
    if (lines.length) out.push({ label: f.label, groups: grouped(lines) })
  }
  return out
}

/** Draws fields, folded when they are long. `onAll` hears once everything is drawn (at once for short ones). */
function Diff({ fields, onAll, onOpen }: { fields: Field[]; onAll?: () => void; onOpen: () => void }) {
  const size = useMemo(() => ({
    lines: fields.reduce((n, f) => n + f.lines.length, 0),
    chars: fields.reduce((n, f) => n + f.lines.reduce((m, l) => m + l.text.length, 0), 0),
  }), [fields])
  const fold = size.lines > FOLD_LINES || size.chars > FOLD_CHARS
  /** Lines that may be drawn; 0 while folded. */
  const [drawn, setDrawn] = useState(0)
  const all = !fold || drawn >= size.lines
  useEffect(() => {
    if (!drawn || drawn >= size.lines) return
    const t = setTimeout(() => setDrawn((n) => n + PART_LINES), 30)
    return () => clearTimeout(t)
  }, [drawn, size.lines])
  useEffect(() => { if (all) onAll?.() }, [all]) // eslint-disable-line react-hooks/exhaustive-deps
  const folded = useMemo(() => (fold ? firstOf(fields, FOLD_LINES, FOLD_CHARS) : null), [fields, fold])
  const whole = useMemo(() => (fold && !drawn ? [] : fields.map((f): Part => ({ label: f.label, groups: grouped(f.lines) }))), [fields, fold, drawn > 0]) // eslint-disable-line react-hooks/exhaustive-deps
  let left = !fold ? Infinity : drawn
  return <>
    {(drawn || !fold ? whole : folded!).map((p, i) => {
      if (fold && drawn && left <= 0) return null
      // whole groups only, so the ones that are there aren't drawn again
      const groups = fold && drawn ? p.groups.filter((g) => { const yes = left > 0; left -= g.length; return yes }) : p.groups
      return <div key={i} className="aiField"><h4>{p.label}</h4><pre className="aiDiff">{groups.map((g, k) => <Rows key={k} lines={g} />)}</pre></div>
    })}
    {fold && !drawn && <button type="button" className="btn small" onClick={() => { onOpen(); setDrawn(PART_LINES) }}>
      {size.lines > FOLD_LINES ? `Show all ${count(size.lines)} lines` : `Show all ${count(size.chars)} characters`}</button>}
  </>
}

/** What the card says once it was decided. */
export function outcome(c: Card): string {
  const text = c.text && short(oneLine(c.text))
  switch (c.state) {
    case 'waiting': return ''
    case 'applying': return 'Applying…'
    case 'applied': return text ?? 'Applied.'
    case 'undone': return 'Undone.'
    case 'rejected': return 'Rejected. Nothing was changed.'
    case 'stopped': return 'Stopped. Nothing was changed.'
    case 'expired': return text ?? 'This changed meanwhile, so nothing was applied.'
  }
}

type Actions = Pick<AssistantApi, 'approve' | 'reject' | 'undo'>
/** `open`: the panel is. `act` must stay the same object, so a card isn't drawn again for every piece of an answer. */
export const ChangeCard = memo(function ChangeCard({ card: c, open, act }: { card: Card; open: boolean; act: { current: Actions } }) {
  const { title, fields, warnings, cls } = c.proposal
  const { id } = c.proposal
  const at = useId()
  const me = useRef<HTMLDivElement>(null)
  const [all, setAll] = useState(false)
  const decides = c.state === 'waiting', undoes = c.state === 'applied'
  // Buttons that just came, moved or changed wait; the key says which ones are ready.
  const key = `${id} ${decides ? 'decide' : undoes ? 'undo' : ''} ${open} ${all}`
  const [ready, setReady] = useState('')
  useEffect(() => {
    if (!open || !(decides || undoes)) return
    const t = setTimeout(() => setReady(key), ARM_MS)
    return () => { clearTimeout(t); setReady('') } // also when the panel is closed and opened again
  }, [key, open, decides, undoes])
  const armed = open && ready === key
  const gone = cls === 'delete'
  const said = outcome(c)
  return (
    <div ref={me} className={`aiCard ${c.state} ${cls}`} role="group" aria-label={short(title)} tabIndex={-1}
      // a key that is held down was pressed for something else
      onKeyDown={(e) => { if (e.repeat && (e.key === 'Enter' || e.key === ' ') && (e.target as Element).closest('button')) e.preventDefault() }}>
      <h3>{short(title)}</h3>
      <Diff fields={fields} onAll={() => setAll(true)} onOpen={() => me.current?.focus()} />
      {warnings.length > 0 && <ul className="aiRisks">{warnings.map((w, i) => <li key={i}>{short(w)}</li>)}</ul>}
      {gone && (decides || undoes || c.state === 'applying') && <p className="muted small">You can undo this until Dispatch closes.</p>}
      {said && <p className={`aiOutcome small ${c.state === 'expired' || (undoes && c.text) ? 'warnLine' : 'muted'}`}>{said}</p>}
      {undoes && c.now && <div className="aiNow"><p className="muted small">Since it was applied, this has changed:</p><Diff fields={c.now} onOpen={() => me.current?.focus()} /></div>}
      {decides && <div className="actions">
        <button type="button" className={`btn small ${gone ? 'danger' : 'primary'}`} disabled={!armed || !all} aria-describedby={all ? undefined : `${at}-rest`} onClick={() => void act.current.approve(id)}>{gone ? 'Delete' : 'Apply'}</button>
        <button type="button" className="btn small" disabled={!armed} onClick={() => act.current.reject(id)}>Reject</button>
        {!all && <span id={`${at}-rest`} className="muted small">Show the rest first.</span>}
      </div>}
      {undoes && <div className="actions"><button type="button" className="btn small" disabled={!armed} onClick={() => void act.current.undo(id)}>Undo</button></div>}
    </div>
  )
})
