/** Working out the script line that takes a selected response value. */
import { describe, expect, it } from 'vitest'
import { bodySource, extractedTargets, headerSource, jsonSource, rowFor, ruleLine, setVar, textSource, withRule, withoutRule, type Source } from '../src/core/extract'
import { compileWithFunction, runScript } from '../src/core/scripts'
import { mergeVars } from '../src/core/scriptPipeline'
import { isSecretName } from '../src/core/share'

/** Runs a rule against a body, the way a send would. */
async function runRule(expr: string, body: string, env: Record<string, string> = {}, headers: [string, string][] = []) {
  const o = await runScript({
    phase: 'post', source: 't', code: ruleLine('env', 'out', expr), request: { name: 'r', url: 'https://a.test', method: 'GET', headers: [], body: { mode: 'none', raw: '' } },
    response: { code: 200, status: 'OK', headers, body, responseTime: 1, responseSize: 1 },
    vars: { globals: {}, collection: {}, environment: env, data: {}, locals: {} }, info: { requestName: 'r', requestId: 'i', iteration: 0, iterationCount: 1 },
  }, { sendRequest: async () => { throw new Error('no') } }, compileWithFunction)
  expect(o.error ?? null).toBeNull()
  return o.vars.environment.out
}
/** A source for the first occurrence of `pick` in `text`. */
const at = (fn: (t: string, a: number, b: number) => Source, text: string, pick: string, nth = 0) => {
  let i = text.indexOf(pick); for (let n = 0; n < nth; n++) i = text.indexOf(pick, i + 1)
  return fn(text, i, i + pick.length)
}
const ok = (s: Source) => { if (!s.ok) throw new Error(s.reason); return s }

describe('from JSON', () => {
  it.each([
    ['part of a string', '{"data":{"token":"abc"}}', 'b', "dx.response.json('data.token')", 'abc', 'token'],
    ['a key', '{"data":{"token":"abc"}}', 'token', "dx.response.json('data.token')", 'abc', 'token'],
    ['a whole member with its comma', '{"token": "abc", "x":1}', '"token": "abc",', "dx.response.json('token')", 'abc', 'token'],
    ['a number in an array', '{"items":[{"id":7}]}', '7', "dx.response.json('items[0].id')", '7', 'id'],
    ['a root array', '["first"]', 'first', "dx.response.json('[0]')", 'first', 'value'],
    ['a list item', '{"ids":[1,22]}', '22', "dx.response.json('ids[1]')", '22', 'ids'],
    ['a boolean', '{"on":true}', 'true', "dx.response.json('on')", 'true', 'on'],
    ['a key with a space', '{"user name":[{"id":"u1"}]}', 'u1', "dx.response.json()?.['user name']?.[0]?.['id']", 'u1', 'id'],
    ['a key with a dot', '{"a.b":"v"}', 'v', "dx.response.json()?.['a.b']", 'v', 'aB'],
    ['a key of digits', '{"x":{"0":"v"}}', 'v', "dx.response.json()?.['x']?.['0']", 'v', 'x'],
    ['a key with quotes', `{"it's \\"q\\"":"v"}`, '"v"', `dx.response.json()?.['it\\'s "q"']`, 'v', 'itSQ'],
    ['a key with a backslash', '{"a\\\\b":"v"}', '"v"', "dx.response.json()?.['a\\\\b']", 'v', 'aB'],
    ['an escaped key', '{"\\u00e9":"v"}', '"v"', "dx.response.json()?.['é']", 'v', 'value'],
    ['an escaped string', '{"t":"a\\"b\\u0041\\n"}', 'u0041', "dx.response.json('t')", 'a"bA\n', 't'],
    ['an object selected whole', '{"o":{"a":1}}', '{"a":1}', "dx.response.json('o')", '{\n  "a": 1\n}', 'o'],
    ['the last of duplicate keys', '{"a":"1st","a":"2nd"}', '1st', "dx.response.json('a')", '2nd', 'a'],
    ['a null-safe path', '{"a":[[{"b":"deep"}]]}', 'deep', "dx.response.json('a[0][0].b')", 'deep', 'b'],
  ])('%s', async (_n, body, pick, expr, value, name) => {
    const s = ok(at(jsonSource, body, pick))
    expect([s.expr, s.value, s.name]).toEqual([expr, value, name])
    expect(await runRule(s.expr, body)).toBe(value)
  })
  it.each([
    ['two values', '{"a":1,"b":2}', '1,"b":2'], ['only spaces', '{"a":   1}', '  '], ['a comma', '[1,2]', ','],
  ])('refuses %s', (_n, body, pick) => { expect(at(jsonSource, body, pick)).toEqual({ ok: false, reason: 'Select one value.' }) })
  it('refuses null and an empty text', () => {
    for (const [b, p] of [['{"a":null}', 'null'], ['{"a":""}', '""']]) expect(at(jsonSource, b, p)).toEqual({ ok: false, reason: 'This value is empty.' })
  })
  it('is picked by content; other text uses the text rule', () => {
    expect(ok(at(bodySource, '{"a":"b"}', 'b"')).expr).toContain('json')
    expect(ok(at(bodySource, '<a>b</a>', 'b')).expr).toContain('.match(')
  })
  it('handles deep nesting without running out of stack', () => {
    const body = `${'['.repeat(3000)}"x"${']'.repeat(3000)}`
    expect(ok(at(jsonSource, body, 'x')).value).toBe('x')
  })
})

