import { beforeEach, describe, expect, it } from 'vitest'
import { exportWorkspace } from '../src/core/backup'
import * as db from '../src/core/db'
import { workspaceToFiles } from '../src/core/workspaceFiles'
import { CHATS_PER_SPACE, deleteChat, deleteChats, listChats, saveChat, type Chat } from '../src/core/assistant/chats'
import { defaultSettings, newCollection } from '../src/core/types'

beforeEach(() => db.resetForTests())

const chat = (id: string, o: Partial<Chat> = {}): Chat => ({ id, spaceId: 'default', connectionId: 'c1', model: 'm', title: `Title ${id}`, messages: [{ role: 'user', content: 'hello' }], updatedAt: 1000, ...o })

/** Every record of every store, as text, to look for plaintext. */
async function dump(): Promise<string> {
  const d = await db.open()
  let out = ''
  for (const name of Array.from(d.objectStoreNames)) {
    const t = d.transaction(name)
    const s = t.objectStore(name)
    const [vals, keys] = await Promise.all([new Promise<unknown[]>((r) => { const q = s.getAll(); q.onsuccess = () => r(q.result) }), new Promise<unknown[]>((r) => { const q = s.getAllKeys(); q.onsuccess = () => r(q.result) })])
    out += JSON.stringify([keys, vals])
  }
  return out
}

