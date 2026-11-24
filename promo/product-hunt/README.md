# Product Hunt launch kit: Dispatch 0.2.0

Everything to paste into the Product Hunt composer, plus the launch-day plan. Copy follows the repo rule: warm,
problem-led, no other API tool named or compared, no claim beyond what 0.2.0 does. Nothing is submitted without the
owner's go-ahead.

## Listing

| Field | Text | Length |
|---|---|---|
| Name | Dispatch | 8 / 40 |
| Tagline | Build and test APIs on your computer, no account needed | 55 / 60 |
| Link | https://dispatch.ogcrafts.cloud | |
| Pricing | Free (open source, MIT) | |
| Topics | Developer Tools, API, Open Source (and Productivity if a fourth is allowed) | |

Other taglines, if the first is taken or feels long:
- Your API workbench, local-first and free (40)
- Send, test and document APIs without signing up (47)

**Description** (257 / 260 characters):

> Dispatch is a free, open-source API client that works without an account. Send requests, write tests, run
> collections and load tests, and generate docs. Your work stays on your computer, in a folder you can sync or put in
> git. Windows, macOS, Linux and web.

## Gallery

Upload in this order (1270×760, in `gallery/`); the first is also the social preview.

| # | File | Says |
|---|---|---|
| 1 | `01-cover.png` | Work on your APIs without an account |
| 2 | `02-local.png` | No sign-up. Nothing stored on our servers. |
| 3 | `03-extract.png` | Stop copying tokens by hand |
| 4 | `04-scripts.png` | Test every response, in a sandbox |
| 5 | `05-runner.png` | Run whole collections, not one call at a time |
| 6 | `06-load.png` | See how an API holds up under load |
| 7 | `07-docs.png` | Share a request without sharing your secrets |
| 8 | `08-looks.png` | Windows, macOS, Linux, or the browser |

Thumbnail: `gallery/thumbnail.png` (240×240, the app icon). Rebuild everything with `gallery.mjs` (steps at its top).

**Video:** Product Hunt takes a YouTube link. Upload `promo/out/dispatch-promo-16x9.mp4` (42 s, captions in
`site/src/assets/video/dispatch-promo.vtt`) to YouTube as Unlisted or Public, then paste the link. It was
recorded before 0.1.0: the request title row is the one from before #56, and nothing from 0.2.0 is in it.

## Maker's first comment

Post it right after the launch goes live.

> Hi everyone 👋
>
> I built Dispatch because I kept running into the same small frustrations with API tools: being asked to sign in
> just to check one endpoint, my requests being kept somewhere I didn't choose, and basics like running a collection
> or a load test sitting behind a plan.
>
> So Dispatch starts from the other end:
> - **No account.** Open it and send a request. Everything stays on your computer, and secrets are encrypted there.
> - **Your files, your sync.** A workspace can live in a folder of plain files. Put it in git, OneDrive, Dropbox or
>   Syncthing and it follows you; if a file changed in two places, you choose, file by file. Secret values only
>   travel if you turn that on, in one file encrypted with your passphrase.
> - **No copying tokens around.** Pick a value in a response and save it as a variable; every send refreshes it. On
>   desktop, each environment keeps its own cookies, so staging and production sign-ins stay apart.
> - **The basics are all there, free:** scripts and tests, a collection runner with data files and JUnit reports,
>   load tests, scheduled runs, docs, a local mock server, flows, gRPC, WebSocket, MQTT and MCP.
> - **Open source (MIT)**, on Windows, macOS, Linux and in the browser.
>
> An honest note: this is 0.2.0, an early release, and the installers aren't code-signed yet, so Windows and macOS will show a warning
> the first time. The site explains how to check a download, and the web app needs no install at all.
>
> I'd love to hear what gets in your way when you work with APIs, and what you'd want Dispatch to do next.

## Short replies for common questions

- **Is it really free?** Yes, MIT licensed, no paid tier for the basics, no account.
- **How do I use it on two computers or with a team?** Link a workspace to a folder (desktop) and keep that folder in
  whatever you already use to sync or share, or in git. Changes come in on their own; conflicts are never overwritten.
- **Can I bring my existing collections?** Yes: it imports OpenAPI 3, Swagger 2, HAR, cURL and the common collection
  file formats (Postman, Insomnia, Bruno), and exports to Postman's format. (Naming file formats is fine; never
  compare the products.)
- **Why does Windows warn me?** The installers aren't code-signed yet. Each download has a SHA-256
  on the download page and the builds come from public GitHub Actions runs.
- **How do I use a login's token in other requests?** Select it in the response, right-click, Extract into variable…,
  then write `{{token}}` where you need it. Each login refreshes it, in the runner, flows and `dispatch-run` too.
- **Does it send anything?** Only if you tick it on first launch: anonymous usage counts and error reports, both
  off by default. Details on the privacy page.
- **CI?** `dispatch-run` runs a workspace folder, collection or flow from the command line, with secrets from CI
  variables.

## Launch plan

Before the day:
1. Owner: a Product Hunt account (personal, as the maker) and, in claude.ai, reconnect the Product Hunt connector
   (it asked to sign in again on 2026-11-23; its tools were listed again on 2026-11-24, not tried). With it, Claude can create the draft, check the field limits and pick
   a free date; the owner submits.
2. Owner: upload the promo video to YouTube.
3. Pick a day: launches go live at 00:01 Pacific (13:31 in India). Tuesday to Thursday get the most traffic and
   the most competition; a weekend is quieter and easier to place on.
4. Tell people who'd care a day or two before (a short post where friends and colleagues follow you). Ask them to
   look and comment if they find it useful, not to upvote: Product Hunt penalises vote requests.

On the day:
1. Post the maker's comment as soon as it's live.
2. Reply to every comment, in the same warm tone.
3. Share the launch link on your own channels in the morning and once later in the day.
4. Watch the site's download numbers and the GitHub issues for first-run problems (SmartScreen, Gatekeeper).

After: thank commenters, file what people asked for on the Kan board "Dispatch", and add a "Featured on Product
Hunt" badge to the site only if the owner wants one.
