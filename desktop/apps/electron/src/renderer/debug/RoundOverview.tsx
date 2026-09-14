import { Repeat2 } from 'lucide-react'
import { useDebugText } from './DebugSessionProvider'
import { duration, roundLabel } from './TraceParts'
import type { TraceRound } from './types'
import './round-overview.css'

export function RoundOverview({ round }: { round: TraceRound }) {
  const text = useDebugText()
  const { inputTokens, outputTokens, cachedInputTokens } = round.usage
  const cacheRate = inputTokens != null && Number.isFinite(inputTokens) && inputTokens > 0
    && cachedInputTokens != null && Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0 && cachedInputTokens <= inputTokens
    ? `${(cachedInputTokens / inputTokens * 100).toFixed(1)}%` : null
  const metrics = [
    { label: text('耗时', 'Time'), value: duration(round.durationMs) },
    { label: text('输入 token', 'Input tokens'), value: inputTokens?.toLocaleString() ?? '—' },
    { label: text('输出 token', 'Output tokens'), value: outputTokens?.toLocaleString() ?? '—' },
    { label: text('缓存读取', 'Cache read'), value: cachedInputTokens?.toLocaleString() ?? '—', hint: cacheRate },
  ]

  return <section className="debug-round-overview" aria-label={text('循环概览', 'Round overview')}>
    <div className="debug-round-overview-heading">
      <span className="debug-round-overview-icon" aria-hidden="true"><Repeat2 size={17} /></span>
      <div className="debug-round-overview-identity">
        <h3 className="debug-round-overview-title"><code>{roundLabel(round)}</code><span>{text('模型响应', 'Model response')}</span></h3>
        <dl className="debug-round-overview-metadata">
          <div><dt>{text('模型', 'Model')}</dt><dd>{round.model ?? text('未记录', 'Not recorded')}</dd></div>
          <div><dt>Stage</dt><dd><code>{round.stage ?? '—'}</code></dd></div>
          <div><dt>{text('模式', 'Mode')}</dt><dd><code>{round.mode ?? '—'}</code></dd></div>
        </dl>
      </div>
    </div>
    <dl className="debug-round-overview-metrics">
      {metrics.map(metric => <div key={metric.label}>
        <dt>{metric.label}</dt>
        <dd><span>{metric.value}</span>{metric.hint != null ? <small>{metric.hint}</small> : null}</dd>
      </div>)}
    </dl>
  </section>
}
