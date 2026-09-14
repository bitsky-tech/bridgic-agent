import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, BrainCircuit, Check, ChevronRight, Circle, Clock3, GitBranch, Square, UserRound, Wrench } from 'lucide-react'
import { useI18n, createTranslator } from '../i18n'
import type { DemoScenario } from './demo-data'
import type { ExperimentSession, ExperimentTurn } from './experiment-state'
import type { DebugRecords, DebugRecordStatus } from './debug-record-types'
import './session-execution.css'
import { RoundMetricsBar } from './RoundMetricsBar'
import { ModelResponseContent } from './ModelResponseContent'

export interface SessionStageFocus { stageId: string; turnId?: string }
interface Props {
  session: ExperimentSession
  scenario: DemoScenario
  focusRequest: SessionStageFocus | null
  onFocusHandled: () => void
  onStageChange: (stageId: string) => void
  initialTrace?: ReactNode
  debugRecords?: DebugRecords
  onOpenTool?: (id: string) => void
  onOpenRound?: (id: string) => void
}
type Locale = 'zh-CN' | 'en-US'
type StageStatus = 'inherited' | 'completed' | 'running' | 'cancelled' | 'awaiting' | 'pending'
const lightLogo = new URL('../../../desktop/apps/electron/src/renderer/assets/icon-light.svg', import.meta.url).href
const darkLogo = new URL('../../../desktop/apps/electron/src/renderer/assets/icon-dark.svg', import.meta.url).href

export function executionStageStatus(turn: ExperimentTurn, index: number): StageStatus {
  if (index < turn.startStageIndex) return 'inherited'
  if (index < turn.completedStages) return 'completed'
  return index === turn.completedStages && turn.status !== 'completed' ? turn.status : 'pending'
}

/** Navigation defaults to the latest turn, including its unstarted or inherited stages. */
export function resolveStageTurn(session: ExperimentSession, scenario: DemoScenario, request: SessionStageFocus): ExperimentTurn | undefined {
  const index = scenario.stages.findIndex(stage => stage.id === request.stageId)
  if (index < 0) return undefined
  if (request.turnId) return session.turns.find(turn => turn.id === request.turnId)
  return session.turns.at(-1)
}

export interface SessionPromptMessage { role: 'user' | 'system'; content: string; source: 'user_message' | 'execution_state'; turnId: string }

/** Slice at the requested turn so later messages never leak into an earlier request preview. */
export function getTurnPromptHistory(session: ExperimentSession, turnId: string, scenario: DemoScenario, locale: Locale): SessionPromptMessage[] {
  const index = session.turns.findIndex(turn => turn.id === turnId)
  if (index < 0) return []
  const t = createTranslator(locale)
  const messages: SessionPromptMessage[] = []
  session.turns.slice(0, index + 1).forEach((turn, previousIndex) => {
    messages.push({ role: 'user', content: turn.input, source: 'user_message', turnId: turn.id })
    if (previousIndex === index) return
    const stage = scenario.stages[Math.min(turn.completedStages, scenario.stages.length - 1)]
    const state = turn.status === 'cancelled'
      ? t('experiments.turnStoppedAtStage', { ordinal: previousIndex + 1, stage: stage?.title ?? t('experiments.unknownStage') })
      : turn.status === 'awaiting'
        ? t('experiments.turnAwaitingAtStage', { ordinal: previousIndex + 1, stage: stage?.title ?? t('experiments.currentStage') })
        : turn.status === 'completed'
          ? t('experiments.turnSimulationCompleted', { ordinal: previousIndex + 1 })
          : t('experiments.turnSimulationRunning', { ordinal: previousIndex + 1 })
    messages.push({ role: 'system', content: state, source: 'execution_state', turnId: turn.id })
  })
  return messages
}

