import { useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { viewedSessionIdAtom } from '@/atoms/navigation'
import { browserSurfaceBlockedAtom, setNativeWordSurfaceRectAtom } from '@/atoms/browser'
import { activeWordHostSessionAtom, completeWordFileOpenAtom, wordFileOpenRequestAtom } from '@/atoms/word'
import { showToastAtom } from '@/atoms/toast'
import { Icons } from '@/components/amphi/Icons'
import { useNativeOfficeSurface, type NativeOfficeSurfacePolicy } from '@/hooks/useNativeOfficeSurface'
import { rlog } from '@/lib/logger'
import { OfficeAppHeader } from './OfficeWorkbenchChrome'

const surfacePolicy: NativeOfficeSurfacePolicy = {
  deactivateOnDetach: true,
  onError: (error) => rlog.warn('[word-host] native surface sync failed', error),
}
const openingRequests = new Map<string, Promise<void>>()

/** Main-window viewport only; the Session-owned child renderer owns all Word document state. */
export function WordWorkbenchPanel({ active = false }: { active?: boolean }) {
  const { t } = useTranslation()
  const store = useStore()
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const hostSession = useAtomValue(activeWordHostSessionAtom)
  const request = useAtomValue(wordFileOpenRequestAtom)
  const blocked = useAtomValue(browserSurfaceBlockedAtom)
  const publishBounds = useSetAtom(setNativeWordSurfaceRectAtom)
  const completeOpen = useSetAtom(completeWordFileOpenAtom)
  const showToast = useSetAtom(showToastAtom)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [failure, setFailure] = useState<{ sessionId: string; error: string } | null>(null)
  const [retryingSession, setRetryingSession] = useState<string | null>(null)
  const api = window.api.wordHost

  useEffect(() => {
    if (!active || !sessionId || !api) return
    let disposed = false
    void api.ensureSession(sessionId).then(() => {
      if (!disposed) setFailure((current) => current?.sessionId === sessionId ? null : current)
    }).catch((error: unknown) => {
      if (!disposed) setFailure({ sessionId, error: String(error) })
    })
    return () => { disposed = true }
  }, [active, api, sessionId])

  useEffect(() => {
    if (!request || !api) return
    let operation = openingRequests.get(request.id)
    if (!operation) {
      operation = api.openFile(request.sessionId, request)
      openingRequests.set(request.id, operation)
      void operation.finally(() => openingRequests.delete(request.id)).catch(() => undefined)
    }
    let subscribed = true
    void operation.catch((error: unknown) => {
      rlog.warn('[word-host] document import failed', { name: request.name, error })
      if (subscribed && store.get(viewedSessionIdAtom) === request.sessionId) {
        showToast(t('word.fileOpenFailed', { name: request.name }))
      }
    }).finally(() => {
      completeOpen({ sessionId: request.sessionId, requestId: request.id })
    })
    return () => { subscribed = false }
  }, [api, completeOpen, request, showToast, store, t])

  useNativeOfficeSurface({
    client: api,
    policy: surfacePolicy,
    viewportRef,
    sessionId: active && !blocked && hostSession && !hostSession.crashed ? sessionId : null,
    surfaceKey: hostSession ? `${hostSession.sessionId}:${hostSession.targetId}:${hostSession.crashed}` : null,
    publishBounds,
  })

  if (!sessionId) return null
  const failed = failure?.sessionId === sessionId || hostSession?.crashed === true
  const retrying = retryingSession === sessionId
  const retry = async () => {
    if (retrying || !api) return
    setRetryingSession(sessionId)
    setFailure(null)
    try {
      await api.closeSession(sessionId)
      await api.ensureSession(sessionId)
    } catch (error) {
      setFailure({ sessionId, error: String(error) })
    } finally {
      setRetryingSession((current) => current === sessionId ? null : current)
    }
  }
  return (
    <div className="h-full min-h-0 w-full bg-bg-app" data-testid="word-native-viewport" ref={viewportRef}>
      {(!hostSession || failed) && (
        <section className="flex h-full flex-col bg-bg-surface" data-testid="word-host-status">
          <OfficeAppHeader icon={Icons.wordDocument(16)} iconClassName="bg-blue-500/10 text-blue-600 dark:text-blue-400" title="Word" />
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-xs text-text-secondary" role={failed ? 'alert' : 'status'}>
            {t(failed ? 'word.hostFailed' : 'word.hostLoading')}
            {failed && <button className="rounded-md bg-brand-blue px-3 py-2 text-white disabled:opacity-50" data-testid="word-host-retry" disabled={retrying} onClick={() => { void retry() }} type="button">{t('word.retry')}</button>}
          </div>
        </section>
      )}
    </div>
  )
}
