# Update notice: design (short)

Status: draft, waiting for the owner's approval. Owner's decision (2026-11-24): automatic checks are **on by default**.

## Why
People should see inside the desktop app that a newer version is out. Today the check on start is off by default, its
message lasts 9 seconds, any other message replaces it, and nothing checks again while the app stays open.

## Goals
- A lasting "Update to X" button in the top bar, in every look, until the update is installed or that version dismissed.
- Click: the existing release notes and install prompt. The x dismisses that version only; a newer one shows again.
- Checks on start and every 24 hours while open, only with the setting on. Automatic failures are silent.
- Menu > Check for updates still works, answers out loud, and brings a dismissed version's button back.
- A failed install can be tried again. Today `update_install` takes the pending update, so a retry says
  "Check for updates first."; the button checks again before each install.
- The web app never checks. Builds without an update key make no check.

## Non-goals
Silent or background installs, system notifications, a "skip forever" option, update channels.

## Anti-goals
Anyone being surprised by the new network request; workspace data leaving the machine; a dialog interrupting work.

## Switching the default
- `updateCheckOnStart: false` is saved for everyone, so it can't say who chose it. A new setting `autoUpdateCheck`
  (default true) replaces it; the old one is no longer read.
- New and existing users see a one-time notice: "Dispatch looks for new versions on GitHub. No workspace data is sent."
  with OK and Turn off. No automatic check runs until the notice has been shown and 24 hours or a restart have passed,
  so there is time to turn it off first. (Builder's call.)
- Same release: Settings label, privacy page ("No update check unless you turn it on"), its FAQ and code signing
  wording, README, docs/RELEASING.md, Windows guide, changelog.

## Approaches
1. **Top bar button + on by default (picked).** Always visible and interrupts nothing; the privacy wording changes.
2. Top bar button + ask once. Keeps today's privacy promise; fewer people see updates.
3. A longer toast. Smallest change, but still disappears and is still replaced by other messages.

## How (builder's calls)
State in a `useUpdates` hook (`src/ui/updates.ts`); dismissed version and last check time kept on the device, not in
backups. Tests: on/off, notice before first check, daily repeat, dismissed vs newer, silent failure, retry, web.

## Limits
Versions up to 0.2.0 don't have this, so most 0.2.0 users still need Menu > Check for updates once. The first in-app
update (0.1.0 to 0.2.0) was never recorded on a real machine: verify a real update on the Predator before release.
