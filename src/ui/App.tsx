import { useCallback, useEffect, useRef, useState } from 'react'
import { useMenuDismiss } from './menus'
import { useWorkspace, type View, type WorkspaceApi } from './useWorkspace'
import { useDialogs } from './Dialogs'
import { useContextMenu } from './ContextMenu'
import { HomeView } from './HomeView'
import { ShareDialog } from './ShareDialog'
import { SplitPane } from './SplitPane'
import { runUpdateCheck, updatesAvailable } from './updates'
import { applyTelemetry, telemetryOffered, track } from './telemetry'
import { ConsentDialog, FeedbackDialog } from './PrivacyDialogs'
import { AboutDialog } from './AboutDialog'
import type { ShareTarget } from '../core/share'
import { Sidebar } from './Sidebar'
import { RequestPane } from './RequestPane'
import { ResponsePane } from './ResponsePane'
import { CollectionEditor, EnvironmentEditor, FolderEditor, GlobalsEditor } from './Editors'
import { exportCollection, exportWorkspace, importFileAsync, type ImportResult } from '../core/backup'
import { nameFromUrl } from '../core/curl'
import { withScheme } from '../core/url'
import type { Transport } from '../core/transport'
import { saveAnyFile, saveTextFile } from './files'
import { RunnerView } from './RunnerView'
import { LoadView } from './LoadView'
import { getOAuthToken } from './oauth'
import { importBruno, toPostmanCollection } from '../core/interop'
import { desktopFolders, openCollectionFolder, openSpaceFolder, useFolderSync } from './linkedDirs'
import { SchedulesView, useScheduler } from './Schedules'
import { layeredVars, selectLayer } from '../core/layers'
import { FlowView } from './FlowView'
import { SpacesView } from './SpacesView'
import { McpPane } from './McpPane'
import { BrowserPane } from './BrowserPane'
import type { BrowserLauncher } from '../core/browser'
import { DocsView } from './DocsView'
import { MockView } from './MockView'
import { DND_TAB } from './dnd'
import { useMcpHost } from './mcpHost'
import { Markdown } from './Markdown'
import { ProtocolPicker, RealtimePane } from './RealtimePane'
import { GrpcPane } from './GrpcPane'
import { BackupsView } from './BackupsView'
import { CookiesView, SettingsView } from './SettingsView'
import { LOOKS } from '../core/types'
import type { Auth } from '../core/types'
import type { Collection } from '../core/types'
import type { Pipeline } from '../core/runtime'
import type { ScriptEngine } from '../core/scriptPipeline'

const readText = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('Couldn’t read that file.'))
  r.readAsText(file)
})

function Console({ ws, onClose }: { ws: WorkspaceApi; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [ws.logs.length])
  return (
    <section className="console" aria-label="Console">
      <div className="consoleHead">
        <strong>Console</strong><span className="muted small">script output and network log</span><span className="grow" />
        <button type="button" className="btn small ghost" onClick={() => ws.setLogs([])}>Clear</button>
        <button type="button" className="btn small ghost" aria-label="Close console" onClick={onClose}>×</button>
      </div>
      <div className="consoleBody mono" role="log">
        {ws.logs.map((l, i) => (
          <div key={i} className={`logLine ${l.level}`}>
            <span className="muted">{new Date(l.at).toLocaleTimeString()}</span>
            {l.source && <span className="logSrc">{l.source}</span>}
            <span className="logText">{l.text}</span>
          </div>
        ))}
        {!ws.logs.length && <p className="muted small">Nothing yet. <code>console.log()</code> in a script, or send a request.</p>}
        <div ref={end} />
      </div>
    </section>
  )
}

/** Other importers (OpenAPI, HAR) register here so App doesn't need to know them. */
export type Importer = (text: string, fileName: string) => ImportResult | null

/** A page (Settings, a collection, the runner…) shows as one more tab, so the requests are always one click away.
 *  It stays in the tab bar while you work in a request, so the page is one click away too. */
type PageTab = { title: string; on: boolean; onOpen: () => void; onClose: () => void }

