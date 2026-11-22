/** Linked folders, phase 2: deciding what came in from a folder (src/core/folderMerge.ts). */
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { applyIncoming, describeIncoming, isCopyName, planIncoming, textHash } from '../src/core/folderMerge'

const id = (t: string) => t // the test's "hash" is the text itself
const disk = (files: Record<string, string>) => Object.entries(files).map(([path, text]) => ({ path, text, hash: text }))
const plan = (d: Record<string, string>, app: Record<string, string>, known: Record<string, string>, take?: string[]) =>
  planIncoming(disk(d), Object.entries(app).map(([path, text]) => ({ path, text })), known, id, { parse, take: take && new Set(take) })

describe('textHash', () => {
  it('matches the desktop side (text_hash in lib.rs) byte for byte', () => {
    expect(textHash('')).toBe('cbf29ce484222325')
    expect(textHash('dispatch')).toBe('4592850c14d1d82b')
    expect(textHash('id: a\nname: Café ✈\n')).toBe('117831fc4b033caa')
  })
})

describe('isCopyName', () => {
  it('spots copies made by cloud drives, sync tools and file managers', () => {
    for (const p of ["collections/shop/orders (Laptop's conflicted copy).req.yaml", 'environments/staging.sync-conflict-20261122-101010-ABC.env.yaml',
      'flows/smoke - Copy.flow.yaml', 'flows/Copy of smoke.flow.yaml', 'environments/staging (1).env.yaml']) expect(isCopyName(p)).toBe(true)
    for (const p of ['collections/shop/orders.req.yaml', 'flows/get-conflict-list.flow.yaml', 'environments/copy-files.env.yaml', 'flows/conflict-resolution.flow.yaml']) expect(isCopyName(p)).toBe(false)
  })
})

describe('planIncoming', () => {
  it('takes in what changed only in the folder, and leaves what changed only in the app to be written', () => {
    const p = plan({ 'a.req.yaml': 'id: a\nv: 2', 'b.req.yaml': 'id: b\nv: 1' }, { 'a.req.yaml': 'id: a\nv: 1', 'b.req.yaml': 'id: b\nv: 9' }, { 'a.req.yaml': 'id: a\nv: 1', 'b.req.yaml': 'id: b\nv: 1' })
    expect(p.incoming).toEqual([{ path: 'a.req.yaml', text: 'id: a\nv: 2' }])
    expect(p.conflicts).toEqual([])
  })
  it('takes in files added and deleted in the folder', () => {
    const p = plan({ 'new.req.yaml': 'id: n' }, { 'old.req.yaml': 'id: o' }, { 'old.req.yaml': 'id: o' })
    expect(p.incoming).toEqual([{ path: 'new.req.yaml', text: 'id: n' }, { path: 'old.req.yaml', text: null }])
  })
  it('treats a file renamed in the folder as a rename, not a copy', () => {
    const p = plan({ 'renamed.req.yaml': 'id: a\nname: Renamed' }, { 'a.req.yaml': 'id: a\nname: A' }, { 'a.req.yaml': 'id: a\nname: A' })
    expect(p.copies).toEqual([])
    expect(p.incoming.map((f) => f.path)).toEqual(['a.req.yaml', 'renamed.req.yaml'])
  })
  it('sets copies aside: by name, or a new file carrying the id of a file still there', () => {
    const p = plan({ 'a.req.yaml': 'id: a', "a (Laptop's conflicted copy).req.yaml": 'id: a\nv: 2', 'a-laptop.req.yaml': 'id: a\nv: 3' }, { 'a.req.yaml': 'id: a' }, { 'a.req.yaml': 'id: a' })
    expect(p.copies).toEqual(["a (Laptop's conflicted copy).req.yaml", 'a-laptop.req.yaml'])
    expect(p.incoming).toEqual([])
  })
  it('reports a conflict when both sides changed, and agrees when they changed the same way', () => {
    const p = plan({ 'a.req.yaml': 'id: a\nv: folder', 'b.req.yaml': 'id: b\nv: same' }, { 'a.req.yaml': 'id: a\nv: app', 'b.req.yaml': 'id: b\nv: same' }, { 'a.req.yaml': 'id: a', 'b.req.yaml': 'id: b' })
    expect(p.conflicts).toEqual(['a.req.yaml'])
    expect(p.adopt).toEqual({ 'b.req.yaml': 'id: b\nv: same' })
  })
  it('"use the file’s version" takes a file in even when the app changed it too', () => {
    const p = plan({ 'a.req.yaml': 'id: a\nv: folder' }, { 'a.req.yaml': 'id: a\nv: app' }, { 'a.req.yaml': 'id: a' }, ['a.req.yaml'])
    expect(p.incoming).toEqual([{ path: 'a.req.yaml', text: 'id: a\nv: folder' }])
    expect(p.conflicts).toEqual([])
  })
  it('keeps unreadable files (git conflict markers) out, with the reason', () => {
    const broken = 'id: a\n<<<<<<< HEAD\nv: 1\n=======\nv: 2\n>>>>>>> main\n'
    const p = plan({ 'a.req.yaml': broken }, { 'a.req.yaml': 'id: a' }, { 'a.req.yaml': 'id: a' })
    expect(p.incoming).toEqual([])
    expect(p.unreadable.map((u) => u.path)).toEqual(['a.req.yaml'])
    expect(p.unreadable[0].error).toBeTruthy()
  })
})

describe('applyIncoming and describeIncoming', () => {
  it('applies added, changed and removed files and says what they were', () => {
    const inc = [{ path: 'a.req.yaml', text: 'v2' }, { path: 'e.env.yaml', text: null }, { path: 'f.flow.yaml', text: 'f' }, { path: 'b.req.yaml', text: 'b' }]
    expect(applyIncoming([{ path: 'a.req.yaml', text: 'v1' }, { path: 'e.env.yaml', text: 'e' }], inc).sort((x, y) => x.path.localeCompare(y.path)))
      .toEqual([{ path: 'a.req.yaml', text: 'v2' }, { path: 'b.req.yaml', text: 'b' }, { path: 'f.flow.yaml', text: 'f' }])
    expect(describeIncoming(inc)).toBe('2 requests, 1 environment, 1 flow')
  })
})
