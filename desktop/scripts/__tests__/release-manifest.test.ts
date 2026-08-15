/**
 * Tests for scripts/release-manifest.ts.
 *
 * Covers:
 *  - matching versions → the exact packaged shape
 *  - drift between desktop and backend → throws (this is the case that would
 *    otherwise block every user at the startup gate while CI stayed green)
 *  - non-`x.y.z` versions → throws, on both sides
 *  - __version__ extraction from a realistic src/__init__.py
 *  - atomic write leaves parseable JSON at the target path
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RELEASE_MANIFEST_SCHEMA,
  buildReleaseManifest,
  parseBackendVersion,
  writeReleaseManifest,
} from '../release-manifest'

let tmpDirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'release-manifest-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

describe('buildReleaseManifest', () => {
  it('produces the packaged shape when both versions match', () => {
    expect(buildReleaseManifest({ desktopVersion: '0.1.0', backendVersion: '0.1.0' })).toEqual({
      schema: RELEASE_MANIFEST_SCHEMA,
      desktopVersion: '0.1.0',
      requiredBackendVersion: '0.1.0',
    })
  })

  it('throws when desktop and backend versions drift', () => {
    expect(() =>
      buildReleaseManifest({ desktopVersion: '0.1.0', backendVersion: '0.1.1' }),
    ).toThrow('Desktop and backend release versions must match')
  })

  it('rejects a non dotted-numeric desktop version', () => {
    expect(() => buildReleaseManifest({ desktopVersion: '0.1', backendVersion: '0.1' })).toThrow(
      'Desktop version must be dotted numeric',
    )
  })

  it('rejects a pre-release suffix', () => {
    // P0 compatibility is exact string equality, so `1.0.0-beta.1` would never
    // match a daemon reporting `1.0.0` even though they are the same release.
    expect(() =>
      buildReleaseManifest({ desktopVersion: '1.0.0-beta.1', backendVersion: '1.0.0-beta.1' }),
    ).toThrow('dotted numeric')
  })

  it('validates the BACKEND version independently of the desktop one', () => {
    // Every other negative case passes an invalid value on both sides, and
    // `assertVersion('Desktop', …)` runs first — so deleting the backend
    // assertion entirely left the whole suite green. A backend `0.1.0-rc1` would
    // then reach the manifest, and the exact-string gate would block every user
    // against a daemon reporting `0.1.0`.
    expect(() =>
      buildReleaseManifest({ desktopVersion: '0.1.0', backendVersion: '0.1.0-rc1' }),
    ).toThrow('Backend version must be dotted numeric')
  })
})

describe('parseBackendVersion', () => {
  it('refuses two module-level assignments rather than guessing', () => {
    // A docstring example at column 0 satisfies the `^` anchor. Taking the first
    // match would bake that version into the manifest, and per this module's own
    // header that blocks 100% of users while CI stays green.
    const source = ['"""', 'Example:', '__version__ = "9.9.9"', '"""', '__version__ = "0.1.0"'].join(
      '\n',
    )
    expect(() => parseBackendVersion(source)).toThrow('2 module-level __version__')
  })

  it('does not swallow across lines on a bare annotation', () => {
    const source = ['__version__: Final[str]', '# note', 'FOO = "bar"'].join('\n')
    expect(() => parseBackendVersion(source)).toThrow('Could not find __version__')
  })

  it('extracts __version__ from a realistic module header', () => {
    const source = [
      '"""Package root."""',
      '',
      'from __future__ import annotations',
      '',
      '__version__ = "1.2.3"',
      '',
      '__all__ = ["__version__"]',
      '',
    ].join('\n')
    expect(parseBackendVersion(source)).toBe('1.2.3')
  })

  it('accepts single quotes', () => {
    expect(parseBackendVersion("__version__ = '0.9.0'\n")).toBe('0.9.0')
  })

  it('ignores a commented-out or indented lookalike', () => {
    // Anchored to line start so a docstring example or an attribute assignment
    // inside a class body cannot win over the real module-level constant.
    const source = ['#  __version__ = "9.9.9"', '    __version__ = "8.8.8"', '__version__ = "0.1.0"'].join(
      '\n',
    )
    expect(parseBackendVersion(source)).toBe('0.1.0')
  })

  it('throws with an actionable message when the constant is gone', () => {
    expect(() => parseBackendVersion('# nothing here\n')).toThrow('Could not find __version__')
  })
})

describe('writeReleaseManifest', () => {
  it('writes parseable JSON and leaves no temp file behind', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'nested', 'release-manifest.json')
    const manifest = buildReleaseManifest({ desktopVersion: '2.0.0', backendVersion: '2.0.0' })

    writeReleaseManifest(manifest, target)

    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual(manifest)
    expect(readdirSync(path.join(dir, 'nested'))).toEqual(['release-manifest.json'])
  })
})
