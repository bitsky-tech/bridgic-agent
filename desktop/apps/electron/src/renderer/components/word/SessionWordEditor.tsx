import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { WordFileOpenRequest } from '@/atoms/word'
import type { WordDocumentReadResult } from '@shared/types'
import {
  createEmptyWordWorkspace,
  createWordDomainStore,
  restoreWordWorkspace,
} from '@/lib/wordDomain'
import {
  createWordWorkspacePersister,
  loadPersistedWordWorkspace,
  type WordPersistenceStatus,
  type WordWorkspacePersister,
} from '@/lib/wordPersistence'
import { Icons } from '@/components/amphi/Icons'
import { Tooltip } from '@/components/amphi/Tooltip'
import { OfficeAppHeader } from '@/components/app/OfficeWorkbenchChrome'
import { rlog } from '@/lib/logger'
import { loadOfficeRecovery } from '@/lib/office/officePersistence'

const WordEditor = lazy(() => import('./WordEditor').then((module) => ({ default: module.WordEditor })))

interface PreparedWordFile {
  fileName: string
  html: string
  mtimeMs: number
  warnings: string[]
}

const pendingFileImports = new Map<string, Promise<PreparedWordFile>>()
const noop = () => undefined
const readWordDocument = (path: string) => window.api.word.readDocument(path)
export type WordWorkspaceFlush = () => Promise<void>

function prepareWordFile(request: WordFileOpenRequest, readDocument: (path: string) => Promise<WordDocumentReadResult>): Promise<PreparedWordFile> {
  const key = `${request.sessionId}:${request.id}`
  const pending = pendingFileImports.get(key)
  if (pending) return pending
  const task = Promise.all([
    readDocument(request.path),
    import('@/lib/wordDocxImport'),
  ]).then(async ([document, importer]) => ({
    fileName: document.fileName,
    mtimeMs: document.mtimeMs,
    ...await importer.importDocxToHtml(document.bytes),
  }))
  pendingFileImports.set(key, task)
  const clear = () => {
    if (pendingFileImports.get(key) === task) pendingFileImports.delete(key)
  }
  void task.then(clear, clear)
  return task
}

export interface SessionWordEditorProps {
  defaultTitle: string
  expanded: boolean
  onClose?: () => void
  onDocumentCountChange?: (sessionId: string, count: number) => void
  onOpenFileError?: (name: string, cause: unknown) => void
  onOpenFileRequestHandled?: (requestId: string, error?: string) => void
  onFlushHandlerChange?: (flush: WordWorkspaceFlush | null) => void
  onStateChange?: (state: { documentCount: number; persistenceStatus: WordPersistenceStatus }) => void
  onToggleExpanded?: () => void
  openFileRequest?: WordFileOpenRequest | null
  readDocument?: (path: string) => Promise<WordDocumentReadResult>
  sessionId: string
  showExpandControl?: boolean
}

/** One Session's Word frontend, reusable inside its dedicated Electron renderer target. */
export function SessionWordEditor({
  defaultTitle,
  expanded,
  onClose,
  onDocumentCountChange = noop,
  onOpenFileError = noop,
  onOpenFileRequestHandled = noop,
  onFlushHandlerChange = noop,
  onStateChange = noop,
  onToggleExpanded = noop,
  openFileRequest = null,
  readDocument = readWordDocument,
  sessionId,
  showExpandControl = true,
}: SessionWordEditorProps) {
  return (
    <SessionWordEditorInstance
      defaultTitle={defaultTitle}
      expanded={expanded}
      key={sessionId}
      onClose={onClose}
      onDocumentCountChange={onDocumentCountChange}
      onOpenFileError={onOpenFileError}
      onOpenFileRequestHandled={onOpenFileRequestHandled}
      onFlushHandlerChange={onFlushHandlerChange}
      onStateChange={onStateChange}
      onToggleExpanded={onToggleExpanded}
      openFileRequest={openFileRequest}
      readDocument={readDocument}
      sessionId={sessionId}
      showExpandControl={showExpandControl}
    />
  )
}

