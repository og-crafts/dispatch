import { useLayoutEffect, useState, type RefObject } from 'react'

export const MIN_W = 300, MAX_W = 720
const WORK = 320, BESIDE = 1200

/** Whether the panel lies over the work area (which then can't be reached) or beside it, and how wide it may be. */
export function usePanelLayout(panel: RefObject<HTMLElement>, open: boolean): { over: boolean; most: number } {
  const [layout, setLayout] = useState({ over: window.innerWidth < BESIDE, most: MAX_W })
  useLayoutEffect(() => {
    if (!open) return
    const app = panel.current?.closest<HTMLElement>('.app')
    const side = app?.querySelector<HTMLElement>('.side')
    const work = app?.querySelector<HTMLElement>('.work')
    const measure = () => {
      const px = (v: string) => parseFloat(v) || 0
      const css = app && getComputedStyle(app)
      const gap = css ? px(css.columnGap) : 0
      const free = window.innerWidth - (css ? px(css.paddingLeft) + px(css.paddingRight) : 0) - (side?.offsetWidth ?? 0) - gap
      const beside = free - gap - WORK
      const over = window.innerWidth < BESIDE || beside < MIN_W
      const most = Math.max(MIN_W, Math.min(MAX_W, Math.floor(over ? free : beside)))
      app?.setAttribute('data-assistant', over ? 'over' : 'beside')
      work?.toggleAttribute('inert', over)
      setLayout((l) => (l.over === over && l.most === most ? l : { over, most }))
    }
    measure()
    window.addEventListener('resize', measure)
    const sized = typeof ResizeObserver === 'undefined' || !side ? null : new ResizeObserver(measure)
    if (side) sized?.observe(side)
    return () => {
      window.removeEventListener('resize', measure); sized?.disconnect()
      app?.removeAttribute('data-assistant'); work?.removeAttribute('inert')
    }
  }, [open, panel])
  return layout
}
