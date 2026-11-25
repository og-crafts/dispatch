# The built-in assistant: rules for developers

The desktop app has an assistant that answers questions about the workspace you have open: why a test fails, what a
script does, how to write the next one. The person connects a model (Anthropic, OpenAI, or an OpenAI-compatible address,
for example one on this computer). This version only reads. It can't change, send, run or delete anything.

Code: `src/core/assistant/` (connections, gate, loop, providers, chats), `src/ui/assistant/` (the hook, panel, settings,
dialogs) and `src-tauri/src/ai.rs` (sends and streams, because the webview's CSP can't reach AI hosts). The privacy page
(`site/build.py`) and the README promise what these rules enforce: change them together.

## Rules to keep

### One gate for tools (`gate.ts`)
- A tool runs only through `runTool`: an offered tool, input that fits its schema (unknown fields are refused), the open
  workspace, and only while the workspace is the one the question was asked in. A mid-answer switch is refused.
- Read only, twice. The gate refuses every other tool, and what it hands to `handleMcp` couldn't send anyway: a method
  list no request matches (an empty list means *every* method), a transport whose `send` throws, an empty pipeline, no
  flows, no hooks and no outside-assistant workspace.
- History entries without a collection belong to no workspace, so the chat doesn't see them. Cost: unsaved sends are
  invisible to it. The console can't be attributed to a workspace: it is behind the connection's own tick and the consent
  question says it covers all workspaces.

### One exit for data
- Everything that leaves goes through the `Redactor` built from `allSecrets` (every workspace, history, connection keys,
  sign-ins, cookies, certificate keys). A new source of data is added to `allSecrets` and to `prepare`.
- Data is cleaned before `handleMcp`, which cuts and hides patterns itself: half a secret could survive otherwise. It is
  cleaned again after, then cut to size, then wrapped as data with a random mark the content can't know.
- A summary is made from what was said, without tool results. Less data leaves; summaries are thinner.

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
- Hiding is a best effort. A secret Dispatch doesn't know, pasted under an ordinary name, can go to the model. Ordinary
  data isn't hidden.
- Known secrets shorter than 6 characters are hidden in their own field, but not where the same text recurs elsewhere
  (hiding "admin" or "1234" everywhere would garble ordinary text).
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

## Tests
`tests/assistant-*.test.*`, `tests/use-assistant.test.tsx`, and `cargo test --lib ai::` in `src-tauri`. On a loaded
machine the first `App` render can take over a second: raise the test's wait, don't loosen the code.
