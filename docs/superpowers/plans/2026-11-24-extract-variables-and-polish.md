# Extract into variable and polish: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename in place, curl naming, readable long values, extract into variable, a Secrets section and cookies per environment.

**Architecture:** Pure logic goes in `src/core` (`extract.ts`, `cookies.ts`) and is unit-tested; React pieces stay small (`InlineName.tsx`, `ValueField.tsx`, `ExtractDialog.tsx`, `VariablesEditor.tsx`). The extraction rule is an ordinary script line. The cookie jar key travels in `SendOptions`, taken from the run's environment.

**Tech Stack:** React, TypeScript, Vitest + Testing Library (jsdom), CodeMirror 6, IndexedDB, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-11-23-extract-variables-and-polish-design.md`

## Global Constraints

- App copy is warm and plain, and never names or compares another tool.
- No new request or file-format fields; `KV.secret` and the one `variables` array stay.
- No extraction from Preview, Visualize or binary bodies. Web cookies unchanged. "Keep cookies between requests" stays global.
- Secret values never show in clear text anywhere they didn't before.
- CSS uses existing tokens only, in all three looks, light and dark.
- `export PATH=~/.local/node/bin:~/.cargo/bin:$PATH` first. Before each commit: the task's tests; before each PR: `npm test`, `npm run typecheck`, `npm run build`, all exit 0. Known flaky under a full run: `dnd`, `handoff`, `regressions` (re-run alone).
- Commits: author `Omprakash Gautam <356532942+og-crafterr@users.noreply.github.com>`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Owner merges.

## Decisions made while planning

- **The rule skips missing values.** `dx.env.set('token', undefined)` stores the text `undefined`, so a failed login would wipe a good token. The line is therefore `{ const v = dx.response.json('data.token'); if (v != null) dx.env.set('token', v) } // extracted`. The script runtime is unchanged.
- **JSON filter active:** paths in filtered text don't match the body, so Extract is disabled with "Clear the filter first".
- **Persistence gaps found:** flows drop script changes to collection variables, and the MCP run hook (`afterRun` in `mcpHost.ts`) doesn't save them. Send (`applyChanges`) and the Runner screen already save all three scopes. Scheduled runs don't keep changes, as their screen says; unchanged.
- **`isSecretName` doesn't exist;** it is added to `src/core/share.ts` as `SECRET_NAME.test(name)`.
- **Changelog:** 0.1.0 is already released and the test wants the top entry to match `package.json`, so the entry is added with the next version bump, not in these PRs.

## Review Focus

1. The editor of a collection, folder, environment or flow is open while it is renamed in the sidebar: the next edit there must keep the new name (Task 1).
2. A login fails with JSON lacking the token: the saved value stays (Task 5).
3. CRLF bodies, where the editor's offsets differ from the body's: the right value is picked (Task 4, Task 6).
4. The environment is switched while a run or send is in flight: its cookies stay in the run's own jar (Task 9).
5. A script's `dx.env.set` on a secret row keeps the row secret after extract and after send (Task 5).

---

# PR 1: polish (branch `feature/polish`, from `main`, carrying the spec and plan commits)

### Task 1: Rename in place

**Files:** Create `src/ui/InlineName.tsx`; modify `src/ui/Sidebar.tsx`, `src/ui/Editors.tsx` (and the flow view) if Review Focus 1 fails, `src/ui/app.css`; test `tests/rename.test.tsx`.

**Interfaces — Produces:** `InlineName({ value, label, onSave, onCancel }: { value: string; label: string; onSave: (name: string) => void; onCancel: () => void })`: an input with the name selected on mount. In Sidebar, state `renaming: { kind: 'request'|'folder'|'collection'|'flow'|'environment'; id: string } | null`.

- [ ] **Step 1: Failing tests** (App rendered as in `tests/layout.test.tsx`)
  - `it.each` over the five kinds: double-click the row button; `getByLabelText('Rename <name>')` is focused with the whole name selected; type `New`, Enter; the row shows `New`.
  - Esc keeps the old name; blur saves; whitespace-only cancels; saved names are trimmed; Enter followed by blur saves once.
  - F2 on a focused row button starts it; the ⋯ menu's Rename starts it and no dialog opens.
  - A collapsed folder and an open folder each keep their state after a double-click on name or caret.
  - The row isn't draggable while renaming, and typing Space or Enter doesn't open the row.
  - Review Focus 1: open the environment editor, rename in the sidebar, add a variable in the editor; the sidebar still shows the new name. Same for collection, folder, flow.
