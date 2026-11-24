/** Working out the script line that takes a selected response value. */
import { describe, expect, it } from 'vitest'
import { bodySource, extractedTargets, headerSource, jsonSource, ruleLine, textSource, withRule, withoutRule, type Source } from '../src/core/extract'
import { compileWithFunction, runScript } from '../src/core/scripts'
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
    ['a key with a space', '{"user name":[{"id":"u1"}]}', 'u1', "dx.response.json()['user name']?.[0]?.['id']", 'u1', 'id'],
    ['a key with a dot', '{"a.b":"v"}', 'v', "dx.response.json()['a.b']", 'v', 'aB'],
    ['a key of digits', '{"x":{"0":"v"}}', 'v', "dx.response.json()['x']?.['0']", 'v', 'x'],
    ['a key with quotes', `{"it's \\"q\\"":"v"}`, '"v"', `dx.response.json()['it\\'s "q"']`, 'v', 'itSQ'],
    ['a key with a backslash', '{"a\\\\b":"v"}', '"v"', "dx.response.json()['a\\\\b']", 'v', 'aB'],
    ['an escaped key', '{"\\u00e9":"v"}', '"v"', "dx.response.json()['é']", 'v', 'value'],
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
  const LINE = "{ const v = dx.response.json('data.token'); if (v != null) dx.env.set('token', v) } // extracted"
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
