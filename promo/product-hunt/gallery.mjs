#!/usr/bin/env node
// Builds the Product Hunt gallery (1270×760 PNGs) and the 240×240 thumbnail into promo/product-hunt/gallery/ (committed),
// from its own screenshots (promo/product-hunt/shots, 2x: `npm run build`, then `node scripts/screenshots.mjs ph`).
//
//   PLAYWRIGHT=~/projects/github-tools/rea/node_modules/playwright-core \
//   CHROMIUM=~/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell \
//   node promo/product-hunt/gallery.mjs
//
// Copy for every slide lives in SLIDES below; keep it problem-led and never name or compare other tools.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../..')
const OUT = join(HERE, 'gallery')
const pw = process.env.PLAYWRIGHT
if (!pw) { console.error('Set PLAYWRIGHT to a playwright or playwright-core package directory.'); process.exit(2) }
const { chromium } = createRequire(join(pw, 'package.json'))(pw)

const dataUrl = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`
const shot = (name) => dataUrl(join(HERE, 'shots', `${name}.png`), 'image/png')
const FONT = dataUrl(join(REPO, 'promo/public/fonts/manrope.woff2'), 'font/woff2')
const ICON = dataUrl(join(REPO, 'public/icon.svg'), 'image/svg+xml')

// kicker: small line above; title: the problem answered; text: one sentence; img: screenshot; dark: slide scheme.
const SLIDES = [
  { file: '01-cover', cover: true, dark: true, img: 'dark-request',
    title: 'Work on your APIs without an account', text: 'Build, send, test and document APIs on your own computer. Free and open source.' },
  { file: '02-local', dark: false, img: 'light-request', kicker: 'Local-first',
    title: 'No sign-up. Nothing stored on our servers.', text: 'Your work stays on your computer. To have it elsewhere, keep a workspace in a folder you already sync or put in git.' },
  { file: '03-scripts', dark: false, img: 'light-scripts', kicker: 'Scripts and tests',
    title: 'Test every response, in a sandbox', text: 'Before-request and test scripts with completion, assertions and common libraries built in.' },
  { file: '04-runner', dark: true, img: 'dark-runner', kicker: 'Runner',
    title: 'Run whole collections, not one call at a time', text: 'Iterations, CSV or JSON data, JUnit reports for CI, and scheduled runs.' },
  { file: '05-load', dark: true, img: 'dark-load', kicker: 'Load tests',
    title: 'See how an API holds up under load', text: 'Virtual users, a duration and an error limit, with live charts. No paywall in the way.' },
  { file: '06-docs', dark: false, img: 'light-docs', kicker: 'Docs and sharing',
    title: 'Share a request without sharing your secrets', text: 'Generated docs, and one self-contained HTML page with secrets and server addresses left out.' },
  { file: '07-looks', dark: false, img: 'grove-request', kicker: 'Desktop and web',
    title: 'Windows, macOS, Linux, or the browser', text: 'Three looks in light and dark. MIT licensed, with no account and no paid tier for the basics.' },
]

const css = (dark) => `
  @font-face { font-family: Manrope; src: url(${FONT}) format('woff2'); font-weight: 200 800; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1270px; height: 760px; overflow: hidden; }
  body { font-family: Manrope, sans-serif; background: ${dark ? '#0F0F10' : '#F7F7F8'}; color: ${dark ? '#EDEDED' : '#171717'};
    padding: 56px 0 0 64px; display: grid; grid-template-columns: 400px 1fr; gap: 48px; }
  .copy { padding-top: 24px; display: flex; flex-direction: column; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 22px; }
  .brand img { width: 40px; height: 40px; border-radius: 10px; }
  .kicker { color: ${dark ? '#FFB020' : '#8A5300'}; font-weight: 600; font-size: 18px; }
  h1 { font-size: 40px; line-height: 1.12; font-weight: 700; letter-spacing: -0.01em; }
  .cover h1 { font-size: 46px; }
  p { font-size: 20px; line-height: 1.45; color: ${dark ? '#A1A1A6' : '#525252'}; }
  .url { margin-top: auto; margin-bottom: 64px; font-size: 18px; font-weight: 600; color: ${dark ? '#FFC24D' : '#8A5300'}; }
  .shot { align-self: end; justify-self: start; width: 820px; height: 640px; border-radius: 14px 0 0 0; overflow: hidden;
    border: 1px solid ${dark ? '#2C2C2F' : '#E2E2E6'}; border-right: 0; border-bottom: 0;
    box-shadow: 0 10px 40px ${dark ? 'rgba(0,0,0,.5)' : 'rgba(23,23,23,.10)'}; }
  .shot img { width: 1120px; display: block; }
`

const slideHtml = (s) => `<!doctype html><html><head><meta charset="utf-8"><style>${css(s.dark)}</style></head>
<body class="${s.cover ? 'cover' : ''}"><div class="copy">
  <div class="brand"><img src="${ICON}" alt="">Dispatch</div>
  ${s.kicker ? `<div class="kicker">${s.kicker}</div>` : ''}
  <h1>${s.title}</h1><p>${s.text}</p>
  <div class="url">dispatch.ogcrafts.cloud</div>
</div><div class="shot"><img src="${shot(s.img)}" alt=""></div></body></html>`

const thumbHtml = `<!doctype html><html><head><style>*{margin:0}html,body{width:240px;height:240px;background:transparent}
img{width:240px;height:240px;display:block}</style></head><body><img src="${ICON}" alt=""></body></html>`

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
const page = await browser.newPage({ viewport: { width: 1270, height: 760 }, deviceScaleFactor: 1 })
for (const s of SLIDES) {
  await page.setContent(slideHtml(s), { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(OUT, `${s.file}.png`) })
  console.log(`${s.file}.png`)
}
await page.setViewportSize({ width: 240, height: 240 })
await page.setContent(thumbHtml, { waitUntil: 'load' })
await page.screenshot({ path: join(OUT, 'thumbnail.png'), omitBackground: true })
console.log('thumbnail.png')
await browser.close()
