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

type Notify = (msg: string, action?: { label: string; run: () => void }) => void

/**
 * One check, with what to tell the person. `quiet` (the check on start) says nothing unless there's an update.
 * Installing always asks first.
 */
export async function runUpdateCheck(notify: Notify, confirm: (m: string) => Promise<boolean>, quiet = false) {
  let info: UpdateInfo
  try { info = await checkForUpdate() } catch (e) { if (!quiet) notify(String(e instanceof Error ? e.message : e)); return }
  if (!info.version) { if (!quiet) notify(`You have the newest version (${info.current}).`); return }
  const install = async () => {
    const notes = info.notes?.trim() ? `\n\n${info.notes.trim().slice(0, 600)}` : ''
    if (!(await confirm(`Install Dispatch ${info.version}? You have ${info.current}. Dispatch restarts when it’s done; open tabs and drafts are kept.${notes}`))) return
    notify(`Downloading Dispatch ${info.version}…`)
    try { await installUpdate() } catch (e) { notify(String(e instanceof Error ? e.message : e)) }
  }
  if (quiet) notify(`Dispatch ${info.version} is available.`, { label: 'Install…', run: () => void install() })
  else await install()
}