function SessionWordEditorInstance({
  defaultTitle,
  expanded,
  onClose,
  onDocumentCountChange,
  onOpenFileError,
  onOpenFileRequestHandled,
  onFlushHandlerChange,
  onStateChange,
  onToggleExpanded,
  openFileRequest,
  readDocument,
  sessionId,
  showExpandControl,
}: Required<Omit<SessionWordEditorProps, 'onClose'>> & Pick<SessionWordEditorProps, 'onClose'>) {
  const [persistenceStatus, setPersistenceStatus] = useState<WordPersistenceStatus>('saving')
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveryAttempt, setRecoveryAttempt] = useState(0)
  const persistenceStatusRef = useRef<WordPersistenceStatus>('saving')
  const [store, setStore] = useState<ReturnType<typeof createWordDomainStore> | null>(null)
  const persisterRef = useRef<WordWorkspacePersister | null>(null)
  const storeRef = useRef<ReturnType<typeof createWordDomainStore> | null>(null)
  const editorFlushRef = useRef<WordWorkspaceFlush | null>(null)
  const defaultTitleRef = useRef(defaultTitle)
  const recoveryErrorRef = useRef<string | null>(null)

  useLayoutEffect(() => { defaultTitleRef.current = defaultTitle }, [defaultTitle])
  const setEditorFlush = useCallback((flush: WordWorkspaceFlush | null) => { editorFlushRef.current = flush }, [])
  const flushWorkspace = useCallback(async () => {
    if (recoveryErrorRef.current) throw new Error(recoveryErrorRef.current)
    if (!persisterRef.current) throw new Error('The Word workspace is not ready.')
    await storeRef.current?.whenIdle()
    await editorFlushRef.current?.()
    await persisterRef.current.flush()
  }, [])

  useEffect(() => {
    let cancelled = false
    let ownedStore: ReturnType<typeof createWordDomainStore> | null = null
    let ownedPersister: WordWorkspacePersister | null = null
    void loadOfficeRecovery(async () => {
      const stored = await loadPersistedWordWorkspace(sessionId)
      return stored === null ? null : restoreWordWorkspace(stored, sessionId, defaultTitleRef.current)
    }).then((recovery) => {
      if (cancelled) return
      if (recovery.status === 'failed') {
        recoveryErrorRef.current = recovery.error.message
        setRecoveryError(recovery.error.message)
        persistenceStatusRef.current = 'error'
        setPersistenceStatus('error')
        return
      }
      const initial = recovery.status === 'empty'
        ? createEmptyWordWorkspace(sessionId)
        : recovery.value
      const persister = createWordWorkspacePersister(sessionId, (status) => {
        persistenceStatusRef.current = status
        setPersistenceStatus(status)
      })
      ownedPersister = persister
      persisterRef.current = persister
      ownedStore = createWordDomainStore(initial, {
        get defaultTitle() { return defaultTitleRef.current },
        onChange: persister.save,
      })
      storeRef.current = ownedStore
      setStore(ownedStore)
      persistenceStatusRef.current = 'saved'
      setPersistenceStatus('saved')
    })
    return () => {
      cancelled = true
      if (persisterRef.current === ownedPersister) persisterRef.current = null
      if (storeRef.current === ownedStore) storeRef.current = null
      // Child cleanup can still enqueue its final native snapshot before scheduling stops.
      queueMicrotask(() => { ownedPersister?.dispose(); ownedStore?.dispose() })
    }
  }, [recoveryAttempt, sessionId])

  useEffect(() => {
    if (!store && !recoveryError) return
    onFlushHandlerChange(flushWorkspace)
    return () => onFlushHandlerChange(null)
  }, [flushWorkspace, onFlushHandlerChange, recoveryError, store])

  useEffect(() => {
    if (recoveryError) {
      onStateChange({ documentCount: 0, persistenceStatus: 'error' })
      return
    }
    if (!store) return
    const publishState = () => onStateChange({ documentCount: store.getSnapshot().documents.length, persistenceStatus: persistenceStatusRef.current })
    publishState()
    return store.subscribe(publishState)
  }, [onStateChange, persistenceStatus, recoveryError, store])

  useEffect(() => {
    if (!store) return
    const previous = window.__bridgicWord
    window.__bridgicWord = store.api
    return () => {
      if (window.__bridgicWord !== store.api) return
      if (previous) window.__bridgicWord = previous
      else delete window.__bridgicWord
    }
  }, [store])

  useEffect(() => {
    if (!store) return
    let previousCount: number | undefined
    const publishDocumentCount = () => {
      const workspace = store.getSnapshot()
      const count = workspace.documents.length
      if (count === previousCount) return
      previousCount = count
      onDocumentCountChange(workspace.sessionId, count)
    }
    publishDocumentCount()
    return store.subscribe(publishDocumentCount)
  }, [onDocumentCountChange, store])

  useEffect(() => {
    if (!openFileRequest) return
    if (recoveryError) {
      onOpenFileRequestHandled(openFileRequest.id, recoveryError)
      return
    }
    if (!store) return
    let active = true
    void (async () => {
      let error: string | undefined
      try {
        if (openFileRequest.sessionId !== sessionId) throw new Error('The Word document request belongs to another Session.')
        await flushWorkspace()
        if (!active) return
        const prepared = await prepareWordFile(openFileRequest, readDocument)
        if (!active) return
        const existing = store.getSnapshot().documents.find((item) => item.sourcePath === openFileRequest.path)
        const result = await (existing?.sourceMtimeMs === prepared.mtimeMs
          ? store.dispatch({ type: 'document.activate', documentId: existing.id })
          : store.dispatch({
            type: 'document.open',
            html: prepared.html,
            sourceMtimeMs: prepared.mtimeMs,
            sourcePath: openFileRequest.path,
            title: prepared.fileName,
          }))
        if (!result.ok) throw new Error(result.error.message)
        if (prepared.warnings.length > 0) {
          rlog.warn('[word] document imported with conversion warnings', {
            name: prepared.fileName,
            warnings: prepared.warnings,
          })
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        if (active) onOpenFileError(openFileRequest.name, cause)
      } finally {
        if (active) onOpenFileRequestHandled(openFileRequest.id, error)
      }
    })()
    return () => { active = false }
  }, [flushWorkspace, onOpenFileError, onOpenFileRequestHandled, openFileRequest, readDocument, recoveryError, sessionId, store])

  if (recoveryError) return <WordRecoveryErrorState onRetry={() => {
    recoveryErrorRef.current = null
    setRecoveryError(null)
    persistenceStatusRef.current = 'saving'
    setPersistenceStatus('saving')
    setRecoveryAttempt((attempt) => attempt + 1)
  }} />

  if (!store) {
    return openFileRequest
      ? <WordFileOpeningState fileName={openFileRequest.name} />
      : <div className="h-full min-h-0 bg-bg-app" data-testid="word-workbench-loading" />
  }

  return <WordSessionSurface
    expanded={expanded}
    onClose={onClose}
    onSaveRequested={() => { void flushWorkspace().catch((error) => rlog.warn('[word] workspace flush failed', error)) }}
    onEditorFlushHandlerChange={setEditorFlush}
    onToggleExpanded={onToggleExpanded}
    persistenceStatus={persistenceStatus}
    showExpandControl={showExpandControl}
    store={store}
    openingFileName={openFileRequest?.name ?? null}
  />
}

