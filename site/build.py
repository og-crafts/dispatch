#!/usr/bin/env python3
"""Builds the Dispatch website into site/dist. No dependencies: python3 site/build.py [--strict]

--strict also fails the build when the web app build (dist/ in the repo root) is missing, so a publish can never
go out without /app/.
Optional inputs: site/release.json (desktop installers, see README), ../dist (web app, copied to dist/app/),
../dist-cli/dispatch-run.mjs (CLI, copied to dist/downloads/).
"""
import hashlib, html, json, re, shutil, sys, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
SRC, DIST = ROOT / "src", ROOT / "dist"
BASE = "https://dispatch.ogcrafts.cloud"
EMAIL = "hello@ogcrafts.cloud"
DAY = datetime.date.today().isoformat()
# When each legal page's wording last changed. Change the date with the text, never on a plain rebuild.
UPDATED = {"privacy": "2026-11-25", "code-signing": "2026-11-25", "terms": "2026-11-14"}
VERSION = json.loads((REPO / "package.json").read_text())["version"]
STRICT = "--strict" in sys.argv
e = html.escape

RELEASE = None  # {"version","date","assets":[{"os","arch","kind","url","size_mb","sha256"}]}
if (ROOT / "release.json").exists(): RELEASE = json.loads((ROOT / "release.json").read_text())
WEB_DIST = REPO / "dist"
WEB = (WEB_DIST / "index.html").exists()
CLI_FILE = REPO / "dist-cli" / "dispatch-run.mjs"
CLI = CLI_FILE.exists()

NAV = [("/#features", "Features"), ("/download/", "Download"), ("/cli/", "CLI"), ("/changelog/", "Changelog"), ("/support/", "Support")]
SHOTS = {  # file -> (alt text, caption)
    "request": ("Dispatch in light theme: a POST request that creates an order, its 201 Created response with a JSON body and 2 of 2 tests passed", "Send a request and read the response, with the JSON folded and filterable."),
    "scripts": ("A post-response script with test, expect and dx.collection, and the passing test listed under the response", "Scripts and tests run in a sandbox. The response shows each test."),
    "runner": ("The collection runner results: fifteen requests across three data rows, 18 tests passed and none failed", "The runner sends a collection once per data row and lists every result."),
    "load": ("A passed load test with request count, median, p95 and error rate, and charts of response time and requests per second", "A load test with charts, thresholds and a per-status breakdown."),
    "docs": ("Generated documentation for a collection: variables, the Login request with headers and body", "Documentation generated from the collection, ready to export as Markdown."),
}

# Structured data for the home page (a data block, not a script: the CSP does not apply and nothing runs).
LD_JSON = json.dumps({"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "Dispatch", "applicationCategory": "DeveloperApplication",
    "operatingSystem": "Windows, macOS, Linux, Web", "description": "An API client with no account and no cloud. Your collections stay on your machine.",
    "url": BASE + "/", "image": BASE + "/assets/og.png", "license": "https://opensource.org/licenses/MIT", "isAccessibleForFree": True,
    "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"}, "author": {"@type": "Organization", "name": "OGCrafts", "url": "https://ogcrafts.cloud"}},
    separators=(",", ":")).replace("</", "<\\/")

# ---------- small helpers ----------
def inline(t):
    t = e(t, quote=False)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    return t
def ul(items): return "<ul>" + "".join(f"<li>{inline(i)}</li>" for i in items) + "</ul>"

# Every screenshot comes in each look and in light and dark: request.png (Dispatch, light), request-dark.png,
# request-grove.png, request-grove-dark.png, request-grove-classic.png, request-grove-classic-dark.png
# (scripts/screenshots.mjs site). The page names the Dispatch pair; look.js swaps in the visitor's look.
LOOK_SUFFIX = {"dispatch": "", "grove": "-grove", "grove-classic": "-grove-classic"}
def shot_file(name, look="dispatch", dark=False): return f"/assets/shots/{name}{LOOK_SUFFIX[look]}{'-dark' if dark else ''}.png"
def picture(name, lazy=True, look="dispatch"):
    alt, _ = SHOTS[name]
    l = ' loading="lazy"' if lazy else ""
    img = f'<img src="{shot_file(name, look)}" data-shot="{name}" width="1440" height="900" alt="{e(alt)}"{l}>'
    return f'<picture><source srcset="{shot_file(name, look, True)}" media="(prefers-color-scheme: dark)">{img}</picture>'
def figure(name, lazy=True, look=None, caption=None):
    """look: show this look whatever the visitor picked (the Themes section shows Grove)."""
    pic = picture(name, lazy, look or "dispatch")
    if lazy: pic = f'<a class="full" href="{shot_file(name, look or "dispatch")}" aria-label="Open the full-size screenshot: {e(SHOTS[name][0])}">{pic}</a>'
    fixed = f' data-look="{look}"' if look else ""
    return f'<figure class="shot"{fixed}>{pic}<figcaption>{e(caption or SHOTS[name][1])}</figcaption></figure>'

LOOK_PICKER = """<details class="lookPicker" hidden><summary aria-label="Look and colours">Look</summary><div class="lookMenu">
<fieldset><legend>Look</legend><label><input type="radio" name="look" value="dispatch"> Dispatch <span class="sw sw-dispatch"></span></label>
<label><input type="radio" name="look" value="grove"> Grove <span class="sw sw-grove"></span></label>
<label><input type="radio" name="look" value="grove-classic"> Grove classic <span class="sw sw-grove"></span></label></fieldset>
<fieldset><legend>Colours</legend><label><input type="radio" name="theme" value="system"> System</label>
<label><input type="radio" name="theme" value="light"> Light</label><label><input type="radio" name="theme" value="dark"> Dark</label></fieldset>
<p>The same looks as in the app (Settings, Themes). Kept in this browser only.</p></div></details>"""

# ---------- page shell ----------
def shell(path, title, desc, body, current="", noindex=False):
    canon = BASE + path
    ld = f'\n<script type="application/ld+json">{LD_JSON}</script>' if path == "/" else ""
    navs = "".join(f'<a href="{h}"{" aria-current=\"page\"" if h == current else ""}>{l}</a>' for h, l in NAV)
    app = '<a href="/app/">Open the web app</a>' if WEB else ""
    robots = '<meta name="robots" content="noindex">' if noindex else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F7F7F8" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0F0F10" media="(prefers-color-scheme: dark)">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; font-src 'self'; base-uri 'self'; form-action 'none'">
