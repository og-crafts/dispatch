import { statusTone, timeAgo } from '../core/format'
import { Icon } from './Icons'
import type { WorkspaceApi } from './useWorkspace'

/** The path and query, without scheme and host (the full URL is in the tooltip). */
const pathOf = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i, '') || url
const short = (m: string) => (m === 'DELETE' ? 'DEL' : m === 'OPTIONS' ? 'OPT' : m)

/** Where the app starts from the rail or the logo: what's here, what you did last, and the common first steps. */
export function HomeView({ ws, onImport, onNewFlow }: { ws: WorkspaceApi; onImport: () => void; onNewFlow: () => void }) {
  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const space = ws.spaces.find((x) => x.id === ws.activeSpaceId)?.name ?? 'Workspace'
  const colIds = new Set(ws.collections.map((c) => c.id))
  const saved = ws.requests.filter((r) => r.collectionId && colIds.has(r.collectionId)).length
  const recent = ws.history.slice(0, 8)
  const tabs = ws.tabs

  return (
    <section className="home" aria-label="Home">
      <header className="homeHero">
        <p className="eyebrow">{space}</p>
        <h1>{greeting}</h1>
        <p className="muted">
          {saved} saved request{saved === 1 ? '' : 's'} in {ws.collections.length} collection{ws.collections.length === 1 ? '' : 's'}
          {ws.environment ? <> · environment <b>{ws.environment.name}</b></> : ' · no environment selected'}
        </p>
        <div className="homeActions">
          <button type="button" className="btn primary" onClick={() => ws.startNew()}><Icon name="plus" size={16} />New request</button>
          <button type="button" className="btn" onClick={onImport}><Icon name="import" size={16} />Import</button>
          <button type="button" className="btn" onClick={onNewFlow}><Icon name="flows" size={16} />New flow</button>
          <button type="button" className="btn" onClick={() => ws.setView({ kind: 'runner', collectionId: null, folderId: null })}><Icon name="runner" size={16} />Run a collection</button>
        </div>
      </header>

      <div className="homeGrid">
        <section className="card" aria-labelledby="home-recent">
          <h2 id="home-recent">Recently sent</h2>
          {recent.length ? (
            <ul className="homeList">
              {recent.map((h) => (
                <li key={h.id}>
                  <button type="button" className="homeItem" onClick={() => ws.openHistory(h)} title={h.sent.url}>
                    <span className={`mtag m-${h.sent.method}`}>{short(h.sent.method)}</span>
                    <span className="homeItemText mono">{pathOf(h.sent.url)}</span>
                    <span className={`hstat ${h.response ? statusTone(h.response.status) : 'bad'}`}>{h.response ? h.response.status : '—'}</span>
                    <span className="muted tiny">{timeAgo(h.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">Requests you send show up here.</p>}
        </section>

        <section className="card" aria-labelledby="home-tabs">
          <h2 id="home-tabs">Pick up where you left off</h2>
          {tabs.length ? (
            <ul className="homeList">
              {tabs.map((t) => (
                <li key={t.id}>
                  <button type="button" className="homeItem" onClick={() => ws.selectTab(t.id)} title={t.draft.url}>
                    <span className={`mtag m-${t.draft.method}`}>{short(t.draft.method)}</span>
                    <span className="homeItemText">{t.draft.name}</span>
                    {ws.isDirty(t.draft) && <span className="dot" title="Unsaved changes" />}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">No open requests. Start one with New request, or pick a saved one from Collections.</p>}
        </section>
      </div>

      <section aria-labelledby="home-cols">
        <h2 id="home-cols" className="homeSub">Collections</h2>
        {ws.collections.length ? (
          <div className="colGrid">
            {ws.collections.map((c) => {
              const n = ws.requests.filter((r) => r.collectionId === c.id).length
              const f = ws.folders.filter((x) => x.collectionId === c.id).length
              return (
                <div key={c.id} className="colCard">
                  <button type="button" className="colCardMain" onClick={() => ws.setView({ kind: 'collection', id: c.id })} title={c.name}>
                    <span className="colIcon" aria-hidden="true"><Icon name="collections" size={18} /></span>
                    <span className="colName">{c.name}</span>
                    <span className="muted small">{n} request{n === 1 ? '' : 's'}{f ? ` · ${f} folder${f === 1 ? '' : 's'}` : ''}</span>
                  </button>
                  <div className="colCardActions">
                    <button type="button" className="btn small ghost" onClick={() => ws.startNew(c.id)}>New request</button>
                    <button type="button" className="btn small ghost" onClick={() => ws.setView({ kind: 'runner', collectionId: c.id, folderId: null })}>Run</button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : <p className="muted small">No collections yet. Save a request, or import a Postman collection, OpenAPI file or HAR.</p>}
      </section>
    </section>
  )
}
