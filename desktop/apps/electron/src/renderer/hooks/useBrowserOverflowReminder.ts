/**
 * Detect a wide active page once its native Browser presentation is genuinely ready.
 *
 * The trigger deliberately lives with the presented page instead of a rail-click action:
 * Agent auto-reveal and manual Browser selection therefore follow the same lifecycle.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EmbeddedBrowserTabInfo } from '@shared/types'
import { rlog } from '@/lib/logger'

/** Briefly let a newly loaded page finish its responsive layout before inspection. */
export const BROWSER_OVERFLOW_INSPECTION_DELAY_MS = 240

/** Native viewport dimensions after Electron has applied and shown them. */
export interface BrowserPresentationBounds {
  width: number
  height: number
}

/** Inputs that define the currently presented Browser page. */
export interface UseBrowserOverflowReminderOptions {
  activeTab: EmbeddedBrowserTabInfo | null
  expanded: boolean
  presentationVisible: boolean
  sessionId: string | null
  surfaceVisible: boolean
}

/** Result used by the native-surface lifecycle and Browser chrome. */
export interface UseBrowserOverflowReminderResult {
  dismissReminder: () => void
  onPresentationReady: (bounds: BrowserPresentationBounds) => void
  reminderId: string | null
}

interface ReadyPresentation extends BrowserPresentationBounds {
  epoch: number
  sessionId: string
}

interface OverflowCandidate {
  epochKey: string
  key: string
  sessionId: string
  tabId: string
}

/**
 * Inspect at most once per Browser open epoch, after the active non-blank page loads.
 * A late result is shown only while the same Session, tab, URL and viewport remain active.
 */
export function useBrowserOverflowReminder({
  activeTab,
  expanded,
  presentationVisible,
  sessionId,
  surfaceVisible,
}: UseBrowserOverflowReminderOptions): UseBrowserOverflowReminderResult {
  const epochSequenceRef = useRef(0)
  const presentationOpenRef = useRef(false)
  const presentationSessionRef = useRef<string | null>(null)
  const handledEpochsRef = useRef(new Set<string>())
  const inspectionRevisionRef = useRef(0)
  const [readyPresentation, setReadyPresentation] = useState<ReadyPresentation | null>(null)
  const [overflowCandidateKey, setOverflowCandidateKey] = useState<string | null>(null)
  const activeTabId = activeTab?.tabId ?? null
  const activeTabUrl = activeTab?.url ?? null
  const activeTabLoading = activeTab?.loading ?? false
  const activeTabCrashed = activeTab?.crashed ?? false

  useLayoutEffect(() => {
    if (!presentationVisible) {
      presentationOpenRef.current = false
      presentationSessionRef.current = null
    }
    inspectionRevisionRef.current += 1
    // A new requested presentation must wait for a fresh native bounds/show acknowledgement.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReadyPresentation(null)
  }, [presentationVisible, sessionId, surfaceVisible])

  const onPresentationReady = useCallback((bounds: BrowserPresentationBounds) => {
    if (
      !presentationVisible
      || !surfaceVisible
      || !sessionId
      || bounds.width <= 0
      || bounds.height <= 0
    ) return

    if (!presentationOpenRef.current || presentationSessionRef.current !== sessionId) {
      epochSequenceRef.current += 1
      presentationOpenRef.current = true
      presentationSessionRef.current = sessionId
    }
    const next: ReadyPresentation = {
      epoch: epochSequenceRef.current,
      height: Math.round(bounds.height),
      sessionId,
      width: Math.round(bounds.width),
    }
    setReadyPresentation((current) => (
      current?.epoch === next.epoch
      && current.height === next.height
      && current.sessionId === next.sessionId
      && current.width === next.width
        ? current
        : next
    ))
  }, [presentationVisible, sessionId, surfaceVisible])

  const readyEpochKey = presentationVisible
    && sessionId
    && readyPresentation?.sessionId === sessionId
    ? JSON.stringify([sessionId, readyPresentation.epoch])
    : null

  const candidate = useMemo<OverflowCandidate | null>(() => {
    if (
      !readyEpochKey
      || !surfaceVisible
      || !sessionId
      || !readyPresentation
      || !activeTabId
      || activeTabCrashed
      || activeTabLoading
      || !activeTabUrl
      || activeTabUrl === 'about:blank'
    ) {
      return null
    }
    return {
      epochKey: readyEpochKey,
      key: JSON.stringify([
        readyEpochKey,
        activeTabId,
        activeTabUrl,
        readyPresentation.width,
        readyPresentation.height,
      ]),
      sessionId,
      tabId: activeTabId,
    }
  }, [
    activeTabCrashed,
    activeTabId,
    activeTabLoading,
    activeTabUrl,
    readyEpochKey,
    readyPresentation,
    sessionId,
    surfaceVisible,
  ])

  useLayoutEffect(() => {
    // Invalidate a pending page script before passive-effect cleanup runs. This
    // prevents an old URL/tab/viewport result from consuming the current epoch.
    inspectionRevisionRef.current += 1
  }, [candidate?.key])

  useEffect(() => {
    inspectionRevisionRef.current += 1
    if (!readyEpochKey || !expanded) return
    handledEpochsRef.current.add(readyEpochKey)
  }, [expanded, readyEpochKey])

  useEffect(() => {
    const inspectionRevision = inspectionRevisionRef.current + 1
    inspectionRevisionRef.current = inspectionRevision
    if (!candidate || expanded || handledEpochsRef.current.has(candidate.epochKey)) return

    const timer = window.setTimeout(() => {
      if (handledEpochsRef.current.has(candidate.epochKey)) return
      void window.api.browser.hasHorizontalOverflow(candidate.sessionId, candidate.tabId).then(
        (hasHorizontalOverflow) => {
          if (inspectionRevisionRef.current === inspectionRevision) {
            handledEpochsRef.current.add(candidate.epochKey)
            setOverflowCandidateKey(hasHorizontalOverflow ? candidate.key : null)
          }
        },
        (error) => {
          if (inspectionRevisionRef.current === inspectionRevision) {
            handledEpochsRef.current.add(candidate.epochKey)
            setOverflowCandidateKey(null)
            rlog.warn('[embedded-browser] horizontal overflow inspection failed', error)
          }
        },
      )
    }, BROWSER_OVERFLOW_INSPECTION_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
      if (inspectionRevisionRef.current === inspectionRevision) {
        inspectionRevisionRef.current += 1
      }
    }
  }, [candidate, expanded])

  const dismissReminder = useCallback(() => {
    inspectionRevisionRef.current += 1
    if (candidate) handledEpochsRef.current.add(candidate.epochKey)
    setOverflowCandidateKey(null)
  }, [candidate])

  const reminderId = !expanded
    && candidate !== null
    && overflowCandidateKey === candidate.key
    ? candidate.key
    : null

  return { dismissReminder, onPresentationReady, reminderId }
}
