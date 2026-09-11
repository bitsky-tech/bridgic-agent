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
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  return <div className="model-response-content">
    {thinking?.trim() && <details className="model-thinking" data-content-source={thinkingFidelity}>
      <summary><ChevronRight size={12} /><BrainCircuit size={13} /><span>Thinking</span>{thinkingFidelity === 'example' && <small>{t('示例', 'Example')}</small>}</summary>
      <p className="model-thinking-text">{thinking}</p>
    </details>}
    {output?.trim() ? <div className="model-output" data-content-source={outputFidelity}>
      {outputFidelity === 'example' && <small className="model-output-source">{t('正文示例', 'Example response')}</small>}
      <p className="model-output-text" aria-label={t('模型正文', 'Model response text')}>{output}</p>
    </div> : <p className="model-output-empty">{output === null || output === undefined ? t('暂无模型正文数据', 'Model response data is unavailable') : t('本轮无正文', 'No response text in this round')}</p>}
  </div>
}
