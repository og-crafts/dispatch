/** Assistant connections and kept chats, shared by Settings and the chat: changes run one after another, and everyone hears of them. */
import { useEffect, useState } from 'react'
import * as db from '../../core/db'
import { deleteChat, deleteChats, saveChat, type Chat } from '../../core/assistant/chats'
import type { Connection } from '../../core/assistant/connections'

function queue() {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(f: () => Promise<T>): Promise<T> => { const next = last.then(f, f); last = next.catch(() => {}); return next }
}
const inOrder = queue(), chatsInOrder = queue()
const connectionListeners = new Set<(list: Connection[]) => void>()
const allDeletedListeners = new Set<() => void>()

/** Changes the saved list, from what is saved now. */
export const updateConnections = (change: (now: Connection[]) => Connection[]): Promise<void> => inOrder(async () => {
  await db.putConnections(change(await db.getConnections()))
  const list = await db.getConnections()
  connectionListeners.forEach((f) => f(list))
})

/** The saved connections, kept up to date; null until they are read. */
export function useConnections(): Connection[] | null {
  const [list, setList] = useState<Connection[] | null>(null)
  useEffect(() => {
    let live = true
    const take = (l: Connection[]) => { if (live) setList(l) }
    connectionListeners.add(take)
    // in the queue, so an older read never lands after a newer change
    void inOrder(async () => { try { take(await db.getConnections()) } catch { take([]) } })
    return () => { live = false; connectionListeners.delete(take) }
  }, [])
  return list
}

// Deletes come after the saves asked for before them, so a chat can't come back.
export const keepChat = (chat: Chat): Promise<boolean> => chatsInOrder(() => saveChat(chat))
export const removeChat = (id: string): Promise<void> => chatsInOrder(() => deleteChat(id))
/** Deletes every chat in every workspace. Open ones are dropped first, so nothing saves them again. */
export function removeAllChats(): Promise<void> {
  allDeletedListeners.forEach((f) => f())
  return chatsInOrder(() => deleteChats())
}
export function onAllChatsDeleted(f: () => void): () => void {
  allDeletedListeners.add(f)
  return () => { allDeletedListeners.delete(f) }
}
