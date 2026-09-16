import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, Clock3, Crosshair, ExternalLink, FileOutput, MessageSquare, Repeat2, Wrench, X } from 'lucide-react'
import type { SessionWorkbenchExtensionProps } from '@/components/app/DesktopAppExtensions'
import { WorkbenchToolHeader, WorkbenchToolScrollArea, WorkbenchToolSurface, WorkbenchSearchField } from '@/components/app/WorkbenchToolPrimitives'
import { useDebugSession, useDebugText, type DebugPanelKind } from './DebugSessionProvider'
import { JsonRecord, ToolStatusLabel, duration, roundLabel, turnLabel } from './TraceParts'
import type { TraceRound } from './types'
import { toolStatus, type ToolInspection } from './tool-records'
import { RoundTurnList, TurnContext } from './RoundTurnList'
import { groupRoundsByTurn, userInputText } from './trace-presentation'
import { StageFilter, roundStageKey } from './StageFilter'
import { ToolCallEditor } from './ToolCallEditor'
import { RoundModelCall } from './RoundModelCall'
import { RoundToolCalls } from './RoundToolCalls'
import { RoundOverview } from './RoundOverview'
import './debug-inspector.css'
import './round-detail.css'

function ToolDetail({ call }: { call: ToolInspection }) {
  const { records, inspect, locate } = useDebugSession()
  const text = useDebugText()
  const round = call.round
  const canInspectRound = records.rounds.some(item => item.id === round.id)
  const input = userInputText(call.userInput)
  return <div className="debug-detail debug-tool-detail">
    <div className="debug-tool-identity">
      <h3><span className="debug-tool-identity-icon"><Wrench size={17} /></span><span>{call.name ?? text('unknownTool')}</span></h3>
      <div className="debug-tool-run-meta"><ToolStatusLabel call={call} /><span><Clock3 size={12} />{text('duration')} {duration(call.durationMs)}</span></div>
    </div>
    <section className="debug-inspector-card debug-inspector-source">
      <div className="debug-inspector-heading"><MessageSquare size={15} aria-hidden="true" /><h4>{text('callSource')}</h4><span className="debug-inspector-caption">{call.turnOrdinal < 0 ? text('toolWorkbench.currentTurn') : `Turn ${turnLabel(call.turnOrdinal)}`}</span></div>
      <div className="debug-inspector-body">
        <p className="debug-inspector-message">{input ?? text('userInputNotRecorded')}</p>
        <dl className="debug-tool-origin">
          <div><dt>{text('round')}</dt><dd>{roundLabel(round)}</dd></div>
          {round?.stage ? <div><dt>Stage</dt><dd>{round.stage}</dd></div> : null}
          {round?.mode ? <div><dt>{text('mode')}</dt><dd>{round.mode}</dd></div> : null}
        </dl>
      </div>
      {canInspectRound ? <div className="debug-inspector-actions">
        <button type="button" onClick={() => locate(round)}><Crosshair size={13} />{text('locateInChat')}</button>
        <button type="button" onClick={() => inspect('rounds', round.id)}><Repeat2 size={13} />{text('inspectRound')}</button>
      </div> : <p className="debug-tool-editor-note">{text('live.detailsPending')}</p>}
    </section>
    <ToolCallEditor call={call} />
    <details className="debug-inspector-card debug-tool-result" open>
      <summary className="debug-inspector-heading"><FileOutput size={15} aria-hidden="true" /><h4>{text('result')}</h4><ChevronDown className="debug-inspector-chevron" size={14} aria-hidden="true" /></summary>
      <div className="debug-inspector-body">
        <pre>{call.hasResult && call.result !== undefined ? JSON.stringify(call.result, null, 2) : text('notRecorded')}</pre>
      {call.error !== undefined && call.error !== null ? <div className="debug-tool-result-error">
        <strong>{text('error')}</strong><pre>{JSON.stringify(call.error, null, 2)}</pre>
      </div> : null}
      </div>
    </details>
  </div>
}

