import { type ReactNode, useEffect, useRef, useState } from 'react'

const KEY = 'dispatch.splitRatio'
const MIN = 0.15, MAX = 0.85, DEFAULT = 0.5
const clamp = (n: number) => Math.min(MAX, Math.max(MIN, n))
function saved(): number { try { const n = Number(localStorage.getItem(KEY)); return n ? clamp(n) : DEFAULT } catch { return DEFAULT } }
function keep(n: number) { try { localStorage.setItem(KEY, String(n)) } catch { /* not remembered */ } }

function useMedia(query: string): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [on, setOn] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const m = window.matchMedia(query)
    const f = () => setOn(m.matches)
    m.addEventListener?.('change', f)
    return () => m.removeEventListener?.('change', f)
  }, [query])
  return on
}

/**
 * Request above response (side by side on wide screens) with a divider you drag, like Postman: each side scrolls
 * on its own, so giving the request more room gives the body editor more room. Arrow keys move it too, a
 * double-click resets it, and the position is remembered. On phones the two simply stack.
 */
export function SplitPane({ first, second }: { first: ReactNode; second: ReactNode }) {
  const wide = useMedia('(min-width: 1500px)')
  const narrow = useMedia('(max-width: 760px)')
  const [ratio, setRatio] = useState(saved)
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const set = (n: number) => { const r = clamp(n); setRatio(r); keep(r) }

  if (narrow) return <div className="split">{first}{second}</div>
  const a = `minmax(0, ${ratio}fr)`, b = `minmax(0, ${1 - ratio}fr)`
  const style = wide ? { gridTemplateColumns: `${a} 10px ${b}`, gridTemplateRows: 'minmax(0, 1fr)' } : { gridTemplateRows: `${a} 10px ${b}`, gridTemplateColumns: 'minmax(0, 1fr)' }
  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    return wide ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height
  }
  return (
    <div ref={box} className={`split sized ${wide ? 'wide' : 'tall'}`} style={style}>
      {first}
      <div className="splitter" role="separator" tabIndex={0} aria-orientation={wide ? 'vertical' : 'horizontal'}
        aria-label="Resize the request and response" aria-valuemin={MIN * 100} aria-valuemax={MAX * 100} aria-valuenow={Math.round(ratio * 100)}
        title="Drag to resize; double-click to reset"
        onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); dragging.current = true; document.body.classList.add(wide ? 'resizing' : 'resizingRows') }}
        onPointerMove={(e) => { if (dragging.current) setRatio(clamp(at(e))) }}
        onPointerUp={(e) => { if (!dragging.current) return; dragging.current = false; document.body.classList.remove('resizing', 'resizingRows'); set(at(e)); (e.target as HTMLElement).releasePointerCapture?.(e.pointerId) }}
        onDoubleClick={() => set(DEFAULT)}
        onKeyDown={(e) => {
          const back = wide ? 'ArrowLeft' : 'ArrowUp', fwd = wide ? 'ArrowRight' : 'ArrowDown'
          const step = e.shiftKey ? 0.1 : 0.03
          if (e.key === back) { e.preventDefault(); set(ratio - step) }
          else if (e.key === fwd) { e.preventDefault(); set(ratio + step) }
          else if (e.key === 'Home') { e.preventDefault(); set(MIN) }
          else if (e.key === 'End') { e.preventDefault(); set(MAX) }
        }} />
      {second}
    </div>
  )
}
