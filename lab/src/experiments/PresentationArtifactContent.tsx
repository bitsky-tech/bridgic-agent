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
  const { t } = useI18n()
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
        <strong>{trace.chapters.length} {t(trace.chapters.length === 1 ? 'experiments.chapter' : 'experiments.chapters')} / {slides.length} {t(slides.length === 1 ? 'experiments.slide' : 'experiments.slides')}</strong>
        <span className="trace-badge is-waiting"><Clock3 size={12} />{t('experiments.awaitingConfirmation')}</span>
      </div>
      <button className="dbg-text-button artifact-record-link" onClick={() => onRound('R10')}>
        {t('experiments.inspectTheR10OutlineRecord')}<ArrowRight size={12} />
      </button>
      {trace.reportedSlideCount !== slides.length && <div className="trace-discrepancy">
        <AlertCircle size={16} />
        <div>
          <strong>{t('experiments.outlineCountDiscrepancy', { reported: trace.reportedSlideCount, actual: slides.length })}</strong>
          <p>{t('experiments.theSlideCountIsCalculatedFromTheListBelow')}</p>
        </div>
      </div>}
      {selected ? <>
        <nav className="artifact-page-navigation" aria-label={t('experiments.outlineSlides')}>
          <label className="trace-field-label" htmlFor={selectorId}>{t('experiments.selectASlide')}</label>
          <select id={selectorId} value={selected.id} onChange={event => setSlideId(event.target.value)}>
            {trace.chapters.map(chapter => <optgroup key={chapter.id} label={chapter.title}>
              {chapter.slides.map(slide => <option key={slide.id} value={slide.id}>
                {String(slides.indexOf(slide) + 1).padStart(2, '0')} · {slide.title}
              </option>)}
            </optgroup>)}
          </select>
        </nav>
        <section className="trace-slide-detail" aria-label={t('experiments.slideContent')}>
          <span className="dbg-eyebrow">{t('experiments.slideEyebrowPrefix')} {slides.indexOf(selected) + 1} {t('experiments.outline')}</span>
          <h3>{selected.title}</h3>
          <span className="trace-field-label">{t('experiments.keyMessage')}</span>
          <p className="trace-key-message">{selected.keyMessage}</p>
          <span className="trace-field-label">{t('experiments.purpose')}</span>
          <p>{selected.purpose}</p>
          <span className="trace-field-label">{t('experiments.content')}</span>
          <ul>{selected.bullets.map(line => <li key={line}>{line}</li>)}</ul>
          <span className="trace-field-label">{t('experiments.slideSourcesLabel')}</span>
          {selected.sourceIds.map(id => {
            const source = trace.sources.find(item => item.id === id)
            return source && <div className="trace-slide-source" key={id}>
              <BookOpen size={13} />
              <span>{source.title}</span>
              <small className={source.status === 'unverified' ? 'is-unverified' : undefined}>
                {source.status === 'unverified' ? t('experiments.unverified') : source.kind === 'brief' ? t('experiments.briefSourceBadge') : t('experiments.available')}
              </small>
            </div>
          })}
        </section>
      </> : <p className="artifact-empty-state">{t('experiments.thisOutlineHasNoSlidesYet')}</p>}
    </> : artifact === 'brief' ? <>
      <div className="trace-artifact-summary">
        <FileText size={17} /><code>.presentation/brief.md</code>
        <button className="dbg-text-button" onClick={() => onRound('R03')}>R03<ArrowRight size={12} /></button>
      </div>
      <pre className="trace-brief-content">{trace.brief}</pre>
    </> : <>
      <div className="trace-artifact-summary"><BookOpen size={17} /><strong>{trace.sources.length} {t(trace.sources.length === 1 ? 'experiments.sourceCountOne' : 'experiments.sourceCountMany')}</strong></div>
      <p className="trace-artifact-intro">{t('experiments.registeringASourceDoesNotMeanItRetrievalOutcome')}</p>
      {trace.sources.map(source => <section className="trace-source-card" key={source.id}>
        <header>
          <BookOpen size={16} /><strong>{source.title}</strong>
          <span className={`trace-badge ${source.status === 'available' ? 'is-success' : 'is-waiting'}`}>
            {source.status === 'available' ? t('experiments.available') : t('experiments.unverified')}
          </span>
        </header>
        <p>{source.note}</p>
        <button className="dbg-text-button" onClick={() => onRound(source.kind === 'brief' ? 'R03' : 'R09')}>
          {t('experiments.inspectSupportingRecord')} · {source.kind === 'brief' ? 'R03' : 'R09'}<ArrowRight size={12} />
        </button>
      </section>)}
      {!trace.sources.length && <p className="artifact-empty-state">{t('experiments.noSourcesHaveBeenRegisteredYet')}</p>}
    </>}
  </div>
}