<link rel="canonical" href="{canon}">{robots}
<link rel="manifest" href="/site.webmanifest">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml"><link rel="icon" href="/assets/icon-32.png" sizes="32x32" type="image/png"><link rel="apple-touch-icon" href="/assets/icon-180.png">
<link rel="preload" href="/assets/fonts/manrope-latin.woff2" as="font" type="font/woff2" crossorigin>
<meta property="og:type" content="website"><meta property="og:site_name" content="Dispatch"><meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}"><meta property="og:url" content="{canon}"><meta property="og:image" content="{BASE}/assets/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Dispatch by OGCrafts: an API client with no account and no cloud">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{e(title)}"><meta name="twitter:description" content="{e(desc)}"><meta name="twitter:image" content="{BASE}/assets/og.png">{ld}
<script src="/assets/look.js"></script>
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js" defer></script>
</head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="wrap"><a class="brand" href="/"><img src="/assets/icon-32.png" width="32" height="32" alt="">Dispatch</a>
<nav class="main" aria-label="Main">{navs}{'<a href="/app/">Web app</a>' if WEB else ""}</nav>{LOOK_PICKER}</div></header>
<main id="main">
{body}
</main>
<footer class="site"><div class="wrap">
<div><a class="brand" href="/"><img src="/assets/icon-32.png" width="32" height="32" alt="">Dispatch</a>
<p>An API client that keeps your work on your machine. No account, nothing shared unless you say yes.</p></div>
<div><h2>Dispatch</h2><ul><li><a href="/#features">Features</a></li><li><a href="/download/">Download</a></li><li><a href="/cli/">Command line</a></li><li>{app or '<a href="/download/">Web app</a>'}</li><li><a href="/changelog/">Changelog</a></li><li><a href="https://github.com/og-crafts/dispatch">Source code</a></li></ul></div>
<div><h2>Fine print</h2><ul><li><a href="/privacy/">Privacy policy</a></li><li><a href="/terms/">Terms of use</a></li><li><a href="/code-signing/">Code signing policy</a></li><li><a href="/support/">Support</a></li><li><a href="mailto:{EMAIL}">{EMAIL}</a></li></ul></div>
<small>&copy; {DAY[:4]} OGCrafts. Dispatch is made by <a href="https://ogcrafts.cloud">OGCrafts</a>. Other product and format names that appear on this site are used only to say what Dispatch can import or export; they belong to their owners, and Dispatch is independent of and not affiliated with them.</small>
</div></footer></body></html>"""

def article(path, title, desc, inner, crumb):
    body = f'<div class="article"><div class="wrap"><p class="crumbs"><a href="/">Home</a> / {crumb}</p>{inner}</div></div>'
    return shell(path, f"{title} | Dispatch", desc, body, current=path)

# ---------- content ----------
# Each card starts from a frustration people have with API tools and says what Dispatch does about it.
# No product is named or compared here, on purpose.
WHY = [
 ("No account. Open it and send.", "There is nothing to sign up for and no login between you and your first request. Dispatch has no accounts at all, so there is no account to lose access to either."),
 ("Your work stays where you put it.", "Collections, environments and history are saved on your machine. Secrets are encrypted with a key that never leaves it. We run no server that receives your requests, and we could not read them if we wanted to."),
 ("The basics are not behind a paywall.", "The runner, load tests, mock server, documentation and command-line runner are all in the same free app. There are no tiers, seats or limits on how many times you may run your own collection."),
 ("It works when the network doesn&rsquo;t.", "On a train, on a locked-down VPN or in a room with no signal, the desktop app opens and your collections are there. Nothing has to sync before you can work."),
 ("Your team already has a place to share.", "Link a workspace to a folder and it becomes plain YAML files. Review them in a pull request and share them through the git you already use."),
 ("You decide what leaves your machine.", "Usage and error reports are off until you tick a box, and the privacy policy lists exactly what they contain. Your URLs, requests and responses are never part of them. The assistant contacts a model only when you ask it something, or press Test or Load models for a connection you set up, and the policy says what goes to whom."),
]

FEATURES = [
 ("Requests", "HTTP with params, path variables, headers and bodies: JSON, text, XML, HTML, urlencoded, multipart with files, binary and GraphQL. Also WebSocket, MQTT over WebSocket, server-sent events, Socket.IO and, on desktop, gRPC with server reflection or a `.proto` file. Several requests open in tabs."),
 ("GraphQL", "Fetch the schema by introspection, get completions and checks as you type, and browse the schema with starter operations."),
 ("Auth", "Basic, bearer, API key, Digest, OAuth 2.0 (client credentials, password, authorization code with PKCE, refresh), JWT and AWS Signature v4. Folders and collections can set auth for everything inside."),
 ("Variables and secrets", "Globals, collection, environment, data-file and script scopes, plus 70 `{{$random...}}` fake-data generators. Secret values are hidden, left out of exports, and encrypted on this device."),
 ("Scripts and tests", "Pre-request and post-response JavaScript with Dispatch's `dx` API (variables, request edits, `dx.response`, `dx.send`) and `test`/`expect` checks. Scripts from collections you import from Postman run unchanged. Scripts run in a sandbox with no network or storage access of their own. Common libraries can be loaded with `require`."),
 ("Browser logins", "On desktop, a Browser login request drives your installed Chrome or Edge through a login page: open, type, click, wait. It keeps the cookies (HttpOnly too) or the token from local storage as secret variables, so the requests after it are signed in. It also runs in the runner, schedules and the CLI."),
 ("Flows", "Wire saved requests together on a canvas with If, Script, Set variable, For each, Delay and End blocks. Requests branch on ok or failed, and each block shows its status live while the flow runs. Run flows in the app or with `dispatch-run flow`."),
 ("MCP", "Test MCP servers: connect over HTTP or, on desktop, start a local server command, then list and call tools, read resources and get prompts. On desktop, sign in to servers that use OAuth; the sign-in is kept per environment as a secret. `dispatch-run mcp` works the other way round and lets an AI assistant list, send and run your saved requests, limited to the methods you allow."),
 ("Ask about your own requests", "Stuck on why a test fails, or what an old script does? In versions after 0.2.0 the desktop app has an assistant you can ask right inside Dispatch. Connect a model with your own key, or one that runs on this computer. It reads your requests, scripts and variables, explains them and suggests scripts you can copy. It does not change or send anything. It is off until you add a connection, secrets Dispatch knows about are hidden from it, and the privacy policy says plainly what that does and does not cover."),
 ("AI assistants, on your terms", "On desktop, Dispatch can let the AI assistant you already use work with your requests through a local connection. It is off until you turn it on, limited to the methods you allow, and secret values are hidden from it. Hand a request over with a note, and decide whether the assistant may edit your workspace or only its own."),
 ("Share as a page", "Turn a request or a collection into one HTML file anyone can open, with the response and examples included and secret values removed before it is written."),
 ("Runner and data-driven runs", "Run a collection, a folder or a suite, with iterations, delays, CSV or JSON data files and stop-on-failure. Export JSON or JUnit reports."),
 ("Load testing", "Up to 200 virtual users with ramp-up, duration or loops, think time and pass/fail thresholds (p95, error rate, throughput). Latency and throughput charts, and a CSV of every sample."),
 ("Schedules", "On desktop, run a collection every few minutes and get a notification when it fails. Results are kept."),
 ("Mocks and docs", "Generated Markdown documentation per collection. A mock server that serves your saved examples, on desktop or with the CLI."),
 ("Workspaces as files", "On desktop, keep a whole workspace (its collections, environments and flows) or a single collection as a folder of plain YAML files, written as you work, so it can live in git. Keep the folder in OneDrive, Dropbox, iCloud Drive, Syncthing or git to have it on your other computers: changes made there come in on their own, and a file changed in both places is never overwritten. Secret values stay on the device, unless you turn on Sync secrets: then they travel in one file encrypted with a passphrase only you know. The CLI runs collection folders."),
 ("Import and export", "Import Postman collections and environments, Insomnia exports, Bruno folders, OpenAPI 3 and Swagger 2 (JSON or YAML), HAR files and curl commands. Export a Dispatch backup, one collection, or a Postman collection."),
 ("Code in 12 languages", "Copy any request as curl, JavaScript fetch, Node axios, Python requests, Go, Java, C#, PHP, Ruby, Rust, HTTPie or PowerShell."),
 ("The CLI", "`dispatch-run` runs collections, folders, suites and flows with environments and data files, runs load tests with pass/fail thresholds, serves mocks, and serves a collection to AI assistants over MCP. Built for CI."),
 ("Workspaces and tidy-ups", "Group collections, environments and flows into workspaces. Duplicate an environment. Parameterize turns hard-coded hosts, tokens and IDs in a request into variables, and is offered right after you paste a curl command. A variable can hold named alternatives, such as the load balancer or one instance, and the runner can run once per alternative to compare them."),
 ("Everyday comforts", "A code editor with syntax colours and `{{variable}}` completion, undo for every delete, daily local backups with restore, drag and drop in the sidebar, search across bodies and headers (Ctrl+K), and response history with side-by-side compare."),
]
COMPARE = [
 ("Requests are sent from", "The Rust side of the app", "Your browser, with `fetch`"),
 ("Servers you can reach", "Any server", "Servers that allow it through CORS"),
 ("Response headers shown", "All of them", "Only the ones the server exposes through CORS"),
 ("Self-signed certificates", "Allowed, if you turn it on", "Up to the browser"),
 ("Cookies", "Cookie jar with a manager", "The browser's own rules"),
 ("Client certificates, extra CAs, proxy", "Yes", "No"),
 ("gRPC", "Yes", "No"),
 ("Browser logins", "Yes, with your installed Chrome or Edge", "No"),
 ("MCP servers", "Over HTTP, or a local command", "Over HTTP, if the server allows CORS"),
 ("Mock server", "Yes", "No (use the CLI)"),
 ("Workspaces and collections as files, schedules", "Yes", "No"),
 ("Load tests", "No browser limits", "About six connections per server, and CORS applies"),
 ("Everything else", "Same", "Same: tabs, scripts, runner, docs, imports, code generation"),
]
FAQ = [
 ("Is Dispatch free?", "Yes. There are no accounts, ads or paid tiers."),
 ("Is Dispatch open source?", "Yes, under the MIT licence. The source code is on <a href=\"https://github.com/og-crafts/dispatch\">GitHub</a>, so you can read it, build it yourself and report issues there."),
 ("Where is my data stored?", "On your device. The desktop app and the web app both keep collections, environments and history in local storage (IndexedDB). If you link a workspace or collection to a folder on desktop, that folder holds them too. We run no server that receives your data."),
 ("Does it send anything besides my requests?", "Usage and error reports only if you agree. On first launch Dispatch asks whether to share anonymous usage (which features are used) and reports of its own errors; both are off unless you tick them, and you can change them in Settings. It never sends your URLs, requests, responses or variables in those. The desktop app also asks GitHub whether there is a new version, when it starts and once a day. It tells you first, sends no workspace data, installs nothing without asking, and you can turn it off in Settings. In versions after 0.2.0 the desktop app also has an assistant. It is off until you add a connection, and then it sends your questions, and what it reads to answer them, to the model you chose: Anthropic, OpenAI, an address you type or a model on this computer. We receive none of it. See the privacy policy."),
 ("What happens to my secrets?", "Secret variables, passwords, tokens, keys and Authorization or Cookie headers are encrypted before they are stored, using a key that stays on the device and cannot be exported. A copy of the database moved to another device cannot read them. Exports and backups leave secrets out. An assistant key is kept the same way and is sent only to the connection it belongs to."),
 ("What if I clear my browser data?", "The web app keeps its data in that browser, so clearing site data erases it. Use Menu, Export backup now and then. The desktop app is not affected by browser data."),
 ("Why does the web app say servers must allow CORS?", "A web page can only read responses from servers that permit it. If a server does not, use the desktop app, which has no such rule."),
 ("Can I bring my existing collections?", "Yes. Dispatch imports Postman collections and environments, Insomnia exports, Bruno folders, OpenAPI files, HAR files and curl commands, so you can try it with the requests you already have."),
 ("Are the installers signed?", "Not yet. Windows SmartScreen and macOS Gatekeeper will warn on first launch. The <a href=\"/download/#unsigned\">download page</a> explains how to open them."),
 ("Does it sync between devices?", "Not now. Export a backup, or link a workspace to a folder and keep it in git."),
 ("Is there a mobile app?", "No. The web app works in a phone browser but is built for a larger screen."),
 ("How do I get help or report a problem?", f"Write to <a href=\"mailto:{EMAIL}\">{EMAIL}</a>."),
]
PRIVACY_KEEP = ["Collections, requests, environments, history and settings", "Secret values, encrypted with a key that stays on the device", "Daily local backups", "Everything the app saves, in local storage or in the folder you pick"]
PRIVACY_NEVER = ["No account or sign-in", "No analytics or error reports unless you opt in", "No assistant traffic until you ask it something, or press Test or Load models, with a connection you set up", "No workspace data in update checks, which you can turn off", "No fonts, scripts or images from other sites", "No server that receives your collections"]
NEXT = [
 ("Live folder updates", "A workspace folder reloads as its files change, for example after a git pull, instead of the next time Dispatch saves or you click Reload."),
 ("Workspace folders in the CLI", "Run a workspace folder with `dispatch-run`, choosing its environment and flows, with secret values from environment variables in CI."),
 ("Signed installers", "Code-signed installers for Windows and macOS, so they open without a warning."),
]

def app_buttons(primary=True):
    out = ""
    if WEB: out += f'<a class="btn primary" href="/app/">Open in your browser</a>'
    out += f'<a class="btn{"" if WEB else " primary"}" href="/download/">Download for desktop</a>'
    return out

def home():
    why = "".join(f'<div class="card"><h3>{t}</h3><p>{inline(d)}</p></div>' for t, d in WHY)
    feats = "".join(f'<div class="card"><h3>{t}</h3><p>{inline(d)}</p></div>' for t, d in FEATURES)
    cmp_rows = "".join(f"<tr><th scope=\"row\">{inline(a)}</th><td>{inline(b)}</td><td>{inline(c)}</td></tr>" for a, b, c in COMPARE)
    faq = "".join(f"<details><summary>{q}</summary><p>{a if '<a' in a else inline(a)}</p></details>" for q, a in FAQ)
    nxt = "".join(f'<div class="card"><h3>{t} <span class="tag">Planned</span></h3><p>{d}</p></div>' for t, d in NEXT)
    keep = "".join(f"<li>{inline(k)}</li>" for k in PRIVACY_KEEP)
    never = "".join(f"<li>{inline(k)}</li>" for k in PRIVACY_NEVER)
    return f"""
