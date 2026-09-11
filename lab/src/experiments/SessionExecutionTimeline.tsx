import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, BrainCircuit, Check, ChevronRight, Circle, Clock3, GitBranch, Square, UserRound, Wrench } from 'lucide-react'
import { useI18n } from '../i18n'
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
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const messages: SessionPromptMessage[] = []
  session.turns.slice(0, index + 1).forEach((turn, previousIndex) => {
    messages.push({ role: 'user', content: turn.input, source: 'user_message', turnId: turn.id })
    if (previousIndex === index) return
    const stage = scenario.stages[Math.min(turn.completedStages, scenario.stages.length - 1)]
    const state = turn.status === 'cancelled'
      ? t(`第 ${previousIndex + 1} 轮已由用户停止，停止位置：${stage?.title ?? '未知阶段'}。未完成的阶段没有完成回执。`, `Turn ${previousIndex + 1} was stopped by the user at ${stage?.title ?? 'an unknown stage'}. Unfinished stages have no completion receipt.`)
      : turn.status === 'awaiting'
        ? t(`第 ${previousIndex + 1} 轮停留在${stage?.title ?? '当前阶段'}，等待用户输入；不能据此推断用户已确认。`, `Turn ${previousIndex + 1} is awaiting user input at ${stage?.title ?? 'the current stage'}; this does not imply user approval.`)
        : turn.status === 'completed'
          ? t(`第 ${previousIndex + 1} 轮模拟执行完成。`, `Turn ${previousIndex + 1} completed its simulated execution.`)
          : t(`第 ${previousIndex + 1} 轮正在模拟执行。`, `Turn ${previousIndex + 1} is running in the simulation.`)
    messages.push({ role: 'system', content: state, source: 'execution_state', turnId: turn.id })
  })
  return messages
}

