import { useI18n } from '../i18n'
import { formatMetricCount, metricNumber, roundCacheHitPercent, type RoundMetrics } from './round-metrics'
import './round-metrics.css'

/** Per-round telemetry; never infer tokens from text or split a turn's total across rounds. */
export function RoundMetricsBar({ metrics }: { metrics?: RoundMetrics }) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const duration = metricNumber(metrics?.durationMs)
  const durationText = duration === null ? '—' : duration < 1000 ? `${duration} ms` : `${(duration / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} s`
  const cachePercent = roundCacheHitPercent(metrics)
  const input = formatMetricCount(metrics?.inputTokens, locale)
  const output = formatMetricCount(metrics?.outputTokens, locale)
  const cached = formatMetricCount(metrics?.cacheReadTokens, locale)
  const unknown = t('未记录', 'Not recorded')
  return <dl className="round-metrics" aria-label={t('本轮执行指标', 'Round execution metrics')} data-source={metrics?.source ?? 'unavailable'}>
    <div title={duration === null ? unknown : t(`本轮执行耗时：${duration} ms`, `Round execution duration: ${duration} ms`)}><dt>{t('耗时', 'Time')}</dt><dd>{durationText}</dd></div>
    <div title={t(`输入 Token：${input}`, `Input tokens: ${input}`)}><dt>{t('输入', 'In')}</dt><dd>{input}</dd></div>
    <div title={t(`输出 Token：${output}`, `Output tokens: ${output}`)}><dt>{t('输出', 'Out')}</dt><dd>{output}</dd></div>
    <div title={cachePercent === null ? t('缓存命中率未记录或不可计算', 'Cache hit rate is unavailable') : t(`缓存读取 ${cached} / 输入 ${input} Token`, `Cache-read ${cached} / input ${input} tokens`)}><dt>{t('缓存命中', 'Cache')}</dt><dd>{cachePercent === null ? '—' : `${cachePercent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`}</dd></div>
    {metrics?.source === 'example' && <span className="round-metrics-source" title={t('指标为界面演示值，不是实际运行统计。', 'Illustrative metrics for the interface, not actual execution telemetry.')}>{t('示例', 'Demo')}</span>}
  </dl>
}
