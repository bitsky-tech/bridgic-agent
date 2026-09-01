/**
 * Unit tests for the pure watch-set reconcile logic (`../fs-watch-core`).
 * No fs, no timers, no electron — just set diffing.
 */
import { describe, expect, test } from 'bun:test'
import { reconcileWatchSet } from '../fs-watch-core'

describe('reconcileWatchSet', () => {
  test('computes normalized additions and removals', () => {
    const cases: [string[], string[], { toAdd: string[]; toRemove: string[] }][] = [
      [[], [], { toAdd: [], toRemove: [] }],
      [[], ['/a', '/b'], { toAdd: ['/a', '/b'], toRemove: [] }],
      [['/a', '/b'], ['/a'], { toAdd: [], toRemove: ['/b'] }],
      [['/a', '/b'], ['/b', '/c'], { toAdd: ['/c'], toRemove: ['/a'] }],
      [['/a', '/b'], ['/b', '/a'], { toAdd: [], toRemove: [] }],
      [[], ['/a', '/a'], { toAdd: ['/a'], toRemove: [] }],
      [[''], ['', '/a'], { toAdd: ['/a'], toRemove: [] }],
    ]
    for (const [current, desired, expected] of cases) {
      expect(reconcileWatchSet(current, desired)).toEqual(expected)
    }
  })
})
