import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  ArrowRight, BrainCircuit, FlaskConical, Layers3, LoaderCircle, MessageSquare, Play, Plus, X,
} from 'lucide-react'
import { useI18n } from '../i18n'
import { getDemoScenarios } from './demo-data'
import { createExperimentPreviewState, experimentReducer, type InspectorPanel, type ExperimentSession } from './experiment-state'
import './experiments.css'
import { PresentationTraceView } from './PresentationTraceView'
import type { TraceTreeFocus } from './TraceExecutionTree'
import { SessionHistoryItem } from './SessionHistoryItem'
import { ExperimentWorkbench } from './ExperimentWorkbench'
import { getPresentationTrace } from './presentation-trace-data'
import { SessionExecutionTimeline } from './SessionExecutionTimeline'
import { SessionComposer } from './SessionComposer'
import { debugCallId, debugRoundId } from './debug-record-types'

export function ExperimentWorkspace() {
  const { locale } = useI18n()
  const tr = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const scenarios = useMemo(() => getDemoScenarios(locale), [locale])
  const [state, dispatch] = useReducer(experimentReducer, undefined, createExperimentPreviewState)
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const [traceFocus, setTraceFocus] = useState<TraceTreeFocus | null>(null)
  const [timelineFocus, setTimelineFocus] = useState<{ stageId: string; turnId?: string } | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const taskRef = useRef<HTMLTextAreaElement>(null)
  const activeMode = state.modes.find(mode => mode.id === state.activeModeId)!
  const scenario = scenarios.find(item => item.id === activeMode.id)
  const activeSession = activeMode?.sessions.find(session => session.id === activeMode.activeSessionId)
  const activeTrace = useMemo(() => activeSession?.source === 'presentation-trace-demo' ? getPresentationTrace(locale) : null, [activeSession?.source, locale])
  const runningSession = activeMode?.sessions.find(session => session.status === 'running')
  const hasRunningSessions = state.modes.some(mode => mode.sessions.some(session => session.status === 'running'))
  const stages = scenario?.stages ?? []
  const selectedStage = stages.find(stage => stage.id === activeMode?.selectedStageId)
    ?? stages[Math.min(activeSession?.completedStages ?? 0, stages.length - 1)]
    ?? stages[0]
  const panel = activeMode?.panel ?? 'cognitive'

  useEffect(() => {
    if (!hasRunningSessions) return
    const timer = window.setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 250)
    return () => window.clearInterval(timer)
  }, [hasRunningSessions])

  useEffect(() => {
    const container = tabsRef.current
    const selected = container?.querySelector<HTMLElement>('.dbg-agent-tab.is-active')
    if (!container || !selected) return
    const containerBounds = container.getBoundingClientRect()
    const selectedBounds = selected.getBoundingClientRect()
    if (selectedBounds.right > containerBounds.right) container.scrollLeft += selectedBounds.right - containerBounds.right
    else if (selectedBounds.left < containerBounds.left) container.scrollLeft -= containerBounds.left - selectedBounds.left
  }, [state.activeModeId, locale])

  function setPanel(next: InspectorPanel) {
    if (activeMode) dispatch({ type: 'select-panel', modeId: activeMode.id, panel: next })
  }
  function newTest() {
    if (!activeMode) return
    setTraceFocus(null)
    setTimelineFocus(null)
    dispatch({ type: 'new-session', modeId: activeMode.id })
    setNavigatorOpen(false)
    window.requestAnimationFrame(() => taskRef.current?.focus())
  }
  function chooseSession(session: ExperimentSession) {
    setTraceFocus(null)
    setTimelineFocus(null)
    if (activeMode) dispatch({ type: 'select-session', modeId: activeMode.id, sessionId: session.id })
    setNavigatorOpen(false)
  }
  function inspectSessionStage(stageId: string, turnId: string) {
    if (!activeSession) return
    const fixtureTurn = activeSession.source === 'presentation-trace-demo' && activeSession.turns[0]?.id === turnId
    dispatch({ type: 'select-stage', modeId: activeMode.id, stageId })
    setTraceFocus(fixtureTurn ? { kind: 'stage', stageId } : null)
    setTimelineFocus(fixtureTurn ? null : { stageId, turnId })
  }
  function inspectTraceRound(roundId: string, nextPanel: InspectorPanel = 'tools') {
    const round = activeTrace?.rounds.find(item => item.id === roundId)
    if (!round) return
    setTraceFocus({ kind: 'round', roundId, panel: nextPanel })
    if (round.stage !== 'main') dispatch({ type: 'select-stage', modeId: activeMode.id, stageId: round.stage })
    setPanel(nextPanel)
  }
  return (
    <main className="debug-workspace" aria-label={tr('执行实验', 'Experiments')} onKeyDown={event => {
      if (event.key === 'Escape') setNavigatorOpen(false)
    }}>
      <header className="dbg-agent-tabs-bar">
        <div ref={tabsRef} className="dbg-agent-tabs" role="tablist" aria-label={tr('Agent 模式', 'Agent modes')}>
          {state.modes.map((mode, index) => <div className={`dbg-agent-tab ${mode.id === activeMode.id ? 'is-active' : ''}`} key={mode.id}>
            <button id={`dbg-agent-tab-${mode.id}`} role="tab" aria-selected={mode.id === activeMode.id} aria-controls="dbg-agent-content" tabIndex={mode.id === activeMode.id ? 0 : -1} onClick={() => {
              dispatch({ type: 'select-mode', modeId: mode.id }); setTraceFocus(null); setTimelineFocus(null); setNavigatorOpen(false)
            }} onKeyDown={event => {
              const nextIndex = event.key === 'ArrowRight' ? (index + 1) % state.modes.length : event.key === 'ArrowLeft' ? (index + state.modes.length - 1) % state.modes.length : event.key === 'Home' ? 0 : event.key === 'End' ? state.modes.length - 1 : null
              if (nextIndex !== null) {
                event.preventDefault()
                const next = state.modes[nextIndex]!
                dispatch({ type: 'select-mode', modeId: next.id })
                setTraceFocus(null)
                setTimelineFocus(null)
                setNavigatorOpen(false)
                document.getElementById(`dbg-agent-tab-${next.id}`)?.focus()
              }
            }}>
              {mode.sessions.some(session => session.status === 'running') ? <LoaderCircle className="dbg-spin" size={15} /> : <BrainCircuit size={15} />}
              <span>{scenarios.find(item => item.id === mode.id)!.title}</span>
            </button>
          </div>)}
        </div>
        <span className="dbg-tabs-note"><FlaskConical size={13} />{tr('前端演示', 'Frontend demo')}</span>
      </header>

      {scenario && selectedStage && <div className="dbg-layout" id="dbg-agent-content" role="tabpanel" aria-labelledby={`dbg-agent-tab-${activeMode.id}`}>
        {navigatorOpen && <button className="dbg-nav-backdrop" aria-label={tr('收起会话列表', 'Dismiss session list')} onClick={() => setNavigatorOpen(false)} />}
        <aside className={`dbg-navigator ${navigatorOpen ? 'is-open' : ''}`} aria-label={tr('测试会话', 'Test sessions')}>
          <div className="dbg-navigator-top"><button className="dbg-button dbg-new-test" onClick={newTest}><Plus size={15} />{tr('新建测试', 'New test')}</button><button className="dbg-icon-button dbg-mobile-close" aria-label={tr('关闭导航', 'Close navigation')} onClick={() => setNavigatorOpen(false)}><X size={16} /></button></div>
          <div className="dbg-history-header"><span>{tr('本次演示记录', 'DEMO SESSIONS')}<small>{activeMode.sessions.length}</small></span><MessageSquare size={13} /></div>
          <div className="dbg-session-list" aria-label={tr('测试会话列表', 'Test session list')}>
            {activeMode.sessions.length === 0 ? <div className="dbg-empty-history"><MessageSquare size={19} /><p>{tr('还没有测试会话', 'No test sessions yet')}</p><span>{tr('新建测试后，可以在同一会话里反复追加消息。', 'Start a test, then send follow-up messages in the same session.')}</span></div> : [...activeMode.sessions].reverse().map(session => <SessionHistoryItem
              key={`${activeMode.id}:${session.id}`}
              session={session}
              active={session.id === activeSession?.id}
              onSelect={() => chooseSession(session)}
            />)}
          </div>
        </aside>

        <ExperimentWorkbench key={activeMode.id} session={activeSession} modeId={activeMode.id} modeLabel={scenario.title} trace={activeTrace} scenario={scenario} onInspectRound={inspectTraceRound} onInspectStage={inspectSessionStage}>
          {({ onArtifact, onOpenTool, onOpenRound, records }) => <section className="dbg-main" aria-label={tr('测试工作区', 'Test workspace')}>
          {activeSession ? <>
            <div className="trace-review">
              <div className="trace-review-content">
                <header className="experiment-trace-header">
                  <span className="dbg-eyebrow"><button className="dbg-icon-button dbg-mobile-nav-button" aria-label={tr('测试会话', 'Test sessions')} onClick={() => setNavigatorOpen(true)}><Layers3 size={17} /></button>{scenario.title} · {tr('会话执行记录', 'SESSION EXECUTION')}</span>
                </header>
                <SessionExecutionTimeline session={activeSession} scenario={scenario} debugRecords={records} onOpenTool={onOpenTool} onOpenRound={onOpenRound} focusRequest={timelineFocus} onFocusHandled={() => setTimelineFocus(null)} onStageChange={stageId => dispatch({ type: 'select-stage', modeId: activeMode.id, stageId })}
                  initialTrace={activeTrace ? <PresentationTraceView embedded trace={activeTrace} onArtifact={onArtifact} onOpenTool={(roundId, callId) => onOpenTool(debugCallId(activeSession.turns[0]!.id, roundId, callId))} onOpenRound={roundId => onOpenRound(debugRoundId(activeSession.turns[0]!.id, roundId))} panel={panel} focusRequest={traceFocus} onFocusChange={setTraceFocus} onPanelChange={setPanel} onStageChange={stageId => dispatch({ type: 'select-stage', modeId: activeMode.id, stageId })} onOpenNavigator={() => setNavigatorOpen(true)} /> : undefined} />
              </div>
            </div>
            <SessionComposer key={activeSession.id} session={activeSession} scenario={scenario} blockedByOtherRun={!!runningSession && runningSession.id !== activeSession.id}
              onDraftChange={input => dispatch({ type: 'set-session-draft', modeId: activeMode.id, sessionId: activeSession.id, input })}
              onStop={() => dispatch({ type: 'stop-session', modeId: activeMode.id, sessionId: activeSession.id, stoppedAt: Date.now() })}
              onSend={continuation => {
                const turnId = crypto.randomUUID()
                dispatch({ type: 'append-message', modeId: activeMode.id, sessionId: activeSession.id, turnId, createdAt: Date.now(), continuation })
                setTraceFocus(null)
                const stageIndex = continuation === 'reassess' ? 0 : Math.min(activeSession.completedStages, stages.length - 1)
                const stageId = stages[stageIndex]!.id
                dispatch({ type: 'select-stage', modeId: activeMode.id, stageId })
                setTimelineFocus({ stageId, turnId })
              }} />
          </> : <div className="dbg-task-screen" key={activeMode.id}>
            <button className="dbg-button dbg-mobile-nav-button" onClick={() => setNavigatorOpen(true)}><Layers3 size={15} />{tr('测试会话', 'Test sessions')}</button>
            <div className="dbg-task-start">
              <div className="dbg-task-mode"><BrainCircuit size={23} /></div>
              <span className="dbg-eyebrow">{scenario.title} <code>{scenario.id}</code></span>
              <h1>{tr('从一个测试任务开始', 'Start with a test task')}</h1>
              <p>{tr('运行后，沿着 Cognitive、Prompt 和 Tools 查看执行过程。', 'Run a task, then inspect its execution through Cognitive, Prompt, and Tools.')}</p>
              <form className="dbg-task-composer" onSubmit={event => { event.preventDefault(); dispatch({ type: 'start-session', modeId: activeMode.id, id: crypto.randomUUID(), createdAt: Date.now() }) }}>
                <label htmlFor="dbg-task-input">{tr('测试任务', 'Test task')}</label>
                <textarea ref={taskRef} id="dbg-task-input" placeholder={tr('请输入测试任务', 'Enter a test task')} value={activeMode.draft} maxLength={10000} rows={5} onChange={event => dispatch({ type: 'set-draft', modeId: activeMode.id, input: event.target.value })} />
                <div className="dbg-composer-actions"><button type="button" className="dbg-text-button" onClick={() => { dispatch({ type: 'set-draft', modeId: activeMode.id, input: scenario.input }); taskRef.current?.focus() }}>{tr('填入示例任务', 'Use an example task')}</button><button className="dbg-button dbg-primary" type="submit" disabled={!activeMode.draft.trim() || !!runningSession}><Play size={14} fill="currentColor" />{tr('运行', 'Run')}</button></div>
              </form>
              {runningSession && <div className="dbg-pending-session"><LoaderCircle className="dbg-spin" size={14} /><span>{tr('此模式还有一个测试正在演示。', 'A test in this mode is still running.')}</span><button className="dbg-text-button" onClick={() => chooseSession(runningSession)}>{tr('查看', 'View')}<ArrowRight size={12} /></button></div>}
              <div className="dbg-task-footnote"><span><MessageSquare size={13} />{tr('新建会话后可连续发送消息', 'Continue messaging within each test session')}</span><span><FlaskConical size={13} />{tr('前端演示 · 结果为预设示例', 'Frontend demo · predefined results')}</span></div>
            </div>
          </div>}
        </section>}
        </ExperimentWorkbench>
      </div>}
    </main>
  )
}