function TabBar({ ws, onClose, onMenu, page }: { ws: WorkspaceApi; onClose: (id: string) => void; onMenu: (e: React.MouseEvent, tabId: string) => void; page?: PageTab }) {
  return (
    <div className="tabBar" role="tablist" aria-label="Open requests">
      {ws.tabs.map((t) => {
        const on = t.id === ws.activeId && ws.view.kind === 'request'
        const dirty = ws.isDirty(t.draft)
        return (
          <div key={t.id} className={`reqTab ${on ? 'on' : ''}`} draggable title="Drag onto a collection or folder to save it there" onContextMenu={(e) => onMenu(e, t.id)}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(DND_TAB, t.id); e.dataTransfer.setData('text/plain', t.draft.name) }}>
            <button type="button" role="tab" aria-selected={on} className="reqTabMain" onClick={() => ws.selectTab(t.id)} title={t.draft.url || t.draft.name}
              onAuxClick={(e) => { if (e.button === 1) onClose(t.id) }}>
              <span className={`mtag m-${t.draft.protocol === 'http' ? t.draft.method : 'proto'}`}>{t.draft.protocol !== 'http' ? ({ ws: 'WS', mqtt: 'MQTT', grpc: 'gRPC', sse: 'SSE', socketio: 'SIO', mcp: 'MCP', browser: 'WEB' } as Record<string, string>)[t.draft.protocol] : t.draft.method === 'DELETE' ? 'DEL' : t.draft.method === 'OPTIONS' ? 'OPT' : t.draft.method}</span>{' '}
              <span className="reqTabName">{t.draft.name}</span>
              {t.sending && <span className="spin" aria-label="sending" />}
            </button>
            <button type="button" className={`reqTabX ${dirty ? 'dirty' : ''}`} aria-label={`Close ${t.draft.name}`} onClick={() => onClose(t.id)}>{dirty ? '●' : '×'}</button>
          </div>
        )
      })}
      {page && (
        <div className={`reqTab page ${page.on ? 'on' : ''}`}>
          <button type="button" role="tab" aria-selected={page.on} className="reqTabMain" title={page.title} onClick={page.onOpen}>
            <span className="pageMark" aria-hidden="true" />
            <span className="reqTabName">{page.title}</span>
          </button>
          <button type="button" className="reqTabX" aria-label={`Close ${page.title}`} title="Back to your requests" onClick={page.onClose}>×</button>
        </div>
      )}
      <button type="button" className="reqTabNew" aria-label="New tab" title="New request (Ctrl+T)" onClick={() => ws.startNew()}>+</button>
    </div>
  )
}

export interface AppExtras {
  /** Extra panels by view kind (runner, load test...). */
  views?: Partial<Record<'runner' | 'load', (ws: WorkspaceApi, notify: (m: string) => void) => React.ReactNode>>
  importers?: Importer[]
  extend?: (base: Pipeline, transport: Transport) => Pipeline
}

