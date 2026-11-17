# Usage analytics, error reports and feedback

Decided by the owner on 2026-11-16: ask on first launch (both off unless ticked), hosted free tiers (Aptabase Cloud
for usage, Sentry for errors), feedback through a pre-filled GitHub issue or e-mail.

## What the person sees

- **First launch** (only in builds that have the keys): "Help make Dispatch better?" with two unticked boxes,
  usage and error reports, each saying what is sent and where; "No thanks" or Esc sends nothing. Asked once
  (`settings.telemetryAsked`).
- **Settings → General → Privacy:** the same two switches (`shareUsage`, `shareErrors`), any time.
- **☰ → Send feedback…:** kind (problem / idea / question), title, text, optional version + system details; opens
  a GitHub issue (public, labelled bug / enhancement / question) or an e-mail to hello@ogcrafts.cloud. Dispatch
  sends nothing itself.
- The privacy policy (`/privacy/#opt-in`), the code signing policy page and the README say the same.

## What is sent (`src/ui/telemetry.ts`)

- **Usage (Aptabase, `POST https://{eu|us}.aptabase.com/api/v0/event`):** event name, fixed labels, app version,
  locale, desktop/web, channel (snapshot / release / dev), a random per-run session id. No cookies (`credentials:
  omit`), no user id. Events: `app_started`, `request_sent` {protocol, ok}, `imported` {format}, `shared_html`
  {what, requests}, `update_check`, `feedback_sent` {via, kind}. **Never add user content** (URLs, names, bodies,
  headers, variables, file names) to an event.
- **Errors (Sentry, `@sentry/browser`, loaded only after consent):** uncaught errors and unhandled rejections in
  Dispatch's own code. No breadcrumbs, no tracing, no replay, no request data, no user; messages are passed through
  `redact()` (URLs, e-mails, IPs, JWTs, tokens, long values) and stack frames keep only the bundle file name.
  Release `dispatch@<version>`, environment = channel, tag `platform`.
- `tests/telemetry.test.ts` checks: nothing is sent without consent or without keys, the exact payload, redaction
  and scrubbing.

## Set-up (owner, once)

1. **Aptabase:** sign up at https://aptabase.com (free tier), create an app "Dispatch" (EU region is fine), copy
   its App Key (`A-EU-…`).
2. **Sentry:** sign up at https://sentry.io (free Developer plan), create a project of type "Browser JavaScript"
   named `dispatch`, copy its DSN (`https://…@o….ingest.….sentry.io/…`). In the project settings, turn on "Data
   Scrubber" and "Use Default Scrubbers" (on by default), and leave "Store client IP addresses" off.
3. Give both values to Claude, or set them yourself as **repository variables** (not secrets; they are public
   client keys that end up in the app anyway):
   `gh variable set APTABASE_APP_KEY -R og-crafts/dispatch -b 'A-EU-…'` and
   `gh variable set SENTRY_DSN -R og-crafts/dispatch -b 'https://…'`.
4. The next CI build includes them (`VITE_APTABASE_APP_KEY`, `VITE_SENTRY_DSN`, `VITE_DISPATCH_CHANNEL` in
   `build.yml`). Without them a build offers nothing and sends nothing.

The web app on the site is built by `scripts/publish-site.sh` on this machine: export the same three `VITE_*`
variables before running it if the web app should offer sharing too.

## Later

- Upload source maps to Sentry in CI (needs a Sentry auth token secret) so stack traces show source lines.
- Rust-side panics aren't reported (only the web view's errors).
- SignPath's terms ask for data collection to be shown "during installation": the consent screen appears before
  anything is sent, on first launch; if SignPath asks, also show the privacy summary in the installer
  (`bundle.licenseFile`).
