# Assistant step 2 (scripts and parameterizing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chat can propose changes to requests, scripts and variables; the person sees exactly what changes and
applies, rejects or undoes each one.

**Architecture:** An edit tool runs the existing edit code on the real records with a capturing `save`/`remove`, which gives
a `Proposal` (before and after of every record). The gate shows it and waits. `useWorkspace.applyProposal` compares
"before" with the records as they are now and writes everything in one database transaction. Nothing is sent or run.

**Tech Stack:** TypeScript, React 18, IndexedDB, vitest. No new dependency and no Rust change.

**Spec:** `docs/superpowers/specs/2026-11-24-assistant-design.md`, "Permissions", "Applying and undoing", tools step 2.
**Also read:** `docs/ASSISTANT.md`. **Needs:** #92 (merged, `main` 3bb715c).

## Global Constraints

- Every rule in `docs/ASSISTANT.md` stays, except "Read only, twice", which becomes "never sends, and changes only
  through an approved proposal". `handleMcp` still gets `NO_METHODS`, `NO_TRANSPORT` and no hooks from the chat.
- Every edit and delete is approved on its own, for exact arguments and the exact state shown. No "always allow".
- Tools see and answer with cleaned text; only the edit code touches real records. `<hidden>` is never accepted back.
- An edit can't replace or remove a value the model was not shown, except `apply_parameters` (which moves it) and deleting a
  whole request.
- Only the open workspace. Nothing in the assistant's own workspace unless that is the open one.
- Outside assistants keep today's tools, permissions and texts exactly; Task 7 only adds two tools under "AI can edit".
- Proposals, previews and undo are in memory only: never in saved chats, backups, logs, telemetry or the model's context.
- Undo ends when Dispatch closes. Approvals don't survive a restart, a workspace switch or a changed connection.
- 25 tool calls and 10 minutes per message; time spent waiting for the person doesn't count.
- All looks; keyboard and screen reader; warm copy, no comparisons. `npm run typecheck`, `npm test` and `npm run build` before each commit.

## Review Focus

1. **Stop pressed while a change is being written:** the model and the panel must both hear "applied", because it was. (Tasks 3, 5)
2. **The request is open with unsaved edits:** a proposal would be built on the old text, or a later Save would undo it. It is
   refused with "Save or discard your changes to X first". (Tasks 2, 3)
3. **A collection, folder or environment editor is open when a change is applied:** the next keystroke must not write the old
   script or variables back (`useSaved` in `Editors.tsx` follows only the name and variables today). (Task 3)
4. **A script holds a known secret under an ordinary name:** the model saw `<hidden>` in its place, and a rewrite without it
   would lose the secret. Refused. (Task 2)
5. **Hostile text in a response asks for a change that leaks a token** (a new host under existing auth, `{{token}}` put in a URL, a
   script that posts variables): nothing happens without a click, and the card names the risk. (Tasks 2, 5)

## Proposal, in one place

`src/core/assistant/proposal.ts`, used by every task below:

```ts
type Kind = 'collection' | 'folder' | 'request' | 'environment' | 'globals'
/** before null: created; after null: deleted. Globals: id 'globals', the record is KV[]. */
interface Change { kind: Kind; id: string; before: Rec | null; after: Rec | null }
interface Line { type: 'same' | 'add' | 'del' | 'gap'; text: string }
interface Field { label: string; lines: Line[] }                       // what the card draws
interface Proposal {
  id: string; spaceId: string; tool: string; cls: 'edit' | 'delete'
  title: string; fields: Field[]; warnings: string[]; changes: Change[]
  /** The tool's reply, given to the model only when it was applied. */
  reply: string
}
type ApplyResult = { ok: true } | { ok: false; reason: 'changed' | 'unsaved' | 'gone' | 'failed'; text: string }
/** Records without updatedAt, keys in order: equal strings mean the same record. */
function canonical(r: Rec | null): string
```

---

### Task 1: Tool classes, schemas and the clean copy