<section class="hero"><div class="wrap"><div>
<p class="eyebrow">Dispatch by OGCrafts</p>
<h1>Open it. Send the request. That&rsquo;s it.</h1>
<p class="lead">Dispatch is an API client that stays out of your way. Nothing to sign up for, nothing to log in to, and your collections stay on your own machine.</p>
<div class="cta-row">{app_buttons()}</div>
<p class="note">Free and open source. For Windows, macOS and Linux, in your browser, and on the command line for CI.</p></div>
{figure("request", lazy=False)}</div></section>
<div class="promise"><div class="wrap"><ul><li>No sign-up, ever</li><li>Your data stays with you</li><li>Nothing behind a paywall</li><li>Plain files that live in git</li><li>Open source (MIT)</li></ul></div></div>
<section id="watch"><div class="wrap"><div class="section-head"><p class="eyebrow">A short tour</p><h2>See it in under a minute.</h2><p class="lead">Send a request, test it, run it for every row, load test it, and pick a look. The video has captions.</p></div>
<figure class="video"><video controls preload="none" playsinline width="1920" height="1080" poster="/assets/video/dispatch-promo-poster.jpg"><source src="/assets/video/dispatch-promo-16x9.mp4" type="video/mp4"><track kind="captions" src="/assets/video/dispatch-promo.vtt" srclang="en" label="English" default>Your browser can&rsquo;t play this video. <a href="/assets/video/dispatch-promo-16x9.mp4">Download it</a> instead.</video></figure></div></section>
<section id="why"><div class="wrap"><div class="section-head"><p class="eyebrow">Why we built it</p><h2>We wanted our API tool back.</h2><p class="lead">You know the feeling. You only want to check one endpoint, and first there is a login screen, a sync spinner and a banner about a plan you don&rsquo;t need. We felt that too, so we built the tool we wanted to use.</p></div>
<div class="grid three">{why}</div></div></section>
<section class="tint" id="tour"><div class="wrap">
<div class="split"><div><p class="eyebrow">Scripts and tests</p><h2>Check every response.</h2><p>Write a few lines of JavaScript after a request to test the status, the body or the timing, and to save a value like a token for the next request. Each test shows as passed or failed under the response.</p><p>Scripts run in a sandbox, apart from the app and your saved data.</p></div>{figure("scripts")}</div>
<div class="split flip"><div><p class="eyebrow">Runner</p><h2>Run it again for every row.</h2><p>Run a whole collection, a folder or several collections as a suite. Give it a CSV or JSON file and it runs once per row, with the columns as variables. Export the results as JSON or JUnit.</p><p>The same run works from the command line, so CI can do it too.</p></div>{figure("runner")}</div>
<div class="split"><div><p class="eyebrow">Load testing</p><h2>See how it holds up.</h2><p>Send the same request, or a whole flow, from up to 200 virtual users. Set pass and fail thresholds for p95 latency, error rate and throughput, and watch the charts.</p><p>Load test only servers you own or have permission to test. Dispatch asks you to confirm that before it starts.</p></div>{figure("load")}</div>
<div class="split flip"><div><p class="eyebrow">Docs and mocks</p><h2>Documentation comes with the collection.</h2><p>Dispatch writes Markdown documentation from your requests, parameters, bodies and saved examples, and leaves secret values out. Save a response as an example and a mock server can serve it back.</p></div>{figure("docs")}</div>
<div class="split"><div><p class="eyebrow">Themes</p><h2>Pick the look that suits you.</h2><p>Dispatch comes in graphite with one amber accent. Grove is roomier, in mint and forest green, and Grove classic keeps those colours on the compact layout. Each look has a light and a dark side, or follows your system.</p><p>Change it any time in Settings, Themes.</p></div>{figure("request", look="grove", caption="The Grove look: roomier, in mint and forest green.")}</div>
</div></section>
<section id="features"><div class="wrap"><div class="section-head"><p class="eyebrow">Also in the box</p><h2>The whole job, in one app.</h2><p class="lead">Send requests, check the responses, run them in bulk, and write up the result. All of it is included.</p></div>
<div class="grid">{feats}</div></div></section>
<section class="tint" id="imports"><div class="wrap"><div class="section-head"><p class="eyebrow">Bring what you have</p><h2>Import, export, keep in git.</h2><p>Years of saved requests shouldn&rsquo;t be the price of trying something new. Dispatch reads the formats your collections are already in, and writes its own as plain files.</p></div>
<ul class="chips"><li>Postman collections and environments</li><li>Insomnia</li><li>Bruno folders</li><li>OpenAPI 3 and Swagger 2</li><li>HAR</li><li>curl</li><li>Postman export</li><li>YAML folders for git</li></ul>
<p class="muted">Import any of them from the menu, or paste a curl command into the URL bar.</p></div></section>
<section id="compare"><div class="wrap"><div class="section-head"><p class="eyebrow">Desktop or web</p><h2>Same app, two ways to send.</h2><p>The desktop app sends requests from Rust, so it can reach any server. The web app uses the browser&rsquo;s <code>fetch</code>, so the browser&rsquo;s rules apply.</p></div>
<div class="table-wrap"><table><thead><tr><th scope="col">&nbsp;</th><th scope="col">Desktop</th><th scope="col">Web</th></tr></thead><tbody>{cmp_rows}</tbody></table></div></div></section>
<section class="tint" id="privacy"><div class="wrap"><div class="section-head"><p class="eyebrow">Privacy</p><h2>Your APIs are your business.</h2><p>Dispatch has no servers of its own to send your data to. The <a href="/privacy/">privacy policy</a> has the details in plain words.</p></div>
<div class="grid"><div class="card"><h3>Kept on your device</h3><ul>{keep}</ul></div><div class="card"><h3>What we will never do</h3><ul>{never}</ul></div></div></div></section>
<section id="next"><div class="wrap"><div class="section-head"><p class="eyebrow">Coming next</p><h2>Planned, not shipped.</h2><p>These are ideas we intend to build. They are not in the current release, and there is no date.</p></div><div class="grid">{nxt}</div></div></section>
<section class="tint" id="faq"><div class="wrap"><div class="section-head"><p class="eyebrow">FAQ</p><h2>Good questions.</h2></div>{faq}<p>Still stuck? <a href="/support/">Contact support</a>.</p></div></section>
<section><div class="wrap"><h2>Send your first request in a minute.</h2><p class="lead">Open the web app and try it. There is nothing to sign up for.</p><div class="cta-row">{app_buttons()}</div></div></section>
"""

def dl_card(os_key, title, assets):
    rows = ""
    for a in assets:
        rows += (f'<li><div class="dl-main"><strong>{e(a["kind"])}</strong><span class="muted">{e(a["arch"])} &middot; {e(str(a["size_mb"]))} MB</span>'
                 f'<code class="hash">SHA-256 {e(a["sha256"])}</code></div><a class="btn small primary" href="{e(a["url"])}" download>Download</a></li>')
    return f'<div class="panel" data-os="{os_key}"><h3>{title}</h3><ul class="dl">{rows}</ul></div>'

def download():
    if RELEASE and RELEASE.get("assets"):
        by = {}
        for a in RELEASE["assets"]: by.setdefault(a["os"].lower(), []).append(a)
        names = {"windows": "Windows", "macos": "macOS", "linux": "Linux"}
        cards = "".join(dl_card(k, names[k], by[k]) for k in ("windows", "macos", "linux") if k in by)
        main = f'<p>Version <strong>{e(RELEASE["version"])}</strong>, released {e(RELEASE["date"])}.</p>{cards}<p>The same files are on the <a href="https://github.com/og-crafts/dispatch/releases">GitHub releases page</a>, with the release notes.</p><p class="note">Check a download against its SHA-256 checksum: <code>sha256sum file</code> on Linux, <code>shasum -a 256 file</code> on macOS, <code>Get-FileHash file</code> in PowerShell.</p>'
    else:
        main = '<div class="panel"><h2>Desktop downloads coming soon</h2><p>The installers are not public yet. Until they are, use the web app in your browser, or the command-line runner.</p></div>'
    web = f'<p><a class="btn primary" href="/app/">Open the web app</a></p>' if WEB else ""
    cli = '<a href="/cli/">command-line runner</a>'
    return f"""<h1>Download Dispatch</h1>
