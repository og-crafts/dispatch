/** Key/value tables: long values stay readable, and the key column can be resized. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { KVTable } from '../src/ui/KVTable'
import { kv } from '../src/core/types'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const value = (n = 1) => screen.getByLabelText(`Headers Value ${n}`) as HTMLTextAreaElement
const handle = () => screen.getByRole('separator', { name: 'Resize the key column' })
const width = () => Number(handle().getAttribute('aria-valuenow'))

describe('values', () => {
  it('are a field that holds and wraps the whole value', () => {
    const long = 'x'.repeat(500)
    render(<KVTable label="Headers" rows={[kv('a', long)]} onChange={() => {}} />)
    expect(value().tagName).toBe('TEXTAREA'); expect(value().value).toBe(long); expect(value().rows).toBe(1)
  })
  it('stay on one line: Enter adds nothing, a pasted line break becomes a space', () => {
    const onChange = vi.fn()
    render(<KVTable label="Headers" rows={[kv('a', 'b')]} onChange={onChange} />)
    expect(fireEvent.keyDown(value(), { key: 'Enter' })).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(value(), { target: { value: 'a\r\nb\nc' } })
    expect(onChange.mock.calls[0][0][0].value).toBe('a b c')
  })
  it('Ctrl+Enter still reaches the app (it sends)', () => {
    render(<KVTable label="Headers" rows={[kv('a', 'b')]} onChange={() => {}} />)
    expect(fireEvent.keyDown(value(), { key: 'Enter', ctrlKey: true })).toBe(true)
  })
  it('keep secrets in a password field, and files as a picker', () => {
    render(<KVTable label="Headers" allowFiles rows={[{ ...kv('s', 'x'), secret: true }, { ...kv('f'), type: 'file' }]} onChange={() => {}} />)
    expect((value() as unknown as HTMLInputElement).type).toBe('password')
    expect(screen.getByLabelText('Headers file 2')).toBeTruthy()
  })
})

describe('key column', () => {
  it('resizes with the arrow keys, remembers its width, and resets', () => {
    const { unmount } = render(<KVTable label="Headers" rows={[]} onChange={() => {}} />)
    const w = width()
    fireEvent.keyDown(handle(), { key: 'ArrowRight' }); expect(width()).toBe(w + 16)
    unmount()
    render(<KVTable label="Headers" rows={[]} onChange={() => {}} />)
    expect(width()).toBe(w + 16)
    fireEvent.doubleClick(handle()); expect(width()).toBe(w)
  })
  it('stays within bounds and works without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    render(<KVTable label="Headers" rows={[]} onChange={() => {}} />)
    fireEvent.keyDown(handle(), { key: 'End' }); expect(width()).toBe(600)
    fireEvent.keyDown(handle(), { key: 'Home' }); expect(width()).toBe(120)
  })
})