export function SessionExecutionTimeline({ session, scenario, focusRequest, onFocusHandled, onStageChange, initialTrace, debugRecords, onOpenTool, onOpenRound }: Props) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
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
    return status === 'completed' ? t('已完成', 'Complete')
      : status === 'running' ? t('模拟执行中', 'Simulating')
        : status === 'cancelled' ? t('在此停止', 'Stopped here')
          : status === 'awaiting' ? t('等待输入', 'Awaiting input')
            : status === 'inherited' ? t('本轮未重跑', 'Not rerun') : t('尚未执行', 'Not started')
  }
  function callStatusLabel(status: DebugRecordStatus) {
    return status === 'success' ? t('成功', 'Succeeded') : status === 'error' ? t('失败', 'Failed') : status === 'running' ? t('执行中', 'Running') : status === 'cancelled' ? t('已停止', 'Stopped') : status === 'waiting' ? t('等待', 'Waiting') : t('示例', 'Example')
  }
  function policyText(turn: ExperimentTurn) {
    const start = scenario.stages[turn.startStageIndex]?.title ?? scenario.stages[0]!.title
    return turn.continuation === 'reassess'
      ? t(`本轮模拟策略：携带已有对话，从「${start}」重新评估。`, `Simulation policy: retain the conversation and reassess from “${start}”.`)
      : turn.continuation === 'continue'
        ? t(`本轮模拟策略：携带已有对话，从「${start}」继续；本轮之前的记录保持原样。`, `Simulation policy: retain the conversation and continue from “${start}”; earlier records remain unchanged.`)
        : t(`本轮从「${start}」开始模拟执行。`, `This simulation starts at “${start}”.`)
  }

  return <section className="session-execution" aria-label={t('会话执行过程', 'Session execution history')}>
    <header className="session-execution-heading"><div><h1>{t('测试对话', 'Test conversation')}</h1><p>{t('点击工具或循环，在右侧查看请求与结果。', 'Select a tool or round to inspect its request and result on the right.')}</p></div><span>{session.turns.length} {t('轮', 'turns')}</span></header>
    <ol className="session-turns">{session.turns.map((turn, turnIndex) => {
      const fixture = turnIndex === 0 && session.source === 'presentation-trace-demo' && initialTrace
      const stoppedStage = scenario.stages[Math.min(turn.completedStages, scenario.stages.length - 1)]
      const turnLabel = t(`第 ${turnIndex + 1} 轮`, `Turn ${turnIndex + 1}`)
      const executionLabel = turn.status === 'running' ? t('模拟执行中', 'Simulating') : turn.status === 'cancelled' ? t('已停止', 'Stopped') : turn.status === 'awaiting' ? t('等待输入', 'Awaiting input') : t('模拟完成', 'Simulation complete')
      return <li key={turn.id} className="session-turn" data-turn-id={turn.id}>
        <article className="session-user-message" data-message-role="user" aria-label={t(`${turnLabel} · 用户消息`, `${turnLabel} · User message`)}><header><UserRound size={13} aria-hidden="true" /><strong>{t('你', 'You')}</strong><span>{turnLabel}</span></header><p>{turn.input}</p></article>
        <article className="session-agent-message" data-message-role="agent" aria-label={`${turnLabel} · Bridgic Agent`}>
        <header className="session-agent-heading"><span className="session-agent-avatar" aria-hidden="true"><img className="session-agent-logo-light" src={lightLogo} alt="" width={26} height={26} draggable={false} /><img className="session-agent-logo-dark" src={darkLogo} alt="" width={26} height={26} draggable={false} /></span><h2>Bridgic Agent</h2><span className={`session-agent-meta is-${turn.status}`}>{turnLabel}<span aria-hidden="true"> · </span>{executionLabel}</span></header>
        <div className="session-agent-body">
        <div className="session-turn-origin"><GitBranch size={13} /><p>{fixture ? t('PPT 测试示例 · 正文与 Thinking 来自历史记录', 'PPT test example · Response text and Thinking from a historical record') : policyText(turn)}</p></div>
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
              {!reached ? <p className="session-stage-empty">{state === 'inherited' ? t('继续策略保留了前轮的阶段位置，本轮没有再次执行这里。', 'The continuation policy retained the earlier stage position; this stage was not executed again.') : t('这一轮还没有执行到此阶段。', 'This turn did not reach this stage.')}</p> : <>
                {records.length === 0 && <p className="session-stage-purpose">{stage.description}</p>}
                {records.map(record => <section className="session-stage-record" key={record.id} data-debug-round-id={record.id}>
                  <ModelResponseContent output={record.output} thinking={record.thinking} outputFidelity={record.outputFidelity} thinkingFidelity={record.thinkingFidelity} />
                  {record.calls.length > 0 && <ul className="session-compact-calls" aria-label={t(`${stage.title}的工具调用`, `Tool calls for ${stage.title}`)}>{record.calls.map((call, callIndex) => <li key={call.id}>
                    <button className="session-tool-link" data-debug-call-id={call.id} disabled={!onOpenTool} onClick={() => onOpenTool?.(call.id)} aria-label={t(`查看工具调用 ${call.name} · 第 ${call.turnOrdinal} 轮 · ${record.label} · ${callIndex + 1}`, `Inspect tool call ${call.name} · Turn ${call.turnOrdinal} · ${record.label} · ${callIndex + 1}`)}>
                      <Wrench size={13} /><code>{call.name}</code><span className="session-call-summary" title={call.summary}>{call.summary}</span><span className={`session-call-status is-${call.status}`}>{call.status === 'error' ? <AlertCircle size={11} /> : call.status === 'success' ? <Check size={11} /> : null}{callStatusLabel(call.status)}</span><ChevronRight size={12} />
                    </button>
                  </li>)}</ul>}
                  <footer className="session-round-footer"><RoundMetricsBar metrics={record.metrics} /><button className="session-round-link" aria-label={t(`查看循环 · 第 ${record.turnOrdinal} 轮 · ${record.label}`, `Inspect round · Turn ${record.turnOrdinal} · ${record.label}`)} disabled={!onOpenRound} onClick={() => onOpenRound?.(record.id)}><BrainCircuit size={12} /><code>{record.label}</code><ChevronRight size={12} /></button></footer>
                </section>)}
                {state === 'cancelled' && <p className="session-stop-note">{t('本轮在此中断，本阶段没有完成回执。', 'This turn stopped here; this stage has no completion receipt.')}</p>}
                {records.length === 0 && <p className="session-mock-note">{t('阶段由前端计时模拟，尚未接入实际执行记录。', 'Stage progress is simulated by the frontend; actual execution records are not connected.')}</p>}

              </>}
            </div>
          </li>
        })}</ul>}
        {turn.status !== 'running' && <div className={`session-turn-end is-${turn.status}`}><span>{turn.status === 'cancelled' ? <Square size={11} /> : turn.status === 'awaiting' ? <Clock3 size={13} /> : <Check size={13} />}</span><div><strong>{turn.status === 'cancelled' ? t(`已停止 · ${stoppedStage?.title ?? ''}`, `Stopped · ${stoppedStage?.title ?? ''}`) : turn.status === 'awaiting' ? t('等待用户输入', 'Awaiting user input') : t('本轮模拟执行完成', 'This simulated turn completed')}</strong><p>{turn.status === 'cancelled' ? t('停止只结束这一轮。继续发送消息时，将保留这段执行历史。', 'Stopping ends only this turn. Send another message to continue with this history retained.') : turn.status === 'awaiting' ? t('此处保留当时的等待状态；后续消息和执行将追加在下面。', 'This snapshot preserves its waiting state; subsequent messages and execution are appended below.') : t('可以在同一会话中追加要求，开始下一轮测试。', 'Add another request in this session to start the next test turn.')}</p></div></div>}
        </div>
        </article>
      </li>
    })}</ol>
  </section>
}
