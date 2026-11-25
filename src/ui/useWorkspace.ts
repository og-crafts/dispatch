import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import * as db from '../core/db'
import type { Collection, Environment, Folder, HistoryEntry, HttpResponse, KV, LogLine, PreparedRequest, RequestDef, Settings, TestResult } from '../core/types'
import { ASSISTANT_SPACE, DEFAULT_SPACE, type Space, bySort, defaultSettings, newCollection, newEnvironment, newFolder, newRequest, normalizeRequest, spaceOf, uid } from '../core/types'
import { prepare } from '../core/prepare'
import { CookieTransport, type Transport, defaultTransport, isDesktop } from '../core/transport'
import { browserHook } from '../core/browserPipeline'
import type { BrowserLauncher } from '../core/browser'
import { desktopLauncher } from './desktopBrowser'
import { CookieJars, type StoredCookie, cookieKey, jarKey } from '../core/cookies'
import type { Workspace } from '../core/backup'
import { deleteChats, sweepChats } from '../core/assistant/chats'
import { type ApplyResult, type Change, type Kind, type Proposal, type Rec, canonical } from '../core/assistant/proposal'
import { type Execution, type Pipeline, type RunContext, execute, folderChain, prepareContext, sendOptions } from '../core/runtime'
import { type ScriptEngine, scriptPipeline, mergeVars } from '../core/scriptPipeline'
import { WorkerEngine } from '../core/workerEngine'
import { type Scope, ruleFor, setVar, withRule, withoutRule } from '../core/extract'
import { type Flow, type FlowRun, type FlowStep, newFlow, runFlow } from '../core/flows'
import { FAKE } from '../core/fake'
import { authPipeline } from '../core/auth'
import { effectiveAuth } from '../core/prepare'
import { INBOX } from '../core/mcpWorkspace'
import { track } from './telemetry'

/** A linked folder's last sync: files changed outside the app that it left alone, or an error. */
export interface FolderStatus {
  /** Files changed both in the folder and in the app; neither side was overwritten. */
  conflicts: string[]
  error?: string
  at: number
  /** Copies a cloud drive or person made of a file (same item twice); never read as items. */
  copies?: string[]
  /** Copies whose names Dispatch doesn't read at all (e.g. `a.req (conflicted copy).yaml`); never touched. */
  strays?: string[]
  /** Files that changed in the folder but can't be read; the app keeps its version and doesn't overwrite them. */
  unreadable?: { path: string; error: string }[]
  /** The synced secrets file, when secrets sync is on: in step, waiting for the passphrase, or changed in both places. */
  vault?: { state: 'ok' | 'locked' | 'conflict' | 'error'; note?: string }
}

export type View =
  | { kind: 'request' }
  | { kind: 'home' }
  | { kind: 'collection'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'environment'; id: string }
  | { kind: 'globals' }
  | { kind: 'runner'; collectionId: string | null; folderId: string | null }
  | { kind: 'load'; requestId: string | null }
  | { kind: 'docs'; collectionId: string }
  | { kind: 'mock'; collectionId: string }
  | { kind: 'backups' }
  | { kind: 'settings' }
  | { kind: 'cookies' }
  | { kind: 'schedules' }
  | { kind: 'spaces' }
  | { kind: 'flow'; id: string }

export interface Result {
  sent: PreparedRequest
  response: HttpResponse | null
  error: string | null
  tests: TestResult[]
  visualizer?: { html: string }
  browser?: import('../core/browser').BrowserRunResult
}

export interface Tab {
  id: string
  draft: RequestDef
  result: Result | null
  sending: boolean
  /** The workspace it was opened in; only that workspace's tabs show. Unset = the workspace on screen (stamped soon after). */
  space?: string
}

const same = (a: RequestDef, b: RequestDef) => JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 })

/** How a change read from a linked folder is applied (docs/DESIGN-linked-workspaces.md, phase 2). */
export interface FromFolder {
  /** Keep open tabs that have unsaved edits as they are (the folder's version is saved; the tab stays a draft). */
  keepEdits?: boolean
  /** Put items the folder no longer has on the undo list under this label. */
  trashLabel?: string
  /** Do nothing (and answer false) when anything was written since this was worked out; the next check does it again. */
  ifUnchanged?: boolean
}
/** A tab after its request was replaced from a folder: the new version, unless `keepEdits` and the tab had edits. */
function refreshTab(t: Tab, next: RequestDef[], before: RequestDef[], opts: FromFolder): Tab {
  const r = next.find((x) => x.id === t.draft.id)
  if (!r) return t
  const old = before.find((x) => x.id === t.draft.id)
  if (opts.keepEdits && old && !same(old, t.draft)) return t
  return { ...t, draft: structuredClone(r) }
}
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
/**
 * A handed-over copy's scripts: the collection's and folders' scripts it ran with (outermost first), then its own,
 * each marked with where it came from, so the copy in the Inbox behaves like the original.
 */
function carriedScripts(r: RequestDef, col: Collection | null, chain: Folder[]): RequestDef['scripts'] {
  const owners = [...(col ? [[`collection “${col.name}”`, col.scripts] as const] : []), ...[...chain].reverse().map((f) => [`folder “${f.name}”`, f.scripts] as const)]
  const join = (pick: (x: RequestDef['scripts']) => string) => {
    const parts = owners.filter(([, sc]) => pick(sc).trim()).map(([who, sc]) => `// From the ${who} (it ran for this request there)\n${pick(sc)}`)
    if (!parts.length) return pick(r.scripts)
    return [...parts, ...(pick(r.scripts).trim() ? [`// The request’s own\n${pick(r.scripts)}`] : [])].join('\n\n')
  }
  return { ...r.scripts, pre: join((x) => x.pre), post: join((x) => x.post) }
}
const LOG_LIMIT = 500
const newTab = (draft: RequestDef = newRequest()): Tab => ({ id: uid(), draft, result: null, sending: false })

/**
 * State whose newest value can be read at once, before React renders. Every write goes through `set`, which moves the
 * ref first and renders what the ref holds, so a render of older state never puts the ref back.
 */
function useLive<T>(initial: T | (() => T)) {
  const [value, setValue] = useState(initial)
  const ref = useRef(value)
  const set = useCallback((u: T | ((v: T) => T)) => { const next = typeof u === 'function' ? (u as (v: T) => T)(ref.current) : u; ref.current = next; setValue(() => next) }, [])
  return [value, set, ref] as const
}

type Stored = Exclude<Rec, KV[]>
/** Stored records by kind, as they are now. */
interface Lists { collection: Collection[]; folder: Folder[]; request: RequestDef[]; environment: Environment[] }
const recIn = (l: Lists, globals: KV[], kind: Kind, id: string): Rec | null => (kind === 'globals' ? globals : (l[kind] as Stored[]).find((x) => x.id === id) ?? null)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** An applied change put onto a record the person moved in the same instant: what they touched stays theirs. */
function rebase(was: unknown, after: unknown, now: unknown, key = ''): unknown {
  const s = (v: unknown) => canonical((v ?? null) as Rec | null)
  if (s(was) === s(after)) return now
  if (s(was) === s(now)) return after
  if (key === 'variables') return mergeVars(was as KV[], after as KV[], now as KV[])
  if (!isObj(was) || !isObj(after) || !isObj(now)) return now
  return Object.fromEntries([...new Set([...Object.keys(now), ...Object.keys(after)])].map((k) => [k, rebase(was[k], after[k], now[k], k)]).filter(([, v]) => v !== undefined))
}
const no = (reason: Exclude<ApplyResult, { ok: true }>['reason'], text: string): ApplyResult => ({ ok: false, reason, text })

/** All app state and actions. Saved data lives in IndexedDB; open tabs are drafts until saved. */
/** A variable table before and after a run. */
export interface VarChange { before: KV[]; after: KV[] }

export interface WorkspaceOptions {
  transport?: Transport
  engine?: ScriptEngine
  /** Keep cookies around a transport passed in too (tests). */
  cookies?: boolean
  browserLauncher?: BrowserLauncher
  /** Extra hooks merged after scripts (auth signing...). */
  extend?: (base: Pipeline, transport: Transport) => Pipeline
}

