import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** One entry of a right-click menu; '-' draws a divider. */
export type ContextItem = '-' | { label: string; run: () => void; tone?: 'danger'; hint?: string; disabled?: boolean }

interface Open { x: number; y: number; items: ContextItem[]; label: string }

/**
 * A right-click menu at the pointer (or under the focused element when opened from the keyboard: Shift+F10 or the
 * Menu key). Arrow keys move, Enter picks, Escape or a click elsewhere closes, and focus goes back where it was.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<Open | null>(null)
  const open = useCallback((e: React.MouseEvent | MouseEvent, items: ContextItem[], label = 'Actions') => {
    if (!items.some((x) => x !== '-')) return
    e.preventDefault(); e.stopPropagation()
    let { clientX: x, clientY: y } = e
    // From the keyboard the event has no pointer position; open under the element instead.
    if (!x && !y && e.currentTarget instanceof Element) { const r = e.currentTarget.getBoundingClientRect(); x = r.left; y = r.bottom }
    setMenu({ x, y, items, label })
  }, [])
  const node = menu ? <Menu menu={menu} close={() => setMenu(null)} /> : null
  return { open, node }
}

function Menu({ menu, close }: { menu: Open; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const back = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  // Keep it on screen.
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    const w = window.innerWidth, h = window.innerHeight
    setPos({ left: Math.max(4, Math.min(menu.x, w - r.width - 4)), top: Math.max(4, menu.y + r.height > h - 4 ? menu.y - r.height : menu.y) })
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])

  useEffect(() => {
    const done = () => { close(); (back.current as HTMLElement | null)?.focus?.() }
    const outside = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); done() } }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('contextmenu', outside, true)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('contextmenu', outside, true)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [close])

  const move = (e: React.KeyboardEvent) => {
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus() }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Tab') { e.preventDefault(); close() }
  }

  // On <body>: glass panels (backdrop-filter) would otherwise become the box that position: fixed is measured from.
  return createPortal(
    <div ref={ref} className="ctxMenu" role="menu" aria-label={menu.label} style={{ left: pos.left, top: pos.top }} onKeyDown={move}>
      {menu.items.map((it, i) => it === '-'
        ? <div key={`sep${i}`} className="ctxSep" role="separator" />
        : (
          <button key={it.label} type="button" role="menuitem" className={it.tone ?? ''} disabled={it.disabled}
            onClick={() => { close(); it.run() }}>
            <span>{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ))}
    </div>,
    document.body,
  )
}

/**
 * The ⋯ menu of the sidebar row under the pointer, as a right-click menu: its items are read from the row's own
 * menu, and picking one clicks the real item, so both menus always match.
 */
export function rowMenuItems(target: EventTarget | null): { items: ContextItem[]; label: string } | null {
  const row = (target as Element | null)?.closest?.('.row')
  const details = row?.querySelector(':scope > details.menu')
  if (!details) return null
  const buttons = [...details.querySelectorAll<HTMLButtonElement>('.menuList > button')]
  const label = details.querySelector('summary')?.getAttribute('aria-label') ?? 'Actions'
  const items: ContextItem[] = []
  buttons.forEach((b) => {
    const danger = b.classList.contains('danger')
    if (danger && items.length) items.push('-')
    items.push({ label: b.textContent ?? '', run: () => b.click(), tone: danger ? 'danger' : undefined })
  })
  return { items, label }
}
