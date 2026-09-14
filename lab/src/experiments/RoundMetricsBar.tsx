import { useI18n } from '../i18n'
import { formatMetricCount, metricNumber, roundCacheHitPercent, type RoundMetrics } from './round-metrics'
import './round-metrics.css'

/** Per-round telemetry; never infer tokens from text or split a turn's total across rounds. */
export function RoundMetricsBar({ metrics }: { metrics?: RoundMetrics }) {
  const { locale, t } = useI18n()
  const duration = metricNumber(metrics?.durationMs)
  const durationText = duration === null ? '—' : duration < 1000 ? `${duration} ms` : `${(duration / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} s`
  const cachePercent = roundCacheHitPercent(metrics)
  const input = formatMetricCount(metrics?.inputTokens, locale)
  const output = formatMetricCount(metrics?.outputTokens, locale)
  const cached = formatMetricCount(metrics?.cacheReadTokens, locale)
  const unknown = t('experiments.notRecorded')
  return <dl className="round-metrics" aria-label={t('experiments.roundExecutionMetrics')} data-source={metrics?.source ?? 'unavailable'}>
    <div title={duration === null ? unknown : t('experiments.roundDurationTooltip', { duration })}><dt>{t('experiments.time')}</dt><dd>{durationText}</dd></div>
    <div title={t('experiments.inputTokensTooltip', { input })}><dt>{t('experiments.in')}</dt><dd>{input}</dd></div>
    <div title={t('experiments.outputTokensTooltip', { output })}><dt>{t('experiments.out')}</dt><dd>{output}</dd></div>
    <div title={cachePercent === null ? t('experiments.cacheHitRateIsUnavailable') : t('experiments.cacheReadTooltip', { cached, input })}><dt>{t('experiments.cache')}</dt><dd>{cachePercent === null ? '—' : `${cachePercent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`}</dd></div>
    {metrics?.source === 'example' && <span className="round-metrics-source" title={t('experiments.illustrativeMetricsForTheInterfaceNotActualExecutionTelemetry')}>{t('experiments.demo')}</span>}
  </dl>
}
