import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Braces, BrainCircuit, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, FileText, FlaskConical, LocateFixed, Play, RotateCcw, Search, Square, Wrench } from 'lucide-react'
import { useI18n, type Translator } from '../i18n'
import type { DebugOpenRequest, DebugRecords, DebugRecordStatus, DebugRound, DebugToolCall } from './debug-record-types'
import { createDebugSimulationReceipt, debugRoundTabs, emptyDebugFilters, filterDebugCalls, filterDebugRounds, isValidRoundRequest, nextDebugRoundTab, parseDebugArguments, roundRequest, type DebugFilters, type DebugRoundTab, type DebugSimulationReceipt } from './debug-panel-state'
import './debug-workbench-panel.css'
import { RoundMetricsBar } from './RoundMetricsBar'
import { ModelResponseContent } from './ModelResponseContent'

interface Props {
  sessionId?: string
  surface: 'tools' | 'rounds'
  records: DebugRecords
  request: DebugOpenRequest | null
  onLocateRound: (round: DebugRound) => void
  onArtifact?: (artifact: 'brief' | 'sources' | 'outline') => void
  renderToolExtra?: (call: DebugToolCall) => ReactNode
}
type Detail = { kind: 'list' } | { kind: 'tool'; id: string; fromRound?: string } | { kind: 'round'; id: string }
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? ''

function statusText(status: DebugRecordStatus, t: Translator, round = false) {
  if (round && status === 'success') return t('experiments.roundComplete')
  if (round && status === 'error') return t('experiments.toolFailures')
  return { success: t('experiments.succeeded'), error: t('experiments.failed'), running: t('experiments.running'), cancelled: t('experiments.stopped'), waiting: t('experiments.awaitingUser'), example: t('experiments.example') }[status]
}

function Status({ status, t, round = false }: { status: DebugRecordStatus; t: Translator; round?: boolean }) {
  return <span className={`debug-record-status is-${status}`}>
    {status === 'success' ? <Check size={12} /> : status === 'error' ? <CircleAlert size={12} /> : status === 'cancelled' ? <Square size={11} /> : status === 'example' ? <FlaskConical size={12} /> : <Clock3 size={12} />}
    {statusText(status, t, round)}
  </span>
}

function JsonView({ value, empty }: { value: unknown; empty: string }) {
  return value === null || value === undefined ? <p className="debug-empty-value">{empty}</p> : <pre className="debug-json">{typeof value === 'string' ? value : pretty(value)}</pre>
}

function DetailSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="debug-detail-section"><header><h4>{title}</h4>{aside}</header>{children}</section>
}

