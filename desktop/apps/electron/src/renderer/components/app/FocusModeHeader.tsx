/** Session-level Build status bar. */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { currentAgentRunningAtom, currentThinkingModeAtom } from '@/atoms/agent'
import {
  BUILD_STAGES,
  currentBriefAtom,
  isFocusMode,
  loadSessionBriefAtom,
} from '@/atoms/build'
import { SessionStatusBar } from './SessionStatusBar'
import { StageRail } from './StageRail'

/**
 * Container-width breakpoints for full rail ↔ compact rail (with hysteresis, so it does not
 * flip back and forth right at the threshold).
 *
 * The full rail has a **fixed width** ≈ 420px (4 pills ≈ 300 + 3 connector segments of 40px = 120).
 * Add padding 48, two gaps of 40, status + button on the right ≈ 155, and the title column shrunk
 * all the way to its min-content ≈ 156 — 830 is the real lower bound at which the full rail fits.
 *
 * History: this used to be 880, but that number was computed assuming "title column at a fixed
 * basis of 28rem", while the layout back then let the **rail** absorb the remaining space
 * (`flex-1`, and basis:0 does not participate in shrinking) — so at 880 wide the rail only got
 * ≈190px and the 420px rail simply overflowed onto the status text on the right (user screenshot).
 * Now the rail takes its content width and the title absorbs the remainder (see the three-column
 * strategy in `SessionStatusBar`), so the same window width fits the full rail earlier and the
 * breakpoint ends up lower than before.
 *
 * ⚠️ Both numbers come from the addition above and are **not pixel-calibrated on a real machine**.
 * CJK glyph width / font / zoom all affect them; measure the actual width of
 * `[data-testid=full-stage-rail]` before changing them.
 */
// Exported: tests and the layout sandbox must run off the same numbers. Tests used to hard-code
// widths around the breakpoint, so any breakpoint change turned them red for a reason unrelated to
// the behaviour under test — the value should exist in exactly one place.
export const COMPACT_HEADER_WIDTH = 830
export const EXPANDED_HEADER_WIDTH = 854

export interface FocusStageRailProps {
  /** Current build think unit (clarify/explore/generate/verify; null when the position is unknown). */
  stage: string | null
  /** Whether the current session is streaming (breathing dot on the active node). */
  streaming: boolean
  /** Narrow columns switch to a compact progress bar with the current stage. */
  compact?: boolean
}

/** Horizontal stage rail: task creation → explore → generate → verify, driven by the real thinking
 *  position (`stage`). When `stage` is outside the four segments (null / unknown), indexOf falls back
 *  to -1, all four are pending and there is no active node. With compact=true it collapses into a
 *  compact progress bar (CompactStageRail). */
export function FocusStageRail({ stage, streaming, compact = false }: FocusStageRailProps) {
  const { t } = useTranslation()
  const current = stage === null ? -1 : (BUILD_STAGES as readonly string[]).indexOf(stage)
  if (compact) return <CompactStageRail current={current} streaming={streaming} />
  return (
    <StageRail
      items={BUILD_STAGES.map((item) => ({
        id: item,
        label: t(`focusMode.stages.${item}`),
        description: t(`focusMode.stageDescriptions.${item}`),
      }))}
      current={current}
      isRunning={streaming}
    />
  )
}

/** Background of one compact progress-bar segment (done/active/pending; a helper to avoid a nested ternary, §1.24). */
function compactBarClass(done: boolean, active: boolean): string {
  if (done) return 'bg-brand-blue/50'
  if (active) return 'bg-brand-blue'
  return 'bg-stage-track'
}

