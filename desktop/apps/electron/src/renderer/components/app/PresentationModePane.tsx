/** Dedicated Agent-owned progress surface for the presentation-making pipeline. */
import type {
  PresentationChapterOutline,
  PresentationSourceCard,
  PresentationTemplateCandidate,
} from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import {
  currentAgentRunningAtom,
  currentMessagesAtom,
  currentThinkingModeAtom,
} from '@/atoms/agent'
import {
  presentationPaneViewFamily,
  presentationTemplateSelectionFamily,
  respondPresentationOutlineAtom,
  respondPresentationTemplateAtom,
  type PresentationPaneView,
} from '@/atoms/presentation-plan'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { currentHumanRequestAtom } from '@/atoms/human-request'
import { Icons } from '@/components/amphi/Icons'
import { useAutoHideScrollbar } from '@/hooks/useAutoHideScrollbar'
import { cn } from '@/lib/cn'
import {
  parseLocalResourceReference,
  toLocalResourceDisplayUrl,
} from '@/components/markdown/localResource'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

const PRESENTATION_STAGES = [
  {
    id: 'ppt_brief',
    steps: [],
  },
  {
    id: 'ppt_plan',
    steps: ['collect_evidence', 'map_slides', 'design_visual_direction'],
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

function PresentationArtifactLink({ title, meta, testId, needsAttention = false, onOpen }: {
  title: string
  meta: string
  testId: string
  needsAttention?: boolean
  onOpen: () => void
}) {
  return (
    <button
      className="mt-2 flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-2 text-left transition-colors hover:border-border-default hover:bg-bg-hover"
      onClick={onOpen}
      data-testid={testId}
    >
      <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md', needsAttention ? 'bg-status-warning-bg text-status-warning' : 'bg-bg-subtle text-text-accent')}>
        {needsAttention ? Icons.edit(12) : Icons.file(12)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs font-medium text-text-primary">{title}</span>
        <span className="block truncate text-[10px] text-text-tertiary">{meta}</span>
      </span>
      <span className="shrink-0 text-text-tertiary">{Icons.chevronRight(12)}</span>
    </button>
  )
}

function PresentationSourcesPanel({ sources }: { sources: PresentationSourceCard[] }) {
  const { t } = useTranslation()
  if (sources.length === 0) return null
  return (
    <section className="space-y-2" data-testid="presentation-sources">
      <p className="pb-1 text-2xs leading-5 text-text-tertiary">{t('presentationMode.sources.detailHint')}</p>
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

function templatePreviewUrl(sourceValue: string): string | null {
  const source = sourceValue.trim()
  if (!source) return null
  const local = parseLocalResourceReference(source)
  if (local?.kind === 'image') return toLocalResourceDisplayUrl(local.fileUrl)
  try {
    const url = new URL(source)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function templateColor(value: string | undefined, fallback: string): string {
  return value && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value.trim()) ? value.trim() : fallback
}

function PresentationTemplatePreview({ candidate, hovering }: {
  candidate: PresentationTemplateCandidate
  hovering: boolean
}) {
  const { t } = useTranslation()
  const [activeIndex, setActiveIndex] = useState(0)
  const [failedUrls, setFailedUrls] = useState<string[]>([])
  const previewUrls = candidate.previewPaths
    .map(templatePreviewUrl)
    .filter((value): value is string => value !== null)
  const previewKey = previewUrls.join('\u0000')
  const availableUrls = previewUrls.filter(url => !failedUrls.includes(url))
  const previewUrl = availableUrls.length > 0 ? availableUrls[activeIndex % availableUrls.length] : null
  const paper = templateColor(candidate.colors[0], '#f8f6f1')
  const ink = templateColor(candidate.colors[1], '#273142')
  const accent = templateColor(candidate.colors[2], '#7c6cf2')

  useEffect(() => {
    if (!hovering || availableUrls.length < 2) return
    const timer = window.setInterval(() => {
      setActiveIndex(current => (current + 1) % availableUrls.length)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [availableUrls.length, hovering, previewKey])

  if (previewUrl) {
    return (
      <div
        className="relative size-full"
        data-testid="presentation-template-preview"
      >
        <img
          key={previewUrl}
          src={previewUrl}
          alt={t('presentationMode.templates.previewAlt', { title: candidate.title })}
          className="size-full bg-black/5 object-contain"
          loading="lazy"
          onError={() => setFailedUrls(current => current.includes(previewUrl) ? current : [...current, previewUrl])}
        />
        {availableUrls.length > 1 && hovering && (
          <span className="absolute bottom-2 right-2 rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-white backdrop-blur-sm">
            {(activeIndex % availableUrls.length) + 1}/{availableUrls.length}
          </span>
        )}
      </div>
    )
  }
  return (
    <div
      className="relative size-full overflow-hidden"
      style={{ backgroundColor: paper }}
      aria-label={t('presentationMode.templates.noPreview')}
    >
      <span className="absolute left-[9%] top-[13%] h-[7%] w-[48%] rounded-sm opacity-90" style={{ backgroundColor: ink }} />
      <span className="absolute left-[9%] top-[25%] h-[3%] w-[31%] rounded-sm opacity-30" style={{ backgroundColor: ink }} />
      <span className="absolute bottom-[14%] left-[9%] h-[39%] w-[35%] rounded-md opacity-15" style={{ backgroundColor: ink }} />
      <span className="absolute bottom-[14%] right-[9%] h-[52%] w-[39%] rounded-md opacity-80" style={{ backgroundColor: accent }} />
      <span className="absolute bottom-[9%] left-[9%] text-[9px] font-medium opacity-45" style={{ color: ink }}>
        {t('presentationMode.templates.structuralPreview')}
      </span>
    </div>
  )
}

function PresentationTemplatesPanel({
  candidates,
  retrievalError,
  selectedId,
  interactive,
  busy,
  onSelect,
  onAnswer,
}: {
  candidates: PresentationTemplateCandidate[]
  retrievalError?: string | null
  selectedId: string | null
  interactive: boolean
  busy: boolean
  onSelect: (templateId: string) => void
  onAnswer: (action: 'select' | 'skip' | 'refresh') => void
}) {
  const { t } = useTranslation()
  const [hoveredTemplateId, setHoveredTemplateId] = useState<string | null>(null)
  return (
    <section className="pb-24" data-testid="presentation-templates-detail">
      <div className="rounded-xl border border-border-subtle bg-bg-elevated px-3.5 py-3 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent-blue-subtle text-text-accent">
            {Icons.presentation(14)}
          </span>
          {t('presentationMode.templates.galleryTitle')}
          <span className="ml-auto rounded-full bg-bg-subtle px-2 py-1 text-2xs font-medium tabular-nums text-text-secondary">
            {t('presentationMode.templates.count', { count: candidates.length })}
          </span>
        </div>
        <p className="mt-2 text-xs leading-5 text-text-tertiary">
          {t('presentationMode.templates.galleryHint')}
        </p>
      </div>

      {candidates.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border-default px-4 py-10 text-center text-xs text-text-tertiary">
          <p>{t('presentationMode.templates.empty')}</p>
          {retrievalError && (
            <p className="mx-auto mt-2 max-w-md text-[10px] leading-4 text-status-warning" data-testid="presentation-template-error">
              {retrievalError}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3" data-testid="presentation-template-grid">
          {candidates.map((candidate, index) => {
            const selected = candidate.templateId === selectedId
            let badge = t('presentationMode.templates.candidate')
            if (candidate.agenticFit === 'strong') badge = t('presentationMode.templates.strongFit')
            if (index === 0) badge = t('presentationMode.templates.bestMatch')
            return (
              <button
                key={candidate.templateId}
                type="button"
                onClick={() => {
                  if (interactive) onSelect(candidate.templateId)
                }}
                onMouseEnter={() => setHoveredTemplateId(candidate.templateId)}
                onMouseLeave={() => setHoveredTemplateId(null)}
                className={cn(
                  'group overflow-hidden rounded-xl border bg-bg-elevated text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-border-default hover:shadow-md',
                  selected ? 'border-accent-primary ring-2 ring-accent-primary/20' : 'border-border-subtle',
                )}
                aria-pressed={selected}
                aria-disabled={!interactive}
                data-testid="presentation-template-card"
                data-template-id={candidate.templateId}
              >
                <div className="relative aspect-video overflow-hidden border-b border-border-subtle bg-bg-subtle">
                  <PresentationTemplatePreview
                    key={`${candidate.templateId}:${candidate.version}:${hoveredTemplateId === candidate.templateId ? 'hover' : 'idle'}`}
                    candidate={candidate}
                    hovering={hoveredTemplateId === candidate.templateId}
                  />
                  <span className="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-semibold text-white backdrop-blur-sm">
                    {badge}
                  </span>
                  {selected && (
                    <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-accent-primary text-white shadow">
                      {Icons.check(12)}
                    </span>
                  )}
                </div>
                <div className="px-2.5 py-2.5">
                  <p className="truncate text-xs font-semibold text-text-primary" title={candidate.title}>{candidate.title}</p>
                  <p className="mt-1 text-[10px] tabular-nums text-text-tertiary">
                    {candidate.aspectRatio || t('presentationMode.templates.unknownRatio')}
                    {typeof candidate.slideCount === 'number'
                      ? ` · ${t('presentationMode.templates.slideCount', { count: candidate.slideCount })}`
                      : ''}
                    {typeof candidate.roleCoverage === 'number'
                      ? ` · ${t('presentationMode.templates.coverage', { percent: Math.round(candidate.roleCoverage * 100) })}`
                      : ''}
                  </p>
                  {candidate.agenticReason && (
                    <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-text-secondary">
                      {candidate.agenticReason}
                    </p>
                  )}
                  {(candidate.strengths.length > 0 || candidate.semanticTags.length > 0) && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {[...candidate.strengths, ...candidate.semanticTags].slice(0, 3).map((tag, tagIndex) => (
                        <span key={`${tag}-${tagIndex}`} className="max-w-full truncate rounded bg-bg-subtle px-1.5 py-0.5 text-[9px] text-text-tertiary">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {interactive && <div className="sticky bottom-0 -mx-4 mt-4 flex items-center gap-2 border-t border-border-subtle bg-bg-surface/95 px-4 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.06)] backdrop-blur">
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer('refresh')}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          data-testid="presentation-template-refresh"
        >
          {Icons.refresh(13)} {t(candidates.length > 0
            ? 'presentationMode.templates.refresh'
            : 'presentationMode.templates.retry')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer('skip')}
          className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          data-testid="presentation-template-skip"
        >
          {t('presentationMode.templates.skip')}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          disabled={busy || !selectedId}
          onClick={() => onAnswer('select')}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[image:var(--brand-gradient)] px-3 text-xs font-semibold text-text-on-brand disabled:opacity-50"
          data-testid="presentation-template-confirm"
        >
          {Icons.check(13)} {busy
            ? t('presentationMode.templates.confirming')
            : t('presentationMode.templates.confirm')}
        </button>
      </div>}
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
  const [expandedChapterIds, setExpandedChapterIds] = useState<Set<string>>(new Set())
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
  const toggleChapter = (chapterId: string) => {
    setExpandedChapterIds(current => {
      const next = new Set(current)
      if (next.has(chapterId)) next.delete(chapterId)
      else next.add(chapterId)
      return next
    })
  }
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
            contentOutline: [''],
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
    && draft.every(chapter => chapter.title.trim() && chapter.slides.every(slide => (
      slide.title.trim() && slide.contentOutline.some(item => item.trim())
    )))
    && draft.some(chapter => chapter.slides.length > 0)
  return (
    <section className="pb-2" data-testid="presentation-outline">
      <div className="rounded-xl border border-border-subtle bg-bg-elevated px-3.5 py-3 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent-blue-subtle text-text-accent">
            {Icons.file(14)}
          </span>
          {t('presentationMode.outline.slideBlueprint')}
          <span className="ml-auto rounded-full bg-bg-subtle px-2 py-1 text-2xs font-medium tabular-nums text-text-secondary">
            {t('presentationMode.outline.summary', {
              chapters: draft.length,
              slides: draft.reduce((total, chapter) => total + chapter.slides.length, 0),
            })}
          </span>
        </div>
        <p className="mt-2 text-xs leading-5 text-text-tertiary">
          {editable ? t('presentationMode.outline.editHint') : t('presentationMode.outline.readOnlyHint')}
        </p>
      </div>
      <ol className="mt-3 space-y-3">
        {draft.map((chapter, chapterIndex) => {
          const slideOffset = draft
            .slice(0, chapterIndex)
            .reduce((total, item) => total + item.slides.length, 0)
          const expanded = expandedChapterIds.has(chapter.id)
          let chapterSummary = null
          if (editable) {
            chapterSummary = (
              <textarea
                className="mt-1 min-h-12 w-full resize-y rounded-md border border-border-subtle bg-bg-input px-2 py-1.5 text-2xs leading-5 text-text-tertiary outline-none focus:border-accent-primary"
                value={chapter.summary ?? ''}
                onChange={event => patchChapter(chapter.id, { summary: event.target.value })}
                aria-label={t('presentationMode.outline.chapterSummary')}
              />
            )
          } else if (chapter.summary) {
            chapterSummary = <p className="mt-1 text-2xs leading-5 text-text-tertiary">{chapter.summary}</p>
          }
          return (
            <li
              key={chapter.id}
              className="overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated shadow-sm transition-colors hover:border-border-default"
              draggable={editable}
              onDragStart={() => setDragged({ kind: 'chapter', id: chapter.id })}
              onDragOver={event => editable && event.preventDefault()}
              onDrop={() => dropIntoChapter(chapter.id)}
              data-testid="presentation-outline-chapter"
            >
              <div className="flex items-start gap-2.5 px-3 py-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-blue-subtle text-xs font-semibold tabular-nums text-text-accent">
                  {chapterIndex + 1}
                </span>
                <button
                  className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
                  onClick={() => toggleChapter(chapter.id)}
                  aria-expanded={expanded}
                  aria-label={t(expanded ? 'presentationMode.outline.collapseChapter' : 'presentationMode.outline.expandChapter', { title: chapter.title })}
                >
                  {expanded ? Icons.chevronDown(13) : Icons.chevronRight(13)}
                </button>
                <div className="min-w-0 flex-1">
                  {editable ? (
                    <input
                      className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs font-semibold text-text-primary outline-none hover:border-border-default focus:border-accent-primary focus:bg-bg-input"
                      value={chapter.title}
                      onChange={event => patchChapter(chapter.id, { title: event.target.value })}
                      aria-label={t('presentationMode.outline.chapterTitle')}
                    />
                  ) : <p className="py-1 text-xs font-semibold text-text-primary">{chapter.title}</p>}
                  {expanded && chapterSummary}
                </div>
                <span className="mt-0.5 shrink-0 rounded-full bg-bg-subtle px-2 py-1 text-2xs tabular-nums text-text-tertiary">
                  {t('presentationMode.outline.slideCount', { count: chapter.slides.length })}
                </span>
                {editable && (
                  <button className="mt-0.5 shrink-0 rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-status-error" onClick={() => removeChapter(chapter.id)} aria-label={t('presentationMode.outline.deleteChapter')}>
                    {Icons.trash(12)}
                  </button>
                )}
              </div>
              {expanded && <ol className="space-y-2 border-t border-border-subtle bg-bg-subtle/40 px-3 py-3">
                {chapter.slides.map((slide, slideIndex) => {
                  const number = slideOffset + slideIndex + 1
                  return (
                    <li
                      key={slide.id}
                      className="rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-2.5 transition-colors hover:border-border-default"
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
                      <div className="flex items-start gap-2.5">
                        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-2xs font-semibold tabular-nums text-text-secondary', editable && 'cursor-move')}>{number}</span>
                        <div className="min-w-0 flex-1">
                          {editable ? (
                            <input
                              className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs font-semibold text-text-primary outline-none hover:border-border-default focus:border-accent-primary focus:bg-bg-input"
                              value={slide.title}
                              onChange={event => patchSlide(chapter.id, slide.id, { title: event.target.value })}
                              aria-label={t('presentationMode.outline.slideTitle')}
                            />
                          ) : <p className="text-xs font-semibold leading-5 text-text-primary">{slide.title}</p>}
                          {(editable || slide.purpose) && (editable ? (
                            <input
                              className="mt-1 w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-2xs leading-5 text-text-secondary outline-none hover:border-border-default focus:border-accent-primary focus:bg-bg-input"
                              value={slide.purpose ?? ''}
                              onChange={event => patchSlide(chapter.id, slide.id, { purpose: event.target.value })}
                              placeholder={t('presentationMode.outline.purpose')}
                              aria-label={t('presentationMode.outline.purpose')}
                            />
                          ) : <p className="mt-1 text-2xs leading-5 text-text-secondary">{slide.purpose}</p>)}
                          {(editable || slide.keyMessage) && (editable ? (
                            <textarea
                              className="mt-1 min-h-9 w-full resize-y rounded-md border border-transparent bg-transparent px-1.5 py-1 text-2xs leading-5 text-text-tertiary outline-none hover:border-border-default focus:border-accent-primary focus:bg-bg-input"
                              value={slide.keyMessage ?? ''}
                              onChange={event => patchSlide(chapter.id, slide.id, { keyMessage: event.target.value })}
                              placeholder={t('presentationMode.outline.keyMessage')}
                              aria-label={t('presentationMode.outline.keyMessage')}
                            />
                          ) : <p className="mt-1 text-2xs leading-5 text-text-tertiary">{slide.keyMessage}</p>)}
                          {editable ? (
                            <textarea
                              className="mt-2 min-h-20 w-full resize-y rounded-lg border border-border-subtle bg-bg-input px-2.5 py-2 text-2xs leading-5 text-text-secondary outline-none focus:border-accent-primary"
                              value={slide.contentOutline.join('\n')}
                              onChange={event => patchSlide(chapter.id, slide.id, {
                                contentOutline: event.target.value.split('\n').slice(0, 8),
                              })}
                              placeholder={t('presentationMode.outline.contentOutline')}
                              aria-label={t('presentationMode.outline.contentOutline')}
                            />
                          ) : slide.contentOutline.length > 0 && (
                            <ul className="mt-2 space-y-1 text-2xs leading-5 text-text-tertiary">
                              {slide.contentOutline.map((item, itemIndex) => item.trim() && (
                                <li key={`${slide.id}-content-${itemIndex}`} className="flex gap-1.5">
                                  <span className="text-text-accent">•</span>
                                  <span>{item}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {slide.sourceIds.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {slide.sourceIds.map(sourceId => (
                                <span key={sourceId} className="max-w-full truncate rounded-md bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-tertiary" title={sourceById.get(sourceId)?.title ?? sourceId}>
                                  {sourceById.get(sourceId)?.title ?? sourceId}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        {editable && (
                          <button className="shrink-0 rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-status-error" onClick={() => removeSlide(chapter.id, slide.id)} aria-label={t('presentationMode.outline.deleteSlide')}>
                            {Icons.trash(11)}
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>}
              {editable && expanded && (
                <button className="mx-3 mb-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-2xs font-medium text-text-accent hover:bg-bg-hover" onClick={() => addSlide(chapter.id)}>
                  {Icons.plus(11)} {t('presentationMode.outline.addSlide')}
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {editable && (
        <div className="sticky bottom-0 mt-4 flex items-center justify-between gap-2 rounded-xl border border-border-subtle bg-bg-elevated/95 p-2.5 shadow-lg backdrop-blur">
          <button className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-text-secondary hover:bg-bg-hover" onClick={addChapter}>
            {Icons.plus(12)} {t('presentationMode.outline.addChapter')}
          </button>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[image:var(--brand-gradient)] px-3 text-xs font-semibold text-text-on-brand disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!valid || busy}
            onClick={() => onConfirm(draft)}
            data-testid="presentation-outline-confirm"
          >
            {Icons.check(12)} {busy ? t('presentationMode.outline.confirming') : t('presentationMode.outline.confirm')}
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
  const respondTemplate = useSetAtom(respondPresentationTemplateAtom)
  const pendingChoice = useAtomValue(currentHumanRequestAtom) !== null
  const [outlineSubmitting, setOutlineSubmitting] = useState(false)
  const [templateSubmitting, setTemplateSubmitting] = useState(false)
  const [paneView, setStoredPaneView] = useAtom(presentationPaneViewFamily(sessionId ?? ''))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAutoHideScrollbar(scrollRef)

  const setPaneView = (view: PresentationPaneView) => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setStoredPaneView(view)
  }

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
  const outlineSlideCount = outline.reduce((total, chapter) => total + chapter.slides.length, 0)
  const outlineRequestId = position?.mode === 'presentation'
    ? position.presentationOutlineConfirmationId ?? null
    : null
  const outlineEditable = activeStageId === 'ppt_plan'
    && Boolean(outlineRequestId)
    && !position?.presentationOutlineConfirmed
  const outlineBusy = outlineSubmitting || (outlineEditable && agentRunning)
  const templateCandidates = position?.mode === 'presentation'
    ? position.presentationTemplateCandidates ?? []
    : []
  const templateRequestId = position?.mode === 'presentation'
    ? position.presentationTemplateSelectionId ?? null
    : null
  const templateStatus = position?.mode === 'presentation'
    ? position.presentationTemplateSelectionStatus ?? 'idle'
    : 'idle'
  const templateError = position?.mode === 'presentation'
    ? position.presentationTemplateSelectionError ?? null
    : null
  const [selectedTemplateId, setSelectedTemplateId] = useAtom(
    presentationTemplateSelectionFamily(templateRequestId ?? ''),
  )
  const templatePending = Boolean(templateRequestId) && templateStatus === 'pending'
  let displayedTemplateId: string | null = null
  if (templatePending) {
    displayedTemplateId = selectedTemplateId
  } else if (templateStatus === 'selected') {
    displayedTemplateId = position?.presentationSelectedTemplate?.templateId ?? null
  }
  const templateBusy = templateSubmitting || (templatePending && agentRunning)
  const pendingHuman = pendingChoice
    || (outlineEditable && !agentRunning)
    || (templatePending && !agentRunning)
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

  const answerTemplate = (action: 'select' | 'skip' | 'refresh') => {
    if (!sessionId || !templateRequestId || templateBusy) return
    if (action === 'select' && !selectedTemplateId) return
    setTemplateSubmitting(true)
    void respondTemplate({
      sessionId,
      requestId: templateRequestId,
      action,
      ...(action === 'select' && selectedTemplateId ? { templateId: selectedTemplateId } : {}),
    }).finally(() => {
      setTemplateSubmitting(false)
      setPaneView('progress')
    })
  }

  useEffect(() => {
    if (templatePending && templateCandidates.length > 0) setStoredPaneView('templates')
  }, [setStoredPaneView, templateCandidates.length, templatePending, templateRequestId])

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
  let detailTitle = t('presentationMode.outline.title')
  let detailMeta = t('presentationMode.outline.summary', { chapters: outline.length, slides: outlineSlideCount })
  if (paneView === 'sources') {
    detailTitle = t('presentationMode.sources.title')
    detailMeta = t('presentationMode.sources.count', { count: sources.length })
  } else if (paneView === 'templates') {
    detailTitle = t('presentationMode.templates.title')
    detailMeta = t('presentationMode.templates.count', { count: templateCandidates.length })
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
        {paneView === 'progress' ? (
          <span className="flex shrink-0 text-text-accent">{Icons.presentation(16)}</span>
        ) : (
          <button
            className="flex size-6 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            onClick={() => setPaneView('progress')}
            aria-label={t('presentationMode.backToProgress')}
            data-testid="presentation-detail-back"
          >
            <span className="rotate-180">{Icons.chevronRight(14)}</span>
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
          {paneView === 'progress' ? t('presentationMode.title') : detailTitle}
        </h2>
        {paneView === 'progress' ? (
          <span
            className={cn('shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium', statusTone)}
            data-testid="presentation-status"
          >
            {status}
          </span>
        ) : (
          <span className="shrink-0 text-2xs tabular-nums text-text-tertiary">{detailMeta}</span>
        )}
      </div>

      <div ref={scrollRef} className="auto-hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {paneView === 'sources' && (
          <div className="px-4 py-4" data-testid="presentation-sources-detail">
            <PresentationSourcesPanel sources={sources} />
          </div>
        )}
        {paneView === 'outline' && (
          <div className="px-4 py-4" data-testid="presentation-outline-detail">
            <PresentationOutlinePanel
              key={outlineRequestId ?? `outline-${outline.map(chapter => chapter.id).join('-')}`}
              chapters={outline}
              sources={sources}
              editable={outlineEditable}
              busy={outlineBusy}
              onConfirm={confirmOutline}
            />
          </div>
        )}
        {paneView === 'templates' && (
          <div className="px-4 py-4">
            <PresentationTemplatesPanel
              candidates={templateCandidates}
              retrievalError={templateError}
              selectedId={displayedTemplateId}
              interactive={templatePending}
              busy={templateBusy}
              onSelect={setSelectedTemplateId}
              onAnswer={answerTemplate}
            />
          </div>
        )}
        {paneView === 'progress' && <>
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
                  const ownsDetailArtifact = stepId === 'collect_evidence'
                    || stepId === 'map_slides'
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
                          className="absolute -left-[20px] top-0.5 flex size-4 items-center justify-center rounded-full bg-bg-surface text-accent-primary"
                          data-testid="presentation-step-spinner"
                          role="status"
                          aria-label={t('presentationMode.status.running')}
                        >
                          <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.4} />
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
                          <p className="line-clamp-2 text-2xs leading-5 text-text-tertiary">{report.summary}</p>
                          {!ownsDetailArtifact && report.evidence.length > 0 && (
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
                        <PresentationArtifactLink
                          title={t('presentationMode.sources.title')}
                          meta={t('presentationMode.sources.count', { count: sources.length })}
                          testId="presentation-open-sources"
                          onOpen={() => setPaneView('sources')}
                        />
                      )}
                      {stepId === 'map_slides' && outlineSlideCount > 0 && (
                        <PresentationArtifactLink
                          title={t('presentationMode.outline.slideBlueprint')}
                          meta={t('presentationMode.outline.summary', { chapters: outline.length, slides: outlineSlideCount })}
                          testId="presentation-open-outline"
                          needsAttention={outlineEditable}
                          onOpen={() => setPaneView('outline')}
                        />
                      )}
                      {stepId === 'design_visual_direction' && templateCandidates.length > 0 && (
                        <PresentationArtifactLink
                          title={t('presentationMode.templates.title')}
                          meta={templateStatus === 'selected'
                            ? t('presentationMode.templates.selected')
                            : t('presentationMode.templates.count', { count: templateCandidates.length })}
                          testId="presentation-open-templates"
                          needsAttention={templatePending}
                          onOpen={() => setPaneView('templates')}
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
                      <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.4} />
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
        </>}
      </div>
    </div>
  )
}
