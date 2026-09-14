import { ArrowRight, Check } from 'lucide-react'
import { useI18n } from '../i18n'
import type { PresentationInteractionHighlight } from './presentation-highlights'

export function PresentationInteractionContent({ interaction, onInspectRound, onOutline }: {
  interaction: PresentationInteractionHighlight
  onInspectRound: () => void
  onOutline: () => void
}) {
  const { t } = useI18n()
  const specialized = interaction.kind === 'presentation-outline'

  return <div className="experiment-interaction-content">
    <div className="run-interaction-body">
      <div className="run-dialog-meta"><span className={`run-kind ${specialized ? 'is-specialized' : 'is-common'}`}>{specialized ? t('experiments.stageSpecific') : t('experiments.general')}</span><span>{specialized ? `${t('experiments.pptOrchestration')} · ` : ''}{interaction.stageLabel}</span><span>{interaction.roundId}</span></div>
      {interaction.kind === 'human-choice' ? <>
        <p className="run-interaction-prompt">{interaction.prompt}</p>
        {interaction.questions.map(item => <section className="run-question" key={item.id}>
          {item.header && <h3>{item.header}</h3>}
          <p>{item.question}</p>
          <div className="run-question-options">{item.options.map((option, index) => <span className={item.answer === option ? 'is-chosen' : undefined} key={`${index}-${option}`}>{item.answer === option && <Check size={12} />}{option}</span>)}</div>
          <p className="run-recorded-answer"><span>{t('experiments.recordedAnswer')}</span><strong>{item.answer ?? (interaction.status === 'answered' ? t('experiments.answerDetailsNotRecorded') : t('experiments.noResponseYet'))}</strong></p>
        </section>)}
      </> : <section className="run-outline-request">
        <p>{t('experiments.reviewTheSlideOutlineAndConfirmWhetherYourExpectations')}</p>
        <p>{interaction.summary}</p>
        <ol>{interaction.chapters.map((chapter, index) => <li key={index}><span>{chapter.title}</span><small>{chapter.slideCount} {t('experiments.slides')}</small></li>)}</ol>
        <button className="run-link" onClick={onOutline}>{t('experiments.viewSlideOutline')}<ArrowRight size={12} /></button>
        <p className="run-recorded-answer"><span>{t('experiments.userResponse')}</span><strong>{t('experiments.noResponseYetAwaitingOutlineApproval')}</strong></p>
      </section>}
    </div>
    <footer className="run-interaction-footer"><span>{t('experiments.mockRecordReplayOnlyNoResponseIsSubmitted')}</span><button className="run-link" onClick={onInspectRound}>{t('experiments.inspectExecutionRecord')}<ArrowRight size={12} /></button></footer>
  </div>
}
