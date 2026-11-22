// Copies fonts, the logo and the voice lines into public/ (gitignored). The screenshots come from
// `node ../scripts/screenshots.mjs promo` (see README.md), which writes public/shots/.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(here, '..')
const pub = join(here, 'public')
for (const d of ['fonts', 'voice', 'shots']) mkdirSync(join(pub, d), { recursive: true })
cpSync(join(repo, 'node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2'), join(pub, 'fonts/manrope.woff2'))
cpSync(join(repo, 'site/src/assets/fonts/geist-mono-400.ttf'), join(pub, 'fonts/geist-mono-400.ttf'))
cpSync(join(repo, 'site/src/assets/icons/icon.svg'), join(pub, 'icon.svg'))
cpSync(join(here, 'assets/voice'), join(pub, 'voice'), { recursive: true })
console.log('fonts, icon and voice copied to public/')
