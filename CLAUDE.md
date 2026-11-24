# CLAUDE.md — dispatch

Dispatch is OGCrafts' local-first API client: a React + TypeScript web app (`src/`) wrapped in a Tauri 2
desktop shell (`src-tauri/`). Same UI everywhere; only the transport differs (`src/core/transport.ts`).

It's our own app with its own name and look (own palette, inherited from the OneLifeStack apps). Other API tools appear only as file formats we import or export;
never copy another product's name, branding, icons, UI or wording, and never describe Dispatch as an alternative to,
replacement for or clone of another product (owner rule, 2026-11-19). Copy is warm and starts from the problems
people have with API tools (forced accounts, sync, paywalled basics, data leaving the machine) and what Dispatch does
about each, without naming or disparaging anyone.

## Layout

- `src/core/` — logic with no React, shared by the app and the CLI:
  - model and storage: `types.ts`, `db.ts` (IndexedDB v4; records normalized on read), `backup.ts` (Dispatch backup,
    Postman), `openapi.ts` (OpenAPI/Swagger/HAR)
  - building and sending: `vars.ts` + `fake.ts` ({{variables}}), `url.ts`, `prepare.ts` (variables + auth + body),
    `runtime.ts` (`execute`: the one pipeline everything uses), `auth.ts` (JWT, AWS SigV4, Digest, OAuth 2),
    `transport.ts` (fetch / Tauri / cookie jar), `cookies.ts`
  - scripts: `scripts.ts` (Dispatch's own `dx` API + top-level `test`/`expect` with chai; the Postman `pm` API stays
    only so imported scripts run; new snippets, docs, demos and AI tool texts use `dx`, never `pm`; reference
    `docs/SCRIPTS.md`), `scriptPipeline.ts` (collection → folders → request order),
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
  - `mcpHandler.ts`: the MCP tools (list_requests, send_request, run_collection, run_flow; plus get_request (secrets shown as `<hidden>` and refused if written back); with `workspace` set, create/update/copy/move/delete_request (update and create take preRequestScript / testScript), set_variables and set_scripts (folder or collection scripts) in the assistant's own workspace, and in the open workspace when its Space has `aiEdit` (Workspaces page → "AI can edit"); requests the user hands over (request menu → Hand to AI assistant…) land in `assistant/Inbox` with `RequestDef.handoff`, flagged in list_requests until move_request files them; see `mcpWorkspace.ts`), one JSON-RPC message
    in, one reply out; shared by `dispatch-run mcp` (stdio, first collection) and the desktop app's local MCP
    endpoint (every collection in the active workspace, with hooks that save script/token changes like Send does).
  - `mcpLogs.ts`: read-only MCP tools get_logs (the Console), list_history / get_history_entry (sends with responses, open workspace only) and get_environment, offered when Settings → AI assistants → "Let them read the console, history and environments" (`mcpHostLogs`, off by default) is on. Output goes through `Redactor`: get_request's pattern hiding plus every known secret value (secret or secret-named variables, auth fields, sensitive headers, the MCP token) wherever it appears.
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
  Look (since the unslop redesign, 2026-11-18): tokens at the top of `app.css` (light + dark), graphite surfaces with
  hairlines, no glass, glows or gradients; one accent, the logo amber (since 2026-11-20; `--primary-strong` #ffb020 fills with graphite `--on-primary`,
  `--primary` a deeper amber #a86500 in light mode for marks and focus, `--link` #8a5300); spacing on a 4px grid; weights 400–600, sentence-case labels; the response "postmark" (status ·
  time · size, `.postmark` in ResponsePane) is the signature. The "Look" section at the end of `app.css` overrides the
  older rules.
  Themes (Settings → Themes, since 2026-11-19): `settings.look` = `dispatch` (the look above, default) | `grove` |
  `grove-classic`, set as `data-look` on `<html>`; `settings.theme` still picks light/dark. Both Grove looks share one
  palette (mint, forest green, terracotta; from the owner's design canvas "Dispatch — screen designs", directions F
  and G); the owner wants the colours to match the canvas exactly (2026-11-19): only green, terracotta and the
  delete red carry meaning (PUT/PATCH are terracotta like POST, no blue or purple), dividers are `--divider` and the bundled Manrope font (`@fontsource-variable/manrope`, no network); `grove` is roomy (pill bars, filled
  pill tabs, big request title), `grove-classic` keeps the compact layout. All of it is the "Themes" block at the end
  of `app.css`; new rules must use tokens (`--sans` for the font) so every look picks them up. The canvas's own
  layouts (nav in the top bar, a history sidebar, Git status line) are NOT built: the looks restyle today's layout.
- Share as HTML: `core/share.ts` builds sanitized data (Sanitizer: secret-named values, JWT/bearer/AWS keys,
  emails, IPs, server address → `{{baseUrl}}`, sampled lists; variables stay `{{name}}`), `core/shareHtml.ts`
  renders one self-contained page (CSP, data embedded as JSON, DOM built with textContent). `ui/ShareDialog.tsx`
  asks for title/version/author/contact/description. Entry points: the request title row's ⋯ menu (Share as HTML…), request/folder/collection menus.
- About and changelog: `changelog.json` (repo root, newest release first) is the one changelog: Menu → About Dispatch
  (`src/ui/AboutDialog.tsx`, via `src/core/changelog.ts`) shows the version, channel and every release, and
  `site/build.py` builds /changelog/ from it. Add an entry with every version bump (`tests/about.test.tsx` checks it).
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
- `tests/` — vitest (jsdom; `cli.test.ts` builds and runs the real CLI in Node; `cssTokens.test.ts` keeps each dark colour
  set equal in its two copies). Rust: `grpc::end_to_end` (a tonic server on 127.0.0.1, runs in CI) and `mcp_host` `gate()`
  tests (token, Origin, Host); `src-tauri/tests/grpc_live.rs` — live gRPC test (needs `examples/grpc`); `network_live.rs` — mTLS/proxy (needs `examples/tls`);
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
- Stacked PRs: merge the bottom one **without** deleting its branch (or retarget the next PR to `main` first);
  deleting the base branch auto-closes the PR on top (that closed #25, 2026-11-16).
- Never push to `main` without `npm run typecheck`: vitest passes code that the CI typecheck rejects (this happened
  once with a readonly tuple in a test).
- Desktop webview ↔ Chrome DevTools: Chrome refuses WebSocket connections that send an `Origin` header unless that
  origin is allowed with `--remote-allow-origins`. The desktop launcher passes exactly `location.origin`.
- Windows: Rust's `Command::new` only looks for `.exe` (use `resolve_command` for `npx`/`npm`), and child processes
  need `CREATE_NO_WINDOW` (`no_console`). `shellWords` keeps a backslash before an ordinary character, for Windows
  paths.
- Don't `npx` remote packages from tool calls; that's blocked here. Local examples (`examples/*.mjs`) cover MCP.
- The desktop CSP keeps `'unsafe-eval'` (`tauri.conf.json`). Only user scripts need it: `compileWithFunction` runs
  `new Function` inside the script Worker (ajv and handlebars compile there too); the main bundle has no eval. Whether a
  worker loaded from the app gets the page's CSP differs between engines, and the macOS/Linux webviews (WebKit) couldn't
  be tested on 2026-11-21, so it stays until scripts are checked with it removed on all three OSes.
- MCP sign-in redirects to `http://127.0.0.1:33418/callback`, which a registered client is bound to; tests use 33419.

## Where we left off

Updated 2026-11-24. **Pending work is tracked on the Kan board "Dispatch"**
(https://kanban.gautamlabs.io/boards/mb7hut0k7z77; CLI: `KAN_BOARD=mb7hut0k7z77 ~/bin/kan show|card|move|note|desc`).
Lists: Waiting on you (owner actions), To do, In progress, Testing, Done; labels Release, Feature, Bug, Testing,
Infra. Keep the cards current at the end of each session (as with the Native Android Apps board).

**State.** Versioning restarted at **0.1.0** (PR #24). Releases: **`v0.1.0-SNAPSHOT`** was published 2026-11-22 as a pre-release; the plain **`v0.1.0`** comes next (a GitHub
pre-release, not offered as an in-app update; app version stays 0.1.0 because MSI needs numeric versions) until real
testing gives solid evidence; then a plain `v0.1.0` and the clean-up of the old v0.5.x releases/tags. `main` has,
since the last published preview (0.5.1): local MCP endpoint, drag and drop, branded installers (art rebuilt with
OGCrafts text), the OGCrafts move (bundle ID `cloud.ogcrafts.dispatch`), the MCP assistant workspace (#16), the UX
refresh (#17) and its fixes (#20), Share as HTML (#18), in-app updates (#22; update key set by the owner), SignPath
groundwork (#23) and opt-in usage/error reports + Send feedback (#26, `docs/TELEMETRY.md`); since 2026-11-17 also
the AI hand-off, "AI can edit" and right-click menus (#27) and the MCP log tools (#28), see "AI assistants" below;
since 2026-11-18 the unslop redesign (#31, see "Look" above) and the single-instance guard (#32: a second launch
focuses the open window and quits; `tauri-plugin-single-instance`, first plugin in `src-tauri/src/lib.rs`);
since 2026-11-19 themes (#33: Dispatch, Grove, Grove classic; the Grove colours follow the owner's canvas exactly,
see "Look" above), warm problem-led copy on the site and README with every comparison to other tools removed (#34,
rule at the top of this file) and the one-click Windows setup (#35, see "Windows setup" below).
Since 2026-11-19 also the audit fixes (#36 hygiene, #37 CI, #38 version + tests). Since 2026-11-20: the site refresh
and promo video (#46), Dispatch's own script API `dx` with `pm` kept for Postman scripts (#47, `docs/SCRIPTS.md`) and
the new logo "Plane in motion" with the amber accent (#48, see "Logo" below). Since 2026-11-21: this status (#49),
Share as HTML in the Dispatch look + clearer focus ring (#50), Rust tests for the MCP endpoint checks (#51), stable
legal-page dates (#52), the gRPC crates moved up together with end-to-end tests (#53), the borderless installer splash
(#54, see "Windows setup" below), dropdown menus that close on an outside click / Escape / window blur (#55,
`src/ui/menus.ts` `useMenuDismiss`) and a calmer request title row (#56: `{{ }}`, Code, a ⋯ menu with Save as…,
Share as HTML… and Parameterize…, then Save). All merged by Claude on the owner's word; #54, #55 and #56 were
installed and tried by the owner on the Predator first. `main` = 793026f, CI green on every job (updater skipped as
always); 363 vitest tests.
**No PRs open (2026-11-22).** The Dependabot PRs were merged on the owner's word, each checked on top of the new
`main` first: #39 GitHub Actions to new majors (checkout v7, setup-node v7, upload-artifact v7, download-artifact v8,
action-gh-release v3; the two release-only actions just need Node 24, no input changes), #41 tauri 2.12.6 + plugins,
#40 Tauri CLI/api 2.12.5 (installer template header line only) + small npm bumps, #43 jsdom 31, #45 vitest 5.1.1
(vite 6.4.5 is enough). `main` = c0f0116; 363 tests. The release-only steps (download-artifact v8, gh-release v3)
first run for real on the snapshot tag: watch that run. #42/#44 were closed by Dependabot once #53 merged. Merged branches were deleted on GitHub and locally (2026-11-20 and 2026-11-21, incl. the throwaway
`test/windows-2026-11-21`). Left on purpose: `docs/after-installers` (PR #11 closed unmerged), the old local branches
that are copies of the `archive` remote (`feature/flows`, `feature/inbox`, `feature/v0.3`, …), `site/0.5.0-ogcrafts`
(local, unmerged), and `site/0.5.1-ogcrafts`, checked out in the worktree `../onelifestack-dispatch-site` with staged,
uncommitted changes (LICENSE, `scripts/publish-site.sh`, `site/*`): look before touching it.
**2026-11-21 (owner: "do everything you can without me"):** the open audit items became four PRs (all merged the
same evening): #50 Share as HTML in the Dispatch look + clearer focus ring + `cssTokens.test.ts`; #51 MCP endpoint checks
moved unchanged into `gate()` with Rust tests; #52 legal pages keep the date their wording changed (`UPDATED` in
`site/build.py`) and the finished `docs/PLAN*.md` removed; #53 the gRPC crates moved up together (tonic 0.14, prost
0.14, prost-reflect 0.16, protox 0.9; replaced Dependabot #42/#44) with end-to-end tests;
those tests caught a race already on `main`: every `.proto` compile shared one temp file, so two at once could delete
each other's (fixed in #53: a folder per compile).
Dependabot: #39, #41, #45 pass CI as they are; fixes pushed onto #40 (Tauri CLI 2.12.5: its NSIS template is unchanged,
only the `TAURI-CLI-VERSION` line moved) and #43 (jsdom 31 joins inline text in accessible names: a spoken space after
the method tag in sidebar rows and tabs). `'unsafe-eval'` was kept on purpose (see Gotchas). Windows desktop check
of #50+#51+#53 together (Predator, CI build of the throwaway branch `test/windows-2026-11-21`, MSI unpacked, the
installed app's data backed up and restored): app starts in the new look; MCP
endpoint answers 401 (no/wrong token), 403 (Origin, foreign Host), 404, 405, 200; it found that the URL field still had
the faint focus halo (an older `input:focus` rule in the Look section won) and that the roomy Grove look showed no
focus on the URL at all, both fixed in #50. gRPC over the internet couldn't be checked: grpcb.in doesn't answer (port
9000/9001 time out from the homelab and the Predator) and grpc.postman-echo.com fails the TLS handshake
("InvalidContentType") with the old crates on `main` exactly as with #53, so TLS behaves as before; the local
end-to-end and grpc-js tests cover plaintext.
**Resume here (2026-11-24, read first): the six-feature round is MERGED.** The owner tested the setup
(`Dispatch_0.1.0_x64-setup-extract-cookies.exe`) and said merge: #81 polish (rename in place, curl naming, wrapping values),
#82 extract into variable, #83 Secrets section, #84 cookies per environment + all review fixes, with merge commits
(`main` 9ad8cd6, same tree as 8b7114e, which was green on #84; 574 tests). Merged branches are kept on origin. Not released:
next is a version bump with its changelog entry, when the owner wants a release. Going back to 0.1.0 from this build
starts fine but without the cookies.
Design + plan: `docs/superpowers/specs/2026-11-23-extract-variables-and-polish-design.md`,
`docs/superpowers/plans/2026-11-24-extract-variables-and-polish.md`. The rule line differs from the design on purpose:
`{ const v = <expr>; if (v != null && v !== '') dx.env.set('token', v) } // extracted` (a failed login keeps the token).
Runs merge what they changed onto the tables as they are now (`mergeVars`, `ws.keepVars`), so edits made meanwhile stay.
Checked on the Predator (build 2861eaf, own data folder through `WEBVIEW2_USER_DATA_FOLDER`, so the installed app's data
is untouched: use that from now on; CDP listened on `[::1]:9222`): extract, refresh on the next send, empty token kept,
cookies separate for two environments and none, rename, Secrets. **Not checked there: values after a restart** (Windows
held later launches of the unpacked exe; storage tests cover it). Changelog entry: add with the next version bump (these
features aren't in 0.1.0). Known minors: Undo of Extract after its tab is closed leaves the rule; multi-line plain values
become one line when edited; the key-column handle has a dead zone in narrow panes.

**Earlier on 2026-11-23: Dispatch 0.1.0 is OUT.** #76 merged, tag `v0.1.0` on `main` 10fd7d8, CI green
on every job incl. updater; the owner published it as **Latest** 2026-11-23 (notes from the changelog). `latest.json`
lists 0.1.0 for all five platforms, so in-app updates work from now on. The v0.5.0/v0.5.1 releases and tags were
deleted (owner's OK), and so were the old preview tags v0.2.0–v0.4.4: only `v0.1.0` and `v0.1.0-SNAPSHOT` are left. Site published from the tag
(`VITE_DISPATCH_CHANNEL=release`): /download/ links the v0.1.0 files, no snapshot wording; `site/release.json` on `main`
matches. ogcrafts.cloud already listed 0.1.0 (no change needed). **Product Hunt kit: `promo/product-hunt/`** (README =
listing copy, gallery order, maker's comment, replies, launch plan; `gallery/` = 7 slides 1270×760 + thumbnail from
`gallery.mjs`, shots from `node scripts/screenshots.mjs ph`). Waiting on the owner: Product Hunt account + reconnect
the claude.ai Product Hunt connector, YouTube upload of the promo, launch date. Nothing is submitted without the owner.
Since then (2026-11-23): #78 (the kit) and #79 merged (`main` 8dea53c); #79 rewrote the macOS first-run steps on
/download/#unsigned after the owner hit "Apple could not verify Dispatch is free of malware" on a Mac: newer macOS
has no Control-click → Open for apps that aren't notarized, so the steps lead with System Settings → Privacy & Security →
Open Anyway, with `xattr -dr com.apple.quarantine /Applications/Dispatch.app` as the fallback. Site republished from
`main` (app code identical to the tag). **Apple signing: deferred by the owner (2026-11-23).** Recommended: the owner's
own Apple Developer account (US$99/yr, Individual), not a friend's Developer ID (their name shows as signer, their
account carries the risk). When it comes: a CI signing + notarization step from repo secrets (`.p12` + password, Team
ID, App Store Connect API key), built so the credentials can be swapped. In-app updates use Dispatch's own key, so
a later change of Apple signer breaks nothing. No PRs open.

**Earlier (2026-11-22 late night):** everything from the owner's "work end to end" list is merged:
#74 Sync secrets (opt-in `secrets.dispatch-vault`; `src/core/secretsVault.ts`, Rust `read_vault`/`put_vault`,
`linkedDirs.syncVault`, `PassphraseDialog`) and #75 `dispatch-run` on workspace folders (`--env`, `--flow`, `mcp`;
`DISPATCH_SECRET_<KEY>`, `DISPATCH_VAULT_PASSPHRASE`); the owner tested both on the Predator. Earlier today: #67–#73
(folder watch, Save, response viewer, share from response, folder order + Windows drag fix + feedback e-mail).
**Next: the plain 0.1.0 release** for the Product Hunt launch (`docs/RELEASING.md` "After publishing" and "The first
plain release"): merge this prep PR, tag `v0.1.0` on `main`, the owner publishes the draft **as Latest**, then (owner's
OK) delete the v0.5.x releases and old tags, publish the site from the tag (`VITE_DISPATCH_CHANNEL=release`,
`site/release.json` version "0.1.0") and bump ogcrafts.cloud `apps.json`. Then the Product Hunt kit (tagline,
description, gallery 1270×760, promo video, maker's first comment; problem-led, no comparisons).
Flaky under a loaded full run (pass alone): `dnd.test.tsx`, `handoff.test.tsx`, `regressions.test.tsx`.

**Earlier on 2026-11-22:** **v0.1.0-SNAPSHOT is out.** The tag is on `main` 0a46658 (#60
About + changelog.json, #61 friendly update-check message, #62 site look picker). CI was green on every job, and the owner
published it on 2026-11-22 as a **pre-release, not Latest**, on purpose: GitHub "Latest" is still v0.5.1, which has no
`latest.json`, so Check for updates says "No update found" (#61). A plain 0.1.0 becomes Latest together with removing the
0.5.x releases (owner's OK needed). After that, updates work for real.
The site was published from the tag on 2026-11-22 (worktree at the tag; `site/release.json` regenerated from the release
API, using the `digest` field for checksums; `VITE_APTABASE_APP_KEY`/`VITE_SENTRY_DSN` from the repo variables,
`VITE_DISPATCH_CHANNEL=snapshot`). dispatch.ogcrafts.cloud has the Look menu, /download/ shows "0.1.0 (snapshot)", and
/changelog/ is live. ogcrafts.cloud (repo og-crafts/site) `apps.json` lists Dispatch 0.1.0. `site/release.json` on
`main` matches the published snapshot.
Nothing is open on GitHub (as of 2026-11-22, `main` 968e57d). #63 added the SignPath sentence to the download page;
after SignPath declined, #64 removed it again and rewrote /code-signing/ (unsigned, how installers are built, how to
check a download). The site was republished from `main` after each, and the live site has no SignPath mention. Options: items from the Kan "To do" list.
Dependabot tip: after one npm PR merges, the others conflict in `package-lock.json`. Dependabot rebases its own PRs
(even over a pushed merge commit, as it did with #45), and a branch Claude pushed to is fixed by merging `main`,
taking main's lockfile and running `npm install`.
Seen for real: the new icon, the splash and the app in a real install on the Predator (owner, 2026-11-21); the snapshot
setup from 0a46658 is in the Predator's `Downloads` as `Dispatch_0.1.0_x64-setup-snapshot.exe`. Not yet checked: the
.dmg window, the splash at 125/150/200 % scaling. The older test setups (owner) and
`C:\Users\ompra\dispatch-data-backup-2026-11-21` (Claude, on the owner's request) were deleted on 2026-11-22; the app's
own data in `AppData\Local\cloud.ogcrafts.dispatch` is untouched.
- **Done 2026-11-22:** secret scanning + push protection on; SignPath Foundation application submitted and
  **declined the same day** (not enough public visibility yet; reapply later, see `docs/SIGNING.md`). The owner chose
  to drop SignPath from the site (#64, live) and to go the **Microsoft Store** route for Windows (an MSIX package signed
  by Microsoft; the direct downloads stay unsigned). Store developer sign-up (free, Individual) was started 2026-11-22
  but Microsoft blocked creating a new Microsoft account for the OGCrafts Gmail address ("unusual activity"). Next:
  the owner signs up with an existing Microsoft account or retries later from another network, reserves the app
  name, and sends the Product identity values (Identity Name, Publisher `CN=…`, PublisherDisplayName). Then Claude
  adds an MSIX build to CI with the in-app update check off for Store builds, and prepares the listing. **Owner to-dos:** decisions on macOS signing
  and the email extras.
- Preview (0.5.x) installs can't update to 0.1.0 (different bundle ID, no updater): export backup, uninstall,
  install, import (the download page says so).

**AI assistants (MCP), 2026-11-17.** On `main`, all behind Settings → AI assistants:
- #27: Hand to AI assistant… (request menu, right-click) puts a copy in `assistant/Inbox` with the user's note, the
  auth and the collection/folder scripts it ran with (marked `// From the …`), and the original collection's
  variables (it resolves them until `move_request` files it). Workspaces page → "AI can edit" lets assistants change
  the open workspace's requests, collection variables and scripts (the consent dialog says scripts run on Send and
  can read secrets). New MCP tools get_request, set_variables, set_scripts, move_request. Right-click menus on tabs
  and sidebar rows (`src/ui/ContextMenu.tsx`).
- #28: read-only get_logs, list_history, get_history_entry, get_environment (`src/core/mcpLogs.ts`), behind
  "Let them read the console, history and environments" (`mcpHostLogs`, off by default).
- Secret hiding: everything assistants see goes through `hideInText`/`hide` (`mcpWorkspace.ts`: URL passwords, JWTs,
  auth-scheme values, secret-named fields and `name=value` pairs; `access-control-*` headers exempt) and, for the log
  tools, `Redactor` (every known secret value wherever it appears). Writes never drop a hidden value: update_request
  keeps hidden headers it isn't given and refuses to rewrite a URL, body, docs or script that holds one.
- Both PRs had a review (10 findings) and two Windows desktop checks on the Predator (method below); every finding
  was fixed before merging. Planted-secret scan of the log tools: 0 leaks.
- Next ideas (owner chose the log tools first, 2026-11-17): a one-click Claude Desktop extension that talks to the
  local endpoint; a "Copy Codex command" (check Codex CLI's local MCP support first); keep collection-run results so
  a run-results tool can show them (today only the console summary line). ChatGPT itself would need a public relay:
  deferred. Users bring their own Claude/ChatGPT app; a subscription can't be used inside Dispatch directly.

**Desktop check on Windows (2026-11-16, Claude over SSH, build of main 52b2630).** Run on the owner's Predator
(Windows 11, WebView2 157) from the CI `dispatch-windows` artifact, MSI unpacked with `msiexec /a` (no install), so
the installed 0.5.1 stayed untouched. Passed: new layout renders; Home; a real send (200, no CORS); Save to a new
collection; Save as… on an edited saved request (copy gets the edit, original keeps its last save); library panel
drag, arrow keys (when focused), width remembered across reload; request/response divider drag and double-click
reset; rail folds and reopens the library; Settings tabs; MCP endpoint starts, refuses no token (401), Origin (403),
foreign Host (403), GET (401); all #16 tools (create, update, send, copy, delete own; update/delete of a user
request refused with the copy_request hint; POST refused under GET,HEAD); the "AI assistant" workspace shows what
the assistant made; Share dialog opens with `{{baseUrl}}` and the secret check. Not covered: the native save dialog
behind "Save HTML file", drag and drop, installers, scaling/monitors. Its 7 small findings were fixed in #20.
How it was driven, for next time: run the exe in the owner's desktop session via a temporary scheduled task (a
`.bat` that sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` then starts it; the owner must
be logged in), `ssh -L 19222:127.0.0.1:9222` and drive it over CDP (`Runtime.evaluate`, `Input.dispatchMouseEvent`,
`Input.insertText`, `Page.captureScreenshot`); MCP via `ssh -L 14320:127.0.0.1:4320` with `Host: 127.0.0.1:4320`.
Afterwards stop the exe, unregister the task, and delete `%LOCALAPPDATA%\cloud.ogcrafts.dispatch` so a later real
install starts clean. **Wait until no `msedgewebview2.exe` with `cloud.ogcrafts.dispatch` in its command line is left
before deleting** (they outlive a `taskkill` of the exe for a few seconds). On 2026-11-17 the first launch after such
a cleanup started WebView2 40 s late and a minute later ran on an empty database (data imported meanwhile was gone);
a clean cold start did not repeat it. Seen again 2026-11-18: the first launch of a freshly unpacked build started
two `dispatch.exe` 5–6 s apart, both stalled about 40 s, and one exited as the other came up. It happened once with
and once without the single-instance guard (PR #32), and not with a third fresh build (one parent, the task's
`cmd.exe`). Cause unknown; so far only seen with this check's way of launching a just-unpacked exe. Since #32 a
deliberate second launch can't run a second copy: it focuses the open window and quits within 0.2 s (the lock is
released before an update restart). Seen a fourth time on 2026-11-19 (themes build, PR #33): two `dispatch.exe` 6 s apart, both children
of the task's one `cmd.exe`; the guard closed the second copy after 34 s and the first kept running. A fifth time
the same day, on the first of three fresh installs by the new setup (both copies children of the setup, 0.3 s
apart; the setup calls `ShellExecute` once). Every sighting is the first start of a never-seen unsigned exe, where
Windows also holds the launch for about 27 s, so the likely cause is that Windows check, not Dispatch.
Tips from 2026-11-17: Node's `fetch` won't send a custom `Host` header, so call MCP with `node:http`; dialogs are
native `<dialog>` elements; picking the open library section folds the panel; import test data by setting a
`DataTransfer` file on `input[aria-label="Import file"]` and dispatching `change`.

**Windows setup (one-click, #35; checked on the Predator 2026-11-19).** `src-tauri/installer/installer.nsi` is
Tauri's NSIS template (CLI 2.12.4) with seven blocks marked `DISPATCH:`; `tests/installer.test.ts` fails when the
Tauri CLI is bumped without re-applying them (`docs/RELEASING.md`). A plain double-click forces passive mode: one
window ("Installing Dispatch", a progress bar, only Cancel), a per-user install with no admin prompt, shortcuts, then
the app opens. `/WIZARD` brings the pages back; `/S`, `/P` and `/UPDATE` runs are as Tauri made them. Seen working
on Windows 11 with the CI build 4e5ff68 (left installed there in `%LOCALAPPDATA%\Dispatch`): fresh install, install
over a running app (closed, replaced, reopened), `/WIZARD`, `/S`. Not run: the uninstall, an in-app update.
- **Borderless splash (#54, 2026-11-21).** On a one-click run, `OneClickSplash` (the install page's SHOW function)
  turns that window into a 400×240 rounded graphite card: logo (`splash-logo-{100,125,150,200}.bmp`, picked by DPI,
  from `scripts/make-installer-art.mjs splash`), "Installing Dispatch", a note and a thin amber progress bar; then
  "Opening Dispatch" until the app starts. All Win32 calls go through the NSIS System plugin. `/WIZARD`, `/S`, `/P`,
  `/UPDATE` and the `.msi` (WiX wizard) are unchanged, so a person who runs the `.msi` sees the classic wizard: point
  them at the setup `.exe`. Checked by Claude on the Predator at 100 % (a stray Back button at "Opening" was fixed) and
  installed by the owner by hand.
- The first start of every new unsigned build blocks about 27 s inside the setup's launch call (Windows checking the
  file; a repeat install of the same build takes under 1 s), so the window then says "Opening Dispatch. The first
  time, Windows may take a moment to check it." A new setup exe also took 30-40 s to start. Signing should end both.
- The old 0.5.1 on the Predator was a broken MSI remnant (publisher OneLifeStack, no exe). The setup only replaces an
  MSI with the same product name and publisher, so that entry is still listed in Windows' installed apps.
- How it was run: copy the setup over `scp`, start it in the owner's desktop session with a temporary `/it`
  scheduled task that runs a PowerShell watcher (window and control texts through `EnumWindows`/`EnumChildWindows`,
  pictures with `PrintWindow`), then delete the task and files. Never use `CopyFromScreen`: the setup window opens
  behind the owner's windows, so it captures their screen. `PrintWindow` hangs while the setup's thread is blocked.

**Moved to OGCrafts (2026-11-14).** Dispatch is no longer an OneLifeStack app. Home: GitHub org
`og-crafts` (a free org; admin login `og-crafterr`). Repo `og-crafts/dispatch` (transferred, so issues, PRs and the
v0.5.1 release came with it); site repo `og-crafts/dispatch-site` (Pages, custom domain `dispatch.ogcrafts.cloud`,
HTTPS enforced); Cloudflare CNAME `dispatch -> og-crafts.github.io` (DNS only). Bundle ID is now
`cloud.ogcrafts.dispatch`; backups are written as `ogcrafts-dispatch` and the old `onelifestack-dispatch` name still
imports (`LEGACY_FORMATS` in `src/core/backup.ts`). Contact: hello@ogcrafts.cloud. Commits here use the
`og-crafterr` noreply address (`356532942+og-crafterr@users.noreply.github.com`), not the OneLifeStack one.
`gh` has three logins: use `gh auth switch` or `GH_TOKEN=$(gh auth token --user NAME)` for the right one.
The old `onelifestack/dispatch-site` is left unpublished (custom domain removed); the archive repo stays under
`onelifestack`. Dispatch was removed from developer.onelifestack.com. The next release is the first
under the new bundle ID (now `v0.1.0-SNAPSHOT`, see Releases). The installer art was rebuilt with the OGCrafts text on 2026-11-16 (`scripts/make-installer-art.mjs`; it needs
`CHROMIUM=~/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell` and libasound, see
"Visual check without a desktop").

**The repo is public (MIT) since 2026-11-05.** GitHub billing blocked Actions on the private repo, so the owner
made it public. To keep a personal e-mail out of the public history, the old repo was renamed
`onelifestack/onelifestack-dispatch-archive` (private; keeps PRs #1–#18, the old issues #8–#15 with the Windows
reports, and the draft releases up to v0.4.4) and this repo was pushed fresh with rewritten history. Issue and PR
numbers restarted here; below, numbers marked *archive* refer to the old repo. Locally, remote `archive` is the old
repo. Never commit with any address other than the noreply one (see the folder CLAUDE.md).

**Releases.** Every release is a *draft*: the owner publishes. **Versioning restarted at v0.1.0 (owner,
2026-11-16):** the earlier previews (v0.2.0–v0.5.1, built under OneLifeStack) had their changelog entries replaced
by one 0.1.0 entry. Their GitHub releases (v0.5.0, v0.5.1, the second still marked "Latest") and eight tags are
still in this repo as of 2026-11-19: delete them only after 0.1.0 is out, with the owner's OK; their history stays in the commits,
in the private archive repo (drafts up to v0.4.4) and in the notes below. Version numbers live in `package.json`
(+ lock), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ lock) and `docs/TESTING-WINDOWS.md`;
`tests/version.test.ts` fails if they disagree. The CLI and the MCP client read theirs from `package.json`
(`src/core/version.ts`).
- v0.1.0: the first release as Dispatch by OGCrafts (bundle ID `cloud.ogcrafts.dispatch`, in-app updates, Share
  as HTML, the UX refresh, the MCP assistant workspace). Previews can't update to it: export a backup, uninstall,
  install 0.1.0, import.

**Windows test (issues #2 and #9).** An agent on a Windows PC follows `docs/TESTING-WINDOWS.md` (copied into the issue
body; the guide tells it to strip personal details) and reports as comments. Rounds 1–3 (0.4.1–0.5.0, 2026-11-04/05)
found archive #9, #14, #15 and the copied-folder bug, all fixed by 0.5.1. Issue #9 (2026-11-10) asks for the next round
(0.5.1 retest, the MCP endpoint and drag and drop on a `main` build, scaling/monitors/SmartScreen); no report as of
2026-11-21. Since 2026-11-16 Claude checks desktop builds on the Predator itself (method above). Next: when a report
comes, fix in a PR, bump the version everywhere `tests/version.test.ts` checks, and refresh the issue body from the guide.

**Open on GitHub.**
- Minor findings from round 2, not filed yet: no Duplicate in the collection menu; static-token servers show the
  Sign in banner and the Auth tab can't be reached for MCP; MCP results from the previous tab stay visible; two
  blocks named "End" can't be told apart in flow selects; importing a
  backup into the same workspace duplicates everything; error texts include Rust internals (`os error 10061`).
- Issue #9: the next Windows round (see above).
- Open PRs (2026-11-22): none.
- Flaky CI: `tests/browser.test.ts` ("The browser didn't start in time") and the Linux `linuxdeploy` step each
  failed once and passed on `gh run rerun --failed`. The browser test failed again on PR #18 (2026-11-16).
- The macOS job (universal build) hit its 15-minute limit on every run 2026-11-16/17 (#26, #27, #28, `main`), so no
  `.dmg` was built; on 2026-11-18 it passed on #31 and #32 (cause never found). Watch it on the next runs.

**Sites.** dispatch.ogcrafts.cloud shows 0.5.1 (published 2026-11-14 from a branch off the v0.5.1 tag plus the
rebranded site files; `site/release.json` on `main` points at 0.5.1). The OGCrafts home site, https://ogcrafts.cloud
(repo `og-crafts/site`, local ~/projects/ogcrafts-site), has a Dispatch card and page; update `apps.json` there
(version) after each release. After each published release: regenerate `site/release.json`, run
`scripts/publish-site.sh` from a worktree at the release tag (it worked for Claude on 2026-11-14 with the
`og-crafts` gh token), and bump the version on the home site.
On 2026-11-19 the owner chose **not** to publish the site from `main` (it describes 0.1.0, and its download page
says "install 0.1.0 from this page", while the only installers are the 0.5.1 preview): it waits for the
`v0.1.0-SNAPSHOT` tag. Until then the live site keeps the old copy, says "No telemetry" and has no `/code-signing/`
page. The GitHub repo description, homepage (the site) and topics were set the same day.
On 2026-11-20 the site source moved to the app's Dispatch look (graphite and amber tokens, Manrope instead of
Nunito), got new screenshots incl. Grove (`scripts/screenshots.mjs site`), a new `og.png`, JSON-LD, and a short
promo video with captions; the video and og.png come from `promo/` (Remotion, local Kokoro voice, synthesized
music; see `promo/README.md`). Still unpublished, same rule: it goes live with the tag.
On 2026-11-22 the site got the app's looks: a Look menu in the header (`site/src/look.js`, loaded in `<head>` so the
pick applies before drawing; Dispatch, Grove, Grove classic × System/Light/Dark, kept in localStorage
`dispatch-site-look`). `site.css` holds the palettes as `/* tokens: <name> */` blocks (dispatch-light/dark,
grove-light/dark); `build.py` checks every one against WCAG AA and that the forced-dark copies match. Every figure
has six screenshots (`<shot>[-grove|-grove-classic][-dark].png`, `node scripts/screenshots.mjs site`); look.js swaps
them. Without scripts the site is the Dispatch look following the system.

**Waiting on the owner.**
- **Aptabase App Key and Sentry DSN** as repo variables `APTABASE_APP_KEY` / `SENTRY_DSN`: the only thing blocking
  the `v0.1.0-SNAPSHOT` tag.
- Updater key: done by the owner 2026-11-16 (key in `~/keys`, secrets set, public key in `tauri.conf.json`); in-app
  updates work from the first signed release (`docs/RELEASING.md` "Auto-updates").
- **Windows code signing: SignPath Foundation** (owner, 2026-11-16). Code signing policy page, privacy wording and
  the CI step (gated on the `SIGNPATH_API_TOKEN` secret) are built; the owner turns on MFA, applies, and after
  approval sets up the SignPath project and token, then approves each release in SignPath. All in `docs/SIGNING.md`.
- A look at the .dmg window (branded installers, PR #10, merged). The Windows setup was seen on the Predator
  2026-11-19 (above); its header art was redrawn with the new logo on 2026-11-20 (not yet seen in a real installer).
- Turn on secret scanning + push protection (repo Settings → Code security; free for public repos). Off as of
  2026-11-22, together with Dependabot security updates.
- Sync: decided 2026-11-22 (folder sync via phase 2 + opt-in encrypted secrets file; `docs/DESIGN-linked-workspaces.md` "Sync decision").
- OGCrafts email extras: Gmail "Send mail as" via Resend and a DMARC record (see the memory note ogcrafts-brand).

**Logo (2026-11-20).** The owner picked "Plane in motion" (option J of the logo sheet
https://claude.ai/artifact/TjdKDtCsPvJNQsRbJMwDSG): amber #FFB020 tile, graphite #1C1C1E plane with speed lines
(`public/icon.svg`, copied to `site/src/assets/icons/`). Desktop icons come from `npx tauri icon <1024 png>` (delete
the android/ and ios/ folders it adds); installer art from `scripts/make-installer-art.mjs`. The app accent moved from
violet to amber with it (owner's choice).

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
