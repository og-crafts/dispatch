import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

// Bundled fonts are under the SIL Open Font License, which asks that the copyright and licence travel with them.
const notices = readFileSync('public/THIRD-PARTY-NOTICES.txt', 'utf8')

describe('third-party notices', () => {
  it('ship with the app and carry the licence text', () => {
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(notices).toContain('PERMISSION & CONDITIONS')
  })
  it('name every bundled font with its copyright line', () => {
    const manrope = readFileSync('node_modules/@fontsource-variable/manrope/LICENSE', 'utf8').split('\n')[0]
    expect(readFileSync('src/main.tsx', 'utf8')).toContain('@fontsource-variable/manrope')
    expect(notices).toContain(manrope)
    for (const f of ['OFL-Nunito.txt', 'OFL-GeistMono.txt']) {
      expect(existsSync(`site/src/assets/fonts/${f}`)).toBe(true)
      expect(notices).toContain(readFileSync(`site/src/assets/fonts/${f}`, 'utf8').split('\n')[0])
    }
  })
  it('covers every font face the site loads', () => {
    const faces = [...readFileSync('site/src/site.css', 'utf8').matchAll(/@font-face \{ font-family: "?([^;"]+)"?;/g)].map((m) => m[1])
    expect(faces.length).toBeGreaterThan(0)
    for (const name of new Set(faces)) expect(notices).toContain(name)
  })
})
