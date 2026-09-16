import { Cpu, Network, Server, SlidersHorizontal } from 'lucide-react'
import type { DebugModelRequest } from '@shared/debug-model-types'
import { useDebugText } from './DebugSessionProvider'

const namedParameters: Record<string, string> = {
  temperature: 'temperature', top_p: 'topP', max_tokens: 'maxTokens', max_output_tokens: 'maxOutputTokens',
  max_completion_tokens: 'maxOutputTokens', reasoning: 'reasoning', reasoning_effort: 'reasoningEffort',
  tool_choice: 'toolChoice', parallel_tool_calls: 'parallelTools', seed: 'seed', stop: 'stop',
}

export function ModelCallParameters({ request }: { request: DebugModelRequest }) {
  const text = useDebugText()
  const entries = Object.entries(request.extraBody)
  return <div className="debug-request-parameters">
    <div className="debug-parameter-model">
      <span className="debug-parameter-model-icon"><Cpu size={20} /></span>
      <div><span>{text('model')}</span><strong>{request.model || text('notRecorded')}</strong></div>
    </div>
    <div className="debug-parameter-connection">
      <div><span><Server size={13} />{text('modelCall.provider')}</span><code>{request.providerId ?? '—'}</code></div>
      <div><span><Network size={13} />{text('modelCall.protocol')}</span><code>{request.protocol || '—'}</code></div>
    </div>
    <section className="debug-parameter-options">
      <header><SlidersHorizontal size={14} /><strong>{text('modelCall.explicitParameters')}</strong><span>{entries.length}</span></header>
      {entries.length ? <dl className="debug-parameter-values">
        {entries.map(([key, value]) => {
          const structured = value !== null && typeof value === 'object'
          const knownLabel = namedParameters[key]
          return <div key={key} className={structured ? 'is-structured' : undefined}>
            <dt>{knownLabel ? <><span>{text(`modelCall.parameterNames.${knownLabel}`)}</span><code>{key}</code></> : <code>{key}</code>}</dt>
            <dd>{structured ? <pre>{JSON.stringify(value, null, 2)}</pre> : <code>{typeof value === 'string' ? value : JSON.stringify(value)}</code>}</dd>
          </div>
        })}
      </dl> : <div className="debug-parameter-empty"><SlidersHorizontal size={22} /><div><strong>{text('modelCall.noExplicitParameters')}</strong><p>{text('modelCall.parameterDefaultsNotice')}</p></div></div>}
    </section>
  </div>
}
