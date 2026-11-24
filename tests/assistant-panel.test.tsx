/** The assistant's panel: what it shows of untrusted output, how it is used, and how it sits in the app. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import * as db from '../src/core/db'
import { listChats, saveChat, type Chat } from '../src/core/assistant/chats'
import { newConnection, type Connection } from '../src/core/assistant/connections'
import { defaultSettings, type HttpResponse } from '../src/core/types'
import type { Transport } from '../src/core/transport'
import type { WorkspaceApi } from '../src/ui/useWorkspace'
import { App } from '../src/ui/App'
import { Markdown } from '../src/ui/Markdown'
import { AssistantHost } from '../src/ui/assistant/AssistantHost'
import AssistantPanel from '../src/ui/assistant/AssistantPanel'
import { items } from '../src/ui/assistant/transcript'
import { updateConnections } from '../src/ui/assistant/store'
import type { AssistantApi } from '../src/ui/assistant/useAssistant'

type Req = { url: string; body: string | null }
const rust = vi.hoisted(() => ({ answers: [] as unknown[], sent: [] as unknown[], cancelled: 0, emit: [] as unknown[], opened: [] as string[] }))
vi.mock('@tauri-apps/api/core', () => {
  class Channel { onmessage: (e: unknown) => void; constructor(cb?: (e: unknown) => void) { this.onmessage = cb ?? (() => {}) } }
  return {
    Channel,
    invoke: async (cmd: string, args: { req: Req; onEvent: Channel; url: string }) => {
      if (cmd === 'ai_cancel') { rust.cancelled++; return }
      if (cmd === 'open_url') { rust.opened.push(args.url); return }
      if (cmd !== 'ai_stream') return
      rust.sent.push(args.req)
      rust.emit.push((e: unknown) => args.onEvent.onmessage(e))
      const a = rust.answers.shift()
      if (a === undefined) throw new Error('offline')
      await Promise.resolve()
      args.onEvent.onmessage({ kind: 'head', status: 200, headers: [] })
      if (a === 'hang') return
      args.onEvent.onmessage({ kind: 'chunk', base64: Buffer.from(a as string).toString('base64') })
      args.onEvent.onmessage({ kind: 'end' })
    },
  }
})
const data = (o: object) => `data: ${JSON.stringify(o)}\n\n`
const says = (text: string) => data({ choices: [{ delta: { content: text } }] }) + data({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
const b64 = (s: string) => Buffer.from(s).toString('base64')
const emit = (i: number) => rust.emit[i] as (e: object) => void

const local = (over: Partial<Connection> = {}): Connection => ({ ...newConnection('compatible'), id: 'l', name: 'My computer', model: 'qwen', tools: 'yes', ...over })
const cloud = (over: Partial<Connection> = {}): Connection => local({ id: 'c', name: 'Work key', baseUrl: 'https://models.example.com/v1', key: 'planted-KEY-123', readLogs: false, ...over })
const chatOf = (messages: unknown[], over: Partial<Chat> = {}): Chat => ({ id: 'ch', spaceId: 'default', connectionId: 'l', model: 'qwen', origin: 'http://localhost:11434', title: 'Why 401', messages, updatedAt: 1, ...over })

const copied: string[] = []
const desktop = (on: boolean) => { if (on) (window as never as Record<string, unknown>).__TAURI_INTERNALS__ = {}; else delete (window as never as Record<string, unknown>).__TAURI_INTERNALS__ }
beforeEach(async () => {
  await db.resetForTests(); localStorage.clear()
  rust.answers.length = 0; rust.sent.length = 0; rust.emit.length = 0; rust.opened.length = 0; rust.cancelled = 0; copied.length = 0
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { copied.push(s) } } })
})
afterEach(() => { cleanup(); desktop(false); vi.restoreAllMocks() })

describe('untrusted Markdown', () => {
  const opened: string[] = []
  const show = (text: string) => { opened.length = 0; return render(<Markdown text={text} untrusted={{ open: (u) => opened.push(u) }} />).container }

  it.each([
    '![secret](https://evil.test/?d=1)', '![](https://evil.test/a.png)', '![x](data:image/png;base64,AAAA)', '[![a](https://evil.test/i.png)](https://evil.test/l)',
    '<img src="https://evil.test/x.png">', '![x](https://evil.test/a.png "title")', '![x](<https://evil.test/a.png>)', '![x][ref]\n\n[ref]: https://evil.test/a.png',
    '| a |\n|---|\n| ![x](https://evil.test/a.png) |', '- ![x](//evil.test/a.png)', '> # ![x](https://evil.test/a.png)',
  ])('loads no image: %s', (text) => {
    const c = show(text)
    expect(c.querySelector('img,picture,source,svg image,video,iframe,object,embed,link,style,[style],[src],[srcset]')).toBeNull()
  })

  it('shows an image’s words and address as text, not as a link', () => {
    const c = show('see ![the plan](https://evil.test/a.png?d=1) here')
    expect(c.textContent).toContain('the plan')
    expect(c.textContent).toContain('https://evil.test/a.png?d=1')
    expect(c.querySelector('a,button,[role="link"]')).toBeNull()
  })

  it.each(['<script>window.__x=1</script>', '<a href="https://evil.test">x</a>', '<iframe src="https://evil.test"></iframe>', '<b onclick="x()">b</b>', '&lt;script&gt;', '```html\n<script>1</script>\n```'])('passes no HTML on: %s', (text) => {
    const c = show(text)
    expect(c.querySelector('script,a,iframe,b,[onclick]')).toBeNull()
    expect(c.textContent).toContain(text.includes('```') ? '<script>1</script>' : text.includes('evil') ? 'evil.test' : text)
  })

  it('shows a link’s whole address, has no href to follow, and opens it only on a click', () => {
    const c = show('[your bank](https://evil.test/login?a=1)')
    expect(c.querySelector('[href]')).toBeNull()
    expect(c.textContent).toContain('your bank')
    const b = screen.getByRole('link', { name: /https:\/\/evil\.test\/login\?a=1/ })
    expect(b.textContent).toBe('https://evil.test/login?a=1')
    expect(opened).toEqual([])
    fireEvent.click(b)
    expect(opened).toEqual(['https://evil.test/login?a=1'])
  })

  it('a label that looks like another address is not what opens', () => {
    show('[https://good.test](https://evil.test/)')
    fireEvent.keyDown(screen.getByRole('link'), { key: 'Enter' })
    expect(opened).toEqual(['https://evil.test/'])
  })

  it('a bare address is a link of that address; look-alike letters show as they are sent', () => {
    show('go to https://api.test/a, then https://раypal.test/x')
    const all = screen.getAllByRole('link').map((b) => b.textContent)
    expect(all[0]).toBe('https://api.test/a')
    expect(all[1]).toContain('https://xn--')
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'tauri://x', '#x', '//evil.test', 'JAVASCRIPT:x', 'ms-settings:x', 'https:'])('is no link: %s', (u) => {
    const c = show(`[x](${u})`)
    expect(c.querySelector('a,button,[role="link"]')).toBeNull()
    expect(c.textContent).toContain('x')
  })

  it('takes mail addresses', () => {
    show('[write](mailto:a@b.test)')
    fireEvent.click(screen.getByRole('link'))
    expect(opened).toEqual(['mailto:a@b.test'])
  })

  it('code blocks, also indented ones in a list, have Copy, which copies just the code', async () => {
    show('1. First\n   ```js\n   dx.test(1)\n     more\n   ```\n2. Second')
    const b = screen.getByRole('button', { name: 'Copy code' })
    await act(async () => { fireEvent.click(b) })
    expect(copied).toEqual(['dx.test(1)\n  more'])
    expect(screen.getAllByRole('list').map((l) => l.getAttribute('start'))).toEqual(['1', '2'])
  })

  it('odd and huge output is shown and stays quick', () => {
    const t = performance.now()
    for (const text of ['['.repeat(200_000), '>'.repeat(200_000), '> '.repeat(20_000) + 'x', '|' + ' '.repeat(200_000) + '|\n' + ' '.repeat(200_000) + 'x', '![['.repeat(60_000), '`'.repeat(200_001), '*a'.repeat(100_000), 'a line\n'.repeat(60_000)]) {
      const c = show(text)
      expect(c.textContent!.length).toBeGreaterThan(0)
      cleanup()
    }
    expect(performance.now() - t).toBeLessThan(8000)
    expect(show('>'.repeat(3900)).querySelectorAll('blockquote').length).toBeLessThan(30)
  }, 30_000)

  it('documents written by people stay as they were', () => {
    const c = render(<Markdown text={'[a](https://x.test)\n\n```js\n1\n```'} />).container
    expect(c.querySelector('a')!.getAttribute('href')).toBe('https://x.test')
    expect(c.querySelector('button')).toBeNull()
  })
})

describe('reading stored messages', () => {
  it('shows what was said and looked up in both providers’ forms, and never tool results or thinking', () => {
    const anthropic = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'HIDDEN' }, { type: 'fallback', to: { model: 'other' } }, { type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't', name: 'get_request', input: { name: 'Shop/Create order' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'RAW', is_error: true }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ]
    expect(items(anthropic).map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([['you', 'q'], ['model', 'other'], ['assistant', 'Looking'], ['tool', 'Read Shop/Create order'], ['assistant', 'Done']])
    expect(items(anthropic)[3]).toMatchObject({ state: 'failed' })
    const chat = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Hm', tool_calls: [{ id: '1', function: { name: 'list_requests', arguments: '{}' } }] }, { role: 'tool', tool_call_id: '1', content: 'RAW' }, { role: 'assistant', content: 'A' }]
    expect(items(chat).map((i) => ('text' in i ? i.text : ''))).toEqual(['q', 'Hm', 'Listed the requests', 'A'])
  })

  it('takes nonsense without failing', () => {
    const bad = [null, 1, 'x', [], {}, { role: 'assistant' }, { role: 'assistant', content: [null, 3, { type: 'text', text: {} }, { type: 'tool_use' }, { type: 'tool_use', name: {}, input: 5 }, { type: 'fallback' }], tool_calls: [null, { function: null }, { function: { name: 'get_request', arguments: '{bad' } }] }, { role: 'user', content: { a: 1 } }, { role: 'assistant', content: null, tool_calls: 'x' }]
    expect(() => items(bad)).not.toThrow()
    expect(() => items('x' as never)).not.toThrow()
    for (const i of items(bad)) expect(typeof (i as { text: unknown }).text).toBe('string')
    expect(items([{ role: 'assistant', content: [{ type: 'tool_use', name: 'get_request', input: { name: 'a\n‮b'.padEnd(500, 'c') } }] }])[0]).toMatchObject({ text: expect.not.stringMatching(/[\n‮]/) })
  })
})

/** The panel alone, with a hook that does what it's told. */
const api = (over: Partial<AssistantApi> = {}): AssistantApi => ({
  ready: true, connections: [local()], connection: local(), selectConnection: vi.fn(), chats: [], chat: null, paused: false, blocked: null,
  send: vi.fn(async () => 'sent' as const), stop: vi.fn(), newChat: vi.fn(), openChat: vi.fn(async () => {}), deleteChat: vi.fn(async () => {}),
  status: 'idle', ended: null, streamed: '', tools: [], usage: null, fallback: null, error: '', pendingConsent: null, allowConsent: vi.fn(async () => 'sent' as const), declineConsent: vi.fn(),
  nearFull: false, summarise: vi.fn(async () => 'sent' as const), summary: null, startFromSummary: vi.fn(async () => 'sent' as const), dismissSummary: vi.fn(), ...over,
})
const ws = (over: object = {}) => ({ spaces: [{ id: 'default', name: 'Orders' }, { id: 'two', name: 'Second' }], activeSpaceId: 'default', environment: { name: 'Staging' }, switchSpace: vi.fn(), setView: vi.fn(), ...over }) as never as WorkspaceApi
function panel(over: Partial<AssistantApi> = {}, w = ws()) {
  const onClose = vi.fn()
  const el = (o: Partial<AssistantApi>, open = true) => <AssistantPanel a={api(o)} ws={w} open={open} onClose={onClose} />
  const r = render(el(over))
  return { ...r, w, onClose, set: (o: Partial<AssistantApi>, open = true) => r.rerender(el(o, open)) }
}
const box = () => screen.getByRole('textbox', { name: 'Message to the assistant' }) as HTMLTextAreaElement
const region = () => screen.getByRole('complementary', { name: 'Assistant' })
const said = () => screen.getByTestId('assistant-said').textContent
const type = (t: string) => fireEvent.change(box(), { target: { value: t } })

