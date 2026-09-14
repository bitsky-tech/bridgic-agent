import { Clock3, ExternalLink, Wrench } from 'lucide-react'
import { useDebugText } from './DebugSessionProvider'
import { duration, TraceStatusLabel } from './TraceParts'
import { toolCallPreview } from './tool-call-preview'
import type { TraceToolCall } from './types'
import './round-tool-calls.css'

export function RoundToolCalls({ calls, onInspect }: { calls: TraceToolCall[]; onInspect: (call: TraceToolCall) => void }) {
  const text = useDebugText()
  if (!calls.length) return null
  return <section className="debug-round-tool-calls" aria-label={text('本轮工具执行', 'Tool execution in this round')}>
    <h4>{text('工具执行', 'Tool execution')}<span>{calls.length}</span></h4>
    {calls.map(call => {
      const preview = toolCallPreview(call)
      const name = call.name ?? text('未知工具', 'Unknown tool')
      return <article className="debug-round-tool-call" key={call.id} data-debug-tool-preview={call.id}>
        <button type="button" className="debug-round-tool-call-heading" onClick={() => onInspect(call)}
          aria-label={`${text('查看工具调用', 'Inspect tool call')} ${name} · ${call.ordinal}`}>
          <Wrench size={14} aria-hidden="true" /><code>{name}</code><TraceStatusLabel status={call.status} /><ExternalLink size={12} aria-hidden="true" />
        </button>
        <div className="debug-round-tool-call-body">
          <div className="debug-round-tool-call-meta"><span>{text('参数', 'Arguments')}</span><span><Clock3 size={11} aria-hidden="true" />{text('耗时', 'Duration')} {duration(call.durationMs)}</span></div>
          {preview.argumentState === 'recorded' ? <dl className="debug-round-tool-arguments">
            {preview.arguments.map((argument, index) => <div key={index}>
              <dt>{argument.name || text('参数值', 'Value')}</dt><dd>{argument.value}</dd>
            </div>)}
          </dl> : <p className="debug-round-tool-placeholder">{preview.argumentState === 'missing' ? text('参数未记录', 'Arguments not recorded') : text('无参数', 'No arguments')}</p>}
          {preview.remainingArgumentCount > 0 ? <button type="button" className="debug-round-tool-more" onClick={() => onInspect(call)}>
            {text(`查看其余 ${preview.remainingArgumentCount} 项参数`, `View ${preview.remainingArgumentCount} more arguments`)}
          </button> : null}
          <div className={`debug-round-tool-outcome is-${preview.outcomeKind}`}>
            <span>{preview.outcomeKind === 'error' ? text('错误摘要', 'Error preview') : text('结果摘要', 'Result preview')}</span>
            <p>{preview.outcomeKind === 'missing' ? text('未记录到执行结果', 'No execution result recorded') : preview.outcome}</p>
          </div>
        </div>
      </article>
    })}
  </section>
}
