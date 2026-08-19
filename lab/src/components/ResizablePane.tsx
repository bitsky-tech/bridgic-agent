import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import './ResizablePane.css'

export type ResizablePaneSide = 'left' | 'right'

export interface PaneStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ResizablePaneLabels {
  resize: string
  collapse: string
  expand: string
}

export interface ResizablePaneProps {
  side: ResizablePaneSide
  storageKey: string
  collapsedStorageKey?: string
  children: ReactNode
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  collapsedWidth?: number
  keyboardStep?: number
  collapsible?: boolean
  defaultCollapsed?: boolean
  collapsed?: boolean
  labels?: Partial<ResizablePaneLabels>
  storage?: PaneStorage | null
  className?: string
  contentClassName?: string
  id?: string
  style?: CSSProperties
  onWidthChange?: (width: number) => void
  onCollapsedChange?: (collapsed: boolean) => void
}

const defaultLabels: ResizablePaneLabels = {
  resize: 'Resize panel',
  collapse: 'Collapse panel',
  expand: 'Expand panel',
}

export function clampPaneWidth(width: number, minWidth: number, maxWidth: number): number {
  const normalizedMin = Number.isFinite(minWidth) ? Math.max(0, minWidth) : 0
  const normalizedMax = Number.isFinite(maxWidth) ? Math.max(normalizedMin, maxWidth) : normalizedMin
  const normalizedWidth = Number.isFinite(width) ? width : normalizedMin
  return Math.min(normalizedMax, Math.max(normalizedMin, normalizedWidth))
}

export function readStoredPaneWidth(
  storage: PaneStorage | null | undefined,
  storageKey: string,
  fallback: number,
  minWidth: number,
  maxWidth: number,
): number {
  if (!storage) return clampPaneWidth(fallback, minWidth, maxWidth)
  try {
    const stored = storage.getItem(storageKey)
    if (stored === null || stored.trim() === '') {
      return clampPaneWidth(fallback, minWidth, maxWidth)
    }
    return clampPaneWidth(Number(stored), minWidth, maxWidth)
  } catch {
    return clampPaneWidth(fallback, minWidth, maxWidth)
  }
}

export function readStoredPaneCollapsed(
  storage: PaneStorage | null | undefined,
  storageKey: string,
  fallback: boolean,
): boolean {
  if (!storage) return fallback
  try {
    const stored = storage.getItem(storageKey)
    if (stored === 'true') return true
    if (stored === 'false') return false
    return fallback
  } catch {
    return fallback
  }
}

export function paneWidthForKey(
  currentWidth: number,
  key: string,
  side: ResizablePaneSide,
  minWidth: number,
  maxWidth: number,
  step = 16,
): number | null {
  if (key === 'Home') return clampPaneWidth(minWidth, minWidth, maxWidth)
  if (key === 'End') return clampPaneWidth(maxWidth, minWidth, maxWidth)
  const normalizedStep = Number.isFinite(step) ? Math.max(1, step) : 16
  const grows = (side === 'left' && key === 'ArrowRight') || (side === 'right' && key === 'ArrowLeft')
  const shrinks = (side === 'left' && key === 'ArrowLeft') || (side === 'right' && key === 'ArrowRight')
  if (!grows && !shrinks) return null
  return clampPaneWidth(currentWidth + (grows ? normalizedStep : -normalizedStep), minWidth, maxWidth)
}

