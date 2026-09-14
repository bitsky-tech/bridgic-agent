import { describe, expect, test } from 'bun:test'
import { formatMetricCount, metricNumber, roundCacheHitPercent } from './round-metrics'

describe('round metric helpers', () => {
  test('zero remains a recorded value and unknown or invalid numbers remain unavailable', () => {
    expect(metricNumber(0)).toBe(0)
    expect(metricNumber(-0)).toBe(0)
    expect(metricNumber(1380)).toBe(1380)
    expect(metricNumber(1.5)).toBe(1.5)
    for (const value of [null, undefined, NaN, Infinity, -Infinity, -1]) expect(metricNumber(value)).toBeNull()
    expect(formatMetricCount(0)).toBe('0')
    expect(formatMetricCount(12480, 'en-US')).toBe('12,480')
    for (const value of [null, undefined, NaN, Infinity, -Infinity, -1]) expect(formatMetricCount(value)).toBe('—')
  })

  test('cache hit rate distinguishes zero hits from unavailable or inconsistent counts', () => {
    expect(roundCacheHitPercent({ inputTokens: 1000, cacheReadTokens: 0 })).toBe(0)
    expect(roundCacheHitPercent({ inputTokens: 1000, cacheReadTokens: 250 })).toBe(25)
    expect(roundCacheHitPercent({ inputTokens: 1000, cacheReadTokens: 1000 })).toBe(100)
    expect(roundCacheHitPercent(undefined)).toBeNull()
    expect(roundCacheHitPercent({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull()
    expect(roundCacheHitPercent({ inputTokens: 1000, cacheReadTokens: 1001 })).toBeNull()
    for (const value of [null, NaN, Infinity, -Infinity, -1]) {
      expect(roundCacheHitPercent({ inputTokens: value, cacheReadTokens: 0 })).toBeNull()
      expect(roundCacheHitPercent({ inputTokens: 1000, cacheReadTokens: value })).toBeNull()
    }
  })
})
