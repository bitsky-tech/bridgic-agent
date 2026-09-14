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
  const { t } = useI18n()
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
        <span className="dbg-eyebrow">{t('experiments.pptOrchestrationMockRecord')}</span>
        <h1><button className="dbg-icon-button dbg-mobile-nav-button" aria-label={t('experiments.stagesAndSessions')} onClick={onOpenNavigator}><Layers3 size={17} /></button>{trace.title}</h1>
        <div className="experiment-trace-task"><span>{t('experiments.originalTask')}</span><p>{trace.input}</p><button className="dbg-text-button" onClick={() => inspectRound('R01', 'cognitive')} aria-label={t('experiments.inspectWorkflowEntry')}><ArrowRight size={14} /></button></div>
      </header>}
      <TraceExecutionTree rounds={trace.rounds} focusRequest={focusRequest} onFocusHandled={handleFocus} onPanelChange={onPanelChange} onArtifact={onArtifact} onInspectRound={inspectRound} onOpenTool={onOpenTool} onOpenRound={onOpenRound} />
      <p className="trace-bottom-note"><FlaskConical size={12} />{t('experiments.responseTextAndThinkingAreHistoricalSnapshotsServiceConnected')}</p>
    </div>
  </div>
}
