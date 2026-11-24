# Extract into variable, Secrets section, cookies per environment, and editing polish

Owner request, 2026-11-23. Six changes to the Dispatch app (web + desktop). Copy in the app stays Dispatch's own:
warm, plain, never naming or comparing another tool (repo rule, CLAUDE.md top).

## Why

The owner works through login flows: a login request returns a token, and later requests need it. Today that means
copying the token by hand, or writing a test script line by hand. The other five are friction found while testing
0.1.0: long header values are cut off, a second pasted curl keeps the old name, cookies leak between environments
(for example a staging session cookie sent to production), secret variables are a checkbox column that's easy to
miss, and renaming takes a menu and a dialog.

Success: log in once, right-click the token in the response, choose "Extract into variable", and every later send
of the login request refreshes `{{token}}`, in the app, the runner, flows and the CLI.

## Goals

1. **Extract into variable** from a response: right-click a selected value in the body or a header value, give a
   name and scope, and get a rule that refreshes the variable on every send.
2. **Long values readable** in the key/value tables (request headers, params, variables).
3. **Curl paste names the request** each time, unless the person renamed it themselves.
4. **Cookies per environment** on desktop (and in runs that use an environment).
5. **A Secrets section** in the variable editors instead of the "Secret" checkbox column.
6. **Rename in place** by double-click or F2 in the sidebar.

## Non-goals

- No new request format or file-format fields (the extraction rule is script code; secrets keep the existing
  `secret` flag). Workspace folders, the encrypted secrets file, backups and Postman export stay as they are.
- No per-environment cookies in the web app: the browser owns cookies there (as today).
- No extraction from Preview, Visualize or binary bodies.

## Anti-goals

- Hidden magic: a rule must be visible and editable as ordinary script code.
- Losing data: no existing variable value, script or cookie may be dropped silently.
- Leaking secrets: an extracted value marked secret must not show in clear text anywhere it didn't before.

## Approach for the extraction rule (owner picked A, 2026-11-23)

- **A (chosen): a script line.** "Extract into variable" appends a marked line to the request's "After response"
  script, e.g. `dx.env.set('token', dx.response.json('data.token'))`. Scripts already run on Send, in the runner,
  flows, the CLI, linked folders and Postman export, so the rule works everywhere with nothing new. Trade-off: it
  lives in Scripts, so the response shows a small note saying which variables the request sets.
- **B (rejected): an "Extract" table per request**, run by Dispatch. Friendlier for non-scripters, but a new
  request-format field the runner, CLI, folder files, MCP tools and Postman export would all need to learn.

## Design

### 1. Extract into variable

**Where:** the response Body viewer (CodeMirror, read-only) and the response Headers table. Right-click with a
selection (body) or on a header row (headers; the value is the whole header value) opens the app's own context menu
(`src/ui/ContextMenu.tsx`) with **Extract into variable…** (plus Copy). Without a selection in the body, the item is
disabled with a hint ("Select a value first").

