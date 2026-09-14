import { BrainCircuit, ChevronRight } from 'lucide-react'
import { useI18n } from '../i18n'
import './model-response-content.css'

interface Props {
  output?: string | null
  thinking?: string | null
  outputFidelity?: 'recorded' | 'example'
  thinkingFidelity?: 'recorded' | 'example'
}

/** Render independent response channels without substituting editorial summaries. */
export function ModelResponseContent({ output, thinking, outputFidelity, thinkingFidelity }: Props) {
  const { t } = useI18n()
  return <div className="model-response-content">
    {thinking?.trim() && <details className="model-thinking" data-content-source={thinkingFidelity}>
      <summary><ChevronRight size={12} /><BrainCircuit size={13} /><span>Thinking</span>{thinkingFidelity === 'example' && <small>{t('experiments.exampleBadge')}</small>}</summary>
      <p className="model-thinking-text">{thinking}</p>
    </details>}
    {output?.trim() ? <div className="model-output" data-content-source={outputFidelity}>
      {outputFidelity === 'example' && <small className="model-output-source">{t('experiments.exampleResponse')}</small>}
      <p className="model-output-text" aria-label={t('experiments.modelResponseText')}>{output}</p>
    </div> : <p className="model-output-empty">{output === null || output === undefined ? t('experiments.modelResponseDataIsUnavailable') : t('experiments.noResponseTextInThisRound')}</p>}
  </div>
}