export function DebugWorkbenchPanel({ sessionId, surface, records, request, onLocateRound, onArtifact, renderToolExtra }: Props) {
  const { locale, t } = useI18n()
  const [filters, setFilters] = useState<DebugFilters>(emptyDebugFilters)
  const [detail, setDetail] = useState<Detail>({ kind: 'list' })
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [receipts, setReceipts] = useState<Record<string, DebugSimulationReceipt[]>>({})
  const [roundTab, setRoundTab] = useState<DebugRoundTab>('request')
  const [editingRound, setEditingRound] = useState(false)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const cardNodes = useRef(new Map<string, HTMLButtonElement>())
  const tabNodes = useRef(new Map<DebugRoundTab, HTMLButtonElement>())
  const detailTitle = useRef<HTMLHeadingElement>(null)
  const lastRequest = useRef<DebugOpenRequest | null>(null)
  const lastSurface = useRef(surface)
  const lastSession = useRef(sessionId)
  const editorId = useId()
  const tool = detail.kind === 'tool' ? records.calls.find(call => call.id === detail.id) : undefined
  const round = detail.kind === 'round' ? records.rounds.find(item => item.id === detail.id) : tool ? records.rounds.find(item => item.id === tool.roundId) : undefined
  const callNames = useMemo(() => [...new Set(records.calls.map(call => call.name))].sort(), [records.calls])
  const turns = useMemo(() => [...new Map(records.rounds.map(item => [item.turnId, item.turnOrdinal])).entries()], [records.rounds])
  const filteredCalls = filterDebugCalls(records.calls, filters)
  const filteredRounds = filterDebugRounds(records.rounds, filters)

  useEffect(() => {
    if (lastSession.current === sessionId) return
    lastSession.current = sessionId
    setDetail({ kind: 'list' })
    setFilters(emptyDebugFilters)
    setHighlightId(null)
    setPendingFocus(null)
    setEditingRound(false)
  }, [sessionId])

  useEffect(() => {
    if (lastSurface.current !== surface) {
      lastSurface.current = surface
      setDetail({ kind: 'list' })
      setFilters(emptyDebugFilters)
      setHighlightId(null)
    }
  }, [surface])

  useEffect(() => {
    if (detail.kind === 'tool' && !tool || detail.kind === 'round' && !round) {
      setDetail({ kind: 'list' })
      setFilters(emptyDebugFilters)
      setHighlightId(null)
    }
  }, [detail, tool, round])

  useEffect(() => {
    if (filters.turnId && !turns.some(([id]) => id === filters.turnId)) setFilters(emptyDebugFilters)
  }, [filters.turnId, turns])

  useEffect(() => {
    if (!request || request === lastRequest.current) return
    const exists = request.kind === 'tool' ? records.calls.some(call => call.id === request.id) : records.rounds.some(item => item.id === request.id)
    if (!exists) return
    lastRequest.current = request
    setFilters(emptyDebugFilters)
    setDetail({ kind: 'list' })
    setHighlightId(request.id)
    setPendingFocus(request.id)
  }, [request, records])

  useEffect(() => {
    if (!pendingFocus || detail.kind !== 'list') return
    const node = cardNodes.current.get(pendingFocus)
    if (!node) return
    node.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    node.focus({ preventScroll: true })
    setPendingFocus(null)
  }, [pendingFocus, detail, filteredCalls, filteredRounds])

  useEffect(() => {
    if (detail.kind === 'list') return
    detailTitle.current?.focus({ preventScroll: true })
    detailTitle.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [detail])

  const openTool = (call: DebugToolCall, fromRound?: string) => setDetail({ kind: 'tool', id: call.id, fromRound })
  const openRound = (item: DebugRound) => { setDetail({ kind: 'round', id: item.id }); setRoundTab('request'); setEditingRound(false) }
  const back = () => {
    if (detail.kind === 'tool' && detail.fromRound) {
      setDetail({ kind: 'round', id: detail.fromRound })
    } else {
      if (detail.kind !== 'list') { setHighlightId(detail.id); setPendingFocus(detail.id) }
      setDetail({ kind: 'list' })
    }
  }
  const duration = (value: number | null) => value === null ? t('experiments.notRecorded') : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`
  const execution = (ordinal: number) => t('experiments.executionOrdinal', { ordinal })
  const updateFilter = <K extends keyof DebugFilters>(key: K, value: DebugFilters[K]) => setFilters(current => ({ ...current, [key]: value }))
  const artifact = (item: DebugRound | DebugToolCall) => item.source !== 'fixture' ? null : ['R03', 'R04'].includes(item.sourceRoundId) ? 'brief' : item.sourceRoundId === 'R09' ? 'sources' : item.sourceRoundId === 'R10' ? 'outline' : null
  const artifactButton = (item: DebugRound | DebugToolCall) => {
    const id = artifact(item)
    return id && onArtifact ? <button type="button" className="debug-text-button" onClick={() => onArtifact(id)}><FileText size={13} />{id === 'brief' ? t('experiments.previewBrief') : id === 'sources' ? t('experiments.previewSources') : t('experiments.previewOutline')}<ArrowUpRight size={12} /></button> : null
  }
  const simulate = (kind: 'tool' | 'round', id: string, value: Record<string, unknown>) => {
    const receipt = createDebugSimulationReceipt(kind, id, value, crypto.randomUUID(), Date.now())
    setReceipts(current => ({ ...current, [id]: [...current[id] ?? [], receipt] }))
  }
  const receiptList = (id: string) => receipts[id]?.length ? <DetailSection title={t('experiments.localSimulations')} aside={<span>{receipts[id]!.length}</span>}>
    <ol className="debug-receipts">{receipts[id]!.map((receipt, index) => <li key={receipt.id}><details open={index === receipts[id]!.length - 1}><summary><FlaskConical size={13} /><strong>{t('experiments.simulatedRequestOrdinal', { ordinal: index + 1 })}</strong><time>{new Date(receipt.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><ChevronDown size={12} /></summary><p>{t('experiments.requestPreviewCreatedNoRealToolOrIsUnchanged')}</p><JsonView value={receipt.request} empty="" /></details></li>)}</ol>
  </DetailSection> : null

  const renderEditor = (kind: 'tool' | 'round', id: string, original: Record<string, unknown>, disabled: boolean) => {
    const text = drafts[id] ?? pretty(original)
    const parsed = parseDebugArguments(text)
    const validRound = kind !== 'round' || parsed.ok && isValidRoundRequest(parsed.value)
    const valid = parsed.ok && validRound
    const changed = text !== pretty(original)
    const error = !parsed.ok ? parsed.error === 'invalid-json' ? t('experiments.invalidJson') : t('experiments.parametersMustBeAJsonObjectNotOrNull') : !validRound ? t('experiments.theRequestNeedsAMessagesArrayWithToolsArray') : null
    return <div className="debug-editor">
      <label htmlFor={`${editorId}-${kind}`}>{kind === 'tool' ? t('experiments.argumentsEditable') : t('experiments.roundRequestEditableExample')}<span>{changed ? t('experiments.modified') : 'JSON'}</span></label>
      <textarea id={`${editorId}-${kind}`} spellCheck={false} value={text} aria-invalid={!valid} aria-describedby={error ? `${editorId}-error` : undefined} onChange={event => setDrafts(current => ({ ...current, [id]: event.target.value }))} />
      {error && <p id={`${editorId}-error`} className="debug-validation-error" role="alert">{error}</p>}
      <div className="debug-editor-actions"><button type="button" className="debug-secondary-button" disabled={!changed} onClick={() => setDrafts(current => ({ ...current, [id]: pretty(original) }))}><RotateCcw size={13} />{t('experiments.reset')}</button><button type="button" className="debug-primary-button" disabled={!valid || disabled} onClick={() => { if (parsed.ok && validRound && !disabled) simulate(kind, id, kind === 'tool' ? { tool: tool!.name, arguments: parsed.value } : parsed.value) }}><Play size={13} />{kind === 'tool' ? t('experiments.simulateRerun') : t('experiments.simulateRound')}</button></div>
      <div className="debug-preview-feedback" role="status">{!!receipts[id]?.length && <><FlaskConical size={12} /><span>{receipts[id]!.length === 1 ? t('experiments.countSimulatedRequestCreatedSeeTheRequestRecordsBelow', { count: receipts[id]!.length }) : t('experiments.countSimulatedRequestsCreatedSeeTheRequestRecordsBelow', { count: receipts[id]!.length })}</span></>}</div>
      <p className="debug-panel-hint">{disabled ? t('experiments.runningRecordsCannotBeRerunYet') : t('experiments.thisCreatesALocalRequestPreviewRealExecutionService')}</p>
    </div>
  }

  return <div className="debug-workbench-panel" aria-label={surface === 'tools' ? t('experiments.toolDebuggingWorkbench') : t('experiments.agentRoundDebuggingWorkbench')}>
    {detail.kind === 'list' ? <>
      <div className="debug-list-toolbar">
        <label className="debug-search"><Search size={14} /><input aria-label={surface === 'tools' ? t('experiments.searchToolCalls') : t('experiments.searchAgentRounds')} placeholder={surface === 'tools' ? t('experiments.searchToolOrSummary') : t('experiments.searchRoundOrStage')} value={filters.query} onChange={event => updateFilter('query', event.target.value)} /></label>
        {surface === 'tools' && <select className="debug-tool-select" aria-label={t('experiments.filterByToolName')} value={filters.name} onChange={event => updateFilter('name', event.target.value)}><option value="">{t('experiments.allTools')}</option>{callNames.map(name => <option key={name} value={name}>{name}</option>)}</select>}
        <div className="debug-filter-row"><select aria-label={t('experiments.filterByExecution')} value={filters.turnId} onChange={event => updateFilter('turnId', event.target.value)}><option value="">{t('experiments.allExecutions')}</option>{turns.map(([id, ordinal]) => <option key={id} value={id}>{execution(ordinal)}</option>)}</select><select aria-label={t('experiments.filterByStatus')} value={filters.status} onChange={event => updateFilter('status', event.target.value as DebugFilters['status'])}><option value="">{t('experiments.allStatuses')}</option>{(['success', 'error', 'running', 'cancelled', 'waiting', 'example'] as const).map(status => <option key={status} value={status}>{statusText(status, t, surface === 'rounds')}</option>)}</select></div>
        <div className="debug-list-caption"><span>{surface === 'tools' ? t('experiments.countCalls', { count: filteredCalls.length }) : t('experiments.countRounds', { count: filteredRounds.length })}</span><span><FlaskConical size={11} />{t('experiments.frontendSamples')}</span></div>
      </div>
      <div className="debug-record-list">
        {surface === 'tools' ? filteredCalls.map(call => <button type="button" key={call.id} ref={node => { if (node) cardNodes.current.set(call.id, node); else cardNodes.current.delete(call.id) }} data-debug-call-id={call.id} className={`debug-record-card ${highlightId === call.id ? 'is-highlighted' : ''}`} onClick={() => openTool(call)}>
          <span className="debug-record-top"><span className={`debug-record-icon is-${call.status}`}><Wrench size={16} /></span><span className="debug-record-heading"><strong>{call.name}</strong><span>{execution(call.turnOrdinal)} · {call.roundLabel} · {call.stageLabel}</span></span><ChevronRight size={14} /></span>
          <p>{call.summary}</p><span className="debug-record-bottom"><Status status={call.status} t={t} /><span><Clock3 size={11} />{duration(call.durationMs)}</span></span>
        </button>) : filteredRounds.map(item => <button type="button" key={item.id} ref={node => { if (node) cardNodes.current.set(item.id, node); else cardNodes.current.delete(item.id) }} data-debug-round-id={item.id} className={`debug-record-card ${highlightId === item.id ? 'is-highlighted' : ''}`} onClick={() => openRound(item)}>
          <span className="debug-record-top"><span className="debug-round-number">{item.label}</span><span className="debug-record-heading"><strong>{item.title}</strong><span>{execution(item.turnOrdinal)} · {item.stageLabel}</span></span><ChevronRight size={14} /></span>
          <p>{item.summary}</p><span className="debug-record-bottom"><Status status={item.status} t={t} round /><span>{t('experiments.countToolCalls', { count: item.calls.length })}{item.calls.some(call => call.status === 'error') && t('experiments.countFailed', { count: item.calls.filter(call => call.status === 'error').length })}</span></span>
        </button>)}
        {(surface === 'tools' ? filteredCalls : filteredRounds).length === 0 && <div className="debug-panel-empty">{surface === 'tools' ? <Wrench size={24} /> : <BrainCircuit size={24} />}<strong>{(surface === 'tools' ? records.calls : records.rounds).length ? t('experiments.noMatchingRecords') : t('experiments.noDebugRecordsYet')}</strong><p>{t('experiments.runATestOrAdjustTheFiltersSeeRecords')}</p>{Object.values(filters).some(Boolean) && <button type="button" className="debug-text-button" onClick={() => setFilters(emptyDebugFilters)}>{t('experiments.clearFilters')}</button>}</div>}
      </div>
    </> : <>
      <button type="button" className="debug-back-button" onClick={back}><ArrowLeft size={14} />{detail.kind === 'tool' && detail.fromRound ? t('experiments.backToRound') : t('experiments.backToList')}</button>
      {tool ? <>
        <div className="debug-detail-title"><h3 ref={detailTitle} tabIndex={-1}><Wrench size={18} />{tool.name}</h3><Status status={tool.status} t={t} /><p>{tool.summary}</p></div>
        <dl className="debug-record-meta"><div><dt>{t('experiments.execution')}</dt><dd>{execution(tool.turnOrdinal)}</dd></div><div><dt>{t('experiments.agentRound')}</dt><dd>{round ? <button type="button" className="debug-text-button" onClick={() => openRound(round)}>{tool.roundLabel}<ArrowUpRight size={11} /></button> : tool.roundLabel}</dd></div><div><dt>{t('experiments.stage')}</dt><dd>{tool.stageLabel}</dd></div><div><dt>{t('experiments.duration')}</dt><dd>{duration(tool.durationMs)}</dd></div><div><dt>{t('experiments.startedAt')}</dt><dd>{tool.startedAt === null ? t('experiments.notRecorded') : new Date(tool.startedAt).toLocaleString(locale)}</dd></div></dl>
        <div className="debug-detail-links">{round && <button type="button" className="debug-text-button" onClick={() => onLocateRound(round)}><LocateFixed size={13} />{t('experiments.locateInConversation')}</button>}{artifactButton(tool)}</div>
        {renderEditor('tool', tool.id, tool.arguments, tool.status === 'running')}
        <DetailSection title={t('experiments.originalResult')} aside={<span>{t('experiments.readOnly')}</span>}>
          {tool.error && <div className="debug-tool-error"><CircleAlert size={14} /><span>{tool.error}</span></div>}
          <JsonView value={tool.result} empty={t('experiments.noResultWasRecorded')} />
        </DetailSection>
        {renderToolExtra?.(tool)}
        {receiptList(tool.id)}
      </> : round ? <>
        <div className="debug-detail-title"><h3 ref={detailTitle} tabIndex={-1}><span className="debug-round-number">{round.label}</span>{round.title}</h3><Status status={round.status} t={t} round /><p>{execution(round.turnOrdinal)} · {round.stageLabel}</p></div>
        <div className="debug-detail-links"><button type="button" className="debug-text-button" onClick={() => onLocateRound(round)}><LocateFixed size={13} />{t('experiments.locateInConversation')}</button>{artifactButton(round)}</div>
        <RoundMetricsBar metrics={round.metrics} />
        <div className="debug-round-tabs" role="tablist" aria-label={t('experiments.roundDetails')}>{debugRoundTabs.map(tab => <button type="button" role="tab" id={`${editorId}-tab-${tab}`} aria-controls={`${editorId}-panel-${tab}`} aria-selected={roundTab === tab} tabIndex={roundTab === tab ? 0 : -1} key={tab} ref={node => { if (node) tabNodes.current.set(tab, node); else tabNodes.current.delete(tab) }} onClick={() => setRoundTab(tab)} onKeyDown={event => {
          const next = nextDebugRoundTab(tab, event.key)
          if (!next) return
          event.preventDefault()
          setRoundTab(next)
          tabNodes.current.get(next)?.focus()
        }}>{tab === 'request' ? t('experiments.request') : tab === 'response' ? t('experiments.outputTools') : t('experiments.cognitive')}</button>)}</div>
        <div role="tabpanel" id={`${editorId}-panel-request`} aria-labelledby={`${editorId}-tab-request`} hidden={roundTab !== 'request'} tabIndex={0}>
          <p className="debug-provenance"><FlaskConical size={13} />{round.promptMessages.some(message => message.fidelity === 'illustrative') ? t('experiments.thisIsAnIllustrativeRequestNotTheAModel') : t('experiments.showingRecordedRequestFieldsMissingFieldsAreNotFabricated')}</p>
          <dl className="debug-record-meta"><div><dt>{t('experiments.model')}</dt><dd>{round.model ?? t('experiments.notRecorded')}</dd></div></dl>
          <DetailSection title={t('experiments.promptMessages')} aside={<span>{round.promptMessages.length}</span>}>
            {round.promptMessages.length ? <ol className="debug-prompt-messages">{round.promptMessages.map((message, index) => <li key={message.id}><details open><summary><code>{message.role}</code><strong>{message.label}</strong><span>{index + 1}</span><ChevronDown size={12} /></summary><pre>{message.content}</pre></details></li>)}</ol> : <p className="debug-empty-value">{t('experiments.promptWasNotRecorded')}</p>}
          </DetailSection>
          <DetailSection title={t('experiments.toolDefinitions')} aside={<span>{round.toolDefinitions.length}</span>}>
            <div className="debug-tool-definitions">{round.toolDefinitions.map(definition => <details key={definition.name}><summary><Braces size={13} /><code>{definition.name}</code><ChevronDown size={12} /></summary><p>{definition.description}</p><JsonView value={definition.schema} empty={t('experiments.theCompleteToolSchemaWasNotRecorded')} /></details>)}</div>
          </DetailSection>
          <details className="debug-model-options"><summary>{t('experiments.modelOptions')}<ChevronDown size={12} /></summary><JsonView value={round.modelOptions} empty={t('experiments.modelOptionsWereNotRecorded')} /></details>
        </div>
        <div role="tabpanel" id={`${editorId}-panel-response`} aria-labelledby={`${editorId}-tab-response`} hidden={roundTab !== 'response'} tabIndex={0}>
          <DetailSection title={t('experiments.modelResponse')}><ModelResponseContent output={round.output} thinking={round.thinking} outputFidelity={round.outputFidelity} thinkingFidelity={round.thinkingFidelity} /></DetailSection>
          <DetailSection title={t('experiments.returnedToolCallsAndResults')} aside={<span>{round.calls.length}</span>}>
            <div className="debug-round-calls">{round.calls.map(call => <button type="button" key={call.id} onClick={() => openTool(call, round.id)}><Wrench size={14} /><span><strong>{call.name}</strong><small>{call.summary}</small></span><Status status={call.status} t={t} /><ChevronRight size={12} /></button>)}</div>
            {!round.calls.length && <p className="debug-empty-value">{t('experiments.noToolCallsAreRecordedForThisRound')}</p>}
          </DetailSection>
        </div>
        <div role="tabpanel" id={`${editorId}-panel-state`} aria-labelledby={`${editorId}-tab-state`} hidden={roundTab !== 'state'} tabIndex={0}>
          {round.inspectionSource === 'example' && <p className="debug-provenance"><FlaskConical size={13} />{t('experiments.theFollowingWorkflowNotesWereWrittenForRecordedDecisions')}</p>}
          <DetailSection title={round.inspectionSource === 'example' ? t('experiments.demoNotes') : t('experiments.roundDecision')}><p className="debug-decision">{round.decision || t('experiments.noDecisionWasRecorded')}</p>{round.evidence.length > 0 && <ul className="debug-evidence">{round.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}</DetailSection>
          <DetailSection title={t('experiments.stateBefore')}><JsonView value={round.beforeState} empty={t('experiments.aCompleteStateSnapshotWasNotRecorded')} /></DetailSection>
          <DetailSection title={t('experiments.stateAfter')}><JsonView value={round.afterState} empty={t('experiments.aCompleteStateSnapshotWasNotRecorded')} /></DetailSection>
        </div>
        <div className="debug-round-replay"><button type="button" className="debug-secondary-button" aria-expanded={editingRound} onClick={() => setEditingRound(value => !value)}><Braces size={13} />{t('experiments.editRequestSimulateRound')}<ChevronDown size={12} /></button>{editingRound && renderEditor('round', round.id, roundRequest(round), round.status === 'running')}</div>
        {receiptList(round.id)}
      </> : <p className="debug-empty-value">{t('experiments.thisRecordIsUnavailableReturnToTheList')}</p>}
    </>}
  </div>
}