export function useWorkspace(opts: WorkspaceOptions = {}) {
  const [settings, setSettingsState, settingsRef] = useLive<Settings>(defaultSettings)
  // On desktop, cookies from responses go back on later requests (the browser does this itself on the web).
  // Each environment has its own; `activeJar` names the one in use on screen.
  const [jars] = useState(() => new CookieJars())
  const activeJar = useRef<() => string>(() => jarKey(null, DEFAULT_SPACE.id))
  const [transport] = useState<Transport>(() => {
    const t = opts.transport ?? defaultTransport()
    return t.unrestricted && (!opts.transport || opts.cookies) ? new CookieTransport(t, (key) => jars.get(key ?? activeJar.current()), () => settingsRef.current.cookieJar, () => activeJar.current()) : t
  })
  const [ready, setReady] = useState(false)
  const [collections, setCollections, collectionsRef] = useLive<Collection[]>([])
  const [folders, setFolders, foldersRef] = useLive<Folder[]>([])
  const [requests, setRequests, requestsRef] = useLive<RequestDef[]>([])
  const [environments, setEnvironments, environmentsRef] = useLive<Environment[]>([])
  const [globals, setGlobalsState, globalsRef] = useLive<KV[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [tabs, setTabs, tabsRef] = useLive<Tab[]>(() => [newTab()])
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id)
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  /** The tab last used in each workspace, to come back to it. */
  const lastTab = useRef<Record<string, string>>({})
  const [view, setView] = useState<View>({ kind: 'request' })
  const [logs, setLogs] = useState<LogLine[]>([])
  /** Recently deleted things, newest last, so a delete can be undone. */
  const [trash, setTrash, trashRef] = useLive<{ id: string; label: string; data: Workspace }[]>([])
  /** Undo list entries being put back or put back already, from the list or a card: never twice. */
  const restored = useRef(new Set<string>())
  const [backups, setBackups] = useState<db.BackupInfo[]>([])
  const [spaces, setSpacesState, spacesRef] = useLive<Space[]>([DEFAULT_SPACE])
  const [flows, setFlows, flowsRef] = useLive<Flow[]>([])
  /** Flows deleted in this session. A late save (an editor closing, a pending timer) must not bring them back (#14). */
  const deletedFlows = useRef(new Set<string>())
  const aborts = useRef(new Map<string, AbortController>())
  const [engine] = useState<ScriptEngine>(() => opts.engine ?? new WorkerEngine())
  const [pipeline] = useState<Pipeline>(() => {
    const sendOpts = () => ({ timeoutMs: settingsRef.current.timeoutMs, followRedirects: settingsRef.current.followRedirects, insecureTls: settingsRef.current.insecureTls })
    const scripted = authPipeline(scriptPipeline({ engine, transport, sendOptions: sendOpts }), transport, sendOpts)
    // Browser login steps need a browser the app can start: the desktop app (or a launcher passed in, for tests).
    const launcher = opts.browserLauncher ?? (isDesktop() ? desktopLauncher : null)
    const base: Pipeline = launcher ? { ...scripted, browser: browserHook(launcher, (ctx) => (transport instanceof CookieTransport ? transport.jar(cookieKey(ctx)) : null)) } : scripted
    return opts.extend ? opts.extend(base, transport) : base
  })
  const pipelineRef = useRef(pipeline)
  /** Cookies of environments deleted in this session, for Undo. */
  const droppedJars = useRef(new Map<string, StoredCookie[]>())
  const dropJar = (id: string) => { const kept = jars.get(id).entries(); if (kept.length) droppedJars.current.set(id, kept); jars.delete(id) }
  const jarTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveJars = useRef(() => { clearTimeout(jarTimer.current); jarTimer.current = undefined; void db.putCookieJars(jars.entries()) })
  // Closing right after a change must not lose it.
  useEffect(() => {
    const flush = () => { if (jarTimer.current) saveJars.current() }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [])

  useEffect(() => {
    let live = true
    void (async () => {
      const [c, f, r, e, g, h, s, saved] = await Promise.all([
        db.listCollections(), db.listFolders(), db.listRequests(), db.listEnvironments(), db.getGlobals(), db.listHistory(), db.getSettings(),
        db.getOpenTabs(),
      ])
      if (!live) return
      setCollections(c.sort(byName)); setFolders(f); setRequests(r); setEnvironments(e.sort(byName)); setGlobalsState(g)
      setHistory(h); setSettingsState(s)
      setSpacesState(await db.getSpaces())
      sweepChats().catch(() => {}) // chats of a workspace removed before its chats were
      setFlows(await db.listFlows())
      if (transport instanceof CookieTransport) {
        const saved = await db.getCookieJars(jarKey(e.some((x) => x.id === s.activeEnvId) ? s.activeEnvId : null, s.activeSpaceId))
        if (!live) return
        // Cookies of environments that no longer exist go.
        for (const k of Object.keys(saved)) if (!k.startsWith('none:') && !e.some((x) => x.id === k)) delete saved[k]
        jars.load(saved)
        // Written back at once, so a list from before jars isn't taken for another environment's next time.
        await db.putCookieJars(jars.entries())
        jars.onChange = () => { clearTimeout(jarTimer.current); jarTimer.current = setTimeout(saveJars.current, 300) }
      }
      // A daily backup, taken quietly when the app opens.
      void (async () => {
        let list = await db.listBackups()
        if (!list.length || Date.now() - list[0].at > 24 * 3600_000) {
          if (c.length || r.length || e.length) { await db.addBackup({ collections: c, folders: f, requests: r, environments: e, globals: g }, 'daily'); list = await db.listBackups() }
        }
        if (live) setBackups(list)
      })()
      if (saved?.tabs?.length) {
        const restored = saved.tabs.map((d, i) => ({ ...newTab(normalizeRequest(d)), space: saved.spaces?.[i] ?? undefined }))
        setTabs(restored); setActiveId(restored[Math.min(saved.active, restored.length - 1)]?.id ?? restored[0].id)
      }
      setReady(true)
    })()
    return () => { live = false }
  }, [])

  // Open tabs survive a reload (drafts included).
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => { void db.putOpenTabs(tabs.map((x) => x.draft), Math.max(0, tabs.findIndex((x) => x.id === activeId)), tabs.map((x) => x.space ?? null)) }, 400)
    return () => clearTimeout(t)
  }, [tabs, activeId, ready])

  // Each workspace has its own tabs: a new tab belongs to the workspace on screen.
  useEffect(() => {
    if (tabs.some((t) => !t.space)) setTabs((ts) => ts.map((t) => (t.space ? t : { ...t, space: settingsRef.current.activeSpaceId })))
  }, [tabs])
  const shownTabs = tabs.filter((t) => (t.space ?? settings.activeSpaceId) === settings.activeSpaceId)
  const active = shownTabs.find((t) => t.id === activeId) ?? shownTabs[0] ?? tabs.find((t) => t.id === activeId) ?? tabs[0]
  // Edits go to activeId, so keep it on the tab actually shown (e.g. tabs restored while another workspace is open).
  useEffect(() => { if (active.id !== activeId) setActiveId(active.id) }, [active.id, activeId])
  const draft = active.draft
  const savedOf = useCallback((d: RequestDef) => requests.find((r) => r.id === d.id) ?? null, [requests])
  const isDirty = useCallback((d: RequestDef) => {
    const s = savedOf(d)
    return s ? !same(s, d) : d.url.trim() !== '' || d.body.text !== '' || d.scripts.pre !== '' || d.scripts.post !== ''
  }, [savedOf])
  const saved = savedOf(draft)
  const dirty = isDirty(draft)
  const collection = collections.find((c) => c.id === draft.collectionId) ?? null
  const environment = environments.find((e) => e.id === settings.activeEnvId) ?? null
  activeJar.current = () => jarKey(environmentsRef.current.some((e) => e.id === settingsRef.current.activeEnvId) ? settingsRef.current.activeEnvId : null, settingsRef.current.activeSpaceId)
  /** The cookies in use on screen, or null where the browser keeps them. */
  const cookieJar = useCallback(() => (transport instanceof CookieTransport ? transport.jar() : null), [transport])
  const runContext = useCallback((d: RequestDef, extra: Partial<RunContext> = {}): RunContext => ({
    collection: collections.find((c) => c.id === d.collectionId) ?? null,
    folders, environment, globals, ...extra,
  }), [collections, folders, environment, globals])
  /** Variable names for "{{" completion: what's in scope for the open request, then the fake-data generators. */
  const variableNames = useCallback(() => {
    const out = new Map<string, string>()
    const add = (rows: KV[] | undefined, from: string) => rows?.forEach((v) => { if (v.enabled && v.key.trim()) out.set(v.key.trim(), v.secret ? `${from} · secret` : `${from} · ${v.value.slice(0, 30)}`) })
    add(globals, 'globals'); add(collection?.variables, 'collection'); add(environment?.variables, environment?.name ?? 'environment')
    return [...[...out].map(([name, detail]) => ({ name, detail })), ...Object.keys(FAKE).map((name) => ({ name, detail: 'generated' }))]
  }, [globals, collection, environment])
  const prepared = useMemo(() => prepare(draft, prepareContext(runContext(draft), draft)), [draft, runContext])
  const chain = useMemo(() => folderChain(folders, draft.folderId), [folders, draft.folderId])

  const patchTab = useCallback((id: string, patch: Partial<Tab> | ((t: Tab) => Partial<Tab>)) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))
  }, [])
  /** Edits the active tab's request. */
  const setDraft = useCallback((u: RequestDef | ((d: RequestDef) => RequestDef)) => {
    setTabs((ts) => ts.map((t) => (t.id === activeId ? { ...t, draft: typeof u === 'function' ? u(t.draft) : u } : t)))
  }, [activeId])

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => { const next = { ...s, ...patch }; void db.putSettings(next); return next })
  }, [])
  const log = useCallback((lines: LogLine[]) => { if (lines.length) setLogs((l) => [...l, ...lines].slice(-LOG_LIMIT)) }, [])

  /** Opens a request: switches to its tab if already open, otherwise opens a new tab (or reuses an empty one). */
  const openRequest = useCallback((r: RequestDef, result: Result | null = null) => {
    setView({ kind: 'request' })
    setTabs((ts) => {
      const open = ts.find((t) => t.draft.id === r.id)
      // Open in another workspace's tabs: it moves to this one.
      if (open) { setActiveId(open.id); return ts.map((t) => (t.id === open.id ? { ...t, result: result ?? t.result, space: settingsRef.current.activeSpaceId } : t)) }
      const tab = { ...newTab(structuredClone(r)), result }
      const cur = ts.find((t) => t.id === activeId)
      // Replace the current tab when it's an untouched new request.
      if (cur && !requests.some((x) => x.id === cur.draft.id) && !cur.draft.url && !cur.draft.body.text && !cur.result) {
        setActiveId(tab.id); return ts.map((t) => (t.id === cur.id ? tab : t))
      }
      setActiveId(tab.id); return [...ts, tab]
    })
  }, [activeId, requests])

  const startNew = useCallback((collectionId: string | null = null, folderId: string | null = null) => {
    const tab = newTab(newRequest({ collectionId, folderId }))
    setTabs((ts) => [...ts, tab]); setActiveId(tab.id); setView({ kind: 'request' })
  }, [])

  const closeTab = useCallback((id: string) => { closeTabsRef.current([id]) }, [])
  const selectTab = useCallback((id: string) => { setActiveId(id); setView({ kind: 'request' }) }, [])
  /**
   * Closes tabs (the tab menu's Close others / to the left / to the right / all, and closeTab). Only the open
   * workspace's tabs count: if none of them is left it gets a fresh one, and the active tab moves to the nearest one
   * on the left that stays. Worked out from the current tabs first, so the state updater stays pure.
   */
  const closeTabs = useCallback((ids: string[]) => {
    for (const id of ids) aborts.current.get(id)?.abort()
    const ts = tabsRef.current
    const here = settingsRef.current.activeSpaceId
    const mine = (t: Tab) => (t.space ?? here) === here
    const restHere = ts.filter((t) => mine(t) && !ids.includes(t.id))
    const fresh = restHere.length ? null : { ...newTab(), space: here }
    const active = activeIdRef.current
    let next = active
    if (fresh) next = fresh.id
    else if (ids.includes(active)) {
      const shown = ts.filter(mine)
      const i = shown.findIndex((t) => t.id === active)
      next = (shown.slice(0, Math.max(0, i)).reverse().find((t) => !ids.includes(t.id)) ?? restHere[0]).id
    }
    const after = [...ts.filter((t) => !ids.includes(t.id)), ...(fresh ? [fresh] : [])]
    setTabs(after)
    if (next !== active) { activeIdRef.current = next; setActiveId(next) }
  }, [])
  const closeTabsRef = useRef(closeTabs); closeTabsRef.current = closeTabs
  /** Opens a copy of a tab's request, with its unsaved edits, as a new unsaved request right after it. */
  const duplicateTab = useCallback((id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id)
      if (i < 0) return ts
      const tab = newTab({ ...structuredClone(ts[i].draft), id: uid(), name: `${ts[i].draft.name} copy`, updatedAt: Date.now() })
      setActiveId(tab.id); setView({ kind: 'request' })
      return [...ts.slice(0, i + 1), tab, ...ts.slice(i + 1)]
    })
  }, [])

  /**
   * The one queue for writes that touch many records at once (applying and undoing a proposal, imports, a folder's
   * version, a restored backup), so none of them works on what another is about to change.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const inTurn = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(run, run)
    queue.current = p.catch(() => {})
    return p
  }, [])

  /** State first, so nothing works on the old version while it is being written; back as it was if that fails. */
  const persistRequest = useCallback(async (r: RequestDef) => {
    const old = requestsRef.current.find((x) => x.id === r.id)
    setRequests((rs) => [...rs.filter((x) => x.id !== r.id), r])
    try { await db.putRequest(r) } catch (e) {
      setRequests((rs) => (rs.includes(r) ? [...rs.filter((x) => x !== r), ...(old ? [old] : [])] : rs))
      throw e
    }
  }, [])

  const saveDraft = useCallback(async (into?: { collectionId: string | null; folderId?: string | null; name: string }) => {
    const r: RequestDef = { ...draft, ...(into ?? {}), updatedAt: Date.now() }
    if (into && into.folderId === undefined) r.folderId = into.collectionId === draft.collectionId ? draft.folderId : null
    await persistRequest(r)
    setDraft(r)
    return r
  }, [draft, persistRequest, setDraft])

  /**
   * Save as: the draft (with any unsaved edits) becomes a new saved request; the tab moves to it and the
   * original stays as it was last saved.
   */
  const saveDraftAs = useCallback(async (into: { collectionId: string | null; folderId: string | null; name: string }) => {
    const r: RequestDef = { ...structuredClone(draft), ...into, id: uid(), sort: Date.now(), updatedAt: Date.now() }
    await persistRequest(r)
    setDraft(r)
    return r
  }, [draft, persistRequest, setDraft])

  const renameRequest = useCallback(async (r: RequestDef, name: string) => {
    await persistRequest({ ...(requestsRef.current.find((x) => x.id === r.id) ?? r), name, updatedAt: Date.now() })
    setTabs((ts) => ts.map((t) => (t.draft.id === r.id ? { ...t, draft: { ...t.draft, name } } : t)))
  }, [persistRequest])

  const moveRequest = useCallback(async (r: RequestDef, collectionId: string | null, folderId: string | null) => {
    await persistRequest({ ...(requestsRef.current.find((x) => x.id === r.id) ?? r), collectionId, folderId, updatedAt: Date.now() })
    setTabs((ts) => ts.map((t) => (t.draft.id === r.id ? { ...t, draft: { ...t.draft, collectionId, folderId } } : t)))
  }, [persistRequest])

  const toTrash = useCallback((label: string, data: Partial<Workspace>) => {
    const id = uid()
    setTrash((t) => [...t, { id, label, data: { collections: [], folders: [], requests: [], environments: [], ...data } }].slice(-20))
    return id
  }, [])

  /** What was taken out of the state before a delete comes back if the delete fails. */
  const orBack = useCallback(async (deleting: Promise<unknown>, gone: { collections?: Collection[]; folders?: Folder[]; requests?: RequestDef[]; environments?: Environment[] }) => {
    const back = <T extends { id: string }>(xs: T[], add: T[] = []) => [...xs, ...add.filter((a) => !xs.some((x) => x.id === a.id))]
    try { await deleting } catch (e) {
      setCollections((xs) => back(xs, gone.collections).sort(byName)); setFolders((xs) => back(xs, gone.folders))
      setRequests((xs) => back(xs, gone.requests)); setEnvironments((xs) => back(xs, gone.environments).sort(byName))
      throw e
    }
  }, [])
  const removeRequest = useCallback(async (id: string) => {
    const r = requestsRef.current.find((x) => x.id === id)
    setRequests((rs) => rs.filter((x) => x.id !== id))
    await orBack(db.deleteRequest(id), { requests: r ? [r] : [] })
    if (r) toTrash(`“${r.name}”`, { requests: [r] })
    // Open tabs keep the request as an unsaved draft.
    setTabs((ts) => ts.map((t) => (t.draft.id === id ? { ...t, draft: { ...t.draft, id: uid() } } : t)))
  }, [toTrash, orBack])

  const duplicateRequest = useCallback(async (r: RequestDef) => {
    const copy: RequestDef = { ...structuredClone(r), id: uid(), name: `${r.name} copy`, updatedAt: Date.now() }
    await persistRequest(copy)
    return copy
  }, [persistRequest])

  /** Saves variables runs changed, onto the environments, collections and globals as they are now. */
  const keepVars = useCallback(async (o: { environment?: VarChange & { id: string }; collections?: (VarChange & { id: string })[]; globals?: VarChange }) => {
    const changed = (c: VarChange, now: KV[]) => { const next = mergeVars(c.before, c.after, now); return JSON.stringify(next) === JSON.stringify(now) ? null : next }
    const e = o.environment && environmentsRef.current.find((x) => x.id === o.environment!.id)
    const ev = e && changed(o.environment!, e.variables)
    if (e && ev) {
      const next = { ...e, variables: ev, updatedAt: Date.now() }
      setEnvironments((es) => es.map((x) => (x.id === next.id ? next : x))); await db.putEnvironment(next)
    }
    for (const ch of o.collections ?? []) {
      const c = collectionsRef.current.find((x) => x.id === ch.id)
      const cv = c && changed(ch, c.variables)
      if (!c || !cv) continue
      const next = { ...c, variables: cv, updatedAt: Date.now() }
      setCollections((cs) => cs.map((x) => (x.id === next.id ? next : x))); await db.putCollection(next)
    }
    const g = o.globals && changed(o.globals, globalsRef.current)
    if (g) { setGlobalsState(g); await db.putGlobals(g) }
  }, [])
  /** Saves variables changed by scripts. */
  const applyChanges = useCallback((x: Execution, ctx: RunContext) => keepVars({
    environment: x.changes.environment && ctx.environment ? { id: ctx.environment.id, before: x.base.environment, after: x.changes.environment } : undefined,
    collections: x.changes.collection && ctx.collection ? [{ id: ctx.collection.id, before: x.base.collection, after: x.changes.collection }] : [],
    globals: x.changes.globals ? { before: x.base.globals, after: x.changes.globals } : undefined,
  }), [keepVars])

  /** Saves OAuth tokens refreshed during a send back to the request, folder or collection that owns the auth. */
  const applyAuthUpdate = useCallback(async (u: NonNullable<Execution['authUpdate']>) => {
    if (u.owner === 'request') {
      setTabs((ts) => ts.map((t) => (t.draft.id === u.id ? { ...t, draft: { ...t.draft, auth: { ...t.draft.auth, ...u.patch } } } : t)))
      const savedReq = requestsRef.current.find((r) => r.id === u.id)
      if (savedReq) { const next = { ...savedReq, auth: { ...savedReq.auth, ...u.patch } }; setRequests((rs) => rs.map((r) => (r.id === u.id ? next : r))); await db.putRequest(next) }
    } else if (u.owner === 'folder') {
      const f = foldersRef.current.find((x) => x.id === u.id)
      if (f) { const next = { ...f, auth: { ...f.auth, ...u.patch } }; setFolders((fs) => fs.map((x) => (x.id === u.id ? next : x))); await db.putFolder(next) }
    } else {
      const c = collectionsRef.current.find((x) => x.id === u.id)
      if (c) { const next = { ...c, auth: { ...c.auth, ...u.patch } }; setCollections((cs) => cs.map((x) => (x.id === u.id ? next : x))); await db.putCollection(next) }
    }
  }, [])

  /** Adds a send to History (the Send button, and requests an AI assistant sends through the local MCP endpoint). */
  const recordHistory = useCallback(async (request: RequestDef, x: Execution) => {
    let entry: HistoryEntry = { id: uid(), at: Date.now(), request: structuredClone(request), sent: x.sent, response: x.response, error: x.error, tests: x.tests }
    // Large bodies would bloat history; keep the first 256 KB and drop binary data.
    if (entry.response) entry = { ...entry, response: { ...entry.response, body: entry.response.body.slice(0, 262_144), base64: undefined } }
    await db.addHistory(entry)
    setHistory((h) => [entry, ...h].slice(0, db.HISTORY_LIMIT))
  }, [])

  const send = useCallback(async () => {
    const tab = active
    if (tab.sending) return
    const ctrl = new AbortController(); aborts.current.set(tab.id, ctrl)
    patchTab(tab.id, { sending: true })
    const ctx = runContext(tab.draft)
    const x = await execute(tab.draft, ctx, transport, sendOptions(tab.draft, settings, ctrl.signal), pipelineRef.current)
    aborts.current.delete(tab.id)
    patchTab(tab.id, { sending: false, result: { sent: x.sent, response: x.response, error: x.error, tests: x.tests, visualizer: x.visualizer, browser: x.browser } })
    log([...x.logs, {
      level: x.error ? 'error' : 'info', at: Date.now(), source: 'network',
      text: `${x.sent.method} ${x.sent.url} → ${x.response ? `${x.response.status} ${x.response.statusText} · ${x.response.timeMs} ms` : x.error}`,
    }])
    await applyChanges(x, ctx)
    if (x.authUpdate) await applyAuthUpdate(x.authUpdate)
    await recordHistory(tab.draft, x)
    track('request_sent', { protocol: tab.draft.protocol, ok: !!x.response && x.response.status < 400 })
  }, [active, patchTab, runContext, transport, settings, log, applyChanges, applyAuthUpdate, recordHistory])

  const cancel = useCallback(() => aborts.current.get(active.id)?.abort(), [active.id])

  const openHistory = useCallback((h: HistoryEntry) => {
    // Opens as a fresh draft, so editing it never changes the saved request it came from.
    const tab = { ...newTab({ ...normalizeRequest(structuredClone(h.request)), id: uid() }), result: { sent: h.sent, response: h.response, error: h.error, tests: h.tests ?? [] } }
    setTabs((ts) => [...ts, tab]); setActiveId(tab.id); setView({ kind: 'request' })
  }, [])
  const clearHistory = useCallback(async () => { await db.clearHistory(); setHistory([]) }, [])

  const addCollection = useCallback(async (name: string) => {
    const c = { ...newCollection(name), workspaceId: settingsRef.current.activeSpaceId }; await db.putCollection(c)
    setCollections((cs) => [...cs, c].sort(byName))
    return c
  }, [])
  const updateCollection = useCallback(async (c: Collection) => {
    // State first so a request sent right after an edit already uses it; then persist.
    const next = { ...c, updatedAt: Date.now() }
    setCollections((cs) => cs.map((x) => (x.id === c.id ? next : x)))
    await db.putCollection(next)
  }, [])
  const removeCollection = useCallback(async (id: string) => {
    const c = collectionsRef.current.find((x) => x.id === id)
    const gone = { collections: c ? [c] : [], folders: foldersRef.current.filter((f) => f.collectionId === id), requests: requestsRef.current.filter((r) => r.collectionId === id) }
    setCollections((cs) => cs.filter((c) => c.id !== id))
    setFolders((fs) => fs.filter((f) => f.collectionId !== id))
    setRequests((rs) => rs.filter((r) => r.collectionId !== id))
    await orBack(db.deleteCollection(id), gone)
    setTabs((ts) => ts.map((t) => (t.draft.collectionId === id ? { ...t, draft: { ...t.draft, id: uid(), collectionId: null, folderId: null } } : t)))
    setView((v) => (v.kind === 'collection' && v.id === id ? { kind: 'request' } : v))
    if (c) toTrash(`“${c.name}”`, gone)
  }, [toTrash, orBack])

  const addFolder = useCallback(async (collectionId: string, name: string, parentId: string | null = null) => {
    const f = newFolder(collectionId, name, parentId); await db.putFolder(f)
    setFolders((fs) => [...fs, f])
    return f
  }, [])
  const updateFolder = useCallback(async (f: Folder) => {
    const next = { ...f, updatedAt: Date.now() }
    setFolders((fs) => fs.map((x) => (x.id === f.id ? next : x)))
    await db.putFolder(next)
  }, [])
  const removeFolder = useCallback(async (id: string) => {
    const ids = new Set([id])
    for (let grew = true; grew;) { grew = false; for (const f of foldersRef.current) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true } }
    const top = foldersRef.current.find((f) => f.id === id)
    const gone = { folders: foldersRef.current.filter((f) => ids.has(f.id)), requests: requestsRef.current.filter((r) => r.folderId && ids.has(r.folderId)) }
    setFolders((fs) => fs.filter((f) => !ids.has(f.id)))
    setRequests((rs) => rs.filter((r) => !r.folderId || !ids.has(r.folderId)))
    await orBack(db.deleteFolders([...ids]), gone)
    setTabs((ts) => ts.map((t) => (t.draft.folderId && ids.has(t.draft.folderId) ? { ...t, draft: { ...t.draft, id: uid(), folderId: null } } : t)))
    setView((v) => (v.kind === 'folder' && ids.has(v.id) ? { kind: 'request' } : v))
    if (top) toTrash(`“${top.name}”`, gone)
  }, [toTrash, orBack])

  const addEnvironment = useCallback(async (name: string) => {
    const e = { ...newEnvironment(name), workspaceId: settingsRef.current.activeSpaceId }; await db.putEnvironment(e)
    setEnvironments((es) => [...es, e].sort(byName))
    return e
  }, [])
  const updateEnvironment = useCallback(async (e: Environment) => {
    const next = { ...e, updatedAt: Date.now() }
    setEnvironments((es) => es.map((x) => (x.id === e.id ? next : x)))
    await db.putEnvironment(next)
  }, [])
  const removeEnvironment = useCallback(async (id: string) => {
    const e = environmentsRef.current.find((x) => x.id === id)
    setEnvironments((es) => es.filter((e) => e.id !== id))
    await orBack(db.deleteEnvironment(id), { environments: e ? [e] : [] })
    dropJar(id)
    setSettingsState((s) => { if (s.activeEnvId !== id) return s; const n = { ...s, activeEnvId: null }; void db.putSettings(n); return n })
    setView((v) => (v.kind === 'environment' && v.id === id ? { kind: 'request' } : v))
    if (e) toTrash(`“${e.name}”`, { environments: [e] })
  }, [toTrash, orBack])
  /** Copies an environment (values included, secrets too: it stays on this device) as "<name> copy". */
  const duplicateEnvironment = useCallback(async (e: Environment) => {
    const copy: Environment = { ...structuredClone(e), id: uid(), name: `${e.name} copy`, updatedAt: Date.now(), variables: e.variables.map((v) => ({ ...v, id: uid() })) }
    await db.putEnvironment(copy)
    setEnvironments((es) => [...es, copy].sort(byName))
    return copy
  }, [])
  const setGlobals = useCallback(async (g: KV[]) => { setGlobalsState(g); await db.putGlobals(g) }, [])

  /** "Extract into variable": sets the value now and adds the rule to the request's script. Returns how to undo both. */
  const extractVariable = useCallback(async (o: { scope: Scope; name: string; value: string; secret: boolean; expr: string }) => {
    const draftId = tabsRef.current.find((t) => t.id === activeIdRef.current)!.draft.id
    const onDraft = (fn: (post: string) => string) => setTabs((ts) => ts.map((t) => (t.draft.id === draftId ? { ...t, draft: { ...t.draft, scripts: { ...t.draft.scripts, post: fn(t.draft.scripts.post) } } } : t)))
    const draft = tabsRef.current.find((t) => t.draft.id === draftId)!.draft
    const ownerId = o.scope === 'env' ? settingsRef.current.activeEnvId : draft.collectionId
    /** The table as it is now, and how to save it. */
    const table = (): { rows: KV[]; save: (rows: KV[]) => Promise<void> } | null => {
      if (o.scope === 'globals') return { rows: globalsRef.current, save: setGlobals }
      if (o.scope === 'env') { const e = environmentsRef.current.find((x) => x.id === ownerId); return e ? { rows: e.variables, save: (variables) => updateEnvironment({ ...e, variables }) } : null }
      const c = collectionsRef.current.find((x) => x.id === ownerId)
      return c ? { rows: c.variables, save: (variables) => updateCollection({ ...c, variables }) } : null
    }
    const t = table()
    if (!t) throw new Error('That place for the variable is gone.')
    const set = setVar(t.rows, o.name, o.value, o.secret)
    const before = ruleFor(draft.scripts.post, o.scope, o.name)
    await t.save(set.rows)
    onDraft((post) => withRule(post, o.scope, o.name, o.expr))
    return async () => {
      onDraft((post) => withoutRule(post, o.scope, o.name, o.expr, before))
      const now = table()
      if (now) await now.save(set.undo(now.rows))
    }
  }, [setGlobals, updateEnvironment, updateCollection])

  const importWorkspace = useCallback((w0: Workspace) => { const here = settingsRef.current.activeSpaceId; return inTurn(async () => {
    for (const e of w0.environments) { const kept = droppedJars.current.get(e.id); if (kept) { droppedJars.current.delete(e.id); for (const k of kept) jars.get(e.id).set(k) } }
    // Imports land in the workspace you're looking at (unless they name one that exists here).
    const known = (id?: string) => !!id && spacesRef.current.some((x) => x.id === id)
    const w: Workspace = {
      ...w0,
      collections: w0.collections.map((c) => (known(c.workspaceId) && c.workspaceId !== DEFAULT_SPACE.id ? c : { ...c, workspaceId: here })),
      environments: w0.environments.map((e) => (known(e.workspaceId) && e.workspaceId !== DEFAULT_SPACE.id ? e : { ...e, workspaceId: here })),
      flows: w0.flows?.map((x) => (known(x.workspaceId) && x.workspaceId !== DEFAULT_SPACE.id ? x : { ...x, workspaceId: here })),
    }
    for (const f of w.flows ?? []) deletedFlows.current.delete(f.id) // Undo and imports bring flows back on purpose.
    await db.putMany(w)
    setCollections((cs) => [...cs, ...w.collections].sort(byName))
    setFolders((fs) => [...fs, ...w.folders])
    setRequests((rs) => [...rs, ...w.requests])
    setEnvironments((es) => [...es, ...w.environments].sort(byName))
    if (w.flows?.length) setFlows((fs) => [...fs.filter((f) => !w.flows!.some((x) => x.id === f.id)), ...w.flows!])
    if (w.globals?.length) {
      const now = globalsRef.current
      const merged = [...now, ...w.globals.filter((g) => !now.some((x) => x.key === g.key))]
      await setGlobals(merged)
    }
  }) }, [setGlobals, inTurn])

  // ---------- flows ----------
  const addFlow = useCallback(async (name: string) => {
    const f = { ...newFlow(name), workspaceId: settingsRef.current.activeSpaceId }
    await db.putFlow(f); setFlows((fs) => [...fs, f]); return f
  }, [])
  const updateFlow = useCallback(async (f: Flow) => {
    if (deletedFlows.current.has(f.id)) return
    const next = { ...f, updatedAt: Date.now() }
    setFlows((fs) => fs.map((x) => (x.id === f.id ? next : x))); await db.putFlow(next)
  }, [])
  const duplicateFlow = useCallback(async (f: Flow) => {
    const c: Flow = { ...structuredClone(f), id: uid(), name: `${f.name} copy`, updatedAt: Date.now() }
    await db.putFlow(c); setFlows((fs) => [...fs, c]); return c
  }, [])
  const removeFlow = useCallback(async (id: string) => {
    const f = flows.find((x) => x.id === id)
    deletedFlows.current.add(id)
    await db.deleteFlow(id); setFlows((fs) => fs.filter((x) => x.id !== id))
    setView((v) => (v.kind === 'flow' && v.id === id ? { kind: 'request' } : v))
    if (f) toTrash(`“${f.name}”`, { flows: [f] })
  }, [flows, toTrash])
  /** Runs a flow with the active environment; keeps the variables it changes. */
  const runFlowNow = useCallback(async (f: Flow, onStep: (s: FlowStep) => void, signal?: AbortSignal): Promise<FlowRun> => {
    const env = environments.find((e) => e.id === settingsRef.current.activeEnvId) ?? null
    const r = await runFlow(f, { collections, folders, requests, environment: env, globals, settings: settingsRef.current }, transport, pipelineRef.current, engine, { onStep, signal })
    await keepVars({
      environment: r.environment && env ? { id: env.id, before: env.variables, after: r.environment } : undefined,
      collections: Object.entries(r.collections).map(([id, after]) => ({ id, before: collections.find((c) => c.id === id)?.variables ?? [], after })),
      globals: { before: globals, after: r.globals },
    })
    log([...r.logs, { level: r.ok ? 'info' : 'error', at: Date.now(), source: 'flow', text: `${f.name}: ${r.ok ? 'passed' : `failed — ${r.error}`} (${r.steps.length} steps, ${r.durationMs} ms)` }])
    return r
  }, [environments, collections, folders, requests, globals, transport, engine, keepVars, log])

  // ---------- workspaces ----------
  const activeSpaceId = spaces.some((x) => x.id === settings.activeSpaceId) ? settings.activeSpaceId : DEFAULT_SPACE.id
  const visibleCollections = useMemo(() => collections.filter((c) => spaceOf(c) === activeSpaceId), [collections, activeSpaceId])
  const visibleFlows = useMemo(() => flows.filter((f) => spaceOf(f) === activeSpaceId), [flows, activeSpaceId])
  const visibleEnvironments = useMemo(() => environments.filter((e) => spaceOf(e) === activeSpaceId), [environments, activeSpaceId])
  const saveSpaces = useCallback(async (next: Space[]) => { setSpacesState(next); await db.putSpaces(next) }, [])
  /** Linked folders' state for the Workspaces page and collection pages, keyed like db.FolderState. */
  const [folderStatus, setFolderStatusState] = useState<Record<string, FolderStatus>>({})
  const setFolderStatus = useCallback((key: string, st: FolderStatus | null) => setFolderStatusState((m) => {
    const next = { ...m }; if (st) next[key] = st; else delete next[key]; return next
  }), [])
  /** Shows another workspace, and picks up the environment last used there. */
  const switchSpace = useCallback((id: string) => {
    const s = settingsRef.current
    const remembered = s.spaceEnv[id] ?? null
    const env = remembered && environments.some((e) => e.id === remembered && spaceOf(e) === id) ? remembered : null
    setSettings({ activeSpaceId: id, activeEnvId: env, spaceEnv: { ...s.spaceEnv, [s.activeSpaceId]: s.activeEnvId } })
    setView({ kind: 'request' })
    // Show that workspace's tabs, back on the one last used there (or a new request if it has none).
    lastTab.current[s.activeSpaceId] = activeIdRef.current
    setTabs((ts) => {
      const stamped = ts.map((t) => (t.space ? t : { ...t, space: s.activeSpaceId }))
      const theirs = stamped.filter((t) => t.space === id)
      if (!theirs.length) { const t = { ...newTab(), space: id }; setActiveId(t.id); return [...stamped, t] }
      setActiveId(theirs.find((t) => t.id === lastTab.current[id])?.id ?? theirs[0].id)
      return stamped
    })
  }, [environments, setSettings])
  const addSpace = useCallback(async (name: string) => {
    const sp = { id: uid(), name }
    await saveSpaces([...spacesRef.current, sp])
    return sp
  }, [saveSpaces])
  /** Adds a workspace read from a folder, keeping its id (so reading the folder again finds it). */
  const addSpaceFrom = useCallback(async (sp: Space) => {
    if (!spacesRef.current.some((x) => x.id === sp.id)) await saveSpaces([...spacesRef.current, sp])
  }, [saveSpaces])
  const setSpaceFolderId = useCallback(async (id: string, folderId: string) => {
    await saveSpaces(spacesRef.current.map((x) => (x.id === id ? { ...x, folderId } : x)))
  }, [saveSpaces])
  /** Links a workspace to a folder (desktop), or unlinks it with `undefined`. */
  const setSpaceFolder = useCallback(async (id: string, dir: string | undefined) => {
    await saveSpaces(spacesRef.current.map((x) => (x.id === id ? { ...x, linkedDir: dir } : x)))
  }, [saveSpaces])
  const renameSpace = useCallback((id: string, name: string) => saveSpaces(spacesRef.current.map((x) => (x.id === id ? { ...x, name } : x))), [saveSpaces])
  /** Only empty workspaces can be removed (move or delete their collections and environments first). */
  const removeSpace = useCallback(async (id: string) => {
    if (id === DEFAULT_SPACE.id || collectionsRef.current.some((c) => spaceOf(c) === id) || environmentsRef.current.some((e) => spaceOf(e) === id)) return false
    await saveSpaces(spacesRef.current.filter((x) => x.id !== id))
    try { await deleteChats(id) } catch { /* the sweep on the next start finishes it */ } // Chats go for good with their workspace (no undo).
    jars.delete(jarKey(null, id))
    if (settingsRef.current.activeSpaceId === id) switchSpace(DEFAULT_SPACE.id)
    return true
  }, [saveSpaces, switchSpace])
  const moveToSpace = useCallback(async (kind: 'collection' | 'environment', id: string, spaceId: string) => {
    if (kind === 'collection') {
      const c = collectionsRef.current.find((x) => x.id === id); if (c) await updateCollection({ ...c, workspaceId: spaceId })
    } else {
      const e = environmentsRef.current.find((x) => x.id === id); if (!e) return
      await updateEnvironment({ ...e, workspaceId: spaceId })
      if (settingsRef.current.activeEnvId === id) setSettings({ activeEnvId: null })
    }
  }, [updateCollection, updateEnvironment, setSettings])
  /** Lets MCP assistants create, change and delete requests in a workspace of the user's too (or stops it). */
  const setSpaceAi = useCallback(async (id: string, on: boolean) => {
    await saveSpaces(spacesRef.current.map((x) => (x.id === id ? { ...x, aiEdit: on || undefined } : x)))
  }, [saveSpaces])
  const setSpaceSecrets = useCallback(async (id: string, on: boolean) => {
    await saveSpaces(spacesRef.current.map((x) => (x.id === id ? { ...x, syncSecrets: on || undefined } : x)))
  }, [saveSpaces])
  /** Workspaces MCP assistants may write to: their own, and the user's that allow it. */
  const aiSpaces = () => new Set([ASSISTANT_SPACE.id, ...spacesRef.current.filter((x) => x.aiEdit).map((x) => x.id)])
  /**
   * Saves what an MCP assistant made or changed in its own workspace (added the first time) or in a workspace the
   * user lets it edit. Anything elsewhere is ignored.
   */
  const saveAssistant = useCallback(async (c: { collections: Collection[]; folders: Folder[]; requests: RequestDef[] }) => {
    const newSpace = !spacesRef.current.some((x) => x.id === ASSISTANT_SPACE.id)
    const allowed = aiSpaces()
    // An existing collection keeps its workspace whatever the assistant sends.
    const cols = c.collections.filter((x) => {
      const cur = collectionsRef.current.find((y) => y.id === x.id)
      return cur ? allowed.has(spaceOf(cur)) && spaceOf(x) === spaceOf(cur) : allowed.has(spaceOf(x))
    })
    const ok = new Set([...collectionsRef.current.filter((x) => allowed.has(spaceOf(x))).map((x) => x.id), ...cols.map((x) => x.id)])
    const fs = c.folders.filter((f) => ok.has(f.collectionId))
    const rs = c.requests.filter((r) => r.collectionId && ok.has(r.collectionId))
    const was = { cols: collectionsRef.current, fs: foldersRef.current, rs: requestsRef.current, tabs: tabsRef.current }
    const before = new Map(was.rs.filter((r) => rs.some((y) => y.id === r.id)).map((r) => [r.id, r]))
    const upsert = <T extends { id: string }>(list: T[], add: T[]) => [...list.filter((x) => !add.some((y) => y.id === x.id)), ...add]
    // The state moves at once, so a second call (two quick hand-offs, an approved change) sees these.
    if (newSpace) setSpacesState((xs) => [...xs, ASSISTANT_SPACE])
    if (cols.length) setCollections((xs) => upsert(xs, cols).sort(byName))
    if (fs.length) setFolders((xs) => upsert(xs, fs))
    if (rs.length) setRequests((xs) => upsert(xs, rs))
    // Open tabs without unsaved edits show the assistant's version, so a later Save can't write the old one back.
    // Tabs with the user's own unsaved edits keep them (and show as changed against the new version).
    if (rs.length) {
      setTabs((ts) => ts.map((t) => {
        const n = rs.find((r) => r.id === t.draft.id)
        const old = n && before.get(n.id)
        return n && old && same(old, t.draft) ? { ...t, draft: structuredClone(n) } : t
      }))
    }
    const shown = tabsRef.current
    try {
      // Stored in one go, or not at all. The list of workspaces too, even if another save added this one: that save may fail.
      const inSpace = newSpace || cols.some((x) => spaceOf(x) === ASSISTANT_SPACE.id)
      await db.putMany({ collections: cols, folders: fs, requests: rs, ...(inSpace ? { spaces: () => spacesRef.current } : {}) })
    } catch (e) {
      // Back as it was, but for what was written since.
      const back = <T extends { id: string }>(xs: T[], mine: T[], old: T[]) => [...xs.filter((x) => !mine.includes(x)), ...old.filter((o) => mine.some((m) => m.id === o.id && xs.includes(m)))]
      setCollections((xs) => back(xs, cols, was.cols).sort(byName)); setFolders((xs) => back(xs, fs, was.fs)); setRequests((xs) => back(xs, rs, was.rs))
      setTabs((ts) => ts.map((t) => {
        const old = was.tabs.find((x) => x.id === t.id), put = shown.find((x) => x.id === t.id)
        return old && put && old.draft !== put.draft && t.draft === put.draft ? { ...t, draft: old.draft } : t
      }))
      if (newSpace && !collectionsRef.current.some((x) => spaceOf(x) === ASSISTANT_SPACE.id)) setSpacesState((xs) => xs.filter((x) => x.id !== ASSISTANT_SPACE.id))
      throw e
    }
  }, [])
  /**
   * "Hand to AI assistant": a copy of a saved request goes to the assistant's Inbox with the user's note, for it to
   * review and file (core/mcpWorkspace.ts). The copy takes the auth it inherited; the original stays as it is.
   */
  const handQueue = useRef<Promise<unknown>>(Promise.resolve())
  const handToAssistant = useCallback((r: RequestDef, note: string): Promise<RequestDef> => {
    // One at a time, so two quick hand-offs share one Inbox and get distinct names.
    const run = async () => {
      const col = collectionsRef.current.find((x) => x.id === r.collectionId) ?? null
      const chain = folderChain(foldersRef.current, r.folderId) // innermost first
      let inbox = collectionsRef.current.find((x) => spaceOf(x) === ASSISTANT_SPACE.id && x.name === INBOX)
      const made = inbox ? [] : [inbox = { ...newCollection(INBOX), workspaceId: ASSISTANT_SPACE.id }]
      const inInbox = requestsRef.current.filter((x) => x.collectionId === inbox!.id)
      const taken = new Set(inInbox.map((x) => x.name))
      let name = r.name
      for (let i = 2; taken.has(name); i++) name = `${r.name} (${i})`
      const auth = r.auth.kind === 'inherit' ? effectiveAuth(r, col, chain) : null
      const copy: RequestDef = {
        ...structuredClone(r), id: uid(), name, collectionId: inbox.id, folderId: null, updatedAt: Date.now(),
        sort: Math.max(0, ...inInbox.map((x) => x.sort)) + 1,
        auth: auth ? structuredClone(auth) : r.auth,
        scripts: carriedScripts(r, col, chain),
        handoff: { note: note.trim(), from: [col?.name ?? 'Unsaved', ...[...chain].reverse().map((f) => f.name), r.name].join('/'), at: Date.now(), variables: col?.variables.length ? structuredClone(col.variables) : undefined },
      }
      await saveAssistant({ collections: made, folders: [], requests: [copy] })
      return copy
    }
    const p = handQueue.current.then(run, run)
    handQueue.current = p.catch(() => {})
    return p
  }, [saveAssistant])

  /**
   * Moves requests and folders under a parent (a collection's top level, or a folder), placed before `beforeId`
   * (a sibling request or folder) or at the end. Siblings are renumbered so the order is exact. Folders carry their
   * contents along, also to another collection. A folder can't move into itself or its own subfolders.
   */
  /**
   * Moves requests and folders under `parent` (before `beforeId`, else at the end) and renumbers the siblings.
   * `extra` holds items that aren't saved yet (copies, a tab being saved): they're added first, then placed.
   */
  const placeItems = useCallback(async (items: { kind: 'request' | 'folder'; id: string }[], parent: { collectionId: string; folderId: string | null }, beforeId: string | null = null, extra: { folders?: Folder[]; requests?: RequestDef[] } = {}) => {
    const folders = foldersRef.current, requests = requestsRef.current
    const merge = <T extends { id: string }>(base: T[], add: T[] = []) => [...base.filter((x) => !add.some((a) => a.id === x.id)), ...add]
    const baseFolders = merge(folders, extra.folders)
    const baseRequests = merge(requests, extra.requests)
    const descendants = (fid: string) => {
      const ids = new Set([fid])
      for (let grew = true; grew;) { grew = false; for (const f of baseFolders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true } }
      return ids
    }
    if (parent.folderId && items.some((i) => i.kind === 'folder' && descendants(i.id).has(parent.folderId!))) return false
    const moving = new Set(items.map((i) => i.id))
    let nextFolders = baseFolders.map((f) => ({ ...f }))
    let nextRequests = baseRequests.map((r) => ({ ...r }))
    // Re-parent.
    for (const it of items) {
      if (it.kind === 'request') nextRequests = nextRequests.map((r) => (r.id === it.id ? { ...r, collectionId: parent.collectionId, folderId: parent.folderId } : r))
      else {
        const ids = descendants(it.id)
        nextFolders = nextFolders.map((f) => (f.id === it.id ? { ...f, collectionId: parent.collectionId, parentId: parent.folderId } : ids.has(f.id) ? { ...f, collectionId: parent.collectionId } : f))
        nextRequests = nextRequests.map((r) => (r.folderId && ids.has(r.folderId) ? { ...r, collectionId: parent.collectionId } : r))
      }
    }
    // Renumber the new siblings with the moved items placed before `beforeId`.
    const siblings = [
      ...nextFolders.filter((f) => f.collectionId === parent.collectionId && f.parentId === parent.folderId).map((f) => ({ kind: 'folder' as const, id: f.id, sort: f.sort, name: f.name })),
      ...nextRequests.filter((r) => r.collectionId === parent.collectionId && (r.folderId ?? null) === parent.folderId).map((r) => ({ kind: 'request' as const, id: r.id, sort: r.sort, name: r.name })),
    ].sort(bySort)
    const rest = siblings.filter((x) => !moving.has(x.id))
    const moved = items.map((i) => siblings.find((x) => x.id === i.id)!).filter(Boolean)
    const at = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1
    const ordered = at >= 0 ? [...rest.slice(0, at), ...moved, ...rest.slice(at)] : [...rest, ...moved]
    ordered.forEach((x, i) => {
      if (x.kind === 'folder') nextFolders = nextFolders.map((f) => (f.id === x.id ? { ...f, sort: i + 1 } : f))
      else nextRequests = nextRequests.map((r) => (r.id === x.id ? { ...r, sort: i + 1 } : r))
    })
    const savedF = new Map(folders.map((f) => [f.id, JSON.stringify(f)]))
    const savedR = new Map(requests.map((r) => [r.id, JSON.stringify(r)]))
    const changedF = nextFolders.filter((f) => JSON.stringify(f) !== savedF.get(f.id))
    const changedR = nextRequests.filter((r) => JSON.stringify(r) !== savedR.get(r.id))
    setFolders(nextFolders); setRequests(nextRequests)
    setTabs((ts) => ts.map((t) => { const r = changedR.find((x) => x.id === t.draft.id); return r ? { ...t, draft: { ...t.draft, collectionId: r.collectionId, folderId: r.folderId, sort: r.sort } } : t }))
    await db.putMany({ folders: changedF, requests: changedR })
    return true
  }, [])

  /**
   * "Sort by name": the folders and requests under a collection or folder, and everything below, in natural name order
   * (2 before 10), folders first. It sets the manual order once; dragging and Move up/down still work afterwards.
   */
  const sortByName = useCallback(async (collectionId: string, folderId: string | null) => {
    const folders = foldersRef.current, requests = requestsRef.current
    const natural = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    const nextFolders = new Map(folders.map((f) => [f.id, f]))
    const nextRequests = new Map(requests.map((r) => [r.id, r]))
    const level = (parent: string | null) => {
      const subs = folders.filter((f) => f.collectionId === collectionId && f.parentId === parent).sort(natural)
      const reqs = requests.filter((r) => r.collectionId === collectionId && (r.folderId ?? null) === parent).sort(natural)
      subs.forEach((f, i) => nextFolders.set(f.id, { ...f, sort: i + 1 }))
      reqs.forEach((r, i) => nextRequests.set(r.id, { ...r, sort: subs.length + i + 1 }))
      for (const f of subs) level(f.id)
    }
    level(folderId)
    const changedF = [...nextFolders.values()].filter((f) => f.sort !== folders.find((x) => x.id === f.id)!.sort)
    const changedR = [...nextRequests.values()].filter((r) => r.sort !== requests.find((x) => x.id === r.id)!.sort)
    setFolders([...nextFolders.values()]); setRequests([...nextRequests.values()])
    setTabs((ts) => ts.map((t) => { const r = changedR.find((x) => x.id === t.draft.id); return r ? { ...t, draft: { ...t.draft, sort: r.sort } } : t }))
    await db.putMany({ folders: changedF, requests: changedR })
  }, [])

  /** Copies requests and folders (with everything in them) under `parent`. Copies next to their original get “ copy”. */
  const copyItems = useCallback(async (items: { kind: 'request' | 'folder'; id: string }[], parent: { collectionId: string; folderId: string | null }, beforeId: string | null = null) => {
    const folders = foldersRef.current, requests = requestsRef.current
    const now = Date.now()
    const outFolders: Folder[] = []
    const outRequests: RequestDef[] = []
    const top: { kind: 'request' | 'folder'; id: string }[] = []
    const copyRequest = (r: RequestDef, collectionId: string, folderId: string | null, rename: boolean) => {
      const c: RequestDef = { ...structuredClone(r), id: uid(), collectionId, folderId, name: rename ? `${r.name} copy` : r.name, updatedAt: now }
      outRequests.push(c); return c
    }
    const copyFolder = (fo: Folder, parentId: string | null, rename: boolean): Folder => {
      const c: Folder = { ...structuredClone(fo), id: uid(), collectionId: parent.collectionId, parentId, name: rename ? `${fo.name} copy` : fo.name }
      outFolders.push(c)
      for (const r of requests.filter((x) => x.folderId === fo.id)) copyRequest(r, parent.collectionId, c.id, false)
      for (const sub of folders.filter((x) => x.parentId === fo.id)) copyFolder(sub, c.id, false)
      return c
    }
    for (const it of items) {
      if (it.kind === 'request') {
        const r = requests.find((x) => x.id === it.id); if (!r) continue
        const same = r.collectionId === parent.collectionId && (r.folderId ?? null) === parent.folderId
        top.push({ kind: 'request', id: copyRequest(r, parent.collectionId, parent.folderId, same).id })
      } else {
        const fo = folders.find((x) => x.id === it.id); if (!fo) continue
        const same = fo.collectionId === parent.collectionId && (fo.parentId ?? null) === parent.folderId
        top.push({ kind: 'folder', id: copyFolder(fo, parent.folderId, same).id })
      }
    }
    if (!top.length) return false
    return placeItems(top, parent, beforeId, { folders: outFolders, requests: outRequests })
  }, [placeItems])

  /** Saves an open tab into a collection or folder (a new request, or a saved one with its edits, moved there). */
  const saveTabTo = useCallback(async (tabId: string, parent: { collectionId: string; folderId: string | null }, beforeId: string | null = null) => {
    const t = tabs.find((x) => x.id === tabId)
    if (!t) return false
    const r: RequestDef = { ...t.draft, collectionId: parent.collectionId, folderId: parent.folderId, updatedAt: Date.now() }
    const ok = await placeItems([{ kind: 'request', id: r.id }], parent, beforeId, { requests: [r] })
    if (ok) setTabs((ts) => ts.map((x) => (x.id === tabId ? { ...x, draft: { ...r, sort: x.draft.sort } } : x)))
    return ok
  }, [tabs, placeItems])

  /** Whether nothing was written since this render: what a folder's version was worked out from is still what is here. */
  const unchanged = () => collections === collectionsRef.current && folders === foldersRef.current && requests === requestsRef.current && environments === environmentsRef.current

  /** Replaces a collection's contents (e.g. reloaded from its folder); adds it if it's new. */
  /**
   * Makes a workspace hold exactly what a folder holds (the folder wins): items in the workspace that the folder
   * doesn't have are removed, the folder's items are added or updated (ids kept, moved here if they were elsewhere).
   * Collections with a folder of their own are left alone. Callers take a backup first.
   */
  const replaceSpaceContents = useCallback(async (spaceId: string, w: { collections: Collection[]; folders: Folder[]; requests: RequestDef[]; environments: Environment[]; flows: Flow[] }, opts: FromFolder = {}) => inTurn(async () => {
    if (opts.ifUnchanged && !unchanged()) return false
    // What to remove is decided on what was here when `w` was worked out (this render): an item added or moved in since
    // isn't missing from the folder. One that has left since stays where it went.
    const inSpace = <T extends { workspaceId?: string }>(x: T) => spaceOf(x) === spaceId
    const goneCols = collections.filter((c) => inSpace(c) && !c.linkedDir && !w.collections.some((x) => x.id === c.id) && collectionsRef.current.some((x) => x.id === c.id && inSpace(x) && !x.linkedDir)).map((c) => c.id)
    const goneEnvs = environments.filter((e) => inSpace(e) && !w.environments.some((x) => x.id === e.id) && environmentsRef.current.some((x) => x.id === e.id && inSpace(x))).map((e) => e.id)
    const goneFlows = flows.filter((f) => inSpace(f) && !w.flows.some((x) => x.id === f.id)).map((f) => f.id)
    if (opts.trashLabel) {
      const spaceCols = new Set(collections.filter((c) => inSpace(c) && !c.linkedDir).map((c) => c.id))
      const keep = new Set(w.requests.map((r) => r.id))
      const gone: Partial<Workspace> = {
        collections: collections.filter((c) => goneCols.includes(c.id)),
        folders: folders.filter((f) => goneCols.includes(f.collectionId)),
        requests: requests.filter((r) => r.collectionId && spaceCols.has(r.collectionId) && !keep.has(r.id)),
        environments: environments.filter((e) => goneEnvs.includes(e.id)),
        flows: flows.filter((f) => goneFlows.includes(f.id)),
      }
      if (gone.collections!.length || gone.requests!.length || gone.environments!.length || gone.flows!.length) toTrash(opts.trashLabel, gone)
    }
    const colIds = new Set([...goneCols, ...w.collections.map((c) => c.id)])
    const savedBefore = requestsRef.current
    for (const id of colIds) await db.deleteCollection(id)
    for (const id of goneEnvs) { await db.deleteEnvironment(id); dropJar(id) }
    for (const id of goneFlows) { deletedFlows.current.add(id); await db.deleteFlow(id) }
    for (const f of w.flows) deletedFlows.current.delete(f.id)
    await db.putMany(w)
    setCollections((cs) => [...cs.filter((c) => !colIds.has(c.id)), ...w.collections].sort(byName))
    setFolders((fs) => [...fs.filter((f) => !colIds.has(f.collectionId)), ...w.folders])
    setRequests((rs) => [...rs.filter((r) => !r.collectionId || !colIds.has(r.collectionId)), ...w.requests])
    setEnvironments((es) => [...es.filter((e) => !goneEnvs.includes(e.id) && !w.environments.some((x) => x.id === e.id)), ...w.environments].sort(byName))
    setFlows((fs) => [...fs.filter((f) => !goneFlows.includes(f.id) && !w.flows.some((x) => x.id === f.id)), ...w.flows])
    setTabs((ts) => ts.map((t) => refreshTab(t, w.requests, savedBefore, opts)))
    if (settingsRef.current.activeEnvId && goneEnvs.includes(settingsRef.current.activeEnvId)) setSettings({ activeEnvId: null })
    setView((v) => (v.kind === 'flow' && goneFlows.includes(v.id) ? { kind: 'request' } : v))
    return true
  }), [collections, folders, requests, environments, flows, setSettings, toTrash, inTurn]) // eslint-disable-line react-hooks/exhaustive-deps

  const replaceCollection = useCallback((w: Workspace, opts: FromFolder = {}) => inTurn(async () => {
    if (opts.ifUnchanged && !unchanged()) return false
    const requests = requestsRef.current
    const c = w.collections[0]
    if (opts.trashLabel) {
      const keep = new Set(w.requests.map((r) => r.id))
      const gone = requests.filter((r) => r.collectionId === c.id && !keep.has(r.id))
      if (gone.length) toTrash(opts.trashLabel, { requests: gone })
    }
    await db.deleteCollection(c.id)
    await db.putMany({ collections: [c], folders: w.folders, requests: w.requests })
    setCollections((cs) => [...cs.filter((x) => x.id !== c.id), c].sort(byName))
    setFolders((fs) => [...fs.filter((f) => f.collectionId !== c.id), ...w.folders])
    setRequests((rs) => [...rs.filter((r) => r.collectionId !== c.id), ...w.requests])
    setTabs((ts) => ts.map((t) => refreshTab(t, w.requests, requests, opts)))
    return true
  }), [collections, folders, requests, environments, toTrash, inTurn]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Deletes several requests with one undo. */
  const removeRequests = useCallback(async (ids: string[]) => {
    const gone = requestsRef.current.filter((r) => ids.includes(r.id))
    setRequests((rs) => rs.filter((r) => !ids.includes(r.id)))
    await orBack((async () => { for (const id of ids) await db.deleteRequest(id) })(), { requests: gone })
    setTabs((ts) => ts.map((t) => (ids.includes(t.draft.id) ? { ...t, draft: { ...t.draft, id: uid() } } : t)))
    if (gone.length) toTrash(gone.length === 1 ? `“${gone[0].name}”` : `${gone.length} requests`, { requests: gone })
  }, [toTrash, orBack])

  /** Deletes requests for an MCP assistant, only where it may write; they go to the trash so the user can undo. */
  const removeForAssistant = useCallback(async (ids: string[]) => {
    const allowed = aiSpaces()
    const ok = new Set(collectionsRef.current.filter((x) => allowed.has(spaceOf(x))).map((x) => x.id))
    await removeRequests(ids.filter((id) => requestsRef.current.some((r) => r.id === id && r.collectionId && ok.has(r.collectionId))))
  }, [removeRequests])
  /** Puts back the most recent delete, or the one named (what a message offered to undo). */
  const undoDelete = useCallback(async (id?: string) => {
    const last = trashRef.current.filter((t) => (!id || t.id === id) && !restored.current.has(t.id)).pop()
    if (!last) return null
    restored.current.add(last.id)
    setTrash((t) => t.filter((x) => x !== last))
    await importWorkspace(last.data)
    return last.label
  }, [importWorkspace])

  const snapshot = useCallback((): db.BackupData => ({ collections: collectionsRef.current, folders: foldersRef.current, requests: requestsRef.current, environments: environmentsRef.current, globals: globalsRef.current, flows: flowsRef.current }), [])
  const backupNow = useCallback(async (reason: db.BackupInfo['reason'] = 'manual') => {
    await db.addBackup(snapshot(), reason); setBackups(await db.listBackups())
  }, [snapshot])
  /** Replaces everything with a backup, after backing up what's there now. */
  const restoreBackup = useCallback((id: string) => inTurn(async () => {
    const data = await db.getBackup(id)
    if (!data) return false
    await db.addBackup(snapshot(), 'before-restore')
    await db.replaceAll(data)
    deletedFlows.current.clear()
    setCollections(data.collections.sort(byName)); setFolders(data.folders); setRequests(data.requests)
    setEnvironments(data.environments.sort(byName)); setGlobalsState(data.globals); if (data.flows) setFlows(data.flows)
    setBackups(await db.listBackups()); setView({ kind: 'request' })
    return true
  }), [snapshot, inTurn])

  // ---------- what the assistant proposed and the person approved ----------
  /** A saved record as it is now (null when it isn't there). */
  const recordNow = useCallback((kind: Kind, id: string): Rec | null =>
    recIn({ collection: collectionsRef.current, folder: foldersRef.current, request: requestsRef.current, environment: environmentsRef.current }, globalsRef.current, kind, id), [])
  /** Whether an open tab of this request has edits that aren't saved. */
  const isUnsaved = useCallback((requestId: string): boolean => {
    const r = requestsRef.current.find((x) => x.id === requestId)
    return tabsRef.current.some((t) => t.draft.id === requestId && (!r || !same(r, t.draft)))
  }, [])
  /** Why these changes can't be written now, or null. `done` is the word for what then didn't happen. */
  const refusal = useCallback((spaceId: string, changes: Change[], done: 'applied' | 'undone'): ApplyResult | null => {
    const s = settingsRef.current
    if ((spacesRef.current.some((x) => x.id === s.activeSpaceId) ? s.activeSpaceId : DEFAULT_SPACE.id) !== spaceId) return no('gone', `Another workspace is open, so nothing was ${done}.`)
    const made = <T extends Stored>(kind: Kind, id: string | null) => (changes.find((c) => c.kind === kind && c.id === id)?.after ?? (id ? recordNow(kind, id) : null)) as T | null
    const gone = no('gone', `What this belongs to isn’t in this workspace any more, so nothing was ${done}.`)
    const changed = no('changed', `This changed meanwhile, so nothing was ${done}.`)
    const dropped = (kind: Kind, id: string | null) => changes.some((c) => c.kind === kind && c.id === id && !c.after)
    for (const c of changes) {
      const now = recordNow(c.kind, c.id)
      if (c.kind === 'request' && c.before && isUnsaved(c.id)) return no('unsaved', `Save or discard your changes to “${(c.before as RequestDef).name}” first. Nothing was ${done}.`)
      if (c.before && !now) return gone
      for (const r of [now, c.after]) {
        if (!r || Array.isArray(r)) continue
        const owner = 'collectionId' in r ? made<Collection>('collection', r.collectionId) : r
        if (!owner || spaceOf(owner as Collection | Environment) !== spaceId) return gone
        if (r !== c.after || !('collectionId' in r)) continue
        const into = 'folderId' in r ? r.folderId : r.parentId
        if (into && made<Folder>('folder', into)?.collectionId !== r.collectionId) return gone
      }
      if (canonical(now) !== canonical(c.before)) return changed
      // Nothing that isn't part of this goes with a collection or folder.
      if (!c.after && (c.kind === 'collection' || c.kind === 'folder')) {
        const inside = (r: Folder | RequestDef) => (c.kind === 'collection' ? r.collectionId === c.id : ('folderId' in r ? r.folderId : r.parentId) === c.id)
        if (foldersRef.current.some((x) => inside(x) && !dropped('folder', x.id)) || requestsRef.current.some((x) => inside(x) && !dropped('request', x.id))) return changed
      }
    }
    return null
  }, [recordNow, isUnsaved])
  /**
   * Writes changes in one transaction; state follows once it has committed. They are checked when it starts and again
   * right before the transaction. Whatever the person writes while it commits is queued behind it and stays theirs:
   * the change is put onto their version.
   */
  const writeChanges = useCallback(async (spaceId: string, list: Change[], done: 'applied' | 'undone'): Promise<{ result: ApplyResult; written: Change[] }> => {
    const at = Date.now()
    const written: Change[] = list.map((c) => ({ ...c, after: c.after && !Array.isArray(c.after) ? { ...structuredClone(c.after), updatedAt: at } : structuredClone(c.after) }))
    let refused = refusal(spaceId, written, done)
    if (refused) return { result: refused, written }
    const was = new Map<Change, Rec | null>()
    try {
      await db.applyRecords(written.filter((c) => c.after), written.filter((c) => !c.after), () => {
        refused = refusal(spaceId, written, done)
        if (refused) throw new Error('refused')
        for (const c of written) was.set(c, recordNow(c.kind, c.id))
      })
    } catch { return { result: refused ?? no('failed', `Dispatch couldn’t save this, so nothing was ${done}.`), written } }
    const again: Change[] = []
    const settled = <T extends Stored>(kind: Kind, xs: T[], here: (x: T) => boolean): T[] => {
      for (const c of written) {
        if (c.kind !== kind) continue
        const old = was.get(c) as T | null, now = xs.find((x) => x.id === c.id) ?? null, after = c.after as T | null
        if (now === old) {
          if (!after) xs = xs.filter((x) => x.id !== c.id)
          else if (now) xs = xs.map((x) => (x === now ? after : x))
          else if (here(after)) xs = [...xs, after] // what it went into may have been deleted in the same instant
        } else if (now && old && after) {
          const both = rebase(old, after, now) as T
          xs = xs.map((x) => (x === now ? both : x)); again.push({ ...c, after: both })
        }
      }
      return xs
    }
    const col = (id: string | null) => collectionsRef.current.some((c) => c.id === id)
    const fo = (id: string | null) => !id || foldersRef.current.some((f) => f.id === id) || written.some((c) => c.kind === 'folder' && c.id === id && c.after)
    // Rendered at once, so an open editor's next keystroke is already on top of it.
    flushSync(() => {
      const has = (k: Kind) => written.some((c) => c.kind === k)
      if (has('collection')) setCollections((xs) => settled('collection', xs, () => true).sort(byName))
      if (has('folder')) setFolders((xs) => settled('folder', xs, (f) => col(f.collectionId) && fo(f.parentId)))
      if (has('request')) setRequests((xs) => settled('request', xs, (r) => col(r.collectionId) && fo(r.folderId)))
      if (has('environment')) setEnvironments((xs) => settled('environment', xs, () => true).sort(byName))
      const g = written.find((c) => c.kind === 'globals')
      if (g) {
        const now = globalsRef.current, old = was.get(g) as KV[]
        const next = now === old ? g.after as KV[] : mergeVars(old, g.after as KV[], now)
        setGlobalsState(next)
        if (now !== old) again.push({ ...g, after: next })
      }
      // Tabs without edits show the new version; a deleted request's tab stays as an unsaved draft.
      setTabs((ts) => ts.map((t) => {
        const c = written.find((x) => x.kind === 'request' && x.id === t.draft.id)
        const now = c && requestsRef.current.find((r) => r.id === c.id)
        let d = t.draft
        if (c && !c.after && !now) d = { ...d, id: uid() }
        else if (c && now && was.get(c) && same(was.get(c) as RequestDef, d)) d = structuredClone(now)
        if (written.some((x) => !x.after && x.kind === 'collection' && x.id === d.collectionId)) d = { ...d, collectionId: null, folderId: null }
        else if (written.some((x) => !x.after && x.kind === 'folder' && x.id === d.folderId)) d = { ...d, folderId: null }
        return d === t.draft ? t : { ...t, draft: d }
      }))
      setView((v) => ((v.kind === 'collection' || v.kind === 'folder' || v.kind === 'environment') && written.some((c) => !c.after && c.kind === v.kind && c.id === v.id) ? { kind: 'request' } : v))
    })
    // The change itself is stored by now; a failure here only leaves what the person's own write left.
    // After the person's own write, which may still be on its way; not over a newer one (that has both already).
    for (const c of again) await db.applyRecords([c], [], () => { if (recordNow(c.kind, c.id) !== c.after) throw new Error('newer') }).catch(() => {})
    return { result: { ok: true }, written }
  }, [refusal, recordNow])
  /** Proposals applied since Dispatch started, with the records as they were written. In memory only. */
  const appliedRef = useRef(new Map<string, { changes: Change[]; trashId: string | null; undone: boolean }>())
  const applyProposal = useCallback((p: Proposal): Promise<ApplyResult> => inTurn(async () => {
    if (appliedRef.current.has(p.id)) return no('changed', 'This was already applied.')
    const { result, written } = await writeChanges(p.spaceId, p.changes, 'applied')
    if (!result.ok) return result
    const gone = written.flatMap((c) => (c.kind === 'request' && !c.after && !recordNow('request', c.id) ? [c.before as RequestDef] : []))
    const trashId = gone.length ? toTrash(gone.length === 1 ? `“${gone[0].name}”` : `${gone.length} requests`, { requests: gone }) : null
    appliedRef.current.set(p.id, { changes: written, trashId, undone: false })
    return result
  }), [inTurn, writeChanges, toTrash, recordNow])
  const undoProposal = useCallback((p: Proposal): Promise<ApplyResult> => inTurn(async () => {
    const a = appliedRef.current.get(p.id)
    if (!a || a.undone) return no('changed', a ? 'This was already undone.' : 'This wasn’t applied, so there is nothing to undo.')
    const changed = no('changed', 'This changed meanwhile, so nothing was undone.')
    if (a.trashId && restored.current.has(a.trashId)) return changed
    // Claimed while it is put back, so the list can't put it back too; off the list once it is.
    if (a.trashId) restored.current.add(a.trashId)
    const { result } = await writeChanges(p.spaceId, a.changes.map((c) => ({ ...c, before: c.after, after: c.before })).reverse(), 'undone')
    if (result.ok) {
      a.undone = true
      if (a.trashId) setTrash((t) => t.filter((x) => x.id !== a.trashId))
    } else if (a.trashId) restored.current.delete(a.trashId)
    return result
  }), [inTurn, writeChanges])

  return {
    applyProposal, undoProposal, isUnsaved, recordNow,
    trash, undoDelete, backups, backupNow, restoreBackup, placeItems, sortByName, copyItems, saveTabTo, removeRequests, replaceCollection,
    flows: visibleFlows, allFlows: flows, addFlow, updateFlow, duplicateFlow, removeFlow, runFlowNow,
    spaces, activeSpaceId, switchSpace, addSpace, addSpaceFrom, setSpaceFolder, setSpaceFolderId, renameSpace, removeSpace, moveToSpace, setSpaceAi, setSpaceSecrets,
    replaceSpaceContents, folderStatus, setFolderStatus,
    /** Everything, across workspaces (exports, backups, file sync). The plain lists below are this workspace's. */
    allCollections: collections, allEnvironments: environments,
    ready, transport, collections: visibleCollections, folders, requests, environments: visibleEnvironments, globals, history, settings, logs,
    recordHistory,
    /** Every workspace's tabs; `tabs` are the ones shown. */
    allTabs: tabs,
    tabs: shownTabs, activeId: active.id, active, draft, view, result: active.result, sending: active.sending, saved, dirty, isDirty,
    collection, environment, prepared, chain, runContext, pipeline: pipelineRef, variableNames,
    setDraft, setView, setSettings, setLogs, log, openRequest, startNew, closeTab, closeTabs, duplicateTab, selectTab, saveDraft, saveDraftAs, renameRequest,
    moveRequest, removeRequest, duplicateRequest, saveAssistant, removeForAssistant, handToAssistant, send, cancel, applyChanges, applyAuthUpdate, openHistory, clearHistory,
    addCollection, updateCollection, removeCollection, addFolder, updateFolder, removeFolder,
    addEnvironment, updateEnvironment, removeEnvironment, duplicateEnvironment, setGlobals, keepVars, extractVariable, cookieJar, cookieJars: jars, importWorkspace,
  }
}

export type WorkspaceApi = ReturnType<typeof useWorkspace>
