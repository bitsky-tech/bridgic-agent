/**
 * HumanRequestBanner — inline "agent asks the user to choose" prompt (daemon path).
 *
 * Reads the active session's pending `human_request` (`currentHumanRequestAtom`)
 * and renders one interaction card for option or free-text questions.
 *
 * Multi-question asks render a tab bar (one tab per question, ✓ once answered)
 * with the active question's options below. Compact questions get a free-form
 * "other" row by default; review lists use collapsible option previews and may
 * allow an explicit no-selection answer.
 *
 * Interaction (keyboard-first, mouse-equivalent):
 *   - picking a single-select option auto-advances to the next UNANSWERED
 *     question (multi-select stays put — you pick several). Once everything is
 *     answered it stays on the current tab; it NEVER auto-submits.
 *   - the banner grabs focus on mount and is fully keyboard-drivable: `1`–`9`
 *     pick the Nth option of the active question, `↑/↓` (and `←/→`) switch
 *     question, `Enter` submits — or, when something is unanswered, jumps to
 *     the first unanswered question (same as clicking the disabled-looking
 *     submit). While the caret sits in an "other" field only `Enter` is
 *     intercepted; every other key types normally.
 *
 * Submitting sends the composed `question: answer` lines through the normal
 * chat pipeline (`respondHumanRequestAtom` → `appendUserMessageAtom`): the
 * daemon resumes the suspended turn off the session's PENDING status. Typing
 * in the composer instead of picking also answers as a whole (same frames)
 * and dismisses this banner.
 *
 * Styling: Tailwind className only (§1.22); tabs + option rows use the
 * canonical "1px transparent border, swap to brand on selected" pattern (§LS1).
 */
import type { AskUserQuestion } from '@shared/types'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  currentHumanRequestAtom,
  nextUnansweredIndex,
  respondHumanRequestAtom,
  type HumanRequest,
} from '@/atoms/human-request'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { cn } from '@/lib/cn'
import { Btn } from '../amphi/Primitives'
import { Icons } from '../amphi/Icons'

export function HumanRequestBanner({ floating = false }: { floating?: boolean }) {
  const pending = useAtomValue(currentHumanRequestAtom)
  if (!pending) return null
  const requestKey = pending.requestId ?? `${pending.sessionId}:${pending.questions[0]?.question ?? ''}`
  return <HumanRequestChoice key={requestKey} request={pending} floating={floating} />
}

/** A question's resolved answer: the "other" text wins for single-select;
 *  multi-select joins picked labels + the other text. Empty = unanswered. */
function resolveAnswer(q: AskUserQuestion, picked: string[], other: string, empty: boolean, noneLabel: string): string {
  if (empty) return q.emptyLabel || noneLabel
  const free = other.trim()
  if (!q.multiSelect) return free || picked[0] || ''
  return [...picked, free].filter(Boolean).join(',')
}

function selectionCount(picked: string[], other: string): number {
  return picked.length + (other.trim() ? 1 : 0)
}

function OptionMarker({ review, selected, index }: { review: boolean; selected: boolean; index: number }) {
  if (review) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center text-2xs font-bold',
          selected
            ? 'border-brand-blue bg-brand-blue text-white'
            : 'border-border-default bg-bg-surface',
        )}
      >
        {selected ? '✓' : ''}
      </span>
    )
  }
  if (index >= 9) return null
  return (
    <span className="text-xs leading-5 text-text-tertiary tabular-nums select-none">
      {index + 1}
    </span>
  )
}

interface ChooseAskProps {
  request: HumanRequest
  floating?: boolean
}