- [ ] **Step 2:** `npx vitest run tests/rename.test.tsx` fails on the missing input.
- [ ] **Step 3: Implement.** The input replaces the `.rowMain` button (never nested in it). Save through `renameRequest`, `updateFolder`, `updateCollection`, `updateFlow`, `updateEnvironment`. On a caret double-click, two toggles already cancel out; don't add a click delay. If an open editor holds a stale name, sync `name` from the prop the way `EnvironmentEditor` syncs `variables`.
- [ ] **Step 4:** the test file and `tests/contextmenu.test.tsx` pass.
- [ ] **Step 5:** commit `Rename in place in the sidebar (double-click, F2)`.

### Task 2: Curl paste names the request

**Files:** `src/core/curl.ts`, `src/ui/RequestPane.tsx`; test `tests/core.test.ts`.

**Interfaces — Produces:** `nameAfterPaste(current: string, previousUrl: string, imported: string): string` in `curl.ts`.

- [ ] **Step 1: Failing tests**
```ts
expect(nameAfterPaste('New request', '', 'a.test/x')).toBe('a.test/x')
expect(nameAfterPaste('a.test/x', 'https://a.test/x?q=1', 'b.test/y')).toBe('b.test/y')
expect(nameAfterPaste('Log in', 'https://a.test/x', 'b.test/y')).toBe('Log in')
```
  plus one App test: paste two curl commands into the URL field; the title follows the second.
- [ ] **Step 2:** fails: not exported.
- [ ] **Step 3: Implement**, used in `onPaste` with `d.name`, `d.url`, `request.name`.
- [ ] **Step 4:** passes. **Step 5:** commit `A pasted curl command renames the request unless you named it`.

### Task 3: Long values in key/value tables

**Files:** Create `src/ui/ValueField.tsx`; modify `src/ui/KVTable.tsx`, `src/ui/app.css`; test `tests/kvtable.test.tsx`.

**Interfaces — Produces:** `ValueField({ value, label, placeholder, secret?, onChange }: { value: string; label: string; placeholder?: string; secret?: boolean; onChange: (v: string) => void })`: a one-row textarea that grows to 8 lines then scrolls; `secret` gives today's password input. `KVTable` gains key-column width in localStorage `dispatch.kvKey.<label>`.

- [ ] **Step 1: Failing tests:** the value cell is a TEXTAREA with the existing aria-label; a 500-character value is all in it; Enter prevents default and doesn't change the value; pasted `a\r\nb` becomes `a b`; a secret row is still a password input; the key separator (`role="separator"`, `aria-label="Resize the key column"`) moves by 16 px on ArrowRight, resets on double-click, keeps its width after remount, and works when localStorage throws; file rows still show the file picker.
- [ ] **Step 2:** fails.
- [ ] **Step 3: Implement.** Height from `scrollHeight` in a layout effect, re-measured on width changes (ResizeObserver, guarded: jsdom has none). Width clamped to 120–600 px. Pointer handling as in Sidebar's `.resizer`. Update `.kv td input` rules (including `tr.off` and Grove) to cover textarea.
- [ ] **Step 4:** test file and full suite pass. Screenshot Headers with a long token, and response Headers and Cookies, in each look at wide and narrow widths; nothing is cut off.
- [ ] **Step 5:** commit `Long values wrap in key/value tables; resizable key column`, then push, PR, desktop check on the Predator.

---

# PR 2: extract into variable (branch `feature/extract`)

### Task 4: Working out the source

**Files:** Create `src/core/extract.ts`; modify `src/core/scripts.ts` (export `fmt`), `src/core/share.ts` (`isSecretName(name: string): boolean`); test `tests/extract.test.ts`.

**Interfaces — Produces:**
```ts
type Source = { ok: true; expr: string; value: string; name: string; unique: boolean } | { ok: false; reason: string }
jsonSource(text: string, from: number, to: number): Source
headerSource(name: string, value: string): Source
textSource(body: string, from: number, to: number): Source
bodySource(text: string, from: number, to: number): Source // JSON.parse(text) works → jsonSource, else textSource
type Scope = 'env' | 'collection' | 'globals'
ruleLine(scope: Scope, name: string, expr: string): string
withRule(script: string, scope: Scope, name: string, expr: string): string
extractedTargets(script: string): { scope: Scope; name: string }[]
```
- [ ] **Step 1: Failing tests**
  - `{"data":{"token":"abc"}}`, selecting `b`: expr `dx.response.json('data.token')`, value `abc`, name `token`. Selecting the key gives the same.
  - `items[0].id` number `7`; root array `dx.response.json('[0]')`; booleans; an object value is its `fmt` text; `null` is refused ("This value is empty").
  - Key `user name`: `dx.response.json()['user name']`, continuing with `?.['id']`, `?.[0]`. Keys with a dot, quote, backslash, unicode escape, or only digits take this form.
  - Escaped strings decode; duplicate keys use the last; whitespace-only and selections spanning two values are refused ("Select one value"). A whole object selected exactly is that object.
  - Every successful JSON expr, run through `runScript` against that body, equals `value`.
  - Header: `dx.response.headers.get('X-Request-Id')`, name `xRequestId`.
  - Text: `<t>abc</t>` selecting `abc` gives a regex whose run through `runScript` returns `abc`; regex characters, `/` and newlines in the context are escaped; a repeated pattern has `unique: false`; multi-line selections work. Same for a CRLF body, given the LF text the viewer shows.
  - `ruleLine('env','token',"dx.response.json('data.token')")` equals `{ const v = dx.response.json('data.token'); if (v != null) dx.env.set('token', v) } // extracted`; names with quotes are escaped.
  - `withRule` appends on a new line (also after a trailing `//` comment), replaces its own marked line, leaves unmarked lines alone; a different scope adds a line. `extractedTargets` ignores unmarked lines.
