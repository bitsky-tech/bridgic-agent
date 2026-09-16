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
    { label: text(round.modelDurationMs != null ? 'modelDuration' : 'time'), value: duration(round.modelDurationMs ?? round.durationMs), title: round.modelDurationMs != null ? text('modelDurationHint') : undefined },
    { label: text('inputTokens'), value: inputTokens?.toLocaleString() ?? '—' },
    { label: text('outputTokens'), value: outputTokens?.toLocaleString() ?? '—' },
    { label: text('cacheRead'), value: cachedInputTokens?.toLocaleString() ?? '—', hint: cacheRate },
  ]

  return <section className="debug-round-overview" aria-label={text('roundOverview')}>
    <div className="debug-round-overview-heading">
      <span className="debug-round-overview-icon" aria-hidden="true"><Repeat2 size={17} /></span>
      <div className="debug-round-overview-identity">
        <h3 className="debug-round-overview-title"><code>{roundLabel(round)}</code><span>{text('modelResponse')}</span></h3>
        <dl className="debug-round-overview-metadata">
          <div><dt>{text('model')}</dt><dd>{round.model ?? text('notRecorded')}</dd></div>
          <div><dt>Stage</dt><dd><code>{round.stage ?? '—'}</code></dd></div>
          <div><dt>{text('mode')}</dt><dd><code>{round.mode ?? '—'}</code></dd></div>
        </dl>
      </div>
    </div>
    <dl className="debug-round-overview-metrics">
      {metrics.map(metric => <div key={metric.label} title={metric.title}>
        <dt>{metric.label}</dt>
        <dd><span>{metric.value}</span>{metric.hint != null ? <small>{metric.hint}</small> : null}</dd>
      </div>)}
    </dl>
  </section>
}