function RoundDetail({ round }: { round: TraceRound }) {
  const text = useDebugText()
  const { turns, inspect, locate } = useDebugSession()
  return <div className="debug-detail debug-round-detail">
    <RoundOverview round={round} />
    <details className="debug-round-input"><summary>{text('userInput')} · Turn {turnLabel(round.turnOrdinal)}</summary>
      <TurnContext turn={turns.find((turn) => turn.id === round.turnId)} ordinal={round.turnOrdinal}>
      <div className="debug-inspector-actions"><button type="button" onClick={() => locate(round)}><Crosshair size={13} />{text('locateInChat')}</button></div>
      </TurnContext>
    </details>
    <details className="debug-round-model-call" open>
      <summary>{text('modelCall.title')}</summary>
      <RoundModelCall round={round} />
    </details>
    {round.calls.length ? <details className="debug-round-support">
      <summary>{text('toolExecution')} <span>{round.calls.length}</span></summary>
      <div className="debug-round-support-body">
        <RoundToolCalls calls={round.calls} onInspect={call => inspect('tools', call.id)} />
        {round.actDurationMs != null ? <p className="debug-round-action-time"><Clock3 size={12} />{text('actionGroupDuration')} <span>{duration(round.actDurationMs)}</span></p> : null}
      </div>
    </details> : null}
    <details className="debug-round-support">
      <summary>{text('rawRecord')}</summary>
      <div className="debug-round-support-body debug-round-raw">
        <JsonRecord title={text('roundRecord')} value={round.raw} />
        <JsonRecord title={text('usageSources')} value={round.usageSources} open={false} />
        <JsonRecord title={text('usageValidation')} value={round.usageIssues} open={false} />
      </div>
    </details>
  </div>
}

