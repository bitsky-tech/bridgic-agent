/** Dedicated Agent-owned progress surface for the presentation-making pipeline. */
import type { PresentationChapterOutline, PresentationSourceCard } from '@shared/types'
import { useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  currentAgentRunningAtom,
  currentMessagesAtom,
  currentThinkingModeAtom,
} from '@/atoms/agent'
import { respondPresentationOutlineAtom } from '@/atoms/presentation-plan'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { currentHumanRequestAtom } from '@/atoms/human-request'
import { Icons } from '@/components/amphi/Icons'
import { useAutoHideScrollbar } from '@/hooks/useAutoHideScrollbar'
import { cn } from '@/lib/cn'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

const PRESENTATION_STAGES = [
  {
    id: 'ppt_brief',
    steps: [],
  },
  {
    id: 'ppt_plan',
    steps: ['collect_evidence', 'shape_chapters', 'map_slides', 'design_visual_direction'],
  },
  {
    id: 'ppt_compose',
    steps: ['build_slide_shells', 'fill_slide_content', 'create_visuals', 'polish_deck'],
  },
  {
    id: 'ppt_review',
    steps: ['audit_narrative', 'audit_evidence', 'inspect_visual_quality', 'confirm_delivery'],
  },
] as const

type PresentationStage = (typeof PRESENTATION_STAGES)[number]
type PresentationStageId = PresentationStage['id']

function stageUnitCount(stage: PresentationStage): number {
  return Math.max(1, stage.steps.length)
}

