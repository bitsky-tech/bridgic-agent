import { viewedSessionIdAtom } from '@/atoms/navigation'
import { browserSurfaceBlockedAtom, setNativePowerPointSurfaceRectAtom } from '@/atoms/browser'
import { activeEmbeddedPowerPointSessionAtom, powerPointFileOpeningAtom } from '@/atoms/powerpoint'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { useAtomValue, useSetAtom } from 'jotai'
import { useRef } from 'react'
import { useNativeOfficeSurface, type NativeOfficeSurfacePolicy } from '@/hooks/useNativeOfficeSurface'
import { useTranslation } from 'react-i18next'
import { useOfficeSessionRestore } from '@/hooks/useOfficeSessionRestore'
import { OfficeSessionLoading } from './OfficeSessionLoading'

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
  const { t } = useTranslation()
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const powerPointSession = useAtomValue(activeEmbeddedPowerPointSessionAtom)
  const openingFile = useAtomValue(powerPointFileOpeningAtom)
  const powerPointSurfaceKey = powerPointSession
    ? `${powerPointSession.sessionId}:${powerPointSession.targetId ?? ''}:${powerPointSession.crashed}`
    : null
  const surfaceBlocked = useAtomValue(browserSurfaceBlockedAtom)
  const publishSurfaceRect = useSetAtom(setNativePowerPointSurfaceRectAtom)
  const viewportRef = useRef<HTMLDivElement>(null)
  const restoration = useOfficeSessionRestore('presentation', sessionId, active, powerPointSession !== null, () => window.api.powerpoint.ensureSession(sessionId!))

  useNativeOfficeSurface({
    client: window.api.powerpoint,
    policy: powerPointSurfacePolicy,
    viewportRef,
    sessionId: active && !openingFile && !surfaceBlocked && powerPointSurfaceKey ? sessionId : null,
    surfaceKey: powerPointSurfaceKey,
    publishBounds: publishSurfaceRect,
  })

  if (!sessionId) return null
  if (!powerPointSession && !openingFile) return <OfficeSessionLoading failed={restoration.failed} onRetry={restoration.retry} />

  return (
    <div
      ref={viewportRef}
      className={cn('h-full min-h-0 w-full', !active && 'invisible pointer-events-none')}
      data-testid="embedded-powerpoint-viewport"
    >
      {openingFile ? (
        <div className="flex h-full items-center justify-center text-xs text-text-secondary" role="status">
          {t('session.presentation.importing')}
        </div>
      ) : null}
    </div>
  )
}
