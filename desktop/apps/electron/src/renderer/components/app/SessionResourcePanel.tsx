/** Session-owned mode surfaces and independent workbench tools in one right-side dock. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { viewedSessionIdAtom } from '@/atoms/amphi'
import { currentBrowserAgentActiveAtom } from '@/atoms/agent'
import { currentOfficeSurfaceStatusesAtom } from '@/atoms/office'
import {
  browserNeedsAttentionFamily,
  setBrowserNeedsAttentionAtom,
} from '@/atoms/browser-attention'
import {
  activeEmbeddedBrowserSessionAtom,
  SessionWorkbenchSurface,
  sessionWorkbenchSurfaceAtom,
  setBrowserHandoffPendingAtom,
  setSessionWorkbenchSurfaceAtom,
} from '@/atoms/browser'
import {
  activeExcelHostSessionAtom,
  pendingExcelWorkbookOpenRequestsAtom,
} from '@/atoms/excel'
import {
  filesNeedsAttentionFamily,
  setFilesNeedsAttentionAtom,
} from '@/atoms/files-attention'
import {
  powerPointNeedsAttentionFamily,
  setPowerPointNeedsAttentionAtom,
} from '@/atoms/powerpoint-attention'
import {
  clearRightPanelCollapseRequestAtom,
  rightPanelCollapseRequestAtom,
  rightPanelCollapsedAtom,
  setRightPanelCollapsedAtom,
} from '@/atoms/layout'
import { presentationExpandedAtom } from '@/atoms/presentation'
import { activeEmbeddedPowerPointSessionAtom } from '@/atoms/powerpoint'
import {
  consumeSessionModeExitCollapseRequestAtom,
  currentSessionModeExitCollapseRequestAtom,
  setSessionFocusPaneAtom,
} from '@/atoms/session-focus-pane'
import {
  openSessionModeSurfaceAtom,
  selectedSessionModeSurfaceAtom,
  SessionModeSurfaceKind,
  sessionModeSurfaceAtom,
} from '@/atoms/session-focus-pane-view'
import { useBrowserAttention } from '@/hooks/useBrowserAttention'
import { useEmbeddedBrowserSurfaceEligible } from '@/hooks/useEmbeddedBrowserSurfaceEligible'
import { useHostWindowForeground } from '@/hooks/useHostWindowForeground'
import { usePowerPointAttention } from '@/hooks/usePowerPointAttention'
import {
  SURFACE_ACTIVITY_SETTLE_MS,
  type SurfaceActivityKind,
  useSurfaceActivityPresentation,
} from '@/hooks/useSurfaceActivityPresentation'
import { isOfficeAppKind } from '@/lib/office/officeSurfaceStatus'
import { rlog } from '@/lib/logger'
import { SessionSurfaceRail } from './SessionSurfaceChrome'
import { SessionSurfaceContent } from './SessionSurfaceContent'
import { SessionSurfaceRailTabs } from './SessionSurfaceRailTabs'

type PendingBrowserExit = {
  action: 'collapse' | 'mode' | 'surface'
  sessionId: string
  surface?: SessionWorkbenchSurface
}

export { SURFACE_ACTIVITY_SETTLE_MS }
export const BROWSER_ACTIVITY_SETTLE_MS = SURFACE_ACTIVITY_SETTLE_MS

/** Unified right dock: exactly one foreground surface plus a permanent Bridgic/tool rail. */
export function SessionResourcePanel() {
  const viewedSessionId = useAtomValue(viewedSessionIdAtom)
  return (
    <SessionResourcePanelForSession
      key={viewedSessionId ?? 'no-session'}
      viewedSessionId={viewedSessionId}
    />
  )
}

