import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { WordFileOpenRequest } from '@/atoms/word'
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
import { SESSION_STATUS_BAR_HEIGHT_PX } from '@/components/app/SessionStatusBar'
import { rlog } from '@/lib/logger'

const WordEditor = lazy(() => import('./WordEditor').then((module) => ({ default: module.WordEditor })))

interface PreparedWordFile {
  fileName: string
  html: string
  mtimeMs: number
  warnings: string[]
}

const pendingFileImports = new Map<string, Promise<PreparedWordFile>>()

function prepareWordFile(request: WordFileOpenRequest): Promise<PreparedWordFile> {
  const pending = pendingFileImports.get(request.id)
  if (pending) return pending
  const task = Promise.all([
    window.api.word.readDocument(request.path),
    import('@/lib/wordDocxImport'),
  ]).then(async ([document, importer]) => ({
    fileName: document.fileName,
    mtimeMs: document.mtimeMs,
    ...await importer.importDocxToHtml(document.bytes),
  }))
  pendingFileImports.set(request.id, task)
  const clear = () => {
    if (pendingFileImports.get(request.id) === task) pendingFileImports.delete(request.id)
  }
  void task.then(clear, clear)
  return task
}

export interface SessionWordEditorProps {
  defaultTitle: string
  expanded: boolean
  onOpenFileError?: (name: string, cause: unknown) => void
  onOpenFileRequestHandled?: (requestId: string) => void
  onToggleExpanded?: () => void
  openFileRequest?: WordFileOpenRequest | null
  sessionId: string
  showExpandControl?: boolean
}

/** One Session's Word frontend, reusable inside its dedicated Electron renderer target. */
export function SessionWordEditor({
  defaultTitle,
  expanded,
  onOpenFileError = () => undefined,
  onOpenFileRequestHandled = () => undefined,
  onToggleExpanded = () => undefined,
  openFileRequest = null,
  sessionId,
  showExpandControl = true,
}: SessionWordEditorProps) {
  return (
    <SessionWordEditorInstance
      defaultTitle={defaultTitle}
      expanded={expanded}
      key={sessionId}
      onOpenFileError={onOpenFileError}
      onOpenFileRequestHandled={onOpenFileRequestHandled}
      onToggleExpanded={onToggleExpanded}
      openFileRequest={openFileRequest}
      sessionId={sessionId}
      showExpandControl={showExpandControl}
    />
  )
}

function SessionWordEditorInstance({
  defaultTitle,
  expanded,
  onOpenFileError,
  onOpenFileRequestHandled,
  onToggleExpanded,
  openFileRequest,
  sessionId,
  showExpandControl,
}: Required<SessionWordEditorProps>) {
  const [persistenceStatus, setPersistenceStatus] = useState<WordPersistenceStatus>('saving')
  const [store, setStore] = useState<ReturnType<typeof createWordDomainStore> | null>(null)
  const persisterRef = useRef<WordWorkspacePersister | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadPersistedWordWorkspace(sessionId).then((stored) => {
      if (cancelled) return
      const initial = stored === null
        ? createEmptyWordWorkspace(sessionId)
        : restoreWordWorkspace(stored, sessionId, defaultTitle)
      const persister = createWordWorkspacePersister(setPersistenceStatus)
      persisterRef.current = persister
      setStore(createWordDomainStore(initial, {
        defaultTitle,
        onChange: persister.save,
      }))
      setPersistenceStatus('saved')
    })
    return () => {
      cancelled = true
      persisterRef.current?.dispose()
      persisterRef.current = null
    }
  }, [defaultTitle, sessionId])

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
    if (!store || !openFileRequest) return
    let active = true
    void (async () => {
      try {
        const prepared = await prepareWordFile(openFileRequest)
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
        if (active) onOpenFileError(openFileRequest.name, cause)
      } finally {
        if (active) onOpenFileRequestHandled(openFileRequest.id)
      }
    })()
    return () => { active = false }
  }, [onOpenFileError, onOpenFileRequestHandled, openFileRequest, store])

  if (!store) {
    return openFileRequest
      ? <WordFileOpeningState fileName={openFileRequest.name} />
      : <div className="h-full min-h-0 bg-bg-app" data-testid="word-workbench-loading" />
  }

  return <WordSessionSurface
    expanded={expanded}
    onSaveRequested={() => persisterRef.current?.flush()}
    onToggleExpanded={onToggleExpanded}
    persistenceStatus={persistenceStatus}
    showExpandControl={showExpandControl}
    store={store}
    openingFileName={openFileRequest?.name ?? null}
  />
}

function WordSessionSurface({ expanded, onSaveRequested, onToggleExpanded, openingFileName, persistenceStatus, showExpandControl, store }: {
  expanded: boolean
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
        onSaveRequested={onSaveRequested}
        onToggleExpanded={onToggleExpanded}
        persistenceStatus={persistenceStatus}
        showExpandControl={showExpandControl}
        store={store}
      />
    </Suspense>
  )
}

function WordFileOpeningState({ fileName }: { fileName: string }) {
  const { t } = useTranslation()
  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid="word-file-opening-state">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4" style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}>
        <span className="flex text-blue-600">{Icons.wordDocument(16)}</span>
        <span className="text-sm font-semibold text-text-primary">Word</span>
      </header>
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
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4" style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}>
        <span className="flex text-blue-600">{Icons.wordDocument(16)}</span>
        <span className="text-sm font-semibold text-text-primary">Word</span>
      </header>
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