function WordSessionSurface({ expanded, onClose, onEditorFlushHandlerChange, onSaveRequested, onToggleExpanded, openingFileName, persistenceStatus, showExpandControl, store }: {
  expanded: boolean
  onClose?: () => void
  onEditorFlushHandlerChange: (flush: WordWorkspaceFlush | null) => void
  onSaveRequested: () => void
  onToggleExpanded: () => void
  openingFileName: string | null
  persistenceStatus: WordPersistenceStatus
  showExpandControl: boolean
  store: ReturnType<typeof createWordDomainStore>
}) {
  const workspace = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  if (workspace.documents.length === 0) {
    return openingFileName
      ? <WordFileOpeningState fileName={openingFileName} />
      : <WordLaunchEmptyState onCreate={() => { void store.dispatch({ type: 'document.create' }) }} />
  }

  return (
    <Suspense fallback={<div className="h-full min-h-0 bg-bg-app" data-testid="word-core-loading" />}>
      <WordEditor
        expanded={expanded}
        onClose={onClose}
        onSaveRequested={onSaveRequested}
        onFlushHandlerChange={onEditorFlushHandlerChange}
        onToggleExpanded={onToggleExpanded}
        persistenceStatus={persistenceStatus}
        showExpandControl={showExpandControl}
        store={store}
      />
    </Suspense>
  )
}

function WordRecoveryErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid="word-recovery-error-state">
      <OfficeAppHeader icon={Icons.wordDocument(16)} iconClassName="bg-blue-500/10 text-blue-600 dark:text-blue-400" title="Word" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-sm">
          <div className="text-sm font-medium text-text-primary" role="alert">{t('word.recoveryFailed')}</div>
          <div className="mt-1.5 text-xs leading-5 text-text-tertiary">{t('word.recoveryFailedDescription')}</div>
          <button className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:opacity-90" data-testid="word-retry-recovery" onClick={onRetry} type="button">
            {t('word.retry')}
          </button>
        </div>
      </div>
    </section>
  )
}

function WordFileOpeningState({ fileName }: { fileName: string }) {
  const { t } = useTranslation()
  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid="word-file-opening-state">
      <OfficeAppHeader icon={Icons.wordDocument(16)} iconClassName="bg-blue-500/10 text-blue-600 dark:text-blue-400" title="Word" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div>
          <div aria-hidden="true" className="mx-auto size-6 animate-spin rounded-full border-2 border-blue-600/20 border-t-blue-600" />
          <div aria-live="polite" className="mt-3 max-w-72 truncate text-xs text-text-secondary" role="status">
            {t('word.openingFile', { name: fileName })}
          </div>
        </div>
      </div>
    </section>
  )
}

function WordLaunchEmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation()
  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid="word-launch-empty-state">
      <OfficeAppHeader icon={Icons.wordDocument(16)} iconClassName="bg-blue-500/10 text-blue-600 dark:text-blue-400" title="Word" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-sm">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-app text-blue-600">
            {Icons.wordDocument(20)}
          </div>
          <div className="mt-4 text-sm font-medium text-text-primary">{t('word.emptyTitle')}</div>
          <div className="mt-1.5 text-xs leading-5 text-text-tertiary">{t('word.emptyDescription')}</div>
          <Tooltip content={t('word.newDocument')} delayMs={0}>
            <button
              aria-label={t('word.newDocument')}
              className="mt-4 inline-flex h-8 min-w-24 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:opacity-90"
              data-testid="word-create-document"
              onClick={onCreate}
              type="button"
            >
              {Icons.plus(13)}
              {t('word.newDocument')}
            </button>
          </Tooltip>
        </div>
      </div>
    </section>
  )
}
