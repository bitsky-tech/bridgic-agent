/**
 * Floating scroll button in the bottom-right of the message area — one button whose direction flips with user intent.
 *
 * Hidden by default; the parent (Pipeline) sets `visible` once a user **scroll gesture** happens and the content is long
 * enough, then fades it out after scrolling stops for a while. Always mounted, fading in and out via `opacity` +
 * `pointer-events` (both directions are transitioned); the scroll itself uses rAF + easeInOutCubic for custom smoothing.
 *
 * The direction decision (`nextScrollIntent`) is a pure function whose state the caller holds in a ref: accumulated
 * scrolling in the same direction must cross a threshold before flipping, and a single pull in the opposite direction
 * resets the accumulator — the intent is "the user scrolled up several times in a row = they want to go back to the top",
 * rather than jittering with every individual scroll direction. At the very top / bottom the edge test wins over the
 * accumulator, because a button pointing at where you already are is a dead button.
 */
import { useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import { Tooltip } from './Tooltip'

/** The end the button currently points at. */
export const ScrollDirection = {
  Top: 'top',
  Bottom: 'bottom',
} as const
export type ScrollDirection = (typeof ScrollDirection)[keyof typeof ScrollDirection]

/** How many px from the top / bottom counts as "at the edge" (the button for that end is meaningless, so force it to point at the other end). */
const EDGE_BAND = 80
/** How many px of same-direction scrolling are needed before the button's intent flips. About two screens of wheel gestures, so a single jitter cannot trigger it. */
const INTENT_THRESHOLD = 300
/** Absolute cap on the accumulated travel — continuous scrolling in a long list does not need unbounded growth, crossing the threshold is enough. */
const TRAVEL_CAP = INTENT_THRESHOLD * 2
/** Below this scrollable distance the button is not shown: the content is not long enough to need jumping. */
export const MIN_SCROLLABLE_DISTANCE = 240

/** Accumulated scroll-intent state. The caller holds it in a ref and feeds it to `nextScrollIntent` on every scroll event. */
export interface ScrollIntentState {
  /** scrollTop of the previous event, used to compute this event's direction of travel. */
  lastTop: number
  /** Accumulated travel in the current direction (negative = upwards); reset to zero on reversal. */
  travel: number
  /** Where the button currently points. */
  direction: ScrollDirection
}

/** Initial intent: before any scrolling the button points at the top (opening a session lands at the bottom by default). */
export const INITIAL_SCROLL_INTENT: ScrollIntentState = {
  lastTop: 0,
  travel: 0,
  direction: ScrollDirection.Top,
}

/** Scroll-container metrics needed by `nextScrollIntent` (structurally compatible with HTMLElement). */
export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Accumulate in the same direction / reset on reversal, clamped within TRAVEL_CAP. Events with delta 0 do not affect the accumulator. */
function accumulateTravel(prev: number, delta: number): number {
  if (delta === 0) return prev
  const sameDirection = prev !== 0 && Math.sign(delta) === Math.sign(prev)
  const next = sameDirection ? prev + delta : delta
  return Math.min(TRAVEL_CAP, Math.max(-TRAVEL_CAP, next))
}

/**
 * Derive the new intent from the previous intent + the current scroll metrics. Pure function (immutable arguments, no side effects).
 *
 * Decision priority: at the top → the only possible wish is to go to the bottom; at the bottom → the only possible wish is to
 * go back to the top; only in between do we check whether the accumulated travel crossed `INTENT_THRESHOLD`, and if it did not,
 * the previous direction is kept (no jitter).
 */
export function nextScrollIntent(
  prev: ScrollIntentState,
  metrics: ScrollMetrics,
): ScrollIntentState {
  const { scrollTop, scrollHeight, clientHeight } = metrics
  const travel = accumulateTravel(prev.travel, scrollTop - prev.lastTop)
  const atTop = scrollTop <= EDGE_BAND
  const atBottom = scrollHeight - scrollTop - clientHeight <= EDGE_BAND

  let direction = prev.direction
  if (atTop) direction = ScrollDirection.Bottom
  else if (atBottom) direction = ScrollDirection.Top
  else if (travel <= -INTENT_THRESHOLD) direction = ScrollDirection.Top
  else if (travel >= INTENT_THRESHOLD) direction = ScrollDirection.Bottom

  return { lastTop: scrollTop, travel, direction }
}

/** Circular floating button style. */
const SCROLL_BTN =
  'flex h-8 w-8 items-center justify-center rounded-full border border-border-default bg-bg-elevated text-text-secondary shadow-md transition-colors hover:bg-bg-hover hover:text-text-primary'

/** Eased smooth scroll to a target scrollTop (rAF + easeInOutCubic). */
function smoothScrollTo(el: HTMLElement, top: number, duration = 450): void {
  const start = el.scrollTop
  const dist = top - start
  if (Math.abs(dist) < 2) return
  let t0 = 0
  const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2)
  const step = (now: number): void => {
    if (t0 === 0) t0 = now
    const p = Math.min((now - t0) / duration, 1)
    el.scrollTop = start + dist * ease(p)
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export interface ScrollControlsProps {
  scrollRef: RefObject<HTMLDivElement | null>
  /** Whether it is shown (fades in while scrolling, out when idle). */
  visible: boolean
  /** The end the button points at, derived by `nextScrollIntent`. */
  direction: ScrollDirection
}

export function ScrollControls({ scrollRef, visible, direction }: ScrollControlsProps) {
  const { t } = useTranslation()
  // Force it to stay visible while hovered: otherwise the idle fade-out timer would hide it right when the mouse is already on the button but has not clicked yet.
  const [hovered, setHovered] = useState(false)
  const shown = visible || hovered
  const toTop = direction === ScrollDirection.Top
  const label = toTop ? t('scrollControls.toTop') : t('scrollControls.toBottom')
  const jump = (): void => {
    const el = scrollRef.current
    if (!el) return
    smoothScrollTo(el, toTop ? 0 : el.scrollHeight - el.clientHeight)
  }
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'absolute bottom-4 right-4 z-10 transition-opacity duration-300',
        shown ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <Tooltip content={label}>
        <button type="button" onClick={jump} className={SCROLL_BTN} aria-label={label}>
          {/* There is only one arrow icon, reused by rotating it when pointing down — so we do not keep a second icon just for the mirrored shape. */}
          <span className={cn('flex transition-transform duration-200', !toTop && 'rotate-180')}>
            {Icons.arrowUp(15)}
          </span>
        </button>
      </Tooltip>
    </div>
  )
}
