import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Repeat2, Wrench, X } from 'lucide-react'
import { ResizablePane } from '../components/ResizablePane'
import { useI18n } from '../i18n'
import { ExperimentSurfaceRail, type ExperimentSurface } from './ExperimentSurfaceRail'
import type { ExperimentSession, InspectorPanel } from './experiment-state'
import { PresentationArtifactContent } from './PresentationArtifactContent'
import type { PresentationTrace } from './presentation-trace-data'
import type { DemoScenario } from './demo-data'
import { buildDebugRecords } from './debug-records'
import { debugRoundId, type DebugOpenRequest, type DebugRecords, type DebugRound } from './debug-record-types'
import { PresentationInteractionContent } from './PresentationInteractionContent'
import { getPresentationHighlights } from './presentation-highlights'
import { DebugWorkbenchPanel } from './DebugWorkbenchPanel'
import './experiment-panel-content.css'

type ArtifactId = 'outline' | 'brief' | 'sources'
interface WorkbenchActions {
  onArtifact: (artifact: ArtifactId) => void
  onOpenTool: (id: string) => void
  onOpenRound: (id: string) => void
  records: DebugRecords
}

export function ExperimentWorkbench({ session, modeId, modeLabel, scenario, trace, onInspectRound, onInspectStage, children }: {
  session: ExperimentSession | undefined
  modeId: string
  modeLabel: string
  scenario: DemoScenario
  onInspectStage: (stageId: string, turnId: string) => void
  trace: PresentationTrace | null
  onInspectRound: (roundId: string, panel?: InspectorPanel) => void
  children: (actions: WorkbenchActions) => ReactNode
}) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const records = useMemo(() => buildDebugRecords(session, scenario, trace, locale), [session, scenario, trace, locale])
  const highlights = useMemo(() => trace ? getPresentationHighlights(trace, locale) : null, [trace, locale])
  const [surface, setSurface] = useState<ExperimentSurface | null>(trace ? 'tools' : null)
  const [debugSurface, setDebugSurface] = useState<'tools' | 'rounds'>('tools')
  const [request, setRequest] = useState<DebugOpenRequest | null>(null)
  const [artifactId, setArtifactId] = useState<ArtifactId | null>(null)
  const [maxPanelWidth, setMaxPanelWidth] = useState(620)
  const containerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const artifactBackRef = useRef<HTMLButtonElement>(null)
  const railFocusFromPanel = useRef(false)
  const nonce = useRef(0)
  const panelId = useId()
  const latestTurn = session?.turns.at(-1)
  const title = artifactId ? { brief: t('需求简报', 'Brief'), sources: t('资料与引用', 'Sources'), outline: t('逐页大纲', 'Slide outline') }[artifactId]
    : surface === 'agent' ? 'Bridgic Agent' : surface === 'rounds' ? t('Agent 循环', 'Agent rounds') : t('工具调用', 'Tool calls')
  const status = session?.status === 'awaiting' ? t('等待用户', 'Awaiting user')
    : session?.status === 'running' ? t('演示中', 'Simulating')
      : session?.status === 'cancelled' ? t('已停止', 'Stopped') : t('演示完成', 'Simulation complete')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    function measure() {
      // The overlay is sized by CSS; preserve the desktop panel's stored width.
      setMaxPanelWidth(window.matchMedia('(max-width: 1000px)').matches ? 620 : Math.max(320, Math.min(620, container!.clientWidth - 488)))
    }
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => { setRequest(null); setArtifactId(null) }, [session?.id])
  useEffect(() => {
    if (artifactId) { bodyRef.current?.scrollTo({ top: 0 }); artifactBackRef.current?.focus({ preventScroll: true }) }
  }, [artifactId])

  function openRecord(kind: DebugOpenRequest['kind'], id: string) {
    if (!(kind === 'tool' ? records.calls : records.rounds).some(record => record.id === id)) return
    const next = kind === 'tool' ? 'tools' : 'rounds'
    setArtifactId(null)
    setDebugSurface(next)
    setSurface(next)
    setRequest({ kind, id, nonce: ++nonce.current })
  }
  function openArtifact(id: ArtifactId) {
    if (!trace) return
    setArtifactId(id)
    setSurface(debugSurface)
  }
  function closePanel() {
    setSurface(null)
    document.getElementById('experiment-rail-tab-agent')?.focus()
  }
  function locateRound(round: DebugRound) {
    if (round.source === 'fixture') onInspectRound(round.sourceRoundId, 'cognitive')
    else onInspectStage(round.stageId, round.turnId)
    if (window.matchMedia('(max-width: 1000px)').matches) setSurface(null)
  }

  return <div ref={containerRef} className="experiment-workbench" data-panel-open={!!surface} onFocusCapture={event => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.experiment-surface-rail')) return
    railFocusFromPanel.current = event.relatedTarget instanceof HTMLElement && !!event.relatedTarget.closest('.experiment-side-pane')
  }} onKeyDownCapture={event => {
    const onRail = event.target instanceof HTMLElement && !!event.target.closest('.experiment-surface-rail')
    if (onRail && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) railFocusFromPanel.current = false
    if (!surface || event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !onRail || railFocusFromPanel.current) return
    const target = artifactBackRef.current ?? closeButtonRef.current
    if (target) { event.preventDefault(); target.focus() }
  }}>
    <div className="experiment-trace-column">{children({ onArtifact: openArtifact, onOpenTool: id => openRecord('tool', id), onOpenRound: id => openRecord('round', id), records })}</div>
    {surface && <button className="experiment-side-backdrop" aria-label={t('收起侧面板', 'Dismiss side panel')} onClick={closePanel} />}
    <ResizablePane side="right" storageKey="lab.experiments.side-panel-width" defaultWidth={420} minWidth={320} maxWidth={maxPanelWidth} collapsible={false} id={panelId} className="experiment-side-pane" style={{ display: surface ? undefined : 'none' }} labels={{ resize: t('调整实验侧面板宽度', 'Resize experiment side panel') }}>
      <section className="experiment-side-surface" role="tabpanel" aria-labelledby={`experiment-rail-tab-${surface ?? debugSurface}`} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); closePanel() }
      }}>
        <header className="experiment-side-header">
          {artifactId ? <button ref={artifactBackRef} className="dbg-icon-button" aria-label={t('返回调试台', 'Back to debugger')} onClick={() => setArtifactId(null)}><ArrowLeft size={16} /></button>
            : surface === 'tools' ? <Wrench size={16} /> : surface === 'rounds' ? <Repeat2 size={16} /> : null}
          <h2>{title}</h2>
          {!artifactId && surface !== 'agent' && <span>{surface === 'rounds' ? records.rounds.length : records.calls.length}</span>}
          <button ref={closeButtonRef} className="dbg-icon-button" aria-label={t('关闭侧面板', 'Close side panel')} onClick={closePanel}><X size={16} /></button>
        </header>
        <div ref={bodyRef} className="experiment-side-body">
          <div hidden={surface !== 'agent' || !!artifactId} className="experiment-agent-content">
            <span className="dbg-eyebrow">{t('当前 Agent 模式', 'CURRENT AGENT MODE')}</span>
            <h3>{modeLabel}</h3><code>{modeId}</code>
            {session ? <>
              <section className="experiment-agent-task"><h4>{t('原始任务', 'Original task')}</h4><p>{session.input}</p>{records.rounds[0] && <button className="run-link" onClick={() => openRecord('round', records.rounds[0]!.id)}>{t('查看首次循环', 'Inspect first round')}<ArrowRight size={12} /></button>}</section>
              {session.turns.length > 1 && latestTurn && <section className="experiment-agent-task is-followup"><h4>{t('最近一条消息', 'Latest message')}</h4><p>{latestTurn.input}</p></section>}
              <dl className="experiment-agent-facts"><div><dt>{t('当前执行状态', 'Current execution status')}</dt><dd>{status}</dd></div><div><dt>{t('会话执行次数', 'Executions in this session')}</dt><dd>{session.turns.length}</dd></div><div><dt>{t('循环记录', 'Round records')}</dt><dd>{records.rounds.length}</dd></div><div><dt>{t('工具记录', 'Tool records')}</dt><dd>{records.calls.length}</dd></div></dl>
              <p className="experiment-panel-note">{t('当前为前端模拟数据。点击对话中的工具或循环，在右侧查看参数、模型输入和结果。', 'Frontend sample data. Select a tool or round in the conversation to inspect arguments, model inputs, and results on the right.')}</p>
            </> : <p className="experiment-panel-note">{t('输入测试任务并运行后，在这里查看当前测试的信息。', 'Run a test task to inspect its information here.')}</p>}
          </div>
          <div hidden={surface === 'agent' || !!artifactId}>
            <DebugWorkbenchPanel sessionId={session?.id} surface={debugSurface} records={records} request={request} onLocateRound={locateRound} onArtifact={trace ? openArtifact : undefined} renderToolExtra={call => {
              const interaction = call.source === 'fixture' ? highlights?.interactions.find(item => item.roundId === call.sourceRoundId && item.toolName === call.name) : null
              return interaction ? <div className="experiment-tool-interaction"><p className="experiment-record-origin">{t('交互回放 · 保留当时状态', 'Interaction replay · State at the time')}</p><PresentationInteractionContent interaction={interaction} onInspectRound={() => {
                const round = records.rounds.find(item => item.id === call.roundId)
                if (round) locateRound(round)
              }} onOutline={() => openArtifact('outline')} /></div> : null
            }} />
          </div>
          {artifactId && trace && <div><p className="experiment-record-origin">{t('第 1 次执行 · 产物示例快照', 'Execution 1 · Sample artifact snapshot')}</p><PresentationArtifactContent trace={trace} artifact={artifactId} onRound={id => {
            const turnId = session?.turns[0]?.id
            if (turnId) openRecord('round', debugRoundId(turnId, id))
          }} /></div>}
        </div>
      </section>
    </ResizablePane>
    <ExperimentSurfaceRail active={surface} onSelect={next => {
      railFocusFromPanel.current = false
      if (next === surface && !artifactId) closePanel()
      else { setArtifactId(null); setSurface(next); if (next !== 'agent') setDebugSurface(next) }
    }} hasSession={!!session} hasTools={!!records.calls.length} hasRounds={!!records.rounds.length} panelId={panelId} />
  </div>
}