describe('from headers', () => {
  it('reads by name', async () => {
    const s = ok(headerSource('X-Request-Id', 'r1'))
    expect([s.expr, s.name]).toEqual(["dx.response.headers.get('X-Request-Id')", 'xRequestId'])
    expect(await runRule(s.expr, '', {}, [['X-Request-Id', 'r1']])).toBe('r1')
  })
})

describe('from other text', () => {
  it.each([
    ['XML', '<r><token>abc</token></r>', 'abc', 'token'], ['a form reply', 'ok=1&session=xyz-9&n=2', 'xyz-9', 'session'],
    ['an HTML attribute', '<input name="csrf" value="a/b+c=">', 'a/b+c=', 'value'],
    ['regex characters around it', 'cost (USD) [$]: 12.50* /per\\month', '12.50', 'value'],
    ['several words', 'Hello <b>big wide world</b> bye', 'big wide world', 'b'],
    ['all of it', 'justatoken', 'justatoken', 'value'],
    ['the end', 'token: zzz', 'zzz', 'token'], ['two lines', 'a:\none\ntwo\nend', 'one\ntwo', 'a'],
  ])('%s', async (_n, body, pick, name) => {
    const s = ok(at(textSource, body, pick))
    expect([s.value, s.unique, s.name]).toEqual([pick, true, name])
    expect(await runRule(s.expr, body)).toBe(pick)
  })
  it('works on a CRLF body from the LF text on screen', async () => {
    const lf = 'id: 1\ntoken: abc\nend'
    expect(await runRule(ok(at(textSource, lf, 'abc')).expr, lf.replace(/\n/g, '\r\n'))).toBe('abc')
  })
  it('says when the text around it repeats', () => { expect(ok(at(textSource, '<i>a</i><i>b</i>'.repeat(5), 'b', 2)).unique).toBe(false) })
  it('refuses nothing but spaces', () => { expect(textSource('a  b', 1, 3).ok).toBe(false) })
})

