# The built-in assistant: rules for developers

The desktop app has an assistant that answers questions about the workspace you have open: why a test fails, what a
script does, how to write the next one. The person connects a model (Anthropic, OpenAI, or an OpenAI-compatible address,
for example one on this computer). It reads, and it can propose changes to requests, scripts and variables. A change is
written only after the person presses Apply (Delete for a deletion) on its card. It never sends or runs anything.

Code: `src/core/assistant/` (connections, gate, loop, providers, chats), `src/ui/assistant/` (the hook, panel, settings,
dialogs) and `src-tauri/src/ai.rs` (sends and streams, because the webview's CSP can't reach AI hosts). The privacy page
(`site/build.py`) and the README promise what these rules enforce: change them together.

## Rules to keep

### One gate for tools (`gate.ts`)
- A tool runs only through `runTool`: an offered tool, input that fits its schema (unknown fields are refused), the open
  workspace, and only while the workspace is the one the question was asked in. A mid-answer switch is refused.
- It never sends, twice, and changes only through an approved proposal. No tool that sends is offered or has a class
  (`tools.ts`; a name without a class never runs), and what the gate hands to `handleMcp` couldn't send anyway: a method
  list no request matches (an empty list means *every* method), a transport whose `send` throws, an empty pipeline, no
  flows, no hooks and no outside-assistant workspace. Edit tools never reach `handleMcp`.
- `offeredTools(conn, job)` is asked for the offer and again in the gate. Under 16,000 context tokens the edit tools come
  only with the job "Scripts and variables" (four, and `suggest_parameters`): descriptions fill a small context.
- History entries without a collection belong to no workspace, so the chat doesn't see them. Cost: unsaved sends are
  invisible to it. The console can't be attributed to a workspace: it is behind the connection's own tick and the consent
  question says it covers all workspaces.

### One exit for data
- Everything that leaves goes through the `Redactor` built from `allSecrets` (every workspace, history, connection keys,
  sign-ins, cookies, certificate keys). A new source of data is added to `allSecrets` and to `prepare`.
- Data is cleaned before `handleMcp`, which cuts and hides patterns itself: half a secret could survive otherwise. It is
  cleaned again after, then cut to size, then wrapped as data with a random mark the content can't know.
- A summary is made from what was said, without tool results. Less data leaves; summaries are thinner.

### Proposals (`propose.ts`, `parameters.ts`)
- The edit code (`workspaceCall`) runs on the open workspace with cleaned names and only captures what it would save. The
  real names are put back, and what is left is checked. Nothing is written here. Lookup by cleaned name can't tell
  whether a hidden text is there.
- `<hidden>` is refused in what would be written; a path may hold it, so a request with a secret in its name can be
  reached. Reads refuse it everywhere. Cost: such a request can't be read with `get_request` or parameterized.
- No value the model wasn't shown is replaced or removed (`heldInRequest`, `badVariables`, `lost`); a variable marked secret
  can't be set or removed at all. Exceptions: a header may be replaced by a lone `{{variable}}`, `apply_parameters` moves
  a hidden value without showing it, and a whole request may be deleted. The check comes before the edit code answers,
  so an answer can't tell a right guess from a wrong one. Cost: a script holding a known secret can't be edited.
- The chat can't write a literal where it becomes a known secret (`places.ts`), because a known value is hidden wherever it
  is: by what else goes missing, a made-up one tells whether a guess at a hidden value is right, about a character per
  card. Decided by the place, never by a value. `set_variables`: a new variable with a secret's name is made secret and
  empty, one that is there is the person's. Headers with a secret's name (and key headers, which can be moved to a secret
  variable): only `{{variable}}`, also after Bearer, Basic, Digest or Token. Query parameters with a secret's name: only
  `{{variable}}`. A URL that holds what looks like a secret is refused. `apply_parameters` moves values, but a readable
  one never to a secret's name. A new source in `allSecrets` that the chat can write needs the same. Cost:
  `Cookie: sid={{sid}}`, and IDs in a path like `/tokens/12`, need another way or name.
- What was known as a secret before a change that was written stays hidden in every chat until Dispatch closes (`kept` in
  `useAssistant.ts`): the change may have taken away the one place it was known from.
- Control characters in a URL, name or path the model gives are refused, and one-line values are drawn on one line, so
  one can't look like another row. Cost: a record whose name has one can't be reached by the chat.
- Two records at the same path, a record outside the open workspace, the assistant's own workspace and an open tab with
  unsaved edits of the request are refused. Cost: the person renames, or saves or discards, first.
- The card shows everything that would change: "before" cleaned; "after" exactly as the model gave it, otherwise cleaned;
  control, zero-width and direction characters as codes; one row per variable
  (with its alternatives) or header. A change that can't be drawn is
  refused.
- Warnings name what can be told: scripts, a new address for a sign-in (compared environment by environment), a secret
  used in a place it wasn't, how many requests are reached, schedules that send. Stricter is fine, silence isn't. A secret
  stays `{{name}}` in an address, because a URL parser changes its case and shape before it could be hidden.
