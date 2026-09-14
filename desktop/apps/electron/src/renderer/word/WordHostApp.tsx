import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'
import type { WordHostOpenRequest, WordHostPreloadAPI, WordHostRendererState } from '@shared/types'
import { resolveLocale } from '@shared/locale'
import { SessionWordEditor, type WordWorkspaceFlush } from '@/components/word/SessionWordEditor'
import { rlog } from '@/lib/logger'

/** Keep file imports and shutdown checkpoints ordered within the owning renderer. */
export function createWordHostRequestQueue({ api, flushWorkspace, onError, openDocument, sessionId }: {
  api: Pick<WordHostPreloadAPI, 'completeFlush' | 'completeOpenFile'>
  flushWorkspace: WordWorkspaceFlush
  onError: (error: unknown) => void
  openDocument: (request: WordHostOpenRequest) => Promise<void>
  sessionId: string
}) {
  let tail = Promise.resolve()
  const openRequests = new Set<string>()
  const flushRequests = new Set<string>()
  const enqueue = (operation: () => Promise<void>) => {
    tail = tail.then(operation).catch(onError)
    return tail
  }
  return {
    open(request: WordHostOpenRequest): Promise<void> {
      if (openRequests.has(request.id)) return tail
      openRequests.add(request.id)
      return enqueue(async () => {
        let error: string | undefined
        try {
          if (request.sessionId !== sessionId) throw new Error('The Word document request belongs to another Session.')
          await openDocument(request)
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
          onError(cause)
        }
        await api.completeOpenFile(request.id, error)
      })
    },
    flush(requestId: string): Promise<void> {
      if (flushRequests.has(requestId)) return tail
      flushRequests.add(requestId)
      return enqueue(async () => {
        let success = false
        try {
          await flushWorkspace()
          success = true
        } catch (error) {
          onError(error)
        }
        await api.completeFlush(requestId, success)
      })
    },
  }
}

const reportError = (error: unknown) => rlog.warn('[word-host] renderer operation failed', error)

/** A persistent Session editor with only the narrow Word preload capability. */
export function WordHostApp({ api, sessionId }: { api: WordHostPreloadAPI; sessionId: string }) {
  const { i18n, t } = useTranslation()
  const [settings, setSettings] = useState<GuiSettings>(DEFAULT_SETTINGS)
  const [expanded, setExpanded] = useState(false)
  const [openFileRequest, setOpenFileRequest] = useState<WordHostOpenRequest | null>(null)
  const activeImportRef = useRef<{ id: string; complete: (error?: string) => void } | null>(null)
  const flushRef = useRef<WordWorkspaceFlush | null>(null)
  const readyResolversRef = useRef<Array<() => void>>([])
  const mountedRef = useRef(false)
  const requestsRef = useRef<ReturnType<typeof createWordHostRequestQueue> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    if (!requestsRef.current) requestsRef.current = createWordHostRequestQueue({
      api,
      sessionId,
      onError: reportError,
      openDocument: (request) => new Promise<void>((resolve, reject) => {
        if (!mountedRef.current) { reject(new Error('The Word renderer is unavailable.')); return }
        activeImportRef.current = {
          id: request.id,
          complete: (error) => error ? reject(new Error(error)) : resolve(),
        }
        setOpenFileRequest(request)
      }),
      flushWorkspace: async () => {
        if (!flushRef.current) await new Promise<void>((resolve) => readyResolversRef.current.push(resolve))
        if (!mountedRef.current || !flushRef.current) throw new Error('The Word workspace is unavailable.')
        await flushRef.current()
      },
    })
    const requests = requestsRef.current
    let active = true
    let receivedConfig = false
    const unsubscribers = [
      api.onConfigChanged((next) => {
        if (!active) return
        receivedConfig = true
        setSettings(next)
      }),
      api.onExpandedChanged((event) => {
        if (active && event.sessionId === sessionId) setExpanded(event.expanded)
      }),
      api.onOpenFileRequested((request) => { if (active) void requests.open(request) }),
      api.onFlushRequested((id) => { if (active) void requests.flush(id) }),
    ]
    void api.getConfig().then((next) => {
      if (active && !receivedConfig) setSettings(next)
    }).catch((error) => { if (active) reportError(error) })
    return () => {
      active = false
      mountedRef.current = false
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [api, sessionId])

  useEffect(() => {
    const locale = resolveLocale(settings.locale, navigator.language)
    document.documentElement.lang = locale
    if (i18n.language !== locale) void i18n.changeLanguage(locale)
  }, [i18n, settings.locale])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const systemTheme = media.matches ? 'dark' : 'light'
      document.documentElement.dataset.theme = settings.theme.mode === 'system' ? systemTheme : settings.theme.mode
      document.documentElement.style.setProperty('--accent', settings.theme.accent)
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [settings.theme.accent, settings.theme.mode])

  const onFlushHandlerChange = useCallback((flush: WordWorkspaceFlush | null) => {
    flushRef.current = flush
    if (flush) readyResolversRef.current.splice(0).forEach((resolve) => resolve())
  }, [])
  const onOpenFileRequestHandled = useCallback((id: string, error?: string) => {
    const pending = activeImportRef.current
    if (pending?.id !== id) return
    activeImportRef.current = null
    setOpenFileRequest(null)
    pending.complete(error)
  }, [])
  const onStateChange = useCallback((state: WordHostRendererState) => {
    void api.reportState(state).catch(reportError)
  }, [api])

  return (
    <main className="h-screen w-screen overflow-hidden bg-bg-app">
      <SessionWordEditor
        defaultTitle={t('word.untitled')}
        expanded={expanded}
        onClose={() => { void api.requestHide().catch(reportError) }}
        onFlushHandlerChange={onFlushHandlerChange}
        onOpenFileRequestHandled={onOpenFileRequestHandled}
        onStateChange={onStateChange}
        onToggleExpanded={() => { void api.setExpanded(!expanded).catch(reportError) }}
        openFileRequest={openFileRequest}
        readDocument={api.readDocument}
        sessionId={sessionId}
      />
    </main>
  )
}
