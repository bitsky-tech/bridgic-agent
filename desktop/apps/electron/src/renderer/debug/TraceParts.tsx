import { Check, CircleHelp, Clock3, ExternalLink, Wrench, XCircle } from 'lucide-react'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { MessageThinking } from '@/components/amphi/MessageThinking'
import { useDebugText } from './DebugSessionProvider'
import type { TraceRound, TraceStatus, TraceToolCall } from './types'

export function duration(value: number | null) {
  if (value == null) return '—'
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
}
export const roundLabel = (round: TraceRound | undefined) => round ? `R${String(round.ordinal).padStart(2, '0')}` : '—'
export const turnLabel = (ordinal: number) => ordinal + 1

export function TraceStatusLabel({ status }: { status: TraceStatus }) {
  const text = useDebugText()
  const entries = {
    success: { Icon: Check, label: text('success') },
    error: { Icon: XCircle, label: text('failed') },
    unknown: { Icon: CircleHelp, label: text('resultUnavailable') },
  }
  const { Icon, label } = entries[status]
  return <span className={`debug-status debug-status-${status}`}>
    <Icon size={12} />{label}
  </span>
}

export function RoundMetrics({ round }: { round: TraceRound }) {
  const text = useDebugText()
  const { inputTokens, outputTokens, cachedInputTokens } = round.usage
  const cacheRate = inputTokens != null && inputTokens > 0 && cachedInputTokens != null && cachedInputTokens <= inputTokens
    ? `${(cachedInputTokens / inputTokens * 100).toFixed(1)}%` : null
  return <div className="debug-metrics">
    <span title={round.modelDurationMs != null ? text('modelDurationHint') : undefined}><Clock3 size={11} />{text(round.modelDurationMs != null ? 'modelDuration' : 'time')} {duration(round.modelDurationMs ?? round.durationMs)}</span>
    <span>{text('input')} {inputTokens?.toLocaleString() ?? '—'}</span>
    <span>{text('output')} {outputTokens?.toLocaleString() ?? '—'}</span>
    <span>{text('cacheRead')} {cachedInputTokens?.toLocaleString() ?? '—'}{cacheRate ? ` · ${cacheRate}` : ''}</span>
  </div>
}

export function RoundResponse({ round }: { round: TraceRound }) {
  const text = useDebugText()
  return <div className="debug-response">
    {round.thinking?.trim() ? <details className="debug-thinking">
      <summary>Thinking</summary><MessageThinking thinking={round.thinking} />
    </details> : null}
    {round.body?.trim() ? <MarkdownMessage content={round.body} density="compact" /> : null}
    {!round.body?.trim() && !round.calls.length ? <p className="debug-muted">{text('noRoundResponse')}</p> : null}
  </div>
}

export function ToolRow({ call, onClick }: { call: TraceToolCall; onClick: () => void }) {
  const text = useDebugText()
  const summary = call.arguments === undefined ? '' : JSON.stringify(call.arguments)
  return <button type="button" className="debug-tool-row" onClick={onClick}>
    <Wrench size={13} /><code>{call.name ?? text('unknownTool')}</code>
    <span className="debug-tool-summary">{summary}</span>
    <TraceStatusLabel status={call.status} /><ExternalLink size={12} />
  </button>
}

export function JsonRecord({ title, value, open = true }: { title: string; value: unknown; open?: boolean }) {
  const text = useDebugText()
  return <details className="debug-json" open={open}>
    <summary>{title}</summary>
    <pre>{value === undefined ? text('notRecorded') : JSON.stringify(value, null, 2)}</pre>
  </details>
}