/** Stable app-level live region for unseen Browser activity. */
export function BrowserAttentionAnnouncer() {
  const { t } = useTranslation()
  const store = useStore()
  const viewedSessionId = useAtomValue(viewedSessionIdAtom)
  const browserNeedsAttention = useAtomValue(
    browserNeedsAttentionFamily(viewedSessionId ?? ''),
  )
  const statusRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const status = statusRef.current
    if (!status) return
    status.textContent = ''
    if (!viewedSessionId || !browserNeedsAttention) return
    let active = true
    queueMicrotask(() => {
      const stillNeedsAttention = store.get(viewedSessionIdAtom) === viewedSessionId
        && store.get(browserNeedsAttentionFamily(viewedSessionId))
      if (active && statusRef.current === status && stillNeedsAttention) {
        status.textContent = t('session.resourcePanel.browserNeedsAttention')
      }
    })
    return () => {
      active = false
    }
  }, [browserNeedsAttention, store, t, viewedSessionId])

  return (
    <span
      ref={statusRef}
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-testid="browser-attention-status"
      role="status"
    />
  )
}

/** Stable app-level live region for unseen PowerPoint activity. */
export function PowerPointAttentionAnnouncer() {
  const { t } = useTranslation()
  const store = useStore()
  const viewedSessionId = useAtomValue(viewedSessionIdAtom)
  const powerPointNeedsAttention = useAtomValue(
    powerPointNeedsAttentionFamily(viewedSessionId ?? ''),
  )
  const statusRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const status = statusRef.current
    if (!status) return
    status.textContent = ''
    if (!viewedSessionId || !powerPointNeedsAttention) return
    let active = true
    queueMicrotask(() => {
      const stillNeedsAttention = store.get(viewedSessionIdAtom) === viewedSessionId
        && store.get(powerPointNeedsAttentionFamily(viewedSessionId))
      if (active && statusRef.current === status && stillNeedsAttention) {
        status.textContent = t('session.resourcePanel.presentationNeedsAttention')
      }
    })
    return () => {
      active = false
    }
  }, [powerPointNeedsAttention, store, t, viewedSessionId])

  return (
    <span
      ref={statusRef}
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-testid="powerpoint-attention-status"
      role="status"
    />
  )
}

/** Stable app-level live region for successfully added Files hidden behind another surface. */
export function FilesAttentionAnnouncer() {
  const { t } = useTranslation()
  const store = useStore()
  const viewedSessionId = useAtomValue(viewedSessionIdAtom)
  const filesNeedsAttention = useAtomValue(
    filesNeedsAttentionFamily(viewedSessionId ?? ''),
  )
  const statusRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const status = statusRef.current
    if (!status) return
    status.textContent = ''
    if (!viewedSessionId || !filesNeedsAttention) return
    let active = true
    queueMicrotask(() => {
      const stillNeedsAttention = store.get(viewedSessionIdAtom) === viewedSessionId
        && store.get(filesNeedsAttentionFamily(viewedSessionId))
      if (active && statusRef.current === status && stillNeedsAttention) {
        status.textContent = t('session.resourcePanel.filesNeedsAttention')
      }
    })
    return () => {
      active = false
    }
  }, [filesNeedsAttention, store, t, viewedSessionId])

  return (
    <span
      ref={statusRef}
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-testid="files-attention-status"
      role="status"
    />
  )
}