<p class="lead">The desktop app for Windows, macOS and Linux, free and with no account.</p>
{main}
<h2>No install: the web app</h2><p>The same app runs in your browser and keeps its data in that browser. It can only reach servers that allow it through CORS, and it has no gRPC, mock server or collection folders. See <a href="/#compare">desktop or web</a>.</p>{web}
<h2>Command line</h2><p>The {cli} runs collections in CI and needs Node.js 20 or newer.</p>
<h2 id="unsigned">The installers are not signed yet</h2>
<div class="callout">Windows and macOS will warn you the first time you open Dispatch. That is expected for an app without a paid code-signing certificate, and it does not mean the file is damaged.</div>
<h3>Windows</h3><p>SmartScreen shows &ldquo;Windows protected your PC&rdquo;. Choose <strong>More info</strong>, then <strong>Run anyway</strong>.</p>
<h3>macOS</h3><p>macOS says &ldquo;Apple could not verify Dispatch is free of malware&rdquo;. To open it the first time:</p>
<ol><li>Open the <code>.dmg</code> and drag Dispatch to Applications. Open Dispatch once and choose <strong>Done</strong> (not Move to Trash).</li>
<li>Open <strong>System Settings, Privacy &amp; Security</strong>, scroll down to the message about Dispatch and choose <strong>Open Anyway</strong>. Confirm with your password or Touch ID.</li>
<li>Open Dispatch again and choose <strong>Open</strong>. macOS remembers this, so you only do it once.</li></ol>
<p>If <strong>Open Anyway</strong> isn&rsquo;t there, run this in Terminal, then open Dispatch as usual:</p>
<pre><code>xattr -dr com.apple.quarantine /Applications/Dispatch.app</code></pre>
<h3>Linux</h3><p>There is no signing warning. Install the <code>.deb</code> with <code>sudo apt install ./file.deb</code> or the <code>.rpm</code> with <code>sudo dnf install ./file.rpm</code>. For an AppImage, make it executable (<code>chmod +x file.AppImage</code>) and run it.</p>
<p>Check the SHA-256 checksum next to each download before you open it. The desktop app tells you when there is a new version and can update itself (also under <strong>Menu, Check for updates</strong>). The Linux .deb and .rpm packages don&rsquo;t update themselves: download the new one here. Updates are checked against Dispatch&rsquo;s own signing key before they install. If you installed a preview from before 0.1.0, it can&rsquo;t update to 0.1.0: export a backup in it (<strong>Menu, Export backup</strong>), uninstall it, install 0.1.0 from this page and import the backup.</p>
<p>The <a href="/code-signing/">code signing policy</a> says how Dispatch&rsquo;s installers are built and how you can check that a download is genuine.</p>"""

def cli_page():
    dl = (f'<p><a class="btn primary" href="/downloads/dispatch-run.mjs" download>Download dispatch-run.mjs</a><code class="hash">SHA-256 {CLI_SHA}</code></p>' if CLI else '<p class="note">The download link appears here when the site is published.</p>')
    return f"""<h1>Command line</h1>
