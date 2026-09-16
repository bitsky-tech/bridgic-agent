import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, GitCompareArrows, Layers, MessageSquare, Repeat2, ScanText, X } from 'lucide-react'
import type { SessionWorkbenchExtensionProps } from '@/components/app/DesktopAppExtensions'
import { WorkbenchSearchField, WorkbenchScopeButtons, WorkbenchToolHeader, WorkbenchToolScrollArea, WorkbenchToolSurface } from '@/components/app/WorkbenchToolPrimitives'
import type { DesktopDebugPrompt } from '@shared/debug-prompt-types'
import { useDebugSession, useDebugText } from './DebugSessionProvider'
import { promptRoundLabel, promptTraceId } from './prompt-analysis-core'
import { usePromptAnalysis, type PromptLoadState } from './usePromptAnalysis'
import { RoundMetrics, turnLabel } from './TraceParts'
import { PromptRequestView } from './PromptRequestView'
import { PromptComparisonView } from './PromptComparisonView'
import './debug-inspector.css'
import './round-detail.css'
import './prompt-analysis.css'

export { promptTraceId } from './prompt-analysis-core'
const stageKey = (prompt: DesktopDebugPrompt) => JSON.stringify([prompt.mode, prompt.stage])
const identity = (prompt: DesktopDebugPrompt) => `Turn ${turnLabel(prompt.turnOrdinal)} · ${promptRoundLabel(prompt)}`

function PromptLoadNotice({ state, retry }: { state?: PromptLoadState; retry: () => void }) {
  const text = useDebugText()
  if (state?.error) return <div className="debug-notice" role="alert"><p>{text('promptAnalysis.loadFailed')} · {state.error}</p><button type="button" onClick={retry}>{text('promptAnalysis.retry')}</button></div>
  return <p className="debug-prompt-loading" role="status">{text('promptAnalysis.loading')}</p>
}

function PromptDetail({ prompt, prompts, entries, assemble, initialTab, active }: {
  prompt: DesktopDebugPrompt; prompts: DesktopDebugPrompt[]; entries: Map<string, PromptLoadState>;
  assemble: (id: string, retry?: boolean) => void; initialTab: 'request' | 'compare'; active: boolean
}) {
  const text = useDebugText()
  const debug = useDebugSession()
  const [tab, setTab] = useState(initialTab)
  const candidates = prompts.filter(item => item.id !== prompt.id && item.stage && item.mode)
  const earlier = candidates.filter(item => item.turnOrdinal < prompt.turnOrdinal || (item.turnId === prompt.turnId && item.roundIndex < prompt.roundIndex))
  const defaultBaseline = earlier.at(-1) ?? candidates[0]
  const [baselineId, setBaselineId] = useState<string | null>(null)
  const baseline = candidates.find(item => item.id === baselineId) ?? defaultBaseline ?? null
  const comparisonId = tab === 'compare' ? baseline?.id : undefined
  const round = debug.records.rounds.find(item => item.id === promptTraceId(prompt))
  useEffect(() => { if (active) assemble(prompt.id) }, [active, assemble, prompt.id])
  useEffect(() => { if (active && comparisonId) assemble(comparisonId) }, [active, assemble, comparisonId])
  const requestContent = prompt.request ? <PromptRequestView prompt={prompt} /> : <PromptLoadNotice state={entries.get(prompt.id)} retry={() => assemble(prompt.id, true)} />
  let comparisonContent = <PromptComparisonView key={`${prompt.id}:${baseline?.id ?? ''}`} prompt={prompt} baseline={baseline} />
  if (!prompt.request) comparisonContent = <PromptLoadNotice state={entries.get(prompt.id)} retry={() => assemble(prompt.id, true)} />
  else if (baseline && !baseline.request) comparisonContent = <PromptLoadNotice state={entries.get(baseline.id)} retry={() => assemble(baseline.id, true)} />
  return <div className="debug-prompt-detail">
    <section className="debug-inspector-card debug-inspector-source">
      <div className="debug-inspector-heading"><ScanText size={16} /><h4>{identity(prompt)}</h4><span className={`debug-prompt-fidelity is-${prompt.availability === 'assembled' ? 'exact' : 'unavailable'}`}>{text(prompt.availability === 'assembled' ? 'promptAnalysis.assembled' : 'promptAnalysis.pending')}</span></div>
      <div className="debug-inspector-body"><dl className="debug-tool-origin">
        <div><dt>{text('model')}</dt><dd>{prompt.request?.modelId ?? round?.model ?? text('notRecorded')}</dd></div>
        <div><dt>{text('promptAnalysis.stage')}</dt><dd>{prompt.stage ?? text('notRecorded')}</dd></div>
        {prompt.mode ? <div><dt>{text('mode')}</dt><dd>{prompt.mode}</dd></div> : null}
      </dl></div>
      {round ? <div className="debug-prompt-measured"><span>{text('promptAnalysis.recordedRoundUsage')}</span><RoundMetrics round={round} /></div> : null}
      <div className="debug-inspector-actions"><button type="button" disabled={!round} onClick={() => { if (round) debug.inspect('rounds', round.id) }}><Repeat2 size={13} />{text('inspectRound')}</button></div>
    </section>
    <div className="debug-prompt-tabs debug-round-tabs" role="tablist" aria-label={text('promptAnalysis.title')}>
      <button type="button" role="tab" aria-selected={tab === 'request'} onClick={() => setTab('request')}>{text('promptAnalysis.requestStructure')}</button>
      <button type="button" role="tab" aria-selected={tab === 'compare'} onClick={() => setTab('compare')}>{text('promptAnalysis.requestComparison')}</button>
    </div>
    <div role="tabpanel">{tab === 'request' ? requestContent : <>
      {candidates.length ? <label className="debug-prompt-baseline-select">{text('promptAnalysis.baseline')}<select value={baseline?.id ?? ''} onChange={event => setBaselineId(event.target.value)}>
        {candidates.map(item => <option key={item.id} value={item.id}>{identity(item)} · {item.stage}</option>)}
      </select></label> : null}
      {baseline ? <p className="debug-prompt-comparison-identity"><span>{identity(baseline)}</span><ArrowRight size={13} /><span>{identity(prompt)}</span></p> : null}
      {comparisonContent}
    </>}</div>
  </div>
}

