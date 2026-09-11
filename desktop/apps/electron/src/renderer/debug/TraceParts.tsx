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
    success: { Icon: Check, label: text('成功', 'Success') },
    error: { Icon: XCircle, label: text('失败', 'Failed') },
    unknown: { Icon: CircleHelp, label: text('结果未记录', 'Result unavailable') },
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
    <span><Clock3 size={11} />{text('耗时', 'Time')} {duration(round.durationMs)}</span>
    <span>{text('输入', 'Input')} {inputTokens?.toLocaleString() ?? '—'}</span>
    <span>{text('输出', 'Output')} {outputTokens?.toLocaleString() ?? '—'}</span>
    <span>{text('缓存读取', 'Cache read')} {cachedInputTokens?.toLocaleString() ?? '—'}{cacheRate ? ` · ${cacheRate}` : ''}</span>
  </div>
}

export function RoundResponse({ round }: { round: TraceRound }) {
  const text = useDebugText()
  return <div className="debug-response">
    {round.thinking?.trim() ? <details className="debug-thinking">
      <summary>Thinking</summary><MessageThinking thinking={round.thinking} />
    </details> : null}
    {round.body?.trim() ? <MarkdownMessage content={round.body} density="compact" /> : null}
    {!round.body?.trim() && !round.calls.length ? <p className="debug-muted">{text('此轮没有可展示的正文记录', 'No response text recorded for this round')}</p> : null}
  </div>
}

export function ToolRow({ call, onClick }: { call: TraceToolCall; onClick: () => void }) {
  const text = useDebugText()
  const summary = call.arguments === undefined ? '' : JSON.stringify(call.arguments)
  return <button type="button" className="debug-tool-row" onClick={onClick}>
    <Wrench size={13} /><code>{call.name ?? text('未知工具', 'Unknown tool')}</code>
    <span className="debug-tool-summary">{summary}</span>
    <TraceStatusLabel status={call.status} /><ExternalLink size={12} />
  </button>
}

export function JsonRecord({ title, value, open = true }: { title: string; value: unknown; open?: boolean }) {
  const text = useDebugText()
  return <details className="debug-json" open={open}>
    <summary>{title}</summary>
    <pre>{value === undefined ? text('未记录', 'Not recorded') : JSON.stringify(value, null, 2)}</pre>
  </details>
}
