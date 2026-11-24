import type { KV } from '../core/types'
import { isSecretName } from '../core/share'
import { KVTable } from './KVTable'

/** Puts an edited section (its plain or secret rows) back among the others, every row staying in its place. */
function merge(rows: KV[], section: KV[], next: KV[]): KV[] {
  if (next.length < section.length) return rows.filter((r) => !section.includes(r) || next.includes(r))
  const edited = new Map(section.map((r, i) => [r, next[i]]))
  return [...rows.map((r) => edited.get(r) ?? r), ...next.slice(section.length)]
}

/** Variables in two tables, plain and secret, over one list (the `secret` flag decides). */
export function VariablesEditor({ label, rows, note, onChange }: { label: string; rows: KV[]; note?: React.ReactNode; onChange: (rows: KV[]) => void }) {
  const plain = rows.filter((r) => !r.secret)
  const secret = rows.filter((r) => r.secret)
  const move = (r: KV, to: boolean) => onChange([...rows.filter((x) => x !== r), { ...r, secret: to }])
  return <>
    <h2>Variables</h2>
    {note}
    <KVTable label={`${label} variables`} keyPlaceholder="Variable" rows={plain} onChange={(next) => onChange(merge(rows, plain, next))}
      rowMenu={(r) => [['Make secret', () => move(r, true)]]}
      rowHint={(r) => (isSecretName(r.key) ? <button type="button" className="linkBtn kvHint" onClick={() => move(r, true)}>Looks like a secret: make it secret?</button> : null)} />
    <h2>Secrets</h2>
    <p className="muted small">Hidden on screen, left out of backups, and only synced in the encrypted secrets file if you turn that on.</p>
    <KVTable label={`${label} secrets`} keyPlaceholder="Variable" secret rows={secret} onChange={(next) => onChange(merge(rows, secret, next))}
      rowMenu={(r) => [['Make plain', () => move(r, false)]]} />
  </>
}
