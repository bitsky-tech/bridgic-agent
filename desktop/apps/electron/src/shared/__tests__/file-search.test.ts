/**
 * Tests for the shared tiered fuzzy scorer (used by the main-process
 * fs.searchDir walker). Includes the user-supplied `aaa` subsequence case.
 */
import { describe, expect, test } from 'bun:test'
import { searchEntries, type FileSearchEntry } from '../file-search'

function entry(partial: Partial<FileSearchEntry> & { name: string }): FileSearchEntry {
  return {
    kind: 'file',
    relPath: partial.name,
    crumb: ['mount'],
    sizeBytes: 1,
    mountId: 'm',
    mountName: 'mount',
    ...partial,
  }
}

describe('searchEntries — tiers', () => {
  test('name-prefix beats name-substring beats name-subsequence beats path matches', () => {
    const entries = [
      entry({ name: 'x-gao.txt' }), // T1 substring
      entry({ name: 'gao.txt' }), // T0 prefix
      entry({ name: 'g-a-o.txt' }), // T2 subsequence
      entry({ name: 'plain.txt', crumb: ['mount', 'gao-dir'], relPath: 'gao-dir/plain.txt' }), // T3 path substring
    ]
    const { hits } = searchEntries(entries, 'gao')
    expect(hits.map((h) => h.name)).toEqual(['gao.txt', 'x-gao.txt', 'g-a-o.txt', 'plain.txt'])
    expect(hits[0]?.nameRanges).toEqual([[0, 3]])
    expect(hits[3]?.crumbRanges.length).toBeGreaterThan(0)
  })

  test('`aaa` hits cli-sdk-api-mapping.md through path subsequence (user spec)', () => {
    const e = entry({
      name: 'cli-sdk-api-mapping.md',
      crumb: ['repo', '.agents', 'skills', 'bridgic-browser', 'references'],
      relPath: '.agents/skills/bridgic-browser/references/cli-sdk-api-mapping.md',
    })
    const direct = entry({ name: 'aaa-notes.txt' })
    const { hits, total } = searchEntries([e, direct], 'aaa')
    expect(total).toBe(2)
    // The direct name hit outranks the scattered path hit.
    expect(hits.map((h) => h.name)).toEqual(['aaa-notes.txt', 'cli-sdk-api-mapping.md'])
  })

  test('hidden entries rank after normal ones within the same tier', () => {
    const hidden = entry({
      name: 'config.md',
      relPath: '.claude/config.md',
      crumb: ['mount', '.claude'],
    })
    const normal = entry({ name: 'config.md', relPath: 'docs/config.md', crumb: ['mount', 'docs'] })
    const { hits } = searchEntries([hidden, normal], 'config')
    expect(hits[0]?.relPath).toBe('docs/config.md')
    expect(hits[1]?.relPath).toBe('.claude/config.md')
  })

  test('caps at limit but reports real total', () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry({ name: `match-${i}.txt` }))
    const { hits, total } = searchEntries(entries, 'match')
    expect(hits.length).toBe(50)
    expect(total).toBe(60)
  })

  test('NFD filename matches NFC query (macOS normalization)', () => {
    const nfdName = 'café.txt' // "café" as stored by macOS (NFD: e + combining ´)
    const nfcQuery = 'café'
    const { hits } = searchEntries([entry({ name: nfdName })], nfcQuery)
    expect(hits.length).toBe(1)
  })

  test('empty query → no hits (browse mode is the caller`s job)', () => {
    expect(searchEntries([entry({ name: 'a' })], '  ')).toEqual({ hits: [], total: 0 })
  })

  test('no match → empty with zero total', () => {
    const { hits, total } = searchEntries([entry({ name: 'abc.txt' })], 'zzz')
    expect(hits).toEqual([])
    expect(total).toBe(0)
  })
})
