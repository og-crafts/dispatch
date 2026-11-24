/** hideInText (unchanged output, linear time) and Redactor.clean (at least as hidden as text() and known()). */
import { describe, expect, it } from 'vitest'
import { Redactor } from '../src/core/mcpLogs'
import { HIDDEN, hideInText } from '../src/core/mcpWorkspace'
import { SECRET_NAME } from '../src/core/share'

/** hideInText as it was: what outside assistants get must stay exactly this. */
const IS_VAR = /^\s*\{\{[^{}]+\}\}\s*$/
const old = (s: string) => s
  .replace(/(\/\/[^/\s:@{}]+:)(?!\{\{)([^@/\s]+)@/g, (_m, pre: string) => `${pre}${HIDDEN}@`)
  .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, HIDDEN)
  .replace(/\b((?:Bearer|Basic|Digest|Token)\s+)(?!\{\{)[A-Za-z0-9._~+/=-]{8,}/g, (_m, pre: string) => `${pre}${HIDDEN}`)
  .replace(/("([^"\\]+)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (m, pre: string, k: string, v: string) => (v && !IS_VAR.test(v) && SECRET_NAME.test(k) ? `${pre}"${HIDDEN}"` : m))
  .replace(/([?&;\s]|^)([\w.-]+)=([^&;?\s"'<>,]+)/g, (m, pre: string, k: string, v: string) => (!IS_VAR.test(v) && SECRET_NAME.test(k) ? `${pre}${k}=${HIDDEN}` : m))

/** A repeatable random source (mulberry32). */
function rng(seed: number) {
  const next = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return { int: (n: number) => Math.floor(next() * n), pick: <T>(a: readonly T[]): T => a[Math.floor(next() * a.length)] }
}
const BITS = ['eyJ', 'eyJaaaaa', '.', '-', '_', 'a', 'bbbbb', 'é', ' ', '\n', '"', '\\', ':', '"password"', '"user"', '=', 'password=', 'token', '&', '?', ';', ',', '//', '/', '@', 'u:p', 'Bearer ', 'Basic\t', 'Token', '{{', '}}', '{{v}}', '<', '<hidden>', 'abcdefgh', "'", '😀', '\ud83d']

describe('hideInText', () => {
  it('gives exactly what it gave', () => {
    const r = rng(1)
    for (let i = 0; i < 30_000; i++) {
      const s = Array.from({ length: 1 + r.int(14) }, () => r.pick(BITS)).join('')
      expect(hideInText(s)).toBe(old(s))
    }
    const J = ['eyJ', 'eyJaaaaa', '.', '.', '-', 'bbbbb', 'b', 'é', ' ']
    for (let i = 0; i < 30_000; i++) {
      const s = Array.from({ length: 1 + r.int(12) }, () => r.pick(J)).join('')
      expect(hideInText(s)).toBe(old(s))
    }
  })
  const MB = 1_000_000
  it.each(['-eyJaaaaa', 'eyJaaaaa.', 'eyJaaaaa.aaaaa.', 'eyJ', '.eyJ', '//', '//a:', '//a:b', '//a:b ', ':', '//a', 'Bearer ', 'Bearer', ' ', 'Token\t', 'Basic aaaaaaa!', '"', '"a"', '"a":', '"a":"', '"a" : ', '"a":"\\"', '\\"', '"password":"\\', '\\\n', 'a', 'a=', '&a', '&a=', '?password=', 'token', '{{', '&{{', '"a', 'a.', '-'])('stays quick on 1 MB of %j', (unit) => {
    const body = unit.repeat(Math.ceil(MB / unit.length))
    for (const s of [body, `//u:${body}`, `"password":"${body}`, `"password":"${body}"`, `Bearer ${body}`, `Bearer${' '.repeat(10)}${body}`, `password=${body}`, `"a"${body}`]) {
      const at = performance.now()
      hideInText(s)
      expect(performance.now() - at).toBeLessThan(1_500)
    }
  }, 60_000)
})

describe('Redactor.clean', () => {
  const jwt = 'eyJhbGciOi.payloadPART1.signaturePART2'
  it.each<[string, string[], string, string[]]>([
    ['a scheme word', ['Bearer'], 'log Bearer opaqueTOKEN12345', ['opaqueTOKEN', 'TOKEN12345']],
    ['a field name', ['password'], '{"password":"hunter22x"}', ['hunter22x']],
    ['a pair name', ['password'], 'password=zzz1234', ['zzz1234']],
    ['a JWT segment', ['eyJhbGciOi'], `x ${jwt}`, ['payloadPART1', 'signaturePART2']],
    ['a URL user', ['longuser'], 'https://longuser:pw99@h.test', ['pw99']],
    ['a value with commas', ['ab,cd;efgh&ij'], 'password=ab,cd;efgh&ij x', ['cd', 'efgh', 'ij']],
    ['overlapping values', ['abcdefgh', 'ghijklmn'], 'abcdefghijklmn', ['ijklmn', 'abc']],
    ['quotes inside a URL password', ['zzzzzz'], '//u:"x","password":"qq@ "password":"inner7"', ['inner7']],
  ])('hides around %s', (_n, values, s, gone) => {
    const out = new Redactor(values).clean(s)
    for (const g of gone) expect(out).not.toContain(g)
  })
  it('leaves other text alone', () => {
    expect(new Redactor(['secret-1']).clean('GET {{base}}/items?x=1 "user":"me" Bearer {{t}}')).toBe('GET {{base}}/items?x=1 "user":"me" Bearer {{t}}')
  })
  it('hides everything text() or known() hides, with any known values', () => {
    const r = rng(7)
    let checked = 0
    for (let i = 0; i < 6_000; i++) {
      let n = 0
      const word = () => `w${(n++).toString(36).padStart(2, '0')}${r.int(1e6).toString(36)}q`
      const plain = () => r.pick([word, () => `${word()},${word()}`, () => `${word()}-${word()}`])()
      const part = () => r.pick([
        () => `Bearer ${word()}${word()}`, () => `Token  ${word()}${word()}`, () => `"password":"${plain()}"`, () => `"note" : "${plain()}"`, () => `password=${plain()}`, () => `&api_key=${plain()};`, () => `?q=${word()}`,
        () => `https://${word()}:${word()}@${word()}`, () => `eyJ${word()}${word()}.${word()}${word()}.${word()}${word()}`, plain, () => `"${word()}`, () => '//u:', () => '@', () => '"', () => '{{x}}', () => HIDDEN,
      ])()
      const s = Array.from({ length: 1 + r.int(8) }, part).join(r.pick([' ', '', '\n']))
      const values = Array.from({ length: r.int(5) }, () => r.pick([() => r.pick(['Bearer', 'password', 'Bearer ', '"password"', 'password=', 'api_key', 'https://', 'hidden', 'ken  w', ',w', '":"', 'eyJw00']), () => { const a = r.int(s.length); return s.slice(a, a + 6 + r.int(12)) }])())
      const R = new Redactor(values)
      const out = R.clean(s), text = R.text(s), known = R.known(s)
      for (const w of s.match(/w[0-9a-z]{2}[0-9a-z]*q/g) ?? []) for (let k = 0; k + 4 <= w.length; k++) {
        const bit = w.slice(k, k + 4)
        if (s.split(bit).length !== 2) continue // only bits that are there once
        if (!text.includes(bit) || !known.includes(bit)) { checked++; if (out.includes(bit)) throw new Error(JSON.stringify({ s, values, bit, out, text, known })) }
      }
    }
    expect(checked).toBeGreaterThan(5_000)
  })
})
