/**
 * A Session's spreadsheet or document workbench, presented in its own dock slot.
 *
 * The page itself is a native WebContentsView owned by the main process, for the
 * same reason the embedded browser is one: it has to keep running for a Session
 * nobody is looking at, so the agent can work in a workbook while the person
 * reads something else. This component therefore renders chrome and a viewport,
 * and hands the rectangle to Electron through the shared native-surface hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { WorkbenchKind } from '@shared/types'
import { activeEmbeddedBrowserSessionAtom } from '@/atoms/browser'
import { viewedSessionIdAtom } from '@/atoms/amphi'
import { Icons } from '@/components/amphi/Icons'
import { useNativeBrowserSurface } from '@/hooks/useNativeSurface'
import { rlog } from '@/lib/logger'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

type OpenState =
  | { status: 'idle' | 'ready' }
  | { status: 'error'; message: string }

export interface SessionWorkbenchPanelProps {
  kind: WorkbenchKind
  presentationVisible: boolean
  onPresentationHidden?: () => void
  onPresentationHideFailed?: () => void
}

export function SessionWorkbenchPanel({
  kind,
  presentationVisible,
  onPresentationHidden,
  onPresentationHideFailed,
}: SessionWorkbenchPanelProps) {
  const { t } = useTranslation()
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const browserSession = useAtomValue(activeEmbeddedBrowserSessionAtom)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<OpenState>({ status: 'idle' })
  const isOpen = browserSession?.workbenches.includes(kind) ?? false

  // Opening is what creates the native view; presenting it is a second step, so
  // that an agent-opened workbook does not steal the dock from the person.
  useEffect(() => {
    if (!sessionId || !presentationVisible) return
    let cancelled = false
    void (async () => {
      try {
        await window.api.workbench.ensure(sessionId, kind)
        await window.api.workbench.activate(sessionId, kind)
        if (!cancelled) setState({ status: 'ready' })
      } catch (error) {
        rlog.warn(`[workbench] could not open the ${kind} workbench`, error)
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [kind, presentationVisible, sessionId])

  const ready = state.status === 'ready' && isOpen
  useNativeBrowserSurface(
    viewportRef,
    sessionId,
    !(ready && presentationVisible),
    undefined,
    onPresentationHidden,
    onPresentationHideFailed,
  )

  const close = useCallback(() => {
    if (!sessionId) return
    setState({ status: 'idle' })
    void window.api.workbench.close(sessionId, kind).catch((error) => {
      rlog.warn(`[workbench] could not close the ${kind} workbench`, error)
    })
  }, [kind, sessionId])

  if (!sessionId) return null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-surface">
      <div
        className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-app px-3"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
      >
        <span className="flex h-5 items-center justify-center text-text-secondary">
          {kind === 'sheet' ? Icons.sheet(15) : Icons.document(15)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
          {t(`session.workbench.${kind}.title`)}
        </span>
        {isOpen ? (
          <button
            type="button"
            aria-label={t('session.workbench.close')}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
            data-testid={`session-workbench-${kind}-close`}
            onClick={close}
          >
            {Icons.x(14)}
          </button>
        ) : null}
      </div>

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 bg-white"
        data-testid={`session-workbench-${kind}-canvas`}
      >
        {!ready ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium text-text-primary">
              {t(`session.workbench.${kind}.title`)}
            </p>
            <p className="max-w-[280px] text-xs text-text-tertiary">
              {state.status === 'error' ? state.message : t(`session.workbench.${kind}.hint`)}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
