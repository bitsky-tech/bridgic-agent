import { officeFiles } from '@/lib/office/officeFileClient'
import { i18n } from '@/lib/i18n'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { WordFileOpenRequest } from '@/atoms/word'
import type { WordDocumentReadResult } from '@shared/types'
import {
  createEmptyWordWorkspace,
  createWordDomainStore,
  restoreWordWorkspace,
  isWordDocumentDirty,
} from '@/lib/wordDomain'
import {
  createWordWorkspacePersister,
  loadPersistedWordWorkspace,
  type WordPersistenceStatus,
  type WordWorkspacePersister,
} from '@/lib/wordPersistence'
import { Icons } from '@/components/amphi/Icons'
import { OfficeLaunchEmptyState } from '@/components/app/OfficeLaunchEmptyState'
import { OfficeAppHeader } from '@/components/app/OfficeWorkbenchChrome'
import { rlog } from '@/lib/logger'
import { loadOfficeRecovery } from '@/lib/office/officePersistence'
import { createOfficeAutoSave } from '@/lib/office/officeAutoSave'

const WordEditor = lazy(() => import('./WordEditor').then((module) => ({ default: module.WordEditor })))

interface PreparedWordFile {
  path: string
  fileName: string
  html: string
  mtimeMs: number
  warnings: string[]
  document?: import('@/lib/wordDocxImport').WordFileDocument
  sourceProtected?: boolean
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
    window.officeFiles?.prepare
      ? window.officeFiles.prepare('word', request.path).then((source) => readDocument(source.path))
      : readDocument(request.path),
    import('@/lib/wordImport'),
  ]).then(async ([document, importer]) => ({
    path: document.path ?? request.path,
    fileName: document.fileName,
    mtimeMs: document.mtimeMs,
    ...await importer.importDocxInBackground(document.bytes),
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
  onOpenDocument?: () => unknown | Promise<unknown>
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
  onOpenDocument = noop,
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
      onOpenDocument={onOpenDocument}
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
  onOpenDocument,
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
  const [openFileFailed, setOpenFileFailed] = useState(false)
  const persistenceStatusRef = useRef<WordPersistenceStatus>('saving')
  const [store, setStore] = useState<ReturnType<typeof createWordDomainStore> | null>(null)
  const persisterRef = useRef<WordWorkspacePersister | null>(null)
  const storeRef = useRef<ReturnType<typeof createWordDomainStore> | null>(null)
  const editorFlushRef = useRef<WordWorkspaceFlush | null>(null)
  const defaultTitleRef = useRef(defaultTitle)
  const recoveryErrorRef = useRef<string | null>(null)
  const autoSaveRef = useRef<ReturnType<typeof createOfficeAutoSave> | null>(null)

  useLayoutEffect(() => { defaultTitleRef.current = defaultTitle }, [defaultTitle])
  const setEditorFlush = useCallback((flush: WordWorkspaceFlush | null) => { editorFlushRef.current = flush }, [])
  const openDocument = useCallback(() => {
    setOpenFileFailed(false)
    return onOpenDocument()
  }, [onOpenDocument])
  const flushWorkspace = useCallback(async () => {
    if (recoveryErrorRef.current) throw new Error(recoveryErrorRef.current)
    if (!persisterRef.current) throw new Error('The Word workspace is not ready.')
    await storeRef.current?.whenIdle()
    if (storeRef.current?.getSnapshot().documents.length) await editorFlushRef.current?.()
    await autoSaveRef.current?.flush()
    await persisterRef.current.flush()
  }, [])

  useEffect(() => {
    let cancelled = false
    let ownedStore: ReturnType<typeof createWordDomainStore> | null = null
    let ownedPersister: WordWorkspacePersister | null = null
    let autoSave: ReturnType<typeof createOfficeAutoSave> | null = null
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
      let recoveryStatus: WordPersistenceStatus = 'saved'
      let sourceStatus: WordPersistenceStatus = 'saved'
      const publishStatus = () => {
        let status: WordPersistenceStatus = 'saved'
        if (recoveryStatus === 'saving' || sourceStatus === 'saving') status = 'saving'
        if (recoveryStatus === 'error' || sourceStatus === 'error') status = 'error'
        persistenceStatusRef.current = status
        setPersistenceStatus(status)
      }
      const persister = createWordWorkspacePersister(sessionId, (status) => {
        recoveryStatus = status
        publishStatus()
      })
      ownedPersister = persister
      persisterRef.current = persister
      ownedStore = createWordDomainStore(initial, {
        get defaultTitle() { return defaultTitleRef.current },
        autoSave: Boolean(window.officeFiles?.prepare),
        onChange: (state) => {
          persister.save(state)
          autoSave?.schedule(state.documents.filter(isWordDocumentDirty).map((document) => `${document.id}:${document.contentVersion ?? 0}`).join('|'))
        },
        ...(window.officeFiles ? {
          confirmClose: (title: string) => officeFiles().confirmClose(title, i18n.language),
          saveDocument: async (document: import('@/lib/wordDomain').WordDocumentState, saveAs: boolean, destination?: string) => {
            if (document.sourceProtected && !saveAs && !window.officeFiles?.prepare) throw new Error(i18n.t('office.protectedSave'))
            const { exportWordDocx } = await import('@/lib/wordDocxExport')
            const result = await officeFiles().save({ kind: 'word', managed: Boolean(window.officeFiles?.prepare), documentId: document.id, saveAs, destination, preserveSource: document.sourceProtected, suggestedName: document.title.toLowerCase().endsWith('.docx') ? document.title : `${document.title}.docx`, source: document.sourcePath ? { path: document.sourcePath, mtimeMs: document.sourceMtimeMs ?? null } : undefined, bytes: await exportWordDocx(document) })
            if (!result.ok && result.reason === 'source-protected') throw new Error(i18n.t('office.protectedSave'))
            return result
          },
        } : {}),
      })
      storeRef.current = ownedStore
      if (window.officeFiles?.prepare) {
        const domain = ownedStore
        autoSave = createOfficeAutoSave(async () => {
          for (const document of domain.getSnapshot().documents.filter(isWordDocumentDirty)) {
            const result = await domain.dispatch({ type: 'document.save', documentId: document.id })
            if (!result.ok && result.error.code !== 'save_incomplete') throw new Error(result.error.message)
          }
        }, (status) => { sourceStatus = status; publishStatus() })
        autoSaveRef.current = autoSave
        autoSave.schedule(initial.documents.filter(isWordDocumentDirty).map((document) => `${document.id}:${document.contentVersion ?? 0}`).join('|'))
      }
      setStore(ownedStore)
      publishStatus()
    })
    return () => {
      cancelled = true
      if (persisterRef.current === ownedPersister) persisterRef.current = null
      if (storeRef.current === ownedStore) storeRef.current = null
      if (autoSaveRef.current === autoSave) autoSaveRef.current = null
      autoSave?.dispose()
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
        const beforeImport = store.getSnapshot()
        const revisions = store.api.workspace.getSnapshot().documents
        const prepared = await prepareWordFile(openFileRequest, readDocument)
        if (!active) return
        const existing = store.getSnapshot().documents.find((item) => item.sourcePath === prepared.path)
        const previous = beforeImport.documents.find((item) => item.id === existing?.id && item.sourcePath === prepared.path)
        let result = await (existing && (!previous || existing.sourceMtimeMs === prepared.mtimeMs)
          ? store.dispatch({ type: 'document.activate', documentId: existing.id })
          : store.dispatch({
            type: 'document.open',
            documentId: existing?.id,
            expectedDocumentRevision: revisions.find((item) => item.id === existing?.id)?.revision,
            html: prepared.html,
            document: prepared.document,
            sourceProtected: prepared.sourceProtected,
            sourceMtimeMs: prepared.mtimeMs,
            sourcePath: prepared.path,
            title: prepared.fileName,
          }))
        // Parsing and queued native flushes must never replace a newer live document.
        if (!result.ok && result.error.code === 'revision_conflict' && existing
          && store.getSnapshot().documents.some((item) => item.id === existing.id && item.sourcePath === prepared.path)) {
          result = await store.dispatch({ type: 'document.activate', documentId: existing.id })
        }
        if (!result.ok) throw new Error(result.error.message)
        if (active) setOpenFileFailed(false)
        if (prepared.warnings.length > 0) {
          rlog.warn('[word] document imported with conversion warnings', {
            name: prepared.fileName,
            warnings: prepared.warnings,
          })
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        if (active) {
          setOpenFileFailed(true)
          onOpenFileError(openFileRequest.name, cause)
        }
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
    onClose={onClose ? () => {
      void store.closeAllDocuments().then(async (result) => {
        if (!result.ok) return
        await flushWorkspace()
        onClose()
      }).catch((error) => rlog.warn('[word] close failed', error))
    } : undefined}
    onSaveRequested={flushWorkspace}
    onOpenDocument={openDocument}
    openFileFailed={openFileFailed}
    onEditorFlushHandlerChange={setEditorFlush}
    onToggleExpanded={onToggleExpanded}
    persistenceStatus={persistenceStatus}
    showExpandControl={showExpandControl}
    store={store}
    openingFileName={openFileRequest?.name ?? null}
  />
}

function WordSessionSurface({ expanded, onClose, onEditorFlushHandlerChange, onOpenDocument, onSaveRequested, onToggleExpanded, openFileFailed, openingFileName, persistenceStatus, showExpandControl, store }: {
  expanded: boolean
  onClose?: () => void
  onEditorFlushHandlerChange: (flush: WordWorkspaceFlush | null) => void
  onOpenDocument: () => unknown | Promise<unknown>
  onSaveRequested: () => Promise<void>
  onToggleExpanded: () => void
  openFileFailed: boolean
  openingFileName: string | null
  persistenceStatus: WordPersistenceStatus
  showExpandControl: boolean
  store: ReturnType<typeof createWordDomainStore>
}) {
  const workspace = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  if (workspace.documents.length === 0) {
    return openingFileName
      ? <WordFileOpeningState fileName={openingFileName} />
      : <OfficeLaunchEmptyState failure={openFileFailed ? 'open' : null} kind="word" onCreate={() => store.dispatch({ type: 'document.create' })} onOpen={onOpenDocument} />
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