function SessionResourcePanelForSession({ viewedSessionId }: { viewedSessionId: string | null }) {
  const { t } = useTranslation()
  const store = useStore()
  const workbenchSurface = useAtomValue(sessionWorkbenchSurfaceAtom)
  const modeSurface = useAtomValue(sessionModeSurfaceAtom)
  const selectedModeSurface = useAtomValue(selectedSessionModeSurfaceAtom)
  const modeExitCollapseRequest = useAtomValue(currentSessionModeExitCollapseRequestAtom)
  const browserSession = useAtomValue(activeEmbeddedBrowserSessionAtom)
  const powerPointSession = useAtomValue(activeEmbeddedPowerPointSessionAtom)
  const excelHostSession = useAtomValue(activeExcelHostSessionAtom)
  const officeStatuses = useAtomValue(currentOfficeSurfaceStatusesAtom)
  const pendingExcelWorkbookOpenRequests = useAtomValue(pendingExcelWorkbookOpenRequestsAtom)
  const browserAgentActive = useAtomValue(currentBrowserAgentActiveAtom)
  const rightCollapsed = useAtomValue(rightPanelCollapsedAtom)
  const collapseRequest = useAtomValue(rightPanelCollapseRequestAtom)
  const setWorkbenchSurface = useSetAtom(setSessionWorkbenchSurfaceAtom)
  const setBrowserNeedsAttention = useSetAtom(setBrowserNeedsAttentionAtom)
  const filesNeedsAttention = useAtomValue(filesNeedsAttentionFamily(viewedSessionId ?? ''))
  const setFilesNeedsAttention = useSetAtom(setFilesNeedsAttentionAtom)
  const setPowerPointNeedsAttention = useSetAtom(setPowerPointNeedsAttentionAtom)
  const setBrowserHandoffPending = useSetAtom(setBrowserHandoffPendingAtom)
  const setRightCollapsed = useSetAtom(setRightPanelCollapsedAtom)
  const setPresentationExpanded = useSetAtom(presentationExpandedAtom)
  const clearCollapseRequest = useSetAtom(clearRightPanelCollapseRequestAtom)
  const consumeModeExitCollapseRequest = useSetAtom(consumeSessionModeExitCollapseRequestAtom)
  const setFocusPane = useSetAtom(setSessionFocusPaneAtom)
  const openModeSurface = useSetAtom(openSessionModeSurfaceAtom)
  const railRef = useRef<HTMLDivElement>(null)
  const autoOpenedPowerPointTargetRef = useRef<string | null>(powerPointSession
    ? `${powerPointSession.sessionId}:${powerPointSession.targetId}`
    : null)
  const lastFocusedRailTabRef = useRef<string | null>(null)
  const modeSurfaceHadFocusRef = useRef(false)
  const selectedExcelOpenRequestRef = useRef<number | null>(null)
  const [nativeHideAcknowledgement, setNativeHideAcknowledgement] = useState(0)
  const [pendingBrowserExit, setPendingBrowserExit] = useState<PendingBrowserExit | null>(null)
  const [excelExitPending, setExcelExitPending] = useState(false)
  const [settledModeHandoffKey, setSettledModeHandoffKey] = useState<string | null>(null)
  const hostWindowForeground = useHostWindowForeground()

  useEffect(() => window.api.events.onPowerPointCloseRequested?.((sessionId) => {
    if (store.get(viewedSessionIdAtom) !== sessionId) return
    setPresentationExpanded(false)
    setRightCollapsed(true)
  }) ?? (() => undefined), [setPresentationExpanded, setRightCollapsed, store])

  useEffect(() => window.api.events.onWordHostHideRequested?.((sessionId) => {
    if (store.get(viewedSessionIdAtom) !== sessionId) return
    if (store.get(sessionWorkbenchSurfaceAtom) !== SessionWorkbenchSurface.Word) return
    setRightCollapsed(true)
  }) ?? (() => undefined), [setRightCollapsed, store])

  useEffect(() => window.api.events.onPowerPointExpandedChanged?.((expanded) => {
    setPresentationExpanded(expanded)
  }) ?? (() => undefined), [setPresentationExpanded])

  const contentOpen = selectedModeSurface !== null || !rightCollapsed

  useLayoutEffect(() => {
    if (!viewedSessionId) return
    setBrowserHandoffPending({
      sessionId: viewedSessionId,
      pending: pendingBrowserExit?.sessionId === viewedSessionId,
    })
    return () => setBrowserHandoffPending({ sessionId: viewedSessionId, pending: false })
  }, [pendingBrowserExit, setBrowserHandoffPending, viewedSessionId])
  const browserSelected = selectedModeSurface === null
    && workbenchSurface === SessionWorkbenchSurface.Browser
  const excelSelected = selectedModeSurface === null
    && workbenchSurface === SessionWorkbenchSurface.Excel
  const excelHasNativeSurface = excelHostSession?.ready === true && !excelHostSession.crashed
  const pendingForViewedSession = pendingBrowserExit?.sessionId === viewedSessionId
    ? pendingBrowserExit
    : null
  const activePending = pendingForViewedSession?.sessionId === browserSession?.sessionId
    ? pendingForViewedSession
    : null
  const browserActiveTab = browserSession?.tabs.find(
    (tab) => tab.tabId === browserSession.activeTabId,
  ) ?? null
  const browserHasNativeSurface = browserActiveTab !== null && !browserActiveTab.crashed
  const panelCollapseRequested = collapseRequest || modeExitCollapseRequest
  const resizeBrowserCollapsePending = panelCollapseRequested
    && workbenchSurface === SessionWorkbenchSurface.Browser
    && contentOpen
  const resizeExcelCollapsePending = panelCollapseRequested
    && excelSelected
    && contentOpen
    && excelHasNativeSurface
  const modeHandoffKey = selectedModeSurface !== null
    && workbenchSurface === SessionWorkbenchSurface.Browser
    && browserHasNativeSurface
    && browserSession
    ? `${browserSession.sessionId}:${selectedModeSurface}`
    : null
  const implicitModeHandoffPending = modeHandoffKey !== null
    && settledModeHandoffKey !== modeHandoffKey
  const effectivePending = (resizeBrowserCollapsePending && browserSession
      ? { action: 'collapse' as const, sessionId: browserSession.sessionId }
      : null)
    ?? activePending
    ?? (implicitModeHandoffPending && browserSession
      ? { action: 'mode' as const, sessionId: browserSession.sessionId }
      : null)
  const browserActive = contentOpen && browserSelected && effectivePending === null
  const browserSurfaceEligible = useEmbeddedBrowserSurfaceEligible(
    browserActive,
    browserActiveTab,
  )
  const browserHasOpenPage = (browserSession?.tabs.length ?? 0) > 0
  const browserLoading = browserActiveTab?.loading ?? false
  let liveBrowserActivityKind: SurfaceActivityKind = null
  if (browserAgentActive) liveBrowserActivityKind = 'agent'
  else if (browserLoading) liveBrowserActivityKind = 'loading'
  const browserActivityKind = useSurfaceActivityPresentation(liveBrowserActivityKind)
  const browserBusy = browserActivityKind !== null
  const nativeHandoffPending = browserHasNativeSurface && effectivePending !== null
  const browserNeedsAttention = useBrowserAttention({
    isBrowserSeen: browserSurfaceEligible && hostWindowForeground,
    sessionId: viewedSessionId,
    tabs: browserSession?.tabs,
  })

  const selectedToolActive = (surface: SessionWorkbenchSurface) => (
    contentOpen && selectedModeSurface === null && workbenchSurface === surface
  )

  const seenOfficeSurface = isOfficeAppKind(workbenchSurface)
    && selectedToolActive(workbenchSurface)
    && hostWindowForeground
    && effectivePending === null
    && !panelCollapseRequested
    ? workbenchSurface
    : null
  usePowerPointAttention({
    isPowerPointSeen: seenOfficeSurface === SessionWorkbenchSurface.Presentation,
    sessionId: viewedSessionId,
  })

  const filesSurfaceSeen = selectedToolActive(SessionWorkbenchSurface.Files)
    && hostWindowForeground
    && effectivePending === null
    && !panelCollapseRequested
  useLayoutEffect(() => {
    if (!viewedSessionId || !filesSurfaceSeen || !filesNeedsAttention) return
    setFilesNeedsAttention({ sessionId: viewedSessionId, needsAttention: false })
  }, [filesNeedsAttention, filesSurfaceSeen, setFilesNeedsAttention, viewedSessionId])

  const commitToolSelection = (surface: SessionWorkbenchSurface) => {
    setFocusPane(null)
    setWorkbenchSurface(surface)
    setRightCollapsed(false)
    setSettledModeHandoffKey(null)
  }

  const beginExcelExit = useCallback((afterHidden: () => void) => {
    if (excelExitPending || !viewedSessionId) return
    const sourceSessionId = viewedSessionId
    setExcelExitPending(true)
    void window.api.excelHost.setVisible(false, true).then(
      () => {
        if (store.get(viewedSessionIdAtom) === sourceSessionId) afterHidden()
      },
      (error) => rlog.warn('[excel-host] native surface hide failed', error),
    ).finally(() => {
      if (store.get(viewedSessionIdAtom) === sourceSessionId) setExcelExitPending(false)
    })
  }, [excelExitPending, store, viewedSessionId])

  const beginBrowserExit = (exit: PendingBrowserExit) => {
    setBrowserHandoffPending({ sessionId: exit.sessionId, pending: true })
    setPendingBrowserExit(exit)
  }

  const selectTool = (surface: SessionWorkbenchSurface) => {
    if (excelExitPending) return
    if (surface === SessionWorkbenchSurface.Browser && viewedSessionId) {
      setBrowserNeedsAttention({ sessionId: viewedSessionId, needsAttention: false })
    }
    if (surface === SessionWorkbenchSurface.Presentation && viewedSessionId) {
      setPowerPointNeedsAttention({ sessionId: viewedSessionId, needsAttention: false })
    }
    if (effectivePending !== null) {
      clearCollapseRequest()
      if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
      if (surface === SessionWorkbenchSurface.Browser) {
        setPendingBrowserExit(null)
        commitToolSelection(SessionWorkbenchSurface.Browser)
      } else if (browserSession) {
        // Ownership transfers as soon as the user clicks. The native Browser can
        // finish hiding asynchronously, but a simultaneous mode exit must not
        // mistake the Agent pane for the user's foreground surface and collapse it.
        setFocusPane(null)
        beginBrowserExit({
          action: 'surface',
          sessionId: browserSession.sessionId,
          surface,
        })
      }
      return
    }
    if (selectedModeSurface === null && workbenchSurface === surface && contentOpen) {
      if (
        surface === SessionWorkbenchSurface.Browser
        && browserHasNativeSurface
        && browserSession
      ) {
        beginBrowserExit({ action: 'collapse', sessionId: browserSession.sessionId })
      } else if (surface === SessionWorkbenchSurface.Excel && excelHasNativeSurface) {
        beginExcelExit(() => setRightCollapsed(true))
      } else {
        setRightCollapsed(true)
      }
      return
    }
    if (
      surface !== SessionWorkbenchSurface.Excel
      && excelSelected
      && excelHasNativeSurface
    ) {
      clearCollapseRequest()
      if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
      beginExcelExit(() => commitToolSelection(surface))
      return
    }
    if (
      surface !== SessionWorkbenchSurface.Browser
      && browserActive
      && browserHasNativeSurface
      && browserSession
    ) {
      clearCollapseRequest()
      if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
      setFocusPane(null)
      beginBrowserExit({
        action: 'surface',
        sessionId: browserSession.sessionId,
        surface,
      })
      return
    }
    clearCollapseRequest()
    if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
    commitToolSelection(surface)
  }

  useEffect(() => {
    const session = powerPointSession
    const targetId = session?.targetId ?? null
    if (!session || !targetId || session.crashed) {
      autoOpenedPowerPointTargetRef.current = null
      return
    }
    const key = `${session.sessionId}:${targetId}`
    if (autoOpenedPowerPointTargetRef.current === key) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || autoOpenedPowerPointTargetRef.current === key) return
      autoOpenedPowerPointTargetRef.current = key
      if (!selectedToolActive(SessionWorkbenchSurface.Presentation)) {
        selectTool(SessionWorkbenchSurface.Presentation)
      }
    })
    return () => {
      cancelled = true
    }
  }, [powerPointSession?.crashed, powerPointSession?.sessionId, powerPointSession?.targetId]) // eslint-disable-line react-hooks/exhaustive-deps
  const pendingExcelOpenRequest = pendingExcelWorkbookOpenRequests.find(
    (request) => request.sessionId === viewedSessionId,
  ) ?? null
  useEffect(() => {
    if (!pendingExcelOpenRequest) {
      selectedExcelOpenRequestRef.current = null
      return
    }
    if (excelSelected && contentOpen) return
    if (selectedExcelOpenRequestRef.current === pendingExcelOpenRequest.requestId) return
    selectedExcelOpenRequestRef.current = pendingExcelOpenRequest.requestId
    selectTool(SessionWorkbenchSurface.Excel)
  }, [contentOpen, excelSelected, pendingExcelOpenRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectMode = () => {
    if (excelExitPending) return
    clearCollapseRequest()
    if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
    if (excelSelected && excelHasNativeSurface) {
      beginExcelExit(() => {
        openModeSurface()
        setRightCollapsed(false)
      })
      return
    }
    if (effectivePending !== null && browserSession) {
      if (selectedModeSurface !== null && contentOpen) {
        beginBrowserExit({ action: 'collapse', sessionId: browserSession.sessionId })
      } else {
        openModeSurface()
        setRightCollapsed(false)
        beginBrowserExit({ action: 'mode', sessionId: browserSession.sessionId })
      }
      return
    }
    if (selectedModeSurface !== null && contentOpen) {
      setFocusPane(null)
      setRightCollapsed(true)
      setSettledModeHandoffKey(null)
      return
    }
    openModeSurface()
    setRightCollapsed(false)
    if (browserActive && browserHasNativeSurface && browserSession) {
      beginBrowserExit({ action: 'mode', sessionId: browserSession.sessionId })
    }
  }

  const acknowledgeNativeHide = () => {
    const sourceSessionId = browserSession?.sessionId
    if (!sourceSessionId || store.get(viewedSessionIdAtom) !== sourceSessionId) return
    setNativeHideAcknowledgement((current) => current + 1)
    if (!effectivePending) return
    if (effectivePending.action === 'surface' && effectivePending.surface) {
      commitToolSelection(effectivePending.surface)
    } else if (effectivePending.action === 'collapse') {
      clearCollapseRequest()
      if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
      setFocusPane(null)
      setRightCollapsed(true)
      setSettledModeHandoffKey(null)
    } else {
      setSettledModeHandoffKey(modeHandoffKey)
      setRightCollapsed(false)
    }
    setPendingBrowserExit(null)
  }

  const recoverFromNativeHideFailure = () => {
    const sourceSessionId = browserSession?.sessionId
    if (!sourceSessionId || store.get(viewedSessionIdAtom) !== sourceSessionId) return
    clearCollapseRequest()
    if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
    setPendingBrowserExit(null)
    setSettledModeHandoffKey(null)
    setFocusPane(null)
    setWorkbenchSurface(SessionWorkbenchSurface.Browser)
    setRightCollapsed(false)
  }

  useLayoutEffect(() => {
    if (!panelCollapseRequested) return
    if (resizeBrowserCollapsePending && browserHasNativeSurface && browserSession) return
    if (resizeExcelCollapsePending) {
      if (!excelExitPending) {
        queueMicrotask(() => {
          beginExcelExit(() => {
            clearCollapseRequest()
            if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
            setFocusPane(null)
            setRightCollapsed(true)
          })
        })
      }
      return
    }
    clearCollapseRequest()
    if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
    setFocusPane(null)
    setRightCollapsed(true)
  }, [
    browserHasNativeSurface,
    browserSession,
    beginExcelExit,
    clearCollapseRequest,
    consumeModeExitCollapseRequest,
    panelCollapseRequested,
    resizeBrowserCollapsePending,
    resizeExcelCollapsePending,
    excelExitPending,
    setFocusPane,
    setRightCollapsed,
    viewedSessionId,
  ])

  useEffect(() => {
    if (!pendingForViewedSession || browserHasNativeSurface) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (pendingForViewedSession.action === 'surface' && pendingForViewedSession.surface) {
        commitToolSelection(pendingForViewedSession.surface)
      } else if (pendingForViewedSession.action === 'collapse') {
        clearCollapseRequest()
        if (viewedSessionId) consumeModeExitCollapseRequest(viewedSessionId)
        setFocusPane(null)
        setRightCollapsed(true)
        setSettledModeHandoffKey(null)
      } else {
        setRightCollapsed(false)
      }
      setPendingBrowserExit(null)
    })
    return () => {
      cancelled = true
    }
  }, [browserHasNativeSurface, pendingForViewedSession]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedModeSurface !== null || settledModeHandoffKey === null) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setSettledModeHandoffKey(null)
    })
    return () => {
      cancelled = true
    }
  }, [selectedModeSurface, settledModeHandoffKey])

  useEffect(() => {
    const rememberRailFocus = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      modeSurfaceHadFocusRef.current = target.closest('[data-testid="session-mode-surface"]') !== null
      if (!railRef.current?.contains(target)) {
        lastFocusedRailTabRef.current = null
        return
      }
      lastFocusedRailTabRef.current = target.closest<HTMLElement>('[role="tab"]')?.dataset.testid
        ?? null
    }
    document.addEventListener('focusin', rememberRailFocus)
    return () => document.removeEventListener('focusin', rememberRailFocus)
  }, [])

  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const activeElement = document.activeElement
    const focusStayedInRail = activeElement instanceof Node && rail.contains(activeElement)
    const focusedModeWasRemoved = activeElement === document.body && modeSurfaceHadFocusRef.current
    if (!focusStayedInRail && !focusedModeWasRemoved) return
    rail.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"], [role="tab"][tabindex="0"]',
    )?.focus()
    modeSurfaceHadFocusRef.current = false
  }, [modeSurface, selectedModeSurface, workbenchSurface])

  let browserAriaLabel = t('session.resourcePanel.browser')
  if (browserActivityKind === 'agent') browserAriaLabel = t('session.resourcePanel.browserAgentActive')
  else if (browserActivityKind === 'loading') browserAriaLabel = t('session.resourcePanel.browserLoading')
  else if (browserNeedsAttention) browserAriaLabel = t('session.resourcePanel.browserNeedsAttention')
  else if (browserHasOpenPage) browserAriaLabel = t('session.resourcePanel.browserOpened')
  let browserLabel = t('session.resourcePanel.browser')
  if (browserActivityKind === 'agent') browserLabel = t('session.resourcePanel.browserActiveShort')
  else if (browserActivityKind === 'loading') browserLabel = t('session.resourcePanel.browserLoadingShort')
  let modeAriaLabel = t('workflowRunDetails.runDetails')
  if (modeSurface === SessionModeSurfaceKind.Task) {
    modeAriaLabel = t('focusMode.viewTaskSpec')
  } else if (modeSurface === SessionModeSurfaceKind.Presentation) {
    modeAriaLabel = t('presentationMode.open')
  }

  return (
    <div
      className="flex h-full min-h-0 overflow-hidden bg-bg-surface"
      data-testid="session-resource-panel"
    >
      <SessionSurfaceContent
        isBrowserActive={browserActive}
        isNativeHandoffPending={nativeHandoffPending}
        isToolActive={selectedToolActive}
        modeSurfaceKey={`${viewedSessionId ?? 'none'}:${selectedModeSurface ?? 'none'}`}
        nativeHideAcknowledgement={nativeHideAcknowledgement}
        onNativeHideFailed={recoverFromNativeHideFailure}
        onNativeHidden={acknowledgeNativeHide}
        selectedModeSurface={selectedModeSurface}
      />

      <SessionSurfaceRail
        isAgentActive={selectedModeSurface !== null}
        isContentOpen={contentOpen}
        isModeAvailable={modeSurface !== null}
        modeAriaLabel={modeAriaLabel}
        onOpenMode={selectMode}
        railAriaLabel={t('session.resourcePanel.surfaceRailAria')}
        railRef={railRef}
      >
        <SessionSurfaceRailTabs
          browserAriaLabel={browserAriaLabel}
          browserLabel={browserLabel}
          browserNeedsAttention={browserNeedsAttention}
          filesNeedsAttention={filesNeedsAttention}
          hasBrowserOpenPage={browserHasOpenPage}
          isBrowserAgentActive={browserAgentActive && browserActivityKind === 'agent'}
          isBrowserBusy={browserBusy}
          isContentOpen={contentOpen}
          isModeSelected={selectedModeSurface !== null}
          onSelect={selectTool}
          officeStatuses={officeStatuses}
          seenOfficeSurface={seenOfficeSurface}
          selectedSurface={workbenchSurface}
        />
      </SessionSurfaceRail>
    </div>
  )
}
