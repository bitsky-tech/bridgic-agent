import { useId, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, Square } from 'lucide-react'
import { useI18n } from '../i18n'
import type { DemoScenario } from './demo-data'
import type { ExperimentSession } from './experiment-state'
import './session-composer.css'

export function SessionComposer({ session, scenario, blockedByOtherRun, onDraftChange, onSend, onStop }: {
  session: ExperimentSession
  scenario: DemoScenario
  blockedByOtherRun: boolean
  onDraftChange: (input: string) => void
  onSend: (continuation: 'reassess' | 'continue') => void
  onStop: () => void
}) {
  const { t } = useI18n()
  const [continuation, setContinuation] = useState<'reassess' | 'continue'>('reassess')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  const running = session.status === 'running'
  const canSend = !!session.draft.trim() && !running && !blockedByOtherRun
  const currentStage = scenario.stages[Math.min(session.completedStages, scenario.stages.length - 1)]!
  const status = running ? t('experiments.simulating') : session.status === 'cancelled' ? t('experiments.stoppedSendAFollowUp')
    : session.status === 'awaiting' ? t('experiments.awaitingUserAddInstructions') : t('experiments.completeContinueThisTest')

  function send() {
    if (!canSend) return
    onSend(continuation)
    inputRef.current?.focus()
  }

  return <form className="session-composer" aria-label={t('experiments.sessionMessage')} onSubmit={event => { event.preventDefault(); send() }}>
    <div className="session-composer-status" role="status">
      {running && <LoaderCircle className="dbg-spin" size={12} />}
      <span>{t('experiments.executionOrdinal', { ordinal: session.turns.length })} · {status}</span>
      {running && <span>{currentStage.title}</span>}
    </div>
    <div className="session-composer-box">
      <label className="session-composer-label" htmlFor={inputId}>{t('experiments.followUpMessage')}</label>
      <textarea ref={inputRef} id={inputId} rows={2} maxLength={10000} value={session.draft}
        placeholder={running ? t('experiments.draftInstructionsToSendAfterStopping') : t('experiments.addInstructionsToContinueThisTest')}
        onChange={event => onDraftChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
        }} />
      <div className="session-composer-actions">
        <label>{t('experiments.nextExecutionMock')}
          <select value={continuation} onChange={event => setContinuation(event.target.value as 'reassess' | 'continue')} disabled={running}>
            <option value="reassess">{t('experiments.reassessRequirements')}</option>
            <option value="continue">{session.status === 'completed' ? t('experiments.retryTheFinalStage') : t('experiments.continueFromTheLastStage')}</option>
          </select>
        </label>
        {running ? <button type="button" className="dbg-button session-stop" onClick={() => { onStop(); inputRef.current?.focus() }}><Square size={11} fill="currentColor" />{t('experiments.stop')}</button>
          : <button type="submit" className="dbg-button dbg-primary" disabled={!canSend}><ArrowUp size={15} />{t('experiments.sendRun')}</button>}
      </div>
    </div>
    {blockedByOtherRun && <p className="session-composer-blocked">{t('experiments.anotherTestInThisModeIsRunningSendIt')}</p>}
  </form>
}