- `suggest_parameters` lists what could move, with ids and no values. Which lines there are, their order and names tell
  nothing about a hidden value except that a variable marked secret is in the request. Cost: some suggestions the
  Parameterize panel makes are missing here. A batch counts only while the request and the variables are as they were.
- `apply_parameters` decides what may move under made-up names, so whether a chosen name is a hidden value changes nothing.
  New names are letters, digits, `_`, `-` and `.` only: others could end the pattern that hides the text next to them.
- The console names a record the chat made up only once its card is applied (the chat may read the console).
- `apply_parameters` is refused when the request would then send something else. With another sign-in than bearer, a
  bearer header stays and takes the variable. Environment variables with a secret's name are made secret and empty.
- The chat's parameter tools are **not** offered to outside assistants. They were built and withdrawn (f4bd384, 1ce6222):
  without an approval per call, unlimited calls make every answer about a hidden value a guessing game.

### Approval, apply and undo (`useAssistant.ts`, `useWorkspace.ts`)
- Each edit and delete is approved by itself, for these arguments and this state. There is no "always allow". A
  proposal's `basis` (the active environment, environments, globals, collections, folders but not their order, enabled
  schedules) is compared on approval, when its turn to write comes and right before the transaction (schedules as read on
  approval), and so are the records; any difference ends the card as expired. It is dropped when the card ends. Cost: a
  script's own writes (a run that stores a variable), or a folder sync, expire a waiting card. So does an unsaved tab.
- An approval doesn't survive a stop, another workspace, a changed or removed connection, or a restart.
- The write is one transaction; the screen follows once it has committed. What the person writes meanwhile is put on top.
  Stop while it is being written: the write decides, and the panel and the model hear "applied". A failure while drawing
  doesn't make it untrue. When the outcome is unknown, the card and the model are told to look at it.
- Editors (`Editors.tsx`, `CodeArea.tsx`) take applied changes up, so the next keystroke doesn't write old text back.
- A delete of a request the person edited in that instant leaves their version, and isn't called applied.
- Undo puts back the records as they were only when they are still as they were applied, and shows what changed since
  otherwise. Without it: undo would overwrite the person's work.
- Cards, previews and undo are in memory only: never in saved chats, backups, logs or telemetry. Cost: they end when
  Dispatch closes, and deleting a chat drops its undo (a deleted request is still in the ordinary Undo list). The model's
  own call, with the text it proposed, is part of the chat like any message. The console gets one line per decision:
  outcome, tool and the record's cleaned name.
- The model isn't told about an undo, because messages are only added. It finds out at its next read, and may speak of an
  undone change as present until then.
- 25 tool calls and 10 minutes per message; the clock stands still while a card waits.

### The card (`ChangeCard.tsx`)
- It draws only a proposal's title, fields and warnings, as plain text. Warnings are never cut. Over 200 lines or 20,000
  characters it folds, and Apply waits until all of it was shown.
- Buttons are dead for 500 ms after they appear, move or change, and for a held key: a click meant for something else
  must not decide. Undo follows the same rule. Each announcement is a new node, so the same words are heard again.

### Binding and consent
- A chat, a consent, a summary, a running job and a send are tied to connection, model and origin (scheme, host, port). A
  chat stores its origin and can't go on with another one: local text must not move to a cloud host.
- A changed origin clears the consent, key, context size and tool check, and turns the console off unless the new address
  is this computer. Moving back never turns it on again. A change of path only keeps everything. Addresses change only
  through `withBaseUrl`, and are validated again at every send.
- Anthropic and OpenAI connections have fixed official addresses, so a key can't be pointed elsewhere. A gateway uses the
  compatible kind.
- Consent is enforced in `ask()`, not in `nativeFetch`, so Test and Load models work before it. They carry no workspace
  data. Cost: one layer instead of two; a test pins it.

### Network (`nativeFetch.ts` and `ai.rs`, both check)
- The request must go to the connection's own origin. The webview sends the connection's origin, not the request's, so
  Rust really compares the two.
- Plain http only for the literal host `localhost` and literal loopback, private or link-local IP addresses: names can be
  re-pointed. Cost: a name on the local network needs https or its IP address.
- No redirects. A proxy is used only for https targets (on plain http it would read the key) and never for loopback.
  Cost: an http target behind a mandatory proxy can't be reached.
- Failures come in two ways, a refusal before anything is sent and an error event after; the adapter handles both.
- Request ids are random and events after an abort are dropped.

### Reading a model's stream (`providers/`)
- A clean end with a `finish_reason` is a whole answer without `[DONE]`, because some servers leave it out; `[DONE]`
  without a `finish_reason` is not. Cost: a connection cut exactly after the reason counts as complete, which it is.
- When a stream doesn't clearly say which call a piece belongs to, only calls that came whole in one piece are valid.
  Cost: some unusual servers' calls without arguments are refused.
- The SSE parser gives a CR-ended line at once and skips the LF that may follow in the next chunk.
- If Anthropic's server-side fallback answered with another model, the person is told which.

### The conversation (`loop.ts`)
- Messages are only ever added, and can always be sent again: every call has a result, a turn that didn't finish adds
  nothing, and refused or empty messages aren't appended. An empty answer is an error that says so.
