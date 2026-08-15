/**
 * Hand-rolled Tooltip primitive — the repo-wide hover hint, replacing the native `title` attribute.
 *
 * Why not native title: its styling cannot be controlled (does not follow the two themes), its
 * ~1s appearance delay is not adjustable, and it is unreliable under macOS Electron (the
 * LeftSidebar gateway row already had to hand-roll a replacement because of it).
 * Project rule §1.25: native title is banned in the renderer, always use this component.
 *
 * Usage: wrap a single element. The wrapper is `display: contents` — it produces no box, so the
 * child remains a layout participant of the original parent container (constraints such as
 * flex-1 / truncate are unaffected); hover / focus events bubble from the child up to the
 * wrapper, so none of the child's props need rewriting.
 *
 *   <Tooltip content="Full name" onlyWhenTruncated>
 *     <span className="truncate">…</span>
 *   </Tooltip>
 *
 * Invariants:
 *   - when content is empty (null/undefined/''), children are returned as-is, zero overhead;
 *   - the bubble is portaled to body (fixed positioning) and is clipped by no overflow;
 *     any container scroll / window resize dismisses it immediately (the fixed coordinate
 *     has gone stale);
 *   - positioning and truncation detection are based on the wrapper's first child (the wrapper
 *     itself has no box);
 *   - a child with pointer-events-none (e.g. Btn's simulated disabled state) never receives
 *     hover — when you need a hint on a disabled control, wrap it in an extra span and put
 *     the Tooltip around that.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode, SyntheticEvent } from 'react'
import { cn } from '@/lib/cn'

export interface TooltipProps {
  /** Bubble content. Nothing is rendered when it is empty (null/undefined/''). */
  content: ReactNode
  /** The single trigger element — the `display: contents` wrapper receives its bubbled events. */
  children: ReactElement
  /** Only show the hint when the target is actually truncated (scrollWidth > clientWidth).
   *  For the truncated-name fallback case, so an untruncated name does not nag. */
  onlyWhenTruncated?: boolean
  /** Delay from hover to appearance, 300ms by default (native title is ~1s and not adjustable). */
  delayMs?: number
}

interface TipPos {
  left: number
  top: number
  /** Flip below the target when there is not enough room above. */
  below: boolean
}

/** Gap between the bubble and the target element (px). */
const GAP = 6
/** Minimum distance from the bubble's centre point to the left/right viewport edge (px). */
const EDGE = 8

/** Hand-rolled hover hint bubble — see the file header. */
export function Tooltip({
  content,
  children,
  onlyWhenTruncated = false,
  delayMs = 300,
}: TooltipProps) {
  const [pos, setPos] = useState<TipPos | null>(null)
  const timerRef = useRef<number | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setPos(null)
  }, [])

  // Clear the pending timer on unmount to avoid setState-on-unmounted.
  useEffect(() => cancel, [cancel])

  useEffect(() => {
    if (pos === null) return
    const hide = (): void => setPos(null)
    // Listen in the capture phase: a scroll in any inner scroll container invalidates the fixed coordinate, so just dismiss.
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [pos])

  // Right up against a viewport edge, a bubble positioned by its centre point overflows the
  // right/left edge (it may even get squeezed into a vertical column by the available width and
  // become unreadable). Measure the real width after render and clamp `left` into
  // [EDGE + halfWidth, innerWidth - EDGE - halfWidth] so the whole block stays inside the
  // viewport. useLayoutEffect adjusts before paint so there is no flash; the
  // `clamped !== pos.left` guard prevents a loop.
  useLayoutEffect(() => {
    if (pos === null) return
    const el = bubbleRef.current
    if (el === null) return
    const half = el.offsetWidth / 2
    const clamped = Math.min(Math.max(pos.left, EDGE + half), window.innerWidth - EDGE - half)
    if (clamped !== pos.left) setPos({ ...pos, left: clamped })
  }, [pos])

  const scheduleShow = useCallback(
    (e: SyntheticEvent<HTMLElement>) => {
      // The wrapper is display:contents (no box), so measure its first child instead.
      const target = e.currentTarget.firstElementChild
      if (!(target instanceof HTMLElement)) return
      if (onlyWhenTruncated && target.scrollWidth <= target.clientWidth) return
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        const rect = target.getBoundingClientRect()
        // 44px ≈ one-line bubble height + GAP: flip below when it does not fit above.
        const below = rect.top < 44
        setPos({
          left: Math.min(
            Math.max(rect.left + rect.width / 2, EDGE),
            window.innerWidth - EDGE,
          ),
          top: below ? rect.bottom + GAP : rect.top - GAP,
          below,
        })
      }, delayMs)
    },
    [delayMs, onlyWhenTruncated],
  )

  // Empty content → pass through unchanged, zero overhead. (Placed after all hooks so the hook order stays stable.)
  if (content === null || content === undefined || content === '') {
    return children
  }

  return (
    <>
      <span
        className="contents"
        onMouseEnter={scheduleShow}
        onMouseLeave={cancel}
        onFocus={scheduleShow}
        onBlur={cancel}
      >
        {children}
      </span>
      {pos !== null &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            className={cn(
              // w-max: size to the content (rather than to the available width when pinned against an edge)
              // so a short label stays on one line instead of going vertical; anything longer is then wrapped
              // by max-w-[320px].
              'pointer-events-none fixed z-[200] w-max max-w-[320px] -translate-x-1/2 select-none',
              'rounded-md border border-border-default bg-bg-input px-2 py-1 shadow-md',
              'text-xs leading-[1.5] text-text-secondary whitespace-pre-line break-words',
              // Pure opacity fade-in — enter/pop cannot be used, their transform would override the positioning translate above.
              'animate-fade',
              !pos.below && '-translate-y-full',
            )}
            // left/top are viewport coordinates computed at runtime — the §1.22 dynamic-value exception.
            style={{ left: pos.left, top: pos.top }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
