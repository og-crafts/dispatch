import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { VERSION } from '../src/core/version'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version as string

describe('version', () => {
  it('comes from package.json, so the CLI and the MCP client need no hand bump', () => {
    expect(VERSION).toBe(pkg)
    for (const f of ['src/cli/main.ts', 'src/core/mcp.ts']) expect(readFileSync(f, 'utf8')).not.toMatch(/['"]\d+\.\d+\.\d+['"]/)
  })
  it('is the same in every file a release bumps', () => {
    expect(JSON.parse(readFileSync('package-lock.json', 'utf8')).version).toBe(pkg)
    expect(JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version).toBe(pkg)
    expect(readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^\[package\][^[]*?^version = "([^"]+)"/ms)?.[1]).toBe(pkg)
    const lock = readFileSync('src-tauri/Cargo.lock', 'utf8').match(/name = "dispatch"\nversion = "([^"]+)"/)?.[1]
    expect(lock).toBe(pkg)
    expect(readFileSync('docs/TESTING-WINDOWS.md', 'utf8').split('\n')[0]).toContain(pkg)
  })
})
