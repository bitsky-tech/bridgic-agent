import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { EmbeddedBrowserSessionInfo, EmbeddedBrowserTabInfo } from '@shared/types'
import {
  activeEmbeddedBrowserSessionAtom,
  browserExpandedAtom,
} from '@/atoms/browser'
import { viewedSessionIdAtom } from '@/atoms/amphi'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { Icons } from '@/components/amphi/Icons'
import { useBrowserOverflowReminder } from '@/hooks/useBrowserOverflowReminder'
import { useEmbeddedBrowserSurfaceEligible } from '@/hooks/useEmbeddedBrowserSurfaceEligible'
import { BrowserExpandControl } from './BrowserExpandControl'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

type BrowserLaunchState =
  | { status: 'idle' | 'creating' | 'ready' }
  | { status: 'error'; message: string }

export interface EmbeddedBrowserPanelProps {
  sessionId?: string | null
  browserSession?: EmbeddedBrowserSessionInfo | null
  presentationVisible?: boolean
  onPresentationHidden?: () => void
  onPresentationHideFailed?: () => void
}

/** Session-scoped browser workbench backed by one visible native tab surface. */
export function EmbeddedBrowserPanel({
  sessionId: providedSessionId,
  browserSession: providedBrowserSession,
  presentationVisible = true,
  onPresentationHidden,
  onPresentationHideFailed,
}: EmbeddedBrowserPanelProps = {}) {
  const { t } = useTranslation()
  const activeBrowserSession = useAtomValue(activeEmbeddedBrowserSessionAtom)
  const viewedSessionId = useAtomValue(viewedSessionIdAtom)
  const browserSessionCandidate = providedBrowserSession === undefined
    ? activeBrowserSession
    : providedBrowserSession
  const sessionId = providedSessionId === undefined
    ? browserSessionCandidate?.sessionId ?? viewedSessionId
    : providedSessionId
  const browserSession = browserSessionCandidate?.sessionId === sessionId
    ? browserSessionCandidate
    : null
  const expanded = useAtomValue(browserExpandedAtom)
  const setExpanded = useSetAtom(browserExpandedAtom)
  const viewportRef = useRef<HTMLDivElement>(null)
  const activeTab = useMemo(
    () => browserSession?.tabs.find((tab) => tab.tabId === browserSession.activeTabId) ?? null,
    [browserSession],
  )
  const nativeSurfaceEligible = useEmbeddedBrowserSurfaceEligible(
    presentationVisible,
    activeTab,
  )
  const {
    dismissReminder: dismissOverflowReminder,
    onPresentationReady,
    reminderId: overflowReminderId,
  } = useBrowserOverflowReminder({
    activeTab,
    expanded,
    presentationVisible,
    sessionId: browserSession?.sessionId ?? null,
    surfaceVisible: nativeSurfaceEligible,
  })

  useNativeBrowserSurface(
    viewportRef,
    browserSession?.sessionId ?? null,
    !nativeSurfaceEligible,
    onPresentationReady,
    onPresentationHidden,
    onPresentationHideFailed,
  )

  if (!sessionId) return null
  if (!browserSession) {
    return <BrowserLaunchEmptyState key={sessionId} sessionId={sessionId} />
  }
  const invoke = (operation: Promise<unknown>, label: string) => {
    void operation.catch((error) => rlog.warn(`[embedded-browser] ${label} failed`, error))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-surface">
      <div
        className="flex flex-shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-app px-2"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-testid="browser-tab-strip"
          role="tablist"
          aria-label={t('session.browser.tabsAria')}
        >
          {browserSession.tabs.map((tab) => (
            <BrowserTab
              key={tab.tabId}
              tab={tab}
              active={tab.tabId === browserSession.activeTabId}
              onActivate={() => {
                dismissOverflowReminder()
                invoke(window.api.browser.activateTab(sessionId, tab.tabId), 'activate tab')
              }}
              onClose={() => invoke(
                window.api.browser.closeTab(sessionId, tab.tabId),
                'close tab',
              )}
            />
          ))}
        </div>
        <ChromeButton
          label={t('session.browser.newTab')}
          testId="browser-new-tab"
          onClick={() => invoke(window.api.browser.createTab(sessionId), 'create tab')}
        >
          {Icons.plus(15)}
        </ChromeButton>
        <BrowserExpandControl
          expanded={expanded}
          onReminderDismiss={dismissOverflowReminder}
          reminderId={overflowReminderId}
          onExpandedChange={(nextExpanded) => {
            dismissOverflowReminder()
            setExpanded(nextExpanded)
          }}
        />
        <ChromeButton
          label={t('session.browser.closeSession')}
          testId="browser-close-session"
          onClick={() => {
            setExpanded(false)
            invoke(window.api.browser.closeSession(sessionId), 'close session')
          }}
        >
          {Icons.x(15)}
        </ChromeButton>
      </div>

      <BrowserToolbar sessionId={sessionId} activeTab={activeTab} invoke={invoke} />

      <div ref={viewportRef} className="relative min-h-0 flex-1 bg-white" data-testid="browser-canvas">
        {!activeTab && (
          <BrowserCanvasNotice
            title={t('session.browser.emptyTitle')}
            detail={t('session.browser.emptyDetail')}
          />
        )}
        {activeTab?.crashed && (
          <BrowserCanvasNotice
            title={t('session.browser.crashedTitle')}
            detail={t('session.browser.crashedDetail')}
          />
        )}
      </div>
    </div>
  )
}

