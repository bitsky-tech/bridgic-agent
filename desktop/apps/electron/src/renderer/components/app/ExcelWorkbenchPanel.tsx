import { useEffect, useMemo, useRef, useState } from 'react'
import { useNativeOfficeSurface, type NativeOfficeSurfacePolicy } from '@/hooks/useNativeOfficeSurface'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { ExcelHostConfig } from '@shared/types'
import {
  activeExcelHostSessionAtom,
  claimExcelWorkbookOpenRequestAtom,
  consumeExcelWorkbookOpenRequestAtom,
  excelExpandedAtom,
  pendingExcelWorkbookOpenRequestsAtom,
} from '@/atoms/excel'
import {
  browserSurfaceBlockedAtom,
  setNativeSurfaceRectAtom,
} from '@/atoms/browser'
import { viewedSessionIdAtom } from '@/atoms/navigation'
import { themeAtom } from '@/atoms/theme'
import { showToastAtom } from '@/atoms/toast'
import { Icons } from '@/components/amphi/Icons'
import { rlog } from '@/lib/logger'
import { OfficeAppHeader, OfficePanelControls } from './OfficeWorkbenchChrome'
import { useOfficeSessionRestore } from '@/hooks/useOfficeSessionRestore'
import { OfficeSessionLoading } from './OfficeSessionLoading'

const excelSurfacePolicy: NativeOfficeSurfacePolicy = {
  publishBoundsBeforeApply: true,
  deactivateOnDetach: true,
  onError: (error) => rlog.warn('[excel-host] native surface sync failed', error),
}

/** Main-window viewport for one Session-owned native Excel WebContentsView. */
export function ExcelWorkbenchPanel({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation()
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const hostSession = useAtomValue(activeExcelHostSessionAtom)
  const hasHostSession = hostSession !== null
  const pendingWorkbookOpenRequests = useAtomValue(pendingExcelWorkbookOpenRequestsAtom)
  const expanded = useAtomValue(excelExpandedAtom)
  const surfaceBlocked = useAtomValue(browserSurfaceBlockedAtom)
  const resolvedTheme = useAtomValue(themeAtom).resolved
  const setExpanded = useSetAtom(excelExpandedAtom)
  const consumeWorkbookOpenRequest = useSetAtom(consumeExcelWorkbookOpenRequestAtom)
  const claimWorkbookOpenRequest = useSetAtom(claimExcelWorkbookOpenRequestAtom)
  const showToast = useSetAtom(showToastAtom)
  const publishSurfaceRect = useSetAtom(setNativeSurfaceRectAtom)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hostError, setHostError] = useState<{ sessionId: string; message: string } | null>(null)
  const config = useMemo<ExcelHostConfig | null>(() => sessionId ? ({
    sessionId,
    locale: i18n.resolvedLanguage?.toLocaleLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
    theme: resolvedTheme === 'dark' ? 'dark' : 'light',
  }) : null, [i18n.resolvedLanguage, resolvedTheme, sessionId])
  const restoration = useOfficeSessionRestore('excel', sessionId, active, hasHostSession, () => window.api.excelHost.ensureSession(sessionId!, config!, false))

  const pendingWorkbookOpenRequest = pendingWorkbookOpenRequests.find(
    (request) => request.sessionId === sessionId,
  ) ?? null
  useEffect(() => {
    if (!active || !sessionId || !config || !pendingWorkbookOpenRequest) return
    const request = claimWorkbookOpenRequest(pendingWorkbookOpenRequest.requestId)
    if (!request) return
    const replaceInitialBlank = hostSession === null
    void window.api.excelHost.openWorkbook(sessionId, config, {
      path: request.path,
      replaceInitialBlank,
    }).catch((cause) => {
      rlog.warn('[excel-host] opening routed workbook failed', cause)
      showToast(t('error.cannotOpenFile'))
    }).finally(() => {
      consumeWorkbookOpenRequest(request.requestId)
    })
  }, [
    active,
    claimWorkbookOpenRequest,
    config,
    consumeWorkbookOpenRequest,
    hostSession,
    pendingWorkbookOpenRequest,
    sessionId,
    showToast,
    t,
  ])

  useEffect(() => {
    if (!active || !sessionId || !config || !hasHostSession) return
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
  }, [active, config, hasHostSession, sessionId])

  const nativeVisible = active
    && hostSession?.ready === true
    && !hostSession.crashed
    && !surfaceBlocked
  useNativeOfficeSurface({
    client: window.api.excelHost,
    policy: excelSurfacePolicy,
    viewportRef,
    sessionId: nativeVisible ? sessionId : null,
    publishBounds: publishSurfaceRect,
  })

  if (!sessionId || !config) return null
  if (!hostSession) return <OfficeSessionLoading failed={restoration.failed} onRetry={restoration.retry} />

  const error = hostError?.sessionId === sessionId ? hostError.message : null
  let status = t('excel.hostStarting')
  if (hostSession?.crashed) status = t('excel.hostCrashed')
  else if (error) status = t('excel.hostFailed')
  else if (hostSession?.ready) status = t('excel.hostReady')
  const showShellHeader = !nativeVisible || (hostSession.documentCount ?? 0) > 0

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid="excel-workbench">
      {showShellHeader ? (
        <OfficeAppHeader
          icon={Icons.spreadsheet(16)}
          iconClassName="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          subtitle={`${status} · ${sessionId.slice(0, 8).toUpperCase()}`}
          testId="excel-app-header"
          title="Excel"
        >
          <OfficePanelControls
            closeLabel={t('excel.closePanel')}
            expanded={expanded}
            expandLabel={expanded ? t('excel.exitExpanded') : t('excel.expand')}
            onClose={() => {
              void window.api.excelHost.closeSession(sessionId).catch((error) => {
                rlog.warn('[excel-host] panel close failed', error)
              })
            }}
            onToggleExpanded={() => setExpanded((value) => !value)}
            testIdPrefix="excel"
          />
        </OfficeAppHeader>
      ) : null}

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