<p class="lead"><code>dispatch-run</code> runs your Dispatch collections without the app, for CI, scripts and load checks. It uses the same code as the app.</p>
{dl}
<p>It is one file and needs Node.js 20 or newer. No install step, no dependencies to fetch.</p>
<h2>Run a collection</h2>
<pre><code>node dispatch-run.mjs demo-shop.postman_collection.json -d users.csv --junit report.xml</code></pre>
<p>It accepts a Dispatch backup, a Postman collection, or a collection folder of YAML files written by the desktop app. Requests run in order with their scripts and tests, once per row of the data file. The exit code is non-zero when a test fails, so a CI job fails with it.</p>
<h2>Run a workspace folder</h2>
<pre><code>node dispatch-run.mjs ./payments-workspace --env Staging --collection "Payments API"</code></pre>
<p>A workspace kept in a folder by the desktop app (in a git repository, for example) runs as it is: pick an environment by name with <code>--env</code>, a collection with <code>--collection</code>, or a flow with <code>--flow</code>. The files never hold secret values, so a CI job passes them in:</p>
<ul><li><code>DISPATCH_SECRET_&lt;KEY&gt;</code> fills the secret variable <code>&lt;key&gt;</code>, written in capitals with <code>_</code> for anything that isn’t a letter or digit (<code>api-key</code> → <code>DISPATCH_SECRET_API_KEY</code>). Map your CI’s own secret store onto these.</li>
<li><code>DISPATCH_VAULT_PASSPHRASE</code> opens the folder’s encrypted secrets file, if you turned on <strong>Sync secrets</strong> in the app. <code>DISPATCH_SECRET_*</code> values win over it.</li></ul>
<h2>Options</h2>
<div class="table-wrap"><table><thead><tr><th scope="col">Option</th><th scope="col">What it does</th></tr></thead><tbody>
<tr><td><code>-c, --collection</code></td><td>Collection to run (default: the only or first one)</td></tr>
<tr><td><code>-f, --folder</code></td><td>Folder to run, like <code>Parent/Child</code>. Repeat to run a suite</td></tr>
<tr><td><code>-e, --env</code></td><td>Environment by name (in the file or workspace folder), or an environment file</td></tr>
<tr><td><code>--env-var key=value</code></td><td>Set a variable. It wins over the environment</td></tr>
<tr><td><code>-d, --data</code></td><td>CSV or JSON data file, one iteration per row</td></tr>
<tr><td><code>-n, --iterations</code></td><td>Number of iterations</td></tr>
<tr><td><code>--delay</code>, <code>--timeout</code></td><td>Wait between requests, and per-request timeout, in milliseconds</td></tr>
<tr><td><code>--bail</code></td><td>Stop at the first failure</td></tr>
<tr><td><code>-k, --insecure</code></td><td>Accept self-signed TLS certificates</td></tr>
<tr><td><code>-r, --reporters</code></td><td><code>cli</code>, <code>json</code>, <code>junit</code> (with <code>--json</code> and <code>--junit</code> for the file paths)</td></tr>
</tbody></table></div>
<h2>Load test</h2>
<pre><code>node dispatch-run.mjs load demo-shop.postman_collection.json --request Flaky \\
  --vus 20 --duration 30s --p95 800 --max-errors 1 --i-have-permission</code></pre>
<p>Sends from virtual users and exits non-zero if a threshold is missed. <code>--i-have-permission</code> is required: use it only against servers you own or may test. Other options: <code>--loops</code>, <code>--ramp-up</code>, <code>--think</code>, <code>--min-rps</code>, <code>--samples</code> (write every sample as CSV).</p>
<h2>Mock server</h2>
<pre><code>node dispatch-run.mjs mock demo-shop.postman_collection.json</code></pre>
<p>Serves the saved examples in a collection. Run <code>node dispatch-run.mjs --help</code> for every option.</p>
<h2>Flows</h2>
<pre><code>node dispatch-run.mjs flow my-backup.json --flow "Checkout" -e staging.json</code></pre>
<p>Runs a flow from a Dispatch backup or export, with the same blocks and branches as in the app. Browser login steps need Chrome or Edge on the machine.</p>
<h2>Serve a collection to an AI assistant (MCP)</h2>
<pre><code>claude mcp add dispatch -- node dispatch-run.mjs mcp ./my-collection -e staging.json --allow-methods GET,HEAD</code></pre>
<p>An MCP server over stdio with four tools: <code>list_requests</code>, <code>send_request</code>, <code>run_collection</code> and <code>run_flow</code>. Requests go through their auth, scripts and tests. <code>--allow-methods</code> limits what the assistant may send.</p>
<h2>In GitHub Actions</h2>
<pre><code>- uses: actions/setup-node@v4
  with: {{ node-version: 22 }}
- run: node dispatch-run.mjs api.collection.json -e staging.json --junit report.xml</code></pre>"""

def changelog():
    """Built from changelog.json, the same file the app's About dialog reads."""
    data = json.loads((REPO / "changelog.json").read_text(encoding="utf-8"))
    def rel(r): return f'<div class="release"><h2 id="v{r["version"].replace(".", "-")}">{r["version"]} <span class="muted">{r["date"]}</span></h2><p>{inline(r["title"])}</p>{ul(r["changes"])}</div>'
    return "<h1>Changelog</h1><p class=\"lead\">What changed in each release, newest first.</p>" + "".join(rel(r) for r in data["releases"])

def support():
    faq = "".join(f"<details><summary>{q}</summary><p>{a if '<a' in a else inline(a)}</p></details>" for q, a in FAQ)
    return f"""<h1>Support</h1><p>We are a small team and we read every message.</p>
<div class="panel"><h2>Write to us</h2><p>Email <a href="mailto:{EMAIL}">{EMAIL}</a>. Say which version you use (Menu in the app, or the changelog) and whether it is the desktop app, the web app or the CLI. Please do not send secrets or whole collections; describe the request instead.</p></div>
<h2>Common questions</h2>{faq}"""

