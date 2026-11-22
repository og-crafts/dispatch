import { useState } from 'react'
import { ASSISTANT_SPACE, DEFAULT_SPACE, type Space, spaceOf } from '../core/types'
import type { FolderStatus, WorkspaceApi } from './useWorkspace'
import { FolderIssues } from './FolderIssues'
import { PassphraseDialog } from './PassphraseDialog'

/** True when a linked folder has files waiting for a choice. */
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const needsChoice = (st?: FolderStatus) => !!st && !!(st.conflicts.length || st.copies?.length || st.strays?.length || st.unreadable?.length)

/** Add, rename and remove workspaces (groups of collections, environments and flows), and link them to folders. */
export function SpacesView({ ws, ask, confirm, notify }: { ws: WorkspaceApi; ask: (t: string, initial?: string) => Promise<string | null>; confirm: (m: string) => Promise<boolean>; notify: (m: string) => void }) {
  const desktop = ws.transport.unrestricted
  const [busy, setBusy] = useState(false)
  const [pass, setPass] = useState<{ mode: 'new' | 'unlock' | 'change'; space: Space } | null>(null)
  const run = (fn: () => Promise<string | void>) => async () => {
    if (busy) return
    setBusy(true)
    try { const m = await fn(); if (m) notify(m) } catch (e) { notify(String(e)) } finally { setBusy(false) }
  }
  const dirs = () => import('./linkedDirs')
  // MCP assistants run in the desktop app; the column shows once their own workspace is on (Settings → AI assistants).
  const showAi = desktop && ws.settings.mcpHostWorkspace
  const toggleAi = (x: Space) => run(async () => {
    if (!x.aiEdit && !await confirm(`Let AI assistants edit “${x.name}”? While it’s the open workspace they can create, change, move and remove requests, set collection variables, and change pre-request and test scripts on requests, folders and collections. Scripts run when you send, and can read your environment’s values, including secrets, so only allow assistants you trust. Removed requests go to the trash, so you can undo them; other changes can’t be undone.`)) return
    await ws.setSpaceAi(x.id, !x.aiEdit)
    return x.aiEdit ? `AI assistants can only list and send in “${x.name}” again.` : `AI assistants can now edit “${x.name}” while it’s open.`
  })
  const link = (x: Space) => run(async () => {
    const { desktopFolders, linkSpace } = await dirs()
    const dir = await desktopFolders.pick(); if (!dir) return
    return linkSpace(ws, desktopFolders, x, dir, confirm)
  })
  const useFolder = (x: Space) => run(async () => {
    const { desktopFolders, reloadSpace } = await dirs()
    const warnings = await reloadSpace(ws, desktopFolders, x)
    return `Read “${x.name}” from ${x.linkedDir}. A backup was taken first.${warnings.length ? ` ${warnings.length} note${warnings.length > 1 ? 's' : ''}: ${warnings[0]}` : ''}`
  })
  // Secrets that travel with the folder: start (or unlock, when the folder already has the file), change, stop.
  const startSecrets = (x: Space) => run(async () => {
    const { desktopFolders } = await dirs()
    setPass({ mode: (await desktopFolders.readVault?.(x.linkedDir!)) ? 'unlock' : 'new', space: x })
  })
  const stopSecretsFor = (x: Space) => run(async () => {
    if (!await confirm(`Stop syncing secrets for “${x.name}” on this computer? Its secret values stay here; the encrypted file stays in the folder for other computers.`)) return
    const { stopSecrets } = await dirs()
    return stopSecrets(ws, x)
  })
  const resolveSecrets = (x: Space, side: 'folder' | 'mine') => run(async () => { const { desktopFolders, resolveVault } = await dirs(); return resolveVault(ws, desktopFolders, x, side) })
  const secretsRow = (x: Space) => {
    const v = ws.folderStatus[`space:${x.id}`]?.vault
    return <div className="spaceSecrets">
      {!x.syncSecrets ? <>
        <span className="muted">Secret values stay on this computer.</span>
        <span className="actions"><button type="button" className="btn small ghost" disabled={busy} onClick={startSecrets(x)}>Sync secrets…</button></span>
      </> : v?.state === 'locked' ? <>
        <span className="folderState warn">{v.note}</span>
        <span className="actions">
          <button type="button" className="btn small" disabled={busy} onClick={() => setPass({ mode: 'unlock', space: x })}>Enter passphrase…</button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={stopSecretsFor(x)}>Stop syncing secrets</button>
        </span>
      </> : v?.state === 'conflict' ? <>
        <span className="folderState warn">{v.note}</span>
        <span className="actions">
          <button type="button" className="btn small" disabled={busy} onClick={resolveSecrets(x, 'folder')}>Use the folder’s</button>
          <button type="button" className="btn small" disabled={busy} onClick={resolveSecrets(x, 'mine')}>Keep mine</button>
        </span>
      </> : v?.state === 'error' ? <>
        <span className="folderState bad">{v.note}</span>
        <span className="actions"><button type="button" className="btn small ghost" disabled={busy} onClick={stopSecretsFor(x)}>Stop syncing secrets</button></span>
      </> : <>
        <span className="folderState" title="secrets.dispatch-vault, encrypted with your passphrase">Secrets synced, encrypted</span>
        <span className="actions">
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => setPass({ mode: 'change', space: x })}>Change passphrase…</button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={stopSecretsFor(x)}>Stop syncing secrets</button>
        </span>
      </>}
    </div>
  }
  const unlink = (x: Space) => run(async () => {
    const { unlinkSpace } = await dirs()
    await unlinkSpace(ws, x)
    return `Unlinked “${x.name}”; the files stay where they are.`
  })

  return (
    <section className="editor" aria-label="Workspaces">
      {pass && <PassphraseDialog mode={pass.mode} workspace={pass.space.name} onClose={(m) => { setPass(null); if (m) notify(m) }}
        run={async (p) => {
          const d = await dirs()
          return pass.mode === 'change' ? d.changePassphrase(ws, d.desktopFolders, pass.space, p) : d.turnOnSecrets(ws, d.desktopFolders, pass.space, p)
        }} />}
      <h1 className="titleInput">Workspaces</h1>
      <p className="muted small">Group collections, environments and flows, e.g. one workspace per product or client. Switch from the top bar. Globals and history are shared by all workspaces. To move a collection or environment, use its ⋯ menu.</p>
      <ul className="spaceCards" aria-label="Workspaces list">
        {ws.spaces.map((x) => {
          const cols = ws.allCollections.filter((c) => spaceOf(c) === x.id).length
          const envs = ws.allEnvironments.filter((e) => spaceOf(e) === x.id).length
          const flows = ws.allFlows.filter((f) => spaceOf(f) === x.id).length
          const st = ws.folderStatus[`space:${x.id}`]
          const open = x.id === ws.activeSpaceId
          return (
            <li key={x.id} className={`spaceCard${open ? ' on' : ''}`} aria-label={x.name}>
              <div className="spaceHead">
                <b className="spaceName">{x.name}</b>{open && <span className="pill">open</span>}
                <span className="muted small">{count(cols, 'collection')} · {count(envs, 'environment')} · {count(flows, 'flow')}</span>
                <span className="spaceActions">
                  {!open && <button type="button" className="btn small" onClick={() => ws.switchSpace(x.id)}>Open</button>}
                  <button type="button" className="btn small ghost" onClick={async () => { const n = await ask('Rename workspace', x.name); if (n) await ws.renameSpace(x.id, n) }}>Rename</button>
                  {x.id !== DEFAULT_SPACE.id && <button type="button" className="btn small ghost danger" onClick={async () => {
                    notify((await ws.removeSpace(x.id)) ? `Removed ${x.name}.` : `Move or delete ${x.name}’s collections and environments first.`)
                  }}>Remove</button>}
                </span>
              </div>
              {desktop && <div className="spaceFolder">
                {x.linkedDir ? <>
                  <span className="spaceFolderPath"><span className="muted">Folder</span> <code>{x.linkedDir}</code></span>
                  {st?.error ? <span className="folderState bad">Couldn’t write: {st.error}</span>
                    : needsChoice(st) ? <span className="folderState warn">Needs your choice</span>
                    : st ? <span className="folderState">In step</span> : null}
                  <span className="actions">
                    <button type="button" className="btn small ghost" disabled={busy} onClick={useFolder(x)} title="Make this workspace exactly what the folder holds (a backup is taken first)">Reload from folder</button>
                    <button type="button" className="btn small ghost" disabled={busy} onClick={unlink(x)}>Unlink</button>
                  </span>
                </> : <>
                  <span className="muted">Not kept in a folder.</span>
                  <span className="actions"><button type="button" className="btn small ghost" disabled={busy} onClick={link(x)}>Link to a folder…</button></span>
                </>}
              </div>}
              {desktop && x.linkedDir && secretsRow(x)}
              {x.linkedDir && needsChoice(st) && <FolderIssues ws={ws} statusKey={`space:${x.id}`} dir={x.linkedDir} notify={notify} />}
              {showAi && <div className="spaceAi small">
                {x.id === ASSISTANT_SPACE.id
                  ? <span className="muted">AI assistants’ own workspace.</span>
                  : <label className="check"><input type="checkbox" checked={!!x.aiEdit} disabled={busy} onChange={toggleAi(x)} aria-label={`AI assistants can edit ${x.name}`} /> AI assistants can edit this workspace</label>}
              </div>}
            </li>
          )
        })}
      </ul>
      <div className="actions">
        <button type="button" className="btn primary" onClick={async () => { const n = await ask('New workspace'); if (n) { const sp = await ws.addSpace(n); ws.switchSpace(sp.id) } }}>+ New workspace</button>
        {desktop && <button type="button" className="btn" disabled={busy} onClick={run(async () => {
          const { desktopFolders, openSpaceFolder } = await dirs()
          const dir = await desktopFolders.pick(); if (!dir) return
          return openSpaceFolder(ws, desktopFolders, dir, confirm)
        })}>Open a workspace folder…</button>}
      </div>
      {showAi && <p className="muted small"><b>AI can edit</b>: besides their own “{ASSISTANT_SPACE.name}” workspace, AI assistants may create, change, move and delete requests, set collection variables, and change pre-request and test scripts in a ticked workspace while it’s the open one. Scripts run when you send and can read your environment, secrets included. Unticked workspaces stay list-and-send.</p>}
      <p className="muted small">
        {desktop
          ? <>A workspace linked to a folder is kept there as plain files, one per request, environment and flow, ready for git. History and schedules stay on this device; secret values too, unless you turn on Sync secrets (they then travel encrypted with a passphrase). Keep the folder in OneDrive, Dropbox, iCloud Drive or Syncthing, or in a git repo, to have the workspace on your other computers: changes made there come in on their own. If a file changed both there and here, Dispatch overwrites neither and asks which version to keep.</>
          : <>Linking a workspace to a folder of files needs the desktop app.</>}
      </p>
    </section>
  )
}
