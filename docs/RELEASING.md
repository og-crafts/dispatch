# Releasing Dispatch

## Today

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Merge to `main`, then push a tag: `git tag -a vX.Y.Z -m "Dispatch X.Y.Z" && git push origin vX.Y.Z`.
3. GitHub Actions builds installers and attaches them to a **draft** release:
   Windows (`.msi`, NSIS `.exe`), Linux x64 and ARM64 (`.deb`, `.rpm`, AppImage), macOS universal (`.dmg`).
4. Check the draft, edit the notes, publish.

The installers aren't signed yet, so Windows SmartScreen and macOS Gatekeeper warn on first launch.

## Installer look

The Windows setup (NSIS `.exe` and `.msi`) and the macOS `.dmg` use branded artwork from `src-tauri/installer/`
(wired up in `tauri.conf.json` under `bundle.windows.nsis`, `bundle.windows.wix` and `bundle.macOS.dmg`). The images
are generated: change the look in `scripts/make-installer-art.mjs` and run it (it documents what it needs), then
commit the new images. The `.bmp` sizes are fixed by the installers: 164x314 sidebar, 150x57 header (NSIS), 493x312
dialog and 493x58 banner (WiX).

The `.dmg` background is drawn at 1320x800 and marked 144 dpi so Finder shows it at 660x400 points, sharp on Retina.
**One-click setup on Windows.** Double-clicking `Dispatch_x.y.z_x64-setup.exe` shows no wizard: a borderless splash
(graphite card with the logo, "Installing Dispatch", a thin amber progress bar; `OneClickSplash`; the logo bitmaps
`splash-logo-{100,125,150,200}.bmp` come from `node scripts/make-installer-art.mjs splash`), a per-user install with
no admin prompt, shortcuts on the desktop and in the Start menu, and then Dispatch opens. It is Tauri's NSIS template
with seven small blocks added, each marked `DISPATCH:`, in
`src-tauri/installer/installer.nsi` (`bundle.windows.nsis.template`). `setup.exe /WIZARD` brings the classic pages
back (choose a folder, finish page); `/S` (silent), `/P` (passive) and the updater's `/P /UPDATE /R` behave as
before. **When `@tauri-apps/cli` is bumped,** diff Tauri's new `installer.nsi` against the old one, re-apply the
marked blocks and update the `TAURI-CLI-VERSION` line; `tests/installer.test.ts` fails until that is done. The `.msi`
keeps its standard wizard (IT departments expect one).

The Windows setup has no custom Start menu folder: `nsis.startMenuFolder` was left out because it hasn't been tested
on an upgrade from an older install (the old root-level shortcut could be left behind). Try it on a machine with
0.5.x installed before adding it.

## Code signing (needs the owner)

Windows SmartScreen warns about any installer that isn't Authenticode-signed with a certificate it trusts, and even
a signed one until the certificate has built up some download reputation (EV certificates no longer skip this).
Options as of 2026-11 (checked by Claude; prices and rules change, so confirm before paying):

- **SignPath Foundation (free, open source):** signs releases of OSI-licensed public projects from GitHub Actions
  with the Foundation's certificate. Needs an application, MFA for everyone with access, and a code-signing policy
  page on the site; the publisher Windows shows is "SignPath Foundation", not OGCrafts.
- **Certum Open Source Code Signing (paid, ~€69+/year):** a certificate in the owner's name ("Open Source Developer,
  …") kept in Certum's SimplySign cloud, which needs a phone code; signing from CI needs extra tooling.
- **Microsoft Store:** free for individual developers since 2025-09. An MSIX package is signed by Microsoft, so Store
  installs show no SmartScreen warning and the Store does the updates; MSI/EXE submissions must already be signed.
  Tauri doesn't build MSIX itself.
- **Azure Artifact Signing (Trusted Signing, 9.99 USD/month):** not open to individuals outside the US/Canada.

**Chosen (2026-11-16): SignPath Foundation.** Set-up, application and the CI flow: `docs/SIGNING.md`.

Wiring for a certificate of our own instead: `bundle.windows.signCommand` in `tauri.conf.json` (https://v2.tauri.app/distribute/sign/windows/),
with its secrets in GitHub.

- **macOS:** an Apple Developer account (99 USD/year). Add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` as GitHub secrets; Tauri signs and
  notarizes during `tauri build` when they're set (https://v2.tauri.app/distribute/sign/macos/).

## Auto-updates

Built: the desktop app has **☰ → Check for updates…** and a setting (Settings → General, off by default because it
contacts GitHub) to check quietly on start. Nothing installs without the person agreeing. An update is installed only
if its signature matches the public key built into the app, so only the holder of the private key can ship updates.

- Rust: `src-tauri/src/updater.rs` (`update_check`, `update_install`); the plugin loads only when
  `plugins.updater.pubkey` is set, so builds without a key still run. UI: `src/ui/updates.ts`.
- Release tags: when the `TAURI_SIGNING_PRIVATE_KEY` secret is set, the desktop jobs build with
  `src-tauri/tauri.updater.conf.json` (signed updater files: NSIS `.exe`, AppImages, `Dispatch.app.tar.gz`, each with
  a `.sig`), and the `updater` job attaches `latest.json` (`scripts/make-latest-json.mjs`) to the draft release.
- Installed copies read `https://github.com/og-crafts/dispatch/releases/latest/download/latest.json`, so an update
  reaches people when the owner **publishes** the release, not before.
- Linux `.deb`/`.rpm` installs don't self-update (Tauri updates AppImages only); they show the download page.

**One-time set-up (owner):** `scripts/setup-updater.sh`. It makes the key pair in `~/keys` (with a random password
next to it), writes the public key into `tauri.conf.json`, and stores the key and password as GitHub secrets. Commit
the `tauri.conf.json` change, then run `~/bin/backup-secrets`. Losing the private key means installed copies can't
update any more (they'd need a manual reinstall with a new key).

Copies installed before the first release with the key (0.5.1 and older) have no updater: those people install the
next version by hand once.