export function HumanRequestChoice({ request, floating = false }: ChooseAskProps) {
  const { t } = useTranslation()
  const respond = useSetAtom(respondHumanRequestAtom)
  const questions = request.questions ?? []
  // picked option label(s) + free-form "other" text, keyed by question INDEX —
  // NOT question text: two questions in one ask may share identical text, which
  // keying by text would collapse (shared selection state + duplicate React
  // keys). The daemon splices the composed text back into the suspended ask.
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [others, setOthers] = useState<Record<number, string>>({})
  const [emptySelections, setEmptySelections] = useState<Record<number, boolean>>({})
  const [expandedPreviews, setExpandedPreviews] = useState<Set<string>>(new Set())
  const [activeIdx, setActiveIdx] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const active = questions[activeIdx]
  const activeReviewList = active?.layout === 'review-list' || active?.multiSelect === true

  function pick(i: number, q: AskUserQuestion, label: string): void {
    setEmptySelections((prev) => ({ ...prev, [i]: false }))
    setPicked((prev) => {
      if (!q.multiSelect) return { ...prev, [i]: [label] }
      const cur = new Set(prev[i] ?? [])
      if (cur.has(label)) cur.delete(label)
      else {
        const maximum = q.maxSelections ?? q.options.length
        if (cur.size >= maximum) return prev
        cur.add(label)
      }
      return { ...prev, [i]: [...cur] }
    })
    // Multi-select needs several picks — stay on the tab so the user keeps going.
    if (q.multiSelect) return
    // Single-select: the pick supersedes any typed "other", and this question is
    // now answered — auto-advance focus to the next still-unanswered question.
    setOthers((prev) => ({ ...prev, [i]: '' }))
    const answeredAfter = questions.map((qq, j) => (j === i ? true : answerOf(j, qq) !== ''))
    setActiveIdx(nextUnansweredIndex(answeredAfter, i))
  }

  function typeOther(i: number, q: AskUserQuestion, text: string): void {
    setEmptySelections((prev) => ({ ...prev, [i]: false }))
    setOthers((prev) => ({ ...prev, [i]: text }))
    // Single-select: a typed "other" supersedes any picked option.
    if (!q.multiSelect && text.trim()) setPicked((prev) => ({ ...prev, [i]: [] }))
  }

  function isSelected(i: number, q: AskUserQuestion, label: string): boolean {
    return (picked[i] ?? []).includes(label)
  }

  function answerOf(i: number, q: AskUserQuestion): string {
    return resolveAnswer(q, picked[i] ?? [], others[i] ?? '', emptySelections[i] === true, t('humanRequest.none'))
  }

  function isAnswered(i: number, q: AskUserQuestion): boolean {
    if (emptySelections[i]) return q.allowEmpty === true
    const count = selectionCount(picked[i] ?? [], others[i] ?? '')
    if (count === 0) return false
    const minimum = q.minSelections ?? 1
    const maximum = q.maxSelections ?? (q.multiSelect ? q.options.length : 1)
    return count >= minimum && count <= maximum
  }

  function chooseEmpty(i: number): void {
    setPicked((prev) => ({ ...prev, [i]: [] }))
    setOthers((prev) => ({ ...prev, [i]: '' }))
    setEmptySelections((prev) => ({ ...prev, [i]: true }))
  }

  function selectAll(i: number, q: AskUserQuestion): void {
    const maximum = q.maxSelections ?? q.options.length
    setPicked((prev) => ({
      ...prev,
      [i]: q.options.slice(0, maximum).map((option) => option.label),
    }))
    setOthers((prev) => ({ ...prev, [i]: '' }))
    setEmptySelections((prev) => ({ ...prev, [i]: false }))
  }

  function togglePreview(questionIndex: number, optionIndex: number): void {
    const key = `${questionIndex}:${optionIndex}`
    setExpandedPreviews((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function stopNestedInteraction(event: React.MouseEvent<HTMLElement>): void {
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('a, button, img, input, textarea, select, [role="button"]')
    ) {
      event.stopPropagation()
    }
  }

  const allAnswered = questions.every((q, i) => isAnswered(i, q))
  const answeredCount = questions.reduce((n, q, i) => n + (isAnswered(i, q) ? 1 : 0), 0)
  const remaining = questions.length - answeredCount
  const multi = questions.length > 1
  const acceptanceReview = request.kind === 'accept_rule'
  const acceptanceRuleCount = request.rules?.length ?? 0
  const answeredRuleCount = acceptanceReview
    ? questions.slice(0, acceptanceRuleCount).filter((q, index) => isAnswered(index, q)).length
    : 0
  const remainingRuleCount = acceptanceRuleCount - answeredRuleCount

  function submit(): void {
    if (!allAnswered) {
      if (acceptanceReview && multi) {
        setActiveIdx((current) => (current + 1) % questions.length)
        return
      }
      // Other multi-question asks jump directly to their first unanswered item.
      const idx = questions.findIndex((q, i) => !isAnswered(i, q))
      if (idx >= 0) setActiveIdx(idx)
      return
    }
    const answers = questions.map((q, i) => {
      const answer = answerOf(i, q)
      const selected = !others[i]?.trim() && (picked[i] ?? []).length === 1
        ? q.options.find((option) => option.label === picked[i]?.[0])
        : undefined
      return {
        question: q.question,
        answer,
        ...(selected?.id ? { optionId: selected.id } : {}),
      }
    })
    void respond({
      sessionId: request.sessionId,
      answers,
    })
  }

  function chooseExecutionOnly(): void {
    void respond({
      sessionId: request.sessionId,
      answers: [],
      acceptanceMode: 'execution_only',
    })
  }

  // Keyboard host: the banner grabs focus on mount so number keys / arrows /
  // Enter work without a click. Number keys pick the active question's options,
  // arrows switch question, Enter submits (or jumps to the first unanswered).
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // preventScroll: focusing the inline banner must not yank the chat scroll.
    containerRef.current?.focus({ preventScroll: true })
  }, [])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
      return
    }
    if (questions.length > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) {
      e.preventDefault()
      setActiveIdx((cur) => (cur + 1) % questions.length)
      return
    }
    if (questions.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setActiveIdx((cur) => (cur - 1 + questions.length) % questions.length)
      return
    }
    // Bare 1-9 pick options; skip modifier combos (Cmd+1 etc. are app shortcuts).
    if (e.metaKey || e.ctrlKey || e.altKey || !active) return
    const n = Number(e.key)
    const opt = Number.isInteger(n) && n >= 1 ? active.options[n - 1] : undefined
    if (!opt) return
    e.preventDefault()
    pick(activeIdx, active, opt.label)
  }

  if (floating && collapsed) {
    let summary = active?.question ?? t('humanRequest.waitingSummary')
    if (acceptanceReview) {
      if (acceptanceRuleCount === 1) {
        summary = remainingRuleCount > 0
          ? t('humanRequest.acceptance.singlePending')
          : t('humanRequest.acceptance.singleDone')
      } else {
        summary = remainingRuleCount > 0
          ? t('humanRequest.acceptance.multiPending', { n: remainingRuleCount })
          : t('humanRequest.acceptance.multiDone')
      }
    }
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-border-default bg-bg-elevated px-3.5 text-left shadow-lg animate-focus-enter hover:border-brand-blue/50"
        aria-label={t('humanRequest.expandAria')}
      >
        <span className="flex shrink-0 text-text-accent">{Icons.chat(15)}</span>
        <span className="shrink-0 text-xs font-semibold text-text-primary">{t('humanRequest.waitingTitle')}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{summary}</span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-text-accent">
          {t('humanRequest.expand')} {Icons.chevronDown(12)}
        </span>
      </button>
    )
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative mb-2 rounded-md border border-border-default bg-bg-surface p-3 outline-none',
        floating && 'mb-0 flex max-h-[min(520px,calc(100dvh_-_200px))] flex-col overflow-hidden rounded-xl bg-bg-elevated shadow-xl animate-focus-enter',
        acceptanceReview && 'border-brand-blue/40 bg-bg-elevated p-4',
      )}
    >
      {acceptanceReview && (
        <div className="mb-4 flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-blue text-white">
            {Icons.workflowResult(19)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-text-primary">{t('humanRequest.acceptance.title')}</div>
              {acceptanceRuleCount > 1 && (
                <span className="rounded-full bg-bg-hover px-2 py-0.5 text-xs text-text-secondary">
                  {t('humanRequest.acceptance.suggestionCount', { n: acceptanceRuleCount })}
                </span>
              )}
            </div>
            <div className="mt-1 text-xs leading-5 text-text-secondary">
              {t('humanRequest.acceptance.desc')}
            </div>
          </div>
          {floating && (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            >
              {t('humanRequest.collapse')} <span className="rotate-180">{Icons.chevronDown(12)}</span>
            </button>
          )}
        </div>
      )}
      {floating && !acceptanceReview && (
        <div className="mb-3 flex items-center gap-2 border-b border-border-subtle pb-2.5">
          <span className="flex text-text-accent">{Icons.chat(14)}</span>
          <span className="text-xs font-semibold text-text-primary">{t('humanRequest.needAnswer')}</span>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            {t('humanRequest.collapse')} <span className="rotate-180">{Icons.chevronDown(12)}</span>
          </button>
        </div>
      )}
      {active && (
        <div
          data-question-layout={activeReviewList ? 'review-list' : 'compact'}
          className={cn(
            'flex flex-col gap-1.5 overflow-y-auto',
            floating && 'min-h-0 flex-1 pr-1',
            !floating && activeReviewList && 'max-h-[50vh]',
            !floating && !activeReviewList && 'max-h-72',
          )}
        >
          {request.prompt && (
            <section aria-label={t('humanRequest.promptAria')} className="mb-2 border-b border-border-subtle pb-3">
              <MarkdownMessage
                content={request.prompt}
                density="compact"
                className="text-sm text-text-secondary"
              />
            </section>
          )}
          {questions.length > 1 && (
            <div
              className={cn(
                'mb-2 flex flex-wrap gap-1',
                acceptanceReview && 'border-t border-border-subtle pt-3',
              )}
            >
              {questions.map((q, i) => (
                <div
                  key={i}
                  onClick={() => setActiveIdx(i)}
                  className={cn(
                    'cursor-pointer select-none rounded-md border border-transparent bg-bg-hover px-2.5 py-1 text-xs text-text-primary transition-colors',
                    i === activeIdx && 'border-brand-blue bg-accent-blue-subtle',
                  )}
                >
                  {q.header || t('humanRequest.questionN', { n: i + 1 })}
                  {isAnswered(i, q) && <span className="ml-1 text-text-accent">✓</span>}
                </div>
              ))}
            </div>
          )}
          {acceptanceReview && acceptanceRuleCount > 1 && (
            <div className="text-xs font-medium text-text-accent">
              {t('humanRequest.acceptance.position', { current: activeIdx + 1, total: acceptanceRuleCount })}
            </div>
          )}
          <MarkdownMessage
            content={active.question}
            density="compact"
            className="mb-1 font-medium text-text-primary"
          />
          {active.options.map((opt, oi) => (
            <div
              key={opt.label}
              data-option-index={oi}
              data-selected={isSelected(activeIdx, active, opt.label)}
              onClick={() => pick(activeIdx, active, opt.label)}
              className={cn(
                'flex gap-2 px-3 py-2 rounded-md cursor-pointer border border-transparent bg-bg-hover transition-colors',
                activeReviewList &&
                  'flex-col py-2.5 bg-bg-surface border-border-subtle',
                opt.preview && 'flex-col',
                isSelected(activeIdx, active, opt.label) && 'border-brand-blue bg-accent-blue-subtle',
              )}
            >
              <div className="flex gap-2.5 min-w-0">
                <OptionMarker
                  review={activeReviewList}
                  selected={isSelected(activeIdx, active, opt.label)}
                  index={oi}
                />
                <div className="min-w-0 flex-1" onClick={stopNestedInteraction}>
                  <MarkdownMessage
                    content={opt.label}
                    density="inline"
                    className={cn(
                      'text-sm text-text-primary',
                      activeReviewList && 'font-medium',
                    )}
                  />
                  {opt.description && (
                    <MarkdownMessage
                      content={opt.description}
                      density="compact"
                      className="mt-0.5 max-h-10 overflow-hidden text-xs leading-5 text-text-secondary"
                    />
                  )}
                </div>
                {opt.preview && (
                  <button
                    type="button"
                    className="shrink-0 self-start text-xs text-text-accent hover:underline"
                    onClick={(event) => {
                      event.stopPropagation()
                      togglePreview(activeIdx, oi)
                    }}
                  >
                    {expandedPreviews.has(`${activeIdx}:${oi}`) ? t('humanRequest.collapse') : t('humanRequest.viewDetail')}
                  </button>
                )}
              </div>
              {opt.preview &&
                expandedPreviews.has(`${activeIdx}:${oi}`) && (
                  <div
                    className="ml-6 rounded-md border border-border-subtle bg-bg-input px-3 py-2"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MarkdownMessage
                      content={opt.preview}
                      className="text-xs text-text-secondary"
                    />
                  </div>
                )}
            </div>
          ))}
          {active.allowOther !== false && (
            <div
              className={cn(
                'px-3 py-2 rounded-md border border-transparent bg-bg-hover transition-colors',
                (others[activeIdx] ?? '').trim() !== '' &&
                  'border-brand-blue bg-accent-blue-subtle',
              )}
            >
              <div className="text-sm text-text-primary mb-1">
                {t('humanRequest.other')}
              </div>
              {acceptanceReview ? (
                <textarea
                  rows={2}
                  value={others[activeIdx] ?? ''}
                  onChange={(e) => typeOther(activeIdx, active, e.target.value)}
                  placeholder={t('humanRequest.acceptance.otherPlaceholder')}
                  className="w-full resize-none bg-transparent text-sm leading-5 text-text-primary placeholder:text-text-secondary outline-none"
                />
              ) : (
                <input
                  value={others[activeIdx] ?? ''}
                  onChange={(e) => typeOther(activeIdx, active, e.target.value)}
                  placeholder={t('humanRequest.otherPlaceholder')}
                  className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-secondary outline-none"
                />
              )}
            </div>
          )}
        </div>
      )}
      <div className="mt-3 flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {activeReviewList && active.multiSelect && (
            <span className="text-xs text-text-tertiary tabular-nums">
              {t('humanRequest.selectedCount', {
                picked: (picked[activeIdx] ?? []).length,
                max: active.maxSelections ?? active.options.length,
              })}
            </span>
          )}
          {activeReviewList && active.multiSelect && (
            <button
              type="button"
              className="text-xs text-text-accent hover:underline"
              onClick={() => selectAll(activeIdx, active)}
            >
              {t('humanRequest.selectAll')}
            </button>
          )}
          {active?.allowEmpty && (
            <button
              type="button"
              className={cn(
                'text-xs hover:underline',
                emptySelections[activeIdx] ? 'text-text-accent' : 'text-text-secondary',
              )}
              onClick={() => chooseEmpty(activeIdx)}
            >
              {active.emptyLabel || t('humanRequest.none')}
            </button>
          )}
          {multi && (
            <span className="text-xs text-text-tertiary tabular-nums select-none">
              {acceptanceReview
                ? t('humanRequest.processedCount', { done: answeredRuleCount, total: acceptanceRuleCount })
                : t('humanRequest.viewedCount', { done: answeredCount, total: questions.length })}
            </span>
          )}
          {acceptanceReview && (
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border-subtle bg-bg-hover px-2.5 text-xs text-text-secondary transition-colors hover:border-brand-blue/30 hover:text-text-primary"
              onClick={chooseExecutionOnly}
            >
              <span className="flex shrink-0 text-text-tertiary">{Icons.play(10)}</span>
              <span className="font-medium">{t('humanRequest.acceptance.executionOnly')}</span>
              <span className="text-xs text-text-tertiary">{t('humanRequest.acceptance.executionOnlyHint')}</span>
            </button>
          )}
        </div>
        <SubmitAction
          allAnswered={allAnswered}
          multi={multi}
          onSubmit={submit}
          submitLabel={acceptanceReview ? t('humanRequest.acceptance.submit') : t('humanRequest.submit')}
          remainingLabel={acceptanceReview
            ? t('humanRequest.acceptance.next')
            : t('humanRequest.answerRemaining', { n: remaining })}
        />
      </div>
    </div>
  )
}

interface SubmitActionProps {
  allAnswered: boolean
  multi: boolean
  onSubmit: () => void
  submitLabel?: string
  remainingLabel?: string
}

/** Bottom action button: its wording is always accurate, no longer one control doing several jobs (§1.24: extract a child component for JSX branches and return early).
 *   - everything answered → primary button "submit";
 *   - multiple questions with some unanswered → secondary "answer the remaining N →", which jumps to the first unanswered question (logic inside submit);
 *   - a single unanswered question → nowhere to jump, so a greyed-out "submit" (clicking is a no-op; submit already guards on allAnswered). */
function SubmitAction({
  allAnswered,
  multi,
  onSubmit,
  submitLabel,
  remainingLabel,
}: SubmitActionProps) {
  if (allAnswered) {
    return (
      <Btn variant="primary" size="sm" onClick={onSubmit}>
        {submitLabel}
      </Btn>
    )
  }
  if (multi) {
    return (
      <Btn variant="default" size="sm" onClick={onSubmit}>
        {remainingLabel}
      </Btn>
    )
  }
  return (
    <Btn variant="default" size="sm" onClick={onSubmit} className="opacity-50 cursor-not-allowed pointer-events-none">
      {submitLabel}
    </Btn>
  )
}
