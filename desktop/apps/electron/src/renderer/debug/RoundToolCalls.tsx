import { Clock3, ExternalLink, Wrench } from 'lucide-react'
import { useDebugText } from './DebugSessionProvider'
import { duration, TraceStatusLabel } from './TraceParts'
import { toolCallPreview } from './tool-call-preview'
import type { TraceToolCall } from './types'
import './round-tool-calls.css'

export function RoundToolCalls({ calls, onInspect }: { calls: TraceToolCall[]; onInspect: (call: TraceToolCall) => void }) {
  const text = useDebugText()
  if (!calls.length) return null
  return <section className="debug-round-tool-calls" aria-label={text('toolExecutionInThisRound')}>
    <h4>{text('toolExecution')}<span>{calls.length}</span></h4>
    {calls.map(call => {
      const preview = toolCallPreview(call)
      const name = call.name ?? text('unknownTool')
      return <article className="debug-round-tool-call" key={call.id} data-debug-tool-preview={call.id}>
        <button type="button" className="debug-round-tool-call-heading" onClick={() => onInspect(call)}
          aria-label={`${text('inspectToolCall')} ${name} · ${call.ordinal}`}>
          <Wrench size={14} aria-hidden="true" /><code>{name}</code><TraceStatusLabel status={call.status} /><ExternalLink size={12} aria-hidden="true" />
        </button>
        <div className="debug-round-tool-call-body">
          <div className="debug-round-tool-call-meta"><span>{text('arguments')}</span><span><Clock3 size={11} aria-hidden="true" />{text('duration')} {duration(call.durationMs)}</span></div>
          {preview.argumentState === 'recorded' ? <dl className="debug-round-tool-arguments">
            {preview.arguments.map((argument, index) => <div key={index}>
              <dt>{argument.name || text('value')}</dt><dd>{argument.value}</dd>
            </div>)}
          </dl> : <p className="debug-round-tool-placeholder">{preview.argumentState === 'missing' ? text('argumentsNotRecorded') : text('noArguments')}</p>}
          {preview.remainingArgumentCount > 0 ? <button type="button" className="debug-round-tool-more" onClick={() => onInspect(call)}>
            {text('remainingArguments', { n: preview.remainingArgumentCount })}
          </button> : null}
          <div className={`debug-round-tool-outcome is-${preview.outcomeKind}`}>
            <span>{preview.outcomeKind === 'error' ? text('errorPreview') : text('resultPreview')}</span>
            <p>{preview.outcomeKind === 'missing' ? text('noExecutionResult') : preview.outcome}</p>
          </div>
        </div>
      </article>
    })}
  </section>
}
