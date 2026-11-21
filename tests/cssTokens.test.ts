/** Every dark colour set is written twice in app.css: once for the system's dark mode and once for Settings → Dark.
 *  CSS can't share one block between a media query and an attribute selector, so this keeps the two copies equal. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/ui/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const decls = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))

// "@media (prefers-color-scheme: dark) { <sel>:not([data-theme="light"]) { … } }"
const pairs = [...css.matchAll(/@media \(prefers-color-scheme: dark\)\s*\{\s*([^{]+?):not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/g)]
  .map((m) => ({ selector: m[1].trim(), system: decls(m[2]), after: m.index! + m[0].length }))

describe('dark colour sets', () => {
  it('finds every pair', () => { expect(pairs.length).toBeGreaterThanOrEqual(4) })

  for (const { selector, system, after } of pairs) {
    it(`${selector} (${Object.keys(system).length} colours): system dark and Settings → Dark match`, () => {
      const at = css.indexOf(`${selector}[data-theme="dark"] {`, after) // the copy follows its media block
      expect(at, `no ${selector}[data-theme="dark"] block`).toBeGreaterThan(-1)
      expect(decls(css.slice(at, css.indexOf('}', at)))).toEqual(system)
    })
  }
})
