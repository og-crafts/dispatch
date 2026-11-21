import { useEffect } from 'react'

/**
 * The dropdowns built on <details class="menu"> (the ☰ menu, a sidebar row's ⋯, variables help, request as code)
 * only close from their own button. This closes them the way people expect: a click anywhere outside, Escape
 * (focus goes back to the menu's button), or the window losing focus. Opening one menu closes any other.
 */
export function useMenuDismiss() {
  useEffect(() => {
    const open = () => [...document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')]
    const outside = (e: Event) => {
      const t = e.target as Node | null
      open().forEach((d) => { if (!t || !d.contains(t)) d.open = false })
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const list = open(); if (!list.length) return
      const focusIn = list.find((d) => d.contains(document.activeElement))
      list.forEach((d) => { d.open = false })
      e.preventDefault()
      ;(focusIn ?? list[list.length - 1]).querySelector('summary')?.focus()
    }
    const blur = () => open().forEach((d) => { d.open = false })
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', blur)
    }
  }, [])
}
