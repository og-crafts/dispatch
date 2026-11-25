# Dispatch by OGCrafts

An API client that stays out of your way. Open it and send the request: there is nothing to sign up for, and your
collections stay on your own machine. Build, send, test and document APIs in a desktop app (Tauri, for Linux,
Windows and macOS), in a web app built from the same code, or from a command-line runner for CI.

We built it because we wanted our API tool back: no login before the first request, no waiting for a sync, the
runner, load tests, mocks and docs all in the same free app, and collections as plain files that live in git.

No account, no sync. Collections, environments and history stay in this device's storage. Besides the requests you
send, Dispatch sends nothing unless you opt in to anonymous usage and error reports (asked on first launch; see
docs/TELEMETRY.md). The desktop app also asks GitHub for new versions on start and once a day; it tells you first, no
workspace data is sent, and Settings turns it off. If you add a model to the optional assistant (below), what you ask it,
and what it reads to answer, goes to that model and nowhere else; we receive none of it. Not everything is hidden from it:
see the privacy policy.

## Features

**Everyday work**
- Code editor (CodeMirror): syntax colours, `{{variable}}` and script (`dx.`) autocomplete, GraphQL completion from the
  schema, foldable JSON responses.
- Secrets (secret variables, passwords, tokens, keys, Authorization/Cookie headers) encrypted at rest with a
  non-exportable device key; OAuth tokens saved after automatic refresh.
- Undo for every delete; daily local backups with restore.
- Sidebar drag and drop, multi-select, search across bodies/headers/docs (Ctrl+K).
- Desktop: client certificates (mTLS), extra CA certificates, proxy, cookie manager.
- Script libraries: `require` lodash, moment, crypto-js, uuid, ajv, handlebars; JSON Schema checks;
  `dx.visualize` with a Visualize tab.
- Export to Postman; import from Insomnia and Bruno.
- Collections as files (desktop): a folder of YAML files for git, written as you work; the CLI runs folders.
- Scheduled runs with failure notifications.
- Server-sent events and Socket.IO.
- Response history per request with side-by-side compare.

**Browser logins and flows**
- Browser login requests: drive an installed Chrome or Edge through a login form (open, type, click, wait) and keep
  the cookies (HttpOnly too) or the token from localStorage/sessionStorage as secret variables and in the cookie
  jar. Runs in the desktop app, the runner, schedules, `dispatch-run` and MCP.
- MCP sign-in (desktop): when an MCP server asks for one, Dispatch finds its login, registers itself, and signs
  in with OAuth (PKCE, resource indicators). Tokens are kept per environment, encrypted, renewed automatically and
  never exported. A list of well-known MCP servers (Linear, Notion, Atlassian, Sentry, Stripe, GitHub, …) to start
  from.
- Flows: a canvas where you wire saved requests together with If, Script, Set variable, For each, Delay and End
  blocks. Requests branch on “ok”/“failed”; live status per block and a run log. Run them in the app,
  with `dispatch-run flow`, or from an AI assistant (`run_flow` over MCP). Flows are part of backups and exports.

- Assistant (desktop; after 0.2.0): stuck on why a test fails or what an old script does? Ask right inside Dispatch, with
  a model you connect (your own Anthropic or OpenAI key, an address you choose, or one running on this computer, such as
  Ollama). It reads your requests, scripts and variables, explains them, and can propose changes: a new test, a fixed
  script, values moved into variables. You see each change first, and it is made only when you press Apply. You can undo
  it until you close Dispatch. The assistant never sends or runs anything. A script you applied runs when you send the
  request, so read it first. Off until you add a connection. Secrets Dispatch knows are hidden from it, but it can't
  recognise every secret and ordinary data isn't hidden. Chats and keys stay sealed on the device, out of backups and
  folders. See https://dispatch.ogcrafts.cloud/privacy/#assistant.

**Requests**
- HTTP with params (kept in sync with the URL), `:path` variables, headers, and bodies: JSON, text, XML, HTML,
  urlencoded, multipart form-data with files, binary files, GraphQL.
- Several requests open in tabs (restored after a reload); per-request timeout, redirects and TLS settings.
- WebSocket and MQTT (over WebSocket) with saved messages and a live log; gRPC on desktop (server reflection or a
  pasted `.proto`; unary and streaming).
- GraphQL: fetch the schema by introspection, checks as you type, schema explorer with starter operations.

