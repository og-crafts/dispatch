/** Tabs and the AI assistant: closing several tabs stays in the open workspace, and assistant edits reach open tabs. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useWorkspace } from '../src/ui/useWorkspace'
import { resetForTests } from '../src/core/db'
import { newRequest } from '../src/core/types'
import type { Transport } from '../src/core/transport'

const desktop: Transport = { label: 'fake', unrestricted: true, send: async () => { throw new Error('no network') } }
beforeEach(async () => { await resetForTests() })
afterEach(() => cleanup())

async function mount() {
  const h = renderHook(() => useWorkspace({ transport: desktop }))
  await waitFor(() => expect(h.result.current.ready).toBe(true))
  return h
}

describe('closing several tabs', () => {
  it('only counts the open workspace’s tabs, and leaves it a fresh tab of its own', async () => {
    const h = await mount()
    const home = h.result.current.activeSpaceId
    let work = ''
    await act(async () => { work = (await h.result.current.addSpace('Work')).id })
    act(() => { h.result.current.switchSpace(work) })
    const workTab = h.result.current.activeId
    act(() => { h.result.current.switchSpace(home) })
    act(() => { h.result.current.startNew() })
    const homeTabs = h.result.current.tabs.map((t) => t.id)
    expect(homeTabs).toHaveLength(2)
    expect(homeTabs).not.toContain(workTab)

    // "Close all tabs" in the home workspace: it gets a fresh tab; Work's tab is neither shown nor made active.
    act(() => { h.result.current.closeTabs(homeTabs) })
    expect(h.result.current.tabs).toHaveLength(1)
    expect(homeTabs).not.toContain(h.result.current.activeId)
    expect(h.result.current.activeId).not.toBe(workTab)
    expect(h.result.current.tabs[0].space ?? home).toBe(home)

    // Work still has its own tab.
    act(() => { h.result.current.switchSpace(work) })
    expect(h.result.current.tabs.map((t) => t.id)).toEqual([workTab])
  })
})

describe('assistant edits and open tabs', () => {
  it('shows the assistant’s version in a tab without edits, and keeps a tab’s own unsaved edits', async () => {
    const h = await mount()
    let colId = ''
    await act(async () => { colId = (await h.result.current.addCollection('Shop')).id })
    await act(async () => { await h.result.current.setSpaceAi(h.result.current.activeSpaceId, true) })
    const a = newRequest({ name: 'A', url: 'https://a.test/v1', collectionId: colId })
    const b = newRequest({ name: 'B', url: 'https://b.test/v1', collectionId: colId })
    await act(async () => { await h.result.current.saveAssistant({ collections: [], folders: [], requests: [a, b] }) })
    act(() => { h.result.current.openRequest(h.result.current.requests.find((r) => r.id === a.id)!) })
    act(() => { h.result.current.openRequest(h.result.current.requests.find((r) => r.id === b.id)!) })
    // B gets an unsaved edit of the user's.
    act(() => { h.result.current.setDraft({ ...h.result.current.draft, url: 'https://b.test/mine' }) })

    await act(async () => {
      await h.result.current.saveAssistant({ collections: [], folders: [], requests: [
        { ...a, url: 'https://a.test/v2', updatedAt: Date.now() }, { ...b, url: 'https://b.test/v2', updatedAt: Date.now() },
      ] })
    })
    const tabOf = (id: string) => h.result.current.tabs.find((t) => t.draft.id === id)!
    expect(tabOf(a.id).draft.url).toBe('https://a.test/v2')
    expect(h.result.current.isDirty(tabOf(a.id).draft)).toBe(false)
    expect(tabOf(b.id).draft.url).toBe('https://b.test/mine')
    expect(h.result.current.isDirty(tabOf(b.id).draft)).toBe(true)
  })
})

describe('handing requests to the assistant', () => {
  it('carries the collection’s and folders’ scripts onto the copy, and two quick hand-offs share one Inbox', async () => {
    const h = await mount()
    let colId = ''
    let folderId = ''
    await act(async () => { colId = (await h.result.current.addCollection('Shop')).id })
    await act(async () => {
      const c = h.result.current.allCollections.find((x) => x.id === colId)!
      await h.result.current.updateCollection({ ...c, scripts: { pre: 'pm.variables.set("tok", "1")', post: '' } })
    })
    await act(async () => { folderId = (await h.result.current.addFolder(colId, 'Box')).id })
    await act(async () => {
      const f = h.result.current.folders.find((x) => x.id === folderId)!
      await h.result.current.updateFolder({ ...f, scripts: { pre: '', post: 'pm.test("box", () => {})' } })
    })
    await act(async () => { await h.result.current.setSpaceAi(h.result.current.activeSpaceId, true) })
    await act(async () => {
      const r = newRequest({ name: 'Items', url: 'https://s.test/items', collectionId: colId, folderId, scripts: { pre: 'console.log("own")', post: '' } })
      await h.result.current.saveAssistant({ collections: [], folders: [], requests: [r] })
    })
    const r = h.result.current.requests.find((x) => x.name === 'Items')!
    let copies: Awaited<ReturnType<typeof h.result.current.handToAssistant>>[] = []
    await act(async () => { copies = await Promise.all([h.result.current.handToAssistant(r, 'one'), h.result.current.handToAssistant(r, 'two')]) })
    expect(copies[0].scripts.pre).toBe('// From the collection “Shop” (it ran for this request there)\npm.variables.set("tok", "1")\n\n// The request’s own\nconsole.log("own")')
    expect(copies[0].scripts.post).toBe('// From the folder “Box” (it ran for this request there)\npm.test("box", () => {})')
    expect(copies.map((x) => x.name)).toEqual(['Items', 'Items (2)'])
    expect(copies[0].collectionId).toBe(copies[1].collectionId)
    expect(h.result.current.allCollections.filter((c) => c.name === 'Inbox')).toHaveLength(1)
  })
})
