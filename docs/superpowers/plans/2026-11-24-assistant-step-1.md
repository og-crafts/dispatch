# Assistant step 1 (connections and read-only chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat panel in the desktop app that answers questions about the open workspace with the person's own model.

**Architecture:** Rust streams bytes to one checked origin; a fetch-shaped adapter feeds the Anthropic SDK and a small
chat-completions client; `src/core/assistant/` holds the loop, the gate and the read tools, which call `handleMcp`.

**Tech Stack:** TypeScript, React 18, Tauri 2 `Channel`, reqwest, `@anthropic-ai/sdk` (new, lazy chunk), vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-assistant-design.md`, step 1. **Needs:** PR #90 and #91 merged first.

## Global Constraints

- Desktop only. With no connection: no icon, no network request, no AI chunk loaded.
- Keys: sealed at rest; never in backups, folder files, logs, tool results, error text, telemetry or saved chats.
- HTTPS except loopback and private addresses; no redirects; "accept any certificate" never applies; no {{variables}}.
- Labels: loopback "Local", private address "Your network", everything else "Cloud".
- Console, history and their responses: tick per connection, on for loopback, off otherwise (owner, 2026-11-24).
- Only Read tools exist in this step; anything else is refused in code.
- Messages are append-only and stored as the provider sent them. Redaction happens before storing.
- Limits: 25 tool calls and 10 minutes per message; last 50 chats. Anthropic suggestion: `claude-opus-5-5`.
- Lazy AI chunk at most 150 kB gzipped. All looks; keyboard and screen reader. No comparisons in copy.

## Review Focus

1. The address is `localhost.evil.com`, `127.0.0.1@evil.com`, or redirects elsewhere: the key never goes there (Tasks 1, 2).
2. Stop, window close or workspace switch mid-stream: no late text, no tool runs, next message works (Tasks 4, 6).
3. A response holds instructions or markup: no tool outside Read runs, no image or link loads (Tasks 4, 6).
4. A local model returns malformed or endless tool calls: plain message, loop ends (Task 4).
5. The key was saved by another device key, or is empty: "Enter the key again", never sent blank (Task 2).

---

### Task 1: Rust streaming

**Files:** Create `src-tauri/src/ai.rs`; modify `src-tauri/src/lib.rs`. Tests in `ai.rs`.

**Interfaces:** Produces
`check_target(url: &str, origin: &str) -> Result<reqwest::Url, String>`;
`ai_stream(state, req: AiRequest, on_event: Channel<AiEvent>) -> Result<(), String>`; `ai_cancel(state, id: u64)`;
`AiRequest { id: u64, method: String, url: String, origin: String, headers: Vec<(String,String)>, body: Option<String>, proxy: Option<String>, no_proxy: Option<String>, ca_certs_pem: Vec<String> }`;
`AiEvent` tagged `kind`: `head {status, headers}`, `chunk {base64}`, `end`, `error {message}`.

- [ ] **Step 1: Failing tests:** `check_target` accepts `https://api.anthropic.com/v1/messages`, `http://localhost:11434/v1`,
  `http://127.0.0.1:1234`, `http://[::1]:1`, `http://192.168.1.5:8000`; refuses `http://api.example.com`,
  `http://localhost.evil.com`, `https://127.0.0.1@evil.com`, an origin mismatch, a changed port, `file:`. Against a local
  tokio server: chunks arrive before the end; 302 gives an error and no second request; cancel closes the socket within 1 s.
- [ ] **Step 2:** `cargo test ai::` fails to compile.
- [ ] **Step 3:** Implement: `redirect::Policy::none()`, connect timeout 15 s, no total timeout, no cookie store. Errors never hold headers.
- [ ] **Step 4:** `cargo test ai::` passes. **Step 5:** Commit.

### Task 2: Connections

**Files:** Create `src/core/assistant/connections.ts`, `tests/assistant-connections.test.ts`; modify `src/core/db.ts`.

**Interfaces:** Produces
`Connection { id; name; kind: 'anthropic'|'openai'|'compatible'; baseUrl; model; key; contextTokens?; readLogs: boolean; tools: 'unknown'|'yes'|'no'; consentHost?: string }`;
`reach(url: string): 'local'|'network'|'cloud'`; `newConnection(kind): Connection`; `db.getConnections()`, `db.putConnections(list)`.

- [ ] **Step 1: Failing tests:** the `reach` cases of Task 1; `newConnection('compatible')` at `http://localhost:11434/v1` has
  `readLogs` true, `anthropic` false; changing a local address to a cloud one resets `readLogs` to false and clears
  `consentHost`; raw IndexedDB never contains the key; a backup export never contains it; a key that can't be unsealed reads as `''`.
- [ ] **Step 2:** `npx vitest run tests/assistant-connections.test.ts` fails. **Step 3:** Implement (sealed as `cookieJars` is).
- [ ] **Step 4:** Passes. **Step 5:** Commit.

### Task 3: Providers

**Files:** Create `src/core/assistant/nativeFetch.ts`, `providers/types.ts`, `providers/anthropic.ts`, `providers/chat.ts`,
`tests/assistant-providers.test.ts`; modify `package.json`.