**Auth**: basic, bearer, API key, Digest, OAuth 2.0 (client credentials, password, authorization code + PKCE,
refresh), JWT (HS256/384/512), AWS Signature v4; inherited from folders and collections.

**Variables**: globals, collection, environment, data-file and script-local scopes; secret values (hidden, left out
of backups); 70 `{{$random…}}` fake-data generators; a `{{ }}` panel listing what's in scope.

**Scripts and tests**: JavaScript before the request and after the response, with Dispatch's `dx` API (variables,
request edits, `dx.response`, `dx.send`, runner control) and `test()`/`expect()` checks with chai. Reference:
[docs/SCRIPTS.md](docs/SCRIPTS.md). Scripts in collections imported from Postman run unchanged (`pm.*`), so you can
move over at your own pace. Scripts run sandboxed in a Web Worker with no network or storage access of their own. Console for script output and
the network log.

**Collections**: nested folders with their own auth, scripts and docs; history; runner for collections, folders and
suites with iterations, delays, CSV/JSON data files and stop-on-failure; JSON and JUnit reports.

**Performance**: load tests with up to 200 virtual users, ramp-up, duration or loops, think time, thresholds (p95,
error rate, throughput), latency and throughput charts, CSV export of every sample.

**Response**: pretty JSON with a JSONPath filter, HTML and image preview (sandboxed), headers, cookies, test
results, timing (first byte), save to file, save as example. Cookie jar on desktop.

**Share and reuse**: import Postman collections and environments, OpenAPI 3 / Swagger 2 (JSON or YAML), HAR and
curl; export a Dispatch backup or one collection; copy any request as code in 12 languages; generated Markdown docs
per collection; a mock server that serves saved examples (desktop, or `dispatch-run mock`).

**CLI** (`dispatch-run`): run collections, folders and suites with environments, data files and reporters;
`dispatch-run load` for load tests with pass/fail thresholds; `dispatch-run mock` to serve examples;
`dispatch-run flow` to run a flow from an export; `dispatch-run mcp` to let AI assistants (Claude and others) list, send and run your requests over MCP.
It also runs a **workspace folder** as the desktop app keeps it (`dispatch-run ./my-workspace --env Staging`), with
secret values from `DISPATCH_SECRET_<KEY>` or the folder's encrypted secrets file (`DISPATCH_VAULT_PASSPHRASE`).

## Desktop vs web

The desktop app sends requests from Rust: any server, every header, self-signed certificates (opt-in), cookies, the
mock server and gRPC. The web app uses the browser's `fetch`, so servers must allow it via CORS, the browser only
shows CORS-exposed response headers (Digest auth needs the server to expose `WWW-Authenticate`), and gRPC and the
mock server aren't available.

## Try it

    node examples/demo-server.mjs        # a tiny API on :4318 (login, orders, Digest, a flaky endpoint)

Import `examples/demo-shop.dispatch.json`, then run it in the Runner with `examples/users.csv` as the data file, or
from the command line (`examples/demo-shop.postman_collection.json` is the same collection as a Postman file, to try
an import):

    npm run build:cli
    ./dist-cli/dispatch-run.mjs examples/demo-shop.dispatch.json -d examples/users.csv --junit report.xml

For gRPC see `examples/grpc/README.md`.

## Not yet

Signed installers (in progress; see docs/SIGNING.md), optional sync between devices (needs a design) and gRPC in
the browser.

Already here since the early previews: in-app updates on desktop (you are asked before anything is installed), a
local connection for the AI assistant you already use (off by default, secrets hidden; Settings → AI assistants),
Share as HTML, and usage and error reports that stay off unless you opt in (docs/TELEMETRY.md).

## Build

See [CLAUDE.md](CLAUDE.md).

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)
(starting with the first release after the project is accepted; earlier Windows installers are unsigned).
Committers and reviewers: [og-crafts members](https://github.com/orgs/og-crafts/people). Approvers:
[og-crafts owners](https://github.com/orgs/og-crafts/people?query=role%3Aowner). Privacy: apart from
looking for new versions on GitHub (can be turned off), this program will not transfer any information to other
networked systems unless specifically requested by the user or the person installing or operating it. Full policy: https://dispatch.ogcrafts.cloud/code-signing/

## Licence

MIT. See [LICENSE](LICENSE). The bundled fonts keep their own licence: see
[THIRD-PARTY-NOTICES](public/THIRD-PARTY-NOTICES.txt).

To help out, read [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, read [SECURITY.md](SECURITY.md).
