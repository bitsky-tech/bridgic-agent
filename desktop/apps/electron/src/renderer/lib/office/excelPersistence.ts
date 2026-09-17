import type { OfficeFilesAPI } from '../../../shared/office-files'
import type { ExcelHostPreloadAPI, ExcelSaveResult } from '../../../shared/types'
import type { ExcelWorkspaceTab } from './excelWorkspace'
import {
  createOfficePersistenceScheduler,
  loadOfficeRecovery,
  OfficePersistenceError,
  runOfficePersistenceOperation,
  type OfficePersistenceSnapshot,
} from './officePersistence'
import { OfficeOperationError } from './officeWorkspaceRuntime'

export interface ExcelRecoveryState<TSnapshot> {
  version: 1
  tabs: ExcelWorkspaceTab<TSnapshot>[]
  activeTabId: string | null
  nextWorkbookOrdinal: number
}

function recoveryState<TSnapshot>(value: unknown): ExcelRecoveryState<TSnapshot> | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OfficePersistenceError('invalid_recovery', 'The Excel recovery state is invalid.')
  }
  const candidate = value as Partial<ExcelRecoveryState<TSnapshot>>
  if (candidate.version !== 1 || !Array.isArray(candidate.tabs) || !candidate.tabs.every((tab) => tab
    && typeof tab === 'object'
    && typeof tab.tabId === 'string'
    && typeof tab.fileName === 'string'
    && tab.snapshot
    && typeof tab.snapshot === 'object')) {
    throw new OfficePersistenceError('invalid_recovery', 'The Excel recovery state is invalid.')
  }
  return {
    version: 1,
    tabs: candidate.tabs,
    activeTabId: typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null,
    nextWorkbookOrdinal: Number.isInteger(candidate.nextWorkbookOrdinal)
      ? Math.max(1, candidate.nextWorkbookOrdinal!)
      : candidate.tabs.length + 1,
  }
}

/** Private recovery survives renderer reload, Session release and application restart. */
export function createExcelRecoveryPersistence<TSnapshot>(options: {
  sessionId: string
  files?: OfficeFilesAPI
  api: Pick<ExcelHostPreloadAPI, 'getRecoveryState' | 'setRecoveryState'>
  onStatusChange?: (state: OfficePersistenceSnapshot) => void
}) {
  let ready = false
  let disposed = false
  let restoring: ReturnType<typeof loadOfficeRecovery<ExcelRecoveryState<TSnapshot>>> | null = null
  const scheduler = createOfficePersistenceScheduler<ExcelRecoveryState<TSnapshot>>({
    policy: {
      appKind: 'excel',
      sessionId: options.sessionId,
      kind: 'recovery',
      storage: options.files ? 'recovery-file' : 'session-memory',
      automatic: true,
    },
    delayMs: 250,
    // Serialize BEFORE contextBridge. Passing the nested cell graph directly
    // makes Electron recursively proxy/freeze millions of objects on the UI thread.
    write: (value) => options.files ? options.files.setRecovery('excel', options.sessionId, JSON.stringify(value)) : options.api.setRecoveryState(JSON.stringify(value)),
    onStatusChange: options.onStatusChange,
  })

  return {
    getSnapshot: scheduler.getSnapshot,
    subscribe: scheduler.subscribe,
    restore() {
      if (restoring) return restoring
      ready = false
      restoring = loadOfficeRecovery(async () => {
        if (disposed) throw new OfficePersistenceError('persistence_disposed', 'The Excel recovery controller is unavailable.')
        const stored = options.files ? await options.files.getRecovery('excel', options.sessionId) : await options.api.getRecoveryState()
        if (disposed) throw new OfficePersistenceError('persistence_disposed', 'The Excel recovery controller is unavailable.')
        return recoveryState<TSnapshot>(stored === null ? null : JSON.parse(stored))
      }).then((result) => {
        if (disposed) {
          return {
            status: 'failed' as const,
            error: { code: 'persistence_disposed', message: 'The Excel recovery controller is unavailable.' },
          }
        }
        ready = !disposed && result.status !== 'failed'
        return result
      }).finally(() => { restoring = null })
      return restoring
    },
    schedule(value: ExcelRecoveryState<TSnapshot>) {
      // Never overwrite an unreadable checkpoint with the default blank workbook.
      return ready && !disposed && scheduler.schedule(value)
    },
    flush() {
      if (!ready || disposed) {
        return Promise.reject(new OfficePersistenceError('recovery_unavailable', 'The Excel workspace must be restored before updating its recovery state.'))
      }
      return scheduler.flush()
    },
    dispose() {
      disposed = true
      scheduler.dispose()
    },
  }
}

/** Explicit source writes keep cancellation and conflict distinct from recovery acknowledgements. */
export function writeExcelWorkbookSource(options: {
  files?: OfficeFilesAPI
  api: Pick<ExcelHostPreloadAPI, 'save' | 'saveAs'>
  tab: Pick<ExcelWorkspaceTab<unknown>, 'documentId' | 'fileName' | 'mtimeMs' | 'source'> & { tabId?: string }
  saveAs: boolean
  destination?: string
  conflictMessage: string
  preserveSource?: boolean
  protectedSourceMessage?: string
  prepare: () => Promise<Uint8Array | null>
  assertCurrent: () => void
}) {
  const { api, saveAs, prepare, assertCurrent, conflictMessage } = options
  const tab = { ...options.tab }
  return runOfficePersistenceOperation<Extract<ExcelSaveResult, { ok: true }>>(async () => {
    try {
      const bytes = await prepare()
      if (bytes === null) return { status: 'canceled' }
      assertCurrent()
      if (options.files && (options.files.prepare || tab.source || !tab.documentId || saveAs)) {
        const result = await options.files.save({ kind: 'excel', managed: Boolean(options.files.prepare), documentId: tab.tabId, source: tab.source, preserveSource: options.preserveSource, saveAs, destination: options.destination, bytes, suggestedName: tab.fileName })
        if (!result.ok && result.reason === 'source-protected') throw new OfficePersistenceError('source_protected', options.protectedSourceMessage ?? 'Choose a different file name to preserve the original workbook.')
        if (!result.ok) return result.reason === 'conflict' ? { status: 'conflict', message: conflictMessage } : { status: 'canceled' }
        return { status: 'written', value: { ok: true, documentId: options.files.prepare ? result.source.path : tab.documentId ?? result.source.path, fileName: result.fileName, mtimeMs: result.source.mtimeMs!, source: result.source } }
      }
      const result = saveAs || !tab.documentId || tab.mtimeMs === null
        ? await api.saveAs({ bytes, suggestedName: tab.fileName })
        : await api.save({ documentId: tab.documentId, bytes, expectedMtimeMs: tab.mtimeMs })
      if (!result.ok) {
        return result.reason === 'conflict'
          ? { status: 'conflict', message: conflictMessage }
          : { status: 'canceled' }
      }
      assertCurrent()
      return { status: 'written', value: result }
    } catch (error) {
      if (error instanceof OfficeOperationError) throw new OfficePersistenceError(error.code, error.message)
      throw error
    }
  })
}
