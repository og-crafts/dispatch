# Update notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app checks for updates by default and shows a lasting "Update to X" button.

**Architecture:** Pure timing rules in `src/core/updateSchedule.ts`; a `useUpdates` hook owns state and the existing
Tauri calls; two small components show the button and the one-time notice. Rust gains only `update_configured`.

**Tech Stack:** React 18, TypeScript 5.6, vitest + jsdom, Tauri 2 updater. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-update-notice-design.md`

## Global Constraints

- Nothing installs without a yes. Automatic failures are silent. The web app and builds without a key never check.
- No automatic check before the notice has been shown and then a restart or 24 hours have passed.
- Notice copy, exact: "Dispatch looks for new versions on GitHub. No workspace data is sent." Buttons: "OK", "Turn off".
- Button copy: "Update to 0.3.0" (the version found); its x has the label "Dismiss update 0.3.0".
- Device state goes in IndexedDB meta `updateState`, never in backups or folder files.
- CSS uses existing tokens only; all three looks, light and dark. Commits use the og-crafterr noreply address.
- Never push to `main` without `npm run typecheck`; run `npm run build` before each commit.

## Review Focus

1. The computer sleeps for two days: one check after waking, not several (Task 1, wall-clock test).
2. "Turn off" while a check is on its way: its result shows no button (Task 2).
3. Install fails (offline, or a .deb/.rpm that can't self-update): button stays, retry works, download page offered (Task 2).
4. A newer version appears between the check and the install: the person is asked again for that version (Task 2).
5. The button is clicked twice: one prompt, one install (Task 2).

---

### Task 1: Timing rules, setting and saved state

**Files:**
- Create: `src/core/updateSchedule.ts`; Test: `tests/update-schedule.test.ts`
- Modify: `src/core/types.ts` (`Settings`, `defaultSettings`)

**Interfaces:**
- Produces: `interface UpdateState { noticeAt?: number; noticeAnswered?: boolean; dismissed?: string }`,
  `checkDue(x: { enabled: boolean; noticeAt?: number; runStartedAt: number; lastCheckAt?: number; now: number }): boolean`,
  `Settings.autoUpdateCheck: boolean` (default `true`). `updateCheckOnStart` is removed from the type.

- [ ] **Step 1: Write the failing tests**

```ts
const H = 3_600_000, base = { enabled: true, runStartedAt: 1000, now: 2000 }
it('waits for the notice', () => expect(checkDue(base)).toBe(false))
it('waits after a notice in this run', () => expect(checkDue({ ...base, noticeAt: 1500 })).toBe(false))
it('checks 24 h after it', () => expect(checkDue({ ...base, noticeAt: 1500, now: 1500 + 24 * H })).toBe(true))
it('checks after a restart', () => expect(checkDue({ ...base, noticeAt: 500 })).toBe(true))
it('not again within 24 h', () => expect(checkDue({ ...base, noticeAt: 500, lastCheckAt: 1500, now: 1500 + 23 * H })).toBe(false))
it('once after a long sleep', () => {
  const now = 1500 + 48 * H
  expect(checkDue({ ...base, noticeAt: 500, lastCheckAt: 1500, now })).toBe(true)
  expect(checkDue({ ...base, noticeAt: 500, lastCheckAt: now, now: now + 60_000 })).toBe(false)
})
it('off', () => expect(checkDue({ ...base, enabled: false, noticeAt: 500 })).toBe(false))
```
Also: after `putSettings({ ...defaultSettings, updateCheckOnStart: false } as any)`, `(await getSettings()).autoUpdateCheck` is `true`.

- [ ] **Step 2:** Run `npx vitest run tests/update-schedule.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement both. `lastCheckAt` is in memory only, so each start may check.
- [ ] **Step 4:** Run the same test. Expected: PASS. (Typecheck passes after Task 2 removes the old uses.)

### Task 2: The hook, safe install and Rust command

