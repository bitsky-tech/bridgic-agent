import { useCallback } from 'react'
import { ArrowRight, FlaskConical, Layers3 } from 'lucide-react'
import { useI18n } from '../i18n'
import type { InspectorPanel } from './experiment-state'
import type { PresentationTrace } from './presentation-trace-data'
import './presentation-trace.css'
import { TraceExecutionTree, type TraceTreeFocus } from './TraceExecutionTree'

export function PresentationTraceView({ trace, panel, focusRequest, onFocusChange, onPanelChange, onStageChange, onArtifact, onOpenNavigator, onOpenTool, onOpenRound, embedded = false }: {
  trace: PresentationTrace
  panel: InspectorPanel
  focusRequest: TraceTreeFocus | null
  onFocusChange: (request: TraceTreeFocus | null) => void
  onPanelChange: (panel: InspectorPanel) => void
  onStageChange: (stage: string) => void
  onArtifact: (artifact: 'outline' | 'brief' | 'sources') => void
  onOpenNavigator: () => void
  onOpenTool?: (roundId: string, callId: string) => void
  onOpenRound?: (roundId: string) => void
  embedded?: boolean
}) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const handleFocus = useCallback(() => onFocusChange(null), [onFocusChange])

  function inspectRound(roundId: string, nextPanel: InspectorPanel = panel) {
    const round = trace.rounds.find(item => item.id === roundId)
    if (!round) return
    onFocusChange({ kind: 'round', roundId, panel: nextPanel })
    if (round.stage !== 'main') onStageChange(round.stage)
    onPanelChange(nextPanel)
  }

  return <div className={embedded ? 'session-recorded-trace' : 'trace-review'}>
    <div className={embedded ? undefined : 'trace-review-content'}>
      {!embedded && <header className="experiment-trace-header">
        <span className="dbg-eyebrow">{t('PPT 编排 · 模拟记录', 'PPT ORCHESTRATION · MOCK RECORD')}</span>
        <h1><button className="dbg-icon-button dbg-mobile-nav-button" aria-label={t('阶段与会话', 'Stages and sessions')} onClick={onOpenNavigator}><Layers3 size={17} /></button>{trace.title}</h1>
        <div className="experiment-trace-task"><span>{t('原始任务', 'Original task')}</span><p>{trace.input}</p><button className="dbg-text-button" onClick={() => inspectRound('R01', 'cognitive')} aria-label={t('查看流程入口', 'Inspect workflow entry')}><ArrowRight size={14} /></button></div>
      </header>}
      <TraceExecutionTree rounds={trace.rounds} focusRequest={focusRequest} onFocusHandled={handleFocus} onPanelChange={onPanelChange} onArtifact={onArtifact} onInspectRound={inspectRound} onOpenTool={onOpenTool} onOpenRound={onOpenRound} />
      <p className="trace-bottom-note"><FlaskConical size={12} />{t('正文与 Thinking 为历史快照；工具、流程说明与指标仍为示例，未连接执行服务。', 'Response text and Thinking are historical snapshots; tools, workflow notes, and metrics remain examples, with no execution service connected.')}</p>
    </div>
  </div>
}
