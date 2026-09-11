export interface RoundMetrics {
  durationMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  source: 'example' | 'recorded'
}

export function metricNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? (value === 0 ? 0 : value) : null
}

export function formatMetricCount(value: number | null | undefined, locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  const number = metricNumber(value)
  return number === null ? '—' : new Intl.NumberFormat(locale).format(number)
}

/** A missing or inconsistent denominator is not a zero-percent cache hit rate. */
export function roundCacheHitPercent(metrics: Pick<RoundMetrics, 'inputTokens' | 'cacheReadTokens'> | undefined): number | null {
  const input = metricNumber(metrics?.inputTokens)
  const cached = metricNumber(metrics?.cacheReadTokens)
  if (input === null || cached === null || input === 0 || cached > input) return null
  return cached / input * 100
}