**Files:** Create `src/core/assistant/clean.ts`, `src/core/assistant/proposal.ts`, `tests/assistant-proposal.test.ts`; modify
`gate.ts`, `tools.ts`, `src/core/mcpWorkspace.ts` (texts only).

**Interfaces:** Produces
`cleaner(ctx: ToolContext, w: McpServeOptions): { clean(s: string): string; deep<T>(v: T): T }` (moved from `prepare`, unchanged);
`toolClass(name): 'read' | 'edit' | 'delete'`; `offeredTools(conn, job?: 'ask' | 'scripts'): ToolSpec[]` (replaces `readTools`);
`workspaceTools(editable?: string, own = true)`: with `own` false the texts don't mention the assistant's own workspace or `assistant/`.

Offered: the read tools, plus `create_request`, `update_request`, `copy_request`, `move_request`, `set_variables`, `set_scripts`
(edit), `delete_request` (delete), and from Task 4 `suggest_parameters` (read), `apply_parameters`, `set_environment_variables` (edit).
`update_request` without `reviewed`. Under 16,000 context tokens: `ask` offers the read tools, `scripts` adds `update_request`,
`set_scripts`, `suggest_parameters`, `apply_parameters` and `set_environment_variables`; default `ask`. Otherwise all of them.

- [ ] **Step 1: Failing tests:** `validate` accepts `{ type: 'object', additionalProperties: { type: 'string' } }` and refuses a number value in
  it; accepts an array of strings and refuses a mixed one; an object without `properties` and without `additionalProperties` still
  refuses any field; `__proto__` as a name is refused; `canonical` ignores `updatedAt` and key order, and sees a changed nested script;
  no tool offered to the chat contains the text `assistant/`; `workspaceTools('X')` deep-equals today's output (inline snapshot); small
  context with job `ask` offers no edit tool; `send_request`, `run_collection` and `run_flow` are never offered.
- [ ] **Step 2:** `npx vitest run tests/assistant-proposal.test.ts` fails. **Step 3:** Implement. A name with no class is refused by the gate.
- [ ] **Step 4:** Passes, and `tests/assistant-loop.test.ts`, `assistant-redact`, `mcp*.test.ts` pass unchanged except renamed imports. **Step 5:** Commit.

### Task 2: From a tool call to a proposal

**Files:** Create `src/core/assistant/propose.ts`, `tests/assistant-propose.test.ts`; modify `mcpHandler.ts` (export the lookup as
`finder(o)`, no behaviour change).

**Interfaces:** Consumes Task 1, `workspaceCall`, `diffLines`, `withContext`. Produces
`propose(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<Proposal | { refused: string }>`.
`ToolContext` gains `unsaved(requestId: string): boolean` and `schedules(): Promise<Schedule[]>`.

How it works, so that nothing hidden leaks or is lost:
1. Real records of the open workspace, with `name` replaced by the cleaned name, go to `workspaceCall` with `collections: []` and
   `editable` = the open workspace. Lookup by name can't tell whether a hidden text is there.
