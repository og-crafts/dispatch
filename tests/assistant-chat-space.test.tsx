/** Chats go with their workspace: removing one deletes its chats, and chats of a workspace that is already gone are swept on load. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useWorkspace } from '../src/ui/useWorkspace'
import * as db from '../src/core/db'
import * as chats from '../src/core/assistant/chats'
import type { Transport } from '../src/core/transport'

vi.mock('../src/core/assistant/chats', async (orig) => { const m = await orig<typeof import('../src/core/assistant/chats')>(); return { ...m, deleteChats: vi.fn(m.deleteChats) } })

const desktop: Transport = { label: 'fake', unrestricted: true, send: async () => { throw new Error('no network') } }
beforeEach(async () => { await db.resetForTests() })
afterEach(() => cleanup())

const chat = (id: string, spaceId: string): chats.Chat => ({ id, spaceId, connectionId: 'c', model: 'm', title: id, messages: [{ role: 'user', content: 'hi' }], updatedAt: 1 })
async function mount() {
  const h = renderHook(() => useWorkspace({ transport: desktop }))
  await waitFor(() => expect(h.result.current.ready).toBe(true))
  return h
}

describe('chats and workspaces', () => {
  it('removing a workspace deletes its chats and keeps the others', async () => {
    const h = await mount()
    let work = ''
    await act(async () => { work = (await h.result.current.addSpace('Work')).id })
    expect(await chats.saveChat(chat('w', work))).toBe(true)
    expect(await chats.saveChat(chat('home', 'default'))).toBe(true)
    let ok = false
    await act(async () => { ok = await h.result.current.removeSpace(work) })
    expect(ok).toBe(true)
    expect(await chats.listChats(work)).toEqual([])
    expect(await db.getChatRecord('w')).toBeUndefined()
    expect((await chats.listChats('default')).map((c) => c.id)).toEqual(['home'])
  })

  it('still cleans up (switches away, saves the list) when deleting the chats fails', async () => {
    const h = await mount()
    let work = ''
    await act(async () => { work = (await h.result.current.addSpace('Work')).id })
    act(() => { h.result.current.switchSpace(work) })
    vi.mocked(chats.deleteChats).mockRejectedValueOnce(new Error('disk'))
    let ok = false
    await act(async () => { ok = await h.result.current.removeSpace(work) })
    expect(ok).toBe(true)
    expect(h.result.current.activeSpaceId).toBe('default')
    expect((await db.getSpaces()).some((x) => x.id === work)).toBe(false)
  })

  it('every workspace’s tabs are known, the shown ones apart', async () => {
    const h = await mount()
    await waitFor(() => expect(h.result.current.tabs[0].space).toBe('default'))
    await act(async () => { h.result.current.switchSpace((await h.result.current.addSpace('Work')).id) })
    expect(h.result.current.tabs).toHaveLength(1)
    expect(h.result.current.allTabs).toHaveLength(2)
  })

  it('on load, chats of a workspace that is no longer listed are removed', async () => {
    await db.putSpaces([{ id: 'default', name: 'Default' }, { id: 'x', name: 'X' }] as never)
    await chats.saveChat(chat('orphan', 'x')); await chats.saveChat(chat('keep', 'default'))
    await db.putSpaces([{ id: 'default', name: 'Default' }] as never)
    await mount()
    await waitFor(async () => expect((await db.getChatIndex()).map((e) => e.id)).toEqual(['keep']))
    expect(await db.getChatRecord('orphan')).toBeUndefined()
  })

  it.each(['rename', 'remove'])('%s from a stale screen keeps a workspace added since, so its chats survive the sweep', async (how) => {
    const h = await mount()
    let old = ''
    await act(async () => { old = (await h.result.current.addSpace('Old')).id })
    const stale = h.result.current
    let fresh = ''
    await act(async () => {
      fresh = (await stale.addSpace('Fresh')).id
      await chats.saveChat(chat('f', fresh))
      if (how === 'rename') await stale.renameSpace(old, 'Older'); else await stale.removeSpace(old)
    })
    expect((await db.getSpaces()).map((x) => x.id)).toContain(fresh)
    await chats.sweepChats()
    expect((await chats.listChats(fresh)).map((c) => c.id)).toEqual(['f'])
  })
})