describe('the panel', () => {
  it('says where it is, what it can do, and who answers', () => {
    panel({ usage: { input: 1200, output: 30, totalInput: 5000, totalOutput: 200 } })
    expect(within(region()).getByRole('heading').textContent).toBe('Assistant · Orders workspace')
    expect(region().textContent).toContain('Staging')
    expect(region().textContent).toMatch(/can read and explain/)
    expect(region().textContent).toMatch(/can’t change or send anything/)
    expect(region().textContent).toMatch(/My computer · Local · sees what it reads here/)
    expect(region().textContent).toMatch(/5,000 tokens in · 200 out/)
    expect(screen.queryByRole('combobox', { name: 'Connection' })).toBeNull()
  })

  it('offers the connections when there are several', () => {
    const selectConnection = vi.fn()
    panel({ connections: [local(), cloud()], selectConnection })
    fireEvent.change(screen.getByRole('combobox', { name: 'Connection' }), { target: { value: 'c' } })
    expect(selectConnection).toHaveBeenCalledWith('c')
  })

  it('Enter sends and clears, Shift+Enter doesn’t send, nor Enter while composing', async () => {
    const send = vi.fn(async () => 'sent' as const)
    panel({ send })
    type('hi')
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    expect(send).not.toHaveBeenCalled()
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(send).toHaveBeenCalledWith('hi')
    expect(box().value).toBe('')
  })

  it.each(['consent', 'busy', 'blocked', 'stopped'] as const)('keeps the text when it is not sent: %s', async (result) => {
    panel({ send: vi.fn(async () => result) })
    type('hi')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(box().value).toBe('hi')
  })

  it('keeps what was typed while the message was on its way', async () => {
    let go!: (r: 'sent') => void
    panel({ send: () => new Promise((r) => { go = r }) })
    type('one')
    fireEvent.keyDown(box(), { key: 'Enter' })
    type('one two')
    await act(async () => go('sent'))
    expect(box().value).toBe('one two')
  })

  it('Ctrl+Enter in the box never reaches the request', async () => {
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    panel()
    type('hi')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true }) })
    window.removeEventListener('keydown', seen)
    expect(seen).not.toHaveBeenCalled()
  })

  it('Stop is there while it answers', () => {
    const stop = vi.fn(), send = vi.fn(async () => 'sent' as const)
    const p = panel({ status: 'answering', stop, send, streamed: 'part **of**', tools: [{ id: 1, name: 'get_request', input: { name: 'Create order' }, state: 'ok' }] })
    expect(region().textContent).toContain('part **of**') // as it comes; Markdown when finished
    expect(region().textContent).toContain('Read Create order')
    type('x')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(stop).toHaveBeenCalled()
    expect(document.activeElement).toBe(box())
    p.set({})
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('shows only the end of a very long answer while it comes', () => {
    panel({ status: 'answering', streamed: 'START' + 'x'.repeat(500_000) + 'END' })
    expect(region().textContent).toContain('END')
    expect(region().textContent!.length).toBeLessThan(40_000)
  })

  it('announces an answer once, when it is finished', () => {
    const before = chatOf([{ role: 'user', content: 'q' }])
    const p = panel()
    p.set({ status: 'answering' })
    p.set({ status: 'answering', chat: before })
    for (const streamed of ['He', 'Hello', 'Hello wor']) { p.set({ status: 'answering', chat: before, streamed }); expect(said()).toBe('') }
    const changes: string[] = []
    const seen = new MutationObserver(() => changes.push(said()!))
    seen.observe(screen.getByTestId('assistant-said'), { childList: true, characterData: true, subtree: true })
    const done = { chat: chatOf([...before.messages, { role: 'assistant', content: 'Hello **world**' }]), ended: 'done' as const }
    p.set({ status: 'answering', ...done })
    expect(said()).toBe('')
    p.set(done)
    expect(said()).toBe('Hello **world**')
    p.set({ ...done }); p.set({ ...done, usage: { input: 1, output: 1, totalInput: 1, totalOutput: 1 } })
    seen.takeRecords()
    expect(screen.getByTestId('assistant-said').getAttribute('aria-live')).toBe('polite')
    // nothing else is live: the text as it comes must not be read out piece by piece
    expect(region().querySelectorAll('[aria-live]:not([aria-live="off"]),[role="log"],[role="status"],[role="alert"]')).toHaveLength(1)
    p.set(done, false)
    expect(said()).toBe('')
    p.set(done, true)
    expect(said()).toBe('') // opened again: not read again
    p.set({ ...done, status: 'answering' }, false)
    p.set({ ...done, chat: chatOf([...done.chat.messages, { role: 'assistant', content: 'While closed' }]) }, false)
    p.set({ ...done, chat: chatOf([...done.chat.messages, { role: 'assistant', content: 'While closed' }]) })
    expect(said()).toBe('')
  })

  it('announces a failure and a stop, but not an old answer after a send that came to nothing, nor another chat', () => {
    const old = { chat: chatOf([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'OLD' }]), ended: 'done' as const }
    const p = panel(old)
    p.set({ ...old, status: 'answering' })
    p.set({ ...old, error: 'Enter the key again.' })
    expect(said()).toBe('Enter the key again.')
    p.set({ ...old, status: 'answering' })
    expect(said()).toBe('')
    p.set(old)
    expect(said()).toBe('')
    p.set({ ...old, status: 'answering' })
    p.set({ chat: chatOf([{ role: 'assistant', content: 'ELSE' }], { id: 'other' }) })
    expect(said()).toBe('')
    p.set({ ...old, status: 'answering' })
    p.set({ chat: chatOf([...old.chat.messages, { role: 'user', content: 'more' }]), ended: 'stopped' })
    expect(said()).toMatch(/Stopped/)
  })

  it.each([
    [{ ended: 'error' as const, error: 'The key was refused. Check it in Settings.' }, /The key was refused\. Check it/],
    [{ ended: 'stopped' as const, streamed: 'half' }, /half[\s\S]*Stopped/],
    [{ ended: 'limit' as const, error: 'That was 25 look-ups. Send another message to go on.' }, /25 look-ups/],
    [{ ended: 'length' as const, error: 'The answer was cut off.' }, /cut off/],
    [{ ended: 'refused' as const, error: 'The model declined to answer this. Ask it in another way.' }, /declined/],
    [{ ended: 'done' as const, fallback: 'other-model' }, /Answered by other-model/],
  ])('explains the end of an answer: %o', (over, text) => {
    panel({ chat: chatOf([{ role: 'user', content: 'q' }]), ...over })
    expect(region().textContent).toMatch(text)
  })

  it('a paused chat says so and takes you back', () => {
    const p = panel({ chat: chatOf([]), paused: true, blocked: 'This chat belongs to Orders. Open that workspace to go on, or start a new chat here.' }, ws({ activeSpaceId: 'two' }))
    expect(within(region()).getByRole('heading').textContent).toBe('Assistant · Orders workspace')
    expect(region().textContent).not.toContain('Staging')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(box().getAttribute('aria-describedby')).toBe(screen.getByText(/belongs to Orders/).id)
    fireEvent.click(screen.getByRole('button', { name: 'Open Orders' }))
    expect(p.w.switchSpace).toHaveBeenCalledWith('default')
  })

  it('a chat whose connection is gone can be read, and a key that can’t be read is asked for', () => {
    const p = panel({ chat: chatOf([{ role: 'user', content: 'q' }]), connection: null, blocked: 'The connection this chat used was removed. You can read the chat, or start a new one.' })
    expect(region().textContent).toContain('was removed')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    p.set({ connection: local({ keyLost: true }) })
    expect(region().textContent).toMatch(/Enter the key again/)
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(p.w.setView).toHaveBeenCalledWith({ kind: 'settings' })
    p.set({ connection: local({ tools: 'no' }) })
    expect(region().textContent).toMatch(/text questions only/)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true) // nothing typed
    type('x')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('asks for consent and clears the box only for a sent message', async () => {
    const allowConsent = vi.fn(async () => 'sent' as const), declineConsent = vi.fn()
    const pending = (kind: 'message' | 'summary' | 'new-chat') => ({ kind, connection: cloud(), host: 'models.example.com', text: 'hi' })
    const p = panel({ connection: cloud() })
    type('hi')
    p.set({ pendingConsent: pending('summary'), allowConsent, declineConsent })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Allow models.example.com' }).closest('form')!) })
    expect(box().value).toBe('hi')
    p.set({})
    p.set({ pendingConsent: pending('message'), allowConsent, declineConsent })
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(declineConsent).toHaveBeenCalled()
    expect(box().value).toBe('hi')
    p.set({})
    p.set({ pendingConsent: pending('message'), allowConsent })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Allow models.example.com' }).closest('form')!) })
    expect(box().value).toBe('')
  })

  it('the consent question shows even when the panel was closed meanwhile', () => {
    const p = panel()
    p.set({ pendingConsent: { kind: 'message', connection: cloud(), host: 'models.example.com', text: 'hi' } }, false)
    expect(screen.getByRole('button', { name: 'Allow models.example.com' }).closest('[hidden]')).toBeNull()
  })

  it('a full chat offers a new one with a summary to edit; the edit stays until it is sent', async () => {
    const summarise = vi.fn(async () => 'sent' as const)
    const results = ['blocked', 'consent', 'sent'] as const
    let n = 0
    const startFromSummary = vi.fn(async () => results[n++])
    const p = panel({ nearFull: true, chat: chatOf([{ role: 'user', content: 'q' }]), summarise })
    expect(region().textContent).toMatch(/nearly full/)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Summarise for a new chat' })) })
    expect(summarise).toHaveBeenCalled()
    p.set({ summary: 'Summary of an earlier chat:\n\nA', startFromSummary })
    const s = () => screen.getByRole('textbox', { name: 'Summary' }) as HTMLTextAreaElement
    fireEvent.change(s(), { target: { value: 'my edit' } })
    for (const error of ['Offline. Try again.', '']) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start new chat' })) })
      p.set({ summary: 'Summary of an earlier chat:\n\nA', startFromSummary, error })
      expect(s().value).toBe('my edit')
    }
    expect(startFromSummary).toHaveBeenLastCalledWith('my edit')
    p.set({})
    expect(screen.queryByRole('textbox', { name: 'Summary' })).toBeNull()
    p.set({ summary: 'Another' })
    expect(s().value).toBe('Another')
  })

  it('lists the chats, opens one, and deletes after a yes', async () => {
    const openChat = vi.fn(async () => {}), deleteChat = vi.fn(async () => {}), newChat = vi.fn()
    panel({ chats: [chatOf([], { id: '1', title: 'First' }), chatOf([], { id: '2', title: '' })], openChat, deleteChat, newChat })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'First' })) })
    expect(openChat).toHaveBeenCalledWith('1')
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat First' }))
    expect(deleteChat).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^(Delete|OK)$/ })) })
    await waitFor(() => expect(deleteChat).toHaveBeenCalledWith('1'))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(newChat).toHaveBeenCalled()
  })

  it('focus goes to the box on open; Escape closes only when nothing else is open', () => {
    const p = panel({ chats: [chatOf([])] })
    expect(document.activeElement).toBe(box())
    const menu = region().querySelector('details')!
    menu.open = true
    fireEvent.keyDown(box(), { key: 'Escape' })
    menu.open = false
    fireEvent.keyDown(box(), { key: 'Escape', isComposing: true })
    const d = document.body.appendChild(document.createElement('dialog')); d.setAttribute('open', '')
    fireEvent.keyDown(box(), { key: 'Escape' })
    d.remove()
    expect(p.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(p.onClose).toHaveBeenCalledTimes(1)
    type('draft'); p.set({}, false)
    expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull()
    p.set({})
    expect(box().value).toBe('draft')
    expect(document.activeElement).toBe(box())
  })

  it('is resized with the arrow keys, and the width is kept', () => {
    panel()
    const s = screen.getByRole('separator', { name: 'Resize the assistant' })
    const w = () => Number(s.getAttribute('aria-valuenow'))
    const before = w()
    fireEvent.keyDown(s, { key: 'ArrowLeft' })
    expect(w()).toBe(before + 16)
    fireEvent.keyDown(s, { key: 'End' })
    expect(w()).toBe(Number(s.getAttribute('aria-valuemax')))
    fireEvent.keyDown(s, { key: 'ArrowRight' })
    const kept = w()
    cleanup(); panel()
    expect(Number(screen.getByRole('separator', { name: 'Resize the assistant' }).getAttribute('aria-valuenow'))).toBe(kept)
  })

  it('follows the answer only when the person is at the end', () => {
    const p = panel({ status: 'answering', streamed: 'a' })
    const log = region().querySelector('.aiLog') as HTMLElement
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } })
    p.set({ status: 'answering', streamed: 'ab' })
    expect(log.scrollTop).toBe(1000)
    log.scrollTop = 200; fireEvent.scroll(log)
    p.set({ status: 'answering', streamed: 'abc' })
    expect(log.scrollTop).toBe(200)
  })

  it('a link in an answer opens outside, only on a click', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    panel({ chat: chatOf([{ role: 'user', content: '[no](https://me.test)' }, { role: 'assistant', content: '[docs](https://x.test/a)' }]) })
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: /me\.test/ })).toBeNull() // what the person wrote stays as written
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: /x\.test/ })) })
    expect(open).toHaveBeenCalledWith('https://x.test/a', '_blank', 'noopener')
  })

  it('a chat that can’t be shown doesn’t take the panel along', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = chatOf([]); Object.defineProperty(broken, 'messages', { get() { throw new Error('boom') } })
    const p = panel({ chat: broken })
    expect(region().textContent).toMatch(/can’t be shown/)
    expect(box()).toBeTruthy()
    p.set({ chat: chatOf([{ role: 'user', content: 'fine' }], { id: 'x' }) })
    expect(region().textContent).toContain('fine')
  })
})