function browserStorage(): PaneStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function ResizablePane({
  side,
  storageKey,
  collapsedStorageKey = `${storageKey}.collapsed`,
  children,
  defaultWidth = side === 'left' ? 248 : 370,
  minWidth = 180,
  maxWidth = 520,
  collapsedWidth = 36,
  keyboardStep = 16,
  collapsible = true,
  defaultCollapsed = false,
  collapsed: controlledCollapsed,
  labels: labelOverrides,
  storage: storageOverride,
  className = '',
  contentClassName = '',
  id,
  style,
  onWidthChange,
  onCollapsedChange,
}: ResizablePaneProps) {
  const generatedId = useId()
  const contentId = id ?? `resizable-pane-${generatedId.replace(/:/g, '')}`
  const labels = { ...defaultLabels, ...labelOverrides }
  const normalizedMin = Number.isFinite(minWidth) ? Math.max(0, minWidth) : 0
  const normalizedMax = Number.isFinite(maxWidth) ? Math.max(normalizedMin, maxWidth) : normalizedMin
  const resolvedStorage = useMemo(
    () => storageOverride === undefined ? browserStorage() : storageOverride,
    [storageOverride],
  )
  const [width, setWidth] = useState(() =>
    readStoredPaneWidth(resolvedStorage, storageKey, defaultWidth, normalizedMin, normalizedMax))
  const [internalCollapsed, setInternalCollapsed] = useState(() =>
    readStoredPaneCollapsed(resolvedStorage, collapsedStorageKey, defaultCollapsed))
  const isCollapsed = controlledCollapsed ?? internalCollapsed
  const widthRef = useRef(width)
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const next = clampPaneWidth(widthRef.current, normalizedMin, normalizedMax)
    widthRef.current = next
    setWidth(next)
  }, [normalizedMax, normalizedMin])

  useEffect(() => {
    if (!resolvedStorage) return
    try {
      resolvedStorage.setItem(storageKey, String(width))
    } catch {
      // Storage may be unavailable in private or embedded browser contexts.
    }
  }, [resolvedStorage, storageKey, width])

  useEffect(() => {
    if (!resolvedStorage) return
    try {
      resolvedStorage.setItem(collapsedStorageKey, String(isCollapsed))
    } catch {
      // Storage may be unavailable in private or embedded browser contexts.
    }
  }, [collapsedStorageKey, isCollapsed, resolvedStorage])

  const updateWidth = (nextWidth: number) => {
    const next = clampPaneWidth(nextWidth, normalizedMin, normalizedMax)
    if (next === widthRef.current) return
    widthRef.current = next
    setWidth(next)
    onWidthChange?.(next)
  }

  const updateCollapsed = (next: boolean) => {
    if (!collapsible) return
    if (controlledCollapsed === undefined) setInternalCollapsed(next)
    onCollapsedChange?.(next)
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (isCollapsed || event.button !== 0) return
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: widthRef.current }
    setDragging(true)
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta = event.clientX - drag.startX
    updateWidth(drag.startWidth + (side === 'left' ? delta : -delta))
  }

  const finishDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = paneWidthForKey(
      widthRef.current,
      event.key,
      side,
      normalizedMin,
      normalizedMax,
      keyboardStep,
    )
    if (next !== null) {
      event.preventDefault()
      updateWidth(next)
      return
    }
    if (collapsible && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      updateCollapsed(!isCollapsed)
    }
  }

  const paneWidth = isCollapsed ? Math.max(0, collapsedWidth) : width
  const classes = [
    'resizable-pane',
    `resizable-pane-${side}`,
    isCollapsed ? 'is-collapsed' : '',
    dragging ? 'is-dragging' : '',
    className,
  ].filter(Boolean).join(' ')
  const collapseGlyph = side === 'left' ? '‹' : '›'
  const expandGlyph = side === 'left' ? '›' : '‹'

  return (
    <aside
      className={classes}
      data-collapsed={isCollapsed || undefined}
      data-side={side}
      style={{ ...style, width: paneWidth, flexBasis: paneWidth }}
    >
      <div
        id={contentId}
        className={`resizable-pane-content ${contentClassName}`.trim()}
        hidden={isCollapsed}
      >
        {children}
      </div>

      {!isCollapsed && (
        <div
          className="resizable-pane-separator"
          role="separator"
          aria-label={labels.resize}
          aria-controls={contentId}
          aria-orientation="vertical"
          aria-valuemin={normalizedMin}
          aria-valuemax={normalizedMax}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onDoubleClick={() => updateCollapsed(true)}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDragging}
          onPointerCancel={finishDragging}
          onLostPointerCapture={finishDragging}
        />
      )}

      {collapsible && (
        <button
          type="button"
          className="resizable-pane-toggle"
          aria-controls={contentId}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? labels.expand : labels.collapse}
          title={isCollapsed ? labels.expand : labels.collapse}
          onClick={() => updateCollapsed(!isCollapsed)}
        >
          <span aria-hidden="true">{isCollapsed ? expandGlyph : collapseGlyph}</span>
        </button>
      )}
    </aside>
  )
}
