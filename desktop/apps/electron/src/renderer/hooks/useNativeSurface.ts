/**
 * Drive the App's single native workbench/browser surface from a renderer panel.
 *
 * Electron composites one WebContentsView above the page at a time, so the
 * panel that owns the visible surface is responsible for telling the main
 * process where to draw it and when to hide it. This hook is shared by the
 * embedded browser and by the workbench panels; the handoff sequencing it
 * implements was worked out for the browser and must not diverge between them.
 */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { useSetAtom } from 'jotai'
import { setNativeSurfaceRectAtom } from '@/atoms/browser'
import { rlog } from '@/lib/logger'

export interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

export function useNativeBrowserSurface(
  viewportRef: RefObject<HTMLDivElement>,
  sessionId: string | null,
  hidden: boolean,
  onPresentationReady?: (bounds: ViewportBounds) => void,
  onPresentationHidden?: () => void,
  onPresentationHideFailed?: () => void,
): void {
  const hiddenAcknowledgementRequested = onPresentationHidden !== undefined
  // Publishing the rect alongside every setVisible/setBounds keeps renderer
  // overlays that dodge the native view (rather than hiding it) in step with
  // what Electron was actually told — see `nativeSurfaceRectAtom`.
  const publishSurfaceRect = useSetAtom(setNativeSurfaceRectAtom)
  const hiddenRef = useRef(hidden)
  const onPresentationReadyRef = useRef(onPresentationReady)
  const onPresentationHiddenRef = useRef(onPresentationHidden)
  const onPresentationHideFailedRef = useRef(onPresentationHideFailed)
  const lifecycleRevisionRef = useRef(0)
  const presentationRevisionRef = useRef(0)
  const confirmedHiddenRevisionRef = useRef(-1)
  const focusHostHiddenRevisionRef = useRef(-1)
  const requestPresentationSyncRef = useRef<(_remeasure: boolean) => void>(() => undefined)
  const hideNativeSurface = useCallback(async ({
    presentationRevision,
    lifecycleRevision,
    focusHost = false,
  }: {
    presentationRevision: number
    lifecycleRevision: number
    focusHost?: boolean
  }) => {
    try {
      await window.api.browser.setVisible(false, focusHost)
    } catch (error) {
      rlog.warn('[embedded-browser] native surface hide failed', error)
      if (
        hiddenRef.current
        && presentationRevisionRef.current === presentationRevision
        && lifecycleRevisionRef.current === lifecycleRevision
      ) {
        onPresentationHideFailedRef.current?.()
      }
      return
    }
    // AFTER the round trip, mirroring the show path's "before". Both orderings
    // pick the same safe side: an overlay may sit clear of a view that is gone
    // (harmless), never on top of one that is still there. Publishing null up
    // front would hand overlays the corner back while a failed hide left the
    // view on screen — the exact occlusion this rect exists to prevent.
    publishSurfaceRect(null)
    if (
      hiddenRef.current
      && presentationRevisionRef.current === presentationRevision
      && lifecycleRevisionRef.current === lifecycleRevision
      && confirmedHiddenRevisionRef.current !== presentationRevision
      && (
        focusHostHiddenRevisionRef.current !== presentationRevision
        || focusHost
      )
    ) {
      confirmedHiddenRevisionRef.current = presentationRevision
      onPresentationHiddenRef.current?.()
    }
  }, [publishSurfaceRect])

  useLayoutEffect(() => {
    onPresentationReadyRef.current = onPresentationReady
    onPresentationHiddenRef.current = onPresentationHidden
    onPresentationHideFailedRef.current = onPresentationHideFailed
  }, [onPresentationReady, onPresentationHidden, onPresentationHideFailed])

  useLayoutEffect(() => {
    const lifecycleRevision = lifecycleRevisionRef.current + 1
    lifecycleRevisionRef.current = lifecycleRevision
    const viewport = viewportRef.current
    if (!sessionId || !viewport) {
      publishSurfaceRect(null)
      void window.api.browser.setVisible(false)
      return () => {
        if (lifecycleRevisionRef.current === lifecycleRevision) {
          lifecycleRevisionRef.current += 1
        }
      }
    }
    let disposed = false
    let frame = 0
    let lastBounds: ViewportBounds | null = null
    let applying = false
    let pendingBounds: ViewportBounds | null = null
    let presentationDirty = false

    const applyPending = async () => {
      if (applying || disposed) return
      applying = true
      try {
        while ((pendingBounds || presentationDirty) && !disposed) {
          const presentationRevision = presentationRevisionRef.current
          const bounds = pendingBounds ?? lastBounds
          pendingBounds = null
          presentationDirty = false
          if (hiddenRef.current) {
            await hideNativeSurface({
              presentationRevision,
              lifecycleRevision,
            })
            continue
          }
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
            await window.api.browser.setVisible(false)
            publishSurfaceRect(null)
            continue
          }
          // Published before the IPC round trip, not after: an overlay that steps
          // aside must have moved by the time the view actually appears.
          publishSurfaceRect(bounds)
          await window.api.browser.setBounds(bounds)
          if (disposed) return
          if (hiddenRef.current) {
            await hideNativeSurface({
              presentationRevision,
              lifecycleRevision,
            })
            continue
          }
          await window.api.browser.activateSession(sessionId)
          if (disposed) return
          if (hiddenRef.current) {
            await hideNativeSurface({
              presentationRevision,
              lifecycleRevision,
            })
            continue
          }
          await window.api.browser.setVisible(true)
          if (
            !disposed
            && !hiddenRef.current
            && presentationRevisionRef.current === presentationRevision
          ) {
            onPresentationReadyRef.current?.(bounds)
          }
        }
      } catch (error) {
        rlog.warn('[embedded-browser] native surface sync failed', error)
      } finally {
        applying = false
        if ((pendingBounds || presentationDirty) && !disposed) void applyPending()
      }
    }

    const readBounds = (): ViewportBounds => {
      const rect = viewport.getBoundingClientRect()
      const dock = viewport.closest<HTMLElement>('[data-browser-dock]')
      const clip = viewport.closest<HTMLElement>('[data-browser-dock-clip]')
      const visibleDock = dock?.getBoundingClientRect()
      if (
        visibleDock
        && visibleDock.width > 0
        && visibleDock.height > 0
        && (
          rect.left < visibleDock.left - 0.5
          || rect.right > visibleDock.right + 0.5
        )
      ) {
        return { x: rect.x, y: rect.y, width: 0, height: 0 }
      }
      const visibleClip = clip?.getBoundingClientRect()
      const left = visibleClip ? Math.max(rect.left, visibleClip.left) : rect.left
      const right = visibleClip ? Math.min(rect.right, visibleClip.right) : rect.right
      return {
        x: left,
        y: rect.y,
        width: Math.max(0, right - left),
        height: rect.height,
      }
    }

    requestPresentationSyncRef.current = (remeasure) => {
      if (remeasure) {
        const bounds = readBounds()
        lastBounds = bounds
        pendingBounds = bounds
      }
      presentationDirty = true
      void applyPending()
    }

    const measure = () => {
      if (disposed) return
      const bounds = readBounds()
      if (!sameBounds(lastBounds, bounds)) {
        lastBounds = bounds
        pendingBounds = bounds
        void applyPending()
      }
    }

    const scheduleMeasure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }

    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(viewport)
    let ancestor: HTMLElement | null = viewport.parentElement
    while (ancestor && ancestor !== document.body) {
      observer.observe(ancestor)
      ancestor = ancestor.parentElement
    }
    const workArea = viewport.closest<HTMLElement>('[data-browser-layout-root]')
    for (const child of workArea?.children ?? []) observer.observe(child)
    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('scroll', scheduleMeasure, true)
    window.visualViewport?.addEventListener('resize', scheduleMeasure)
    window.visualViewport?.addEventListener('scroll', scheduleMeasure)

    if (hiddenRef.current) {
      // A browser Session can first appear while another dock surface is in front.
      // Claim it before hiding the presentation so Electron can keep its active tab
      // composited in the manager's parked operational viewport.
      void window.api.browser.activateSession(sessionId).catch((error) => {
        rlog.warn('[embedded-browser] native Session activation failed', error)
      })
    }
    void window.api.browser.setVisible(false)
    scheduleMeasure()
    return () => {
      disposed = true
      if (lifecycleRevisionRef.current === lifecycleRevision) {
        lifecycleRevisionRef.current += 1
      }
      requestPresentationSyncRef.current = () => undefined
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('scroll', scheduleMeasure, true)
      window.visualViewport?.removeEventListener('resize', scheduleMeasure)
      window.visualViewport?.removeEventListener('scroll', scheduleMeasure)
      publishSurfaceRect(null)
      void window.api.browser.setVisible(false)
      void window.api.browser.activateSession(null)
    }
  }, [hideNativeSurface, publishSurfaceRect, sessionId, viewportRef])

  useLayoutEffect(() => {
    hiddenRef.current = hidden
    const presentationRevision = presentationRevisionRef.current + 1
    presentationRevisionRef.current = presentationRevision
    if (hidden) {
      const focusHost = hiddenAcknowledgementRequested
      focusHostHiddenRevisionRef.current = focusHost ? presentationRevision : -1
      void hideNativeSurface({
        presentationRevision,
        lifecycleRevision: lifecycleRevisionRef.current,
        focusHost,
      })
      requestPresentationSyncRef.current(false)
      return
    }
    focusHostHiddenRevisionRef.current = -1
    requestPresentationSyncRef.current(true)
  }, [hidden, hiddenAcknowledgementRequested, hideNativeSurface, sessionId])
}

function sameBounds(left: ViewportBounds | null, right: ViewportBounds): boolean {
  return left !== null && left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height
}