**Interfaces:** Produces `nativeFetch(conn: Connection, net: NetSettings): typeof fetch`; and
`Provider { turn(t: { system: string; messages: unknown[]; tools: ToolSpec[]; signal: AbortSignal; onText(s: string): void }): Promise<Turn> }`,
`Turn { message: unknown; text: string; calls: { id: string; name: string; input: unknown; invalid?: string }[]; stop: 'end'|'tools'|'length'|'refused'; usage?: { input: number; output: number } }`,
`toolResults(calls: { id: string; text: string; isError: boolean }[]): unknown[]`, `listModels(): Promise<string[]>`.

- [ ] **Step 1: Failing tests** with recorded streams split at every byte: text, two parallel calls, invalid JSON (`invalid` set),
  cut off, refused, usage; Anthropic `message` keeps thinking blocks unchanged; 401/404/429/5xx map to plain messages
  without the key; abort rejects within one tick.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. Anthropic: SDK with `fetch: nativeFetch`, browser option on, `maxRetries: 0`
  after output begins, adaptive thinking, automatic tool choice, server-side refusal fallback only on the Anthropic host.
  Check each SDK name against the installed package's types.
- [ ] **Step 4:** Tests and `npm run build` pass; record the chunk's gzip size (limit 150 kB). **Step 5:** Commit.

### Task 4: Gate, read tools and loop

**Files:** Create `src/core/assistant/tools.ts`, `gate.ts`, `loop.ts`, `tests/assistant-loop.test.ts`.

**Interfaces:** Consumes `handleMcp`, `Redactor`, `knownSecrets`. Produces
`readTools(world: () => McpServeOptions, conn: Connection): ToolSpec[]` (list_requests, get_request, get_environment, and with
`readLogs` get_logs, list_history, get_history_entry); `runTool(name, input, ctx): Promise<{ text: string; isError: boolean }>`;
`ask(o: { provider; system; messages; tools; run; signal; on: LoopEvents }): Promise<{ messages: unknown[]; ended: 'done'|'stopped'|'limit'|'length'|'refused'|'error'; error?: string }>`.

- [ ] **Step 1: Failing tests:** send_request, update_request and an invented name are refused and `handleMcp` isn't called;
  wrong input types refused before running; log tools absent and refused when `readLogs` is false; planted secrets in
  variables, auth, headers, bodies, scripts, logs, connection keys and MCP sign-in tokens absent from every outgoing byte;
  hostile text in a name, doc and response changes nothing; 25-call and 10-minute limits; stop before text, mid-text, between
  tools and during a tool; no tool runs on `length` or `refused`; earlier messages stay deep-equal; results cut at
  20,000 characters after redaction (4,000 under 16,000 context tokens).
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. **Step 4:** Passes. **Step 5:** Commit.

### Task 5: Saved chats

**Files:** Create `src/core/assistant/chats.ts`, `tests/assistant-chats.test.ts`; modify `src/core/db.ts`, `src/ui/useWorkspace.ts` (workspace delete).

**Interfaces:** Produces `Chat { id; spaceId; connectionId; model; title; messages: unknown[]; updatedAt }`, `saveChat`, `listChats(spaceId)`,
`deleteChat(id)`, `deleteChats(spaceId?)`; setting `keepChats: boolean` (default true).

- [ ] **Step 1: Failing tests:** sealed in IndexedDB; not in backups or folder files; 51st save in a workspace drops its oldest; off keeps nothing
  new; deleting a workspace deletes its chats; unreadable record is skipped.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. **Step 4:** Passes. **Step 5:** Commit.

### Task 6: Settings and panel

**Files:** Create `src/ui/assistant/{AssistantPanel,ConnectionDialog,ConsentDialog}.tsx`, `useAssistant.ts`,
`tests/assistant-panel.test.tsx`; modify `src/ui/App.tsx`, `SettingsView.tsx`, `Markdown.tsx` (an `untrusted` mode), `app.css`.

- [ ] **Step 1: Failing tests:** no connection means no icon; add, test, edit, remove; Test reports reachable, streams, calls a
  tool, and sets `tools`; no request before consent, and asked again when the host changes; panel footer shows name and label;
  Stop; Enter sends and Shift+Enter makes a line; focus goes to the box on open and back to the icon on close; streamed text
  is announced once, when finished; switching workspace pauses the chat; a new model starts a new chat; images never render and
  links show their address and open only on click; near-full context offers a new chat with a readable summary.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. Consent copy: "{host} will receive what you write and what the assistant
  reads here: requests, scripts and plain variable values{, and the console and past responses}. Known secrets are hidden,
  but Dispatch can't recognise every secret, and ordinary data in responses is not hidden."
- [ ] **Step 4:** `npm test`, typecheck, build pass; screenshots in three looks, light and dark, 900 and 1400 px. **Step 5:** Commit.

### Task 7: Words and real checks

- [ ] **Step 1:** Privacy page, README, Windows guide, CLAUDE.md. No published text before the release.
- [ ] **Step 2:** Ollama and LM Studio on a real machine: streaming, tools, context size. Windows, macOS and Linux builds.
- [ ] **Step 3:** One cloud run with the owner's key, only after the owner agrees to the cost; the six read questions recorded.
- [ ] **Step 4:** Whole-branch review with a security focus, fixes, PR, every CI job green.
