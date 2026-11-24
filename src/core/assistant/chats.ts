import * as db from '../db'

/** The last this many chats are kept in each workspace. */
export const CHATS_PER_SPACE = 50

/** `messages` are the provider's own messages, already redacted by the loop, stored and returned unchanged. */
export interface Chat { id: string; spaceId: string; connectionId: string; model: string; title: string; messages: unknown[]; updatedAt: number }

const isChat = (x: unknown): x is Chat => {
  const c = x as Chat
  return !!c && typeof c.id === 'string' && typeof c.spaceId === 'string' && typeof c.connectionId === 'string' && typeof c.model === 'string'
    && typeof c.title === 'string' && Array.isArray(c.messages) && typeof c.updatedAt === 'number'
}

/**
 * Saves (or replaces) a chat on this device, sealed whole. Does nothing when keeping chats is off or the workspace is
 * gone. Returns whether it was stored.
 */
export async function saveChat(chat: Chat): Promise<boolean> {
  if (!(await db.getSettings()).keepChats) return false
  const sealed = await db.sealText(JSON.stringify(chat))
  return db.putChatRecord({ id: chat.id, spaceId: chat.spaceId, updatedAt: chat.updatedAt }, sealed, CHATS_PER_SPACE)
}

/** A workspace's chats, newest first; a record that can't be opened is left out. */
export async function listChats(spaceId: string): Promise<Chat[]> {
  const mine = (await db.getChatIndex()).filter((e) => e.spaceId === spaceId)
  const out: Chat[] = []
  for (const e of mine) {
    try {
      const sealed = await db.getChatRecord(e.id)
      if (!sealed) continue
      const c: unknown = JSON.parse(await db.unsealText(sealed))
      if (isChat(c) && c.id === e.id && c.spaceId === spaceId) out.push(c)
    } catch { /* unreadable: skipped, still removable */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export const deleteChat = (id: string) => db.removeChatRecords((e) => e.id === id)
/** One workspace's chats, or every chat when no workspace is given. */
export const deleteChats = (spaceId?: string) => db.removeChatRecords((e) => spaceId === undefined || e.spaceId === spaceId)
