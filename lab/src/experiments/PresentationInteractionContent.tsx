import { ArrowRight, Check } from 'lucide-react'
import { useI18n } from '../i18n'
import type { PresentationInteractionHighlight } from './presentation-highlights'

export function PresentationInteractionContent({ interaction, onInspectRound, onOutline }: {
  interaction: PresentationInteractionHighlight
  onInspectRound: () => void
  onOutline: () => void
}) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const specialized = interaction.kind === 'presentation-outline'

  return <div className="experiment-interaction-content">
    <div className="run-interaction-body">
      <div className="run-dialog-meta"><span className={`run-kind ${specialized ? 'is-specialized' : 'is-common'}`}>{specialized ? t('阶段专属', 'Stage-specific') : t('通用交互', 'General')}</span><span>{specialized ? `${t('PPT 编排', 'PPT orchestration')} · ` : ''}{interaction.stageLabel}</span><span>{interaction.roundId}</span></div>
      {interaction.kind === 'human-choice' ? <>
        <p className="run-interaction-prompt">{interaction.prompt}</p>
        {interaction.questions.map(item => <section className="run-question" key={item.id}>
          {item.header && <h3>{item.header}</h3>}
          <p>{item.question}</p>
          <div className="run-question-options">{item.options.map((option, index) => <span className={item.answer === option ? 'is-chosen' : undefined} key={`${index}-${option}`}>{item.answer === option && <Check size={12} />}{option}</span>)}</div>
          <p className="run-recorded-answer"><span>{t('记录的回答', 'Recorded answer')}</span><strong>{item.answer ?? (interaction.status === 'answered' ? t('未记录具体回答', 'Answer details not recorded') : t('尚未回答', 'No response yet'))}</strong></p>
        </section>)}
      </> : <section className="run-outline-request">
        <p>{t('请查看逐页大纲，确认内容与顺序是否符合预期。', 'Review the slide outline and confirm whether the content and order meet your expectations.')}</p>
        <p>{interaction.summary}</p>
        <ol>{interaction.chapters.map((chapter, index) => <li key={index}><span>{chapter.title}</span><small>{chapter.slideCount} {t('页', 'slides')}</small></li>)}</ol>
        <button className="run-link" onClick={onOutline}>{t('查看逐页大纲', 'View slide outline')}<ArrowRight size={12} /></button>
        <p className="run-recorded-answer"><span>{t('用户回应', 'User response')}</span><strong>{t('尚未回应 · 等待大纲确认', 'No response yet · awaiting outline approval')}</strong></p>
      </section>}
    </div>
    <footer className="run-interaction-footer"><span>{t('模拟记录 · 仅回放，不提交回答', 'Mock record · replay only, no response is submitted')}</span><button className="run-link" onClick={onInspectRound}>{t('追溯执行记录', 'Inspect execution record')}<ArrowRight size={12} /></button></footer>
  </div>
}
