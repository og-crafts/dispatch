/**
 * What the chat may write where a value becomes a known secret (allSecrets): only a reference. A known value is hidden
 * wherever it is, so one the model made up would show, by what it hides, whether a guess at a hidden value is right.
 * Decided by the place alone; a value here never depends on what is hidden.
 */
import { hideInText } from '../mcpWorkspace'
import { API_KEY_HEADER } from '../parameterize'
import { SECRET_NAME } from '../share'
import type { KV, RequestDef } from '../types'
import { paramsFromUrl } from '../url'
import type { Cleaner } from './propose'

// No `=` or `;` in the name: a cookie header is taken apart at them.
const REF = /^\s*\{\{\s*[^{}\s=;,&"']+\s*\}\}\s*$/
const SCHEME = /^\s*(?:Bearer|Basic|Digest|Token)\s+(?=\{\{)/i
/** Ordinary names match too (max_tokens); a variable of the same name would be left empty. */
export const PLAIN = 'If it is a plain value, use a {{variable}} with another name for it.'
export const secretName = (k: string) => SECRET_NAME.test(k) || SECRET_NAME.test(k.trim())
/** Empty, or one variable and nothing else. */
export const isRef = (v: string) => !v.trim() || REF.test(v)

/** Why a create_request or update_request call can't write these headers or this URL, or null. `was`: the request now. */
export function literalIn(input: Record<string, unknown>, was: RequestDef | undefined, cl: Cleaner): string | null {
  for (const [i, [k, v]] of Object.entries((input.headers as Record<string, string> | undefined) ?? {}).entries()) {
    // a key header can be moved to a secret variable
    if ((!secretName(k) && !API_KEY_HEADER.test(k.trim())) || isRef(v) || REF.test(v.replace(SCHEME, ''))) continue
    // given back as it can be read
    if (was?.headers.some((h) => h.key === k && h.value === v && JSON.stringify(cl.deep(h)) === JSON.stringify(h))) continue
    return `Header ${i + 1} has a name that is treated as a secret’s, so it can’t be given a value here, only a {{variable}} (also after Bearer, Basic, Digest or Token). ${PLAIN}`
  }
  if (input.url === undefined || input.url === null) return null
  const url = String(input.url).trim()
  const p = paramsFromUrl(url, []).findIndex((x) => secretName(x.key) && !isRef(x.value))
  if (p >= 0) return `Query parameter ${p + 1} has a name that is treated as a secret’s, so it can’t be given a value here, only a {{variable}}. ${PLAIN}`
  return hideInText(url) !== url ? 'That URL holds what looks like a secret, such as a password. Use a {{variable}} for it.' : null
}

/**
 * set_variables: the call with new variables that have a secret's name left empty (a reference may stay), and which those
 * are. One that is there already is the person's to fill in.
 */
export function withoutLiterals(input: Record<string, unknown>, vars: KV[], lower: KV[]): { input: Record<string, unknown>; empty: string[] } | { refused: string } {
  const empty: string[] = []
  const variables: Record<string, string> = {}
  for (const [k, v] of Object.entries((input.variables as Record<string, string> | undefined) ?? {})) {
    const at = (x: KV) => x.key.trim() === k.trim()
    if (!secretName(k) || REF.test(v)) { variables[k] = v; continue }
    if (vars.some(at)) return { refused: `“${k}” has a secret’s name and is there already, so only the person can fill it in.` }
    if (lower.some(at)) return { refused: `There is a “${k}” in the globals already, and an empty one here would hide it. Ask the person to add it.` }
    variables[k] = ''
    empty.push(k)
  }
  return { input: input.variables === undefined ? input : { ...input, variables }, empty }
}