- [ ] **Step 2:** fails. **Step 3: Implement** with a small recursive tokenizer keeping spans. In regexes turn each context newline into `\r?\n`. **Step 4:** passes.
- [ ] **Step 5:** commit `Work out a rule for a selected response value`.

### Task 5: Rules persist everywhere

**Files:** `src/core/flows.ts`, `src/ui/useWorkspace.ts`, `src/ui/mcpHost.ts`; test `tests/flows.test.ts`, `tests/extract-persist.test.tsx`.

**Interfaces — Produces:** `FlowRun.collections: Record<string, KV[]>` (changed ones only).

- [ ] **Step 1: Failing tests:** for each of env, collection, globals: Send, Runner, flow and an MCP collection run leave the new value in storage (read back through `db`). In a flow, the second request sees a collection variable the first one set. Review Focus 2: response `{"error":"x"}` leaves `token` at `old`. Review Focus 5: the row still has `secret: true`.
- [ ] **Step 2:** the flow and MCP collection cases fail; the rest pass (they document what already works).
- [ ] **Step 3: Implement:** `runFlow` keeps its own collection copies; `runFlowNow` and `afterRun` save changed ones with `updateCollection`. **Step 4:** passes.
- [ ] **Step 5:** commit `Keep collection variables set by scripts in flows and assistant runs`.

### Task 6: Right-click and dialog

**Files:** Create `src/ui/ExtractDialog.tsx`; modify `src/ui/ResponsePane.tsx`, `src/ui/CodeArea.tsx`, `src/ui/useWorkspace.ts`, `src/ui/App.tsx`, `src/ui/app.css`, `docs/SCRIPTS.md`; test `tests/extract-ui.test.tsx`.

