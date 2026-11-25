/** The code editor (CodeMirror) and texts that come from outside: an applied change, its undo. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

// Outside jsdom's user agent the real editor is used.
vi.hoisted(() => { Object.defineProperty(navigator, 'userAgent', { value: 'Chrome', configurable: true }) })
import { CodeArea } from '../src/ui/CodeArea'
import { createEditor, syncDoc, type Editor } from '../src/ui/editor/codemirror'

afterEach(() => cleanup())

it('shows an undo back to a text that was typed here before', async () => {
  const editor: { current: Editor | null } = { current: null }
  const at = (value: string) => <CodeArea label="Script" value={value} onChange={() => {}} editorRef={editor} />
  const { rerender } = render(at('a'))
  rerender(at('newer')) // changed while the editor was loading
  await waitFor(() => expect(editor.current).not.toBeNull(), { timeout: 5000 })
  const doc = () => editor.current!.view.state.doc.toString()
  expect(doc()).toBe('newer')
  editor.current!.view.dispatch({ changes: { from: 5, insert: ' typed' } })
  rerender(at('newer typed'))
  rerender(at('applied'))
  await waitFor(() => expect(doc()).toBe('applied'))
  rerender(at('newer typed'))
  await waitFor(() => expect(doc()).toBe('newer typed'))
})

it('doesn’t report a text from outside as typing', async () => {
  const host = document.body.appendChild(document.createElement('div')), typed = vi.fn()
  const ed = await createEditor(host, { doc: 'a', lang: 'text', label: 'x', onChange: typed })
  syncDoc(ed.view, 'one\r\ntwo')
  expect(typed).not.toHaveBeenCalled()
  ed.view.dispatch({ changes: { from: 0, insert: 'z' } })
  expect(typed).toHaveBeenCalledTimes(1)
  ed.destroy()
})
