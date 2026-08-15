/**
 * Tests for scripts/check-doc-links.ts.
 *
 * The case that matters most is the wrong-depth relative path: the filename is
 * correct, so every grep-based check passes it, and only resolving against the
 * referring file's own directory exposes it. That is exactly how
 * `canSendNow.ts` shipped a six-level `../` where seven were needed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findDeadLinks } from '../check-doc-links'

let tmpDirs: string[] = []

/** Build `<root>/a/b/c/referrer` plus a real `<root>/docs/SERVER_API.md`. */
function fixture(): { root: string; referrer: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'doc-links-test-'))
  tmpDirs.push(root)
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  writeFileSync(path.join(root, 'docs/SERVER_API.md'), '# api\n')
  mkdirSync(path.join(root, 'a/b/c'), { recursive: true })
  return { root, referrer: path.join(root, 'a/b/c/referrer.ts') }
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

describe('findDeadLinks', () => {
  it('flags a relative path with too few ../ segments', () => {
    // Two levels lands on `a/docs/`, three is correct. The filename is right in
    // both cases — this is the failure no filename-matching check can see.
    const { referrer } = fixture()
    const dead = findDeadLinks(referrer, ' * see ../../docs/SERVER_API.md\n', false)
    expect(dead).toHaveLength(1)
    expect(dead[0]?.target).toBe('../../docs/SERVER_API.md')
  })

  it('accepts the correct depth', () => {
    const { referrer } = fixture()
    expect(findDeadLinks(referrer, ' * see ../../../docs/SERVER_API.md\n', false)).toEqual([])
  })

  it('resolves against the referring file, not the cwd', () => {
    // A path that would resolve from the repo root but not from this file.
    const { referrer } = fixture()
    expect(findDeadLinks(referrer, ' * see ../docs/SERVER_API.md\n', false)).toHaveLength(1)
  })

  it('leaves bare mentions alone', () => {
    // "backend docs/SERVER_API.md" names a file in another repository; it is not
    // a path relative to here. Nine comments use that shorthand deliberately.
    const { referrer } = fixture()
    expect(findDeadLinks(referrer, ' * Contract: backend docs/SERVER_API.md\n', false)).toEqual([])
  })

  it('checks markdown links only in markdown files', () => {
    const { root } = fixture()
    const readme = path.join(root, 'README.md')
    const body = '[gone](./docs/nope.md)\n'
    expect(findDeadLinks(readme, body, true)).toHaveLength(1)
    expect(findDeadLinks(readme, body, false)).toEqual([])
  })

  it('ignores external targets', () => {
    const { root } = fixture()
    const body = '[a](https://example.com) [b](mailto:x@y.z) [c](#anchor)\n'
    expect(findDeadLinks(path.join(root, 'README.md'), body, true)).toEqual([])
  })

  it('strips a trailing anchor before resolving', () => {
    const { root } = fixture()
    const body = '[api](docs/SERVER_API.md#section-7)\n'
    expect(findDeadLinks(path.join(root, 'README.md'), body, true)).toEqual([])
  })

  it('reports the line number so the failure is actionable', () => {
    const { referrer } = fixture()
    const dead = findDeadLinks(referrer, 'line one\nline two\n * ../../nope.md\n', false)
    expect(dead[0]?.line).toBe(3)
  })
})
