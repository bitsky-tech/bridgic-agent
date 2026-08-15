/**
 * Vertical drag handle for resizing a side column.
 *
 * Absolutely positioned on a column edge (the parent column must be
 * `relative`). Reports width LIVE via `onResize` during the drag and the
 * final value via `onCommit` on pointer-up — so the parent can keep a
 * transient width during drag and persist only once at the end (no IPC
 * spam per frame).
 *
 * `side` is the column being resized, not the handle's edge:
 *   - `'left'`  → handle on the column's right edge; dragging right widens.
 *   - `'right'` → handle on the column's left edge;  dragging left widens.
 *
 * Visual is paint-only (a 1px brand line on hover/active) so toggling it
 * never shifts layout (§LS1). Hit area is wider than the visible line.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Tooltip } from './Tooltip'

export interface ResizeHandleProps {
  side: 'left' | 'right'
  /** Current (persisted) width in px — the drag baseline. */
  width: number
  min: number
  max: number
  /** Live width during drag — parent renders this transient value. */
  onResize: (width: number) => void
  /** Final width on mouse-up — parent persists this. */
  onCommit: (width: number) => void
  /** Optional right-dock collapse after dragging deliberately past its minimum. */
  onCollapse?: (minimumWidth: number) => void
  /** Extra raw drag distance past `min` required before collapse is armed. */
  collapseOvershoot?: number
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
export const RESIZE_COLLAPSE_DWELL_MS = 350

export function ResizeHandle({
  side,
  width,
  min,
  max,
  onResize,
  onCommit,
  onCollapse,
  collapseOvershoot = 0,
}: ResizeHandleProps) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const handleRef = useRef<HTMLDivElement>(null)
  const pointerId = useRef<number | null>(null)
  // Drag baseline captured on pointer-down; refs stay fresh across renders.
  const startX = useRef(0)
  const startW = useRef(width)
  const latest = useRef(width)
  const latestRaw = useRef(width)
  const collapseArmed = useRef(false)
  const collapseTimer = useRef<number | null>(null)

  const clearCollapseArm = useCallback(() => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current)
      collapseTimer.current = null
    }
    collapseArmed.current = false
  }, [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || e.isPrimary === false || pointerId.current !== null) return
      e.preventDefault()
      e.currentTarget.setPointerCapture?.(e.pointerId)
      pointerId.current = e.pointerId
      startX.current = e.clientX
      startW.current = width
      latest.current = width
      latestRaw.current = width
      clearCollapseArm()
      setDragging(true)
    },
    [clearCollapseArm, width],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (pointerId.current !== e.pointerId) return
      e.preventDefault()
      const delta = e.clientX - startX.current
      // 'left' column grows when pointer moves right; 'right' column grows
      // when pointer moves left — hence the sign flip.
      const raw = side === 'left' ? startW.current + delta : startW.current - delta
      const next = clamp(raw, min, max)
      latestRaw.current = raw
      latest.current = next
      const beyondCollapseThreshold = side === 'right'
        && onCollapse !== undefined
        && raw < min - collapseOvershoot
      if (!beyondCollapseThreshold) {
        clearCollapseArm()
      } else if (!collapseArmed.current && collapseTimer.current === null) {
        collapseTimer.current = window.setTimeout(() => {
          collapseTimer.current = null
          if (
            pointerId.current !== null
            && latestRaw.current < min - collapseOvershoot
          ) {
            collapseArmed.current = true
          }
        }, RESIZE_COLLAPSE_DWELL_MS)
      }
      onResize(next)
    },
    [clearCollapseArm, collapseOvershoot, max, min, onCollapse, onResize, side],
  )

  const finishDrag = useCallback((endedPointerId: number, allowCollapse: boolean) => {
    if (pointerId.current !== endedPointerId) return
    pointerId.current = null
    const handle = handleRef.current
    if (handle?.hasPointerCapture?.(endedPointerId)) {
      handle.releasePointerCapture(endedPointerId)
    }
    setDragging(false)
    const shouldCollapse = allowCollapse
      && side === 'right'
      && onCollapse !== undefined
      && collapseArmed.current
      && latestRaw.current < min - collapseOvershoot
    clearCollapseArm()
    if (shouldCollapse) onCollapse(min)
    else onCommit(latest.current)
  }, [clearCollapseArm, collapseOvershoot, min, onCollapse, onCommit, side])

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      finishDrag(e.pointerId, true)
    },
    [finishDrag],
  )

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => finishDrag(e.pointerId, false),
    [finishDrag],
  )

  useEffect(() => {
    if (!dragging) return
    // Pointer capture keeps this renderer as the drag owner while the cursor
    // crosses the sibling native WebContentsView.
    const onBlur = () => {
      if (pointerId.current !== null) finishDrag(pointerId.current, false)
    }
    window.addEventListener('blur', onBlur)
    // Suppress text selection + force the resize cursor across the whole
    // window while dragging (otherwise the cursor flickers over content).
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('blur', onBlur)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [dragging, finishDrag])

  useEffect(() => clearCollapseArm, [clearCollapseArm])

  return (
    <Tooltip content={t('resizeHandle.dragToResize')}>
      <div
        ref={handleRef}
        data-testid={`resize-handle-${side}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        className={cn(
          'absolute top-0 bottom-0 w-2 z-20 touch-none cursor-col-resize group',
          side === 'left' ? '-right-1' : '-left-2',
        )}
      >
        {/* Visible 1px line — paint-only, centered in the hit area. */}
        <span
          className={cn(
            'pointer-events-none absolute inset-y-0 w-px transition-colors',
            side === 'left' ? 'left-1/2 -translate-x-1/2' : 'right-0',
            dragging ? 'bg-brand-blue' : 'bg-transparent group-hover:bg-brand-blue',
          )}
        />
        {/* Hover-only grip hints that this boundary is draggable. Its absolute positioning and
            opacity are paint-only, so it does not affect layout (§LS1). */}
        <span
          className={cn(
            'pointer-events-none absolute top-1/2 h-8 w-1 -translate-y-1/2 rounded-full transition-opacity',
            side === 'left' ? 'left-1/2 -translate-x-1/2' : 'right-0 translate-x-1/2',
            dragging ? 'opacity-100 bg-brand-blue' : 'opacity-0 group-hover:opacity-100 bg-border-strong',
          )}
        />
      </div>
    </Tooltip>
  )
}
