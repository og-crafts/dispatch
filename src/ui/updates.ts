/** In-app updates on the desktop: ask the Rust side (src-tauri/src/updater.rs) for a newer release, then install it. */
import { isDesktop } from '../core/transport'

export interface UpdateInfo {
  current: string
  /** Null when this is the newest version. */
  version: string | null
  notes: string | null
  date: string | null
}

async function call<T>(cmd: string): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd)
}

export const updatesAvailable = () => isDesktop()

/** Asks GitHub for the newest published release. Throws a readable message when it can't. */
export const checkForUpdate = () => call<UpdateInfo>('update_check')

/** Downloads, checks the signature, installs and restarts Dispatch. */
export const installUpdate = () => call<void>('update_install')

export type Notify = (msg: string, action?: { label: string; run: () => void }) => void
export type Confirm = (msg: string) => Promise<boolean>

/** True in desktop builds that carry an update key; others never check on their own. */
export const updatesConfigured = async () => updatesAvailable() && (await call<boolean>('update_configured'))

export const installQuestion = (i: UpdateInfo) => {
  const notes = i.notes?.trim() ? `\n\n${i.notes.trim().slice(0, 600)}` : ''
  return `Install Dispatch ${i.version}? You have ${i.current}. Dispatch restarts when it’s done; open tabs and drafts are kept.${notes}`
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
