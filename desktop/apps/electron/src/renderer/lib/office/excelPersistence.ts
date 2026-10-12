import type { OfficeFilesAPI } from '../../../shared/office-files'
import type { ExcelHostPreloadAPI, ExcelSaveResult } from '../../../shared/types'
import type { ExcelWorkspaceTab } from './excelWorkspace'
import {
  loadOfficeRecovery,
  OfficePersistenceError,
  runOfficePersistenceOperation,
  type OfficePersistenceSnapshot,
} from './officePersistence'
import { OfficeOperationError } from './officeWorkspaceRuntime'
import { createIndexedDbWorkspacePersistence, type WorkspacePersistence } from './workspacePersistence'

export interface ExcelWorkspaceState<TSnapshot> {
  schemaVersion: 1
  tabs: ExcelWorkspaceTab<TSnapshot>[]
  activeTabId: string | null
  nextWorkbookOrdinal: number
}

function readExcelWorkspace<TSnapshot>(value: unknown): ExcelWorkspaceState<TSnapshot> | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OfficePersistenceError('invalid_recovery', 'The Excel recovery state is invalid.')
  }
  const candidate = value as Partial<ExcelWorkspaceState<TSnapshot>>
  if (candidate.schemaVersion !== 1
    || !Array.isArray(candidate.tabs) || !candidate.tabs.every((tab) => tab
    && typeof tab === 'object'
    && typeof tab.tabId === 'string'
    && typeof tab.fileName === 'string'
    && tab.snapshot
    && typeof tab.snapshot === 'object'
    && (tab.source === undefined || (tab.source && typeof tab.source === 'object'
      && typeof tab.source.path === 'string' && Boolean(tab.source.path)
      && (tab.source.mtimeMs === null || (Number.isFinite(tab.source.mtimeMs) && tab.source.mtimeMs >= 0)))))
    || (candidate.activeTabId !== null && typeof candidate.activeTabId !== 'string')
    || !Number.isInteger(candidate.nextWorkbookOrdinal) || candidate.nextWorkbookOrdinal! < 1) {
    throw new OfficePersistenceError('invalid_recovery', 'The Excel recovery state is invalid.')
  }
  return candidate as ExcelWorkspaceState<TSnapshot>
}

/** Structured Session persistence is independent of the explicit XLSX export boundary. */
export function createExcelWorkspacePersistence<TSnapshot>(options: {
  sessionId: string
  workspacePersistence?: WorkspacePersistence<ExcelWorkspaceState<TSnapshot>>
  indexedDB?: IDBFactory
  onStatusChange?: (state: OfficePersistenceSnapshot) => void
}) {
  let ready = false
  let disposed = false
  let restoring: ReturnType<typeof loadOfficeRecovery<ExcelWorkspaceState<TSnapshot>>> | null = null
  const persistence = options.workspacePersistence ?? createIndexedDbWorkspacePersistence<ExcelWorkspaceState<TSnapshot>>({
    appKind: 'excel',
    databaseName: 'bridgic-excel-workbench-v1',
    sessionId: options.sessionId,
    storeName: 'workbooks',
    indexedDB: options.indexedDB,
  })
  const unsubscribeStatus = options.onStatusChange ? persistence.subscribe(options.onStatusChange) : () => undefined
  const assertAvailable = () => {
    if (disposed) throw new OfficePersistenceError('persistence_disposed', 'The Excel workspace controller is unavailable.')
  }

  return {
    getSnapshot: persistence.getSnapshot,
    subscribe: persistence.subscribe,
    restore() {
      if (restoring) return restoring
      ready = false
      restoring = loadOfficeRecovery(async () => {
        assertAvailable()
        const workspace = await persistence.load()
        assertAvailable()
        return readExcelWorkspace<TSnapshot>(workspace)
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
    schedule(value: ExcelWorkspaceState<TSnapshot>) {
      // Never overwrite an unreadable checkpoint with the default blank workbook.
      return ready && !disposed && persistence.schedule(value)
    },
    persist(value: ExcelWorkspaceState<TSnapshot>) {
      if (!ready || disposed) {
        return Promise.reject(new OfficePersistenceError('recovery_unavailable', 'The Excel workspace must be restored before updating its stored state.'))
      }
      return persistence.persist(value)
    },
    flush() {
      if (!ready || disposed) {
        return Promise.reject(new OfficePersistenceError('recovery_unavailable', 'The Excel workspace must be restored before updating its recovery state.'))
      }
      return persistence.flush()
    },
    dispose() {
      disposed = true
      unsubscribeStatus()
      persistence.dispose()
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
