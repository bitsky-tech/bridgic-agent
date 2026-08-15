/**
 * Latch unseen embedded-Browser activity until the user can actually see it.
 *
 * Attention is scoped by Session in Jotai. New tab IDs are also tracked locally
 * so page-created popups are covered without changing the browser snapshot
 * protocol. The caller combines renderer presentation eligibility with the
 * main process's native-host foreground state; host-renderer focus is
 * deliberately not used because the Browser lives in a separate Electron
 * WebContentsView.
 */
import { useLayoutEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { EmbeddedBrowserTabInfo } from '@shared/types'
import {
  browserNeedsAttentionFamily,
  setBrowserNeedsAttentionAtom,
} from '@/atoms/browser-attention'

const EMPTY_BROWSER_TABS: readonly EmbeddedBrowserTabInfo[] = Object.freeze([])

/** Inputs that determine whether Browser activity is currently unseen. */
export interface UseBrowserAttentionOptions {
  isBrowserSeen: boolean
  sessionId: string | null
  tabs?: readonly EmbeddedBrowserTabInfo[]
}

/** Return and maintain the viewed Session's persistent Browser attention state. */
export function useBrowserAttention({
  isBrowserSeen,
  sessionId,
  tabs = EMPTY_BROWSER_TABS,
}: UseBrowserAttentionOptions): boolean {
  const needsAttention = useAtomValue(browserNeedsAttentionFamily(sessionId ?? ''))
  const setNeedsAttention = useSetAtom(setBrowserNeedsAttentionAtom)
  const knownTabsRef = useRef<{
    sessionId: string | null
    tabIds: ReadonlySet<string>
  } | null>(null)

  useLayoutEffect(() => {
    const knownTabIds = knownTabsRef.current?.sessionId === sessionId
      ? knownTabsRef.current.tabIds
      : null
    const nextTabIds = new Set(tabs.map((tab) => tab.tabId))
    knownTabsRef.current = { sessionId, tabIds: nextTabIds }
    if (!sessionId) return

    const hasNewTab = knownTabIds !== null
      && tabs.some((tab) => !knownTabIds.has(tab.tabId))
    let nextNeedsAttention: boolean | null = null
    if (isBrowserSeen && needsAttention) nextNeedsAttention = false
    else if (!isBrowserSeen && hasNewTab) nextNeedsAttention = true

    if (nextNeedsAttention !== null) {
      setNeedsAttention({ sessionId, needsAttention: nextNeedsAttention })
    }
  }, [
    isBrowserSeen,
    needsAttention,
    sessionId,
    setNeedsAttention,
    tabs,
  ])

  return needsAttention && !isBrowserSeen
}