describe('in the app', () => {
  const transport = { label: 'Fake', unrestricted: true, send: async (): Promise<HttpResponse> => ({ status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }) } as Transport
  const open = async (list: Connection[], t = transport) => { await db.putConnections(list); render(<App transport={t} />); await screen.findByLabelText('URL', {}, { timeout: 5000 }) }
  // what the app still writes when it's closed must not land in the next test
  afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 60)) })
  const icon = () => screen.findByRole('button', { name: /^Assistant/ }, { timeout: 5000 })
  const opened = async () => { const i = await icon(); fireEvent.click(i); await screen.findByRole('textbox', { name: 'Message to the assistant' }); return i }

  it('without a connection there is no icon and nothing on the network; one appears with the first', async () => {
    await open([])
    await expect(screen.findByRole('button', { name: /^Assistant/ }, { timeout: 600 })).rejects.toThrow()
    expect(rust.sent).toEqual([])
    await act(() => updateConnections(() => [local()]))
    const i = await opened()
    expect(i.getAttribute('aria-expanded')).toBe('true')
    await act(() => updateConnections(() => []))
    expect(screen.queryByRole('button', { name: /^Assistant/ })).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull()
  })

  it('has none in the browser', async () => {
    await open([local()], { ...transport, unrestricted: false })
    await expect(screen.findByRole('button', { name: /^Assistant/ }, { timeout: 600 })).rejects.toThrow()
  })

  it('answers; closing keeps it running and busy on the icon, and focus goes back there', async () => {
    await open([local()])
    const i = await opened()
    rust.answers.push('hang')
    type('why?')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    await waitFor(() => expect(rust.emit).toHaveLength(1))
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(document.activeElement).toBe(i)
    expect(i.getAttribute('aria-expanded')).toBe('false')
    expect(i.getAttribute('aria-label')).toBe('Assistant, answering')
    await act(async () => { emit(0)({ kind: 'chunk', base64: b64(says('Because.')) }); emit(0)({ kind: 'end' }) })
    await waitFor(() => expect(i.getAttribute('aria-label')).toBe('Assistant'))
    expect(rust.cancelled).toBe(0)
    fireEvent.click(i)
    expect(region().textContent).toContain('Because.')
    expect(await listChats('default')).toHaveLength(1)
  })

  it('a piece of an answer doesn’t draw the app again', async () => {
    let draws = 0
    const Count = () => { draws++; return null }
    function Page() {
      const [slot, setSlot] = useState<HTMLElement | null>(null)
      return <><Count /><span ref={setSlot} /><AssistantHost ws={hostWs} slot={slot} open onOpen={() => {}} /></>
    }
    const hostWs = { ...(ws() as object), ready: true, settings: { ...defaultSettings }, draft: {}, transport, collections: [], allCollections: [], folders: [], requests: [], environments: [], allEnvironments: [], environment: null, globals: [], history: [], logs: [], tabs: [], allTabs: [], view: { kind: 'home' }, pipeline: { current: {} }, cookieJars: { entries: () => ({}) } } as never as WorkspaceApi
    await db.putConnections([local()])
    render(<Page />)
    await screen.findByRole('textbox', { name: 'Message to the assistant' })
    rust.answers.push('hang')
    type('q')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    await waitFor(() => expect(rust.emit).toHaveLength(1))
    const before = draws
    await act(async () => { emit(0)({ kind: 'chunk', base64: b64(data({ choices: [{ delta: { content: 'piece' } }] })) }) })
    await waitFor(() => expect(region().textContent).toContain('piece'))
    expect(draws).toBe(before)
  })

  it('asks before the first message to another computer, and sends nothing before the yes', async () => {
    await open([cloud()])
    await opened()
    type('hi')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    const yes = await screen.findByRole('button', { name: 'Allow models.example.com' })
    expect(rust.sent).toEqual([])
    rust.answers.push(says('Hello'))
    await act(async () => { fireEvent.submit(yes.closest('form')!) })
    await waitFor(() => expect(region().textContent).toContain('Hello'))
    expect(rust.sent).toHaveLength(1)
    expect(box().value).toBe('')
    await waitFor(async () => expect((await icon()).getAttribute('aria-label')).toBe('Assistant')) // kept, before the next test clears the device
  })

  it('another workspace pauses the chat; another model starts a new one', async () => {
    await db.putSpaces([{ id: 'default', name: 'Orders' }, { id: 'two', name: 'Second' }])
    await saveChat(chatOf([{ role: 'user', content: 'old question' }]))
    await open([local()])
    await opened()
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Why 401' }, { timeout: 5000 })) })
    await waitFor(() => expect(region().textContent).toContain('old question'))
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), { target: { value: 'two' } }) })
    await waitFor(() => expect(region().textContent).toMatch(/belongs to Orders/))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open Orders' })) })
    await waitFor(() => expect(region().textContent).not.toMatch(/belongs to Orders/))
    expect(region().textContent).toContain('old question')
    await act(() => updateConnections((l) => l.map((c) => ({ ...c, model: 'new' }))))
    await waitFor(() => expect(region().textContent).not.toContain('old question'))
  })

  it('a link goes to the system browser', async () => {
    await db.putSpaces([{ id: 'default', name: 'Orders' }])
    await saveChat(chatOf([{ role: 'assistant', content: 'https://x.test/a' }]))
    await open([local()])
    await opened()
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Why 401' }, { timeout: 5000 })) })
    const link = await screen.findByRole('link', { name: /x\.test/ })
    desktop(true)
    await act(async () => { fireEvent.click(link) })
    await waitFor(() => expect(rust.opened).toEqual(['https://x.test/a']))
  })
})