# ---------- legal ----------
def privacy():
    return f"""<h1>Privacy policy</h1><p class="updated">Last updated {UPDATED["privacy"]}.</p>
<p>Dispatch is built so that we never receive your data: your collections, requests and responses stay with you. If you agree, it sends us a little anonymous information about how it is used and about its own errors. If you add a model to the Dispatch assistant, what you ask it goes to that model, never to us. This page says exactly what.</p>
<h2>What Dispatch stores</h2>
<p>Your collections, requests, environments, variables, history, cookies, settings and backups. They stay on your device: in your browser&rsquo;s local storage (IndexedDB) for the web app, in the app&rsquo;s local storage for the desktop app, and in a folder you choose if you link a workspace or collection to one. We have no server that receives any of it.</p>
<h2>Secrets</h2>
<p>Secret variables, passwords, tokens, keys, and Authorization and Cookie headers are encrypted before they are saved, using a key that stays on the device and cannot be exported. Exports and backups you download leave secrets out. The same goes for the keys of assistant connections (below).</p>
<p>If you keep a workspace in a folder and turn on <strong>Sync secrets</strong>, its secret values are also written to that folder, in one file encrypted with a passphrase you choose (AES-256-GCM, key made with PBKDF2). The file goes wherever you keep the folder (your cloud drive or git repository); it never comes to us, and without the passphrase it can’t be read. It is off unless you turn it on.</p>
<h2>Requests you send</h2>
<p>When you press Send, Dispatch sends that request to the address you typed, with the headers and body you set. Besides that, Dispatch itself only looks for new versions (desktop, described below), sends the reports you opt in to and, in versions after 0.2.0, sends what the Dispatch assistant needs if you have added a connection to it (described below). What the other server does with it is up to that server. Scripts you write can send requests too (<code>dx.send</code>), to the places you tell them to.</p>
<p>A Browser login request opens your installed Chrome or Edge with a new, empty profile that is deleted afterwards, with sync and background networking turned off. It visits the pages in your steps. The values it keeps, such as cookies or a token, are stored as secret variables on this device.</p>
<h2 id="assistant">The Dispatch assistant (versions after 0.2.0, desktop app)</h2>
<p>The desktop app can have an assistant you ask about your own workspace: why a test fails, what a script does, how to write the next one. It is off until you add a connection under <strong>Settings, AI assistants</strong>. The web app does not have it. Without a connection nothing of it runs and nothing is sent.</p>
<p><strong>Where your questions go.</strong> Only to the connection you chose, and only when you ask something:</p>
<ul><li><strong>Anthropic</strong>: to <code>api.anthropic.com</code>, under your own key.</li>
<li><strong>OpenAI</strong>: to <code>api.openai.com</code>, under your own key.</li>
<li><strong>An address you choose</strong> (a gateway, or a server on your network): to exactly that address, with the key you gave it, if any.</li>
<li><strong>A model on this computer</strong> (for example Ollama at <code>localhost</code>): to your own computer, so nothing leaves it.</li></ul>
<p>Before the first question to a host that is not this computer, Dispatch asks you to allow that host. Changing the scheme, host or port of a connection&rsquo;s address takes away that permission and its key; changing only its path keeps both. Loading a connection&rsquo;s list of models and pressing <strong>Test</strong> contact that host too; the key goes with them, and the test sends a short made-up question, nothing from your workspace. We receive none of this. What the host does with it is up to the host: read its own privacy policy, and note that a model on a server you do not run is somebody else&rsquo;s server.</p>
<p><strong>What the model can read in this version.</strong> What you type, and to answer it, the requests, scripts, names and plain variable values of the workspace you have open, and its environments. The console and past responses only if you tick that for the connection (it is ticked for a model on this computer and not otherwise); the console covers all your workspaces, not only the open one, and the consent question says so. It can only read. It cannot change, send, run or delete anything, and it is told so.</p>
<p><strong>What is hidden, and what is not.</strong> Values Dispatch knows to be secret are replaced by <code>&lt;hidden&gt;</code> before anything leaves your computer: secret variables, tokens, passwords and keys, Authorization and Cookie headers and values, other cookies, sign-ins, client certificate keys and the assistant keys, from every workspace, not just the open one. That is a best effort, and it has limits. Dispatch cannot recognise every secret: one pasted into a plain variable, a URL, a script or a request body under an ordinary name can go to the model. A known secret shorter than six characters is hidden in its own field, but not where the same text turns up somewhere else. Ordinary data is not hidden at all, such as names, e-mail addresses or records in a response the model reads. Do not tick the console option for a host you do not trust, and do not ask the assistant about things you would not send to it.</p>
<p><strong>What is kept on your device.</strong> Connection keys are encrypted like other secrets, with a key that stays on the device, are sent only to the connection they belong to, and are never exported or backed up. Chats are kept on this device, encrypted, per workspace (the last 50), and are never in backups, exports, workspace folders or any sync. Turn <strong>Keep chats on this device</strong> off, or press <strong>Delete all chats</strong>, in Settings, AI assistants; deleting a workspace deletes its chats; removing a connection deletes its key.</p>
<p>We receive nothing from the assistant: no questions, answers, chats, keys or counts. It adds no usage events and no error reports beyond the opt-in ones above.</p>
<h2>What Dispatch does not do</h2>
<ul><li>No account, sign-in or sync.</li><li>No assistant traffic until you ask it something, or press <strong>Test</strong> or <strong>Load models</strong>, with a connection you set up; your workspace goes to a host that is not this computer only after you allow that host; and nothing to us ever.</li><li>No analytics or error reports unless you opt in (below).</li><li>No workspace data in update checks. In versions after 0.2.0, the desktop app looks for a new version when it starts and once a day, and when you choose <strong>Menu, Check for updates</strong>. A notice tells you before the first automatic check, which waits until you restart Dispatch or 24 hours have passed; turn it off there or under <strong>Settings, General</strong>. Up to 0.2.0, automatic checks are off unless you turn them on. The web app never checks. The check asks GitHub, where the releases are published, for a small file that names the newest version; GitHub sees your IP address, as with any download. Nothing about you or your data is sent, and nothing is installed unless you agree.</li><li>No advertising and no trackers.</li><li>No fonts, scripts or images loaded from other sites, in the app or on this website.</li><li>This website sets no cookies. If you pick a look with the Look menu, your browser keeps that choice in its local storage, on your device only.</li></ul>
<h2 id="opt-in">Usage and error reports (only if you agree)</h2>
<p>The first time you open Dispatch it asks whether to share two things. Both are off unless you tick them, and you can change them any time in <strong>Settings, General, Privacy</strong>.</p>
<ul><li><strong>Anonymous usage</strong>, sent to <a href="https://aptabase.com">Aptabase</a> (an analytics service built for privacy, EU or US hosting): the name of an action, such as &ldquo;sent a request&rdquo;, &ldquo;imported a file&rdquo; or &ldquo;checked for updates&rdquo;, with fixed labels like the request type (HTTP, gRPC&hellip;) or the import format; the Dispatch version, desktop or web, operating system and language; and a random session number that changes every time Dispatch starts. No user id, no cookies, and never your URLs, requests, responses, names, variables or files. See <a href="https://aptabase.com/legal/privacy">Aptabase&rsquo;s privacy policy</a>.</li>
<li><strong>Error reports</strong>, sent to <a href="https://sentry.io">Sentry</a> (error tracking): when Dispatch itself fails, the error message and where in Dispatch&rsquo;s code it happened, plus the version, operating system and browser engine. Before it leaves your device, Dispatch blanks out web addresses, e-mail and IP addresses, tokens and other long values, and leaves out what led up to the error. See <a href="https://sentry.io/privacy/">Sentry&rsquo;s privacy policy</a>.</li></ul>
<p>We use this only to find bugs and decide what to improve, keep it no longer than the services&rsquo; standard retention (about 90 days for error reports), and never sell or share it. The services see your IP address when they receive the data, as any server does; we don&rsquo;t store it.</p>
<h2>Feedback</h2>
<p><strong>Menu, Send feedback</strong> fills in a GitHub issue (public) or an e-mail to us for you to check and send yourself. Dispatch doesn&rsquo;t send it.</p>
<h2>The web app and this website</h2>
<p>This website and the web app at <a href="/app/">dispatch.ogcrafts.cloud/app/</a> are static files hosted on GitHub Pages. When you open them, GitHub&rsquo;s servers receive the request for the files and, like any web host, may log your IP address and browser details under <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub&rsquo;s privacy statement</a>. We do not receive those logs for individual visitors and we do not add cookies or tracking. After the files load, the web app does its work in your browser.</p>
<h2>Your control</h2>
<p>To remove everything, delete the data in the app (chats and connection keys under Settings, AI assistants), clear this site&rsquo;s data in your browser, or uninstall the desktop app and delete any collection folder you created. Nothing is kept by us. Whatever a model host you chose received is kept under that host&rsquo;s own rules, and only it can delete that.</p>
<h2>Children</h2><p>Dispatch is a developer tool and is not directed at children.</p>
<h2>Changes and contact</h2>
<p>If this policy changes, the date above changes and the changelog says so. Questions: <a href="mailto:{EMAIL}">{EMAIL}</a>.</p>"""

