import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { kv, newEnvironment, newRequest } from '../src/core/types'
import { ParameterizePanel } from '../src/ui/Parameterize'
import type { WorkspaceApi } from '../src/ui/useWorkspace'

afterEach(() => cleanup())

it.each([true, false])('a name the chosen place already has (enabled: %s) is refused, and nothing is lost', async (enabled) => {
  const dev = newEnvironment('Dev'), other = { ...newEnvironment('Other'), variables: [kv('token', 'theirs', enabled)] }
  const ws = { draft: newRequest({ url: '{{base}}/x', headers: [kv('Authorization', 'Bearer abc-def-ghi')] }), environment: dev, environments: [dev, other], collection: null, globals: [], updateEnvironment: vi.fn(), setGlobals: vi.fn(), setDraft: vi.fn() }
  const notify = vi.fn(), onClose = vi.fn()
  render(<ParameterizePanel ws={ws as unknown as WorkspaceApi} notify={notify} onClose={onClose} />)
  fireEvent.change(screen.getByLabelText('Where to create variables'), { target: { value: `env:${other.id}` } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply 1' }))
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('“token” is already there. Choose another place, or rename that one first. Nothing was changed.'))
  expect(ws.updateEnvironment).not.toHaveBeenCalled()
  expect(ws.setDraft).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})
