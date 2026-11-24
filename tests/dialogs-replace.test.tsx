import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useDialogs } from '../src/ui/Dialogs'
afterEach(() => cleanup())
it('a dialog replaced by another counts as cancelled', async () => {
  let api!: ReturnType<typeof useDialogs>
  function Host() { api = useDialogs(); return <>{api.node}</> }
  render(<Host />)
  let first: boolean | undefined
  await act(async () => { void api.confirm('First?').then((v) => { first = v }) })
  await act(async () => { void api.ask('Name', 'abc') })
  expect(first).toBe(false)
  expect((screen.getByDisplayValue('abc') as HTMLInputElement).value).toBe('abc')
})
