import type { OfficeFileSource } from '../../../shared/office-files'
import { resolveOfficeSourceOpen } from './officeSourceOpen'
import { createOfficeWorkspaceRuntime, OfficeOperationError } from './officeWorkspaceRuntime'

export interface ExcelWorkspaceTab<TSnapshot> {
  source?: OfficeFileSource
  tabId: string
  documentId: string | null
  fileName: string
  snapshot: TSnapshot
  mtimeMs: number | null
  dirty: boolean
  changeVersion: number
  revision: number
}

export interface ExcelWorkbookSave<TSnapshot> {
  source?: OfficeFileSource
  changeVersion: number
  documentId: string
  fileName: string
  mtimeMs: number
  snapshot: TSnapshot
}

export const EXCEL_WORKSPACE_CAPABILITIES = [
  'document.create',
  'document.open',
  'document.activate',
  'document.close',
  'document.edit',
  'document.undo',
  'document.redo',
  'document.save',
  'document.saveAs',
] as const

/** The workbook inventory owns inactive snapshots; the mounted Univer unit owns live edits. */
export function createExcelWorkspace<TSnapshot>(options: {
  sessionId: string
  tabs: ExcelWorkspaceTab<TSnapshot>[]
  activeTabId: string | null
}) {
  type Tab = ExcelWorkspaceTab<TSnapshot>
  const sessionId = options.sessionId
  let state = { tabs: options.tabs, activeTabId: options.activeTabId }
  const listeners = new Set<() => void>()
  const runtime = createOfficeWorkspaceRuntime({
    appKind: 'excel',
    sessionId: options.sessionId,
    capabilities: EXCEL_WORKSPACE_CAPABILITIES,
    read: () => ({
      activeDocumentId: state.activeTabId,
      documents: state.tabs.map((tab) => ({
        // File handles can change on Save as. Blank workbooks still have a stable identity.
        id: tab.tabId,
        title: tab.fileName,
        revision: tab.changeVersion,
        dirty: tab.dirty,
      })),
    }),
  })

  const replace = (tabs: Tab[], activeTabId: string | null) => {
    state = {
      tabs,
      activeTabId: tabs.some((tab) => tab.tabId === activeTabId)
        ? activeTabId
        : tabs[0]?.tabId ?? null,
    }
    runtime.publish()
    for (const listener of listeners) listener()
  }

  return {
    runtime,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    replace,
    setTabs: (update: Tab[] | ((tabs: Tab[]) => Tab[])) => {
      replace(typeof update === 'function' ? update(state.tabs) : update, state.activeTabId)
    },
    activate: (tabId: string | null) => replace(state.tabs, tabId),
    updateTab: (tabId: string, update: (tab: Tab) => Tab) => {
      replace(state.tabs.map((tab) => tab.tabId === tabId ? update(tab) : tab), state.activeTabId)
    },
    async openWorkbook(options: {
      document: Pick<Tab, 'documentId' | 'source' | 'fileName' | 'mtimeMs'>
      importSnapshot: () => Promise<TSnapshot | null>
      flushEditor: () => Promise<void>
      assertCurrent: () => void
      conflictMessage: string
      replaceInitialBlank?: boolean
      expectedDocumentId?: string | null
    }) {
      const { assertCurrent, flushEditor } = options
      const { documentId, source, fileName, mtimeMs } = options.document
      const document = { documentId, source, fileName, mtimeMs }
      await flushEditor()
      assertCurrent()
      const existing = state.tabs.find((tab) => document.source
        ? tab.source?.path === document.source.path
        : tab.documentId === document.documentId)
      if (options.expectedDocumentId && existing?.tabId !== options.expectedDocumentId) {
        throw new OfficeOperationError('source_conflict', 'The requested source no longer belongs to this workbook.')
      }
      const resolution = resolveOfficeSourceOpen(existing, document.mtimeMs)
      if (resolution === 'reuse') {
        replace(state.tabs, existing!.tabId)
        return { documentId: existing!.tabId, reused: true }
      }
      if (resolution === 'conflict') throw new OfficeOperationError('source_conflict', options.conflictMessage)
      const snapshot = await options.importSnapshot()
      assertCurrent()
      if (snapshot === null) return { canceled: true }
      await flushEditor()
      assertCurrent()
      if (existing) {
        const current = state.tabs.find((tab) => tab.tabId === existing.tabId)
        if (!current) throw new OfficeOperationError('document_not_found', 'The workbook is no longer open.')
        // Native typing can continue while parsing. Never replace a newer draft.
        if (current.dirty) throw new OfficeOperationError('source_conflict', options.conflictMessage)
        const refreshed = {
          ...current, ...document, snapshot, dirty: false,
          revision: current.revision + 1, changeVersion: current.changeVersion + 1,
        }
        replace(state.tabs.map((tab) => tab.tabId === current.tabId ? refreshed : tab), current.tabId)
        return { documentId: current.tabId, reused: false }
      }
      const tab: Tab = {
        ...document, tabId: crypto.randomUUID(), snapshot,
        dirty: false, changeVersion: 0, revision: 0,
      }
      const initial = state.tabs[0]
      replace(options.replaceInitialBlank && state.tabs.length === 1
        && initial?.documentId === null && initial.changeVersion === 0
        ? [tab] : [...state.tabs, tab], tab.tabId)
      return { documentId: tab.tabId, reused: false }
    },
    async commitClose(options: {
      tabs: Tab[]
      activeTabId: string | null
      persist: (tabs: Tab[], activeTabId: string | null) => Promise<unknown>
      flushEditor: () => Promise<void>
      assertCurrent: () => void
      changedMessage: string
    }) {
      const approved = state
      let flushDuringRestore = false
      const restoreInventory = async (flushEditor: boolean) => {
        let retained: typeof state
        do {
          retained = state
          await options.persist(retained.tabs, retained.activeTabId)
          if (flushEditor) await options.flushEditor()
          options.assertCurrent()
        } while (state !== retained)
      }
      try {
        // Keep the native editors alive until the proposed inventory is durable.
        await options.persist(options.tabs, options.activeTabId)
        await options.flushEditor()
        options.assertCurrent()
        if (state.tabs.length !== approved.tabs.length || state.tabs.some((tab, index) => {
          const previous = approved.tabs[index]
          return tab.tabId !== previous?.tabId || tab.changeVersion !== previous.changeVersion
        })) {
          flushDuringRestore = true
          throw new OfficeOperationError('document_changed', options.changedMessage)
        }
        replace(options.tabs, options.activeTabId)
      } catch (cause) {
        // Even a failed native flush must restore its last accepted model before
        // the close operation reports failure. Input may continue during writes.
        try { await restoreInventory(flushDuringRestore) } catch (restoreError) {
          // A retrying native flush may fail after restoring the inventory once.
          // Persist accepted input without attempting that failed flush again.
          try { await restoreInventory(false) } catch (checkpointError) {
            throw new OfficeOperationError('checkpoint_failed', checkpointError instanceof Error ? checkpointError.message : 'The Excel recovery checkpoint could not be restored.')
          }
          throw new OfficeOperationError('checkpoint_failed', restoreError instanceof Error ? restoreError.message : 'The Excel recovery checkpoint could not be restored.')
        }
        throw cause
      }
    },
    completeSave(tabId: string, saved: ExcelWorkbookSave<TSnapshot>, draftName: (fileName: string) => string): string[] {
      if (!state.tabs.some((tab) => tab.tabId === tabId)) {
        throw new OfficeOperationError('document_not_ready', 'The saved workbook is no longer open.')
      }
      const retainedDrafts: string[] = []
      const tabs = state.tabs.flatMap((tab) => {
        if (tab.tabId === tabId) return [completeExcelWorkbookSave(tab, saved)]
        if (tab.documentId !== saved.documentId && (!saved.source || tab.source?.path !== saved.source.path)) return [tab]
        if (!tab.dirty) return []
        // Save as may overwrite another open source. Preserve its edits without
        // letting a later Save silently write them back over the newly saved file.
        const fileName = draftName(tab.fileName)
        retainedDrafts.push(fileName)
        return [{ ...tab, documentId: null, source: undefined, mtimeMs: null, fileName }]
      })
      replace(tabs, tabs.some((tab) => tab.tabId === state.activeTabId) ? state.activeTabId : tabId)
      return retainedDrafts
    },
    executeEditor<TEditor extends { readonly documentId: string }, TResult>(options: {
      capability: string
      documentId: string | null
      getEditor: () => TEditor | null
      apply: (editor: TEditor) => TResult | Promise<TResult>
    }) {
      const { capability, documentId, getEditor, apply } = options
      const editor = getEditor()
      return runtime.execute({
        sessionId,
        capability,
        documentId,
      }, async (context) => {
        const assertEditorCurrent = () => {
          if (!documentId || !editor || editor.documentId !== documentId
            || state.activeTabId !== documentId || getEditor() !== editor) {
            throw new OfficeOperationError('document_not_ready', 'The requested workbook is no longer the active editor.')
          }
        }
        assertEditorCurrent()
        const result = await apply(editor!)
        context.assertCurrent()
        assertEditorCurrent()
        return result
      })
    },
  }
}

/** A source write acknowledges only the native change version that produced its bytes. */
export function completeExcelWorkbookSave<TSnapshot>(current: ExcelWorkspaceTab<TSnapshot>, saved: ExcelWorkbookSave<TSnapshot>): ExcelWorkspaceTab<TSnapshot> {
  const changedWhileSaving = current.changeVersion !== saved.changeVersion
  return {
    ...current,
    documentId: saved.documentId,
    source: saved.source ?? current.source,
    fileName: saved.fileName,
    snapshot: changedWhileSaving ? current.snapshot : saved.snapshot,
    mtimeMs: saved.mtimeMs,
    dirty: changedWhileSaving,
  }
}
