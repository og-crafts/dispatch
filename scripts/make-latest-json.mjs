#!/usr/bin/env node
// Builds latest.json for Tauri's updater from a tag's signed installers.
//
//   node scripts/make-latest-json.mjs <folder with the build artifacts> <tag, e.g. v0.5.2> > latest.json
//
// The folder holds what the desktop jobs uploaded (any depth): the Windows NSIS setup .exe, the Linux AppImages and
// the macOS Dispatch.app.tar.gz, each with its .sig from the update key. Installed apps read this file from
// https://github.com/og-crafts/dispatch/releases/latest/download/latest.json, so they only see a release once the
// owner publishes it.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const [dir, tag] = process.argv.slice(2)
if (!dir || !/^v\d+\.\d+\.\d+/.test(tag ?? '')) {
  console.error('Usage: make-latest-json.mjs <artifacts folder> <vX.Y.Z>')
  process.exit(2)
}
const repo = process.env.GITHUB_REPOSITORY || 'og-crafts/dispatch'

const files = []
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p) } }
walk(dir)

/** The installer for a platform, with its signature; null when that build is missing. */
function entry(test) {
  const file = files.find((f) => test(basename(f)) && !f.endsWith('.sig'))
  if (!file) return null
  const sig = files.find((f) => f === `${file}.sig`)
  if (!sig) throw new Error(`${basename(file)} has no .sig: was the update key set for this build?`)
  return { signature: readFileSync(sig, 'utf8').trim(), url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(basename(file))}` }
}

const mac = entry((n) => n.endsWith('.app.tar.gz')) // one universal build for both Mac kinds
const platforms = Object.fromEntries(Object.entries({
  'windows-x86_64': entry((n) => /x64-setup\.exe$/.test(n)),
  'linux-x86_64': entry((n) => /amd64\.AppImage$/.test(n)),
  'linux-aarch64': entry((n) => /aarch64\.AppImage$/.test(n)),
  'darwin-aarch64': mac,
  'darwin-x86_64': mac,
}).filter(([, v]) => v))

if (!Object.keys(platforms).length) { console.error('No signed installers found.'); process.exit(1) }

process.stdout.write(JSON.stringify({
  version: tag.replace(/^v/, ''),
  notes: `What’s new: https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
}, null, 2) + '\n')
console.error(`latest.json: ${Object.keys(platforms).join(', ')}`)
