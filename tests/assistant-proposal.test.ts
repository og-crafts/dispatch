import { describe, expect, it } from 'vitest'
import { validate } from '../src/core/assistant/gate'
import { canonical } from '../src/core/assistant/proposal'
import { offeredTools, toolClass } from '../src/core/assistant/tools'
import type { Connection } from '../src/core/assistant/connections'
import { workspaceTools } from '../src/core/mcpWorkspace'
import { emptyScripts, newCollection } from '../src/core/types'

const conn = (o: Partial<Connection> = {}): Connection => ({ id: 'c', name: 'c', kind: 'compatible', model: 'm', tools: 'yes', readLogs: false, ...o }) as Connection
const names = (c: Connection, job?: 'ask' | 'scripts') => offeredTools(c, job).map((t) => t.name)

describe('validate', () => {
  const map = { type: 'object', additionalProperties: { type: 'string' } }
  it('checks the values of an additionalProperties object, own properties only', () => {
    expect(validate({ a: 'x', b: 'y' }, map)).toBeNull()
    expect(validate({ a: 1 }, map)).toMatch(/must be a string/)
    expect(validate(JSON.parse('{"__proto__":"x"}'), map)).not.toBeNull()
    expect(validate({}, map)).toBeNull()
  })
  it('checks arrays item by item', () => {
    const list = { type: 'object', properties: { remove: { type: 'array', items: { type: 'string' } } } }
    expect(validate({ remove: ['a', 'b'] }, list)).toBeNull()
    expect(validate({ remove: ['a', 2] }, list)).not.toBeNull()
    expect(validate({ remove: 'a' }, list)).not.toBeNull()
  })
  it('still refuses any field of an object with neither properties nor additionalProperties', () => {
    expect(validate({ a: 'x' }, { type: 'object' })).not.toBeNull()
    expect(validate({}, { type: 'object' })).toBeNull()
    expect(validate(JSON.parse('{"__proto__":{}}'), { type: 'object', properties: {} })).not.toBeNull()
  })
})

describe('canonical', () => {
  it('ignores updatedAt and key order, and sees a changed nested script', () => {
    const c = newCollection('A')
    expect(canonical({ ...c, updatedAt: 5 })).toBe(canonical({ ...c, updatedAt: 99 }))
    expect(canonical(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(c).reverse()))))).toBe(canonical(c))
    expect(canonical({ ...c, scripts: { ...emptyScripts(), post: 'x' } })).not.toBe(canonical(c))
    expect(canonical(null)).toBe('null')
  })
})

