import { useState } from 'react'
import { Check, ChevronDown, Copy, FileText, Layers, ShieldCheck, Wrench } from 'lucide-react'
import type { DesktopDebugPrompt } from '@shared/debug-prompt-types'
import { useDebugText } from './DebugSessionProvider'
import { messageRole, promptJsonText } from './prompt-analysis-core'
import './prompt-request.css'

export function PromptCopyButton({ value, label }: { value: string; label?: string }) {
  const text = useDebugText()
  const [copied, setCopied] = useState<{ value: string; status: 'copied' | 'failed' } | null>(null)
  const state = copied?.value === value ? copied.status : 'idle'
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied({ value, status: 'copied' }) }
    catch { setCopied({ value, status: 'failed' }) }
  }
  return <span className="debug-prompt-copy">
    <button type="button" onClick={() => void copy()} aria-label={label ?? text('promptAnalysis.copy')}>
      {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}{state === 'copied' ? text('promptAnalysis.copied') : label ?? text('promptAnalysis.copy')}
    </button>
    {state === 'failed' ? <span role="alert">{text('promptAnalysis.copyFailed')}</span> : null}
  </span>
}

export function PromptRequestView({ prompt }: { prompt: DesktopDebugPrompt }) {
  const text = useDebugText()
  const request = prompt.request
  if (prompt.availability !== 'assembled' || !request) return <p className="debug-notice">{text('promptAnalysis.pendingNotice')}</p>
  return <div className="debug-prompt-request-view">
    <section className="debug-inspector-card">
      <div className="debug-inspector-heading"><ShieldCheck size={15} /><h4>{text('promptAnalysis.assembledRequest')}</h4><span className="debug-prompt-fidelity is-exact">{text('promptAnalysis.assembled')}</span></div>
      <div className="debug-inspector-body">
        <p className="debug-prompt-help">{text('promptAnalysis.assemblyNotice')}</p>
        <dl className="debug-tool-origin">
          <div><dt>{text('promptAnalysis.provider')}</dt><dd>{request.providerId ?? text('notRecorded')}</dd></div>
          <div><dt>{text('model')}</dt><dd>{request.modelId ?? text('notRecorded')}</dd></div>
          <div><dt>{text('promptAnalysis.protocol')}</dt><dd>{request.protocol ?? text('notRecorded')}</dd></div>
        </dl>
      </div>
      <div className="debug-inspector-actions"><PromptCopyButton value={promptJsonText(request)} label={text('promptAnalysis.copyRequest')} /></div>
    </section>
    <div className="debug-prompt-reader-toolbar"><h4>{text('promptAnalysis.messages')} <span>{request.messages.length}</span></h4></div>
    <p className="debug-prompt-help">{text('promptAnalysis.messageSequenceNotice')}</p>
    {request.messages.map((message, index) => <details key={index} open={index === 0} className="debug-inspector-card debug-prompt-message">
      <summary className="debug-inspector-heading"><span className="debug-prompt-message-index">{index + 1}</span><h4>{messageRole(message) ?? text('promptAnalysis.message')}</h4><ChevronDown size={14} className="debug-inspector-chevron" /></summary>
      <div className="debug-inspector-body"><div className="debug-prompt-content-actions"><FileText size={13} /><PromptCopyButton value={promptJsonText(message)} /></div><pre className="debug-prompt-code">{promptJsonText(message)}</pre></div>
    </details>)}
    {!request.messages.length ? <p className="debug-prompt-help">{text('promptAnalysis.emptySection')}</p> : null}
    <details className="debug-inspector-card debug-prompt-tools">
      <summary className="debug-inspector-heading"><Wrench size={15} /><h4>{text('promptAnalysis.toolDefinitions')}</h4><span className="debug-inspector-caption">{request.tools.length}</span><ChevronDown size={14} className="debug-inspector-chevron" /></summary>
      <div className="debug-inspector-body"><p className="debug-prompt-help">{text('promptAnalysis.toolsSeparate')}</p><div className="debug-prompt-content-actions"><span /><PromptCopyButton value={promptJsonText(request.tools)} /></div><pre className="debug-prompt-code">{promptJsonText(request.tools)}</pre></div>
    </details>
    <details className="debug-inspector-card debug-prompt-extra-body">
      <summary className="debug-inspector-heading"><Layers size={15} /><h4>{text('promptAnalysis.extraBody')}</h4><ChevronDown size={14} className="debug-inspector-chevron" /></summary>
      <div className="debug-inspector-body"><div className="debug-prompt-content-actions"><span /><PromptCopyButton value={promptJsonText(request.extraBody)} /></div><pre className="debug-prompt-code">{promptJsonText(request.extraBody)}</pre></div>
    </details>
  </div>
}
