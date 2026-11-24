import { useLayoutEffect, useRef, useState } from 'react'

interface Props {
  value: string
  label: string
  /** `byKey`: finished from the keyboard, so focus should go back to the row. */
  onSave: (name: string, byKey: boolean) => void
  onCancel: (byKey: boolean) => void
}

/** A name being edited where it stands: Enter or leaving saves, Escape (or an empty name) cancels. */
export function InlineName({ value, label, onSave, onCancel }: Props) {
  const [text, setText] = useState(value)
  const input = useRef<HTMLInputElement>(null)
  // Removing the focused field fires blur in some browsers; only the first way out counts.
  const done = useRef(false)
  useLayoutEffect(() => { input.current?.focus(); input.current?.select() }, [])
  const finish = (save: boolean, byKey: boolean) => {
    if (done.current) return
    done.current = true
    const name = text.trim()
    if (save && name && name !== value) onSave(name, byKey); else onCancel(byKey)
  }
  return (
    <input ref={input} className="inlineName" value={text} aria-label={label} spellCheck={false} autoComplete="off"
      onChange={(e) => setText(e.target.value)} onBlur={() => finish(true, false)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true, true) }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true) }
      }} />
  )
}
