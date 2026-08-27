import { viewedSessionIdAtom } from '@/atoms/navigation'
import { browserSurfaceBlockedAtom, setNativePowerPointSurfaceRectAtom } from '@/atoms/browser'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { useAtomValue, useSetAtom } from 'jotai'
import { useLayoutEffect, useRef } from 'react'

export interface EmbeddedPowerPointPanelProps {
  active: boolean
}

/** Renderer placeholder whose rectangle is occupied by the native Session PPT view. */
export function EmbeddedPowerPointPanel({ active }: EmbeddedPowerPointPanelProps) {
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const surfaceBlocked = useAtomValue(browserSurfaceBlockedAtom)
  const publishSurfaceRect = useSetAtom(setNativePowerPointSurfaceRectAtom)
  const viewportRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const powerpoint = window.api.powerpoint
    if (!powerpoint) {
      publishSurfaceRect(null)
      return
    }
    if (!active || surfaceBlocked || !sessionId || !viewport) {
      void powerpoint.setVisible(false)
      publishSurfaceRect(null)
      return
    }
    let disposed = false
    let frame = 0
    let syncing = false
    let pending = true

    const sync = async () => {
      if (syncing || disposed || !pending) return
      syncing = true
      pending = false
      try {
        const rect = viewport.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
          await powerpoint.setVisible(false)
          publishSurfaceRect(null)
          return
        }
        await powerpoint.ensureSession(sessionId)
        if (disposed) return
        await powerpoint.setBounds({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })
        if (disposed) return
        await powerpoint.activateSession(sessionId)
        if (disposed) return
        publishSurfaceRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        await powerpoint.setVisible(true)
      } catch (error) {
        publishSurfaceRect(null)
        rlog.warn('[embedded-powerpoint] native surface sync failed', error)
      } finally {
        syncing = false
        if (pending && !disposed) void sync()
      }
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        pending = true
        void sync()
      })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    let ancestor = viewport.parentElement
    while (ancestor && ancestor !== document.body) {
      observer.observe(ancestor)
      ancestor = ancestor.parentElement
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      void powerpoint.setVisible(false, true).finally(() => publishSurfaceRect(null))
    }
  }, [active, publishSurfaceRect, sessionId, surfaceBlocked])

  return (
    <div
      ref={viewportRef}
      className={cn('h-full min-h-0 w-full', !active && 'invisible pointer-events-none')}
      data-testid="embedded-powerpoint-viewport"
    />
  )
}
