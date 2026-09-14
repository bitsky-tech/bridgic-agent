import { viewedSessionIdAtom } from '@/atoms/navigation'
import { browserSurfaceBlockedAtom, setNativePowerPointSurfaceRectAtom } from '@/atoms/browser'
import { activeEmbeddedPowerPointSessionAtom } from '@/atoms/powerpoint'
import { Icons } from '@/components/amphi/Icons'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { useAtomValue, useSetAtom } from 'jotai'
import { useRef, useState } from 'react'
import { useNativeOfficeSurface, type NativeOfficeSurfacePolicy } from '@/hooks/useNativeOfficeSurface'
import { useTranslation } from 'react-i18next'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

export interface EmbeddedPowerPointPanelProps {
  active: boolean
}

const powerPointSurfacePolicy: NativeOfficeSurfacePolicy = {
  prepareSession: (sessionId) => window.api.powerpoint.ensureSession(sessionId),
  initialSync: 'animation-frame',
  focusHostOnDetach: true,
  clearBoundsAfterDetach: true,
  onError: (error) => rlog.warn('[embedded-powerpoint] native surface sync failed', error),
}

/** Renderer placeholder whose rectangle is occupied by the native Session PPT view. */
export function EmbeddedPowerPointPanel({ active }: EmbeddedPowerPointPanelProps) {
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const powerPointSession = useAtomValue(activeEmbeddedPowerPointSessionAtom)
  const powerPointSurfaceKey = powerPointSession
    ? `${powerPointSession.sessionId}:${powerPointSession.targetId ?? ''}:${powerPointSession.crashed}`
    : null
  const surfaceBlocked = useAtomValue(browserSurfaceBlockedAtom)
  const publishSurfaceRect = useSetAtom(setNativePowerPointSurfaceRectAtom)
  const viewportRef = useRef<HTMLDivElement>(null)

  useNativeOfficeSurface({
    client: window.api.powerpoint,
    policy: powerPointSurfacePolicy,
    viewportRef,
    sessionId: active && !surfaceBlocked && powerPointSurfaceKey ? sessionId : null,
    surfaceKey: powerPointSurfaceKey,
    publishBounds: publishSurfaceRect,
  })

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