export function App({ transport, engine, browserLauncher, extras = {} }: { transport?: Transport; engine?: ScriptEngine; browserLauncher?: BrowserLauncher; extras?: AppExtras }) {
  const ws = useWorkspace({ transport, engine, browserLauncher, extend: extras.extend })
  const mcpHost = useMcpHost(ws)
  const { ask, confirm, askNote, askSave, askPlace, node: dialog } = useDialogs()
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const fileInput = useRef<HTMLInputElement>(null)
  const brunoInput = useRef<HTMLInputElement>(null)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [sharing, setSharing] = useState<ShareTarget | null>(null)
  const [feedback, setFeedback] = useState(false)
  const [about, setAbout] = useState(false)
  // Usage and error reports follow the person's choice (asked once, changeable in Settings).
  useEffect(() => { if (ws.ready) applyTelemetry({ shareUsage: ws.settings.shareUsage, shareErrors: ws.settings.shareErrors }) }, [ws.ready, ws.settings.shareUsage, ws.settings.shareErrors])
  // The last page shown (Settings, a collection…), kept as a tab while a request is open.
  const [lastPage, setLastPage] = useState<View | null>(null)
  useEffect(() => { if (ws.view.kind !== 'request') setLastPage(ws.view) }, [ws.view])
  const [gettingToken, setGettingToken] = useState(false)
  const authActions = {
    gettingToken,
    getToken: async (auth: Auth, apply: (a: Auth) => void) => {
      setGettingToken(true)
      try { const next = await getOAuthToken(ws, auth, ask); if (next) { apply(next); notify('Got a new token.') } }
      catch (e) { notify(e instanceof Error ? e.message : String(e)) }
      finally { setGettingToken(false) }
    },
  }

  const notify = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    setToast({ text: msg, action }); clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), action ? 9000 : msg.length > 80 ? 8000 : 3500)
  }, [])
  // The quiet check on start, once, when the person turned it on (Settings → General).
  const updateChecked = useRef(false)
  useEffect(() => {
    if (!ws.ready || updateChecked.current || !updatesAvailable() || !ws.settings.updateCheckOnStart) return
    updateChecked.current = true
    void runUpdateCheck(notify, confirm, true)
  }, [ws.ready, ws.settings.updateCheckOnStart, notify, confirm])
  useFolderSync(ws, notify)
  useMenuDismiss()
  const sched = useScheduler(ws)
  // Every delete can be undone from the toast.
  const trashCount = useRef(0)
  useEffect(() => {
    if (ws.trash.length > trashCount.current) {
      const last = ws.trash[ws.trash.length - 1]
      notify(`Deleted ${last.label}.`, { label: 'Undo', run: () => { void ws.undoDelete().then((l) => { if (l) notify(`Restored ${l}.`) }) } })
    }
    trashCount.current = ws.trash.length
  }, [ws.trash]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const root = document.documentElement
    if (ws.settings.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', ws.settings.theme)
  }, [ws.settings.theme])
  useEffect(() => {
    const root = document.documentElement
    const look = LOOKS.includes(ws.settings.look) ? ws.settings.look : 'dispatch'
    if (look === 'dispatch') root.removeAttribute('data-look'); else root.setAttribute('data-look', look)
  }, [ws.settings.look])

  const save = useCallback(async () => {
    if (ws.saved) { if (!ws.dirty) { notify('Nothing new to save.'); return } await ws.saveDraft(); notify('Saved.'); return }
    // Name from the URL as written (/users/:id), not as filled in (/users/42).
    const suggested = ws.draft.name === 'New request' && ws.draft.url.trim() ? nameFromUrl(withScheme(ws.draft.url)) : ws.draft.name
    const choice = await askSave(suggested, ws.collections, ws.folders, ws.draft)
    if (!choice) return
    let collectionId = choice.collectionId
    if (choice.newCollection) collectionId = (await ws.addCollection(choice.newCollection)).id
    await ws.saveDraft({ collectionId, folderId: choice.folderId, name: choice.name })
    notify('Saved.')
  }, [ws, askSave, notify])

  /** Save as: a copy under a new name or place; the tab moves to the copy, the original keeps its last save. */
  const saveAs = useCallback(async () => {
    const base = ws.draft.name === 'New request' && ws.draft.url.trim() ? nameFromUrl(withScheme(ws.draft.url)) : ws.draft.name
    const choice = await askSave(ws.saved ? `${base} copy` : base, ws.collections, ws.folders, ws.draft, 'Save as')
    if (!choice) return
    let collectionId = choice.collectionId
    if (choice.newCollection) collectionId = (await ws.addCollection(choice.newCollection)).id
    const r = await ws.saveDraftAs({ collectionId, folderId: choice.folderId, name: choice.name })
    notify(`Saved as “${r.name}”.`)
  }, [ws, askSave, notify])

  const closeTab = useCallback(async (id: string) => {
    const t = ws.tabs.find((x) => x.id === id)
    if (t && ws.isDirty(t.draft) && !(await confirm(`Discard unsaved changes to “${t.draft.name}”?`))) return
    ws.closeTab(id)
  }, [ws, confirm])
  /** Closes several tabs, asking once about unsaved changes unless forced. */
  const closeTabs = useCallback(async (ids: string[], force = false) => {
    const dirty = ws.tabs.filter((t) => ids.includes(t.id) && ws.isDirty(t.draft))
    if (!force && dirty.length && !(await confirm(dirty.length === 1 ? `Discard unsaved changes to “${dirty[0].draft.name}”?` : `Discard unsaved changes in ${dirty.length} tabs (${dirty.map((t) => `“${t.draft.name}”`).join(', ')})?`))) return
    ws.closeTabs(ids)
  }, [ws, confirm])
  const ctx = useContextMenu()
  /** Right-click on a tab: the tab menu. */
  const tabMenu = useCallback((e: React.MouseEvent, id: string) => {
    const i = ws.tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    const t = ws.tabs[i]
    const ids = ws.tabs.map((x) => x.id)
    const others = ids.filter((x) => x !== id)
    const anyDirty = ws.tabs.some((x) => ws.isDirty(x.draft))
    ctx.open(e, [
      { label: 'Duplicate tab', run: () => ws.duplicateTab(id) },
      '-',
      { label: 'Close tab', hint: 'Ctrl+W', run: () => void closeTab(id) },
      ...(ws.isDirty(t.draft) ? [{ label: 'Force close tab', run: () => ws.closeTab(id) }] : []),
      { label: 'Close other tabs', run: () => void closeTabs(others), disabled: !others.length },
      { label: 'Close tabs to the left', run: () => void closeTabs(ids.slice(0, i)), disabled: i === 0 },
      { label: 'Close tabs to the right', run: () => void closeTabs(ids.slice(i + 1)), disabled: i === ids.length - 1 },
      '-',
      { label: 'Close all tabs', run: () => void closeTabs(ids) },
      ...(anyDirty ? [{ label: 'Force close all tabs', run: () => ws.closeTabs(ids), tone: 'danger' as const }] : []),
    ], `Tab actions for ${t.draft.name}`)
  }, [ws, ctx, closeTab, closeTabs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && e.key === 'Enter') { e.preventDefault(); void ws.send() }
      else if (mod && e.shiftKey && k === 's') { e.preventDefault(); void saveAs() }
      else if (mod && k === 's') { e.preventDefault(); void save() }
      else if (mod && (k === 't' || (e.altKey && k === 'n'))) { e.preventDefault(); ws.startNew(ws.draft.collectionId, ws.draft.folderId) }
      else if (mod && k === 'w') { e.preventDefault(); void closeTab(ws.activeId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ws, save, saveAs, closeTab])

  const onImport = async (file: File) => {
    try {
      const text = await readText(file)
      let r: ImportResult | null = null
      for (const imp of extras.importers ?? []) { r = imp(text, file.name); if (r) break }
      r ??= await importFileAsync(text)
      await ws.importWorkspace(r)
      const n = (x: number, w: string) => x && `${x} ${w}${x > 1 ? 's' : ''}`
      const what = [n(r.collections.length, 'collection'), n(r.folders.length, 'folder'), n(r.requests.length, 'request'), n(r.environments.length, 'environment'), n(r.flows?.length ?? 0, 'flow')].filter(Boolean).join(', ')
      track('imported', { format: r.source })
      notify(`Imported ${what || 'nothing'}.${r.warnings.length ? ` ${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''}: ${r.warnings.slice(0, 3).join(' ')}${r.warnings.length > 3 ? ' …' : ''}` : ''}`)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e))
    }
  }

  // Backups and exports cover every workspace.
  const workspace = () => ({ collections: ws.allCollections, folders: ws.folders, requests: ws.requests, environments: ws.allEnvironments, globals: ws.globals, flows: ws.allFlows })
  const onExport = async () => {
    try {
      if (await saveTextFile(`dispatch-backup-${new Date().toISOString().slice(0, 10)}.json`, exportWorkspace(workspace())))
        notify('Backup saved. It includes environment values (not secret ones), so keep it somewhere safe.')
    } catch (e) { notify(`Couldn’t save the backup: ${String(e)}`) }
  }
  const onExportCollection = async (c: Collection) => {
    try {
      if (await saveTextFile(`${c.name.replace(/[^\w.-]+/g, '-')}.dispatch.json`, exportCollection(workspace(), c.id))) notify(`Exported ${c.name}.`)
    } catch (e) { notify(`Couldn’t export: ${String(e)}`) }
  }

  const renderDocs = (md: string) => <Markdown text={md} />
  const onExportPostman = async (c: Collection) => {
    try {
      if (await saveTextFile(`${c.name.replace(/[^\w.-]+/g, '-')}.postman_collection.json`, toPostmanCollection(c, ws.folders, ws.requests)))
        notify(`Exported ${c.name} for Postman (secret values left out).`)
    } catch (e) { notify(`Couldn’t export: ${String(e)}`) }
  }
  const closeMenu = (e: React.MouseEvent) => { (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open') }

  if (!ws.ready) return <p className="loading">Opening…</p>

  const titleOf = (v: View): string | null => {
    if (v.kind === 'request') return null
    if (v.kind === 'collection') return ws.collections.find((c) => c.id === v.id)?.name ?? null
    if (v.kind === 'folder') return ws.folders.find((f) => f.id === v.id)?.name ?? null
    if (v.kind === 'environment') return ws.environments.find((e) => e.id === v.id)?.name ?? null
    if (v.kind === 'flow') return ws.flows.find((x) => x.id === v.id)?.name ?? null
    return pageTitles[v.kind] ?? null
  }
  const viewed = ws.view
  const col = viewed.kind === 'collection' ? ws.collections.find((c) => c.id === viewed.id) : undefined
  const folder = viewed.kind === 'folder' ? ws.folders.find((f) => f.id === viewed.id) : undefined
  const env = viewed.kind === 'environment' ? ws.environments.find((e) => e.id === viewed.id) : undefined
  const extraView = (viewed.kind === 'runner' || viewed.kind === 'load') ? extras.views?.[viewed.kind] : undefined
  const pageTitles: Record<string, string> = {
    home: 'Home', globals: 'Globals', runner: 'Runner', load: 'Load test', docs: 'Docs', mock: 'Mock server', backups: 'Local backups',
    settings: 'Settings', cookies: 'Cookies', schedules: 'Schedules', spaces: 'Workspaces',
  }
  const shownPage = viewed.kind === 'request' ? lastPage : viewed
  const pageTitle = shownPage ? titleOf(shownPage) : null
  const page: PageTab | undefined = shownPage && pageTitle ? {
    title: pageTitle, on: viewed.kind !== 'request',
    onOpen: () => ws.setView(shownPage),
    onClose: () => { setLastPage(null); ws.setView({ kind: 'request' }) },
  } : undefined
  const newFlow = async () => { const n = await ask('New flow', 'New flow'); if (n) { const f = await ws.addFlow(n); ws.setView({ kind: 'flow', id: f.id }) } }
  const dialogs = { ask, confirm, askNote, notify, pickPlace: (title: string, cur: { collectionId: string | null; folderId: string | null }) => askPlace(title, ws.collections, ws.folders, cur) }

  return (
    <div className="app">
      <header className="top">
        <button type="button" className="brand" title="Home" onClick={() => ws.setView({ kind: 'home' })}><img src="./icon.svg" alt="" width="26" height="26" />Dispatch</button>
        <label className="spacePick">
          <span className="sr">Workspace</span>
          <select aria-label="Workspace" value={ws.activeSpaceId} onChange={(e) => { if (e.target.value === '__manage') ws.setView({ kind: 'spaces' }); else ws.switchSpace(e.target.value) }}>
            {ws.spaces.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            <option value="__manage">Manage workspaces…</option>
          </select>
        </label>
        <button type="button" className="btn small" onClick={() => ws.startNew(ws.draft.collectionId, ws.draft.folderId)}>+ New request</button>
        <span className="grow" />
        <label className="envPick">
          <span className="sr">Environment</span>
          <select aria-label="Environment" value={ws.settings.activeEnvId ?? ''} onChange={(e) => ws.setSettings({ activeEnvId: e.target.value || null })}>
            <option value="">No environment</option>
            {ws.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        {layeredVars(ws.environment).map((v) => (
          <label key={v.id} className="layerPick" title={`Which ${v.key} to use`}>
            <span className="mono small">{v.key}</span>
            <select aria-label={`Alternative for ${v.key}`} value={v.active} onChange={(e) => { const env = ws.environment!; void ws.updateEnvironment({ ...env, variables: env.variables.map((x) => (x.id === v.id ? selectLayer(x, e.target.value) : x)) }) }}>
              {v.options!.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
            </select>
          </label>
        ))}
        <details className="menu">
          <summary className="btn small ghost" aria-label="Menu">☰</summary>
          <div className="menuList right" role="menu">
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); fileInput.current?.click() }}>Import (backup, Postman, OpenAPI, HAR)…</button>
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); brunoInput.current?.click() }}>Import a Bruno collection folder…</button>
            {ws.transport.unrestricted && <button type="button" role="menuitem" onClick={async (e) => {
              closeMenu(e)
              try {
                const dir = await desktopFolders.pick(); if (!dir) return
                const r = await openCollectionFolder(ws, desktopFolders, dir)
                notify(`Opened ${r.collections[0].name} from ${dir}; changes are saved back to the folder.${r.warnings.length ? ` ${r.warnings[0]}` : ''}`)
              } catch (err) { notify(String(err)) }
            }}>Open a collection folder…</button>}
            {ws.transport.unrestricted && <button type="button" role="menuitem" onClick={async (e) => {
              closeMenu(e)
              try { const dir = await desktopFolders.pick(); if (dir) notify(await openSpaceFolder(ws, desktopFolders, dir, confirm)) } catch (err) { notify(String(err)) }
            }}>Open a workspace folder…</button>}
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); void onExport() }}>Export backup</button>
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); ws.setView({ kind: 'backups' }) }}>Local backups…</button>
            <hr />
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); ws.setView({ kind: 'settings' }) }}>Settings…</button>
            {updatesAvailable() && <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); track('update_check'); void runUpdateCheck(notify, confirm) }}>Check for updates…</button>}
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); setFeedback(true) }}>Send feedback…</button>
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); setAbout(true) }}>About Dispatch…</button>
            {ws.transport.unrestricted && <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); ws.setView({ kind: 'cookies' }) }}>Cookies…</button>}
          </div>
        </details>
        <input ref={brunoInput} type="file" hidden {...{ webkitdirectory: '', directory: '' }} multiple aria-label="Bruno collection folder" onChange={async (e) => {
          const list = [...(e.target.files ?? [])].filter((f) => /\.(bru|json)$/.test(f.name)); e.target.value = ''
          if (!list.length) return
          try {
            const files = await Promise.all(list.map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, text: await readText(f) })))
            const r = importBruno(files)
            await ws.importWorkspace(r)
            notify(`Imported ${r.requests.length} requests and ${r.environments.length} environments from Bruno.${r.warnings.length ? ` ${r.warnings.slice(0, 2).join(' ')}` : ''}`)
          } catch (err) { notify(err instanceof Error ? err.message : String(err)) }
        }} />
        <input ref={fileInput} type="file" aria-label="Import file" accept="application/json,.json,.yaml,.yml,.har" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onImport(f) }} />
      </header>
      <Sidebar ws={ws} dialogs={dialogs} onExportCollection={(c) => void onExportCollection(c)} onExportPostman={(c) => void onExportPostman(c)} onShare={setSharing} />
      <main className="work">
        <TabBar ws={ws} onClose={(id) => void closeTab(id)} onMenu={tabMenu} page={page} />
        <div className="workBody">
        {viewed.kind === 'home' ? <HomeView ws={ws} onImport={() => fileInput.current?.click()} onNewFlow={() => void newFlow()} />
          : col ? <CollectionEditor key={col.id} ws={ws} confirm={confirm} collection={col} authActions={authActions} renderDocs={renderDocs} />
          : folder ? <FolderEditor key={folder.id} ws={ws} confirm={confirm} folder={folder} authActions={authActions} renderDocs={renderDocs} />
          : env ? <EnvironmentEditor key={env.id} ws={ws} confirm={confirm} environment={env} />
          : viewed.kind === 'globals' ? <GlobalsEditor ws={ws} />
          : viewed.kind === 'runner' ? <RunnerView key={`${viewed.collectionId}:${viewed.folderId}`} ws={ws} notify={notify} start={viewed.collectionId ? { collectionId: viewed.collectionId, folderId: viewed.folderId } : null} />
          : viewed.kind === 'flow' ? <FlowView key={viewed.id} ws={ws} flowId={viewed.id} notify={notify} confirm={confirm} />
          : viewed.kind === 'spaces' ? <SpacesView ws={ws} ask={ask} confirm={confirm} notify={notify} />
          : viewed.kind === 'schedules' ? <SchedulesView ws={ws} sched={sched} notify={notify} />
          : viewed.kind === 'settings' ? <SettingsView ws={ws} notify={notify} mcpHost={mcpHost} />
          : viewed.kind === 'cookies' ? <CookiesView ws={ws} notify={notify} />
          : viewed.kind === 'backups' ? <BackupsView ws={ws} notify={notify} confirm={confirm} />
          : viewed.kind === 'docs' ? <DocsView key={viewed.collectionId} ws={ws} notify={notify} collectionId={viewed.collectionId} />
          : viewed.kind === 'mock' ? <MockView key={viewed.collectionId} ws={ws} notify={notify} collectionId={viewed.collectionId} />
          : viewed.kind === 'load' ? <LoadView key={viewed.requestId ?? 'tab'} ws={ws} notify={notify} requestId={viewed.requestId} />
          : extraView ? extraView(ws, notify)
          : <>
              {ws.draft.protocol === 'http' ? (
                <SplitPane
                  first={<RequestPane ws={ws} onSave={save} onSaveAs={() => void saveAs()} notify={notify} authActions={authActions} renderDocs={renderDocs}
                    onShare={() => setSharing({ kind: 'request', requestId: ws.draft.id, draft: ws.draft, lastResponse: ws.result?.response ?? null })} />}
                  second={<ResponsePane ws={ws} notify={notify} saveFile={saveAnyFile}
                    onShare={() => setSharing({ kind: 'request', requestId: ws.draft.id, draft: ws.draft, lastResponse: ws.result?.response ?? null, open: 'response' })} />} />
              ) : (
                <div className="nonHttp">
                  <div className="titleRow request">
                    <ProtocolPicker draft={ws.draft} onChange={(protocol, url) => ws.setDraft((d) => ({ ...d, protocol, url }))} />
                    <input className="reqName" value={ws.draft.name} aria-label="Request name" onChange={(e) => ws.setDraft((d) => ({ ...d, name: e.target.value }))} />
                    {ws.dirty && <span className="dot" title="Unsaved changes" aria-label="Unsaved changes" />}
                    <span className="grow" />
                    <button type="button" className="btn ghost" onClick={() => void saveAs()} title="Save a copy under a new name or place (Ctrl+Shift+S)">Save as…</button>
                    <button type="button" className="btn ghost" onClick={() => void save()}>Save <kbd>Ctrl S</kbd></button>
                  </div>
                  {ws.draft.protocol === 'grpc' ? <GrpcPane ws={ws} notify={notify} />
                    : ws.draft.protocol === 'browser' ? <BrowserPane ws={ws} notify={notify} />
                    : ws.draft.protocol === 'mcp' ? <McpPane key={ws.draft.id} ws={ws} notify={notify} confirm={confirm} ask={ask} />
                    : <RealtimePane key={ws.draft.id} ws={ws} notify={notify} />}
                </div>
              )}
            </>}
        </div>
      </main>
      {consoleOpen && <Console ws={ws} onClose={() => setConsoleOpen(false)} />}
      <footer className="statusBar small">
        <button type="button" className="linkBtn" aria-expanded={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>
          Console{ws.logs.some((l) => l.level === 'error') ? ' ⚠' : ''} ({ws.logs.length})
        </button>
        <span>{ws.transport.unrestricted ? 'Desktop: sends directly, no CORS limits' : 'Browser: servers must allow this page (CORS)'}</span>
        <span className="grow" />
        <span>{ws.environment ? `Environment: ${ws.environment.name}` : 'No environment'}</span>
        <span>Saved on this device only</span>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.action && <button type="button" className="toastAction" onClick={() => { toast.action!.run(); setToast(null) }}>{toast.action.label}</button>}
          <button type="button" className="toastClose" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}
      {dialog}
      {ctx.node}
      {sharing && <ShareDialog ws={ws} target={sharing} onClose={() => setSharing(null)} notify={notify} />}
      {feedback && <FeedbackDialog onClose={() => setFeedback(false)} />}
      {about && <AboutDialog onClose={() => setAbout(false)} notify={notify} />}
      {!ws.settings.telemetryAsked && telemetryOffered() && <ConsentDialog onDone={(c) => ws.setSettings({ telemetryAsked: true, ...c })} />}
    </div>
  )
}
