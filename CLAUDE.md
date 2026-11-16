# CLAUDE.md — dispatch

Dispatch is OGCrafts' local-first API client: a React + TypeScript web app (`src/`) wrapped in a Tauri 2
desktop shell (`src-tauri/`). Same UI everywhere; only the transport differs (`src/core/transport.ts`).

It's our own app with its own name and look (own palette, inherited from the OneLifeStack apps). Postman is only a reference for the feature set
and an import format; never copy its name, branding, icons or UI.

## Layout

- `src/core/` — logic with no React, shared by the app and the CLI:
  - model and storage: `types.ts`, `db.ts` (IndexedDB v4; records normalized on read), `backup.ts` (Dispatch backup,
    Postman), `openapi.ts` (OpenAPI/Swagger/HAR)
  - building and sending: `vars.ts` + `fake.ts` ({{variables}}), `url.ts`, `prepare.ts` (variables + auth + body),
    `runtime.ts` (`execute`: the one pipeline everything uses), `auth.ts` (JWT, AWS SigV4, Digest, OAuth 2),
    `transport.ts` (fetch / Tauri / cookie jar), `cookies.ts`
  - scripts: `scripts.ts` (pm API, chai), `scriptPipeline.ts` (collection → folders → request order),
    `scriptWorker.ts` + `workerEngine.ts` (sandboxed Web Worker per script)
  - running: `runner.ts` (collections/suites/data, JUnit), `load.ts` (load tests), `csv.ts`
  - other: `codegen.ts` (12 languages), `curl.ts`, `docs.ts`, `mock.ts`, `graphql.ts`, `jsonpath.ts`, `format.ts`
  - v0.3: `vault.ts` (secrets at rest), `interop.ts` (Postman export, Insomnia/Bruno import), `fileFormat.ts`
    (collections as files), `schedules.ts`, `sse.ts`, `diff.ts`, `scriptLibs.ts` (require'able libraries)
  - browser logins: `cdp.ts` (minimal DevTools-protocol client), `browser.ts` (steps, launcher interface),
    `browserPipeline.ts` (the `Pipeline.browser` hook); launchers in `src/node/browserLauncher.ts` (CLI) and
    `src/ui/desktopBrowser.ts` (Tauri `browser_launch`)
  - `mcpAuth.ts`: MCP sign-in (discovery → registration → PKCE + `resource` → refresh), `MCP_SUGGESTIONS`; sign-ins
    sealed in IndexedDB meta `mcpSignIns`, keyed by environment + server. `examples/mcp-http-server.mjs --oauth` is
    a complete local sign-in server for tests and the Windows guide.
  - `mcpHandler.ts`: the MCP tools (list_requests, send_request, run_collection, run_flow; with `workspace` set, create/update/copy/delete_request in the assistant's own workspace, see `mcpWorkspace.ts`), one JSON-RPC message
    in, one reply out; shared by `dispatch-run mcp` (stdio, first collection) and the desktop app's local MCP
    endpoint (every collection in the active workspace, with hooks that save script/token changes like Send does).
  - `flows.ts`: flow graph (nodes, wires from output ports) and `runFlow`; straight chains run in a loop, recursion
    only for branches and For each (deep recursion overflowed the stack). Stored in IndexedDB v4 `flows`.
- `src/ui/` — `useWorkspace.ts` holds all state and actions; one component per view (RequestPane, ResponsePane,
  RunnerView, LoadView, DocsView, MockView, RealtimePane for WebSocket/MQTT/SSE/Socket.IO, GrpcPane, Editors,
  SettingsView/CookiesView, BackupsView, Schedules, ResponseHistory…). `editor/codemirror.ts` is the lazy editor;
  `CodeArea` falls back to a textarea in jsdom. `linkedDirs.ts` syncs collections to folders.
- App shell: `Sidebar.tsx` is a nav rail (Home, the four library sections as tabs, Runner/Load test/Schedules,
  Workspaces, Settings) plus a library panel that folds (pick the open section again) and resizes (edge handle in
  the gap, arrow keys; width in localStorage `dispatch.sideWidth`). Pages open as one extra tab in the tab bar
  (`TabBar` `page`), so requests are one click away. `HomeView.tsx` is the Home page; `Icons.tsx` the line icons.
  Look: tokens at the top of `app.css` (light + dark), the aurora is `body::before`, panels are frosted glass
  (`--surface` + backdrop-filter); the "Look" section at the end of `app.css` overrides the older rules.
- Share as HTML: `core/share.ts` builds sanitized data (Sanitizer: secret-named values, JWT/bearer/AWS keys,
  emails, IPs, server address → `{{baseUrl}}`, sampled lists; variables stay `{{name}}`), `core/shareHtml.ts`
  renders one self-contained page (CSP, data embedded as JSON, DOM built with textContent). `ui/ShareDialog.tsx`
  asks for title/version/author/contact/description. Entry points: request Share button, request/folder/collection menus.
- Opt-in usage (Aptabase) and error reports (Sentry), feedback: `src/ui/telemetry.ts` (consent-gated `track()`,
  `redact()`/`scrubEvent()`), `src/ui/PrivacyDialogs.tsx` (first-launch question, Send feedback). Keys come from
  `VITE_APTABASE_APP_KEY` / `VITE_SENTRY_DSN` at build time; without them nothing is offered. Rules and set-up:
  `docs/TELEMETRY.md`. Never put user content in an event.
- `src/ui/FlowView.tsx` — the flow canvas (absolutely placed blocks, SVG wires, pointer drag; every wire can also
  be set from the side panel's “Then go to” selects, which is what keyboard users and tests use).
- `src/cli/main.ts` — `dispatch-run` (run, `load`, `mock`, `mcp`, `flow`); bundled by `scripts/build-cli.mjs`.
- `src-tauri/src/lib.rs` — send/cancel (proxy, mTLS, CA certs), save files, open URL, OAuth loopback, mock server
  sockets, SSE streams, notifications, collection folders (pick/read/write);
  `grpc.rs` — gRPC (tonic + prost-reflect + protox); `mcp_host.rs` — local MCP endpoint (127.0.0.1 only,
  bearer token, refuses Origin and foreign Host headers, POST only) that relays JSON-RPC to the frontend
  (`src/ui/mcpHost.ts`, turned on in Settings → AI assistants).
- `tests/` — vitest (jsdom; `cli.test.ts` builds and runs the real CLI in Node). `src-tauri/tests/grpc_live.rs` —
  live gRPC test (needs `examples/grpc`); `network_live.rs` — mTLS/proxy (needs `examples/tls`);
  `collection_files.rs` — folder write/prune/escape.
- `examples/` — demo API, demo collection, data file, gRPC test server.

## Commands

Tool calls don't load `~/.bashrc`, so put node and cargo on PATH first:

    export PATH=~/.local/node/bin:~/.cargo/bin:$PATH

- `npm test` — all tests (watch the "Test Files" line too: a file that fails to load doesn't show in the count). `npm run typecheck`. `npm run build` — web build in `dist/` (relative base, so it works
  under any path, e.g. `/app/`).
- `npm run dev` — web dev server on :5173.
- `npm run build:cli` — `dist-cli/dispatch-run.mjs`.
- `npm run tauri dev` — desktop app with hot reload. `npm run tauri build` — `.deb` and AppImage in
  `src-tauri/target/release/bundle/`.

Installers for every OS come from GitHub Actions (`.github/workflows/build.yml`), not this machine: each push or PR
builds Windows (`.msi`, NSIS `.exe`), Linux (`.deb`, `.rpm`, AppImage) and macOS (`.dmg`) as run artifacts. To
release: bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, push a tag
`vX.Y.Z`, and the installers land on a draft GitHub Release to review and publish. The installers aren't code-signed
yet (Windows SmartScreen and macOS Gatekeeper will warn).

Desktop builds on Linux need these system packages (owner installs them; sudo isn't available to Claude):

    sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libsoup-3.0-dev \
      libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev

Rust is user-space via rustup in `~/.cargo` (not on PATH by default).

Installer artwork (`src-tauri/installer/`) is generated by `scripts/make-installer-art.mjs`; see `docs/RELEASING.md`.

## Visual check without a desktop

`vite preview` + Playwright from `~/projects/github-tools/rea/node_modules/playwright-core` with the headless
shell in `~/.cache/ms-playwright/chromium_headless_shell-1148`. It needs `libasound.so.2`, which isn't installed:
unpack it from `apt-get download libasound2t64` with `dpkg-deb -x` and set `LD_LIBRARY_PATH`.

## Gotchas

- `pkill -f <pattern>` in a tool call also matches the tool's own shell command and kills it; stop test servers by
  PID instead.
- The `mqtt` browser bundle exposes `connect` on the default export (see RealtimePane).
- The CLI bundle needs `require()` for CommonJS dependencies (yaml); `scripts/build-cli.mjs` provides it.
- gRPC reflection servers may omit imports or send well-known types under their own file names; `grpc.rs` handles
  both (found with the grpc-js reflection server).
- Keep collection order: requests and folders share a `sort` position; never sort runs by name.
- Run `npm run build` before committing, not just tests: a worker-format change once passed tests but broke the
  build. The script worker must stay `worker: { format: 'es' }`.
- CodeMirror and React: never push a value the editor itself emitted back into it (CodeArea tracks emitted values).
- Port 4321 is taken on this machine by another app; use other ports for test servers.
- Tauri commands can't also be `pub` at the crate root; expose a separate pub function for tests.
- Browser-login tests use Playwright's Chromium with `DISPATCH_BROWSER_ARGS=--no-sandbox` (AppArmor blocks its
  sandbox here). Never add `--no-sandbox` by default.
- A `<select>` inside a `<label>` gets its options in its accessible name; give it an `aria-label`.
- Never push to `main` without `npm run typecheck`: vitest passes code that the CI typecheck rejects (this happened
  once with a readonly tuple in a test).
- Desktop webview ↔ Chrome DevTools: Chrome refuses WebSocket connections that send an `Origin` header unless that
  origin is allowed with `--remote-allow-origins`. The desktop launcher passes exactly `location.origin`.
- Windows: Rust's `Command::new` only looks for `.exe` (use `resolve_command` for `npx`/`npm`), and child processes
  need `CREATE_NO_WINDOW` (`no_console`). `shellWords` keeps a backslash before an ordinary character, for Windows
  paths.
- Don't `npx` remote packages from tool calls; that's blocked here. Local examples (`examples/*.mjs`) cover MCP.
- MCP sign-in redirects to `http://127.0.0.1:33418/callback`, which a registered client is bound to; tests use 33419.

## Where we left off

Updated 2026-11-16. **Versioning restarted at v0.1.0** (see Releases below); until v0.1.0 is published, the old v0.5.1 numbers in these notes refer to deleted preview releases.
`main` (52b2630) is ahead of it, untagged: PRs #6 (local MCP endpoint), #7 (drag and drop), #8 (docs), #10 (branded
installers), the OGCrafts move (#12, #13, #14), and from 2026-11-16 #16 (MCP: the assistant's own workspace), #17
(UX refresh: nav rail, resizable panels, Home, glass look, Settings tabs, Save as…) and #18 (Share as HTML). No PRs
are open. **The 0.5.1 installers were built before the move: they still use bundle ID `com.onelifestack.dispatch`
and publisher OneLifeStack.** The next release (0.5.2 or 0.6.0) is the first with `cloud.ogcrafts.dispatch`; it
installs as a separate app, so 0.5.1 users reinstall once.

**Desktop check on Windows (2026-11-16, Claude over SSH, build of main 52b2630).** Run on the owner's Predator
(Windows 11, WebView2 157) from the CI `dispatch-windows` artifact, MSI unpacked with `msiexec /a` (no install), so
the installed 0.5.1 stayed untouched. Passed: new layout renders; Home; a real send (200, no CORS); Save to a new
collection; Save as… on an edited saved request (copy gets the edit, original keeps its last save); library panel
drag, arrow keys (when focused), width remembered across reload; request/response divider drag and double-click
reset; rail folds and reopens the library; Settings tabs; MCP endpoint starts, refuses no token (401), Origin (403),
foreign Host (403), GET (401); all #16 tools (create, update, send, copy, delete own; update/delete of a user
request refused with the copy_request hint; POST refused under GET,HEAD); the "AI assistant" workspace shows what
the assistant made; Share dialog opens with `{{baseUrl}}` and the secret check. Not covered: the native save dialog
behind "Save HTML file", drag and drop, installers, scaling/monitors. Small findings (not filed):
- The rail label "Environments" is cut off ("Environm…").
- Home's "Pick up where you left off" says no open requests while a blank New request tab is open.
- Opening a request from the tree closes the Settings page tab (maybe intended: pages are one transient tab).
- The request title above the URL is clipped without an ellipsis.
- Switching workspace keeps the other workspace's request tabs open.
- copy_request on a request with no auth says "its inherited none auth was copied onto it".
- The Share dialog counts 0 sample responses for a request just sent through MCP.
How it was driven, for next time: run the exe in the owner's desktop session via a temporary scheduled task (a
`.bat` that sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` then starts it; the owner must
be logged in), `ssh -L 19222:127.0.0.1:9222` and drive it over CDP (`Runtime.evaluate`, `Input.dispatchMouseEvent`,
`Input.insertText`, `Page.captureScreenshot`); MCP via `ssh -L 14320:127.0.0.1:4320` with `Host: 127.0.0.1:4320`.
Afterwards stop the exe, unregister the task, and delete `%LOCALAPPDATA%\cloud.ogcrafts.dispatch` so a later real
install starts clean.

**Moved to OGCrafts (2026-11-14).** Dispatch is no longer an OneLifeStack app. Home: GitHub org
`og-crafts` (a free org; admin login `og-crafterr`). Repo `og-crafts/dispatch` (transferred, so issues, PRs and the
v0.5.1 release came with it); site repo `og-crafts/dispatch-site` (Pages, custom domain `dispatch.ogcrafts.cloud`,
HTTPS enforced); Cloudflare CNAME `dispatch -> og-crafts.github.io` (DNS only). Bundle ID is now
`cloud.ogcrafts.dispatch`; backups are written as `ogcrafts-dispatch` and the old `onelifestack-dispatch` name still
imports (`LEGACY_FORMATS` in `src/core/backup.ts`). Contact: hello@ogcrafts.cloud. Commits here use the
`og-crafterr` noreply address (`356532942+og-crafterr@users.noreply.github.com`), not the OneLifeStack one.
`gh` has three logins: use `gh auth switch` or `GH_TOKEN=$(gh auth token --user NAME)` for the right one.
The old `onelifestack/dispatch-site` is left unpublished (custom domain removed); the archive repo stays under
`onelifestack`. Dispatch was removed from developer.onelifestack.com. The next release (0.5.2 or 0.6.0) is the first
under the new bundle ID. The installer art was rebuilt with the OGCrafts text on 2026-11-16 (`scripts/make-installer-art.mjs`; it needs
`CHROMIUM=~/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell` and libasound, see
"Visual check without a desktop").

**The repo is public (MIT) since 2026-11-05.** GitHub billing blocked Actions on the private repo, so the owner
made it public. To keep a personal e-mail out of the public history, the old repo was renamed
`onelifestack/onelifestack-dispatch-archive` (private; keeps PRs #1–#18, the old issues #8–#15 with the Windows
reports, and the draft releases up to v0.4.4) and this repo was pushed fresh with rewritten history. Issue and PR
numbers restarted here; below, numbers marked *archive* refer to the old repo. Locally, remote `archive` is the old
repo. Never commit with any address other than the noreply one (see the folder CLAUDE.md).

**Releases.** Every release is a *draft*: the owner publishes. **Versioning restarted at v0.1.0 (owner,
2026-11-16):** the earlier previews (v0.2.0–v0.5.1, built under OneLifeStack) had their GitHub releases and tags
deleted from this repo and their changelog entries replaced by one 0.1.0 entry; their history stays in the commits,
in the private archive repo (drafts up to v0.4.4) and in the notes below. Version numbers live in `package.json`
(+ lock), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ lock), `VERSION` in `src/cli/main.ts`,
`clientVersion` in `src/core/mcp.ts` and `docs/TESTING-WINDOWS.md`.
- v0.1.0: the first release as Dispatch by OGCrafts (bundle ID `cloud.ogcrafts.dispatch`, in-app updates, Share
  as HTML, the UX refresh, the MCP assistant workspace). Previews can't update to it: export a backup, uninstall,
  install 0.1.0, import.

**Windows test (issue #2; rounds 1–2 in archive #8).**
- An agent on the owner's Windows machine follows `docs/TESTING-WINDOWS.md`, which is copied into the issue body,
  and posts reports as comments on #2. The repo is public, so the guide tells it to strip personal details.
- Round 1 (on 0.4.1, built from source): 29 of 35 checks passed and it found archive #9 (fixed in 0.4.2).
- Round 2 (installed 0.4.3, 2026-11-05): 35 of 42 passed, 2 failed (archive #14, #15, both fixed in 0.4.4), 5 partial.
  Not covered: 150%/200% scaling, multiple monitors, 6.4d step 9 (a real provider), SmartScreen text.
- Round 3 (installed 0.5.0 over 0.4.3, issue #2, 2026-11-05): 24 of 26 passed, 0 failed, 2 partial. Data survived
  the upgrade; both retests pass. Found: a copied workspace folder with an edited id moved the original's items and
  secrets (fixed in 0.5.1 with `reIdTaken`); guide 6.6b step 5 described the wrong behaviour (corrected, new step 6);
  import message skipped flows, long commands overflowed the confirm dialog, workspace names wrapped (all fixed in
  0.5.1). Flows deleted in 0.4.x stay in the data after upgrading (noted in the 0.5.1 release notes).
- Round 4 (install 0.5.1 over 0.5.0; retest 6.6b step 6 and the round 3 fixes) was requested on #2 on 2026-11-05.
  No report yet as of 2026-11-10. The installers are on the v0.5.1 draft release.
- **Issue #9 (2026-11-10)** is the next Windows round and replaces the round 4 request on #2: part A repeats round 4
  on the installed 0.5.1; part B tests a build from `main` (CI run 42783403452, commit e8f9dc2, artifact
  `dispatch-windows`, still says 0.5.1) for the MCP endpoint (curl checks for 401/403/405, port field, token,
  port in use) and drag and drop; part C covers 150%/200% scaling, multiple monitors and SmartScreen text. The
  report goes on #9, not #2. Artifacts expire 2027-02-08.
- As of 2026-11-16 no tester report on #9 (and none new on #2). Part B is partly covered by Claude's desktop check
  above (MCP endpoint; not drag and drop).
- **Next step:** read the newest comment on #9 and any `[Windows] …` issues or `test/windows-*` branches the agent
  opened. Then fix in a PR, bump the version (package.json, tauri.conf.json, Cargo.toml + lock, `VERSION` in
  `src/cli/main.ts`, `clientVersion` in `src/core/mcp.ts`, the version in `docs/TESTING-WINDOWS.md`), tag, add
  release notes, and refresh #2's body from the guide.

**Open on GitHub.**
- Minor findings from round 2, not filed yet: no Duplicate in the collection menu; static-token servers show the
  Sign in banner and the Auth tab can't be reached for MCP; MCP results from the previous tab stay visible; two
  blocks named "End" can't be told apart in flow selects; importing a
  backup into the same workspace duplicates everything; error texts include Rust internals (`os error 10061`).
- Issue #2: the Windows test (rounds 1–3 done; round 4 moved into #9). Issue #9: the next Windows round.
- No PRs open (2026-11-16). PR #10, branded installers (`src-tauri/installer/`, `scripts/make-installer-art.mjs`),
  is merged; its look has only been seen as images on Linux.
- Merged 2026-11-10, in `main` but not in any tag: the desktop app's local MCP endpoint (#6; Settings → AI
  assistants; `src-tauri/src/mcp_host.rs`, `src/core/mcpHandler.ts`, `src/ui/mcpHost.ts`; the port applies on
  blur/Enter and start/stop are serialised) and drag and drop between views (#7; Ctrl/Alt-drag copies in the
  sidebar, tabs onto collections, requests onto flow canvases and the Runner; `src/ui/dnd.ts`).
- Flaky CI: `tests/browser.test.ts` ("The browser didn't start in time") and the Linux `linuxdeploy` step each
  failed once and passed on `gh run rerun --failed`. The browser test failed again on PR #18 (2026-11-16).

**Sites.** dispatch.ogcrafts.cloud shows 0.5.1 (published 2026-11-14 from a branch off the v0.5.1 tag plus the
rebranded site files; `site/release.json` on `main` points at 0.5.1). The OGCrafts home site, https://ogcrafts.cloud
(repo `og-crafts/site`, local ~/projects/ogcrafts-site), has a Dispatch card and page; update `apps.json` there
(version) after each release. After each published release: regenerate `site/release.json`, run
`scripts/publish-site.sh` from a worktree at the release tag (it worked for Claude on 2026-11-14 with the
`og-crafts` gh token), and bump the version on the home site.

**Waiting on the owner.**
- Deciding whether to tag 0.5.2 soon so the old bundle ID is short-lived.
- **Updater key:** in-app updates are built (☰ → Check for updates…, opt-in check on start, signed `latest.json`
  on release tags; `docs/RELEASING.md` "Auto-updates"). They switch on when the owner runs
  `scripts/setup-updater.sh` (key in `~/keys`, public key into `tauri.conf.json`, GitHub secrets) and that
  `tauri.conf.json` change is merged. Claude's auto mode refused to make the key itself (2026-11-16).
- **Windows code signing: SignPath Foundation** (owner, 2026-11-16). Code signing policy page, privacy wording and
  the CI step (gated on the `SIGNPATH_API_TOKEN` secret) are built; the owner turns on MFA, applies, and after
  approval sets up the SignPath project and token, then approves each release in SignPath. All in `docs/SIGNING.md`.
- A look at the Windows setup pages and the .dmg window (branded installers, PR #10, merged).
- Sync design.
- OGCrafts email extras: Gmail "Send mail as" via Resend and a DMARC record (see the memory note ogcrafts-brand).

**Design canvas.** "Dispatch — Complete UX Redesign" (https://claude.ai/artifact/VxFK9bQ6zCXUV3wb36YLE7) was
gap-analysed against 0.4.4 on 2026-11-05. The owner keeps the node-graph flow editor (the canvas proposed a list).
Biggest unbuilt items: environment kinds + production guard, flow run evidence (screenshots, why it failed, re-run
from a step), richer schedules (times/cron, flows and saved suites), a real Ctrl+K palette.

**Linked workspaces** (owner chose "option B" over the canvas's Desk): phase 1 shipped in 0.5.0. Next: phase 2 (a
folder watcher: live reload and conflicts as files change) and phase 3 (`dispatch-run` on workspace folders,
`--env`, `--flow`, `DISPATCH_SECRET_*`). Code: `src/core/workspaceFiles.ts`, `src/ui/linkedDirs.ts`,
`folder_read`/`folder_sync` in `src-tauri/src/lib.rs`.

**Ideas not started.**
- UI assertions and screenshots in browser steps (deferred by the owner).
- An interactive MCP sign-in in the CLI (today the CLI takes a pasted token).
- A Windows-friendly cURL snippet (2.9 in the report; minor).
