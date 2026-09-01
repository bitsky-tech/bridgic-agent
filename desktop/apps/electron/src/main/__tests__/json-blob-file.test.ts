/**
 * Tests for main/json-blob-file.ts — the shared per-session blob store behind
 * drafts / spec-comments / input-history.
 *
 * Path-injected (no Electron) like python-client/runtime-file.test.ts: each
 * test writes to its own temp dir. Covers the round-trip, the never-throw
 * fallbacks (missing / corrupt / non-object file → {}), and the atomic write.
 *
 * This test originally covered only drafts, while the duplicated spec-comments implementation
 * had no coverage. After consolidating all three behind one implementation, every assertion
 * here protects all three blobs.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonBlob, writeJsonBlob } from '../json-blob-file'

let tmpDirs: string[] = []

function tmpPath(name = 'blob.json'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'json-blob-test-'))
  tmpDirs.push(dir)
  return path.join(dir, name)
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  tmpDirs = []
})

describe('json-blob round-trip', () => {
  it('writes then reads back the same map (incl. @ mention segments)', () => {
    const file = tmpPath()
    const drafts = {
      's1': [
        { type: 'text', value: '看 ' },
        { type: 'mention', id: 'm', label: 'doc.md', group: '文件/文件夹', path: 'a/doc.md' },
      ],
      's2': [{ type: 'text', value: 'hi' }],
    }
    writeJsonBlob(drafts, file)
    expect(readJsonBlob(file, 'test')).toEqual(drafts)
  })

  it('persists as a single JSON object on disk', () => {
    const file = tmpPath()
    writeJsonBlob({ a: [{ type: 'text', value: 'x' }] }, file)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.a).toEqual([{ type: 'text', value: 'x' }])
  })

  it('round-trips nested arrays (input-history stores Segment[][])', () => {
    // Input-history values are one level deeper than drafts: each session stores an array of entries.
    const file = tmpPath()
    const history = {
      's1': [[{ type: 'text', value: '第二条' }], [{ type: 'text', value: '第一条' }]],
    }
    writeJsonBlob(history, file)
    expect(readJsonBlob(file, 'test')).toEqual(history)
  })

  it('creates the parent directory when missing', () => {
    const file = path.join(tmpPath(), 'nested', 'deep', 'blob.json')
    writeJsonBlob({ a: 1 }, file)
    expect(readJsonBlob(file, 'test')).toEqual({ a: 1 })
  })

  it('leaves no .tmp file behind (atomic write completed)', () => {
    const file = tmpPath()
    writeJsonBlob({ a: 1 }, file)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
})

describe('json-blob never throws', () => {
  it('missing file → {}', () => {
    expect(readJsonBlob(path.join(os.tmpdir(), 'nope-does-not-exist.json'), 'test')).toEqual({})
  })

  it('corrupt JSON → {}', () => {
    const file = tmpPath()
    writeFileSync(file, '{ not json', 'utf-8')
    expect(readJsonBlob(file, 'test')).toEqual({})
  })

  it('non-object JSON (array) → {}', () => {
    // JSON.parse('[]') is an object, but an array is invalid for map semantics and must be rejected.
    const file = tmpPath()
    writeFileSync(file, '[1,2,3]', 'utf-8')
    expect(readJsonBlob(file, 'test')).toEqual({})
  })

  it('null JSON → {}', () => {
    const file = tmpPath()
    writeFileSync(file, 'null', 'utf-8')
    expect(readJsonBlob(file, 'test')).toEqual({})
  })
})
