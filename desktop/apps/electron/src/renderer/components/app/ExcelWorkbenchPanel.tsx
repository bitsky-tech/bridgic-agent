import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { EmbeddedBrowserBounds, ExcelHostConfig } from '@shared/types'
import {
  activeExcelHostSessionAtom,
  excelExpandedAtom,
} from '@/atoms/excel'
import {
  browserSurfaceBlockedAtom,
  setNativeSurfaceRectAtom,
} from '@/atoms/browser'
import { viewedSessionIdAtom } from '@/atoms/navigation'
import { themeAtom } from '@/atoms/theme'
import { Icons } from '@/components/amphi/Icons'
import { rlog } from '@/lib/logger'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

type ExcelLaunchState =
  | { status: 'idle' | 'creating' | 'ready' }
  | { status: 'error'; message: string }

/** Renderer chrome around one Session-owned native Excel WebContentsView. */
export function ExcelWorkbenchPanel({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation()
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const hostSession = useAtomValue(activeExcelHostSessionAtom)
  const expanded = useAtomValue(excelExpandedAtom)
  const surfaceBlocked = useAtomValue(browserSurfaceBlockedAtom)
  const resolvedTheme = useAtomValue(themeAtom).resolved
  const setExpanded = useSetAtom(excelExpandedAtom)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hostError, setHostError] = useState<{ sessionId: string; message: string } | null>(null)
  const config = useMemo<ExcelHostConfig | null>(() => sessionId ? ({
    sessionId,
    locale: i18n.resolvedLanguage?.toLocaleLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
    theme: resolvedTheme === 'dark' ? 'dark' : 'light',
  }) : null, [i18n.resolvedLanguage, resolvedTheme, sessionId])

  useEffect(() => {
    if (!active || !sessionId || !config || !hostSession) return
    let current = true
    void window.api.excelHost.ensureSession(sessionId, config).then(
      () => {
        if (current) setHostError((existing) => existing?.sessionId === sessionId ? null : existing)
      },
      (cause) => {
        if (!current) return
        setHostError({
          sessionId,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      },
    )
    return () => {
      current = false
    }
  }, [active, config, hostSession, sessionId])

  const nativeVisible = active
    && hostSession?.ready === true
    && !hostSession.crashed
    && !surfaceBlocked
  useNativeExcelSurface(viewportRef, nativeVisible ? sessionId : null)

  if (!sessionId || !config) return null
  if (!hostSession) return <ExcelLaunchEmptyState config={config} sessionId={sessionId} />

  const error = hostError?.sessionId === sessionId ? hostError.message : null
  let status = t('excel.hostStarting')
  if (hostSession?.crashed) status = t('excel.hostCrashed')
  else if (error) status = t('excel.hostFailed')
  else if (hostSession?.ready) status = t('excel.hostReady')

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid="excel-workbench">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600">
          {Icons.spreadsheet(14)}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-semibold text-text-primary">Excel</strong>
          <span className="block truncate text-[9px] text-text-tertiary" title={hostSession?.targetId ?? undefined}>
            {status}{hostSession?.targetId ? ` · CDP ${hostSession.targetId.slice(0, 8)}` : ''}
          </span>
        </div>
        <button
          aria-label={expanded ? t('excel.exitExpanded') : t('excel.expand')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? t('excel.exitExpanded') : t('excel.expand')}
          type="button"
        >
          {expanded ? Icons.shrink(14) : Icons.expand(14)}
        </button>
      </header>

      <div ref={viewportRef} className="relative min-h-0 flex-1 bg-bg-app" data-testid="excel-native-canvas">
        {!nativeVisible ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
              {Icons.spreadsheet(25)}
            </span>
            <p className="text-xs font-medium text-text-primary">{status}</p>
            {error ? <p className="mt-1 max-w-80 break-words text-[11px] text-status-error">{error}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function ExcelLaunchEmptyState({ config, sessionId }: {
  config: ExcelHostConfig
  sessionId: string
}) {
  const { t } = useTranslation()
  const creatingRef = useRef(false)
  const [state, setState] = useState<ExcelLaunchState>({ status: 'idle' })
  const opening = state.status === 'creating'
  const ready = state.status === 'ready'

  const createWorkbook = () => {
    if (creatingRef.current) return
    creatingRef.current = true
    setState({ status: 'creating' })
    void window.api.excelHost.ensureSession(sessionId, config).then(
      () => setState({ status: 'ready' }),
      (cause) => {
        rlog.warn('[excel-host] open Session failed', cause)
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : String(cause),
        })
      },
    ).finally(() => {
      creatingRef.current = false
    })
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-bg-surface"
      data-testid="excel-launch-empty-state"
    >
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
      >
        <span className="flex text-emerald-600">{Icons.spreadsheet(16)}</span>
        <span className="text-sm font-semibold text-text-primary">Excel</span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-sm">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-app text-emerald-600">
            {Icons.spreadsheet(20)}
          </div>
          <div className="mt-4 text-sm font-medium text-text-primary">{t('excel.emptyTitle')}</div>
          <div className="mt-1.5 text-xs leading-5 text-text-tertiary">
            {t('excel.emptyDescription')}
          </div>
          <button
            className="mt-4 inline-flex h-8 min-w-24 items-center justify-center rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:opacity-90 disabled:cursor-default disabled:opacity-60"
            data-testid="excel-create-workbook"
            disabled={opening || ready}
            onClick={createWorkbook}
            type="button"
          >
            {opening ? t('excel.hostStarting') : t('excel.newWorkbook')}
          </button>
          {state.status === 'error' ? (
            <div className="mt-2 text-xs text-status-error" role="alert">
              {t('excel.hostFailed')}: {state.message}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function useNativeExcelSurface(viewportRef: RefObject<HTMLDivElement>, sessionId: string | null): void {
  const publishSurfaceRect = useSetAtom(setNativeSurfaceRectAtom)
  const revisionRef = useRef(0)

  useLayoutEffect(() => {
    const revision = revisionRef.current + 1
    revisionRef.current = revision
    const viewport = viewportRef.current
    let disposed = false
    let frame = 0
    let lastBounds: EmbeddedBrowserBounds | null = null
    let applying = false
    let pending = false

    const current = () => !disposed && revisionRef.current === revision
    const hide = async () => {
      await window.api.excelHost.setVisible(false)
      if (current()) publishSurfaceRect(null)
    }
    const readBounds = (): EmbeddedBrowserBounds | null => {
      if (!viewport) return null
      const rect = viewport.getBoundingClientRect()
      const clip = viewport.closest<HTMLElement>('[data-browser-dock-clip]')?.getBoundingClientRect()
      const left = clip ? Math.max(rect.left, clip.left) : rect.left
      const right = clip ? Math.min(rect.right, clip.right) : rect.right
      return {
        x: left,
        y: rect.top,
        width: Math.max(0, right - left),
        height: rect.height,
      }
    }
    const apply = async () => {
      if (applying || !current()) return
      applying = true
      try {
        while (pending && current()) {
          pending = false
          if (!sessionId || !viewport) {
            await hide()
            continue
          }
          const bounds = readBounds()
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
            await hide()
            continue
          }
          lastBounds = bounds
          publishSurfaceRect(bounds)
          await window.api.excelHost.setBounds(bounds)
          if (!current()) return
          await window.api.excelHost.activateSession(sessionId)
          if (!current()) return
          await window.api.excelHost.setVisible(true)
        }
      } catch (cause) {
        rlog.warn('[excel-host] native surface sync failed', cause)
        if (current()) publishSurfaceRect(null)
      } finally {
        applying = false
        if (pending && current()) void apply()
      }
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bounds = readBounds()
        if (!sameBounds(lastBounds, bounds)) {
          lastBounds = bounds
          pending = true
          void apply()
        }
      })
    }

    if (!sessionId || !viewport) {
      pending = true
      void apply()
      return () => {
        disposed = true
        if (revisionRef.current === revision) revisionRef.current += 1
      }
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    let ancestor: HTMLElement | null = viewport.parentElement
    while (ancestor && ancestor !== document.body) {
      observer.observe(ancestor)
      ancestor = ancestor.parentElement
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    pending = true
    void apply()
    return () => {
      disposed = true
      if (revisionRef.current === revision) revisionRef.current += 1
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      publishSurfaceRect(null)
      void window.api.excelHost.setVisible(false)
      void window.api.excelHost.activateSession(null)
    }
  }, [publishSurfaceRect, sessionId, viewportRef])
}

function sameBounds(left: EmbeddedBrowserBounds | null, right: EmbeddedBrowserBounds | null): boolean {
  return left !== null && right !== null
    && left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height
}
