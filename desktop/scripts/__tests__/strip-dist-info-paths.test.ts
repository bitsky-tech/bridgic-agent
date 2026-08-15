/**
 * Tests for scripts/strip-dist-info-paths.ts.
 *
 * Two invariants, pulling in opposite directions:
 *  - `direct_url.json` MUST go (it carries the build machine's absolute path)
 *  - everything else in `.dist-info` MUST stay (METADATA and licenses/ are the
 *    inputs THIRD-PARTY-LICENSES.txt is generated from)
 *
 * A "cleanup" that removed the whole directory would satisfy the first and
 * silently break the second, leaving the shipped license file missing its
 * entire Python section.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripDistInfoPaths } from '../strip-dist-info-paths'

let tmpDirs: string[] = []

/** Build a payload that mirrors the real `resources/bin` layout. */
function payload(specs: ReadonlyArray<{ dist: string; directUrl?: boolean }>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'strip-dist-info-test-'))
  tmpDirs.push(root)
  const internal = path.join(root, '_internal')
  mkdirSync(internal, { recursive: true })
  for (const spec of specs) {
    const dir = path.join(internal, spec.dist)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'METADATA'), 'Name: pkg\nVersion: 1.0.0\nLicense-Expression: MIT\n')
    if (spec.directUrl === true) {
      writeFileSync(
        path.join(dir, 'direct_url.json'),
        '{"url":"file:///Users/someone/Desktop/AmphiAgent-02","dir_info":{}}',
      )
    }
  }
  return root
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

describe('stripDistInfoPaths', () => {
  it('removes direct_url.json and reports the count', () => {
    const root = payload([
      { dist: 'bridgic_agent-0.1.5.dist-info', directUrl: true },
      { dist: 'requests-2.34.2.dist-info' },
    ])
    expect(stripDistInfoPaths(root)).toBe(1)
    expect(existsSync(path.join(root, '_internal/bridgic_agent-0.1.5.dist-info/direct_url.json'))).toBe(
      false,
    )
  })

  it('keeps METADATA — the license generator reads it', () => {
    // The reason this cleanup is surgical rather than an rm -rf of .dist-info.
    const root = payload([{ dist: 'bridgic_agent-0.1.5.dist-info', directUrl: true }])
    stripDistInfoPaths(root)
    expect(existsSync(path.join(root, '_internal/bridgic_agent-0.1.5.dist-info/METADATA'))).toBe(true)
  })

  it('leaves non dist-info directories untouched', () => {
    const root = payload([{ dist: 'requests-2.34.2.dist-info' }])
    const other = path.join(root, '_internal/playwright')
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, 'direct_url.json'), 'not a dist-info')
    expect(stripDistInfoPaths(root)).toBe(0)
    expect(existsSync(path.join(other, 'direct_url.json'))).toBe(true)
  })

  it('returns 0 when there is no _internal payload', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'strip-dist-info-test-'))
    tmpDirs.push(root)
    expect(stripDistInfoPaths(root)).toBe(0)
  })

  it('is idempotent', () => {
    const root = payload([{ dist: 'bridgic_agent-0.1.5.dist-info', directUrl: true }])
    expect(stripDistInfoPaths(root)).toBe(1)
    expect(stripDistInfoPaths(root)).toBe(0)
  })
})
