/**
 * Expand/collapse animation container (pure CSS, height adapts automatically).
 *
 * Uses a `grid-template-rows: 0fr ↔ 1fr` transition — it stretches and shrinks smoothly without measuring the
 * content height; the inner layer clips with `overflow-hidden`; the innermost content fades in and slides down
 * with `opacity` plus a slight `translateY`, and reverses on collapse, for a softer feel overall. Children are
 * **always mounted** (conditional rendering can only animate the expand direction), so both expanding and
 * collapsing are animated.
 *
 * Entry consistency: `shown` is initialized to `open`, i.e. **if it is already open on first mount it is pinned
 * expanded with no animation** — this avoids an already-expanded container replaying the "collapse → expand"
 * animation when its parent remounts (e.g. a streaming message being committed to history: the streaming
 * ProcessTimeline unmounts and the committed one mounts), which shows up as the whole block flickering. Only when
 * `open` changes after mount (user clicks the title / a tool row expands for the first time: false→true) do we
 * transition to the new state **one frame later**, preserving the toggle animation.
 * `shown` is animation timing (synchronized with browser paint), not derived render state, hence effect + rAF (a §1.17 exception).
 *
 * The transition is written as an inline style (a §1.22 dynamic-value exception): grid fr transitions + custom
 * easing are unreliable through Tailwind arbitrary classes; inline is the most dependable.
 */
import { useEffect, useState, type ReactNode } from 'react'

export interface CollapseProps {
  open: boolean
  children: ReactNode
}

/** Gentle deceleration curve (approximating easeOutQuint): crisp start, soft landing. */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

export function Collapse({ open, children }: CollapseProps) {
  // Initial value = open: if it is already open on first mount, expand immediately with no entry animation (avoiding the
  // flicker of an already-expanded container replaying the expand animation when its parent remounts). Only changes to open
  // after mount go through the one-frame-delayed transition below.
  const [shown, setShown] = useState(open)
  useEffect(() => {
    // Wait one frame before aligning the animation state to `open`: let the current state paint one frame, then switch on the
    // next → the transition is guaranteed to fire, even if children were lazy-mounted only in this pass. On first mount shown
    // already equals open, so setShown is a no-op and produces no animation; only subsequent changes to open (user toggling)
    // actually transition. The setState happens inside the rAF callback (not synchronously in the effect body), so it triggers no cascading render.
    const id = requestAnimationFrame(() => setShown(open))
    return () => cancelAnimationFrame(id)
  }, [open])

  return (
    <div
      className="grid"
      style={{
        gridTemplateRows: shown ? '1fr' : '0fr',
        transition: `grid-template-rows 300ms ${EASE}`,
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          style={{
            opacity: shown ? 1 : 0,
            transform: shown ? 'translateY(0)' : 'translateY(-4px)',
            transition: `opacity 240ms ease, transform 300ms ${EASE}`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