**Interfaces — Consumes:** Task 4. **Produces:** `CodeArea` prop `onContextMenu?: (e: React.MouseEvent, sel: { text: string; from: number; to: number }) => void` (`text` is the editor's own document); `ws.extractVariable(o: { scope: Scope; name: string; value: string; secret: boolean; expr: string }): Promise<() => Promise<void>>` resolving to undo.

- [ ] **Step 1: Failing tests**
  - Right-click with a selection offers Copy and "Extract into variable…"; with none it is disabled with "Select a value first"; with a JSON filter, "Clear the filter first". Header rows offer it on their value. Shift+F10 works. The sent, preview, visualize and binary views don't offer it.
  - Dialog: name suggested; Save to defaults to the active environment; without one that option is disabled with "No environment selected" and the next allowed scope is chosen; "This collection" is disabled for a request in none. Existing row: "Replaces the current value", Secret follows its flag, and a secret current or new value is masked. Empty or `{}`-containing names can't be extracted. A non-unique text match shows a warning and still extracts.
  - Extract: value stored, row `secret` as ticked, the draft has the rule and is unsaved, toast "Saved {{token}}. Every send of this request refreshes it. Save the request to keep the rule." Undo restores the value and flag (or removes the new row) and takes out only the rule, keeping later script edits.
  - A row with options: the active option's value changes too (`syncLayerValues`). A disabled row of that name is enabled.
  - "Sets {{token}}" shows under the postmark and opens Scripts → After response.
- [ ] **Step 2:** fails. **Step 3: Implement.** In CodeMirror use `view.state.selection.main`; in the textarea `selectionStart/End`; in the big-body `<pre>` a Range measured from its start. `docs/SCRIPTS.md` gets a section "Extract into variable".
- [ ] **Step 4:** tests and full suite pass; a headless run in real CodeMirror (CRLF body included) extracts a token and the next request sends it.
- [ ] **Step 5:** commit `Extract into variable from a response`, push, PR, Predator check.

---

# PR 3: Secrets section (branch `feature/secrets-section`)

### Task 7: Variables and Secrets tables

**Files:** Create `src/ui/VariablesEditor.tsx`; modify `src/ui/KVTable.tsx` (drop `allowSecrets`), `src/ui/ValueField.tsx`, `src/ui/Editors.tsx`, `src/ui/app.css`; test `tests/secrets-section.test.tsx`, existing tests that click the checkbox.

**Interfaces — Produces:** `VariablesEditor({ label, rows, onChange }: { label: string; rows: KV[]; onChange: (rows: KV[]) => void })`; `KVTable` prop `rowMenu?: (row: KV, i: number) => [string, () => void][]`.

- [ ] **Step 1: Failing tests**, for all three editors: two tables, "… variables" and "… secrets"; a row added under Secrets has `secret: true`; its value is a password input, "Show <name>" reveals only that row and it is masked again after leaving the screen; "Make secret" and "Make plain" move the row to the end of the other section without a dialog; order within each section is kept; `api_token` as plain shows "Looks like a secret: make it secret?" and only moves when clicked; a row with options keeps them when moved, and editing it keeps the layer in step; the note reads "Hidden on screen, left out of backups, and only synced in the encrypted secrets file if you turn that on". No Secret checkbox remains.
- [ ] **Step 2:** fails. **Step 3: Implement:** split by flag, recombine as plain rows then secret rows only for a moved row; edits keep each row's place in the array, so saved files don't reorder. **Step 4:** test file, `vault`, `workspacefiles`, `secretsVault` and full suite pass; screenshots in each look.
- [ ] **Step 5:** commit `A Secrets section for variables`, push, PR, Predator check.

---

# PR 4: cookies per environment (branch `feature/env-cookies`)

### Task 8: Jars and storage

**Files:** `src/core/cookies.ts`, `src/core/db.ts`; test `tests/cookies.test.ts`.

**Interfaces — Produces:** `jarKey(environmentId: string | null, workspaceId: string): string`; `class CookieJars { get(key: string): CookieJar; delete(key: string): void; load(m: Record<string, StoredCookie[]>): void; entries(): Record<string, StoredCookie[]>; onChange?: () => void }`; `db.getCookieJars(legacyKey: string): Promise<Record<string, StoredCookie[]>>`, `db.putCookieJars(m)`.

- [ ] **Step 1: Failing tests:** `jarKey('e1','w')` is `e1`, `jarKey(null,'w')` is `none:w`; jars don't share; a change in any jar calls `onChange`; stored map round-trips sealed; a legacy list comes back as `{ [legacyKey]: list }`; unreadable data gives `{}` without overwriting what is stored; empty jars aren't saved.
- [ ] **Step 2:** fails. **Step 3: Implement** (same meta key `cookies`, array means legacy). **Step 4:** passes. **Step 5:** commit `Cookie jars per environment: storage`.

### Task 9: Sends use the run's jar

**Files:** `src/core/transport.ts`, `src/core/runtime.ts`, `src/core/scriptPipeline.ts`, `src/core/browserPipeline.ts`, `src/core/auth.ts` callers, `src/ui/useWorkspace.ts`; test `tests/cookies.test.ts`.

**Interfaces — Produces:** `SendOptions.jar?: string`; `CookieTransport(inner, jars: CookieJar | ((key?: string) => CookieJar), enabled?)`; `browserHook(launcher, jar?: (ctx: RunContext) => CookieJar | null)`; `ws.cookieJar(): CookieJar | null` for the active environment.

- [ ] **Step 1: Failing tests:** a cookie set under env A isn't sent under B or none; Runner, flow, `dx.send` in a script, the auth retry and a browser login use the run's jar; Review Focus 4: switch env between send and response, the cookie lands in A; a run without an environment uses `none:<the collection's workspace>` (active workspace when it has no collection); the CLI still shares one jar per process; the "Keep cookies" setting off sends none.
- [ ] **Step 2:** fails. **Step 3: Implement:** `execute` sets `opts.jar` from `ctx`; script and auth sends receive `ctx`; an absent key means the active environment's jar. **Step 4:** passes. **Step 5:** commit `Each environment keeps its own cookies`.

### Task 10: Screen, upgrade and delete

**Files:** `src/ui/useWorkspace.ts`, `src/ui/SettingsView.tsx`; test `tests/cookies-ui.test.tsx`.

- [ ] **Step 1: Failing tests:** title "Cookies for staging" / "Cookies for No environment"; a line says each environment keeps its own cookies; switching environment while the screen is open shows the other jar; "Clear all" clears only that jar and the toast names it; a legacy list appears only under the environment active at first start; deleting an active environment deletes its jar and the app uses the none jar; a workspace switch changes the none jar; a pending save is written when the app closes soon after (flush on `pagehide`).
- [ ] **Step 2:** fails. **Step 3: Implement.** Migrate after settings and spaces are loaded, and save the map at once. **Step 4:** tests, full suite, typecheck, build pass.
- [ ] **Step 5:** commit `Cookies screen per environment`, push, PR, Predator check (log in under two environments, restart, both stay separate). Then update CLAUDE.md, Kan and memory.