def code_signing():
    return f"""<h1>Code signing policy</h1><p class="updated">Last updated {UPDATED["code-signing"]}.</p>
<p>The Windows and macOS installers of Dispatch are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper warn the first time you open Dispatch. The <a href="/download/#unsigned">download page</a> explains how to open it. This page says how the installers are made and how you can check that the file you have is the one we published.</p>
<h2>How the installers are made</h2>
<ul><li>Every installer is built by GitHub Actions on GitHub-hosted runners, directly from the source code in the public repository <a href="https://github.com/og-crafts/dispatch">og-crafts/dispatch</a>, when a version tag is pushed.</li>
<li>The files are attached to the release on the <a href="https://github.com/og-crafts/dispatch/releases">GitHub releases page</a>. The <a href="/download/">download page</a> links to those same files.</li>
<li>Nothing built outside that workflow is published as a Dispatch installer.</li></ul>
<h2>How to check a download</h2>
<ul><li>The download page lists a SHA-256 checksum for each installer. Compare it with <code>Get-FileHash file</code> in PowerShell, <code>shasum -a 256 file</code> on macOS or <code>sha256sum file</code> on Linux.</li>
<li>Updates installed from inside the desktop app are checked against Dispatch&rsquo;s own update signing key before they install, so a changed update is refused.</li></ul>
<h2>Team roles</h2>
<ul><li>Committers and reviewers: <a href="https://github.com/orgs/og-crafts/people">members of the og-crafts organization</a>. Changes from anyone else arrive as pull requests and are reviewed by a member before they are merged.</li>
<li>Releases: <a href="https://github.com/orgs/og-crafts/people?query=role%3Aowner">owners of the og-crafts organization</a> check and publish every release by hand.</li></ul>
<p>Everyone in these roles uses multi-factor authentication for GitHub.</p>
<h2>Privacy</h2>
<p>Apart from looking for new versions on GitHub (described below, can be turned off), this program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Requests go to the addresses you send them to, and, in versions after 0.2.0, if you add a connection to the Dispatch assistant, what you ask it goes to the model you chose (never to us). Anonymous usage and error reports are sent only if you agree when Dispatch first starts (both unticked; changeable in Settings), and the desktop app looks for new versions on GitHub unless you turn that off (it tells you first and sends no workspace data). The <a href="/privacy/">privacy policy</a> has the details.</p>
<h2>Report a problem</h2>
<p>If you think a Dispatch file is harmful or was not built from this project&rsquo;s source, write to <a href="mailto:{EMAIL}">{EMAIL}</a>.</p>"""

def terms():
    return f"""<h1>Terms of use</h1><p class="updated">Last updated {UPDATED["terms"]}.</p>
<p>These terms cover your use of Dispatch, its website and its web app. By using them you agree to these terms.</p>
<h2>What you get</h2>
<p>Dispatch is free software provided by OGCrafts. You may use it for personal and commercial work, and you may use the command-line runner in your own build pipelines.</p>
<h2>Your data and your requests</h2>
<p>You are responsible for the requests you send and for the servers you send them to. Send requests, and especially load tests, only to systems you own or have permission to test. Keep the credentials you put in Dispatch safe, and keep backups: the web app&rsquo;s data lives in one browser and can be lost when site data is cleared.</p>
<h2>Third-party names</h2>
<p>Dispatch can import and export file formats from other tools. Their names are used only to describe those formats. Dispatch is independent and is not affiliated with or endorsed by them.</p>
<h2>No warranty</h2>
<p>Dispatch is provided &ldquo;as is&rdquo;, without warranties of any kind. It is a developer tool, and it can send requests that change or delete data on the servers you point it at. To the extent the law allows, OGCrafts is not liable for loss or damage from using Dispatch, including lost data or requests sent in error.</p>
<h2>Installers</h2>
<p>Desktop installers are not code-signed yet, so your system may warn when you open them. Check the SHA-256 checksum published with each download, and download only from this website or the project&rsquo;s GitHub releases page.</p>
<h2>Changes and contact</h2>
<p>We may update these terms; the date above will change. Questions: <a href="mailto:{EMAIL}">{EMAIL}</a>.</p>"""

