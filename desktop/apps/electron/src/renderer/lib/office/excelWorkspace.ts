import { createOfficeWorkspaceRuntime, OfficeOperationError } from './officeWorkspaceRuntime'

export interface ExcelWorkspaceTab<TSnapshot> {
  tabId: string
  documentId: string | null
  fileName: string
  snapshot: TSnapshot
  mtimeMs: number | null
  dirty: boolean
  changeVersion: number
  revision: number
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
export function completeExcelWorkbookSave<TSnapshot>(current: ExcelWorkspaceTab<TSnapshot>, saved: {
  changeVersion: number
  documentId: string
  fileName: string
  mtimeMs: number
  snapshot: TSnapshot
}): ExcelWorkspaceTab<TSnapshot> {
  const changedWhileSaving = current.changeVersion !== saved.changeVersion
  return {
    ...current,
    documentId: saved.documentId,
    fileName: saved.fileName,
    snapshot: changedWhileSaving ? current.snapshot : saved.snapshot,
    mtimeMs: saved.mtimeMs,
    dirty: changedWhileSaving,
  }
}