- After a stop or an error two questions can follow each other. The stored messages stay as they are; the
  chat-completions request joins them, because strict chat templates refuse two user messages in a row. Anthropic's API
  combines them itself.
- A provider made for another connection is refused.

### The panel
- Model text is untrusted: bounded, safe Markdown, no raw HTML, links opened only after a check. Tool results, names and
  responses are data, never instructions.
- While typing in the chat, Ctrl+S, Ctrl+T and Ctrl+W do nothing to the tab behind it.
- `AssistantGate` loads the lazy chunk only once a connection exists. Without one, no assistant code runs.

### What is kept
- Keys and chats are sealed on the device, per workspace for chats (the last 50), never in backups, exports, folders or
  sync. `keepChats` (default on) and delete-all exist.
- Deleting a workspace deletes its chats. `removeSpace` and `renameSpace` use `spacesRef`: a stale list plus the sweep of
  orphans could delete live chats.

## Limits we state, and don't hide
- Apply protects against a change nobody approved, not against one that was. An applied script runs when the person (or a
  schedule of theirs) sends the request; it can read variables, secret ones included, and send requests. An applied
  address is where the next send goes. The card warns on a best effort: it can't know what a script will do or make.
- Nothing is sent by applying, but an enabled schedule sends what it names, as before, while Dispatch is open. The card
  says so. A linked workspace's folder gets the change, like the person's own edits.
- Hiding is a best effort. A secret Dispatch doesn't know, pasted under an ordinary name, can go to the model. Ordinary
  data isn't hidden.
- Known secrets shorter than 6 characters are hidden in their own field, but not where the same text recurs elsewhere
  (hiding "admin" or "1234" everywhere would garble ordinary text).
- A known value that crosses a text hidden by its pattern hides its neighbours too. The chat can't make one by an edit
  (see Proposals), but a person's send can: a header filled from a variable the chat set is in the history as a secret.
  So can a script that runs.
- A whole known secret the model guessed comes back as `<hidden>` in a text it wrote and the person approved, so a short or
  guessable one can be confirmed that way. That needs the whole value, never a part of it. Refusals don't repeat what the
  model wrote unless something is there by that name (`assistant-oracle.test.ts`); keep that for every new one.
- What a change took away is remembered in memory only: after a restart, a copy of it elsewhere under an ordinary name is
  ordinary data.
- Base64 and HTML-escaped forms of a secret aren't recognised.

## Open minor points
- Rust: `finish` isn't in a drop guard.
- `db.ts`: an import in the middle of the file; `putConnections` reads then writes, not atomically; a fixed-kind record
  without `baseUrl` is skipped.
- The Anthropic SDK prints deprecated-model warnings with the model's name; its stream parser has only the per-line limit.
- Servers that repeat a call's name after an empty first piece are refused.
- Cookie parts over-hide ordinary words of 6 or more letters. A JSON string of about 30 MB overflows the regex stack (the
  tool answers with an error).
- `deleteChats(spaceId)` can't find records a damaged index forgot (delete-all can).
- Settings: the address error stays after the address is put back; a console tick or context size edited at the same time
  elsewhere survives a move.
- Hook: 'stopped' without an explanation when the connection changes; `openChat` stops the answer even if the chat can't
  be opened; a summary's transcript is cut before keys are hidden; a retry after a failed read-back can duplicate; the
  selected connection isn't remembered.
- Panel: Ctrl+K in the chat goes to the sidebar search; focus after blur isn't verified in a real webview; "Open Settings"
  can't go straight to the AI tab; below 1200 px the panel covers the request's Send.

- Proposals: odd address wording for `https:\\{{token}}`; no
  warning when a secret moves between two headers or two fields, when `create_request` goes where scripts run, or for
  `{{scheme}}://host` and path-variable hosts; warnings belong in their own file.
- Gate: history is gathered twice (`prepare` and the cleaner); "never offered" is tested for the default job only.
- Parameters: choosing a path ID together with an existing variable of the same name is refused; some refusals are stricter than needed; `token2` can come as a duplicate;
  exact headers go by index; a swap can be left out where the same short text is both readable and hidden in one place
  (cleaner spans would fix it).
- Apply and undo: in `useWorkspace.ts`, which is long; plain writes to one record aren't ordered while sealing; a request
  moved out during "take the folder's version" shows twice; `placeItems` and `sortByName` have no roll-back;
  two overlapping failing first saves for the assistant workspace can leave its list wrong.
- Approval: a write queued at Stop still starts and is reported as applied; the card logic could be its own hook; undo's
  console line uses the render's lists.
- Card: copying a diff copies the spoken prefixes; timing of
  the "stay applied" announcement; buttons can be half cut at the log's edge; clipping on Safari; Tibetan and pointed
  Hebrew marks show as codes; "what changed since" isn't reset when a new one comes; one CSS test is a regex.

## Tests
`tests/assistant-*.test.*`, `tests/use-assistant.test.tsx`, `tests/apply-proposal.test.tsx`, and `cargo test --lib ai::` in `src-tauri`. On a loaded
machine the first `App` render can take over a second: raise the test's wait, don't loosen the code.
