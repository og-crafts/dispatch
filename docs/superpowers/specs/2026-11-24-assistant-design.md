# Built-in assistant: design

Status: draft for the owner's approval. Decided by the owner 2026-11-24: approach A (chat panel inside Dispatch,
connecting straight to the model). "Builder's call" marks choices the owner has not made.

## Intent and why
A chat inside Dispatch, using the person's own API key or a local model, that helps write scripts, run runners and
flows, set up schedules, check logs, make flows and parameterize requests. It gives people without an outside AI app
the same help, in the place where they work. The owner has not stated a further reason or a target audience.

## Goals
- Connect a model in under two minutes: key or local address, model, Test.
- Do each of the six jobs on the open workspace, from a plain-language request.
- Nothing changes, is sent or is run without the person seeing exactly what, and saying yes.
- Works fully offline with a local model. People who connect nothing see no difference and no network request.

## Non-goals
Dispatch accounts, a Dispatch-run AI server or paid credits; signing in with a Claude or ChatGPT subscription; the
web app and the CLI; autonomous or scheduled chats; voice, images, web search; bundling a model; schedules that run
while Dispatch is closed; load tests started by the assistant.

## Anti-goals
Secrets reaching a model; a response or an imported file steering the assistant into an action; silent edits; a
surprise bill; making Dispatch feel like an AI product to people who don't want one.

## Constraints
- Local-first. Existing outside-assistant (MCP) permissions and behaviour stay as they are.
- Desktop CSP does not allow the webview to reach AI hosts: calls go through Rust.
- Existing tools live in `mcpHandler.ts`, `mcpWorkspace.ts`, `mcpLogs.ts` and are reused, not copied.
- All looks; keyboard and screen reader; copy rules in CLAUDE.md (no comparisons). No content in telemetry.

## Approaches
| | What | Trade-off |
|---|---|---|
| **A (picked)** | Chat loop in TypeScript, streaming through Rust, existing tools | Nothing extra to install; we own the loop and model differences |
| B | Helper process with an agent framework | More ready-made; bigger installers, another process on three systems |
| C | Better connection for outside AI apps | Cheapest, subscriptions work there; no chat inside Dispatch |
Owner picked A on 2026-11-24: in-app chat, with no server or extra program.

## What people see
Settings > AI assistants gains "Dispatch assistant" above today's outside-assistant section.

    Connections
      Work key      Anthropic · claude-opus-5-5    Cloud    [Test] [Edit] [Remove]
      My computer   http://localhost:11434/v1      Local    [Test] [Edit] [Remove]
    [+ Add connection]