describe('tool classes and what is offered', () => {
  it('classifies every tool, and nothing else', () => {
    expect(toolClass('get_request')).toBe('read')
    expect(toolClass('update_request')).toBe('edit')
    expect(toolClass('delete_request')).toBe('delete')
    expect(['suggest_parameters', 'apply_parameters', 'set_environment_variables'].map(toolClass)).toEqual(['read', 'edit', 'edit'])
    for (const n of ['send_request', 'run_collection', 'run_flow', 'made_up', 'constructor', '']) expect(toolClass(n)).toBeNull()
  })
  it('offers the read tools and the edit tools', () => {
    expect(names(conn({ readLogs: true }))).toEqual(expect.arrayContaining(['list_requests', 'suggest_parameters', 'create_request', 'update_request', 'copy_request', 'move_request', 'set_variables', 'set_scripts', 'delete_request', 'apply_parameters', 'set_environment_variables']))
    expect(names(conn({ tools: 'no' }))).toEqual([])
  })
  it.each([['ask', undefined], ['scripts', undefined], ['ask', 8_000], ['scripts', 8_000]] as const)('sending and running are never offered (job %s, context %s)', (job, contextTokens) => {
    const all = names(conn({ readLogs: true, ...(contextTokens ? { contextTokens } : {}) }), job)
    expect(all).toContain('get_request')
    for (const n of ['send_request', 'run_collection', 'run_flow']) expect(all).not.toContain(n)
  })
  it('update_request has no `reviewed`', () => {
    const t = offeredTools(conn()).find((x) => x.name === 'update_request')!
    expect(Object.keys((t.inputSchema as { properties: object }).properties)).not.toContain('reviewed')
  })
  it('a small context offers the read tools for ask and a few edit tools for scripts', () => {
    const small = conn({ contextTokens: 8_000 })
    expect(names(small).every((n) => toolClass(n) === 'read')).toBe(true)
    expect(names(small, 'ask')).toEqual(names(small))
    expect(names(small, 'scripts').filter((n) => !names(small).includes(n)).sort()).toEqual(['apply_parameters', 'set_environment_variables', 'set_scripts', 'suggest_parameters', 'update_request'])
    expect(names(small)).not.toContain('suggest_parameters')
  })
  it('the chat’s move and delete promise nothing it doesn’t have', () => {
    const text = (n: string) => offeredTools(conn()).find((t) => t.name === n)!.description
    expect(text('move_request')).not.toMatch(/handed/)
    expect(text('delete_request')).toBe('Delete a request from the open workspace. The person decides, and can undo it until Dispatch closes.')
  })
  it('no tool the chat is offered mentions assistant/ or an own workspace', () => {
    const t = JSON.stringify(offeredTools(conn({ readLogs: true })))
    expect(t).not.toContain('assistant/')
    expect(t).not.toMatch(/own workspace/)
  })
})

describe('the chat’s own offering', () => {
  it('has each name once, with the chat’s parameter tools', () => {
    const t = offeredTools(conn({ readLogs: true })), names = t.map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
    expect(workspaceTools('open', false).map((x) => x.name)).not.toContain('apply_parameters')
    expect(Object.keys((t.find((x) => x.name === 'apply_parameters')!.inputSchema as { properties: object }).properties)).toContain('where')
  })
})