**Files:**
- Create: `src/ui/useUpdates.ts`; Test: `tests/use-updates.test.tsx`
- Modify: `src/ui/updates.ts`, `tests/updates.test.ts`, `src-tauri/src/updater.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1; `db.getMeta` / `db.putMeta`; `openExternal` from `PrivacyDialogs.tsx`.
- Produces: Rust `update_configured() -> bool`, registered in `generate_handler!`; and
  `useUpdates(ws: WorkspaceApi, notify: Notify, confirm: Confirm): { available: UpdateInfo | null; noticeOpen: boolean; answerNotice(keepOn: boolean): void; dismiss(): void; install(): Promise<void>; checkNow(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests** (mock `invoke` by command as `tests/updates.test.ts` does; fake timers; `resetForTests`)

| Test | Assertion |
|---|---|
| web / not configured | after 25 h, `update_check` not called; `noticeOpen` false |
| first run | `noticeOpen` true, `noticeAt` saved, no check; at 24 h exactly one check |
| notice waits for `telemetryAsked` when `telemetryOffered()` | `noticeOpen` false until answered |
| Turn off | `autoUpdateCheck` false, no check after 25 h; a check already in flight leaves `available` null |
| found, dismissed | `available.version` '0.3.0', then null; 0.3.0 found again: null; 0.4.0 found: shown |
| `checkNow` on a dismissed 0.3.0 | clears `dismissed`, `available.version` '0.3.0', and asks to install |
| automatic check rejects | `notify` not called |
| install, first `update_install` rejects | notify has the error and action label 'Open download page'; `available` still set; second `install()` calls `update_check` before `update_install` and succeeds |
| version changes before install | `confirm` called twice, second text names 0.4.0; a no installs nothing |
| two `install()` calls at once | one `confirm`, one `update_install` |

- [ ] **Step 2:** Run `npx vitest run tests/use-updates.test.tsx`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement. A 15-minute interval plus start calls `checkDue`. `install()`: confirm, check again,
  confirm again only if the version differs, then install; a check that now finds nothing says "You have the newest
  version (x)." and clears `available`. Download page: `https://dispatch.ogcrafts.cloud/download/`.
  Remove `quiet` from `runUpdateCheck`; `checkNow` keeps today's spoken answers.
- [ ] **Step 4:** Run `npx vitest run tests/use-updates.test.tsx tests/updates.test.ts` and `cargo test updater` in
  `src-tauri`. Expected: PASS (if Linux system packages are missing, record it and rely on CI for cargo).

### Task 3: What people see

**Files:**
- Create: `src/ui/UpdateNotice.tsx` (`UpdateButton`, `UpdateNotice`); Test: `tests/update-notice.test.tsx`
- Modify: `src/ui/App.tsx` (remove `updateChecked` effect; button before the environment picker; notice under the
  header; menu item calls `checkNow`), `src/ui/SettingsView.tsx`, `src/ui/app.css`

**Interfaces:** Consumes Task 2's hook return value.

- [ ] **Step 1: Write the failing tests:** rendering `App` as desktop with 0.3.0 found shows a button named
  "Update to 0.3.0"; another toast leaves it there; "Dismiss update 0.3.0" removes it and focus moves to Menu; the
  notice shows the exact copy in `role="status"`, OK closes it, Turn off unticks the setting; the setting's label is
  "Check for new versions automatically (asks GitHub when Dispatch starts and once a day; nothing is installed without asking)".
- [ ] **Step 2:** Run `npx vitest run tests/update-notice.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. The button must not wrap the header at 900 px wide (shorten to "Update" with the full
  accessible name under 1000 px).
- [ ] **Step 4:** Run `npm test`, `npm run typecheck`, `npm run build`. Expected: all pass, no file fails to load.
- [ ] **Step 5:** Playwright screenshots, three looks x light/dark, 900 and 1400 px. Look at each.
- [ ] **Step 6:** Commit Tasks 1-3: "Show a lasting update notice; check for updates by default".

### Task 4: Wording everywhere

**Files:** Modify `site/build.py` (FAQ line 179, `PRIVACY_NEVER` line 190, download 278, privacy 351, code signing 382,
`UPDATED` dates), `README.md:12`, `docs/RELEASING.md` "Auto-updates", `docs/TESTING-WINDOWS.md` 8.6,
`docs/SIGNING.md` if it quotes the old promise, `CLAUDE.md`. The changelog entry comes with the version bump.

- [ ] **Step 1:** Replace each claim. Privacy text states: on by default, when it checks, that GitHub sees the IP
  address, that no workspace data is sent, the one-time notice, how to turn it off, nothing installs without a yes.
- [ ] **Step 2:** Run `grep -rniE 'unless you (ask or )?turn (it|them) on|off by default' README.md site/build.py docs/*.md`.
  Expected: no match about update checks. Run `python3 site/build.py`; expected: builds without errors.
- [ ] **Step 3:** Commit: "Say that update checks are on by default". Don't publish the site before the release.

### Task 5: Check a real update

- [ ] **Step 1:** Open a PR; every CI job green.
- [ ] **Step 2:** On the Predator, with `WEBVIEW2_USER_DATA_FOLDER` set to an own folder: notice, Turn off, restart.
  With no newer release the button can't appear for real; record that.
- [ ] **Step 3:** Before the release is announced: a real 0.2.0 install updates through Menu > Check for updates, and
  the result is recorded in CLAUDE.md. After the following release: the button appears on its own.