function normalizeEvidence(evidence: string[]): string[] {
  if (evidence.length === 0 || !evidence.every(item => item.length === 1)) return evidence
  const joined = evidence.join('').trim()
  if (!joined.startsWith('[') || !joined.endsWith(']')) return evidence
  const quoted = Array.from(joined.matchAll(/(['"])(.*?)\1/g), match => match[2]!.trim()).filter(Boolean)
  return quoted.length > 0 ? quoted : [joined]
}

function sourceIcon(source: PresentationSourceCard) {
  if (source.kind === 'file') return Icons.file(13)
  if (source.kind === 'conversation') return Icons.chat(13)
  return Icons.link(13)
}

function PresentationSourcesPanel({ sources }: { sources: PresentationSourceCard[] }) {
  const { t } = useTranslation()
  if (sources.length === 0) return null
  return (
    <section className="mt-2 space-y-2" data-testid="presentation-sources">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-2xs font-semibold text-text-secondary">{t('presentationMode.sources.title')}</h4>
        <span className="text-[10px] tabular-nums text-text-tertiary">
          {t('presentationMode.sources.count', { count: sources.length })}
        </span>
      </div>
      {sources.map(source => (
        <article key={source.id} className="rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-2" data-source-kind={source.kind}>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-text-tertiary">{sourceIcon(source)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 text-2xs font-medium leading-4 text-text-primary">{source.title}</p>
                <span className="shrink-0 rounded bg-bg-hover px-1.5 py-0.5 text-[9px] text-text-tertiary">
                  {t(`presentationMode.sources.kinds.${source.kind}`)}
                </span>
              </div>
              {source.excerpt && <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-text-tertiary">{source.excerpt}</p>}
              {source.usage && (
                <p className="mt-1 text-[10px] leading-4 text-text-secondary">
                  <span className="font-medium">{t('presentationMode.sources.usage')}</span>{source.usage}
                </p>
              )}
              {source.locator && (
                <p className="mt-1 truncate text-[10px] text-text-accent" title={source.locator}>{source.locator}</p>
              )}
            </div>
          </div>
        </article>
      ))}
    </section>
  )
}

function PresentationOutlinePanel({ chapters, sources, editable, busy, onConfirm }: {
  chapters: PresentationChapterOutline[]
  sources: PresentationSourceCard[]
  editable: boolean
  busy: boolean
  onConfirm: (chapters: PresentationChapterOutline[]) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(chapters)
  const [dragged, setDragged] = useState<
    { kind: 'chapter'; id: string }
    | { kind: 'slide'; chapterId: string; id: string }
    | null
  >(null)
  const sourceById = new Map(sources.map(source => [source.id, source]))

  if (chapters.length === 0) return null

  const patchChapter = (chapterId: string, patch: Partial<PresentationChapterOutline>) => {
    setDraft(current => current.map(chapter => chapter.id === chapterId ? { ...chapter, ...patch } : chapter))
  }
  const patchSlide = (
    chapterId: string,
    slideId: string,
    patch: Partial<PresentationChapterOutline['slides'][number]>,
  ) => {
    setDraft(current => current.map(chapter => chapter.id === chapterId
      ? { ...chapter, slides: chapter.slides.map(slide => slide.id === slideId ? { ...slide, ...patch } : slide) }
      : chapter))
  }
  const removeChapter = (chapterId: string) => setDraft(current => current.filter(chapter => chapter.id !== chapterId))
  const removeSlide = (chapterId: string, slideId: string) => {
    setDraft(current => current.map(chapter => chapter.id === chapterId
      ? { ...chapter, slides: chapter.slides.filter(slide => slide.id !== slideId) }
      : chapter))
  }
  const addChapter = () => {
    const suffix = `${Date.now()}-${draft.length}`
    setDraft(current => [...current, {
      id: `chapter-user-${suffix}`,
      title: t('presentationMode.outline.newChapter'),
      summary: '',
      slides: [],
    }])
  }
  const addSlide = (chapterId: string) => {
    const suffix = `${Date.now()}-${draft.flatMap(chapter => chapter.slides).length}`
    setDraft(current => current.map(chapter => chapter.id === chapterId
      ? {
          ...chapter,
          slides: [...chapter.slides, {
            id: `slide-user-${suffix}`,
            title: t('presentationMode.outline.newSlide'),
            purpose: '',
            keyMessage: '',
            sourceIds: [],
          }],
        }
      : chapter))
  }
  const dropChapter = (targetId: string) => {
    if (dragged?.kind !== 'chapter' || dragged.id === targetId) return
    setDraft(current => {
      const sourceIndex = current.findIndex(chapter => chapter.id === dragged.id)
      const targetIndex = current.findIndex(chapter => chapter.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return current
      const next = [...current]
      const [moved] = next.splice(sourceIndex, 1)
      if (!moved) return current
      next.splice(targetIndex, 0, moved)
      return next
    })
    setDragged(null)
  }
  const dropSlide = (targetChapterId: string, targetSlideId: string) => {
    if (dragged?.kind !== 'slide' || dragged.id === targetSlideId) return
    setDraft(current => {
      let moved: PresentationChapterOutline['slides'][number] | undefined
      const without = current.map(chapter => {
        if (chapter.id !== dragged.chapterId) return chapter
        moved = chapter.slides.find(slide => slide.id === dragged.id)
        return { ...chapter, slides: chapter.slides.filter(slide => slide.id !== dragged.id) }
      })
      if (!moved) return current
      return without.map(chapter => {
        if (chapter.id !== targetChapterId) return chapter
        const targetIndex = chapter.slides.findIndex(slide => slide.id === targetSlideId)
        const slides = [...chapter.slides]
        slides.splice(targetIndex < 0 ? slides.length : targetIndex, 0, moved!)
        return { ...chapter, slides }
      })
    })
    setDragged(null)
  }
  const dropIntoChapter = (chapterId: string) => {
    if (dragged?.kind === 'chapter') dropChapter(chapterId)
    else if (dragged?.kind === 'slide') dropSlide(chapterId, '')
  }
  const valid = draft.length > 0
    && draft.every(chapter => chapter.title.trim() && chapter.slides.every(slide => slide.title.trim()))
    && draft.some(chapter => chapter.slides.length > 0)
  return (
    <section className="mt-2 rounded-lg border border-border-subtle bg-bg-surface p-2.5" data-testid="presentation-outline">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-2xs font-semibold text-text-primary">{t('presentationMode.outline.title')}</h4>
          <p className="mt-0.5 text-[10px] text-text-tertiary">
            {editable ? t('presentationMode.outline.editHint') : t('presentationMode.outline.readOnlyHint')}
          </p>
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-text-tertiary">
          {t('presentationMode.outline.slideCount', { count: draft.reduce((sum, chapter) => sum + chapter.slides.length, 0) })}
        </span>
      </div>
      <ol className="mt-2.5 space-y-2">
        {draft.map((chapter, chapterIndex) => {
          const slideOffset = draft
            .slice(0, chapterIndex)
            .reduce((total, item) => total + item.slides.length, 0)
          let chapterSummary = null
          if (editable) {
            chapterSummary = (
              <textarea
                className="mt-1 min-h-10 w-full resize-y rounded border border-transparent bg-transparent px-1 py-0.5 text-[10px] leading-4 text-text-tertiary outline-none hover:border-border-default focus:border-accent-primary"
                value={chapter.summary ?? ''}
                onChange={event => patchChapter(chapter.id, { summary: event.target.value })}
                aria-label={t('presentationMode.outline.chapterSummary')}
              />
            )
          } else if (chapter.summary) {
            chapterSummary = <p className="mt-1 text-[10px] leading-4 text-text-tertiary">{chapter.summary}</p>
          }
          return (
            <li
              key={chapter.id}
              className="rounded-lg bg-bg-subtle p-2"
              draggable={editable}
              onDragStart={() => setDragged({ kind: 'chapter', id: chapter.id })}
              onDragOver={event => editable && event.preventDefault()}
              onDrop={() => dropIntoChapter(chapter.id)}
              data-testid="presentation-outline-chapter"
            >
              <div className="flex items-start gap-2">
                <span className={cn('mt-1 shrink-0 text-[10px] font-semibold text-text-accent', editable && 'cursor-move')}>{chapterIndex + 1}</span>
                <div className="min-w-0 flex-1">
                  {editable ? (
                    <input
                      className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-2xs font-semibold text-text-primary outline-none hover:border-border-default focus:border-accent-primary"
                      value={chapter.title}
                      onChange={event => patchChapter(chapter.id, { title: event.target.value })}
                      aria-label={t('presentationMode.outline.chapterTitle')}
                    />
                  ) : <p className="text-2xs font-semibold text-text-primary">{chapter.title}</p>}
                  {chapterSummary}
                </div>
                {editable && (
                  <button className="shrink-0 rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-status-error" onClick={() => removeChapter(chapter.id)} aria-label={t('presentationMode.outline.deleteChapter')}>
                    {Icons.trash(11)}
                  </button>
                )}
              </div>
              <ol className="mt-2 space-y-1.5 border-l border-border-subtle pl-2.5">
                {chapter.slides.map((slide, slideIndex) => {
                  const number = slideOffset + slideIndex + 1
                  return (
                    <li
                      key={slide.id}
                      className="rounded-md bg-bg-surface px-2 py-1.5"
                      draggable={editable}
                      onDragStart={event => {
                        event.stopPropagation()
                        setDragged({ kind: 'slide', chapterId: chapter.id, id: slide.id })
                      }}
                      onDragOver={event => editable && event.preventDefault()}
                      onDrop={event => {
                        event.stopPropagation()
                        dropSlide(chapter.id, slide.id)
                      }}
                      data-testid="presentation-outline-slide"
                    >
                      <div className="flex items-start gap-1.5">
                        <span className={cn('mt-1 shrink-0 text-[9px] tabular-nums text-text-tertiary', editable && 'cursor-move')}>{number}</span>
                        <div className="min-w-0 flex-1">
                          {editable ? (
                            <input
                              className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[10px] font-medium text-text-primary outline-none hover:border-border-default focus:border-accent-primary"
                              value={slide.title}
                              onChange={event => patchSlide(chapter.id, slide.id, { title: event.target.value })}
                              aria-label={t('presentationMode.outline.slideTitle')}
                            />
                          ) : <p className="text-[10px] font-medium leading-4 text-text-primary">{slide.title}</p>}
                          {(editable || slide.purpose) && (editable ? (
                            <input
                              className="mt-0.5 w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[10px] leading-4 text-text-secondary outline-none hover:border-border-default focus:border-accent-primary"
                              value={slide.purpose ?? ''}
                              onChange={event => patchSlide(chapter.id, slide.id, { purpose: event.target.value })}
                              placeholder={t('presentationMode.outline.purpose')}
                              aria-label={t('presentationMode.outline.purpose')}
                            />
                          ) : <p className="mt-0.5 text-[10px] leading-4 text-text-secondary">{slide.purpose}</p>)}
                          {(editable || slide.keyMessage) && (editable ? (
                            <textarea
                              className="mt-0.5 min-h-8 w-full resize-y rounded border border-transparent bg-transparent px-1 py-0.5 text-[10px] leading-4 text-text-tertiary outline-none hover:border-border-default focus:border-accent-primary"
                              value={slide.keyMessage ?? ''}
                              onChange={event => patchSlide(chapter.id, slide.id, { keyMessage: event.target.value })}
                              placeholder={t('presentationMode.outline.keyMessage')}
                              aria-label={t('presentationMode.outline.keyMessage')}
                            />
                          ) : <p className="mt-0.5 text-[10px] leading-4 text-text-tertiary">{slide.keyMessage}</p>)}
                          {slide.sourceIds.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {slide.sourceIds.map(sourceId => (
                                <span key={sourceId} className="max-w-full truncate rounded bg-bg-hover px-1 py-0.5 text-[9px] text-text-tertiary" title={sourceById.get(sourceId)?.title ?? sourceId}>
                                  {sourceById.get(sourceId)?.title ?? sourceId}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        {editable && (
                          <button className="shrink-0 rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-status-error" onClick={() => removeSlide(chapter.id, slide.id)} aria-label={t('presentationMode.outline.deleteSlide')}>
                            {Icons.trash(10)}
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
              {editable && (
                <button className="mt-2 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-text-accent hover:bg-bg-hover" onClick={() => addSlide(chapter.id)}>
                  {Icons.plus(10)} {t('presentationMode.outline.addSlide')}
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {editable && (
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border-subtle pt-2.5">
          <button className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover" onClick={addChapter}>
            {Icons.plus(10)} {t('presentationMode.outline.addChapter')}
          </button>
          <button
            className="rounded-lg bg-accent-primary px-3 py-1.5 text-[10px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!valid || busy}
            onClick={() => onConfirm(draft)}
            data-testid="presentation-outline-confirm"
          >
            {busy ? t('presentationMode.outline.confirming') : t('presentationMode.outline.confirm')}
          </button>
        </div>
      )}
    </section>
  )
}

/** Show live production progress without introducing a separate top-level mode toolbar. */
export function PresentationModePane() {
  const { t } = useTranslation()
  const sessionId = useAtomValue(activeSessionIdAtom)
  const position = useAtomValue(currentThinkingModeAtom)
  const agentRunning = useAtomValue(currentAgentRunningAtom)
  const messages = useAtomValue(currentMessagesAtom)
  const respondOutline = useSetAtom(respondPresentationOutlineAtom)
  const pendingChoice = useAtomValue(currentHumanRequestAtom) !== null
  const [outlineSubmitting, setOutlineSubmitting] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAutoHideScrollbar(scrollRef)

  const activeStageId: PresentationStageId = position?.mode === 'presentation'
    && PRESENTATION_STAGES.some(stage => stage.id === position.stage)
    ? position.stage as PresentationStageId
    : 'ppt_brief'
  const activeIndex = PRESENTATION_STAGES.findIndex(stage => stage.id === activeStageId)
  const activeStage = PRESENTATION_STAGES[activeIndex]!
  const activeStepIndex = Math.min(
    Math.max(0, position?.mode === 'presentation' ? position.presentationStepIndex ?? 0 : 0),
    activeStage.steps.length,
  )
  const completedStepCount = PRESENTATION_STAGES
    .slice(0, activeIndex)
    .reduce((total, stage) => total + stageUnitCount(stage), 0) + activeStepIndex
  const totalStepCount = PRESENTATION_STAGES.reduce((total, stage) => total + stageUnitCount(stage), 0)
  const reports = new Map(
    (position?.mode === 'presentation' ? position.presentationReports ?? [] : [])
      .map(report => [
        `${report.stage}/${report.stepId}`,
        { ...report, evidence: normalizeEvidence(report.evidence) },
      ] as const),
  )
  const sources = position?.mode === 'presentation' ? position.presentationSources ?? [] : []
  const outline = position?.mode === 'presentation' ? position.presentationOutline ?? [] : []
  const outlineRequestId = position?.mode === 'presentation'
    ? position.presentationOutlineConfirmationId ?? null
    : null
  const outlineEditable = activeStageId === 'ppt_plan'
    && Boolean(outlineRequestId)
    && !position?.presentationOutlineConfirmed
  const outlineBusy = outlineSubmitting || (outlineEditable && agentRunning)
  const pendingHuman = pendingChoice || (outlineEditable && !agentRunning)
  const latestAssistant = messages.findLast(message => message.role === 'assistant')
  const failed = Boolean(latestAssistant?.error)
  const overallPercent = totalStepCount === 0
    ? 0
    : Math.round((completedStepCount / totalStepCount) * 100)

  const confirmOutline = (chapters: PresentationChapterOutline[]) => {
    if (!sessionId || !outlineRequestId || outlineBusy) return
    setOutlineSubmitting(true)
    void respondOutline({ sessionId, requestId: outlineRequestId, chapters })
      .finally(() => setOutlineSubmitting(false))
  }

  let status = t('presentationMode.status.paused')
  let statusTone = 'bg-bg-hover text-text-secondary'
  if (pendingHuman) {
    status = t('presentationMode.status.needsInput')
    statusTone = 'bg-status-warning-bg text-status-warning'
  } else if (agentRunning) {
    status = t('presentationMode.status.running')
    statusTone = 'bg-status-info-bg text-status-info'
  } else if (failed) {
    status = t('presentationMode.status.failed')
    statusTone = 'bg-status-error-bg text-status-error'
  }

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg-surface animate-fade"
      data-testid="presentation-mode-pane"
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
      >
        <span className="flex shrink-0 text-text-accent">{Icons.presentation(16)}</span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
          {t('presentationMode.title')}
        </h2>
        <span className="shrink-0 text-2xs tabular-nums text-text-tertiary">
          {completedStepCount}/{totalStepCount}
        </span>
        <span
          className={cn('shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium', statusTone)}
          data-testid="presentation-status"
        >
          {status}
        </span>
      </div>

      <div ref={scrollRef} className="auto-hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="px-4 pb-3 pt-4">
          <section className="rounded-xl bg-bg-subtle px-3.5 py-3" data-testid="presentation-overview">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-xs font-semibold text-text-primary">
                {t(`presentationMode.stages.${activeStage.id}.title`)}
              </span>
              <span className="shrink-0 text-2xs text-text-tertiary">
                {t('presentationMode.progress', { current: activeIndex + 1, total: PRESENTATION_STAGES.length })}
              </span>
            </div>
            {position?.mode === 'presentation' && position.presentationGoal && (
              <p
                className="mt-1.5 line-clamp-3 text-xs leading-5 text-text-secondary"
                data-testid="presentation-goal"
              >
                {position.presentationGoal}
              </p>
            )}
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-stage-track">
              <div
                role="progressbar"
                aria-label={t('presentationMode.stepProgress', { current: completedStepCount, total: totalStepCount })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={overallPercent}
                className="h-full rounded-full bg-[image:var(--brand-gradient)] transition-[width] duration-300"
                style={{ width: `${overallPercent}%` }}
              />
            </div>
          </section>
        </div>

        <ol className="px-4 pb-5 pt-1" aria-label={t('presentationMode.stageAria')}>
          {PRESENTATION_STAGES.map((stage, stageIndex) => {
            const complete = stageIndex < activeIndex
            const current = stageIndex === activeIndex
            let stageStepIndex = 0
            let stageState = 'pending'
            if (complete) {
              stageStepIndex = stage.steps.length
              stageState = 'complete'
            } else if (current) {
              stageStepIndex = activeStepIndex
              stageState = 'current'
            }
            const stepList = (
              <ol className="mt-3 space-y-2.5 border-l border-border-subtle pl-3">
                {stage.steps.map((stepId, stepIndex) => {
                  const stepComplete = stepIndex < stageStepIndex
                  const stepCurrent = current
                    && stepIndex === stageStepIndex
                    && stageStepIndex < stage.steps.length
                  const report = reports.get(`${stage.id}/${stepId}`)
                  let stepState = 'pending'
                  if (stepComplete) stepState = 'complete'
                  else if (stepCurrent) stepState = 'current'
                  return (
                    <li
                      key={stepId}
                      className={cn(
                        'relative',
                        stepCurrent && 'animate-stage-activate motion-reduce:animate-none',
                      )}
                      data-step={stepId}
                      data-state={stepState}
                    >
                      {stepCurrent && agentRunning ? (
                        <span
                          className="absolute -left-[19px] top-1 flex size-3 items-center justify-center rounded-full bg-bg-surface"
                          data-testid="presentation-step-spinner"
                          role="status"
                          aria-label={t('presentationMode.status.running')}
                        >
                          <span className="size-3 animate-spin rounded-full border-2 border-accent-primary/25 border-t-accent-primary motion-reduce:animate-none" />
                        </span>
                      ) : (
                        <span className={cn(
                          'absolute -left-[17px] top-1.5 size-2 rounded-full ring-2 ring-bg-surface',
                          stepComplete && 'bg-status-success',
                          stepCurrent && 'bg-accent-primary',
                          !stepComplete && !stepCurrent && 'bg-border-default',
                        )} />
                      )}
                      <p className={cn(
                        'text-2xs font-medium leading-5',
                        stepCurrent ? 'text-text-primary' : 'text-text-secondary',
                      )}>
                        {t(`presentationMode.steps.${stepId}`)}
                      </p>
                      {report && (
                        <div
                          className="mt-1 animate-enter motion-reduce:animate-none"
                          data-testid={`presentation-report-${stepId}`}
                        >
                          <p className="text-2xs leading-5 text-text-tertiary">{report.summary}</p>
                          {report.evidence.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {report.evidence.slice(0, 3).map(item => (
                                <span
                                  key={item}
                                  className="max-w-full truncate rounded bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-tertiary"
                                  title={item}
                                >
                                  {item}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {stepId === 'collect_evidence' && sources.length > 0 && (
                        <PresentationSourcesPanel sources={sources} />
                      )}
                      {stepId === 'shape_chapters' && outline.length > 0 && !outline.some(chapter => chapter.slides.length > 0) && (
                        <PresentationOutlinePanel
                          key={`chapters-${outline.map(chapter => chapter.id).join('-')}`}
                          chapters={outline}
                          sources={sources}
                          editable={false}
                          busy={false}
                          onConfirm={() => {}}
                        />
                      )}
                      {stepId === 'map_slides' && outline.some(chapter => chapter.slides.length > 0) && (
                        <PresentationOutlinePanel
                          key={outlineRequestId ?? 'confirmed-outline'}
                          chapters={outline}
                          sources={sources}
                          editable={outlineEditable}
                          busy={outlineBusy}
                          onConfirm={confirmOutline}
                        />
                      )}
                    </li>
                  )
                })}
                {current && stage.steps.length > 0 && stageStepIndex === stage.steps.length && (
                  <li className="text-2xs font-medium text-status-success" data-testid="presentation-stage-ready">
                    {t('presentationMode.stageReady')}
                  </li>
                )}
              </ol>
            )
            return (
              <li
                key={stage.id}
                className="relative pb-5 pl-9 last:pb-0"
                data-stage={stage.id}
                data-state={stageState}
              >
                {stageIndex < PRESENTATION_STAGES.length - 1 && (
                  <span className="absolute bottom-0 left-[11px] top-6 w-px bg-border-subtle" aria-hidden="true" />
                )}
                <span className={cn(
                  'absolute left-0 top-0.5 flex size-6 items-center justify-center rounded-full text-2xs font-semibold',
                  complete && 'bg-status-success-bg text-status-success',
                  current && 'bg-accent-primary text-white shadow-sm',
                  !complete && !current && 'border border-border-default bg-bg-surface text-text-tertiary',
                )}>
                  {current && stage.steps.length === 0 && agentRunning ? (
                    <span
                      className="flex size-4 items-center justify-center"
                      data-testid="presentation-stage-spinner"
                      role="status"
                      aria-label={t('presentationMode.status.running')}
                    >
                      <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" />
                    </span>
                  ) : (
                    <span className="relative">{complete ? Icons.check(11) : stageIndex + 1}</span>
                  )}
                </span>
                <div className={cn(
                  'min-w-0 transition-colors',
                  current && 'animate-stage-activate motion-reduce:animate-none',
                )}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className={cn(
                        'text-xs font-semibold',
                        current ? 'text-text-primary' : 'text-text-secondary',
                      )}>
                        {t(`presentationMode.stages.${stage.id}.title`)}
                      </h3>
                      {(complete || current) && stage.steps.length > 0 && (
                        <span className="shrink-0 text-2xs text-text-tertiary">
                          {stageStepIndex}/{stage.steps.length}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-2xs leading-5 text-text-tertiary">
                      {t(`presentationMode.stages.${stage.id}.description`)}
                    </p>
                    {current && stage.steps.length > 0 && stepList}
                    {complete && stage.steps.length > 0 && (
                      <details className="group mt-2">
                        <summary className="cursor-pointer select-none text-2xs font-medium text-text-tertiary hover:text-text-secondary">
                          {t('presentationMode.completedDetails')}
                        </summary>
                        {stepList}
                      </details>
                    )}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
