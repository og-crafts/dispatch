/** The card: what the person sees and clicks before the assistant may change anything. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as db from '../src/core/db'
import { newConnection, type Connection } from '../src/core/assistant/connections'
import type { Line, Proposal } from '../src/core/assistant/proposal'
import { oneLine } from '../src/core/assistant/propose'
import { newRequest } from '../src/core/types'
import type { WorkspaceApi } from '../src/ui/useWorkspace'
import AssistantPanel from '../src/ui/assistant/AssistantPanel'
import { AssistantHost } from '../src/ui/assistant/AssistantHost'
import { items, toolLine, turns } from '../src/ui/assistant/transcript'
import type { AssistantApi, Card } from '../src/ui/assistant/useAssistant'

const fake = vi.hoisted(() => ({ a: null as unknown }))
vi.mock('../src/ui/assistant/useAssistant', () => ({ useAssistant: () => fake.a }))

const local = (over: Partial<Connection> = {}): Connection => ({ ...newConnection('compatible'), id: 'l', name: 'My computer', model: 'qwen', tools: 'yes', ...over })
const asked = (messages: unknown[] = [{ role: 'user', content: 'Add a test' }]) => ({ id: 'ch', spaceId: 'default', connectionId: 'l', model: 'qwen', title: 't', messages, updatedAt: 1 })
const RAW = 'planted-RAW-record-secret', BASIS = 'planted-BASIS-secret', REPLY = 'planted-reply'
const RISK = 'Scripts run when this is sent. They can read variables, including secrets, and send requests.'
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p', spaceId: 'default', tool: 'update_request', cls: 'edit', title: 'Change “Create order”', warnings: [RISK], reply: REPLY, basis: BASIS,
  fields: [{ label: 'After-response script', lines: [{ type: 'same', text: '// tests' }, { type: 'del', text: 'old()' }, { type: 'add', text: 'created()' }, { type: 'gap', text: '3 unchanged lines' }] }],
  changes: [{ kind: 'request', id: 'r', before: newRequest({ name: RAW }), after: newRequest({ name: RAW, url: RAW }) }], ...over,
})
const deletion = (over: Partial<Proposal> = {}) => proposal({ tool: 'delete_request', cls: 'delete', title: 'Delete “Create order”', warnings: [], ...over })
const card = (over: Partial<Card> = {}, p: Proposal = proposal()): Card => ({ proposal: p, state: 'waiting', at: 1, ...over })
const many = (n: number): Line[] => Array.from({ length: n }, (_, i) => ({ type: 'add', text: `line ${i + 1}` }))
const api = (over: Partial<AssistantApi> = {}): AssistantApi => ({
  ready: true, connections: [local()], connection: local(), selectConnection: vi.fn(), chats: [], chat: asked() as AssistantApi['chat'], paused: false, blocked: null,
  send: vi.fn(async () => 'sent' as const), stop: vi.fn(), newChat: vi.fn(), openChat: vi.fn(async () => {}), deleteChat: vi.fn(async () => {}),
  status: 'answering', ended: null, streamed: '', tools: [], cards: [card()], approve: vi.fn(async () => {}), reject: vi.fn(), undo: vi.fn(async () => {}), job: 'ask', setJob: vi.fn(), usage: null, fallback: null, error: '', pendingConsent: null, allowConsent: vi.fn(async () => 'sent' as const), declineConsent: vi.fn(),
  nearFull: false, summarise: vi.fn(async () => 'sent' as const), summary: null, startFromSummary: vi.fn(async () => 'sent' as const), dismissSummary: vi.fn(), ...over,
})
const ws = { spaces: [{ id: 'default', name: 'Orders' }], activeSpaceId: 'default', environment: null, switchSpace: vi.fn(), setView: vi.fn() } as never as WorkspaceApi
function panel(over: Partial<AssistantApi> = {}, open = true) {
  const onClose = vi.fn()
  const el = (a: AssistantApi, o: boolean) => <AssistantPanel a={a} ws={ws} open={o} onClose={onClose} />
  let a = api(over)
  const r = render(el(a, open))
  return { ...r, api: () => a, onClose, set: (o: Partial<AssistantApi>, now = true) => { a = { ...a, ...o }; r.rerender(el(a, now)) } }
}
const cards = () => screen.queryAllByRole('group', { name: /“/ })
const b = (name: string | RegExp) => screen.queryByRole('button', { name }) as HTMLButtonElement | null
const box = () => screen.getByRole('textbox', { name: 'Message to the assistant' }) as HTMLTextAreaElement
const said = () => screen.getByTestId('assistant-said').textContent
const wait = (ms = 500) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(async () => { await db.resetForTests(); localStorage.clear(); vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('what a card shows', () => {
  it('its title, every field as a diff in signs and words, and the warnings', () => {
    panel()
    const [c] = cards()
    expect(c.getAttribute('aria-label')).toBe('Change “Create order”')
    expect(within(c).getByText('After-response script')).toBeTruthy()
    expect(c.querySelector('pre')).not.toBeNull()
    const rows = [...c.querySelectorAll('pre .aiLine')].map((x) => x.textContent)
    expect(rows).toEqual([' // tests', '−removed: old()', '+added: created()', '3 unchanged lines'])
    expect([...c.querySelectorAll('.aiLine .sr')].map((x) => x.textContent)).toEqual(['removed: ', 'added: '])
    expect(c.textContent).toContain(RISK)
  })

  it('holds nothing of the records, of what it rests on or of the reply', () => {
    for (const state of ['waiting', 'applying', 'applied', 'rejected', 'expired', 'stopped', 'undone'] as const) {
      const r = panel({ cards: [card({ state })] })
      expect(document.documentElement.outerHTML).not.toMatch(/planted/)
      r.unmount()
    }
  })

  it('a model’s text stays text: no Markdown, no HTML, nothing that turns it around', () => {
    const evil = '<img src=x onerror=1> **b** [x](https://evil.test)'
    panel({ cards: [card({}, proposal({ title: `Change “${evil}”`, warnings: [evil], fields: [{ label: 'Docs', lines: [{ type: 'add', text: evil }] }] }))] })
    const [c] = cards()
    expect(c.querySelector('img,a,strong,[href],[role="link"]')).toBeNull()
    expect(c.textContent!.split(evil)).toHaveLength(4)
  })

  it('is after the message it belongs to, in order, also when the chat went on', () => {
    const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer one' }, { role: 'user', content: 'second' }]
    panel({ chat: asked(messages) as AssistantApi['chat'], cards: [
      card({ state: 'applied', at: 1 }, proposal({ id: 'a', title: 'Change “A”' })), card({ state: 'rejected', at: 1 }, proposal({ id: 'b', title: 'Change “B”' })), card({ at: 3 }, proposal({ id: 'c', title: 'Change “C”' })),
    ] })
    const t = screen.getByRole('group', { name: 'Conversation' }).textContent!
    const at = ['first', 'answer one', 'Change “A”', 'Change “B”', 'second', 'Change “C”'].map((x) => t.indexOf(x))
    expect(at.every((x) => x >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
  })

  it('takes one very long line and very many lines without freezing', async () => {
    const started = performance.now()
    const r = panel({ cards: [card({}, proposal({ fields: [{ label: 'Body', lines: [{ type: 'add', text: 'x'.repeat(1_000_000) }] }] }))] })
    wait()
    expect(cards()[0].textContent!.length).toBeLessThan(50_000)
    expect(b('Apply')!.disabled).toBe(true)
    fireEvent.click(b('Show all 1,000,000 characters')!)
    wait()
    expect(cards()[0].querySelector('pre')!.textContent!.length).toBeGreaterThanOrEqual(1_000_000)
    expect(b('Apply')!.disabled).toBe(false)
    r.unmount()
    panel({ cards: [card({}, proposal({ fields: [{ label: 'Body', lines: many(6_000) }] }))] })
    wait()
    fireEvent.click(b('Show all 6,000 lines')!)
    expect(b('Apply')!.disabled).toBe(true) // drawn a part at a time
    for (let i = 0; i < 20; i++) wait(100)
    expect(cards()[0].textContent).toContain('line 6000')
    expect(b('Apply')!.disabled).toBe(false)
    expect(performance.now() - started).toBeLessThan(15_000)
  })
})

describe('deciding', () => {
  it('Apply and Reject are real buttons, not focused on their own, and do nothing for the first 500 ms', () => {
    const p = panel()
    for (const n of ['Apply', 'Reject']) {
      expect(b(n)!.tagName).toBe('BUTTON')
      expect(b(n)!.getAttribute('type')).toBe('button')
      expect(b(n)!.disabled).toBe(true)
      fireEvent.click(b(n)!)
    }
    expect(document.activeElement).toBe(box())
    wait(499)
    expect(b('Apply')!.disabled).toBe(true)
    wait(1)
    expect(document.activeElement).toBe(box())
    expect(p.api().approve).not.toHaveBeenCalled()
    expect(p.api().reject).not.toHaveBeenCalled()
    fireEvent.click(b('Apply')!)
    expect(p.api().approve).toHaveBeenCalledWith('p')
    fireEvent.click(b('Reject')!)
    expect(p.api().reject).toHaveBeenCalledWith('p')
  })

  it('a new card in the same place starts its own 500 ms, and opening the panel does too', () => {
    const p = panel()
    wait()
    p.set({ cards: [card({}, proposal({ id: 'q' }))] })
    expect(b('Apply')!.disabled).toBe(true)
    wait()
    expect(b('Apply')!.disabled).toBe(false)
    p.set({}, false)
    wait(5000)
    p.set({}, true)
    expect(b('Apply')!.disabled).toBe(true)
    wait()
    expect(b('Apply')!.disabled).toBe(false)
  })

  it('Undo that takes the place of Apply waits as well, so a double-click doesn’t undo', () => {
    const p = panel()
    wait()
    p.set({ cards: [card({ state: 'applied' })] })
    expect(b('Undo')!.disabled).toBe(true)
    wait()
    fireEvent.click(b('Undo')!)
    expect(p.api().undo).toHaveBeenCalledWith('p')
  })

  it('Enter in the message box doesn’t apply, with or without Ctrl, nor a held Enter on the button', () => {
    const p = panel()
    wait()
    fireEvent.change(box(), { target: { value: 'go on' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    b('Apply')!.focus()
    expect(fireEvent.keyDown(b('Apply')!, { key: 'Enter', repeat: true })).toBe(false)
    expect(fireEvent.keyDown(b('Apply')!, { key: ' ', repeat: true })).toBe(false)
    expect(fireEvent.keyDown(b('Apply')!, { key: 'Enter' })).toBe(true)
    expect(p.api().approve).not.toHaveBeenCalled()
    expect(p.api().send).not.toHaveBeenCalled()
  })

  it('gives the focus to the box when the buttons go away', () => {
    const p = panel()
    wait()
    act(() => b('Apply')!.focus())
    p.set({ cards: [card({ state: 'applying' })] })
    expect(b('Apply')).toBeNull()
    expect(document.activeElement).toBe(box())
  })

  it('more than 200 lines are folded, over all fields; Apply waits until the rest was shown', () => {
    const fields = [{ label: 'Docs', lines: many(150) }, { label: 'Body', lines: many(190) }]
    panel({ cards: [card({}, proposal({ fields }))] })
    wait()
    expect(document.querySelectorAll('.aiLine')).toHaveLength(200)
    expect(b('Apply')!.disabled).toBe(true)
    expect(b('Reject')!.disabled).toBe(false)
    act(() => b('Show all 340 lines')!.focus())
    fireEvent.click(b('Show all 340 lines')!)
    expect(document.querySelectorAll('.aiLine')).toHaveLength(340)
    expect(b(/^Show all/)).toBeNull()
    expect(document.activeElement).toBe(cards()[0])
    expect(b('Apply')!.disabled).toBe(true) // moved under the pointer
    wait()
    expect(b('Apply')!.disabled).toBe(false)
  })

  it('200 lines aren’t folded', () => {
    panel({ cards: [card({}, proposal({ fields: [{ label: 'Body', lines: many(200) }] }))] })
    wait()
    expect(b(/^Show all/)).toBeNull()
    expect(b('Apply')!.disabled).toBe(false)
  })

  it('a delete says Delete, looks like it, and says how long it can be undone', () => {
    const p = panel({ cards: [card({}, deletion())] })
    wait()
    expect(b('Apply')).toBeNull()
    expect(b('Delete')!.className).toContain('danger')
    expect(cards()[0].textContent).toContain('You can undo this until Dispatch closes.')
    fireEvent.click(b('Delete')!)
    expect(p.api().approve).toHaveBeenCalledWith('p')
  })

  it('closing the panel decides nothing', () => {
    const p = panel()
    wait()
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(p.onClose).toHaveBeenCalled()
    p.set({}, false)
    for (const f of [p.api().approve, p.api().reject, p.api().stop]) expect(f).not.toHaveBeenCalled()
  })
})

describe('what came of it', () => {
  const WHY = 'This changed meanwhile, so nothing was applied.'
  it.each([['rejected', 'Rejected', undefined], ['expired', WHY, WHY], ['stopped', 'Stopped', undefined], ['undone', 'Undone', undefined], ['applying', 'Applying…', undefined]] as const)('%s: its words and no buttons', (state, words, text) => {
    panel({ cards: [card({ state, ...(text ? { text } : {}) })] })
    wait()
    expect(cards()[0].textContent).toContain(words)
    expect(within(cards()[0]).queryAllByRole('button')).toEqual([])
  })

  it('a long one that ended can still be shown whole, but not decided', () => {
    panel({ cards: [card({ state: 'rejected' }, proposal({ fields: [{ label: 'Body', lines: many(340) }] }))] })
    expect(within(cards()[0]).getAllByRole('button').map((x) => x.textContent)).toEqual(['Show all 340 lines'])
  })

  it('applied offers Undo; a refused undo says why and what is different now', () => {
    const p = panel({ cards: [card({ state: 'applied' })] })
    expect(cards()[0].textContent).toContain('Applied')
    p.set({ cards: [card({ state: 'applied', text: 'This changed meanwhile, so nothing was undone.', now: [{ label: 'Name', lines: [{ type: 'del', text: 'Create order' }, { type: 'add', text: 'Mine' }] }] })] })
    const c = cards()[0]
    expect(c.textContent).toContain('This changed meanwhile, so nothing was undone.')
    expect(c.textContent).toContain('Since it was applied')
    expect([...c.querySelectorAll('.aiLine')].slice(-2).map((x) => x.textContent)).toEqual(['−removed: Create order', '+added: Mine'])
    expect(said()).toContain('This changed meanwhile, so nothing was undone.')
    expect(b('Undo')).not.toBeNull()
  })

  it('a stop says what stays', () => {
    const STAYS = 'Changes you already applied stay. Use Undo on their cards.'
    const p = panel({ status: 'answering', cards: [card({ state: 'applied' })] })
    p.set({ status: 'idle', ended: 'stopped', chat: asked() as AssistantApi['chat'] })
    expect(screen.getByRole('group', { name: 'Conversation' }).textContent).toContain(STAYS)
    expect(said()).toContain(STAYS)
    p.unmount()
    panel({ status: 'idle', ended: 'stopped', cards: [card({ state: 'rejected' })] })
    expect(document.body.textContent).not.toContain(STAYS)
  })
})

describe('hearing of it', () => {
  it('is announced once, not again when the panel is drawn or opened again', () => {
    const p = panel({ cards: [] })
    p.set({ cards: [card()] })
    const words = 'The assistant proposes a change to Create order. Apply or reject it in the panel.'
    expect(said()).toBe(words)
    p.set({ streamed: 'x' })
    expect(said()).toBe(words)
    p.set({}, false)
    p.set({ cards: [card()] }, true)
    expect(said()).toBe('')
  })

  it('one that came while the panel was closed is announced when it opens', () => {
    const p = panel({ cards: [] })
    p.set({ cards: [card({}, deletion())] }, false)
    expect(said()).toBe('')
    p.set({}, true)
    expect(said()).toBe('The assistant proposes to delete Create order. Delete or reject it in the panel.')
  })

  it('the spinner doesn’t turn while the person is waited for', () => {
    panel({ tools: [{ id: 1, name: 'update_request', input: { name: 'Create order' }, state: 'running', at: 0 }] })
    expect(document.querySelector('.aiTool .spin')).toBeNull()
  })

  it('with the panel closed the icon says that it waits', () => {
    const slot = document.createElement('div')
    document.body.append(slot)
    fake.a = api()
    const el = (open: boolean) => <AssistantHost ws={ws} slot={slot} open={open} onOpen={() => {}} />
    const r = render(el(false))
    expect(within(slot).getByRole('button', { name: 'Assistant, waiting for you' })).toBeTruthy()
    fake.a = api({ cards: [card({ state: 'applied' })] })
    r.rerender(el(false))
    expect(within(slot).getByRole('button', { name: 'Assistant, answering' })).toBeTruthy()
    r.unmount(); slot.remove()
  })
})

describe('round 1', () => {
  const node = () => screen.getByTestId('assistant-said').firstElementChild
  it('a second proposal with the same title is announced as something new', () => {
    const p = panel({ cards: [card()] })
    const first = node(), words = said()
    expect(first).not.toBeNull()
    p.set({ cards: [card({ state: 'rejected' })] })
    p.set({ cards: [card({ state: 'rejected' }), card({}, proposal({ id: 'q' }))] })
    expect(said()).toBe(words)
    expect(node()).not.toBe(first)
  })

  it('so is the same refused undo, but not a drawing of the panel', () => {
    const p = panel({ cards: [card({ state: 'applied' })] })
    const no = () => card({ state: 'applied', text: 'This changed meanwhile, so nothing was undone.' })
    p.set({ cards: [no()] })
    const first = node()
    p.set({ streamed: 'x' })
    expect(node()).toBe(first)
    p.set({ cards: [no()] })
    expect(said()).toBe('This changed meanwhile, so nothing was undone.')
    expect(node()).not.toBe(first)
  })

  it('a warning is never cut', () => {
    const w = `Its sign-in would go to a new address: ${'a.'.repeat(3000)}evil.test.`
    panel({ cards: [card({}, proposal({ warnings: [w] }))] })
    expect(cards()[0].querySelector('.aiRisks li')!.textContent).toBe(w)
  })

  it('very long warnings count in the fold: Apply waits until they were shown whole', () => {
    const w = `Uses {{${'x'.repeat(30_000)}}}, which is secret.`
    panel({ cards: [card({}, proposal({ warnings: [RISK, w] }))] })
    wait()
    expect(cards()[0].textContent).toContain(RISK)
    expect(b('Apply')!.disabled).toBe(true)
    fireEvent.click(b(/^Show all [\d,]+ characters$/)!)
    expect(cards()[0].querySelectorAll('.aiRisks li')[1].textContent).toBe(w)
    wait()
    expect(b('Apply')!.disabled).toBe(false)
  })

  it('a pile of combining marks shows as codes, and a line paints nothing outside itself', () => {
    expect(oneLine('e\u0301')).toBe('e\u0301')
    expect(oneLine(`a${'\u0336'.repeat(4)}`)).toBe(`a${'\u0336'.repeat(4)}`)
    expect(oneLine(`a${'\u0336'.repeat(7)}b`)).toBe(`a${'\u0336'.repeat(4)}${'\\u{336}'.repeat(3)}b`)
    const css = readFileSync('src/ui/app.css', 'utf8')
    expect(/\.aiLine \{[^}]*overflow: clip/.test(css)).toBe(true)
    expect(/\.aiCard :is\(h3, h4, p, li\) \{[^}]*overflow: clip/.test(css)).toBe(true)
  })

  it('Undo waits again when a refused undo’s difference comes or is opened above it', () => {
    const p = panel({ cards: [card({ state: 'applied' })] })
    wait()
    expect(b('Undo')!.disabled).toBe(false)
    p.set({ cards: [card({ state: 'applied', text: 'No.', now: [{ label: 'Body', lines: many(6000) }] })] })
    expect(b('Undo')!.disabled).toBe(true)
    wait()
    expect(b('Undo')!.disabled).toBe(false)
    fireEvent.click(b('Show all 6,000 lines')!)
    expect(b('Undo')!.disabled).toBe(true)
    wait(40); wait(40); wait(400)
    expect(b('Undo')!.disabled).toBe(true) // the last part came less than 500 ms ago
    wait(200)
    expect(b('Undo')!.disabled).toBe(false)
  })
})

describe('the rest of the panel', () => {
  it('says what it can do', () => {
    panel()
    expect(document.querySelector('.aiNote')!.textContent).toBe('It can read, and propose changes. Nothing changes until you apply it. It can’t send or run anything.')
  })

  it('asks what the help is for only where there is little room', () => {
    const p = panel()
    expect(screen.queryByRole('combobox', { name: 'Help with' })).toBeNull()
    p.set({ connection: local({ contextTokens: 16_000 }) })
    expect(screen.queryByRole('combobox', { name: 'Help with' })).toBeNull()
    p.set({ connection: local({ contextTokens: 8192 }) })
    const s = screen.getByRole('combobox', { name: 'Help with' }) as HTMLSelectElement
    expect([...s.options].map((o) => o.textContent)).toEqual(['Questions', 'Scripts and variables'])
    expect(s.value).toBe('ask')
    fireEvent.change(s, { target: { value: 'scripts' } })
    expect(p.api().setJob).toHaveBeenCalledWith('scripts')
  })

  it('a reopened chat says what was proposed, and whether it was not applied, without buttons', () => {
    const call = (id: string, name: string, args: object) => ({ id, function: { name, arguments: JSON.stringify(args) } })
    const edit = call('c0', 'update_request', { name: 'Shop/Create order' })
    const chat = [
      { role: 'user', content: 'a' }, { role: 'assistant', content: '', tool_calls: [edit, call('c1', 'delete_request', { name: 'Old' })] },
      { role: 'tool', tool_call_id: 'c0', content: 'Error: Data from the workspace…' }, { role: 'tool', tool_call_id: 'c1', content: 'Data from the workspace…' },
      // some servers use the same ids again
      { role: 'assistant', content: '', tool_calls: [edit] }, { role: 'tool', tool_call_id: 'c0', content: 'Data from the workspace…' }, { role: 'assistant', content: 'Done' },
    ]
    panel({ status: 'idle', cards: [], chat: asked(chat) as AssistantApi['chat'] })
    expect([...document.querySelectorAll('.aiTool')].map((x) => x.textContent)).toEqual(['Proposed a change to Create order (not applied)', 'Proposed to delete Old', 'Proposed a change to Create order'])
    expect(b(/Apply|Undo|Reject|Delete$/)).toBeNull()
    const anthropic = [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'set_scripts', input: { path: 'Orders/Admin' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'x' }] }]
    expect(items(anthropic)[1]).toMatchObject({ text: 'Proposed a change to Admin', state: 'failed' })
  })

  it.each([
    ['create_request', { name: 'New' }, 'Proposed a new request New'], ['copy_request', { from: 'A/B', to: 'C' }, 'Proposed a copy of B'], ['move_request', { name: 'A/B', to: 'C' }, 'Proposed to move B'],
    ['delete_request', { name: 'A/B' }, 'Proposed to delete B'], ['set_variables', { collection: 'Shop' }, 'Proposed a change to Shop'], ['apply_parameters', { name: 'A/B' }, 'Proposed a change to B'],
    ['set_environment_variables', {}, 'Proposed a change to the environment'], ['update_request', {}, 'Proposed a change to a request'], ['suggest_parameters', { name: 'B' }, 'Looked for values to parameterize in B'],
  ])('%s in plain words', (name, input, text) => { expect(toolLine(name, input)).toBe(text) })

  it('turns are the messages from one question to the next', () => {
    expect(turns([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] }, { role: 'user', content: 'c' }]).map((t) => [t.start, t.items.length])).toEqual([[0, 2], [3, 1]])
    expect(turns('x')).toEqual([])
  })
})