**Working out the source (`src/core/extract.ts`, new, no React):**
- **JSON body:** the viewer shows pretty-printed JSON (`shown`), so map the selection on that text: tokenize `shown`
  with positions, find the innermost value whose span contains the selection (selecting part of a string selects the
  whole string; selecting a key selects its value). When every segment is a plain identifier or an array
  index, use the path form `dx.response.json(path)` already understands (`dig` in `src/core/scripts.ts`):
  `dx.response.json('data.token')`, `dx.response.json('items[0].id')`. Otherwise (a key with a dot, space or other
  character `dig` can't address) write plain JavaScript on the parsed body instead of changing `dig`:
  `dx.response.json()['user name']?.[0]?.['id']`. *(Builder's call: keeps the script runtime unchanged.)*
- **Is it JSON?** Decided by content, as the viewer does: if the body parses as JSON, the JSON path is used, whatever
  the Content-Type. If the viewer shows only the first part of a large body ("Show all" not pressed) and that part
  doesn't parse, use the text rule below.
- **Header:** `dx.response.headers.get('<Header-Name>')`.
- **Other text (XML, HTML, plain):** build a regular expression from up to 20 characters of literal text before and
  after the selection (escaped), capturing the selection's shape (`([^"<\s]+)`-style, chosen from the characters
  the selection contains). Expression: `(dx.response.text().match(/…/) || [])[1]`. If the before/after text doesn't
  make the match unique in the current body, say so in the dialog and still allow it.
- Pure functions with unit tests for each case (nested objects, arrays, escaped strings, numbers, booleans, null,
  unicode keys, selection spanning two values = refuse with a message).

**Dialog (`ExtractDialog.tsx`):** shows the value found (masked if Secret is ticked) and the expression (read-only,
monospace), then:
- **Name** (required; suggested from the last path segment or header name, e.g. `token`, `requestId`).
- **Save to:** Active environment (default when one is active), This collection, Globals. Without an active
  environment, the environment option is disabled with "No environment selected".
- **Secret** tick (default on when the name or path looks secret, same rule as `isSecretName`).
- Button **Extract**.

**What Extract does:**
1. Sets the variable now, from the response on screen, in the chosen scope (creating the row if missing; a row
   created with Secret ticked has `secret: true`). Environment and collection changes save like other edits.
   If the row already exists, its value is replaced (that is the point; Undo brings it back). The dialog shows the
   current value under the name when one exists ("Replaces the current value"), and the Secret tick starts from the
   existing row's flag; ticking it makes the row secret, unticking an existing secret row makes it plain.
   *(Builder's call.)*
2. Adds the rule to the request draft's after-response script:
   `dx.env.set('token', dx.response.json('data.token')) // extracted`
   (`dx.collection.set` / `dx.globals.set` for the other scopes). If a line with the same target
   (`dx.<scope>.set('<name>',`) and the `// extracted` marker exists, replace it instead of adding another.
3. The request is then unsaved (as any edit); the toast says "Saved {{token}}. Every send of this request refreshes
   it. Save the request to keep the rule." with an Undo.

**Where the rule goes:** always the request's own after-response script, never a folder or collection script.
Replacement and the "Sets" note only look at lines ending in `// extracted`; a line the person rewrote by hand
without the marker is theirs, and a new Extract adds a fresh marked line. Undo in the toast reverts both the
variable value and the script line.

**Persistence (check, then fill gaps):** a rule only "refreshes on every send" if `dx.env.set`, `dx.collection.set`
and `dx.globals.set` changes made by an after-response script are written back to storage after a Send, a runner run
and a flow run. Flows already write back environment and globals (`runFlowNow` in `useWorkspace.ts`). The plan must
check each path (Send, runner, flow) for each scope and add the missing write-backs, with tests. In the CLI the
change lasts for that run only (there is no storage), which is expected: a login request earlier in the run feeds
later requests.

**Visible rule:** under the response postmark, a small line lists the `// extracted` targets of the request's
script, e.g. "Sets {{token}}", linking to Scripts → After response.

**Docs:** `docs/SCRIPTS.md` gets a short "Extract into variable" section; the changelog gets an entry.

### 2. Long values in key/value tables

`KVTable` value cells (request headers, params, form fields, variables) become a wrapping text field that grows to
show the whole value (one line when short, up to about 8 lines, then scrolls). Enter doesn't insert a newline
(values stay single-line; Enter moves on as today). The key column gets a sensible width with a drag handle between
the key and value headers (width kept per table in localStorage). The response Headers table already wraps; check
it and the response Cookies table show full values too.

### 3. Curl paste names the request

On curl paste into the URL field, the name changes to the new `nameFromUrl(url)` when the current name is still an
automatic one: "New request", or `nameFromUrl` of the URL the draft had before the paste. A name the person typed
themselves stays. Same rule for typing over the URL? No: only paste of a curl command (owner's ask).

### 4. Cookies per environment (desktop and runs)

- One cookie jar per environment, plus one for "No environment" per workspace. Key: environment id, or
  `none:<workspaceId>`.
- The desktop `CookieTransport` uses the jar of the active environment; switching environment switches jar. The
  browser-login hook (`browserPipeline`) reads and writes the same jar.
- The runner and flows use the jar of the environment the run uses. The CLI (`dispatch-run`) already makes a fresh
  jar per process; no change.
- Storage: IndexedDB meta `cookies` becomes a map `{ [jarKey]: StoredCookie[] }`, sealed as today. Upgrade: the
  existing single list moves to the jar of the active environment of the active workspace when the app first starts
  after the update (or that workspace's "No environment" jar), so the session in use keeps working. Other
  workspaces and environments start with empty jars (cookies are session data; at worst the person logs in again).
  *(Builder's call.)*
- Runs without an environment use the "No environment" jar of the workspace the run belongs to.
- Deleting an environment deletes its jar (also when it was active; the app then uses the "No environment" jar). Backups don't include cookies (unchanged).
- Cookies screen: title "Cookies for <environment name>" (or "No environment"), shows and edits that jar; a short
  line says each environment keeps its own cookies. "Keep cookies between requests" in Settings stays global.
- Web app: unchanged; the Cookies screen keeps its note that the browser owns cookies.

### 5. Secrets section

In the environment editor, and the collection-variables and globals editors (the same `KVTable allowSecrets`, so
all three stay consistent):
- Two tables: **Variables** and **Secrets**. Secrets has its own short note ("Hidden on screen, left out of
  backups, and only synced in the encrypted secrets file if you turn that on").
- Secret values show as dots with a per-row eye button to reveal; copying works on the real value.
- Each row has a menu item to move it: **Make secret** / **Make plain**. A moved row goes to the end of the other
  section. "Make plain" needs no confirmation: it is an explicit choice about the person's own value. Adding a row
  in Secrets creates it with `secret: true`.
- A plain row whose name looks secret (`isSecretName`, e.g. `api_token`) stays where it is, with a small
  "Looks like a secret: make it secret?" hint on that row. Nothing moves on its own. *(Builder's call.)*
- Rows with options (`VarOption`) follow their flag like any other row.
- The "Secret" checkbox column goes. Data stays one `variables` array with the `secret` flag; the order of rows is
  kept within each section.
- Everything that already treats `secret` specially (backups, folder files, vault, MCP hiding, share) is unchanged.

### 6. Rename in place

In the sidebar, double-click (or F2 on a focused row) on a request, folder, collection, flow or environment turns
its name into an input with the name selected. Enter saves (same actions as today's Rename), Esc cancels, blur
saves, an empty name cancels. Single click stays instant (no delay to wait for a second click). Double-clicking a folder or collection
puts its expanded/collapsed state back to what it was before the two clicks, then starts the rename; a short flicker
is acceptable. F2 works on any focused sidebar row. *(Builder's call.)* The ⋯ menu's Rename starts
the same inline edit instead of the dialog. The request title in the request pane is already editable; unchanged.

## Delivery

Four PRs, each with tests, `npm run typecheck`, `npm run build`, and a desktop build checked on the Predator
before merge (owner merges):
1. Polish: rename in place, curl naming, long values (2, 3, 6).
2. Extract into variable (1).
3. Secrets section (5).
4. Cookies per environment (4).

## Calls made while writing (owner can overrule)

Marked *(Builder's call)* above: plain-JavaScript paths for odd JSON keys, how Extract treats an existing row,
which jar gets today's cookies, the "looks like a secret" hint, no confirmation for Make plain, and how
double-click on a folder behaves.

## Left to the builder

Exact component names and file split, the tokenizer implementation, CSS details within the existing tokens, test
file layout, and the wording of small hints (warm and plain).
