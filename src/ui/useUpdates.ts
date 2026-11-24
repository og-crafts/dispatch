/** The update notice (desktop): checks on its own when allowed, remembers what was dismissed, installs on a yes. */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as db from '../core/db'
import { checkDue, DAY, type UpdateState } from '../core/updateSchedule'
import { openExternal } from './PrivacyDialogs'
import { telemetryOffered } from './telemetry'
import { checkForUpdate, type Confirm, errorText, installQuestion, installUpdate, type Notify, type UpdateInfo, updatesConfigured } from './updates'
import type { WorkspaceApi } from './useWorkspace'

const DOWNLOAD_URL = 'https://dispatch.ogcrafts.cloud/download/'
const TICK = 15 * 60_000
/** A failed automatic check is tried again after this long (checkDue waits a day after the last one). */
const RETRY = 3_600_000

export interface UpdatesApi {
  /** The update to offer, unless its version was dismissed. */
  available: UpdateInfo | null
  /** A check the person asked for, a prompt or an install is under way. */
  busy: boolean
  noticeOpen: boolean
  answerNotice(keepOn: boolean): void
  dismiss(): void
  install(): Promise<void>
  /** Menu → Check for updates: answers out loud, and offers a dismissed version again. */
  checkNow(): Promise<void>
}

const failed = (text: string, notify: Notify) => notify(text, { label: 'Open download page', run: () => void openExternal(DOWNLOAD_URL) })

async function download(info: UpdateInfo, notify: Notify) {
  notify(`Downloading Dispatch ${info.version}…`)
  try { await installUpdate(info.version!) } catch (e) { failed(errorText(e), notify) }
}

export function useUpdates(ws: Pick<WorkspaceApi, 'ready' | 'settings' | 'setSettings'>, notify: Notify, confirm: Confirm): UpdatesApi {
  const [configured, setConfigured] = useState(false)
  const [saved, setSavedState] = useState<UpdateState | null>(null)
  const savedRef = useRef<UpdateState>({})
  const [found, setFound] = useState<UpdateInfo | null>(null)
  const runStartedAt = useRef(Date.now())
  const lastCheckAt = useRef<number>()
  const checking = useRef(false)
  const installing = useRef(false)
  const [busy, setBusyState] = useState(false)
  const setBusy = useCallback((on: boolean) => { installing.current = on; setBusyState(on) }, [])
  const enabled = ws.settings.autoUpdateCheck
  const enabledRef = useRef(enabled); enabledRef.current = enabled

  const save = useCallback((patch: Partial<UpdateState>) => {
    const next = { ...savedRef.current, ...patch }
    savedRef.current = next; setSavedState(next)
    void db.putMeta('updateState', next)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        if (!(await updatesConfigured())) return
        savedRef.current = (await db.getMeta<UpdateState>('updateState')) ?? {}
        setSavedState(savedRef.current); setConfigured(true)
      } catch { /* no update checks in this run */ }
    })()
  }, [])

  // The notice waits for the first-launch privacy question, and isn't shown to someone who turned checks off.
  const privacyPending = telemetryOffered() && !ws.settings.telemetryAsked
  const noticeOpen = ws.ready && configured && enabled && !!saved && !saved.noticeAnswered && !privacyPending
  useEffect(() => { if (noticeOpen && savedRef.current.noticeAt === undefined) save({ noticeAt: Date.now() }) }, [noticeOpen, save])

  const tick = useCallback(async () => {
    const now = Date.now()
    if (checking.current || installing.current || !checkDue({ enabled: enabledRef.current, noticeAt: savedRef.current.noticeAt, runStartedAt: runStartedAt.current, lastCheckAt: lastCheckAt.current, now })) return
    checking.current = true; lastCheckAt.current = now
    try {
      const info = await checkForUpdate()
      // Nothing changes under a prompt or an install.
      if (enabledRef.current && !installing.current) setFound(info.version ? info : null)
    } catch { lastCheckAt.current = now - DAY + RETRY /* and it says nothing */ } finally { checking.current = false }
  }, [])
  useEffect(() => {
    if (!ws.ready || !configured || !enabled) return
    void tick()
    const t = setInterval(() => { void tick() }, TICK)
    return () => clearInterval(t)
  }, [ws.ready, configured, enabled, tick])

  const install = useCallback(async () => {
    if (installing.current) return
    setBusy(true)
    try {
      // Checked again before installing: a failed install uses up the update found before.
      let asked = found
      if (asked && !(await confirm(installQuestion(asked)))) return
      let info: UpdateInfo
      try { info = await checkForUpdate() } catch (e) { failed(asked ? `Couldn’t install Dispatch ${asked.version}: ${errorText(e)}` : errorText(e), notify); return }
      if (!info.version) { setFound(null); notify(`You have the newest version (${info.current}).`); return }
      setFound(info)
      if (info.version !== asked?.version) { asked = info; if (!(await confirm(installQuestion(info)))) return }
      await download(info, notify)
    } finally { setBusy(false) }
  }, [found, confirm, notify, setBusy])

  const checkNow = useCallback(async () => {
    if (installing.current) { notify('Dispatch is already checking for or installing an update.'); return }
    setBusy(true)
    let info: UpdateInfo
    try { info = await checkForUpdate() } catch (e) { setBusy(false); notify(errorText(e)); return }
    lastCheckAt.current = Date.now()
    try {
      if (!info.version) { setFound(null); notify(`You have the newest version (${info.current}).`); return }
      setFound(info)
      if (savedRef.current.dismissed) save({ dismissed: undefined })
      if (!(await confirm(installQuestion(info)))) return
      await download(info, notify)
    } finally { setBusy(false) }
  }, [confirm, notify, save, setBusy])

  return {
    available: found && found.version !== saved?.dismissed ? found : null,
    busy, noticeOpen,
    answerNotice: (keepOn) => { save({ noticeAnswered: true }); if (!keepOn) ws.setSettings({ autoUpdateCheck: false }) },
    dismiss: () => { if (found?.version) save({ dismissed: found.version }) },
    install, checkNow,
  }
}