2. `save`/`remove` only capture. Names are put back by id, unless the tool renamed the record.
3. A captured record outside `ctx.spaceId`, or no change at all, is refused.
4. For every changed or removed string, header, field or variable: if its cleaned form differs from the real one it is refused
   ("holds a secret you weren't shown"). A header may be replaced by a lone `{{variable}}` (today's rule). A variable marked secret is
   always refused, also when shorter than 6 characters. Doesn't apply to `delete_request`, or to copies and moves that leave the value as it is.
5. Card text: "before" is cleaned. "After" is shown exactly when the model supplied it, cleaned otherwise. Control, zero-width and
   direction characters are drawn as `\u{202E}` and the like, in both.

- [ ] **Step 1: Failing tests** (one each):
  - `update_request` with `testScript` gives one request change, `before` deep-equal to the stored record, the store untouched, and a
    field "After-response script" with `add` lines holding the exact script.
  - `set_scripts` on a folder; `set_variables`; `create_request` with a new collection and two folders gives four creations; `delete_request`
    has `after: null`; `copy_request` keeps the secret auth in `after` and shows none of it in `fields`, `warnings`, `title` or `reply`.
  - Planted secrets (in variables, auth, headers, body, script, another workspace, a connection key) are in no string of the proposal
    except `changes`, and in no refusal.
  - Review Focus 4: the script `const k = 'abcSECRET99'` with that value as a known secret: rewriting it is refused; editing the request's URL is not.
  - Removing or setting a secret variable is refused, also the 4-character one.
  - `assistant/New/x` as a folder is refused and captures nothing; a request of another workspace isn't found.
  - A request name that contains a known secret can be found by its cleaned name only, and keeps its real name after the edit.
  - Review Focus 2: `unsaved` true refuses with "Save or discard your changes to “Create order” first. Nothing was changed."
  - Review Focus 5, warnings, exact: a changed or new script "Scripts run when this is sent. They can read variables, including secrets,
    and send requests."; a new host on a request that has auth "Its sign-in would go to a new address: evil.example."; a newly used
    secret variable "Uses {{token}}, which is secret."; a collection or folder script "Runs for 12 requests."; a changed variable value
    "Used by 5 requests."; a request, folder, collection, environment or globals an enabled schedule uses "The schedule “Nightly” sends
    this while Dispatch is open."
  - `after` text with U+202E is drawn escaped.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. "Used by" counts `{{name}}` in the workspace's requests (`namesIn`).
- [ ] **Step 4:** Passes; `mcp*.test.ts` unchanged and green. **Step 5:** Commit.

### Task 3: Apply and undo

**Files:** Modify `src/core/db.ts`, `src/ui/useWorkspace.ts`, `src/ui/Editors.tsx`; create `tests/apply-proposal.test.tsx`.

**Interfaces:** Produces on `WorkspaceApi`
`applyProposal(p: Proposal): Promise<ApplyResult>`, `undoProposal(p: Proposal): Promise<ApplyResult>`, `isUnsaved(requestId: string): boolean`;
`db.applyRecords(puts: Change[], deletes: Change[]): Promise<void>` (seals first, then one transaction over all stores it needs).

- [ ] **Step 1: Failing tests:**
  - Applying writes all records of a create-with-folders proposal; with the second put failing, none is stored and the state is unchanged (`failed`).
  - A record changed after the proposal gives `changed` and writes nothing; one changed only in `updatedAt` applies.
  - Two applies in one tick: the second sees the first (refs move at once).
  - Applying twice, or applying after the workspace was switched, is refused; so is a change whose collection or folder was deleted (`gone`).
  - Review Focus 2: an open tab with unsaved edits gives `unsaved`, for apply and undo; a clean open tab shows the new version.
  - Review Focus 3: with the collection editor open, apply a script, then type in its docs: the applied script is still stored. The same for a
    folder's script and an environment's variables. Typing without any outside change never moves the cursor or loses a letter.
  - Undo restores `before`; after a later edit by the person it answers `changed` and writes nothing; undo of a created collection
    that has since got a request is refused; undo of a delete whose folder is gone is refused.
  - A deleted request is on the undo list once; `undoProposal` takes that entry off; Undo from the list first makes the card's undo answer `changed`.
  - A linked folder gets the applied change; a folder sync that changed the record in between gives `changed`.
  - A script that changes a variable by itself between proposal and apply gives `changed` for that table only.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. Add `foldersRef`, and move the refs at once in `updateCollection`, `updateFolder`,
  `updateEnvironment`, `setGlobals`, `persistRequest` and the removes. Applies and undos run one at a time. `useSaved` follows every
  outside change of its record, not only name and variables. Trash entries get an `id`.
- [ ] **Step 4:** Passes; full suite. **Step 5:** Commit.

### Task 4: Parameters and environment variables

**Files:** Create `src/core/assistant/parameters.ts`, `tests/assistant-parameters.test.ts`; modify `src/core/parameterize.ts`
(`knownVars(...)` moved out of `Parameterize.tsx`; `create` never drops a value), `src/ui/Parameterize.tsx`, `propose.ts`, `tools.ts`.

**Interfaces:** Produces
`suggest_parameters { name }` → lines `id · what · {{variable}} · new|existing · secret`, plus `batch`, a random code;
`apply_parameters { name, batch, choose: Record<id, variableName | ''>, where: 'environment' | 'collection' | 'globals' }` (`''` keeps the suggested name);
`set_environment_variables { environment?, variables?: Record<string,string>, remove?: string[] }` (default: the active one);
`suggestionsFor(r: RequestDef, w: McpServeOptions): Suggestion[]`.

- [ ] **Step 1: Failing tests:**
  - A bearer token and an API key: their values, and any part of them, are not in the `suggest_parameters` result.
  - `apply_parameters` gives one proposal with the request and the table; the new variable is secret and holds the real value in `changes`;
    the card shows `Authorization` as `<hidden>` → `{{token}}`.
  - A `batch` from before the request or variables changed is refused: "The request changed. Look at the suggestions again."; an unknown id and an unknown batch too.
  - Names: `token 2`, `{{x}}` and a name already used in scope are refused; a name the target table already has, also switched off, is refused
    rather than losing the value (and the Parameterize panel does the same).
  - `environment` with none active is refused and says to pick the collection or globals.
  - `set_environment_variables`: sets a plain variable and, with layers, the active layer too; a new secret-named variable is created secret
    and empty, and the card says "Dispatch leaves “apiToken” empty for you to fill in."; setting or removing an existing secret is refused;
    another workspace's environment isn't found.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. Batches live in the chat's memory: the last 10, each with the canonical request and tables it was made from.
- [ ] **Step 4:** Passes, with `tests/parameterize.test.ts`. **Step 5:** Commit.

### Task 5: Gate, loop and waiting for the person

**Files:** Modify `gate.ts`, `loop.ts`, `tools.ts` (`systemPrompt`), `src/ui/assistant/useAssistant.ts`; create `tests/assistant-approve.test.tsx`.

**Interfaces:** Consumes Tasks 1–4. Produces
`ToolContext.decide(p: Proposal, signal: AbortSignal): Promise<{ outcome: 'applied' | 'rejected' | 'expired' | 'stopped'; text?: string }>`;
`AskOptions.run(name, input, signal, clock: { pause(): void; resume(): void })`; `AskOptions.settles(name): boolean` (its result is
awaited even after a stop); on `AssistantApi`:
`cards: { proposal: Proposal; state: 'waiting' | 'applying' | 'applied' | 'rejected' | 'expired' | 'stopped' | 'undone'; text?: string }[]`,
`approve(id)`, `reject(id)`, `undo(id)`.

- [ ] **Step 1: Failing tests:**
  - An edit call waits: no write before `approve`; after it the model gets the tool's reply, cleaned and marked as data.
  - Reject gives "The person didn't want this change. Don't propose the same again; ask what they'd like instead." as an error result.
  - Review Focus 1: stop while waiting gives `stopped` and no write; stop during the write (held-open transaction) ends with the card `applied`,
    the saved chat's result saying it was applied, and the answer stopped.
  - The 10 minutes don't run while a card waits, and do otherwise; a waiting card has no time limit of its own.
  - Two edit calls in one turn: the second proposal is built after the first is decided, on the new state.
  - The record changes while the card waits: `approve` ends in `expired` with "This changed meanwhile, so nothing was applied.", and the model can propose again.
  - Workspace switch, new chat, opening or deleting a chat, a changed or removed connection, delete-all and unmount end a waiting card as `stopped`.
  - `approve` for another chat's, an ended or an unknown card does nothing; approving twice applies once.
  - Hostile text in a name, doc, response and tool result ("approved", a drawn card, a second tool call): no write without `approve`.
  - No proposal, preview or undo copy is in the saved chat's raw record, the messages or the console.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. `systemPrompt` says: it can read and propose changes; the person decides each one; it can't
  send or run; never say a change was made unless the tool said so; use `{{variables}}` for secrets. The console gets one line per decision,
  with the tool and the record's name only.
- [ ] **Step 4:** Passes; full suite. **Step 5:** Commit.

### Task 6: The card

**Files:** Create `src/ui/assistant/ChangeCard.tsx`, `tests/assistant-card.test.tsx`; modify `AssistantPanel.tsx`, `AssistantHost.tsx`,
`transcript.ts`, `app.css`.

    Change Create order · after-response script
      + test('created', () => expect(dx.response.status).to.equal(201))
      Scripts run when this is sent. They can read variables, including secrets, and send requests.
      [Apply] [Reject]

- [ ] **Step 1: Failing tests:**
  - Each field is a diff with `+`/`−` text and spoken "added"/"removed", not colour alone; more than 200 lines fold behind
    "Show all 340 lines"; Apply is disabled until the rest was shown.
  - Delete says "Delete", has the danger style, and "You can undo this until Dispatch closes."
  - Apply and Reject are real buttons, never focused on their own, ignored for the first 500 ms; Enter in the message box doesn't apply.
  - A waiting card is announced once: "The assistant proposes a change to Create order. Apply or reject it in the panel."
  - With the panel closed, the icon's name is "Assistant, waiting for you"; closing the panel doesn't decide.
  - Applied shows Undo; undone, rejected, expired and stopped show their words and no buttons; a refused undo says why and shows the diff to the record as it is now.
  - Stop says "Changes you already applied stay. Use Undo on their cards."
  - A reopened chat shows "Proposed a change to Create order" with "(not applied)" when the result was an error, and no buttons.
  - Under 16,000 context tokens a picker "Help with: Questions | Scripts and variables" is shown, otherwise not.
  - The note reads "It can read, and propose changes. Nothing changes until you apply it. It can’t send or run anything."
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. Model text in a card is plain text in `<pre>`, never Markdown.
- [ ] **Step 4:** Tests, typecheck, build pass; assistant chunk still at most 150 kB gzipped; screenshots in three looks, light and dark, at 900
  and 1400 px, looked at. **Step 5:** Commit.

### Task 7: The two parameter tools for outside assistants

**Files:** Modify `mcpWorkspace.ts`, `mcpHandler.ts`, `tests/mcp.test.ts`, `tests/mcp-host.test.tsx`.

**Interfaces:** Consumes `suggestionsFor`. `suggest_parameters` and `apply_parameters` join `WORKSPACE_TOOL_NAMES`, with `where` fixed to the
request's collection. `set_environment_variables` is not offered.

- [ ] **Step 1: Failing tests:** offered only with `workspace` on; refused for requests it may not write to; "AI can edit" off refuses the
  open workspace; new variables go to the collection, secret ones marked secret; no value in any reply; a stale batch is refused;
  `dispatch-run mcp` offers neither.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement. **Step 4:** Passes. **Step 5:** Commit.

### Task 8: Words, review and real checks

- [ ] **Step 1:** `docs/ASSISTANT.md` (rules, costs, limits), CLAUDE.md, README, the privacy page and site text in `site/build.py`,
  `docs/TESTING-WINDOWS.md`. Search for "only reads", "can’t change" and "In this version". Nothing is published.
- [ ] **Step 2:** Whole-branch review with a security focus by a fresh reviewer: the Review Focus list, every write path in `useWorkspace`, every
  string that leaves. Fix Critical and Important.
- [ ] **Step 3:** Eight job tests on Ollama `gemma4:e4b`, each twice, results recorded as they are: add a test; fix a failing script; set a token
  from a response; a folder script; base URL to a variable; bearer token to a secret; an ID in a path; an environment variable.
  The count and any unapproved action (must be 0) go in the PR. A model is called supported only at 18 of 20 over the whole job list, later.
- [ ] **Step 4:** Windows check on the Predator, own `WEBVIEW2_USER_DATA_FOLDER`: apply, reject, undo, stop while waiting, an open editor, unsaved edits,
  planted secrets, restart. Clean up and confirm the owner's data is unchanged.
- [ ] **Step 5:** One cloud run only after the owner agrees to the cost. Draft PR, every CI job green, Kan card. No merge without the owner's word.