function PromptPanel({ sessionId, active, onClose }: SessionWorkbenchExtensionProps) {
  const text = useDebugText()
  const debug = useDebugSession()
  const { prompts, entries, assemble } = usePromptAnalysis(sessionId, active)
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState('')
  const [detail, setDetail] = useState<{ id: string; tab: 'request' | 'compare' } | null>(null)
  const [appliedSelection, setAppliedSelection] = useState<number | null>(null)
  const [selectionUnavailable, setSelectionUnavailable] = useState(false)
  const byId = new Map(prompts.map(item => [item.id, item]))
  const stages = [...new Map(prompts.map(prompt => [stageKey(prompt), prompt])).values()]
  const needle = query.trim().toLocaleLowerCase()
  const filtered = prompts.filter(prompt => (!stage || stageKey(prompt) === stage)
    && `${identity(prompt)} ${prompt.request?.modelId ?? ''} ${prompt.stage ?? ''} ${prompt.mode ?? ''}`.toLocaleLowerCase().includes(needle))
  const grouped = new Map<string, DesktopDebugPrompt[]>()
  for (const prompt of filtered) grouped.set(prompt.turnId, [...(grouped.get(prompt.turnId) ?? []), prompt])
  const selected = detail ? byId.get(detail.id) : undefined
  const selection = debug.selection
  if (active && selection?.kind === 'prompts' && selection.nonce !== appliedSelection) {
    const prompt = prompts.find(item => promptTraceId(item) === selection.id)
    if (prompt || !debug.loading) {
      setAppliedSelection(selection.nonce)
      setSelectionUnavailable(!prompt)
      setQuery(''); setStage('')
      setDetail(prompt ? { id: prompt.id, tab: 'request' } : null)
    }
  }
  if (!debug.loading) {
    if (detail && !selected) setDetail(null)
    if (stage && !stages.some(prompt => stageKey(prompt) === stage)) setStage('')
  }
  const assembled = prompts.filter(prompt => prompt.availability === 'assembled').length
  const openPrompt = (id: string, tab: 'request' | 'compare') => { setSelectionUnavailable(false); setDetail({ id, tab }) }
  return <WorkbenchToolSurface testId="desktop-debug-prompts">
    <WorkbenchToolHeader title={text('promptAnalysis.title')} icon={<ScanText size={16} />}
      actions={<button type="button" aria-label={text('closePanel')} onClick={onClose}><X size={16} /></button>} />
    <WorkbenchToolScrollArea className="debug-panel debug-prompt-panel">
      {debug.error ? <p className="debug-notice" role="alert">{text('readFailed')} · {debug.error}</p> : null}
      {selectionUnavailable && !selected ? <p className="debug-notice" role="status">{text('promptAnalysis.requestUnavailable')}</p> : null}
      {debug.loading ? <p className="debug-prompt-loading" role="status">{text('loading')}</p> : null}
      {selected && detail ? <>
        <button type="button" className="debug-back" onClick={() => setDetail(null)}><ArrowLeft size={13} />{text('backToList')}</button>
        <PromptDetail key={`${selected.id}:${detail.tab}`} prompt={selected} prompts={prompts} entries={entries} assemble={assemble} initialTab={detail.tab} active={active} />
      </> : <>
        <section className="debug-prompt-intro">
          <div><ScanText size={18} /><h3>{text('promptAnalysis.sessionRequests')}</h3></div>
          <p>{text('promptAnalysis.description')}</p>
          <dl className="debug-prompt-metrics">
            <div><dt>Turn</dt><dd>{new Set(prompts.map(item => item.turnId)).size}</dd></div><div><dt>{text('promptAnalysis.requests')}</dt><dd>{prompts.length}</dd></div>
            <div><dt>{text('promptAnalysis.assembled')}</dt><dd>{assembled} <small>/ {prompts.length}</small></dd></div>
          </dl>
        </section>
        <WorkbenchSearchField query={query} onQueryChange={setQuery} clearLabel={text('clearSearch')} searchPlaceholder={text('promptAnalysis.search')} />
        {stages.length ? <div className="debug-prompt-stage-filter"><WorkbenchScopeButtons ariaLabel={text('filterByStage')} value={stage} onChange={setStage}
          options={[{ value: '', label: text('allStages') }, ...stages.map(prompt => ({ value: stageKey(prompt), label: `${prompt.stage ?? text('stageNotRecorded')}${stages.some(other => other.stage === prompt.stage && other.mode !== prompt.mode) ? ` · ${prompt.mode ?? '—'}` : ''}` }))]} /></div> : null}
        <div className="debug-prompt-turn-list">
          {[...grouped].map(([turnId, turnPrompts]) => <details key={turnId} open className="debug-inspector-card debug-prompt-turn">
            <summary className="debug-inspector-heading"><MessageSquare size={14} /><h4>Turn {turnLabel(turnPrompts[0]!.turnOrdinal)}</h4><span className="debug-inspector-caption">{turnPrompts.length} {text('promptAnalysis.requests')}</span><ChevronDown size={14} className="debug-inspector-chevron" /></summary>
            <div className="debug-prompt-request-list">{turnPrompts.map(prompt => <div key={prompt.id} className="debug-prompt-request-row">
              <button type="button" className="debug-prompt-request-open" onClick={() => openPrompt(prompt.id, 'request')}>
                <span className="debug-prompt-request-identity"><code>{promptRoundLabel(prompt)}</code><span><Layers size={12} />{prompt.stage ?? '—'}</span><ArrowRight size={13} /></span>
                {prompt.request ? <><span className="debug-prompt-request-model">{prompt.request.modelId ?? text('notRecorded')}</span><span className="debug-prompt-request-stats"><span>{text('promptAnalysis.messages')} <b>{prompt.request.messages.length}</b></span><span>{text('promptAnalysis.tools')} <b>{prompt.request.tools.length}</b></span></span></> : null}
              </button>
              <div className="debug-prompt-request-foot">
                <span className={`debug-prompt-fidelity is-${prompt.availability === 'assembled' ? 'exact' : 'unavailable'}`}>{text(prompt.availability === 'assembled' ? 'promptAnalysis.assembled' : 'promptAnalysis.pending')}</span>
                {prompts.length > 1 ? <button type="button" onClick={() => openPrompt(prompt.id, 'compare')}><GitCompareArrows size={12} />{text('promptAnalysis.compare')}</button> : null}
              </div>
            </div>)}</div>
          </details>)}
        </div>
        {!debug.loading && !filtered.length ? <p className="debug-empty">{text(query || stage ? 'noMatchingRecords' : 'promptAnalysis.empty')}</p> : null}
        {debug.hasMore ? <button type="button" className="debug-load-more" disabled={debug.loading} onClick={debug.loadMore}>{text('loadMore')}</button> : null}
        <p className="debug-list-note">{text('promptAnalysis.assemblyNotice')}</p>
      </>}
    </WorkbenchToolScrollArea>
  </WorkbenchToolSurface>
}

export function DebugPromptsPanel(props: SessionWorkbenchExtensionProps) { return <PromptPanel key={props.sessionId} {...props} /> }
