import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import type { EmbeddedBrowserSnapshot } from '@shared/types'
import { setBrowserNeedsAttentionAtom } from '@/atoms/browser-attention'
import { setEmbeddedBrowserSnapshotAtom } from '@/atoms/browser'
import { rlog } from '@/lib/logger'

function sessionsWithNewTabs(
  previous: EmbeddedBrowserSnapshot,
  next: EmbeddedBrowserSnapshot,
): string[] {
  const previousTabIds = new Map(previous.sessions.map((session) => [
    session.sessionId,
    new Set(session.tabs.map((tab) => tab.tabId)),
  ]))
  return next.sessions
    .filter((session) => {
      const knownTabIds = previousTabIds.get(session.sessionId) ?? new Set<string>()
      return session.tabs.some((tab) => !knownTabIds.has(tab.tabId))
    })
    .map((session) => session.sessionId)
}

/** Hydrate and subscribe to Electron-owned browser view state. */
export function useEmbeddedBrowserBridge(): void {
  const setSnapshot = useSetAtom(setEmbeddedBrowserSnapshotAtom)
  const setBrowserNeedsAttention = useSetAtom(setBrowserNeedsAttentionAtom)

  useEffect(() => {
    let active = true
    let initialPending = true
    let previousSnapshot: EmbeddedBrowserSnapshot | null = null
    let pendingPushedSnapshots: EmbeddedBrowserSnapshot[] = []
    const latchNewTabs = (
      previous: EmbeddedBrowserSnapshot,
      next: EmbeddedBrowserSnapshot,
    ) => {
      for (const sessionId of sessionsWithNewTabs(previous, next)) {
        setBrowserNeedsAttention({ sessionId, needsAttention: true })
      }
    }
    const unsubscribe = window.api.events.onEmbeddedBrowserChanged((snapshot) => {
      if (!active) return
      if (initialPending) {
        // Keep every transition until the initial query settles. A popup can
        // open and close before that query resolves; retaining only the latest
        // snapshot would erase the evidence that the new tab ever existed.
        pendingPushedSnapshots.push(snapshot)
      } else if (previousSnapshot) {
        latchNewTabs(previousSnapshot, snapshot)
      } else {
        // The initial query failed, so conservatively treat tabs in the first
        // pushed snapshot as new instead of silently missing activity.
        latchNewTabs({ sessions: [] }, snapshot)
      }
      previousSnapshot = snapshot
      setSnapshot(snapshot)
    })
    void window.api.browser.snapshot().then(
      (snapshot) => {
        if (!active) return
        initialPending = false
        if (pendingPushedSnapshots.length > 0) {
          let baseline = snapshot
          for (const pushedSnapshot of pendingPushedSnapshots) {
            latchNewTabs(baseline, pushedSnapshot)
            baseline = pushedSnapshot
          }
          previousSnapshot = baseline
          pendingPushedSnapshots = []
          return
        }
        previousSnapshot = snapshot
        setSnapshot(snapshot)
      },
      (error) => {
        if (!active) return
        initialPending = false
        if (pendingPushedSnapshots.length > 0) {
          let baseline: EmbeddedBrowserSnapshot = { sessions: [] }
          for (const pushedSnapshot of pendingPushedSnapshots) {
            latchNewTabs(baseline, pushedSnapshot)
            baseline = pushedSnapshot
          }
          previousSnapshot = baseline
          pendingPushedSnapshots = []
        }
        rlog.warn('[embedded-browser] initial snapshot failed', error)
      },
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [setBrowserNeedsAttention, setSnapshot])
}
