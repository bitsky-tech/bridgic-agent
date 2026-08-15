/**
 * Height-capped scroll container + automatic stick-to-bottom while streaming.
 *
 * The height cap / scroll styling is passed in via `className` (e.g. max-h + overflow-auto). When `active` (usually
 * = streaming) and the content **grows**, the container is scrolled to the bottom to show the latest content being
 * generated; scrolling up manually stops the auto-scroll (`stick` ref), and scrolling back to the bottom resumes it.
 * It does not jump to the bottom on mount (via the `prevLen` comparison), so completed / historical blocks stay at the
 * top and can be read from the beginning.
 *
 * The effect here is a "synchronize with DOM scrolling" side effect (not derived state, which §1.17 permits).
 */
import { useEffect, useRef, type ReactNode } from 'react'

export interface StickyScrollProps {
  /** Whether auto stick-to-bottom is enabled (usually = streaming). */
  active: boolean
  /** The content that drives following: stick to the bottom when it changes and grows (usually the current text). */
  dep: string
  className?: string
  children: ReactNode
}

/** How many px from the bottom still counts as "at the bottom" (tolerance against growth races). */
const AT_BOTTOM_EPS = 8

export function StickyScroll({ active, dep, className, children }: StickyScrollProps) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prevLen = useRef(dep.length)

  const handleScroll = (): void => {
    const el = ref.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_EPS
  }

  useEffect(() => {
    const grew = dep.length > prevLen.current
    prevLen.current = dep.length
    const el = ref.current
    if (el && active && grew && stick.current) el.scrollTop = el.scrollHeight
  }, [dep, active])

  return (
    <div ref={ref} onScroll={handleScroll} className={className}>
      {children}
    </div>
  )
}
