// Writes the captions for the site's video (WebVTT) from src/timing.ts and scripts/voice-lines.json.
// Run after changing either: node scripts/make-captions.mjs [out=../site/src/assets/video/dispatch-promo.vtt]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] ?? join(here, '..', 'site/src/assets/video/dispatch-promo.vtt')
const timing = readFileSync(join(here, 'src/timing.ts'), 'utf8')
const num = (name) => Number(timing.match(new RegExp(`export const ${name} = (\\d+)`))[1])
const FPS = num('FPS'), TRANSITION = num('TRANSITION'), VOICE_AT = num('VOICE_AT')
const LINES = Object.fromEntries([...timing.match(/LINES = \{([^}]+)\}/)[1].matchAll(/(\w+): ([\d.]+)/g)].map((m) => [m[1], Number(m[2])]))
const SCENES = [...timing.matchAll(/\{ id: '(\w+)', frames: (\d+) \}/g)].map((m) => ({ id: m[1], frames: Number(m[2]) }))
const text = Object.fromEntries(JSON.parse(readFileSync(join(here, 'scripts/voice-lines.json'), 'utf8')))

const ts = (s) => {
  const ms = Math.round(s * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`
}
let at = 0
const cues = SCENES.map(({ id, frames }) => {
  const start = (at + VOICE_AT) / FPS
  at += frames - TRANSITION
  return `${ts(start)} --> ${ts(start + LINES[id] + 0.3)}\n${text[id]}`
})
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, 'WEBVTT\n\n' + cues.join('\n\n') + '\n')
console.log(`${cues.length} cues -> ${out}`)
