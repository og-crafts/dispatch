# Scripts

Every request, folder and collection can have two scripts: **Before request** runs just before it is sent, **After
response (tests)** runs when the response arrives. Collection scripts run first, then folder scripts, then the request's
own. Scripts are plain JavaScript (`await` works at the top level) and run in a sandbox with no access to your saved
data; `console.log` output shows in the Console.

```js
// After response
test('creates the order', () => {
  expect(dx.response.status).to.equal(201)
  expect(dx.response.json('item')).to.equal(dx.vars.get('item'))
})
dx.collection.set('orderId', dx.response.json('id'))
```

## What a script can use

| | |
|---|---|
| `test(name, fn)` | A named check. It passes unless `fn` throws (or its promise rejects). Also `dx.test`. |
| `expect(value)` | [Chai](https://www.chaijs.com/api/bdd/) assertions: `.to.equal`, `.to.include`, `.to.be.below`, `.to.have.property` … Also `dx.expect`. |
| `console` | `log`, `info`, `warn`, `error` to the Console. |
| `require(name)` | `chai`, `lodash`, `moment`, `crypto-js`, `uuid`, `ajv`, `handlebars`. Loaded only when a script asks. |

### Variables

| | |
|---|---|
| `dx.vars` | Every variable as a request sees it: this run, then the data row, the environment, the collection, globals. `get`, `has`, `all()`, `fill(text)`; `set` and `unset` change a value for this run only (until the run or send ends). |
| `dx.env` | The active environment. |
| `dx.collection` | The collection's variables. |
| `dx.globals` | Globals, shared by every collection. |
| `dx.row` | The current row of the Runner's data file (read-only). |

`dx.env`, `dx.collection` and `dx.globals` all have `get(name)`, `set(name, value)`, `has(name)`, `unset(name)`,
`clear()`, `all()` and `fill(text)`. Values are stored as text; objects are saved as JSON. `fill('Bearer {{token}}')`
fills in `{{variables}}` and leaves unknown ones as they are.

### The request (before it is sent)

| | |
|---|---|
| `dx.request.url`, `.method` | Read or set. |
| `dx.request.headers` | `get(name)`, `has(name)`, `set(name, value)` (adds or replaces), `remove(name)`, `all()`. Names are case-insensitive. |
| `dx.request.body` | The body as text. Setting an object sends it as JSON (and adds `Content-Type: application/json` if missing). |
| `dx.request.name` | The request's name. |
| `dx.skip()` | Don't send this request. |

### The response (after it arrives)

| | |
|---|---|
| `dx.response.status`, `.statusText`, `.ok` | `201`, `"Created"`, and `true` for any 2xx. |
| `dx.response.time`, `.size` | Milliseconds and bytes. |
| `dx.response.headers` | `get(name)`, `has(name)`, `all()`. |
| `dx.response.text()` | The body as text. |
| `dx.response.json(path?)` | The parsed body, or the value at a path: `json('items.0.name')` or `json('items[0].name')`. |
| `dx.response.validate(schema)` | Checks the body against a JSON Schema: `{ valid, errors }`. |
| `dx.visualize(template, data)` | Shows a [Handlebars](https://handlebarsjs.com) template in the Visualize tab. The template's own scripts can read `window.dx.data`. |

### Extract into variable

You don't have to write these lines by hand. Select a value in a response (or right-click a response header), choose
**Extract into variable…**, and give it a name. Dispatch sets the variable straight away and adds a line like this to
the request's after-response script:

```js
{ const v = dx.response.json('data.token'); if (v != null && v !== '') dx.env.set('token', v) } // extracted
```

It runs on every send, in the runner, in flows and in `dispatch-run`. When a response doesn't have the value, or it's
empty (a login that failed, say), the variable keeps what it had. The line is ordinary script: change it as you like. Lines that end in
`// extracted` are the ones listed as "Sets {{token}}" by the response, and extracting the same variable again replaces
its line; remove the marker to keep a line as your own.

### Sending and running

| | |
|---|---|
| `await dx.send(request)` | Sends another request and returns a response with the same shape as `dx.response`. Pass a URL, or `{ url, method, headers: { name: value }, body }`; an object body is sent as JSON. |
| `dx.next(name)` | In a Runner run: go to that request next. |
| `dx.stop()` | In a Runner run: stop after this request. |
| `dx.info` | `request`, `requestId`, `iteration` (from 0), `iterations`, `phase` (`"before"` or `"after"`). |

## Snippets

```js
// Before request: get a token first
const res = await dx.send({ url: dx.env.get('authUrl'), method: 'POST', body: { user: dx.env.get('user') } })
dx.env.set('token', res.json('token'))

// Before request: a fresh id on every send
dx.request.headers.set('X-Request-Id', dx.vars.fill('{{$guid}}'))

// After response: check the shape
test('matches the schema', () => {
  const { valid, errors } = dx.response.validate({ type: 'object', required: ['id', 'item'] })
  expect(valid, errors.join('; ')).to.equal(true)
})
```

## Scripts from Postman collections

Collections imported from Postman keep their scripts as they are, and they run: `pm.*` (with `pm.response.to…`
assertions), the older `postman.*` and `tests[...]` forms, `responseBody` and the `_` lodash global all still work, in
the same script as `dx` if you like. Write new scripts with `dx`; the editor suggests `dx` first. A Postman export
writes scripts unchanged, so scripts that use `dx` won't run inside Postman.

| Postman | Dispatch |
|---|---|
| `pm.test(name, fn)`, `pm.expect(v)` | `test(name, fn)`, `expect(v)` |
| `pm.response.code`, `pm.response.status` | `dx.response.status`, `dx.response.statusText` |
| `pm.response.responseTime`, `.responseSize` | `dx.response.time`, `dx.response.size` |
| `pm.response.json().a.b` | `dx.response.json('a.b')` |
| `pm.response.to.have.status(200)` | `expect(dx.response.status).to.equal(200)` |
| `pm.response.to.have.jsonSchema(s)` | `expect(dx.response.validate(s).valid).to.equal(true)` |
| `pm.variables`, `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.iterationData` | `dx.vars`, `dx.env`, `dx.collection`, `dx.globals`, `dx.row` |
| `.toObject()`, `.replaceIn(text)` | `.all()`, `.fill(text)` |
| `pm.request.headers.upsert({ key, value })` | `dx.request.headers.set(name, value)` |
| `pm.sendRequest(req, callback)` | `await dx.send(req)` |
| `pm.execution.skipRequest()` | `dx.skip()` |
| `pm.execution.setNextRequest(name)` / `(null)` | `dx.next(name)` / `dx.stop()` |
| `pm.visualizer.set(t, d)` | `dx.visualize(t, d)` |
| `pm.info.iterationCount`, `.eventName` | `dx.info.iterations`, `dx.info.phase` |