describe('the rule in the script', () => {
  const E = "dx.response.json('data.token')"
  const LINE = "{ const v = dx.response.json('data.token'); if (v != null && v !== '') dx.env.set('token', v) } // extracted"
  it('is one marked line', () => {
    expect(ruleLine('env', 'token', E)).toBe(LINE)
    expect(ruleLine('globals', "it's", 'x')).toContain("dx.globals.set('it\\'s', v)")
  })
  it('keeps the old value when the response has none', async () => {
    expect(await runRule(E, '{"error":"no"}', { out: 'old' })).toBe('old')
    expect(await runRule(ok(at(textSource, '<t>abc</t>', 'abc')).expr, '<e/>', { out: 'old' })).toBe('old')
  })
  it('is appended on a line of its own', () => {
    expect(withRule('', 'env', 'token', E)).toBe(LINE)
    expect(withRule('a() // note', 'env', 'token', E)).toBe(`a() // note\n${LINE}`)
    expect(withRule('a()\n', 'env', 'token', E)).toBe(`a()\n${LINE}`)
  })
  it('replaces its own marked line only', () => {
    const mine = "dx.env.set('token', 'mine')"
    const script = `${mine}\n${LINE}\nafter()`
    expect(withRule(script, 'env', 'token', 'NEW')).toBe(`${mine}\n${ruleLine('env', 'token', 'NEW')}\nafter()`)
    expect(withRule(script, 'collection', 'token', 'NEW').split('\n')).toHaveLength(4)
    expect(withRule(script, 'env', 'token2', 'NEW').split('\n')).toHaveLength(4)
  })
  it('handles $ patterns in the expression', () => { expect(withRule(LINE, 'env', 'token', "'$&$1'")).toBe(ruleLine('env', 'token', "'$&$1'")) })
  it('can be taken out again, putting back the line it replaced', () => {
    const other = withRule('a()', 'env', 'token', E)
    expect(withoutRule(`${other}\nlater()`, 'env', 'token', E, null)).toBe('a()\nlater()')
    expect(withoutRule(other, 'env', 'token', E, 'OLD LINE')).toBe('a()\nOLD LINE')
    expect(withoutRule('edited()', 'env', 'token', E, null)).toBe('edited()')
  })
  it('lists what it sets', () => {
    expect(extractedTargets(`dx.env.set('a', 1)\n${LINE}\ndx.globals.set('b', 2) // extracted\n  ${ruleLine('collection', "it's", E)}`))
      .toEqual([{ scope: 'env', name: 'token' }, { scope: 'globals', name: 'b' }, { scope: 'collection', name: "it's" }])
  })
})

it('knows secret-looking names', () => { expect([isSecretName('api_token'), isSecretName('host')]).toEqual([true, false]) })

describe('a pretty-printed view of XML', () => {
  it('gives a rule that works on the body as it came', async () => {
    const raw = '<r><id>1</id><token>abc</token></r>', shown = '<r>\n  <id>1</id>\n  <token>abc</token>\n</r>'
    const i = shown.indexOf('abc')
    const s = ok(textSource(shown, i, i + 3, raw))
    expect(s.unique).toBe(true)
    expect(await runRule(s.expr, raw)).toBe('abc')
  })
})

describe('setting the variable now', () => {
  const row = { id: '1', key: 'token', value: 'old', enabled: true, secret: true }
  it('replaces the value and flag, and can be undone', () => {
    const r = setVar([row], 'token', 'new', false)
    expect(r.rows).toEqual([{ ...row, value: 'new', secret: false }])
    expect(r.undo([...r.rows, { id: '2', key: 'other', value: '', enabled: true }])).toEqual([row, { id: '2', key: 'other', value: '', enabled: true }])
  })
  it('adds a row, and undo takes only that out', () => {
    const r = setVar([], 'token', 'new', true)
    expect(r.rows).toMatchObject([{ key: 'token', value: 'new', secret: true, enabled: true }])
    expect(r.undo(r.rows)).toEqual([])
  })
  it('turns on a row that was off, and keeps the active option in step', () => {
    const o = { ...row, enabled: false, active: 'b', options: [{ id: 'a', name: 'a', value: '1' }, { id: 'b', name: 'b', value: 'old' }] }
    const r = setVar([o], 'token', 'new', true)
    expect(r.rows[0]).toMatchObject({ enabled: true, options: [{ value: '1' }, { value: 'new' }] })
    expect(r.undo(r.rows)).toEqual([o])
  })
  it('sets the row requests use when there are several', () => {
    const r = setVar([row, { ...row, id: '2' }, { ...row, id: '3', enabled: false }], 'token', 'new', true)
    expect(r.rows.map((x) => x.value)).toEqual(['old', 'new', 'old'])
  })
})