# ---------- contrast check (WCAG) from the tokens in site.css ----------
def lum(h):
    c = [int(h[i:i+2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= .03928 else ((x + .055) / 1.055) ** 2.4 for x in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]
def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True); return (la + .05) / (lb + .05)
def tokens():
    """Every palette in site.css, by the name in its "/* tokens: <name> */" comment. A name may appear twice (the
    system-dark block and the forced-dark copy); the copies must match."""
    css = (SRC / "site.css").read_text()
    found = {}
    for name, body in re.findall(r"/\* tokens: ([\w-]+) \*/\s*[^{]+\{(.*?)\}", css, re.S):
        t = dict(re.findall(r"--([\w-]+):\s*(#[0-9A-Fa-f]{6})", body))
        if name in found and found[name] != t: raise SystemExit(f"site.css: the two '{name}' blocks differ")
        found[name] = t
    want = {"dispatch-light", "dispatch-dark", "grove-light", "grove-dark"}
    if set(found) != want: raise SystemExit(f"site.css must have the palettes {sorted(want)}, found {sorted(found)}")
    return found
PAIRS = [("ink", "bg"), ("ink", "surface"), ("ink", "sunken"), ("ink", "primary-soft"), ("muted", "bg"), ("muted", "surface"), ("muted", "sunken"),
         ("link", "bg"), ("link", "surface"), ("link", "sunken"), ("link", "primary-soft"), ("on-primary", "primary"),
         ("good", "surface"), ("good", "good-soft"), ("good", "bg"), ("warn", "warn-soft"), ("warn", "surface"), ("muted", "good-soft"),
         ("m-get", "surface"), ("m-post", "surface"), ("m-put", "surface"), ("m-patch", "surface"), ("m-delete", "surface"), ("danger", "surface")]
def check_contrast():
    out = []
    for mode, t in tokens().items():
        for fg, bg in PAIRS:
            if fg not in t or bg not in t: out.append(f"contrast: token missing {fg}/{bg} ({mode})"); continue
            r = ratio(t[fg], t[bg])
            if r < 4.5: out.append(f"contrast {mode} {fg} on {bg}: {r:.2f}")
    return out

# ---------- build ----------
CLI_SHA = hashlib.sha256(CLI_FILE.read_bytes()).hexdigest() if CLI else ""

def main():
    if DIST.exists(): shutil.rmtree(DIST)
    A = DIST / "assets"
    (A / "fonts").mkdir(parents=True); (A / "shots").mkdir()
    shutil.copy(SRC / "site.css", A / "site.css"); shutil.copy(SRC / "site.js", A / "site.js"); shutil.copy(SRC / "look.js", A / "look.js")
    for f in (SRC / "assets/fonts").glob("*.*"): shutil.copy(f, A / "fonts" / f.name)
    for f in (SRC / "assets/icons").glob("*.*"): shutil.copy(f, A / f.name)
    shutil.copy(SRC / "assets/og.png", A / "og.png")
    for f in (SRC / "assets/shots").glob("*.png"): shutil.copy(f, A / "shots" / f.name)
    if (SRC / "assets/video").is_dir(): shutil.copytree(SRC / "assets/video", A / "video")
    if WEB: shutil.copytree(WEB_DIST, DIST / "app")
    if CLI: (DIST / "downloads").mkdir(); shutil.copy(CLI_FILE, DIST / "downloads/dispatch-run.mjs")

    pages = {"/": shell("/", "Dispatch: an API client with no account and no cloud", "Open it and send the request. Nothing to sign up for, and your collections stay on your own machine. Free and open source, for desktop, web and CI.", home(), current="/")}
    pages["/download/"] = article("/download/", "Download", "Download Dispatch for Windows, macOS and Linux, open the web app, or get the command-line runner.", download(), "Download")
    pages["/cli/"] = article("/cli/", "Command line", "dispatch-run runs Dispatch collections, load tests and mock servers from the command line and in CI.", cli_page(), "Command line")
    pages["/changelog/"] = article("/changelog/", "Changelog", "What changed in each Dispatch release.", changelog(), "Changelog")
    pages["/privacy/"] = article("/privacy/", "Privacy policy", "Dispatch keeps your data on your device. Usage and error reports are opt-in, and the optional assistant sends only to the model you choose. Read the privacy policy in plain words.", privacy(), "Privacy policy")
    pages["/terms/"] = article("/terms/", "Terms of use", "The terms for using Dispatch.", terms(), "Terms of use")
    pages["/code-signing/"] = article("/code-signing/", "Code signing policy", "How Dispatch's installers are built, how to check a download, and who publishes releases.", code_signing(), "Code signing policy")
    pages["/support/"] = article("/support/", "Support", "Get help with Dispatch.", support(), "Support")
    for path, h in pages.items():
        out = DIST / path.lstrip("/") / "index.html"; out.parent.mkdir(parents=True, exist_ok=True); out.write_text(h)
    (DIST / "404.html").write_text(shell("/404.html", "Page not found | Dispatch", "That page is not here.", '<div class="article"><div class="wrap"><h1>Page not found</h1><p>That page is not here. Try the <a href="/">home page</a> or <a href="/support/">support</a>.</p></div></div>', noindex=True))
    urls = list(pages) + (["/app/"] if WEB else [])
    (DIST / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"<url><loc>{BASE}{p}</loc><lastmod>{DAY}</lastmod></url>\n" for p in urls) + "</urlset>\n")
    (DIST / "CNAME").write_text("dispatch.ogcrafts.cloud\n"); (DIST / ".nojekyll").write_text("")
    (DIST / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {BASE}/sitemap.xml\n")
    (DIST / "site.webmanifest").write_text(json.dumps({"name": "Dispatch", "short_name": "Dispatch", "description": "An API client that keeps your work on your machine", "start_url": "/app/", "scope": "/app/", "display": "standalone",
        "icons": [{"src": "/assets/icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "/assets/icon-512.png", "sizes": "512x512", "type": "image/png"}],
        "theme_color": "#0F0F10", "background_color": "#0F0F10"}) + "\n")
    return check(pages)

def check(pages):
    problems = []
    allp = {**pages, "/404.html": (DIST / "404.html").read_text()}
    ids_of = {p: re.findall(r'\bid="([^"]+)"', h) for p, h in allp.items()}
    for path, h in allp.items():
        for href in re.findall(r'(?:href|src|srcset|poster)="(/[^"#?]*)', h):
            t = DIST / href.lstrip("/")
            if not (t.is_file() or (t / "index.html").is_file()): problems.append(f"{path}: broken {href}")
        for href, frag in re.findall(r'href="(/[^"#]*)#([^"]+)"', h):
            tgt = href if href else path
            tp = tgt if tgt in ids_of else (tgt + "/" if tgt + "/" in ids_of else None)
            if tp and frag not in ids_of[tp]: problems.append(f"{path}: missing anchor {href}#{frag}")
        for frag in re.findall(r'href="#([^"]+)"', h):
            if frag not in ids_of[path]: problems.append(f"{path}: missing anchor #{frag}")
        for tag in re.findall(r"<img [^>]*>", h):
            if " alt=" not in tag: problems.append(f"{path}: img without alt: {tag[:60]}")
        ids = ids_of[path]
        if len(ids) != len(set(ids)): problems.append(f"{path}: duplicate ids {sorted({i for i in ids if ids.count(i) > 1})}")
        if h.count("<h1") != 1: problems.append(f"{path}: needs exactly one h1")
        if "Content-Security-Policy" not in h: problems.append(f"{path}: no CSP meta")
        if re.search(r"<script(?![^>]*\s(?:src=|type=\"application/ld\+json\"))", h): problems.append(f"{path}: inline script")
        for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S):
            try: json.loads(block)
            except ValueError: problems.append(f"{path}: JSON-LD does not parse")
        if re.search(r"\son\w+=\"", h): problems.append(f"{path}: inline event handler")
        if re.search(r"\sstyle=\"", h): problems.append(f"{path}: inline style attribute (CSP style-src 'self')")
        if "<style" in h: problems.append(f"{path}: inline <style>")
        for tag in re.findall(r"<(?:img|script|link|source|track|iframe|audio|video)\b[^>]*>", h):
            m = re.search(r'(?:src|srcset|href)="(https?:)?//([^"]*)', tag)
            if m and 'rel="canonical"' not in tag: problems.append(f"{path}: third-party resource: {tag[:80]}")
    for r in check_contrast(): problems.append(r)
    css = (DIST / "assets/site.css").read_text()
    if "http://" in css or re.search(r"url\(\s*['\"]?(https?:|//)", css): problems.append("css has an external url")
    for m in re.findall(r"url\(([^)]+)\)", css):
        t = DIST / m.strip("'\" ").lstrip("/")
        if not t.is_file(): problems.append(f"css: missing {m}")
    if RELEASE:
        for a in RELEASE.get("assets", []):
            if not str(a.get("url", "")).startswith("https://"): problems.append(f"release.json: asset url must be https: {a.get('url')}")
            if not re.fullmatch(r"[0-9a-f]{64}", str(a.get("sha256", ""))): problems.append(f"release.json: bad sha256 for {a.get('url')}")
            if a.get("os", "").lower() not in ("windows", "macos", "linux"): problems.append(f"release.json: unknown os {a.get('os')}")
    if WEB and not (DIST / "app/index.html").exists(): problems.append("app/index.html missing")
    if STRICT and not WEB: problems.append("strict: web app build (dist/ in the repo root) is missing; run npm run build")
    if STRICT and not CLI: problems.append("strict: CLI build (dist-cli/) is missing; run npm run build:cli")
    return problems

if __name__ == "__main__":
    pr = main()
    if pr: print("\n".join(pr)); sys.exit(1)
    print("site built:", sum(1 for p in DIST.rglob("*.html") if "app" not in p.relative_to(DIST).parts[:1]), "pages; web app:", "yes" if WEB else "no", "; cli:", "yes" if CLI else "no", "; release.json:", "yes" if RELEASE else "no")
