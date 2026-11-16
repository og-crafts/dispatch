# Windows code signing (SignPath Foundation)

Chosen by the owner on 2026-11-16: SignPath Foundation signs Dispatch's Windows installers for free, with a
certificate issued to "SignPath Foundation" (that is the publisher Windows shows). Requirements are on
https://signpath.org/terms; the points that apply to Dispatch are below.

## Status

- [x] Code signing policy page: https://dispatch.ogcrafts.cloud/code-signing/, linked as "Code signing policy" from
      the footer of every page (home and download included) and from the download page.
- [x] Privacy policy says what the optional update check does.
- [x] CI: the Windows job of a release tag sends the installers to SignPath and waits for the signed files, when the
      `SIGNPATH_API_TOKEN` secret is set (`.github/workflows/build.yml`).
- [ ] Owner: multi-factor authentication on GitHub (og-crafterr) and on SignPath.
- [ ] Owner: apply at https://signpath.org/apply (draft answers below).
- [ ] After approval: SignPath project, artifact configuration, API token and repo settings (below).

## What SignPath requires (from their terms, 2026-11)

- OSI licence for everything (MIT), no proprietary parts, actively maintained, already released (0.1.0),
  functionality described on the download page.
- Only our own binaries, built from this repo by GitHub Actions on GitHub-hosted runners (SignPath checks this).
- No hacking tools; no data sent to systems the user didn't choose (Dispatch sends requests only where the user
  points them; the update check is opt-in); an uninstaller (both installers have one).
- MFA for everyone with access to GitHub and SignPath.
- Roles: authors/committers, reviewers (every outside pull request is reviewed), approvers (each release is
  approved by hand in SignPath).
- A "Code signing policy" on the home and download pages with the sentence "Free code signing provided by
  SignPath.io, certificate by SignPath Foundation", the roles, and the privacy statement.
- Signed files must have product name and version metadata, enforced in the artifact configuration.
- Risk: for downloadable programs they want "a certain verifiable reputation". Dispatch is young (few downloads,
  no stars yet), so they may decline for now. Reapplying later with more users is possible.

## Draft application answers

The form is on https://signpath.org/apply (a HubSpot form; fields may differ). Suggested answers:

- **Project name:** Dispatch
- **Repository:** https://github.com/og-crafts/dispatch
- **Homepage / download page:** https://dispatch.ogcrafts.cloud/ and https://dispatch.ogcrafts.cloud/download/
- **Code signing policy:** https://dispatch.ogcrafts.cloud/code-signing/
- **Licence:** MIT
- **Description:** Dispatch is a local-first API client: build, send, test and document HTTP, GraphQL, gRPC,
  WebSocket, MQTT, SSE and MCP requests, with collections, environments, scripts, a runner and a mock server. No
  account and no cloud: data stays on the user's device. Desktop app (Tauri 2: Rust + WebView2), web app and a
  command-line runner.
- **What to sign:** the Windows NSIS setup (`Dispatch_<version>_x64-setup.exe`) and MSI
  (`Dispatch_<version>_x64_en-US.msi`) for each release.
- **Build system:** GitHub Actions on GitHub-hosted `windows-latest` runners, triggered by version tags;
  workflow `.github/workflows/build.yml`.
- **Team:** one maintainer (owner of the og-crafts GitHub organization), who authors, reviews and approves.
- **Releases:** 0.1.0 (2026-11) on GitHub Releases.
- **Contact:** hello@ogcrafts.cloud

## After approval (owner, then Claude)

1. In SignPath: the project (slug `dispatch`), the trusted build system "GitHub.com" linked to it, and the
   signing policy (Foundation projects usually get `release-signing`). Optionally install the SignPath GitHub App.
2. Artifact configuration: upload a sample (the `windows-unsigned` artifact of a release run is a zip with the two
   installers) and let SignPath generate it, then check it signs only those two files and pins product name and
   version, roughly:

   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
     <parameters>
       <parameter name="version" required="true" />
     </parameters>
     <zip-file>
       <pe-file path="Dispatch_*_x64-setup.exe" product-name="Dispatch" product-version="${version}">
         <authenticode-sign />
       </pe-file>
       <msi-file path="Dispatch_*_x64_en-US.msi">
         <authenticode-sign />
       </msi-file>
     </zip-file>
   </artifact-configuration>
   ```

   (Written from SignPath's docs without access to their schema; let their editor validate it. The workflow passes
   `version` as a parameter.)
3. A SignPath API token for a user with submitter rights → GitHub secret `SIGNPATH_API_TOKEN`; repo variables
   `SIGNPATH_ORGANIZATION_ID`, and if different from the defaults, `SIGNPATH_PROJECT_SLUG` (`dispatch`) and
   `SIGNPATH_SIGNING_POLICY_SLUG` (`release-signing`).
4. Then remove the "installers are not signed yet" section from the download page and say so in the release notes.

## How a signed release runs

1. Tag `vX.Y.Z` → the Windows job builds the installers (and their update signatures).
2. It uploads them as the `windows-unsigned` artifact and submits a signing request to SignPath.
3. **The owner approves the request in SignPath** (every release needs this). The job waits up to 2 hours.
4. The signed installers replace the unsigned ones, their update signatures are made again (Authenticode changes
   the file, so the old `.sig` would no longer match), and they are attached to the draft release as before.

The app inside the NSIS setup (`dispatch.exe`) stays unsigned: SmartScreen checks the downloaded installer, not the
installed program. Signing it too would need a second signing request per release.
