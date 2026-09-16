import { useMemo, useState } from 'react'
import { ChevronDown, GitCompareArrows, Wrench } from 'lucide-react'
import type { DesktopDebugPrompt } from '@shared/debug-prompt-types'
import { useDebugText } from './DebugSessionProvider'
import { compareCognitiveRequests, type PromptDifference } from './prompt-analysis-core'
import { PromptCopyButton } from './PromptRequestView'
import './prompt-request.css'

function DifferenceText({ section, side }: { section: PromptDifference; side: 'before' | 'after' }) {
  const text = useDebugText()
  const [full, setFull] = useState(false)
  const value = section[side]
  const start = section.prefix
  const end = value.length - section.suffix
  const changed = section.status !== 'same' && end > start
  const from = full || !changed ? 0 : Math.max(0, start - 120)
  const cutoff = full ? value.length : Math.min(value.length, from + 900)
  const highlightedStart = Math.max(from, start)
  const highlightedEnd = Math.min(cutoff, end)
  return <div className={`debug-prompt-diff-side is-${side === 'before' ? 'baseline' : 'current'}`}>
    <div className="debug-prompt-content-actions"><strong>{text(side === 'before' ? 'promptAnalysis.baseline' : 'promptAnalysis.current')}</strong><PromptCopyButton value={value} /></div>
    <pre className="debug-prompt-code">{!value ? text('promptAnalysis.emptySection') : <>
      {from > 0 ? '…' : ''}
      {changed ? <>{value.slice(from, highlightedStart)}<mark>{value.slice(highlightedStart, highlightedEnd)}</mark>{value.slice(Math.max(highlightedEnd, from), cutoff)}</> : value.slice(from, cutoff)}
      {cutoff < value.length ? '…' : ''}
    </>}</pre>
    {value.length > 900 || from > 0 ? <button type="button" className="debug-prompt-show-full" onClick={() => setFull(!full)}>{text(full ? 'promptAnalysis.showExcerpt' : 'promptAnalysis.showFull')}</button> : null}
  </div>
}

export function PromptComparisonView({ prompt, baseline }: { prompt: DesktopDebugPrompt; baseline: DesktopDebugPrompt | null }) {
  const text = useDebugText()
  const [changedOnly, setChangedOnly] = useState(true)
  const sections = useMemo(() => baseline?.availability === 'assembled' && baseline.request && prompt.availability === 'assembled' && prompt.request
    ? compareCognitiveRequests(baseline.request, prompt.request) : null, [baseline, prompt])
  if (!sections) return <p className="debug-empty">{text('promptAnalysis.noBaseline')}</p>
  const firstMessage = sections.find(section => section.kind === 'message' && section.status !== 'same')
  const title = (section: PromptDifference) => {
    if (section.kind === 'message') return `${text('promptAnalysis.message')} ${(section.index ?? 0) + 1}`
    if (section.kind === 'tools') return text('promptAnalysis.toolDefinitions')
    return text(section.kind === 'extraBody' ? 'promptAnalysis.extraBody' : 'promptAnalysis.metadata')
  }
  const hasChanges = sections.some(section => section.status !== 'same')
  return <div className="debug-prompt-comparison">
    <section className="debug-inspector-card">
      <div className="debug-inspector-heading"><GitCompareArrows size={15} /><h4>{text('promptAnalysis.changes')}</h4></div>
      <div className="debug-inspector-body">
        <dl className="debug-prompt-comparison-facts">
          <div><dt>{text('promptAnalysis.firstChangedSection')}</dt><dd>{firstMessage ? title(firstMessage) : text('promptAnalysis.noMessageChanges')}</dd></div>
          <div><dt>{text('promptAnalysis.toolDefinitions')}</dt><dd>{text(`promptAnalysis.changeStatus.${sections.find(section => section.kind === 'tools')!.status}`)}</dd></div>
        </dl>
        <p className="debug-prompt-help">{text('promptAnalysis.comparisonNotice')}</p>
      </div>
    </section>
    <label className="debug-prompt-change-toggle"><input type="checkbox" checked={changedOnly} onChange={event => setChangedOnly(event.target.checked)} />{text('promptAnalysis.onlyChanges')}</label>
    {!hasChanges && changedOnly ? <p className="debug-prompt-help">{text('promptAnalysis.identical')}</p> : null}
    {sections.filter(section => !changedOnly || section.status !== 'same').map(section => <details key={section.id} open className="debug-inspector-card debug-prompt-diff-section">
      <summary className="debug-inspector-heading">{section.kind === 'tools' ? <Wrench size={14} /> : <GitCompareArrows size={14} />}<h4>{title(section)}</h4><span className={`debug-prompt-change-status is-${section.status}`}>{text(`promptAnalysis.changeStatus.${section.status}`)}</span><ChevronDown size={14} className="debug-inspector-chevron" /></summary>
      <div className="debug-prompt-diff-pair"><DifferenceText key={`${baseline!.id}:${prompt.id}:before`} section={section} side="before" /><DifferenceText key={`${baseline!.id}:${prompt.id}:after`} section={section} side="after" /></div>
    </details>)}
  </div>
}
