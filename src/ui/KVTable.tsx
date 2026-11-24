import { useRef, useState } from 'react'
import type { FileData, KV } from '../core/types'
import { kv } from '../core/types'
import { formatBytes } from '../core/format'
import { useContextMenu } from './ContextMenu'
import { Icon } from './Icons'
import { ValueField } from './ValueField'

interface Props {
  rows: KV[]
  onChange: (rows: KV[]) => void
  label: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  /** Form-data: each row can be text or a file. */
  allowFiles?: boolean
  /** Every row here is a secret: new rows get the flag, and values are masked until shown. */
  secret?: boolean
  /** A ⋯ menu on each row. */
  rowMenu?: (row: KV, i: number) => [string, () => void][]
  /** A line under a row's value. */
  rowHint?: (row: KV, i: number) => React.ReactNode
  /** Path variables: keys come from the URL and can't be edited, added or removed. */
  fixedKeys?: boolean
}

export const MAX_FILE = 25 * 1024 * 1024

/** Reads a picked file into what a request stores. */
export function readFileData(file: File): Promise<FileData> {
  if (file.size > MAX_FILE) return Promise.reject(new Error(`${file.name} is ${formatBytes(file.size)}; files up to ${formatBytes(MAX_FILE)} can be attached.`))
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      resolve({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, base64: url.slice(url.indexOf(',') + 1) })
    }
    r.onerror = () => reject(new Error(`Couldn’t read ${file.name}.`))
    r.readAsDataURL(file)
  })
}

export function FilePick({ file, onPick, label, onError }: { file: FileData | null | undefined; onPick: (f: FileData | null) => void; label: string; onError?: (m: string) => void }) {
  return (
    <span className="filePick">
      <label className="btn small">
        {file ? 'Change file' : 'Choose file'}
        <input type="file" className="sr" aria-label={label} onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (!f) return
          try { onPick(await readFileData(f)) } catch (err) { onError?.(err instanceof Error ? err.message : String(err)) }
        }} />
      </label>
      {file ? <span className="small mono fileName" title={file.name}>{file.name} · {formatBytes(file.size)}</span> : <span className="small muted">No file</span>}
    </span>
  )
}

const MIN_KEY = 120, MAX_KEY = 600, DEFAULT_KEY = 240
const clampKey = (n: number) => Math.min(MAX_KEY, Math.max(MIN_KEY, Math.round(n)))
const keyName = (label: string) => `dispatch.kvKey.${label}`
function savedKey(label: string) {
  try { const n = Number(localStorage.getItem(keyName(label))); return n ? clampKey(n) : DEFAULT_KEY } catch { return DEFAULT_KEY }
}

/** An editable key/value table that always ends with an empty row to type into.
 * Rows are keyed by position so typing into the empty row keeps focus when it becomes a real row. */
