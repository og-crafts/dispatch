import { useState } from 'react'
import type { WorkspaceApi } from './useWorkspace'
import { Diff } from './ResponseHistory'

/**
 * What needs a person's choice in a linked folder (docs/DESIGN-linked-workspaces.md, phase 2): files changed both in
 * the folder and in the app, copies a cloud drive made, and files that can't be read. Each file gets its own
 * choice; nothing is overwritten or deleted until the person picks.
 */
export function FolderIssues({ ws, statusKey, dir, notify }: { ws: WorkspaceApi; statusKey: string; dir: string; notify: (m: string) => void }) {
  const st = ws.folderStatus[statusKey]
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<{ path: string; mine: string | null; theirs: string | null; copyOf?: string | null } | null>(null)
  if (!st) return null
  const conflicts = st.conflicts, copies = st.copies ?? [], strays = st.strays ?? [], unreadable = st.unreadable ?? []
  if (!conflicts.length && !copies.length && !strays.length && !unreadable.length) return null
  const dirs = () => import('./linkedDirs')
  const run = (fn: () => Promise<string | void>) => async () => {
    if (busy) return
    setBusy(true)
    try { const m = await fn(); if (m) notify(m); setDiff(null) } catch (e) { notify(String(e)) } finally { setBusy(false) }
  }
  const take = (path: string) => run(async () => { const d = await dirs(); await d.takeFile(ws, d.desktopFolders, statusKey, path); return `Took ${path} from the folder.` })
  const mine = (path: string, what = `Wrote this device’s version of ${path}.`) => run(async () => { const d = await dirs(); await d.keepMineFile(d.desktopFolders, statusKey, dir, path); return what })
  const show = (path: string, copy = false) => async () => {
    if (diff?.path === path) { setDiff(null); return }
    try {
      const d = await dirs()
      const copyOf = copy ? await d.originalOf(d.desktopFolders, dir, path) : undefined
      const v = await d.fileVersions(ws, d.desktopFolders, statusKey, path, copyOf ?? undefined)
      setDiff({ path, ...v, copyOf })
    } catch (e) { notify(String(e)) }
  }
  const diffBox = (path: string) => diff?.path === path && <div className="folderDiff">
    <p className="muted small">{diff.copyOf ? <>Lines marked − are in <code>{diff.copyOf}</code>, lines marked + only in the copy.</>
      : <>Lines marked − are this device’s version, lines marked + the folder’s.</>}
    {diff.mine === null && ' This device doesn’t have it.'}{diff.theirs === null && ' The folder doesn’t have it any more.'}</p>
    <Diff a={diff.mine ?? ''} b={diff.theirs ?? ''} />
  </div>

  return (
    <div className="note warn small folderIssues" role="status">
      {!!conflicts.length && <>
        <p><b>{conflicts.length} file{conflicts.length > 1 ? 's' : ''} changed both in the folder and in Dispatch.</b> Neither version was overwritten. Choose one for each:</p>
        <ul className="folderFiles" aria-label="Files changed in both places">
          {conflicts.map((p) => <li key={p}>
            <code>{p}</code>
            <span className="actions">
              <button type="button" className="btn small" disabled={busy} onClick={take(p)}>Use the file’s version</button>
              <button type="button" className="btn small" disabled={busy} onClick={mine(p)}>Keep mine</button>
              <button type="button" className="btn small ghost" aria-expanded={diff?.path === p} onClick={show(p)}>Show differences</button>
            </span>
            {diffBox(p)}
          </li>)}
        </ul>
      </>}
      {!!unreadable.length && <>
        <p><b>{unreadable.length} file{unreadable.length > 1 ? 's' : ''} can’t be read</b> (unfinished git merge?). Dispatch keeps its own version and won’t write over {unreadable.length > 1 ? 'them' : 'it'} until {unreadable.length > 1 ? 'they' : 'it'} can be read again:</p>
        <ul className="folderFiles" aria-label="Files that can't be read">
          {unreadable.map((u) => <li key={u.path}>
            <code>{u.path}</code> <span className="badText">{u.error}</span>
            <span className="actions"><button type="button" className="btn small" disabled={busy} onClick={mine(u.path)}>Write mine over it</button></span>
          </li>)}
        </ul>
      </>}
      {!!copies.length && <>
        <p><b>{copies.length} cop{copies.length > 1 ? 'ies' : 'y'} of a file</b>, probably made by a cloud drive when the file changed on two computers. Dispatch doesn’t read copies. Compare, copy anything you need into Dispatch, then delete the copy:</p>
        <ul className="folderFiles" aria-label="Copies of files">
          {copies.map((p) => <li key={p}>
            <code>{p}</code>
            <span className="actions">
              <button type="button" className="btn small ghost" aria-expanded={diff?.path === p} onClick={show(p, true)}>Show differences</button>
              <button type="button" className="btn small danger" disabled={busy} onClick={mine(p, `Deleted the copy ${p}.`)}>Delete the copy</button>
            </span>
            {diffBox(p)}
          </li>)}
        </ul>
      </>}
      {!!strays.length && <p>
        <b>{strays.length} more cop{strays.length > 1 ? 'ies' : 'y'}</b> Dispatch can’t read: <code>{strays.slice(0, 3).join(', ')}{strays.length > 3 ? ', …' : ''}</code>. Open {strays.length > 1 ? 'them' : 'it'} in an editor, move what you need into Dispatch, then delete {strays.length > 1 ? 'them' : 'it'}.
      </p>}
    </div>
  )
}