export function SessionExecutionTimeline({ session, scenario, focusRequest, onFocusHandled, onStageChange, initialTrace, debugRecords, onOpenTool, onOpenRound }: Props) {
  const { locale, t } = useI18n()
  const timelineId = useId()
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const initialTraceRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [focused, setFocused] = useState<string | null>(null)

  useEffect(() => {
    if (!focusRequest) return
    const turn = resolveStageTurn(session, scenario, focusRequest)
    if (!turn) { onFocusHandled(); return }
    const key = `${turn.id}:${focusRequest.stageId}`
    setExpanded(previous => ({ ...previous, [key]: true }))
    setFocused(key)
    const frame = window.requestAnimationFrame(() => {
      const fixture = session.source === 'presentation-trace-demo' && turn === session.turns[0]
      const node = fixture
        ? Array.from(initialTraceRef.current?.querySelectorAll<HTMLElement>('[data-stage-id]') ?? []).find(element => element.dataset.stageId === focusRequest.stageId)?.querySelector<HTMLButtonElement>('.exec-branch-toggle')
        : nodeRefs.current.get(key)
      const container = node?.closest<HTMLElement>('.trace-review')
      if (node && container) {
        container.scrollTo({ top: container.scrollTop + node.getBoundingClientRect().top - container.getBoundingClientRect().top - 16, behavior: 'auto' })
        node.focus({ preventScroll: true })
      }
      onFocusHandled()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusRequest, session, scenario, onFocusHandled])

  function statusLabel(status: StageStatus) {
    return status === 'completed' ? t('experiments.complete')
      : status === 'running' ? t('experiments.turnSimulating')
        : status === 'cancelled' ? t('experiments.stoppedHere')
          : status === 'awaiting' ? t('experiments.awaitingInput')
            : status === 'inherited' ? t('experiments.notRerun') : t('experiments.notStarted')
  }
  function callStatusLabel(status: DebugRecordStatus) {
    return status === 'success' ? t('experiments.succeeded') : status === 'error' ? t('experiments.failed') : status === 'running' ? t('experiments.running') : status === 'cancelled' ? t('experiments.stopped') : status === 'waiting' ? t('experiments.waiting') : t('experiments.exampleBadge')
  }
  function policyText(turn: ExperimentTurn) {
    const start = scenario.stages[turn.startStageIndex]?.title ?? scenario.stages[0]!.title
    return turn.continuation === 'reassess'
      ? t('experiments.reassessPolicy', { start })
      : turn.continuation === 'continue'
        ? t('experiments.continuePolicy', { start })
        : t('experiments.initialSimulationPolicy', { start })
  }

  return <section className="session-execution" aria-label={t('experiments.sessionExecutionHistory')}>
    <header className="session-execution-heading"><div><h1>{t('experiments.testConversation')}</h1><p>{t('experiments.selectAToolOrRoundToInspectTheRight')}</p></div><span>{session.turns.length} {t('experiments.turns')}</span></header>
    <ol className="session-turns">{session.turns.map((turn, turnIndex) => {
      const fixture = turnIndex === 0 && session.source === 'presentation-trace-demo' && initialTrace
      const stoppedStage = scenario.stages[Math.min(turn.completedStages, scenario.stages.length - 1)]
      const turnLabel = t('experiments.turnOrdinal', { ordinal: turnIndex + 1 })
      const executionLabel = turn.status === 'running' ? t('experiments.turnSimulating') : turn.status === 'cancelled' ? t('experiments.stopped') : turn.status === 'awaiting' ? t('experiments.awaitingInput') : t('experiments.turnSimulationComplete')
      return <li key={turn.id} className="session-turn" data-turn-id={turn.id}>
        <article className="session-user-message" data-message-role="user" aria-label={t('experiments.turnUserMessage', { turnLabel })}><header><UserRound size={13} aria-hidden="true" /><strong>{t('experiments.you')}</strong><span>{turnLabel}</span></header><p>{turn.input}</p></article>
        <article className="session-agent-message" data-message-role="agent" aria-label={`${turnLabel} · Bridgic Agent`}>
        <header className="session-agent-heading"><span className="session-agent-avatar" aria-hidden="true"><img className="session-agent-logo-light" src={lightLogo} alt="" width={26} height={26} draggable={false} /><img className="session-agent-logo-dark" src={darkLogo} alt="" width={26} height={26} draggable={false} /></span><h2>Bridgic Agent</h2><span className={`session-agent-meta is-${turn.status}`}>{turnLabel}<span aria-hidden="true"> · </span>{executionLabel}</span></header>
        <div className="session-agent-body">
        <div className="session-turn-origin"><GitBranch size={13} /><p>{fixture ? t('experiments.pptTestExampleResponseTextAndThinkingHistoricalRecord') : policyText(turn)}</p></div>
        {fixture ? <div className="session-initial-trace" ref={initialTraceRef}>{initialTrace}</div> : <ul className="session-stage-tree">{scenario.stages.map((stage, index) => {
          const key = `${turn.id}:${stage.id}`
          const state = executionStageStatus(turn, index)
          const reached = !['pending', 'inherited'].includes(state)
          const open = expanded[key] ?? reached
          const records = reached ? debugRecords?.rounds.filter(record => record.turnId === turn.id && record.stageId === stage.id) ?? [] : []
          return <li key={stage.id} className={`session-stage is-${state}${focused === key ? ' is-focused' : ''}`} data-stage-id={stage.id}>
            <button ref={node => { if (node) nodeRefs.current.set(key, node); else nodeRefs.current.delete(key) }} className="session-stage-toggle" aria-expanded={open} aria-controls={`${timelineId}-${turnIndex}-${stage.id}`} onClick={() => { setExpanded(previous => ({ ...previous, [key]: !open })); onStageChange(stage.id) }}>
              <ChevronRight size={13} /><BrainCircuit size={15} /><span><strong>{stage.title}</strong><code>{stage.id}</code></span><small className={`session-stage-state is-${state}`}>{state === 'completed' ? <Check size={12} /> : state === 'cancelled' ? <Square size={10} /> : state === 'running' || state === 'awaiting' ? <Clock3 size={12} /> : <Circle size={11} />}{statusLabel(state)}</small>
            </button>
            <div id={`${timelineId}-${turnIndex}-${stage.id}`} className="session-stage-body" hidden={!open}>
              {!reached ? <p className="session-stage-empty">{state === 'inherited' ? t('experiments.theContinuationPolicyRetainedTheEarlierStageExecutedAgain') : t('experiments.thisTurnDidNotReachThisStage')}</p> : <>
                {records.length === 0 && <p className="session-stage-purpose">{stage.description}</p>}
                {records.map(record => <section className="session-stage-record" key={record.id} data-debug-round-id={record.id}>
                  <ModelResponseContent output={record.output} thinking={record.thinking} outputFidelity={record.outputFidelity} thinkingFidelity={record.thinkingFidelity} />
                  {record.calls.length > 0 && <ul className="session-compact-calls" aria-label={t('experiments.toolCallsForStage', { stage: stage.title })}>{record.calls.map((call, callIndex) => <li key={call.id}>
                    <button className="session-tool-link" data-debug-call-id={call.id} disabled={!onOpenTool} onClick={() => onOpenTool?.(call.id)} aria-label={t('experiments.inspectToolCallToolTurnOrdinalRoundCallordinal', { tool: call.name, ordinal: call.turnOrdinal, round: record.label, callOrdinal: callIndex + 1 })}>
                      <Wrench size={13} /><code>{call.name}</code><span className="session-call-summary" title={call.summary}>{call.summary}</span><span className={`session-call-status is-${call.status}`}>{call.status === 'error' ? <AlertCircle size={11} /> : call.status === 'success' ? <Check size={11} /> : null}{callStatusLabel(call.status)}</span><ChevronRight size={12} />
                    </button>
                  </li>)}</ul>}
                  <footer className="session-round-footer"><RoundMetricsBar metrics={record.metrics} /><button className="session-round-link" aria-label={t('experiments.inspectRoundTurnOrdinalRound', { ordinal: record.turnOrdinal, round: record.label })} disabled={!onOpenRound} onClick={() => onOpenRound?.(record.id)}><BrainCircuit size={12} /><code>{record.label}</code><ChevronRight size={12} /></button></footer>
                </section>)}
                {state === 'cancelled' && <p className="session-stop-note">{t('experiments.thisTurnStoppedHereThisStageHasCompletionReceipt')}</p>}
                {records.length === 0 && <p className="session-mock-note">{t('experiments.stageProgressIsSimulatedByTheFrontendNotConnected')}</p>}

              </>}
            </div>
          </li>
        })}</ul>}
        {turn.status !== 'running' && <div className={`session-turn-end is-${turn.status}`}><span>{turn.status === 'cancelled' ? <Square size={11} /> : turn.status === 'awaiting' ? <Clock3 size={13} /> : <Check size={13} />}</span><div><strong>{turn.status === 'cancelled' ? t('experiments.stoppedStage', { stage: stoppedStage?.title ?? '' }) : turn.status === 'awaiting' ? t('experiments.awaitingUserInput') : t('experiments.thisSimulatedTurnCompleted')}</strong><p>{turn.status === 'cancelled' ? t('experiments.stoppingEndsOnlyThisTurnSendAnotherHistoryRetained') : turn.status === 'awaiting' ? t('experiments.thisSnapshotPreservesItsWaitingStateSubsequentAppendedBelow') : t('experiments.addAnotherRequestInThisSessionToTestTurn')}</p></div></div>}
        </div>
        </article>
      </li>
    })}</ol>
  </section>
}