export function KVTable({ rows, onChange, label, keyPlaceholder = 'Key', valuePlaceholder = 'Value', allowFiles, secret, rowMenu, rowHint, fixedKeys }: Props) {
  const ghost = kv('', '', true, { ...(allowFiles ? { type: 'text' as const } : {}), ...(secret ? { secret: true } : {}) })
  const ctx = useContextMenu()
  /** Secrets shown on purpose, until the screen is left. */
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set())
  const flip = (id: string) => setShown((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const all = fixedKeys ? rows : [...rows, ghost]
  const update = (i: number, patch: Partial<KV>) => {
    if (i === rows.length) { onChange([...rows, { ...ghost, ...patch }]); return }
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }
  const [keyW, setKeyW] = useState(() => savedKey(label))
  const resizing = useRef<{ x: number; w: number } | null>(null)
  const setKey = (n: number) => { const w = clampKey(n); setKeyW(w); try { localStorage.setItem(keyName(label), String(w)) } catch { /* not remembered */ } }
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))

  return (
    <div className="kvWrap"><table className="kv" aria-label={label}>
      <thead>
        <tr>
          <th className="kv-on"><span className="sr">On</span></th><th className="kv-key" style={{ width: `min(${keyW}px, 45cqw)` }}>{keyPlaceholder}
            <div className="kvResizer" role="separator" aria-orientation="vertical" aria-label="Resize the key column" tabIndex={0}
              aria-valuemin={MIN_KEY} aria-valuemax={MAX_KEY} aria-valuenow={keyW} title="Drag to resize; double-click to reset"
              onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); resizing.current = { x: e.clientX, w: keyW }; document.body.classList.add('resizing') }}
              onPointerMove={(e) => { if (resizing.current) setKeyW(clampKey(resizing.current.w + e.clientX - resizing.current.x)) }}
              onPointerUp={(e) => { if (!resizing.current) return; resizing.current = null; document.body.classList.remove('resizing'); setKey(keyW); e.currentTarget.releasePointerCapture?.(e.pointerId) }}
              onPointerCancel={() => { resizing.current = null; document.body.classList.remove('resizing') }}
              onDoubleClick={() => setKey(DEFAULT_KEY)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 64 : 16
                const to = e.key === 'ArrowLeft' ? keyW - step : e.key === 'ArrowRight' ? keyW + step : e.key === 'Home' ? MIN_KEY : e.key === 'End' ? MAX_KEY : null
                if (to !== null) { e.preventDefault(); setKey(to) }
              }} />
          </th>
          {allowFiles && <th className="kv-type">Type</th>}
          <th>{valuePlaceholder}</th>
          {secret && <th className="kv-more"><span className="sr">Show</span></th>}
          {rowMenu && <th className="kv-more"><span className="sr">More</span></th>}
          {!fixedKeys && <th className="kv-x"><span className="sr">Remove</span></th>}
        </tr>
      </thead>
      <tbody>
        {all.map((r, i) => {
          const isGhost = i === rows.length
          const isFile = allowFiles && r.type === 'file'
          return (
            <tr key={i} className={r.enabled || isGhost ? '' : 'off'}>
              <td className="kv-on">
                {!isGhost && <input type="checkbox" checked={r.enabled} aria-label={`Use ${r.key || 'row'}`} onChange={(e) => update(i, { enabled: e.target.checked })} />}
              </td>
              <td>
                <input className="mono" value={r.key} readOnly={fixedKeys} placeholder={isGhost ? `Add ${keyPlaceholder.toLowerCase()}` : keyPlaceholder}
                  aria-label={`${label} ${keyPlaceholder} ${i + 1}`} spellCheck={false} onChange={(e) => update(i, { key: e.target.value })} />
              </td>
              {allowFiles && (
                <td className="kv-type">
                  <select aria-label={`${label} type ${i + 1}`} value={r.type ?? 'text'} onChange={(e) => update(i, { type: e.target.value as 'text' | 'file', file: null })}>
                    <option value="text">Text</option><option value="file">File</option>
                  </select>
                </td>
              )}
              <td>
                {isFile
                  ? <FilePick file={r.file} label={`${label} file ${i + 1}`} onPick={(file) => update(i, { file })} />
                  : <ValueField value={r.value} secret={r.secret && !shown.has(r.id)} placeholder={valuePlaceholder} label={`${label} ${valuePlaceholder} ${i + 1}`} onChange={(value) => update(i, { value })} />}
                {!isGhost && rowHint?.(r, i)}
              </td>
              {secret && (
                <td className="kv-more">{!isGhost && <button type="button" className="icon" aria-label={`${shown.has(r.id) ? 'Hide' : 'Show'} ${r.key || 'row'}`} title={shown.has(r.id) ? 'Hide the value' : 'Show the value'} onClick={() => flip(r.id)}><Icon name={shown.has(r.id) ? 'eyeOff' : 'eye'} size={15} /></button>}</td>
              )}
              {rowMenu && (
                <td className="kv-more">{!isGhost && <button type="button" className="icon" aria-label={`More for ${r.key || 'row'}`} aria-haspopup="menu"
                  onClick={(e) => ctx.open(e, rowMenu(r, i).map(([text, run]) => ({ label: text, run: () => { if (shown.has(r.id)) flip(r.id); run() } })), `More for ${r.key || 'row'}`)}>⋯</button>}</td>
              )}
              {!fixedKeys && <td className="kv-x">{!isGhost && <button type="button" className="icon" aria-label={`Remove ${r.key || 'row'}`} onClick={() => remove(i)}>×</button>}</td>}
            </tr>
          )
        })}
      </tbody>
    </table>{ctx.node}</div>
  )
}
