#!/usr/bin/env node
// Takes the website's screenshots (site/src/assets/shots, 1440×900) or the promo video's (promo/public/shots, 2x)
// from the real web app: it imports examples/demo-shop.postman_collection.json, makes a "Demo shop (local)"
// environment, sends requests to examples/demo-server.mjs and runs the runner and a load test.
//
//   npm run build                      # the web app in dist/
//   node scripts/screenshots.mjs site  # or: promo
//
// Needs Playwright with a Chromium. Point PLAYWRIGHT at a playwright or playwright-core package directory and,
// if its own browser isn't installed, CHROMIUM at a chrome binary. Ports 4318 (demo API) and 5291 (preview) must be free.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
if (!['site', 'promo'].includes(target)) { console.error('usage: node scripts/screenshots.mjs site|promo'); process.exit(2) }
if (!existsSync(join(REPO, 'dist/index.html'))) { console.error('dist/ is missing: run npm run build first'); process.exit(2) }
const pw = process.env.PLAYWRIGHT
if (!pw) { console.error('Set PLAYWRIGHT to a playwright or playwright-core package directory.'); process.exit(2) }
const { chromium } = createRequire(join(pw, 'package.json'))(pw)

// [file name, scheme, look, which shots]. The site wants 1x, the video 2x for sharp zooms.
const SITE = join(REPO, 'site/src/assets/shots')
const PROMO = join(REPO, 'promo/public/shots')
const RUNS = target === 'site'
  ? [
      { scheme: 'light', look: 'dispatch', which: ['request', 'scripts', 'runner', 'load', 'docs'], name: (s) => `${SITE}/${s}.png` },
      { scheme: 'dark', look: 'dispatch', which: ['request'], name: () => `${SITE}/request-dark.png` },
      { scheme: 'light', look: 'grove', which: ['request'], name: () => `${SITE}/grove.png` },
      { scheme: 'dark', look: 'grove', which: ['request'], name: () => `${SITE}/grove-dark.png` },
    ].map((r) => ({ ...r, dpr: 1 }))
  : [
      { scheme: 'light', look: 'dispatch', which: ['request', 'scripts', 'docs'], prefix: 'light' },
      { scheme: 'dark', look: 'dispatch', which: ['request', 'runner', 'load'], prefix: 'dark' },
      { scheme: 'light', look: 'grove', which: ['request'], prefix: 'grove' },
      { scheme: 'dark', look: 'grove', which: ['request'], prefix: 'grove-dark' },
    ].map((r) => ({ ...r, dpr: 2, name: (s) => `${PROMO}/${r.prefix}-${s}.png` }))

const procs = []
const start = (cmd, args) => { const p = spawn(cmd, args, { cwd: REPO, stdio: 'ignore' }); procs.push(p); return p }
const up = async (url) => { for (let i = 0; i < 60; i++) { try { await fetch(url); return } catch { await sleep(500) } } throw new Error(`${url} did not come up`) }
start(process.execPath, ['examples/demo-server.mjs', '4318'])
start(process.execPath, [join(REPO, 'node_modules/vite/bin/vite.js'), 'preview', '--port', '5291', '--strictPort'])

try {
  await up('http://127.0.0.1:4318/login')
  await up('http://127.0.0.1:5291/')
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
  for (const run of RUNS) {
    mkdirSync(dirname(run.name('x')), { recursive: true })
    await capture(browser, run)
  }
  await browser.close()
} finally {
  for (const p of procs) p.kill()
}