describe('saved chats', () => {
  it('round-trips messages deep-equal, newest first, and replaces a chat saved again', async () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input: { a: [1, null, 'x'] } }], extra: { z: 1 } }]
    expect(await saveChat(chat('a', { messages: msgs, updatedAt: 1 }))).toBe(true)
    await saveChat(chat('b', { updatedAt: 3 }))
    await saveChat(chat('c', { updatedAt: 2 }))
    expect((await listChats('default')).map((c) => c.id)).toEqual(['b', 'c', 'a'])
    expect((await listChats('default')).find((c) => c.id === 'a')!.messages).toEqual(msgs)
    await saveChat(chat('a', { title: 'Changed', updatedAt: 9 }))
    const l = await listChats('default')
    expect(l.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(l[0].title).toBe('Changed')
  })

  it('is sealed in IndexedDB, title included', async () => {
    await saveChat(chat('a', { title: 'SECRET-TITLE', messages: [{ role: 'user', content: 'SECRET-BODY' }] }))
    const text = await dump()
    expect(text).not.toContain('SECRET-TITLE')
    expect(text).not.toContain('SECRET-BODY')
    expect(text).toContain('assistantChat:a')
  })

  it('is not in backups, exports or folder files', async () => {
    await saveChat(chat('a', { title: 'SECRET-TITLE', messages: [{ role: 'user', content: 'SECRET-BODY' }] }))
    const col = newCollection('Col')
    await db.putCollection(col)
    const data = { collections: await db.listCollections(), folders: [], requests: [], environments: [], globals: [] }
    await db.addBackup(data, 'manual')
    const [info] = await db.listBackups()
    const restored = JSON.stringify(await db.getBackup(info.id))
    const exported = exportWorkspace(data)
    const files = JSON.stringify(workspaceToFiles({ space: { id: 'default', name: 'Default' }, ...data, flows: [] } as never, (v) => JSON.stringify(v)))
    for (const t of [restored, exported, files]) { expect(t).not.toContain('SECRET'); expect(t).not.toContain('assistantChat') }
    await db.replaceAll(data) // a restore leaves chats alone
    expect(await listChats('default')).toHaveLength(1)
  })

  it('keeps the last 50 per workspace: the 51st save drops the oldest, other workspaces untouched', async () => {
    await db.putSpaces([{ id: 'default', name: 'Default' }, { id: 's2', name: 'Two' }] as never)
    await saveChat(chat('other', { spaceId: 's2', updatedAt: 0 }))
    for (let i = 1; i <= CHATS_PER_SPACE; i++) await saveChat(chat(`c${i}`, { updatedAt: 100 + i }))
    expect(await listChats('default')).toHaveLength(50)
    await saveChat(chat('c51', { updatedAt: 200 }))
    const l = await listChats('default')
    expect(l).toHaveLength(50)
    expect(l.map((c) => c.id)).not.toContain('c1')
    expect(l[0].id).toBe('c51')
    expect(l.map((c) => c.id)).toContain('c2')
    expect((await listChats('s2')).map((c) => c.id)).toEqual(['other'])
    expect(await db.getChatRecord('c1')).toBeUndefined()
  })

  it('oldest is by updatedAt, and re-saving an old chat does not count twice', async () => {
    for (let i = 1; i <= 50; i++) await saveChat(chat(`c${i}`, { updatedAt: 100 + i }))
    await saveChat(chat('c1', { updatedAt: 500 })) // c1 is now the newest, c2 the oldest
    await saveChat(chat('new', { updatedAt: 501 }))
    const ids = (await listChats('default')).map((c) => c.id)
    expect(ids).toHaveLength(50)
    expect(ids).toContain('c1')
    expect(ids).not.toContain('c2')
  })

  it('concurrent saves lose neither a chat nor an index entry', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => saveChat(chat(`p${i}`, { updatedAt: i }))))
    expect(await listChats('default')).toHaveLength(12)
    expect(await db.getChatIndex()).toHaveLength(12)
  })

  it('with keepChats off stores nothing new and leaves stored chats alone', async () => {
    await saveChat(chat('old', { title: 'Old', updatedAt: 1 }))
    await db.putSettings({ ...(await db.getSettings()), keepChats: false })
    expect(await saveChat(chat('new'))).toBe(false)
    expect(await saveChat(chat('old', { title: 'Changed', updatedAt: 5 }))).toBe(false)
    const l = await listChats('default')
    expect(l.map((c) => [c.id, c.title])).toEqual([['old', 'Old']])
    await deleteChat('old')
    expect(await listChats('default')).toEqual([])
  })

  it('defaults to keeping chats', () => { expect(defaultSettings.keepChats).toBe(true) })

  it('deleteChat and deleteChats(spaceId) remove records; no argument removes all', async () => {
    await db.putSpaces([{ id: 'default', name: 'Default' }, { id: 's2', name: 'Two' }] as never)
    await saveChat(chat('a')); await saveChat(chat('b')); await saveChat(chat('x', { spaceId: 's2' }))
    await deleteChat('a')
    expect((await listChats('default')).map((c) => c.id)).toEqual(['b'])
    await deleteChats('default')
    expect(await listChats('default')).toEqual([])
    expect(await listChats('s2')).toHaveLength(1)
    await deleteChats()
    expect(await listChats('s2')).toEqual([])
    expect(await db.getChatIndex()).toEqual([])
    expect(await db.getChatRecord('x')).toBeUndefined()
  })

  it('a late save for a workspace that was deleted does not bring chats back', async () => {
    await db.putSpaces([{ id: 'default', name: 'Default' }, { id: 'gone', name: 'Gone' }] as never)
    await saveChat(chat('a', { spaceId: 'gone' }))
    await db.putSpaces([{ id: 'default', name: 'Default' }] as never)
    await deleteChats('gone')
    expect(await saveChat(chat('late', { spaceId: 'gone' }))).toBe(false)
    expect(await listChats('gone')).toEqual([])
    expect(await db.getChatIndex()).toEqual([])
  })

  it('chats stay readable after their connection is deleted', async () => {
    await db.putConnections([])
    await saveChat(chat('a', { connectionId: 'deleted-connection' }))
    expect((await listChats('default'))[0].connectionId).toBe('deleted-connection')
  })

  it('skips an unreadable record in the list, and deleteChats still removes it', async () => {
    await saveChat(chat('good', { updatedAt: 2 }))
    await saveChat(chat('bad', { updatedAt: 3 }))
    await db.putMeta('assistantChat:bad', 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA')
    expect((await listChats('default')).map((c) => c.id)).toEqual(['good'])
    await deleteChats('default')
    expect(await db.getChatRecord('bad')).toBeUndefined()
    expect(await db.getChatIndex()).toEqual([])
  })
})
