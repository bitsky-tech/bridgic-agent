import { useEffect, useId, useMemo, useState } from 'react'
import { AlertCircle, ArrowRight, BookOpen, Clock3, FileText, ListTree } from 'lucide-react'
import { useI18n } from '../i18n'
import type { PresentationTrace } from './presentation-trace-data'
import './artifact-content.css'

export function PresentationArtifactContent({ trace, artifact, onRound }: {
  trace: PresentationTrace
  artifact: 'brief' | 'outline' | 'sources'
  onRound: (roundId: string) => void
}) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const slides = useMemo(() => trace.chapters.flatMap(chapter => chapter.slides), [trace.chapters])
  const [slideId, setSlideId] = useState(slides[0]?.id)
  const selected = slides.find(slide => slide.id === slideId) ?? slides[0]
  const selectorId = useId()

  useEffect(() => {
    if (!slides.some(slide => slide.id === slideId)) setSlideId(slides[0]?.id)
  }, [slideId, slides])

  return <div className={`artifact-content artifact-content-${artifact}`}>
    {artifact === 'outline' ? <>
      <div className="trace-artifact-summary">
        <ListTree size={17} />
        <strong>{trace.chapters.length} {t('章', trace.chapters.length === 1 ? 'chapter' : 'chapters')} / {slides.length} {t('页', slides.length === 1 ? 'slide' : 'slides')}</strong>
        <span className="trace-badge is-waiting"><Clock3 size={12} />{t('待确认', 'Awaiting confirmation')}</span>
      </div>
      <button className="dbg-text-button artifact-record-link" onClick={() => onRound('R10')}>
        {t('查看 R10 的大纲记录', 'Inspect the R10 outline record')}<ArrowRight size={12} />
      </button>
      {trace.reportedSlideCount !== slides.length && <div className="trace-discrepancy">
        <AlertCircle size={16} />
        <div>
          <strong>{t(`报告写了 ${trace.reportedSlideCount} 页，实际大纲为 ${slides.length} 页`, `The report says ${trace.reportedSlideCount} slides; the outline contains ${slides.length}`)}</strong>
          <p>{t('页数由下方的结构化页面列表计算。', 'The slide count is calculated from the structured page list below.')}</p>
        </div>
      </div>}
      {selected ? <>
        <nav className="artifact-page-navigation" aria-label={t('大纲页面', 'Outline slides')}>
          <label className="trace-field-label" htmlFor={selectorId}>{t('选择页面', 'Select a slide')}</label>
          <select id={selectorId} value={selected.id} onChange={event => setSlideId(event.target.value)}>
            {trace.chapters.map(chapter => <optgroup key={chapter.id} label={chapter.title}>
              {chapter.slides.map(slide => <option key={slide.id} value={slide.id}>
                {String(slides.indexOf(slide) + 1).padStart(2, '0')} · {slide.title}
              </option>)}
            </optgroup>)}
          </select>
        </nav>
        <section className="trace-slide-detail" aria-label={t('页面内容', 'Slide content')}>
          <span className="dbg-eyebrow">{t('第', 'SLIDE')} {slides.indexOf(selected) + 1} {t('页 · 大纲内容', '· OUTLINE')}</span>
          <h3>{selected.title}</h3>
          <span className="trace-field-label">{t('这一页要说明什么', 'Key message')}</span>
          <p className="trace-key-message">{selected.keyMessage}</p>
          <span className="trace-field-label">{t('页面目的', 'Purpose')}</span>
          <p>{selected.purpose}</p>
          <span className="trace-field-label">{t('内容要点', 'Content')}</span>
          <ul>{selected.bullets.map(line => <li key={line}>{line}</li>)}</ul>
          <span className="trace-field-label">{t('引用依据', 'Sources')}</span>
          {selected.sourceIds.map(id => {
            const source = trace.sources.find(item => item.id === id)
            return source && <div className="trace-slide-source" key={id}>
              <BookOpen size={13} />
              <span>{source.title}</span>
              <small className={source.status === 'unverified' ? 'is-unverified' : undefined}>
                {source.status === 'unverified' ? t('未核验', 'Unverified') : source.kind === 'brief' ? t('需求依据', 'Brief') : t('已提供', 'Available')}
              </small>
            </div>
          })}
        </section>
      </> : <p className="artifact-empty-state">{t('当前大纲还没有页面。', 'This outline has no slides yet.')}</p>}
    </> : artifact === 'brief' ? <>
      <div className="trace-artifact-summary">
        <FileText size={17} /><code>.presentation/brief.md</code>
        <button className="dbg-text-button" onClick={() => onRound('R03')}>R03<ArrowRight size={12} /></button>
      </div>
      <pre className="trace-brief-content">{trace.brief}</pre>
    </> : <>
      <div className="trace-artifact-summary"><BookOpen size={17} /><strong>{trace.sources.length} {t('项来源', trace.sources.length === 1 ? 'source' : 'sources')}</strong></div>
      <p className="trace-artifact-intro">{t('登记了来源不代表已经读取或核验。这里将来源和获取结果一起展示。', 'Registering a source does not mean it was retrieved or verified. Compare each source with its retrieval outcome.')}</p>
      {trace.sources.map(source => <section className="trace-source-card" key={source.id}>
        <header>
          <BookOpen size={16} /><strong>{source.title}</strong>
          <span className={`trace-badge ${source.status === 'available' ? 'is-success' : 'is-waiting'}`}>
            {source.status === 'available' ? t('已提供', 'Available') : t('未核验', 'Unverified')}
          </span>
        </header>
        <p>{source.note}</p>
        <button className="dbg-text-button" onClick={() => onRound(source.kind === 'brief' ? 'R03' : 'R09')}>
          {t('查看登记依据', 'Inspect supporting record')} · {source.kind === 'brief' ? 'R03' : 'R09'}<ArrowRight size={12} />
        </button>
      </section>)}
      {!trace.sources.length && <p className="artifact-empty-state">{t('当前还没有登记来源。', 'No sources have been registered yet.')}</p>}
    </>}
  </div>
}
