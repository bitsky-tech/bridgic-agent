/**
 * Unit tests for the pure watch-set reconcile logic (`../fs-watch-core`).
 * No fs, no timers, no electron — just set diffing.
 */
import { describe, expect, test } from 'bun:test'
import { reconcileWatchSet } from '../fs-watch-core'

describe('reconcileWatchSet', () => {
  test('empty → empty is a no-op', () => {
    expect(reconcileWatchSet([], [])).toEqual({ toAdd: [], toRemove: [] })
  })

  test('all-new desired paths are added', () => {
    expect(reconcileWatchSet([], ['/a', '/b'])).toEqual({ toAdd: ['/a', '/b'], toRemove: [] })
  })

  test('vanished paths are removed', () => {
    expect(reconcileWatchSet(['/a', '/b'], ['/a'])).toEqual({ toAdd: [], toRemove: ['/b'] })
  })

  test('mixed add + remove', () => {
    const r = reconcileWatchSet(['/a', '/b'], ['/b', '/c'])
    expect(r.toAdd).toEqual(['/c'])
    expect(r.toRemove).toEqual(['/a'])
  })

  test('idempotent: equal sets yield empty diffs', () => {
    expect(reconcileWatchSet(['/a', '/b'], ['/b', '/a'])).toEqual({ toAdd: [], toRemove: [] })
  })

  test('deduplicates inputs (same path twice → watched once)', () => {
    expect(reconcileWatchSet([], ['/a', '/a'])).toEqual({ toAdd: ['/a'], toRemove: [] })
  })

  test('drops empty / blank paths', () => {
    expect(reconcileWatchSet([''], ['', '/a'])).toEqual({ toAdd: ['/a'], toRemove: [] })
  })
})