function DebugPanel({ kind, active, onClose }: SessionWorkbenchExtensionProps & { kind: DebugPanelKind }) {
  const debug = useDebugSession()
  const text = useDebugText()
  const [query, setQuery] = useState('')
  const [toolName, setToolName] = useState('')
  const [status, setStatus] = useState('all')
  const [stage, setStage] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [appliedSelection, setAppliedSelection] = useState<number | null>(null)
  const tools = kind === 'tools'
  const names = useMemo(() => [...new Set(debug.toolRecords.map((call) => call.name).filter((name): name is string => Boolean(name)))].sort(), [debug.toolRecords])
  const needle = query.toLocaleLowerCase().trim()
  const calls = debug.toolRecords.filter((call) => (!toolName || call.name === toolName)
    && (status === 'all' || toolStatus(call) === status)
    && `${call.name ?? ''} ${call.sourceCallId ?? ''} ${turnLabel(call.turnOrdinal)}`.toLocaleLowerCase().includes(needle))
  const inputByTurn = new Map(debug.turns.map((turn) => [turn.id, userInputText(turn.userInput) ?? '']))
  const rounds = debug.records.rounds.filter((round) => (!stage || roundStageKey(round) === stage)
    && `${roundLabel(round)} ${round.stage ?? ''} ${round.mode ?? ''} ${round.model ?? ''} ${turnLabel(round.turnOrdinal)} ${inputByTurn.get(round.turnId) ?? ''} ${round.body ?? ''} ${round.calls.map((call) => call.name ?? '').join(' ')}`.toLocaleLowerCase().includes(needle))
  const selectedCall = tools ? debug.toolRecords.find((call) => call.id === detailId || call.aliases.includes(detailId ?? '')) : undefined
  const selectedRound = !tools ? debug.records.rounds.find((round) => round.id === detailId) : undefined

  const selection = debug.selection
  if (active && selection && selection.kind === kind && appliedSelection !== selection.nonce) {
    setAppliedSelection(selection.nonce)
    setQuery(''); setToolName(''); setStatus('all'); setStage(''); setDetailId(null); setFocusedId(selection.id)
  }
  if (!debug.loading) {
    if (detailId && !selectedCall && !selectedRound) setDetailId(null)
    if (focusedId && !(tools ? debug.toolRecords : debug.records.rounds).some((record) => record.id === focusedId)) setFocusedId(null)
    if (toolName && !names.includes(toolName)) setToolName('')
    if (stage && !debug.records.rounds.some((round) => roundStageKey(round) === stage)) setStage('')
  }
  useEffect(() => {
    if (!active || !focusedId || detailId) return
    const frame = requestAnimationFrame(() => {
      const target = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-debug-record]') ?? [])
        .find((element) => element.dataset.debugRecord === focusedId)
      const group = target?.closest<HTMLDetailsElement>('details[data-debug-turn]')
      if (group) group.open = true
      target?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedId, active, detailId, debug.selection?.nonce])
  let detail
  if (selectedCall) detail = <ToolDetail key={selectedCall.id} call={selectedCall} />
  else if (selectedRound) detail = <RoundDetail key={selectedRound.id} round={selectedRound} />
  let emptyText = text('noSavedRecords')
  if (debug.loading) emptyText = text('loadingExecutionRecords')
  else if (query || toolName || stage || status !== 'all') emptyText = text('noMatchingRecords')

  return <WorkbenchToolSurface testId={`desktop-debug-${kind}`}>
    <WorkbenchToolHeader title={tools ? text('toolCalls') : text('agentRounds')}
      icon={tools ? <Wrench size={16} /> : <Repeat2 size={16} />}
      actions={<button type="button" aria-label={text('closePanel')} onClick={onClose}><X size={16} /></button>} />
    <WorkbenchToolScrollArea className="debug-panel">
      {debug.error ? <p role="alert" className="debug-notice">{text('readFailed')} · {debug.error}</p> : null}
      {selectedCall || selectedRound ? <>
        <button className="debug-back" type="button" onClick={() => setDetailId(null)}><ArrowLeft size={13} />{text('backToList')}</button>
        {detail}
      </> : <>
        <WorkbenchSearchField query={query} onQueryChange={setQuery} clearLabel={text('clearSearch')} searchPlaceholder={tools ? text('searchToolNameOrCallId') : text('searchUserInputOutputOrTools')} />
        {!tools ? <StageFilter rounds={debug.records.rounds} value={stage} onChange={(value) => { setStage(value); setFocusedId(null) }} /> : null}
        <div className="debug-list-filters">
          <span>{text('currentSession')} · {tools ? debug.toolRecords.length : `${groupRoundsByTurn(debug.turns, rounds).length} Turn · ${rounds.length} ${text('rounds')}`}</span>
          {tools ? <><select aria-label={text('filterByTool')} value={toolName} onChange={(event) => setToolName(event.target.value)}><option value="">{text('allTools')}</option>{names.map((name) => <option key={name}>{name}</option>)}</select>
            <select aria-label={text('filterByStatus')} value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{text('allStatuses')}</option><option value="running">{text('live.running')}</option><option value="waiting">{text('live.waiting')}</option><option value="error">{text('failed')}</option><option value="success">{text('success')}</option><option value="unknown">{text('noResult')}</option></select></> : null}
        </div>
        {debug.hasMore ? <button type="button" className="debug-load-earlier" disabled={debug.loading} onClick={debug.loadMore}>{text('loadEarlierRecords')}</button> : null}
        <div ref={listRef} className="debug-record-list">
          {tools ? calls.map((call) => <button key={call.id} type="button" data-debug-record={call.id} className={`debug-record-card ${focusedId === call.id ? 'is-focused' : ''}`} onClick={() => setDetailId(call.id)}>
            <strong><Wrench size={15} /><code>{call.name ?? text('unknownTool')}</code><ExternalLink size={12} /></strong>
            <div className="debug-detail-meta"><ToolStatusLabel call={call} /><span>{duration(call.durationMs)}</span></div>
            <div className="debug-record-footer"><span>{call.turnOrdinal < 0 ? text('toolWorkbench.currentTurn') : `Turn ${turnLabel(call.turnOrdinal)}`} · {roundLabel(call.round)}</span><code>{call.sourceCallId ?? '—'}</code></div>
          </button>) : <RoundTurnList turns={debug.turns} rounds={rounds} focusedId={focusedId} onSelect={setDetailId} />}
        </div>
        {(tools ? calls : rounds).length === 0 ? <p className="debug-empty">{emptyText}</p> : null}
        <p className="debug-list-note">{text(tools ? 'toolWorkbench.liveNotice' : 'savedRecordsNotice')}</p>
        {debug.records.issues.length ? <p className="debug-notice">{text('incompleteRecordsNotice')} · {debug.records.issues.length}</p> : null}
      </>}
    </WorkbenchToolScrollArea>
  </WorkbenchToolSurface>
}

export function DebugToolsPanel(props: SessionWorkbenchExtensionProps) { return <DebugPanel key={props.sessionId} {...props} kind="tools" /> }
export function DebugRoundsPanel(props: SessionWorkbenchExtensionProps) { return <DebugPanel key={props.sessionId} {...props} kind="rounds" /> }
