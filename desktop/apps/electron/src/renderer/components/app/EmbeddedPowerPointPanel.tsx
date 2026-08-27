import { viewedSessionIdAtom } from '@/atoms/navigation'
import { browserSurfaceBlockedAtom, setNativePowerPointSurfaceRectAtom } from '@/atoms/browser'
import { activeEmbeddedPowerPointSessionAtom } from '@/atoms/powerpoint'
import { Icons } from '@/components/amphi/Icons'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { useAtomValue, useSetAtom } from 'jotai'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

export interface EmbeddedPowerPointPanelProps {
  active: boolean
}

/** Renderer placeholder whose rectangle is occupied by the native Session PPT view. */
export function EmbeddedPowerPointPanel({ active }: EmbeddedPowerPointPanelProps) {
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const powerPointSession = useAtomValue(activeEmbeddedPowerPointSessionAtom)
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
    if (!active || surfaceBlocked || !sessionId || !powerPointSession || !viewport) {
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
  }, [active, powerPointSession, publishSurfaceRect, sessionId, surfaceBlocked])

  if (!sessionId) return null
  if (!powerPointSession) return <PowerPointLaunchEmptyState sessionId={sessionId} />

  return (
    <div
      ref={viewportRef}
      className={cn('h-full min-h-0 w-full', !active && 'invisible pointer-events-none')}
      data-testid="embedded-powerpoint-viewport"
    />
  )
}

type PowerPointLaunchState = 'creating' | 'error' | 'idle' | 'ready'

function PowerPointLaunchEmptyState({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const creatingRef = useRef(false)
  const [state, setState] = useState<PowerPointLaunchState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const creating = state === 'creating'
  const ready = state === 'ready'
  let buttonKey: 'create' | 'creating' | 'ready' | 'retry' = 'create'
  if (state === 'creating') buttonKey = 'creating'
  else if (state === 'ready') buttonKey = 'ready'
  else if (state === 'error') buttonKey = 'retry'

  const createPowerPoint = () => {
    if (creatingRef.current) return
    creatingRef.current = true
    setErrorMessage('')
    setState('creating')
    void window.api.powerpoint.ensureSession(sessionId).then(
      () => setState('ready'),
      (error) => {
        rlog.warn('[embedded-powerpoint] create session failed', error)
        setErrorMessage(error instanceof Error ? error.message : String(error))
        setState('error')
      },
    ).finally(() => {
      creatingRef.current = false
    })
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-surface"
      data-testid="powerpoint-launch-empty-state"
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
        data-testid="powerpoint-empty-header"
      >
        <span className="flex text-[#D97706]">{Icons.presentation(16)}</span>
        <span className="text-sm font-semibold text-text-primary">
          {t('session.resourcePanel.presentation')}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-sm">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-app text-text-secondary">
            {Icons.presentation(20)}
          </div>
          <div className="mt-4 text-sm font-medium text-text-primary">
            {t('session.presentation.launchTitle')}
          </div>
          <div className="mt-1.5 text-xs leading-5 text-text-tertiary">
            {t('session.presentation.launchDetail')}
          </div>
          <button
            type="button"
            data-testid="powerpoint-create-session"
            disabled={creating || ready}
            onClick={createPowerPoint}
            className="mt-4 inline-flex h-8 min-w-24 items-center justify-center rounded-md bg-brand-blue px-3 text-xs font-medium text-white hover:opacity-90 disabled:cursor-default disabled:opacity-60"
          >
            {t(`session.presentation.launchButton.${buttonKey}`)}
          </button>
          {state === 'error' && (
            <div className="mt-2 text-xs text-red-500" role="alert">
              {t('session.presentation.launchFailed', { message: errorMessage })}
            </div>
          )}
          {(creating || ready) && (
            <div
              className="mt-2 text-xs text-text-tertiary"
              data-testid="powerpoint-create-status"
              role="status"
            >
              {creating
                ? t('session.presentation.syncCreating')
                : t('session.presentation.syncReady')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