function BrowserLaunchEmptyState({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const creatingRef = useRef(false)
  const [state, setState] = useState<BrowserLaunchState>({ status: 'idle' })
  const opening = state.status === 'creating'
  const ready = state.status === 'ready'
  let launchButtonKey: 'creating' | 'open' | 'ready' | 'retry'
  if (state.status === 'error') {
    launchButtonKey = 'retry'
  } else if (state.status === 'idle') {
    launchButtonKey = 'open'
  } else {
    launchButtonKey = state.status
  }
  const openBrowser = () => {
    if (creatingRef.current) return
    creatingRef.current = true
    setState({ status: 'creating' })
    void window.api.browser.createTab(sessionId).then(
      () => setState({ status: 'ready' }),
      (error) => {
        rlog.warn('[embedded-browser] open session failed', error)
        setState({ status: 'error', message: browserErrorMessage(error, t('session.browser.retry')) })
      },
    ).finally(() => {
      creatingRef.current = false
    })
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-surface"
      data-testid="browser-launch-empty-state"
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
        data-testid="browser-empty-header"
      >
        <span className="flex text-text-accent">{Icons.globe(16)}</span>
        <span className="text-sm font-semibold text-text-primary">
          {t('session.resourcePanel.browser')}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-sm">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-app text-text-secondary">
            {Icons.globe(20)}
          </div>
          <div className="mt-4 text-sm font-medium text-text-primary">{t('session.browser.launchTitle')}</div>
          <div className="mt-1.5 text-xs leading-5 text-text-tertiary">
            {t('session.browser.launchDetail')}
          </div>
          <button
            type="button"
            data-testid="browser-open-session"
            disabled={opening || ready}
            onClick={openBrowser}
            className="mt-4 inline-flex h-8 min-w-24 items-center justify-center rounded-md bg-brand-blue px-3 text-xs font-medium text-white hover:opacity-90 disabled:cursor-default disabled:opacity-60"
          >
            {t(`session.browser.launchButton.${launchButtonKey}`)}
          </button>
          {state.status === 'error' && (
            <div className="mt-2 text-xs text-red-500" role="alert">
              {t('session.browser.launchFailed', { message: state.message })}
            </div>
          )}
          {(opening || ready) && (
            <div
              className="mt-2 text-xs text-text-tertiary"
              data-testid="browser-open-status"
              role="status"
            >
              {opening ? t('session.browser.syncCreating') : t('session.browser.syncReady')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BrowserTab({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: EmbeddedBrowserTabInfo
  active: boolean
  onActivate: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const title = tabTitle(tab, t('session.browser.newTab'))
  return (
    <div
      className={cn(
        'group flex h-7 min-w-[120px] max-w-[210px] flex-shrink cursor-pointer items-center gap-1.5 rounded-md border px-2 text-left',
        active
          ? 'border-border-subtle bg-bg-surface text-text-primary shadow-sm'
          : 'border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
      aria-selected={active}
      role="tab"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onActivate()
      }}
    >
      {tab.faviconUrl ? (
        <img src={tab.faviconUrl} alt="" className="h-3.5 w-3.5 flex-shrink-0" />
      ) : (
        <span className="flex-shrink-0 text-text-tertiary">{Icons.globe(13)}</span>
      )}
      <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
      {tab.loading && <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-brand-blue" />}
      <button
        type="button"
        aria-label={t('session.browser.closeTabAria', { title })}
        className="flex-shrink-0 rounded p-0.5 text-text-tertiary opacity-70 hover:bg-bg-active hover:text-text-primary group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        {Icons.x(12)}
      </button>
    </div>
  )
}

function BrowserToolbar({
  sessionId,
  activeTab,
  invoke,
}: {
  sessionId: string
  activeTab: EmbeddedBrowserTabInfo | null
  invoke: (operation: Promise<unknown>, label: string) => void
}) {
  const { t } = useTranslation()
  const [addressDraft, setAddressDraft] = useState<{ tabId: string; value: string } | null>(null)
  const activeTabId = activeTab?.tabId ?? ''
  const address = addressDraft?.tabId === activeTabId
    ? addressDraft.value
    : activeTab?.url ?? ''

  const submitAddress = (event: FormEvent) => {
    event.preventDefault()
    if (!activeTab) return
    const destination = normalizeAddress(address)
    if (!destination) return
    setAddressDraft({ tabId: activeTab.tabId, value: destination })
    invoke(
      window.api.browser.navigateTab(sessionId, activeTab.tabId, destination),
      'navigate tab',
    )
  }

  return (
    <div className="flex h-10 flex-shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-2">
      <ChromeButton
        label={t('session.browser.back')}
        disabled={!activeTab?.canGoBack}
        onClick={() => activeTab && invoke(
          window.api.browser.goBack(sessionId, activeTab.tabId),
          'go back',
        )}
      >
        <span className="rotate-180">{Icons.chevronRight(16)}</span>
      </ChromeButton>
      <ChromeButton
        label={t('session.browser.forward')}
        disabled={!activeTab?.canGoForward}
        onClick={() => activeTab && invoke(
          window.api.browser.goForward(sessionId, activeTab.tabId),
          'go forward',
        )}
      >
        {Icons.chevronRight(16)}
      </ChromeButton>
      <ChromeButton
        label={t('session.browser.reload')}
        disabled={!activeTab}
        onClick={() => activeTab && invoke(
          window.api.browser.reload(sessionId, activeTab.tabId),
          'reload tab',
        )}
      >
        <span className={cn(activeTab?.loading && 'animate-spin')}>{Icons.refresh(15)}</span>
      </ChromeButton>
      <form className="min-w-0 flex-1" onSubmit={submitAddress}>
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-border-subtle bg-bg-input px-2 focus-within:border-brand-blue">
          <span className="flex-shrink-0 text-text-tertiary">{Icons.globe(13)}</span>
          <input
            value={address}
            aria-label={t('session.browser.addressAria')}
            data-testid="browser-address"
            disabled={!activeTab}
            onFocus={(event) => {
              if (activeTab) {
                setAddressDraft({ tabId: activeTab.tabId, value: event.currentTarget.value })
              }
              event.currentTarget.select()
            }}
            onBlur={() => setAddressDraft(null)}
            onChange={(event) => {
              if (activeTab) {
                setAddressDraft({ tabId: activeTab.tabId, value: event.currentTarget.value })
              }
            }}
            placeholder={t('session.browser.addressPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-default"
          />
        </div>
      </form>
    </div>
  )
}

function ChromeButton({
  label,
  testId,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  testId?: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

function BrowserCanvasNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-bg-app text-center">
      <div>
        <div className="text-sm font-medium text-text-primary">{title}</div>
        <div className="mt-1 text-xs text-text-tertiary">{detail}</div>
      </div>
    </div>
  )
}

function tabTitle(tab: EmbeddedBrowserTabInfo, newTabLabel: string): string {
  if (tab.title.trim()) return tab.title.trim()
  if (!tab.url || tab.url === 'about:blank') return newTabLabel
  try {
    return new URL(tab.url).hostname || tab.url
  } catch {
    return tab.url
  }
}

function browserErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return fallbackMessage
}

export function normalizeAddress(value: string): string {
  const input = value.trim()
  if (!input) return ''
  if (/^https?:\/\//i.test(input) || input === 'about:blank') return input
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(?:\/|$)/i.test(input)) {
    return `http://${input}`
  }
  if (/^[^\s/]+\.[^\s]+/.test(input)) return `https://${input}`
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`
}

function useNativeBrowserSurface(
  viewportRef: RefObject<HTMLDivElement>,
  sessionId: string | null,
  hidden: boolean,
  onPresentationReady?: (bounds: ViewportBounds) => void,
  onPresentationHidden?: () => void,
  onPresentationHideFailed?: () => void,
): void {
  const hiddenAcknowledgementRequested = onPresentationHidden !== undefined
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
  }, [])

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
            continue
          }
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
      void window.api.browser.setVisible(false)
      void window.api.browser.activateSession(null)
    }
  }, [hideNativeSurface, sessionId, viewportRef])

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