describe('outside assistants’ tool texts', () => {
  it('stay as they were (editable workspace)', () => { expect(workspaceTools('X')).toMatchInlineSnapshot(`
    [
      {
        "description": "Save a new HTTP request in your own workspace ("assistant/…") or the user’s workspace “X”. It is not sent; use send_request for that.",
        "inputSchema": {
          "properties": {
            "body": {
              "description": "The request body as text. Values shown as <hidden> can't be written back.",
              "type": "string",
            },
            "bodyType": {
              "description": "Defaults to json when the body is JSON, otherwise text.",
              "enum": [
                "json",
                "text",
                "xml",
                "html",
                "graphql",
              ],
              "type": "string",
            },
            "docs": {
              "description": "Notes shown with the request (Markdown).",
              "type": "string",
            },
            "folder": {
              "description": "Where to save it: a path like "assistant/Orders" or "assistant/Orders/Admin", or "Orders/Admin" for the user’s workspace “X”, which they let you edit: the first part is the collection; collections and folders that don’t exist yet are made.",
              "type": "string",
            },
            "headers": {
              "additionalProperties": {
                "type": "string",
              },
              "description": "Header names and values (replaces all headers). Values shown as <hidden> can't be written back: leave headers out to keep them, or use a {{variable}}.",
              "type": "object",
            },
            "method": {
              "description": "Defaults to GET.",
              "enum": [
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "HEAD",
                "OPTIONS",
              ],
              "type": "string",
            },
            "name": {
              "type": "string",
            },
            "preRequestScript": {
              "description": "JavaScript run before it is sent (dx.vars.set, dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it. get_request shows the current one.",
              "type": "string",
            },
            "testScript": {
              "description": "JavaScript run after the response (test("name", () => expect(dx.response.status).to.equal(200)), dx.response.json(), dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it.",
              "type": "string",
            },
            "url": {
              "description": "The full URL with any query string; {{variables}} are fine.",
              "type": "string",
            },
          },
          "required": [
            "folder",
            "name",
            "url",
          ],
          "type": "object",
        },
        "name": "create_request",
      },
      {
        "description": "Change a request in your own workspace ("assistant/…") or the user’s workspace “X”. Only the fields given change.",
        "inputSchema": {
          "properties": {
            "body": {
              "description": "The request body as text. Values shown as <hidden> can't be written back.",
              "type": "string",
            },
            "bodyType": {
              "description": "Defaults to json when the body is JSON, otherwise text.",
              "enum": [
                "json",
                "text",
                "xml",
                "html",
                "graphql",
              ],
              "type": "string",
            },
            "docs": {
              "description": "Notes shown with the request (Markdown).",
              "type": "string",
            },
            "headers": {
              "additionalProperties": {
                "type": "string",
              },
              "description": "Header names and values (replaces all headers). Values shown as <hidden> can't be written back: leave headers out to keep them, or use a {{variable}}.",
              "type": "object",
            },
            "method": {
              "enum": [
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "HEAD",
                "OPTIONS",
              ],
              "type": "string",
            },
            "name": {
              "description": "Its path, like "assistant/Orders/Create order".",
              "type": "string",
            },
            "newName": {
              "description": "Rename it.",
              "type": "string",
            },
            "preRequestScript": {
              "description": "JavaScript run before it is sent (dx.vars.set, dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it. get_request shows the current one.",
              "type": "string",
            },
            "reviewed": {
              "description": "true clears the “handed to you” flag without moving it (move_request clears it too).",
              "type": "boolean",
            },
            "testScript": {
              "description": "JavaScript run after the response (test("name", () => expect(dx.response.status).to.equal(200)), dx.response.json(), dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it.",
              "type": "string",
            },
            "url": {
              "description": "The full URL with any query string; {{variables}} are fine.",
              "type": "string",
            },
          },
          "required": [
            "name",
          ],
          "type": "object",
        },
        "name": "update_request",
      },
      {
        "description": "Copy a request (the user’s or your own) into your own workspace ("assistant/…") or the user’s workspace “X”, with its auth, scripts and settings, so you can change and send the copy.",
        "inputSchema": {
          "properties": {
            "from": {
              "description": "The path from list_requests.",
              "type": "string",
            },
            "name": {
              "description": "A name for the copy; defaults to the original’s.",
              "type": "string",
            },
            "to": {
              "description": "Where to put the copy: a path like "assistant/Orders" or "assistant/Orders/Admin", or "Orders/Admin" for the user’s workspace “X”, which they let you edit: the first part is the collection; collections and folders that don’t exist yet are made.",
              "type": "string",
            },
          },
          "required": [
            "from",
            "to",
          ],
          "type": "object",
        },
        "name": "copy_request",
      },
      {
        "description": "Move (and optionally rename) a request within your own workspace ("assistant/…") or the user’s workspace “X”, e.g. to file one the user handed you from assistant/Inbox into a proper collection. Its auth comes along, and a collection made for it gets the original collection’s variables. Clears the “handed to you” flag.",
        "inputSchema": {
          "properties": {
            "name": {
              "description": "Its path, like "assistant/Inbox/Create order".",
              "type": "string",
            },
            "newName": {
              "description": "Rename it on the way.",
              "type": "string",
            },
            "to": {
              "description": "Where to: a path like "assistant/Orders" or "assistant/Orders/Admin", or "Orders/Admin" for the user’s workspace “X”, which they let you edit: the first part is the collection; collections and folders that don’t exist yet are made.",
              "type": "string",
            },
          },
          "required": [
            "name",
            "to",
          ],
          "type": "object",
        },
        "name": "move_request",
      },
      {
        "description": "Delete a request from your own workspace ("assistant/…") or the user’s workspace “X”. The user can undo it in the app.",
        "inputSchema": {
          "properties": {
            "name": {
              "description": "Its path, like "assistant/Orders/Create order".",
              "type": "string",
            },
          },
          "required": [
            "name",
          ],
          "type": "object",
        },
        "name": "delete_request",
      },
      {
        "description": "Set or remove collection variables (used as {{name}} in its requests) on a collection in your own workspace ("assistant/…") or the user’s workspace “X”, e.g. a {{baseUrl}} after replacing a hard-coded host.",
        "inputSchema": {
          "properties": {
            "collection": {
              "description": "The collection, like "assistant/Orders".",
              "type": "string",
            },
            "remove": {
              "description": "Names to remove.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "variables": {
              "additionalProperties": {
                "type": "string",
              },
              "description": "Names and values to set.",
              "type": "object",
            },
          },
          "required": [
            "collection",
          ],
          "type": "object",
        },
        "name": "set_variables",
      },
      {
        "description": "Set the pre-request or tests script of a collection or folder in your own workspace ("assistant/…") or the user’s workspace “X”; it runs for every request inside. For one request's own scripts use update_request.",
        "inputSchema": {
          "properties": {
            "path": {
              "description": "The collection or folder, like "assistant/Orders" or "assistant/Orders/Admin".",
              "type": "string",
            },
            "preRequestScript": {
              "description": "JavaScript run before every request in the collection or folder (dx.vars.set, dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it. get_request shows the current one.",
              "type": "string",
            },
            "testScript": {
              "description": "JavaScript run after the response of every request in the collection or folder (test("name", () => expect(dx.response.status).to.equal(200)), dx.response.json(), dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it.",
              "type": "string",
            },
          },
          "required": [
            "path",
          ],
          "type": "object",
        },
        "name": "set_scripts",
      },
      {
        "description": "List what is written into a request in your own workspace ("assistant/…") or the user’s workspace “X” and could be moved into {{variables}} (base URL, tokens, API keys, passwords, IDs in the path, values that a variable already has), one per line: id · what · the variable · new or existing · secret. No values are shown. Use the ids and the batch with apply_parameters.",
        "inputSchema": {
          "properties": {
            "name": {
              "description": "Its path, like "assistant/Orders/Create order".",
              "type": "string",
            },
          },
          "required": [
            "name",
          ],
          "type": "object",
        },
        "name": "suggest_parameters",
      },
      {
        "description": "Move values that suggest_parameters listed into variables. Dispatch moves the values itself, also the ones you can’t see. New variables go to the request’s collection; tokens, keys and passwords become secret variables.",
        "inputSchema": {
          "properties": {
            "batch": {
              "description": "The batch suggest_parameters gave.",
              "type": "string",
            },
            "choose": {
              "additionalProperties": {
                "type": "string",
              },
              "description": "The ids to move, each with the name for its variable, or "" for the suggested name.",
              "type": "object",
            },
            "name": {
              "description": "The request, as for suggest_parameters.",
              "type": "string",
            },
          },
          "required": [
            "name",
            "batch",
            "choose",
          ],
          "type": "object",
        },
        "name": "apply_parameters",
      },
    ]
  `) })
  it('stay as they were (own workspace only)', () => { expect(workspaceTools()).toMatchInlineSnapshot(`
    [
      {
        "description": "Save a new HTTP request in your own workspace ("assistant/…"). It is not sent; use send_request for that. You can’t write to the user’s workspaces; they move what they want to keep.",
        "inputSchema": {
          "properties": {
            "body": {
              "description": "The request body as text. Values shown as <hidden> can't be written back.",
              "type": "string",
            },
            "bodyType": {
              "description": "Defaults to json when the body is JSON, otherwise text.",
              "enum": [
                "json",
                "text",
                "xml",
                "html",
                "graphql",
              ],
              "type": "string",
            },
            "docs": {
              "description": "Notes shown with the request (Markdown).",
              "type": "string",
            },
            "folder": {
              "description": "Where to save it: a path like "assistant/Orders" or "assistant/Orders/Admin": the first part is the collection; collections and folders that don’t exist yet are made.",
              "type": "string",
            },
            "headers": {
              "additionalProperties": {
                "type": "string",
              },
              "description": "Header names and values (replaces all headers). Values shown as <hidden> can't be written back: leave headers out to keep them, or use a {{variable}}.",
              "type": "object",
            },
            "method": {
              "description": "Defaults to GET.",
              "enum": [
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "HEAD",
                "OPTIONS",
              ],
              "type": "string",
            },
            "name": {
              "type": "string",
            },
            "preRequestScript": {
              "description": "JavaScript run before it is sent (dx.vars.set, dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it. get_request shows the current one.",
              "type": "string",
            },
            "testScript": {
              "description": "JavaScript run after the response (test("name", () => expect(dx.response.status).to.equal(200)), dx.response.json(), dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it.",
              "type": "string",
            },
            "url": {
              "description": "The full URL with any query string; {{variables}} are fine.",
              "type": "string",
            },
          },
          "required": [
            "folder",
            "name",
            "url",
          ],
          "type": "object",
        },
        "name": "create_request",
      },
      {
        "description": "Change a request in your own workspace ("assistant/…"). Only the fields given change. The user’s saved requests can’t be changed: copy_request one first and change the copy.",
        "inputSchema": {
          "properties": {
            "body": {
              "description": "The request body as text. Values shown as <hidden> can't be written back.",
              "type": "string",
            },
            "bodyType": {
              "description": "Defaults to json when the body is JSON, otherwise text.",
              "enum": [
                "json",
                "text",
                "xml",
                "html",
                "graphql",
              ],
              "type": "string",
            },
            "docs": {
              "description": "Notes shown with the request (Markdown).",
              "type": "string",
            },
            "headers": {
              "additionalProperties": {
                "type": "string",
              },
              "description": "Header names and values (replaces all headers). Values shown as <hidden> can't be written back: leave headers out to keep them, or use a {{variable}}.",
              "type": "object",
            },
            "method": {
              "enum": [
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "HEAD",
                "OPTIONS",
              ],
              "type": "string",
            },
            "name": {
              "description": "Its path, like "assistant/Orders/Create order".",
              "type": "string",
            },
            "newName": {
              "description": "Rename it.",
              "type": "string",
            },
            "preRequestScript": {
              "description": "JavaScript run before it is sent (dx.vars.set, dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it. get_request shows the current one.",
              "type": "string",
            },
            "reviewed": {
              "description": "true clears the “handed to you” flag without moving it (move_request clears it too).",
              "type": "boolean",
            },
            "testScript": {
              "description": "JavaScript run after the response (test("name", () => expect(dx.response.status).to.equal(200)), dx.response.json(), dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it.",
              "type": "string",
            },
            "url": {
              "description": "The full URL with any query string; {{variables}} are fine.",
              "type": "string",
            },
          },
          "required": [
            "name",
          ],
          "type": "object",
        },
        "name": "update_request",
      },
      {
        "description": "Copy a request (the user’s or your own) into your own workspace ("assistant/…"), with its auth, scripts and settings, so you can change and send the copy.",
        "inputSchema": {
          "properties": {
            "from": {
              "description": "The path from list_requests.",
              "type": "string",
            },
            "name": {
              "description": "A name for the copy; defaults to the original’s.",
              "type": "string",
            },
            "to": {
              "description": "Where to put the copy: a path like "assistant/Orders" or "assistant/Orders/Admin": the first part is the collection; collections and folders that don’t exist yet are made.",
              "type": "string",
            },
          },
          "required": [
            "from",
            "to",
          ],
          "type": "object",
        },
        "name": "copy_request",
      },
      {
        "description": "Move (and optionally rename) a request within your own workspace ("assistant/…"), e.g. to file one the user handed you from assistant/Inbox into a proper collection. Its auth comes along, and a collection made for it gets the original collection’s variables. Clears the “handed to you” flag.",
        "inputSchema": {
          "properties": {
            "name": {
              "description": "Its path, like "assistant/Inbox/Create order".",
              "type": "string",
            },
            "newName": {
              "description": "Rename it on the way.",
              "type": "string",
            },
            "to": {
              "description": "Where to: a path like "assistant/Orders" or "assistant/Orders/Admin": the first part is the collection; collections and folders that don’t exist yet are made.",
              "type": "string",
            },
          },
          "required": [
            "name",
            "to",
          ],
          "type": "object",
        },
        "name": "move_request",
      },
      {
        "description": "Delete a request from your own workspace ("assistant/…"). The user can undo it in the app.",
        "inputSchema": {
          "properties": {
            "name": {
              "description": "Its path, like "assistant/Orders/Create order".",
              "type": "string",
            },
          },
          "required": [
            "name",
          ],
          "type": "object",
        },
        "name": "delete_request",
      },
      {
        "description": "Set or remove collection variables (used as {{name}} in its requests) on a collection in your own workspace ("assistant/…"), e.g. a {{baseUrl}} after replacing a hard-coded host.",
        "inputSchema": {
          "properties": {
            "collection": {
              "description": "The collection, like "assistant/Orders".",
              "type": "string",
            },
            "remove": {
              "description": "Names to remove.",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "variables": {
              "additionalProperties": {
                "type": "string",
              },
              "description": "Names and values to set.",
              "type": "object",
            },
          },
          "required": [
            "collection",
          ],
          "type": "object",
        },
        "name": "set_variables",
      },
      {
        "description": "Set the pre-request or tests script of a collection or folder in your own workspace ("assistant/…"); it runs for every request inside. For one request's own scripts use update_request.",
        "inputSchema": {
          "properties": {
            "path": {
              "description": "The collection or folder, like "assistant/Orders" or "assistant/Orders/Admin".",
              "type": "string",
            },
            "preRequestScript": {
              "description": "JavaScript run before every request in the collection or folder (dx.vars.set, dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it. get_request shows the current one.",
              "type": "string",
            },
            "testScript": {
              "description": "JavaScript run after the response of every request in the collection or folder (test("name", () => expect(dx.response.status).to.equal(200)), dx.response.json(), dx.env.set …; Postman's pm.* also works, but write new scripts with dx). Replaces the whole script; "" removes it.",
              "type": "string",
            },
          },
          "required": [
            "path",
          ],
          "type": "object",
        },
        "name": "set_scripts",
      },
      {
        "description": "List what is written into a request in your own workspace ("assistant/…") and could be moved into {{variables}} (base URL, tokens, API keys, passwords, IDs in the path, values that a variable already has), one per line: id · what · the variable · new or existing · secret. No values are shown. Use the ids and the batch with apply_parameters.",
        "inputSchema": {
          "properties": {
            "name": {
              "description": "Its path, like "assistant/Orders/Create order".",
              "type": "string",
            },
          },
          "required": [
            "name",
          ],
          "type": "object",
        },
        "name": "suggest_parameters",
      },
      {
        "description": "Move values that suggest_parameters listed into variables. Dispatch moves the values itself, also the ones you can’t see. New variables go to the request’s collection; tokens, keys and passwords become secret variables.",
        "inputSchema": {
          "properties": {
            "batch": {
              "description": "The batch suggest_parameters gave.",
              "type": "string",
            },
            "choose": {
              "additionalProperties": {
                "type": "string",
              },
              "description": "The ids to move, each with the name for its variable, or "" for the suggested name.",
              "type": "object",
            },
            "name": {
              "description": "The request, as for suggest_parameters.",
              "type": "string",
            },
          },
          "required": [
            "name",
            "batch",
            "choose",
          ],
          "type": "object",
        },
        "name": "apply_parameters",
      },
    ]
  `) })
})