/** Compact stage rail: progress bar + current stage name + N/total. */
function CompactStageRail({ current, streaming }: { current: number; streaming: boolean }) {
  const { t } = useTranslation()
  const total = BUILD_STAGES.length
  const labels = BUILD_STAGES.map((stage) => t(`focusMode.stages.${stage}`))
  const shownLabel = labels[Math.min(current, total - 1)] ?? ''
  return (
    <div
      data-testid="compact-stage-rail"
      // `flex min-w-0` (not inline-flex): inline-flex is shrink-to-fit and does not accept the parent's
      // width constraint, so in a narrow container this rail keeps its hard width and overflows on top of
      // the brief / collapse buttons on the right (those are shrink-0 and cannot get out of the way). The
      // parent is `flex-1` (basis:0%), and flex-shrink is weighted by basis — a basis of 0 does not
      // participate in shrinking at all, it only claims "leftover space" and can be squeezed to nearly
      // zero when space is tight. So the constraint has to be absorbed by this rail itself.
      className="flex min-w-0"
    >
      {/* min-w-0 propagates the shrink down to the stage name's truncate; overflow-hidden is the last
          resort — when it gets so narrow that even the progress bar and counter do not fit, clipping is
          preferable to covering the buttons. */}
      <div className="flex items-center gap-2.5 py-0.5 min-w-0 overflow-hidden">
        <div className="flex gap-[3px] shrink-0">
          {BUILD_STAGES.map((stage, i) => (
            <div
              key={stage}
              className={cn(
                'h-[5px] rounded-full transition-all duration-300 ease-out',
                i === current ? 'w-5' : 'w-2.5',
                compactBarClass(i < current, i === current),
              )}
            />
          ))}
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-text-primary truncate whitespace-nowrap">
            {shownLabel}
          </span>
          {streaming && <span className="w-1.5 h-1.5 rounded-full bg-brand-blue shrink-0 animate-pulse" />}
          <span className="text-xs text-text-tertiary font-mono whitespace-nowrap shrink-0">
            {Math.min(current + 1, total)}/{total}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Task description from the brief: skip blank lines and markdown heading lines (`## Task` etc.)
 *  and take the first line of **body content** (rather than the heading word itself). Also handles
 *  the old headingless format (first line is already body). */
function briefSummary(brief: string): string {
  for (const line of brief.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue // skip blank lines + heading lines
    return trimmed.replace(/^[-*+]\s+/, '') // strip a possible list marker, keep the body
  }
  return ''
}

/** Build is a Session mode, so its progress belongs above the transcript. */
function BuildTopStatusBar({
  stage,
  streaming,
  brief,
}: {
  stage: string | null
  streaming: boolean
  brief: string | null
}) {
  const { t } = useTranslation()
  // HTMLDivElement rather than HTMLElement: the skeleton's root is a div (it used to be a section).
  const statusBarRef = useRef<HTMLDivElement>(null)
  const [containerCompact, setContainerCompact] = useState(false)
  const current = stage === null
    ? -1
    : (BUILD_STAGES as readonly string[]).indexOf(stage)
  const buildStage = current >= 0 ? BUILD_STAGES[current] : null
  const shownStage = buildStage ? t(`focusMode.stages.${buildStage}`) : t('focusMode.preparing')
  const description = buildStage ? t(`focusMode.stageDescriptions.${buildStage}`) : t('focusMode.preparingDescription')
  const summary = brief ? briefSummary(brief) : ''
  // Opening the side surface does not replace or collapse the Session's mode status.
  // The bar degrades only when its own measured width actually requires it.
  const compact = containerCompact

  useEffect(() => {
    const statusBar = statusBarRef.current
    if (!statusBar || typeof ResizeObserver === 'undefined') return

    const update = (width: number) => {
      if (width <= 0) return
      setContainerCompact((current) => (
        current ? width < EXPANDED_HEADER_WIDTH : width < COMPACT_HEADER_WIDTH
      ))
    }
    update(statusBar.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      const width = entry?.borderBoxSize?.[0]?.inlineSize
        ?? entry?.target.getBoundingClientRect().width
      if (width !== undefined) update(width)
    })
    observer.observe(statusBar, { box: 'border-box' })
    return () => observer.disconnect()
  }, [])

  return (
    <SessionStatusBar
      rootRef={statusBarRef}
      testId="build-mode-status-bar"
      isCompact={compact}
      title={t('focusMode.title')}
      badge={
        <span className="shrink-0 whitespace-nowrap rounded-full bg-accent-blue-subtle px-2 py-0.5 text-2xs font-semibold text-text-accent">
          {shownStage}
        </span>
      }
      description={summary || description}
      rail={
        <div data-testid={compact ? undefined : 'full-stage-rail'}>
          <FocusStageRail stage={stage} streaming={streaming} compact={compact} />
        </div>
      }
      status={
        <span className={cn(
          'items-center gap-1.5 text-xs font-medium text-text-secondary',
          compact ? 'hidden' : 'hidden sm:flex',
        )}>
          <span className={cn(
            'h-1.5 w-1.5 rounded-full',
            streaming ? 'animate-pulse bg-brand-blue' : 'bg-text-tertiary',
          )} />
          {streaming ? t('focusMode.building') : t('focusMode.waitingToContinue')}
        </span>
      }
    />
  )
}

export interface FocusModeHeaderProps {
  sessionId?: string
}

/** Build owns a top status surface. Ordinary conversations and Workflow runs do not. */
export function FocusModeHeader({ sessionId }: FocusModeHeaderProps) {
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const position = useAtomValue(currentThinkingModeAtom)
  const streaming = useAtomValue(currentAgentRunningAtom)
  const brief = useAtomValue(currentBriefAtom)
  const loadBrief = useSetAtom(loadSessionBriefAtom)

  const buildFocused = isFocusMode(position)
  const stage = position?.stage ?? null

  useEffect(() => {
    if (activeSessionId && buildFocused) void loadBrief(activeSessionId)
  }, [activeSessionId, buildFocused, stage, streaming, loadBrief])

  if (sessionId !== undefined && sessionId !== activeSessionId) return null
  if (!buildFocused) return null

  return <BuildTopStatusBar stage={stage} streaming={streaming} brief={brief} />
}