async function capture(browser, { scheme, look, dpr, which, name }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: dpr })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const wait = (ms) => page.waitForTimeout(ms)
  const want = (k) => which.includes(k)
  const shot = async (k) => { await wait(400); await page.mouse.move(1430, 890); await wait(150); await page.screenshot({ path: name(k) }); console.log(name(k).replace(REPO + '/', '')) }
  // The Collections button toggles the sidebar, so only press it when it is off.
  const rail = async (label) => { const b = page.locator('.railBtn', { hasText: label }); if (label !== 'Collections' || !(await b.getAttribute('class')).includes(' on')) await b.click(); await wait(700) }
  const row = (label) => page.locator('.rowMain', { hasText: label }).first()
  const send = async () => { await page.locator('.btn.primary', { hasText: 'Send' }).click(); await wait(1500) }
  const toResults = async () => { await page.evaluate(() => [...document.querySelectorAll('h2, h3')].find((e) => e.textContent.trim() === 'Results')?.scrollIntoView({ block: 'start' })); await wait(300) }
  const dismissToasts = async () => { for (const b of await page.locator('.toastClose').all()) await b.click().catch(() => {}) }

  await page.goto('http://127.0.0.1:5291/'); await wait(1500)
  const consent = page.locator('dialog[open] button', { hasText: /No thanks|Not now/ }).first()
  if (await consent.count()) await consent.click().catch(() => {})
  await page.locator('input[aria-label="Import file"]').setInputFiles(join(REPO, 'examples/demo-shop.postman_collection.json'))
  await wait(1200); await dismissToasts()

  if (look !== 'dispatch') {
    await rail('Settings')
    await page.locator('#settings-tab-themes').click(); await wait(200)
    await page.locator(`.themeCard input[value="${look}"]`).check({ force: true }); await wait(700)
    await page.locator('.reqTabX').last().click().catch(() => {}); await wait(300)
  }

  // An environment with the values the demo requests use, so single sends pass their tests.
  await rail('Environments')
  await page.locator('.btn.small', { hasText: /^\+ New$/ }).click(); await wait(400)
  await page.locator('dialog[open] input').first().fill('Demo shop (local)')
  await page.locator('dialog[open] .btn.primary', { hasText: 'OK' }).click(); await wait(600)
  const vars = [['user', 'ann'], ['item', 'espresso'], ['qty', '2']]
  for (let i = 0; i < vars.length; i++) {
    await page.locator(`input[aria-label="Environment variables Variable ${i + 1}"]`).fill(vars[i][0])
    await page.locator(`input[aria-label="Environment variables Value ${i + 1}"]`).fill(vars[i][1]); await wait(150)
  }
  await page.locator('.btn.primary', { hasText: 'Use this environment' }).click(); await wait(500)
  await rail('Collections')
  for (const t of await page.locator('.reqTabX').all()) await t.click().catch(() => {})
  await wait(300)

  await row('1 Login').click(); await wait(400); await send()
  if (want('scripts')) {
    await page.locator('button', { hasText: /^Scripts/ }).first().click(); await wait(200)
    await page.locator('button', { hasText: 'After response (tests)' }).click(); await shot('scripts')
    await page.locator('button', { hasText: /^Params/ }).first().click()
  }
  await row('2 Create order').click(); await wait(400)
  await page.locator('button', { hasText: /^Body/ }).first().click(); await wait(200)
  await send(); await dismissToasts()
  if (want('request')) await shot('request')

  if (want('docs')) {
    await page.locator('summary[aria-label="More for Demo shop"]').click(); await wait(200)
    await page.locator('button', { hasText: 'View docs' }).click(); await wait(900); await shot('docs')
  }
  if (want('runner')) {
    await rail('Runner')
    await page.locator('input[aria-label="Data file"]').setInputFiles(join(REPO, 'examples/users.csv')); await wait(400)
    await page.locator('.btn.primary', { hasText: /Run \d+/ }).click(); await wait(6000)
    await toResults(); await shot('runner')
  }
  if (want('load')) {
    // /flaky fails about 1 in 20 at random, so the error limit is 10% for a result that passes.
    await rail('Collections'); await row('5 Flaky').click(); await wait(400)
    await rail('Load test')
    await page.locator('label', { hasText: 'Duration' }).locator('input').fill('12')
    await page.locator('label', { hasText: 'Errors under' }).locator('input').fill('10')
    await page.locator('label', { hasText: 'I own this server' }).locator('input').check({ force: true })
    await page.locator('.btn.primary', { hasText: 'Start load test' }).click(); await wait(16000)
    await toResults(); await shot('load')
  }
  if (errors.length) console.error('page errors:', errors)
  await ctx.close()
}
