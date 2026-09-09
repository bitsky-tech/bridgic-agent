import { useLayoutEffect, useRef, type RefObject } from 'react'

export interface NativeOfficeSurfaceBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeOfficeSurfaceClient {
  setBounds: (bounds: NativeOfficeSurfaceBounds) => Promise<unknown>
  activateSession: (sessionId: string | null) => Promise<unknown>
  setVisible: (visible: boolean, focusHost?: boolean) => Promise<unknown>
}

export interface NativeOfficeSurfacePolicy {
  prepareSession?: (sessionId: string) => Promise<unknown>
  initialSync?: 'immediate' | 'animation-frame'
  publishBoundsBeforeApply?: boolean
  deactivateOnDetach?: boolean
  focusHostOnDetach?: boolean
  clearBoundsAfterDetach?: boolean
  onError: (error: unknown) => void
}

interface NativeOfficeSurfaceOptions {
  client: NativeOfficeSurfaceClient | undefined
  policy: NativeOfficeSurfacePolicy
  viewportRef: RefObject<HTMLDivElement>
  sessionId: string | null
  surfaceKey?: string | null
  publishBounds: (bounds: NativeOfficeSurfaceBounds | null) => void
}

/** Synchronize a native editor with its clipped DOM slot without owning its target. */
export function useNativeOfficeSurface({ client, policy, viewportRef, sessionId, surfaceKey, publishBounds }: NativeOfficeSurfaceOptions): void {
  const revisionRef = useRef(0)

  useLayoutEffect(() => {
    const revision = ++revisionRef.current
    const viewport = viewportRef.current
    let disposed = false
    let frame = 0
    let applying = false
    let pending = false
    let attached = false
    let visible = false
    let lastBounds: NativeOfficeSurfaceBounds | null = null
    const ownsRevision = () => revisionRef.current === revision
    const current = () => !disposed && ownsRevision()
    const reportError = (error: unknown) => {
      if (current()) {
        publishBounds(null)
        policy.onError(error)
      }
    }

    if (!client) {
      publishBounds(null)
      return () => { disposed = true }
    }

    const readBounds = (): NativeOfficeSurfaceBounds | null => {
      if (!viewport) return null
      const rect = viewport.getBoundingClientRect()
      const clip = viewport.closest<HTMLElement>('[data-browser-dock-clip]')?.getBoundingClientRect()
      const left = clip ? Math.max(rect.left, clip.left) : rect.left
      const right = clip ? Math.min(rect.right, clip.right) : rect.right
      return { x: left, y: rect.top, width: Math.max(0, right - left), height: rect.height }
    }
    const apply = async () => {
      if (applying || !current()) return
      applying = true
      try {
        while (pending && current()) {
          pending = false
          const bounds = readBounds()
          if (!sessionId || !bounds || bounds.width <= 0 || bounds.height <= 0) {
            await client.setVisible(false)
            if (!current()) return
            visible = false
            lastBounds = null
            publishBounds(null)
            continue
          }
          if (!attached && policy.prepareSession) {
            await policy.prepareSession(sessionId)
            if (!current()) return
          }
          if (!sameBounds(lastBounds, bounds)) {
            if (policy.publishBoundsBeforeApply) publishBounds(bounds)
            await client.setBounds(bounds)
            if (!current()) return
            lastBounds = bounds
            if (!policy.publishBoundsBeforeApply) publishBounds(bounds)
          }
          if (!attached) {
            await client.activateSession(sessionId)
            if (!current()) return
            attached = true
          }
          if (!visible) {
            await client.setVisible(true)
            if (!current()) return
            visible = true
          }
        }
      } catch (error) {
        lastBounds = null
        reportError(error)
      } finally {
        applying = false
        if (pending && current()) void apply()
      }
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        pending = true
        void apply()
      })
    }

    if (!sessionId || !viewport) {
      pending = true
      void apply()
      return () => { disposed = true }
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
    if (policy.initialSync === 'animation-frame') schedule()
    else {
      pending = true
      void apply()
    }
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (!policy.clearBoundsAfterDetach) publishBounds(null)
      void client.setVisible(false, policy.focusHostOnDetach).catch(policy.onError).finally(() => {
        // An old hide acknowledgement must not clear a newer Session's rectangle.
        if (policy.clearBoundsAfterDetach && ownsRevision()) publishBounds(null)
      })
      if (policy.deactivateOnDetach) void client.activateSession(null).catch(policy.onError)
    }
  }, [client, policy, publishBounds, sessionId, surfaceKey, viewportRef])
}

function sameBounds(left: NativeOfficeSurfaceBounds | null, right: NativeOfficeSurfaceBounds): boolean {
  return left !== null && left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height
}