A chat icon in the top bar appears once a connection exists (builder's call). It opens a resizable panel on the right:

    Assistant · Orders workspace · Staging        [New chat] [x]
    You     Add tests to Create order and run it
    ------  Read Create order, 2 recent sends
    Change Create order: after-response script
      + test('created', () => expect(dx.response.status).to.equal(201))
      [Apply] [Reject]
    Send POST https://staging.example.com/orders · Staging
      Runs 2 scripts · signed in with {{token}}
      [Send once] [Don't send]
    [ Ask about this workspace ...                     ] [Send]
    Work key · Cloud · sees what it reads here  [Stop]

Applied changes show Undo. Stop ends the model call and any run in progress; a request already sent can't be unsent,
and the panel says so. The chat holds the workspace it started in: switching workspace pauses it.

## Connections and keys
- Kinds in v1: Anthropic; OpenAI; OpenAI-compatible address (Ollama, LM Studio, a company gateway). Others may work
  through the last kind, but are not claimed until tested.
- Model list from the server when offered, otherwise typed. The Anthropic suggestion is `claude-opus-5-5`.
- Keys are sealed with the existing device key, kept per device, and never in backups, folder files, the secrets file,
  exports, logs, tool results or error reports. They are added to the Redactor's known values.
- A key goes only to its connection's origin. Redirects are refused. HTTPS is required except for loopback and private
  addresses (HTTP there shows a warning when it isn't loopback). "Accept any certificate" never applies here; the
  proxy and CA settings do. The address can't be a {{variable}}.
- "Local" is shown only for loopback. Private network addresses say "Your network"; everything else says "Cloud".
- Before the first message to a non-loopback connection, a consent panel says what can be sent and to which host;
  asked again when the host changes.

## What the model gets
- A fixed instruction, the conversation, the tool list, and the open request's name. Nothing else is sent unless a tool
  reads it. Outside content is labelled as data.
- Every tool result goes through one exit that applies `Redactor` and a size limit, including response bodies and headers.
  **Today `send_request` returns response headers and body without redaction**; the chat must not inherit that. Outside
  assistants should get the same protection in a small separate PR (builder's recommendation: now; owner to decide).
- Redaction cannot know a secret that isn't marked, doesn't look like one, or first appears in a response. The consent
  panel says so. Ordinary customer data in responses is sent to a cloud model.
- `<hidden>` is never accepted back in an edit (existing rule).

## Permissions
Enforced in code by one gate between the model and every tool. Instructions to the model are never the protection.

| Class | Examples | Rule |
|---|---|---|
| Read | list/get request, environment names and plain values; console, history and run results if the connection allows it | Automatic |
| Edit | scripts, requests, variables, flows, schedules | Preview, approve each |
| Send/run | request, collection, suite, flow, schedule now | Show targets, approve each |
| Delete | anything | Approve each, always; goes to the undo list |

- No "always allow" in v1 (builder's call). An unknown tool or invalid input is refused before it is shown.
- An approval is for exact arguments and the exact state shown. If the object, environment or workspace changed, it
  expires and a new preview is needed. Approvals don't survive a restart.
- A send preview shows the resolved method and address (secrets hidden), environment, number of scripts, and any
  host not used by this saved request before. Runs list every request and method, rows, and the total number of
  sends. Flows with branches list every request they may send.
- **Scripts can read variables, including secrets, and can send requests.** A script preview says so. Running something
  with a script the assistant changed in this chat names that script in the send approval, even when edited through a folder or collection.
- Limits (builder's calls, editable): 25 tool calls and 10 minutes per message; 100 sends per approved run. Reaching one
  stops and asks. Token counts shown per chat when the server reports them; no price estimates in v1.

## Settled after the builder check (builder's calls unless marked)

**Permissions and today's switches.** The chat has its own rules. It ignores `mcpHostEnabled`, `mcpHostWorkspace`,
`mcpHostLogs`, `mcpHostMethods` and a workspace's "AI can edit": those govern outside assistants, which act without
Dispatch showing each change. In the chat every edit and send is approved, so one more switch adds nothing. The shared
registry takes a policy object; outside assistants keep today's policy exactly. The chat edits the open workspace only.

**Console and history (proposed; owner to decide).** A per-connection tick, "May read the console and send history
(responses included)": on for loopback connections, off for all others until the person ticks it. While off, those
tools aren't offered. Requests, scripts, flows, schedules and environment names/plain values are always readable.

**Applying and undoing.** Each tool produces a proposal: full before and after copies of every touched record. Apply
compares the current records with "before" by a canonical JSON hash, not `updatedAt`; any difference expires the
approval. Undo writes "before" back only if the current record still equals "after"; otherwise it refuses and offers the
diff. This is one new `applyProposal` / `undoProposal` in `useWorkspace`, for all kinds; schedules move from
`Schedules.tsx` into an API it exposes. Secret values stay out of previews and saved chats; undo copies are in memory, so
Undo ends when Dispatch closes. Approvals also bind to the exact arguments and to a hash of everything that decides what
is sent: request, folder and collection auth, scripts and variables, environment, globals, cookies' jar, flow or suite.

**Stopping.** Registry `execute` takes an optional AbortSignal, passed to execute, runCollection, runFlow and
runSchedule. `handleMcp` gains an optional signal it doesn't pass today, so outside behaviour is unchanged. Abort
becomes `ai_cancel`, which drops the HTTP stream.

**Run results.** Stored as a trimmed `RunSummary` (names, method, resolved address, status, time, tests, errors; no
bodies or headers), redacted before storing and again when read, sealed with the vault key as `cookieJars` is.

**Redaction.** The chat redacts with every secret in all workspaces, connection keys, certificate keys, MCP sign-in
tokens and cookies. The secrets file's unlocked values are the same variables. Minimum length stays 6. The shared
`send_request` redaction for outside assistants is a separate PR (owner to decide when).

**Schedules.** Run now is `runSchedule` as it is (script variable changes not kept). Flows and suites stay
unschedulable. The scheduler never pauses for a pending approval; saving a schedule keeps its latest `lastRunAt`.

**Keys and Rust.** Keys are sealed in IndexedDB like every other Dispatch secret, opened in the webview only to start
a call, and passed with it. Keeping them only in Rust would mean an OS keychain on three systems: not in v1. Rust enforces,
per call, HTTPS/loopback rules, no redirects, and that the address is the connection's origin; this limits mistakes, not a
compromised webview. Streaming uses a Tauri `Channel`. No CSP change. The Anthropic SDK runs with its browser option on,
acceptable because the key is the person's own; it is a lazy chunk of at most 150 kB gzipped.
`claude-opus-5-5` is the intended literal.

## Tools, in delivery order
Each step is its own PR, usable on its own, and gets its own plan.

1. **Connections and read-only chat:** connections, streaming, stop, saved chats, consent, redaction exit, gate; existing read tools.
2. **Scripts and parameterizing:** previews by running existing edit code against a capturing `save`/`remove`, a
   before/after diff, stale check, apply, undo. New: `suggest_parameters` and `apply_parameters` over `parameterize.ts`,
   `set_environment_variables`. The model names a suggestion's id and variable; it never handles the hidden value.
   A new secret variable starts empty for the person to fill, or is filled by Dispatch from the value it replaces.
3. **Send and run:** request, collection, saved suite and flow, with abort signals passed all the way through; progress;
   the last 20 run results kept per workspace on the device (sealed, not in backups), with `list_run_results` and
   `get_run_result`. A run made in the Runner is kept too, so "why did it fail?" works.
4. **Flows:** `get_flow`, `create_flow`, `update_flow` (whole graph with a base revision, not free-form patches).
   Validate with `checkFlow` plus schema, unique ids, known ports, existing requests. Preview draws the node graph
   with changes listed as text; Dispatch lays out new blocks. The owner keeps the node-graph editor.
5. **Schedules:** list, create, update, pause, delete, run now, on today's model (collection or folder, every N
   minutes, environment). Enabling needs its own approval that lists what will be sent and how often and says it only
   runs while Dispatch is open. Changing a request a schedule sends warns in that edit's preview.

New tools are also offered to outside assistants, only under existing edit permissions for flows and parameters; schedules
need a new switch, off by default, since they send unattended.

## Conversations
Kept on this device per workspace, sealed, not in backups or folder sync; delete one or all, or turn keeping off.
Deleting a workspace deletes its chats. The last 50 are kept (builder's calls). The provider's own messages are stored
unchanged and only appended to: some models reject edited history. Redaction therefore happens before storing. A chat
stays on its connection and model; switching starts a new chat. When the context is nearly full, Dispatch offers a new
chat with a summary the person can read first.

## Local models
Connection settings include context size. Test checks: reachable, streams, calls one harmless tool with valid input,
answers. If tools fail, the connection works for text questions only, and says so. Under 16,000 tokens only the tools for
the job picked in the panel are offered (Ask, Scripts, Run, Flows, Schedules), and results are shorter. Ollama's documented
default is 4,096 tokens and its OpenAI-compatible address can't set it, so setup explains `OLLAMA_CONTEXT_LENGTH`.
LM Studio tool calling must be confirmed on a real install. "Supported" models are only those that pass the job tests below.

## Failures
Wrong key, no credit, rate limit, offline, model not found, refused answer, cut-off answer, malformed tool input and a
model that loops each get a plain message and a next step. Retries happen only before any output. A tool whose outcome is
unknown (connection lost after sending) is never retried on its own. A broken chat never blocks the rest of Dispatch.

## Technical shape (builder's calls)
- `src/core/assistant/`: `loop.ts`, `gate.ts`, `tools.ts` (registry: schema, class, preview, execute), `providers/`.
  The registry is shared with `mcpHandler.ts`, so outside and inside tools can't drift.
- Rust `ai_stream` / `ai_cancel`: POST, streams bytes, refuses redirects, checks the origin rules. A fetch-shaped adapter
  sits on it. Anthropic uses the official `@anthropic-ai/sdk` with that fetch; OpenAI kinds use a small client over
  `/chat/completions`, kept separate. Loaded only when the panel or connection settings open.
- Anthropic rules to keep: Messages API with our own loop; adaptive thinking and automatic tool choice (no forced tool);
  thinking blocks returned unchanged; check `refusal` and `max_tokens` before running tools; validate streamed tool input;
  server-side refusal fallbacks on where supported, shown to the person, and off for custom addresses.
- UI: `src/ui/assistant/`. Rendering uses the existing Markdown component; model output never becomes HTML; links open
  only on click and show their address; no remote images load (they could leak data).

## Testing
- A scripted fake provider covers the loop: streaming splits, parallel and malformed calls, stop at each point, limits.
- Planted secrets in variables, auth, headers, bodies, responses, logs, scripts and errors: none in outgoing bytes or saved chats.
  Unmarked secrets are a known limit, not a pass condition.
- Hostile text in responses, names, docs and tool results: no action without the matching approval.
- Stale approval, workspace switch, undo after a later edit, deleted request, schedule firing during approval.
- Job tests: 20 fixed tasks (scripts, parameters, logs, runs, flows, schedules) on each model named as supported; pass
  18 of 20 with no unapproved action. Cloud runs cost money: ask the owner first.
- Windows, macOS and Linux streaming; keyboard only; screen reader; three looks in light and dark.
- A security review before step 3 merges.

## Documents
Privacy page (who receives what, per kind), README, site feature text, `docs/SCRIPTS.md` link, Windows guide, changelog.
Site text must not say data never leaves the device once a cloud connection exists. Nothing is published without the owner.

## Order against other work
After the update notice. Steps 1-5 in order; steps 1-2 can ship together as a preview (builder's recommendation).