describe('text rules hold for the next reply', () => {
  it.each([
    ['a form reply', 'access_token=AAA111&expires=1712345678', 'AAA111', 'access_token=BBB222&expires=99'],
    ['what comes before', 'expires=1712345678&access_token=AAA', 'AAA', 'expires=5&access_token=BBB222'],
    ['another token after it', 'access_token=AAA&refresh_token=xyz12', 'AAA', 'access_token=BBB222&refresh_token=q'],
    ['XML beside another value', '<r><a>AAA</a><b>SECRET99</b></r>', 'AAA', '<r><a>BBB222</a><b>zz</b></r>'],
    ['a tag with attributes', '<t exp="17">AAA</t>', 'AAA', '<t exp="99">BBB222</t>'],
    ['several words and a blank end', 'Your code: abc def\n', 'abc def', 'Your code: BBB222\n'],
    ['several words and a CRLF end', 'Your code: abc def\r\n', 'abc def', 'Your code: BBB222\r\n'],
    ['a list that grew', 'id: 1\ntoken: AAA', 'AAA', 'id: 2\ntoken: BBB222\nmore: 1'],
  ])('%s', async (_n, body, pick, next) => {
    const s = ok(at(textSource, body, pick))
    expect(s.unique).toBe(true); expect(s.expr).not.toMatch(/SECRET99|17123|xyz12/)
    expect(await runRule(s.expr, body)).toBe(pick)
    expect(await runRule(s.expr, next)).toBe('BBB222')
  })
  it('part of a word takes the whole word, so the rest isn’t written into the script', () => {
    const s = ok(at(textSource, 'key = abc123def456 end', 'c123'))
    expect(s.value).toBe('abc123def456'); expect(s.expr).not.toContain('abc')
  })
  it('keeps token-like text near the value out of the script', () => {
    expect(ok(at(textSource, 'see eyJhbGciOiJIUzI1NiJ9.abc for it', 'abc')).expr).not.toContain('HUzI1')
  })
  it('works from a deep pretty-printed view of one-line XML', async () => {
    const raw = `${'<d>'.repeat(7)}<token>abc</token>${'</d>'.repeat(7)}`
    const shown = `${' '.repeat(40)}\n${' '.repeat(40)}<token>abc</token>\n`
    const i = shown.indexOf('abc'); const s = ok(textSource(shown, i, i + 3, raw))
    expect(s.unique).toBe(true); expect(await runRule(s.expr, raw)).toBe('abc')
  })
  it('refuses what isn’t in the body as it came', () => {
    expect(textSource('x: zed', 3, 6, 'nothing here')).toEqual({ ok: false, reason: 'This isn’t in the response as it came. Turn on Raw and select it there.' })
  })
  it('stays quick on big bodies', () => {
    const t0 = performance.now()
    for (const b of ['a1'.repeat(100_000), 'a '.repeat(100_000), '<i>a b</i>'.repeat(20_000)]) { textSource(b, b.length - 4, b.length); textSource(`${b} x`, b.length + 1, b.length + 2) }
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})

it('an empty value keeps the old one', async () => { expect(await runRule("dx.response.json('token')", '{"token":""}', { out: 'old' })).toBe('old') })
it('a reply of null keeps the old one', async () => {
  const s = ok(at(jsonSource, '{"a b":"v"}', '"v"'))
  expect(await runRule(s.expr, 'null', { out: 'old' })).toBe('old')
})
it('a later header of the same name is refused, since only the first can be read', () => {
  const all: [string, string][] = [['Set-Cookie', 'a=1'], ['set-cookie', 'b=2']]
  expect(headerSource('Set-Cookie', 'a=1', all.slice(0, 0)).ok).toBe(true)
  expect(headerSource('set-cookie', 'b=2', all.slice(0, 1))).toEqual({ ok: false, reason: 'The response has several “set-cookie” headers, and only the first can be taken.' })
})
it('the row that is shown is the row that is set', () => {
  const rows = [{ id: '1', key: 'token', value: 'a', enabled: true, secret: true }, { id: '2', key: 'token', value: 'b', enabled: false }]
  expect(rowFor(rows, 'token')!.id).toBe('1'); expect(rowFor(rows, 'x')).toBeUndefined()
})
describe('keeping a run’s variable changes', () => {
  const r = (id: string, key: string, value: string) => ({ id, key, value, enabled: true })
  it('touches only what the run changed', () => {
    const before = [r('1', 'a', '1'), r('2', 'b', '1'), r('3', 'c', '1')]
    const after = [r('1', 'a', 'run'), r('2', 'b', '1'), r('9', 'new', 'n')]
    const now = [r('1', 'a', '1'), { ...r('2', 'b', 'edited'), secret: true }, r('3', 'c', '1'), r('4', 'mine', 'm')]
    expect(mergeVars(before, after, now).map((x) => [x.key, x.value])).toEqual([['a', 'run'], ['b', 'edited'], ['mine', 'm'], ['new', 'n']])
  })
  it('gives one row when both added the same name', () => {
    expect(mergeVars([], [r('9', 't', 'run')], [r('4', 't', 'mine')])).toEqual([r('4', 't', 'run')])
  })
})
