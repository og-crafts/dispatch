import { useEffect, useLayoutEffect, useRef } from 'react'

interface Props {
  value: string
  label: string
  placeholder?: string
  /** Masked, on one line. */
  secret?: boolean
  onChange: (v: string) => void
}

const MAX_LINES = 8

/** A value that wraps and grows to show all of it (up to 8 lines, then it scrolls). Still a single line of text. */
export function ValueField({ value, label, placeholder, secret, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fit = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const s = getComputedStyle(el)
    const border = el.offsetHeight - el.clientHeight
    const max = MAX_LINES * (parseFloat(s.lineHeight) || 20) + (parseFloat(s.paddingTop) || 0) + (parseFloat(s.paddingBottom) || 0) + border
    const want = el.scrollHeight + border
    if (!el.scrollHeight) return // not drawn (a hidden tab, the test DOM)
    el.style.height = `${Math.min(want, max)}px`
    el.style.overflowY = want > max ? 'auto' : 'hidden'
  }
  useLayoutEffect(fit, [value, secret])
  // A narrower or wider column wraps differently.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let last = el.clientWidth
    const ro = new ResizeObserver(() => { if (el.clientWidth !== last) { last = el.clientWidth; fit() } })
    ro.observe(el)
    return () => ro.disconnect()
  }, [secret])

  if (secret) {
    return <input className="mono" type="password" value={value} placeholder={placeholder} aria-label={label} spellCheck={false} autoComplete="off"
      onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <textarea ref={ref} className="mono valueField" rows={1} value={value} placeholder={placeholder} aria-label={label} spellCheck={false} autoComplete="off"
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) e.preventDefault() }}
      onChange={(e) => onChange(e.target.value.replace(/\r\n?|\n/g, ' '))} />
  )
}
