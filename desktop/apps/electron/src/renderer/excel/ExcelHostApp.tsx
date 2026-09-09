import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react'
import type { IWorkbookData } from '@univerjs/core'
import type { ExcelDocumentHandle, ExcelHostConfig, ExcelWorkbookOpenTicket } from '../../shared/types'
import { Icons } from '../components/amphi/Icons'
import { OfficeDocumentTabs } from '../components/app/OfficeWorkbenchChrome'
import { completeExcelWorkbookSave, createExcelWorkspace, type ExcelWorkspaceTab } from '../lib/office/excelWorkspace'
import { createExcelRecoveryPersistence, writeExcelWorkbookSource } from '../lib/office/excelPersistence'
import { OfficeOperationError, type OfficeOperationContext } from '../lib/office/officeWorkspaceRuntime'
import {
  clearUnsupportedWorkbookFeatures, createEmptyWorkbook, exportXlsx, importXlsx, unsupportedWorkbookFeatures,
} from '../lib/excelWorkbook'
import { ExcelRibbon, type ExcelRibbonAction, type ExcelRibbonTab, type ExcelViewState } from './ExcelRibbon'
import { excelDataOperationMessage } from './excelDataOperations'
import { ExcelHyperlinkDialog, ExcelPivotTableDialog } from './ExcelInsertDialogs'
import { ExcelFormulaWizardDialog } from './ExcelFormulaWizardDialog'
import { rememberFormula } from './excelFormulaCatalog'
import { excelInsertValidationMessage, type ExcelInsertContext, type ExcelRibbonActionValue } from './excelInsert'
import { UniverSheetEditor } from './UniverSheetEditor'
import { univerLocale, type ExcelViewPreferences, type SheetEditorHandle, type SheetSelectionState } from './excelUniverAdapter'

type WorkbookTab = ExcelWorkspaceTab<IWorkbookData>

type BusyAction = 'opening' | 'saving' | null
type InsertDialogState = { kind: 'hyperlink' | 'pivot'; context: ExcelInsertContext; tabId: string } | null
interface FormulaDialogState {
  initialFormula: string
  sheetId: string
  sheetName: string
  tabId: string
  targetAddress: string
}
type OperationNotice = { id: number; message: string } | null
type RecoveryFailure = { kind: 'restore' | 'write'; message: string } | null
const RECENT_FORMULAS_STORAGE_KEY = 'bridgic.excel.recent-formulas'

function loadRecentFormulas(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_FORMULAS_STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}

interface Copy {
  close: string
  documentTabs: string
  closeUnsaved: string
  dismissError: string
  dismissNotice: string
  lossyOverwrite: string
  lossySaveAs: string
  new: string
  open: string
  openFailed: string
  recoveryReadFailed: string
  recoveryWriteFailed: string
  retryRecovery: string
  saveAs: string
  saveConflict: string
  saveFailed: string
  unsaved: string
  workbook: string
  emptyTitle: string
  emptyDetail: string
}

const COPY: Record<ExcelHostConfig['locale'], Copy> = {
  'en-US': {
    close: 'Close workbook',
    documentTabs: 'Excel workbook tabs',
    closeUnsaved: 'This workbook has unsaved changes. Close it and discard those changes?',
    dismissError: 'Dismiss error',
    dismissNotice: 'Dismiss message',
    lossyOverwrite: 'This file contains Excel objects that cannot be reproduced safely ({features}). The original will not be overwritten. Use Save as to create a simplified copy.',
    lossySaveAs: 'This workbook contains Excel objects that cannot be reproduced safely ({features}). Save a simplified copy without those objects?',
    new: 'New',
    open: 'Open',
    openFailed: 'Could not open this workbook',
    recoveryReadFailed: 'Could not restore the workbooks.',
    recoveryWriteFailed: 'Could not update workbook recovery state.',
    retryRecovery: 'Retry',
    saveAs: 'Save as',
    saveConflict: 'The file changed on disk. Use Save as to keep both versions.',
    saveFailed: 'Could not save this workbook',
    unsaved: 'Unsaved changes',
    workbook: 'Workbook',
    emptyTitle: 'No workbook tabs',
    emptyDetail: 'Create a workbook or open an existing .xlsx file.',
  },
  'zh-CN': {
    close: '关闭工作簿',
    documentTabs: 'Excel 工作簿标签',
    closeUnsaved: '此工作簿有未保存的更改。要关闭并放弃这些更改吗？',
    dismissError: '关闭错误提示',
    dismissNotice: '关闭操作提示',
    lossyOverwrite: '此文件包含当前无法安全还原的 Excel 对象（{features}）。为保护原文件，不会执行覆盖保存；请使用“另存为”创建简化副本。',
    lossySaveAs: '此工作簿包含当前无法安全还原的 Excel 对象（{features}）。是否另存一个不含这些对象的简化副本？',
    new: '新建',
    open: '打开',
    openFailed: '无法打开此工作簿',
    recoveryReadFailed: '无法恢复工作簿。',
    recoveryWriteFailed: '无法保存工作簿恢复状态。',
    retryRecovery: '重试',
    saveAs: '另存为',
    saveConflict: '磁盘中的文件已被修改。请使用“另存为”保留两个版本。',
    saveFailed: '无法保存此工作簿',
    unsaved: '有未保存的更改',
    workbook: '工作簿',
    emptyTitle: '没有工作簿标签页',
    emptyDetail: '新建工作簿，或打开已有的 .xlsx 文件。',
  },
}

function readConfig(): ExcelHostConfig {
  const params = new URLSearchParams(window.location.search)
  const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  return { sessionId: params.get('sessionId') || 'unknown', locale, theme }
}

function newWorkbookTab(config: ExcelHostConfig, ordinal: number): WorkbookTab {
  const name = config.locale === 'zh-CN' ? `工作簿 ${ordinal}` : `Workbook ${ordinal}`
  return {
    tabId: crypto.randomUUID(),
    documentId: null,
    fileName: `${name}.xlsx`,
    snapshot: createEmptyWorkbook(univerLocale(config), name),
    mtimeMs: null,
    dirty: false,
    changeVersion: 0,
    revision: 0,
  }
}

function openedWorkbookTab(document: ExcelDocumentHandle, snapshot: IWorkbookData): WorkbookTab {
  return {
    tabId: crypto.randomUUID(),
    documentId: document.documentId,
    fileName: document.fileName,
    snapshot,
    mtimeMs: document.mtimeMs,
    dirty: false,
    changeVersion: 0,
    revision: 0,
  }
}

function isPristineInitialWorkbook(tab: WorkbookTab): boolean {
  return tab.documentId === null && !tab.dirty && tab.changeVersion === 0
}

/** Workbook tabs for one Agent Session, all inside this single CDP target. */
export function ExcelHostApp() {
  const api = window.excelHostApi
  if (!api) throw new Error('Excel host preload is unavailable')
  const [config, setConfig] = useState(readConfig)
  const [editorTheme, setEditorTheme] = useState<ExcelHostConfig['theme']>(config.theme)
  const nextWorkbookOrdinal = useRef(2)
  const [workspace] = useState(() => {
    const tab = newWorkbookTab(readConfig(), 1)
    return createExcelWorkspace({ sessionId: config.sessionId, tabs: [tab], activeTabId: tab.tabId })
  })
  const { tabs, activeTabId } = useSyncExternalStore(workspace.subscribe, workspace.getState)
  const { activate: setActiveTabId, updateTab, runtime } = workspace
  const workspaceLifetimeRef = useRef(0)
  const [recoveryLoaded, setRecoveryLoaded] = useState(false)
  const [recoveryFailure, setRecoveryFailure] = useState<RecoveryFailure>(null)
  const [recoveryAttempt, setRecoveryAttempt] = useState(0)
  const [recoveryRestoring, setRecoveryRestoring] = useState(true)
  const [recovery] = useState(() => createExcelRecoveryPersistence<IWorkbookData>({
    sessionId: config.sessionId,
    api,
    onStatusChange: (state) => {
      if (state.status === 'error') {
        setRecoveryFailure({ kind: 'write', message: state.error?.message ?? 'Recovery write failed.' })
      } else if (state.status === 'saved') {
        setRecoveryFailure((current) => current?.kind === 'write' ? null : current)
      }
    },
  }))
  const [ribbonTab, setRibbonTab] = useState<ExcelRibbonTab>('home')
  const [selection, setSelection] = useState<SheetSelectionState>({
    address: 'A1', sheetId: '', sheetName: 'Sheet1', targetAddress: 'A1', value: '',
  })
  const [insertDialog, setInsertDialog] = useState<InsertDialogState>(null)
  const [formulaDialog, setFormulaDialog] = useState<FormulaDialogState | null>(null)
  const [recentFunctions, setRecentFunctions] = useState(loadRecentFormulas)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [pendingWorkbookOpenTickets, setPendingWorkbookOpenTickets] = useState<ExcelWorkbookOpenTicket[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<OperationNotice>(null)
  const [viewPreferences, setViewPreferences] = useState<ExcelViewPreferences>({
    highlightMode: 'none',
  })
  const [viewState, setViewState] = useState<ExcelViewState>({
    darkMode: config.theme === 'dark',
    gridlines: true,
    highlightMode: 'none',
    showZeros: true,
    zoom: 1,
  })
  const nextNoticeId = useRef(1)
  const externalWorkbookOpenPendingRef = useRef(false)
  const editorRef = useRef<SheetEditorHandle>(null)
  const copy = COPY[config.locale]
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.tabId === activeTabId) ?? null,
    [activeTabId, tabs],
  )
  const effectiveConfig = useMemo(() => ({ ...config, theme: editorTheme }), [config, editorTheme])
  const executeWorkspaceOperation = useCallback((
    capability: string,
    documentId: string | null,
    apply: (context: OfficeOperationContext) => void | Promise<void>,
  ) => runtime.execute({ sessionId: config.sessionId, capability, documentId }, apply).then((result) => {
    if (!result.ok && result.error.code !== 'runtime_disposed') setError(result.error.message)
    return result
  }), [config.sessionId, runtime])
  const flushActiveEditor = useCallback(async (assertCurrent: () => void) => {
    const activeId = workspace.getState().activeTabId
    const editor = editorRef.current
    if (!activeId || !editor || editor.documentId !== activeId) return
    await editor.flush()
    assertCurrent()
    if (workspace.getState().activeTabId !== activeId || editorRef.current !== editor) {
      throw new OfficeOperationError('document_not_ready', 'The workbook editor was replaced while committing its current cell.')
    }
  }, [workspace])

  useEffect(() => {
    const lifetime = ++workspaceLifetimeRef.current
    const currentLifetime = workspaceLifetimeRef
    return () => {
      // StrictMode replays effects without replacing the Session workspace.
      queueMicrotask(() => {
        if (currentLifetime.current === lifetime) {
          runtime.dispose()
          recovery.dispose()
        }
      })
    }
  }, [recovery, runtime])

  useEffect(() => api.onConfigChanged((next) => {
    if (next.sessionId === config.sessionId) {
      setConfig(next)
      setEditorTheme(next.theme)
    }
  }), [api, config.sessionId])

  useEffect(() => api.onWorkbookOpenRequested((ticket) => {
    setPendingWorkbookOpenTickets((current) => [...current, ticket])
  }), [api])

  useEffect(() => {
    let disposed = false
    void recovery.restore().then((result) => {
      if (disposed) return
      if (result.status === 'failed') {
        setRecoveryFailure({ kind: 'restore', message: result.error.message })
        return
      }
      if (result.status === 'restored') {
        const recovered = result.value
        workspace.replace(recovered.tabs, recovered.activeTabId)
        nextWorkbookOrdinal.current = recovered.nextWorkbookOrdinal
      }
      setRecoveryFailure(null)
      setRecoveryLoaded(true)
    }).finally(() => {
      if (!disposed) setRecoveryRestoring(false)
    })
    return () => {
      disposed = true
    }
  }, [recovery, recoveryAttempt, workspace])

  useEffect(() => {
    document.documentElement.dataset.theme = editorTheme
    document.documentElement.lang = config.locale
    document.title = `Excel · ${config.sessionId}`
  }, [config.locale, config.sessionId, editorTheme])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice((current) => current?.id === notice.id ? null : current), 4000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    const hasUnsaved = tabs.some((tab) => tab.dirty)
    if (recoveryLoaded) void api.setDirty(hasUnsaved).catch((cause) => setError(errorMessage(cause)))
    if (!hasUnsaved) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [api, recoveryLoaded, tabs])

  useEffect(() => {
    if (!recoveryLoaded) return
    const scheduleRecovery = () => {
      const state = workspace.getState()
      recovery.schedule({
        version: 1,
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        nextWorkbookOrdinal: nextWorkbookOrdinal.current,
      })
    }
    const unsubscribe = workspace.subscribe(scheduleRecovery)
    scheduleRecovery()
    // The native child can synchronously publish its last accepted mutation during cleanup.
    return () => { queueMicrotask(unsubscribe) }
  }, [recovery, recoveryLoaded, workspace])

  const markDirty = useCallback((tabId: string, snapshot: IWorkbookData) => {
    updateTab(tabId, (current) => ({
      ...current,
      snapshot,
      dirty: true,
      changeVersion: current.changeVersion + 1,
    }))
  }, [updateTab])
  const handleEditorChange = useCallback((snapshot: IWorkbookData) => {
    if (activeTabId) markDirty(activeTabId, snapshot)
  }, [activeTabId, markDirty])

  const importOpenedWorkbook = useCallback(async (
    document: ExcelDocumentHandle,
    replaceInitialBlank: boolean,
    assertCurrent: () => void,
  ) => {
    const snapshot = await importXlsx(document.bytes, univerLocale(config))
    assertCurrent()
    await flushActiveEditor(assertCurrent)
    const tab = openedWorkbookTab(document, snapshot)
    const current = workspace.getState().tabs
    workspace.replace(
      replaceInitialBlank
      && current.length === 1
      && current[0] !== undefined
      && isPristineInitialWorkbook(current[0])
        ? [tab]
        : [...current, tab],
      tab.tabId,
    )
  }, [config, flushActiveEditor, workspace])

  const addBlankTab = () => {
    void executeWorkspaceOperation('document.create', null, async (context) => {
      await flushActiveEditor(context.assertCurrent)
      setFormulaDialog(null)
      setInsertDialog(null)
      const tab = newWorkbookTab(config, nextWorkbookOrdinal.current)
      nextWorkbookOrdinal.current += 1
      workspace.replace([...workspace.getState().tabs, tab], tab.tabId)
      setError(null)
    })
  }

  const openWorkbook = () => executeWorkspaceOperation('document.open', null, async (context) => {
    setFormulaDialog(null)
    setInsertDialog(null)
    setBusy('opening')
    setError(null)
    try {
      const result = await api.open()
      if (result.canceled) return
      await importOpenedWorkbook(result.document, false, context.assertCurrent)
    } catch (cause) {
      if (cause instanceof OfficeOperationError) throw cause
      throw new Error(`${copy.openFailed}: ${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  })


  useEffect(() => {
    if (!recoveryLoaded || busy !== null || pendingWorkbookOpenTickets.length === 0) return
    const ticket = pendingWorkbookOpenTickets[0]
    if (!ticket || externalWorkbookOpenPendingRef.current) return
    externalWorkbookOpenPendingRef.current = true
    queueMicrotask(() => {
      setPendingWorkbookOpenTickets((current) => current.slice(1))
      void executeWorkspaceOperation('document.open', null, async (context) => {
        setFormulaDialog(null)
        setInsertDialog(null)
        setBusy('opening')
        setError(null)
        try {
          const result = await api.openRequestedWorkbook(ticket.requestId)
          if (!result.canceled) await importOpenedWorkbook(result.document, ticket.replaceInitialBlank, context.assertCurrent)
        } catch (cause) {
          if (cause instanceof OfficeOperationError) throw cause
          throw new Error(`${copy.openFailed}: ${errorMessage(cause)}`)
        } finally {
          setBusy(null)
        }
      }).finally(() => {
        externalWorkbookOpenPendingRef.current = false
      })
    })
  }, [
    api,
    busy,
    copy.openFailed,
    executeWorkspaceOperation,
    importOpenedWorkbook,
    pendingWorkbookOpenTickets,
    recoveryLoaded,
  ])

  const persistWorkbook = useCallback((requestedTab: WorkbookTab, saveAs: boolean) => (
    executeWorkspaceOperation(saveAs ? 'document.saveAs' : 'document.save', requestedTab.tabId, async (context) => {
      if (workspace.getState().activeTabId === requestedTab.tabId) await flushActiveEditor(context.assertCurrent)
      const state = workspace.getState()
      const tab = state.tabs.find((candidate) => candidate.tabId === requestedTab.tabId)!
      const snapshot = tab.tabId === state.activeTabId && editorRef.current?.documentId === tab.tabId
        ? editorRef.current?.snapshot() ?? tab.snapshot
        : tab.snapshot
      const savedChangeVersion = tab.changeVersion
      setBusy('saving')
      setError(null)
      try {
        const incompatible = unsupportedWorkbookFeatures(snapshot)
        const outcome = await writeExcelWorkbookSource({
          api,
          tab,
          saveAs,
          conflictMessage: copy.saveConflict,
          assertCurrent: context.assertCurrent,
          prepare: async () => {
            const featureList = incompatible.join(', ')
            if (incompatible.length > 0 && !saveAs) {
              throw new OfficeOperationError('unsupported_format', copy.lossyOverwrite.replace('{features}', featureList))
            }
            if (incompatible.length > 0 && saveAs
              && !window.confirm(copy.lossySaveAs.replace('{features}', featureList))) return null
            return exportXlsx(snapshot, { allowLossy: saveAs })
          },
        })
        if (outcome.status === 'canceled') return
        if (outcome.status === 'conflict') throw new OfficeOperationError('source_conflict', outcome.message)
        if (outcome.status === 'failed') {
          const message = outcome.error.code === 'unsupported_format'
            ? outcome.error.message
            : `${copy.saveFailed}: ${outcome.error.message}`
          throw new OfficeOperationError(outcome.error.code, message)
        }
        const result = outcome.value
        context.assertCurrent()
        updateTab(tab.tabId, (current) => completeExcelWorkbookSave(current, {
          changeVersion: savedChangeVersion,
          documentId: result.documentId,
          fileName: result.fileName,
          mtimeMs: result.mtimeMs,
          snapshot: incompatible.length > 0 && saveAs
            ? clearUnsupportedWorkbookFeatures(snapshot)
            : snapshot,
        }))
      } catch (cause) {
        if (cause instanceof OfficeOperationError) throw cause
        throw new Error(`${copy.saveFailed}: ${errorMessage(cause)}`)
      } finally {
        setBusy(null)
      }
    })
  ), [
    api,
    copy.lossyOverwrite,
    copy.lossySaveAs,
    copy.saveConflict,
    copy.saveFailed,
    executeWorkspaceOperation,
    flushActiveEditor,
    updateTab,
    workspace,
  ])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 's' || !activeTab || !recoveryLoaded) return
      event.preventDefault()
      void persistWorkbook(activeTab, event.shiftKey)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTab, persistWorkbook, recoveryLoaded])

  const closeTab = (requestedTab: WorkbookTab) => {
    void executeWorkspaceOperation('document.close', requestedTab.tabId, async (context) => {
      if (workspace.getState().activeTabId === requestedTab.tabId) await flushActiveEditor(context.assertCurrent)
      const state = workspace.getState()
      const tab = state.tabs.find((candidate) => candidate.tabId === requestedTab.tabId)!
      if (tab.dirty && !window.confirm(copy.closeUnsaved)) return
      setFormulaDialog(null)
      setInsertDialog(null)
      if (state.tabs.length === 1) {
        await api.closeSession()
        return
      }
      const index = state.tabs.findIndex((candidate) => candidate.tabId === tab.tabId)
      const nextActive = state.tabs[index + 1] ?? state.tabs[index - 1] ?? null
      workspace.replace(
        state.tabs.filter((candidate) => candidate.tabId !== tab.tabId),
        state.activeTabId === tab.tabId ? nextActive?.tabId ?? null : state.activeTabId,
      )
    })
  }

  const reportActionFailure = useCallback((cause: unknown) => {
    const message = excelInsertValidationMessage(cause, config.locale)
      ?? excelDataOperationMessage(cause, config.locale)
    if (message) {
      setError(null)
      setNotice({ id: nextNoticeId.current, message })
      nextNoticeId.current += 1
      return
    }
    setError(errorMessage(cause))
  }, [config.locale])
  const runEditorOperation = useCallback((
    apply: (editor: SheetEditorHandle) => void | Promise<void>,
    capability = 'document.edit',
    documentId = workspace.getState().activeTabId,
  ) => {
    let failure: unknown
    return workspace.executeEditor({
      capability,
      documentId,
      getEditor: () => editorRef.current,
      apply: async (editor) => {
        try {
          await apply(editor)
        } catch (cause) {
          failure = cause
          throw cause
        }
      },
    }).then((result) => {
      if (!result.ok && result.error.code !== 'runtime_disposed') {
        reportActionFailure(failure ?? new OfficeOperationError(result.error.code, result.error.message))
      }
      return result
    })
  }, [reportActionFailure, workspace])
  const rememberRecentFunction = useCallback((name: string) => {
    setRecentFunctions((current) => {
      const next = rememberFormula(current, name)
      try {
        window.localStorage.setItem(RECENT_FORMULAS_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Recent functions are a convenience only; formula editing must still work when storage is unavailable.
      }
      return next
    })
  }, [])
  const handleViewStateChange = useCallback((next: ExcelViewState) => {
    setViewState(next)
    setViewPreferences((current) => (
      current.highlightMode === next.highlightMode
        ? current
        : { highlightMode: next.highlightMode }
    ))
  }, [])
  const runRibbonAction = useCallback((action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => {
    setNotice(null)
    if (action === 'toggle-dark-mode') {
      setEditorTheme((current) => current === 'dark' ? 'light' : 'dark')
      return
    }
    if (action === 'formula-more' || (action === 'formula-insert' && typeof value === 'string')) {
      if (!activeTabId) return
      let initialFormula = ''
      if (action === 'formula-insert') initialFormula = `=${value}()`
      else if (selection.value.startsWith('=')) initialFormula = selection.value
      setFormulaDialog({
        initialFormula,
        sheetId: selection.sheetId,
        sheetName: selection.sheetName,
        tabId: activeTabId,
        targetAddress: selection.targetAddress,
      })
      return
    }
    if ((action === 'insert-pivot-table' || action === 'insert-hyperlink') && value === undefined) {
      const context = editorRef.current?.insertContext(action === 'insert-pivot-table')
      if (!context) return
      if (!activeTabId) return
      setInsertDialog({ kind: action === 'insert-pivot-table' ? 'pivot' : 'hyperlink', context, tabId: activeTabId })
      return
    }
    void runEditorOperation(
      (editor) => editor.run(action, value),
      action === 'undo' || action === 'redo' ? `document.${action}` : 'document.edit',
    )
  }, [activeTabId, runEditorOperation, selection])
  const selectFormulaRange = useCallback((address: string) => {
    void runEditorOperation((editor) => editor.selectRange(address))
  }, [runEditorOperation])
  const setFormulaBarValue = useCallback((value: string) => {
    void runEditorOperation((editor) => editor.setFormulaBarValue(value))
  }, [runEditorOperation])

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-bg-surface text-text-primary">
      <OfficeDocumentTabs
        activeId={activeTabId}
        icon={<span className="flex shrink-0 text-emerald-600 dark:text-emerald-400">{Icons.spreadsheet(16)}</span>}
        label={copy.documentTabs}
        newDisabled={!recoveryLoaded || busy !== null}
        newLabel={copy.new}
        onClose={(id) => {
          const tab = tabs.find((item) => item.tabId === id)
          if (tab) closeTab(tab)
        }}
        onCreate={addBlankTab}
        onSelect={(id) => {
          void executeWorkspaceOperation('document.activate', id, async (context) => {
            if (workspace.getState().activeTabId !== id) await flushActiveEditor(context.assertCurrent)
            setFormulaDialog(null)
            setInsertDialog(null)
            setActiveTabId(id)
          })
        }}
        tabs={(recoveryLoaded ? tabs : []).map((tab) => ({
          id: tab.tabId,
          label: tab.fileName,
          closeLabel: `${copy.close}: ${tab.fileName}`,
          dirtyLabel: tab.dirty ? copy.unsaved : undefined,
        }))}
        testIdPrefix="excel"
      />

      {activeTab ? (
        <ExcelRibbon
          activeTab={ribbonTab}
          disabled={!recoveryLoaded || busy !== null}
          locale={config.locale}
          onAction={runRibbonAction}
          onActiveTabChange={setRibbonTab}
          onAddressSubmit={selectFormulaRange}
          onFormulaSubmit={setFormulaBarValue}
          recentFunctions={recentFunctions}
          selectionAddress={selection.address}
          selectionValue={selection.value}
          viewState={{ ...viewState, darkMode: editorTheme === 'dark' }}
        />
      ) : null}

      {error ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-status-error/20 bg-status-error/10 px-3 py-2 text-xs text-status-error" role="alert">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button aria-label={copy.dismissError} className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setError(null)} type="button">{Icons.x(13)}</button>
        </div>
      ) : null}

      {recoveryFailure ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-status-error/20 bg-status-error/10 px-3 py-2 text-xs text-status-error" role="alert">
          <span className="min-w-0 flex-1 break-words">
            {recoveryFailure.kind === 'restore' ? copy.recoveryReadFailed : copy.recoveryWriteFailed}
          </span>
          <button
            className="shrink-0 font-medium underline underline-offset-2 disabled:opacity-40"
            disabled={recoveryRestoring}
            onClick={() => {
              if (recoveryFailure.kind === 'restore') {
                setRecoveryRestoring(true)
                setRecoveryAttempt((attempt) => attempt + 1)
                return
              }
              setRecoveryRestoring(true)
              void recovery.flush().catch((cause) => {
                setRecoveryFailure({ kind: 'write', message: errorMessage(cause) })
              }).finally(() => setRecoveryRestoring(false))
            }}
            type="button"
          >
            {copy.retryRecovery}
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-12 z-[9998] flex justify-center px-4" role="status">
          <div className="pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border border-status-warning/25 bg-bg-surface px-3 py-2 text-[11px] text-text-secondary shadow-xl">
            <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-status-warning/15 text-[10px] font-semibold text-status-warning">!</span>
            <span className="min-w-0 leading-4">{notice.message}</span>
            <button aria-label={copy.dismissNotice} className="ml-1 shrink-0 text-text-tertiary hover:text-text-primary" onClick={() => setNotice(null)} type="button">{Icons.x(12)}</button>
          </div>
        </div>
      ) : null}

      {activeTab && recoveryLoaded ? (
        <UniverSheetEditor
          key={`${activeTab.tabId}:${activeTab.revision}`}
          ref={editorRef}
          config={effectiveConfig}
          documentId={activeTab.tabId}
          onActionFailure={reportActionFailure}
          onChange={handleEditorChange}
          onSelectionChange={setSelection}
          onViewStateChange={handleViewStateChange}
          snapshot={activeTab.snapshot}
          viewPreferences={viewPreferences}
        />
      ) : null}
      {!activeTab && recoveryLoaded ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">{Icons.spreadsheet(30)}</span>
          <h1 className="text-sm font-semibold">{copy.emptyTitle}</h1>
          <p className="mt-1 text-xs text-text-tertiary">{copy.emptyDetail}</p>
          <div className="mt-4 flex gap-2">
            <HostButton label={copy.new} onClick={addBlankTab}>{Icons.plus(13)} {copy.new}</HostButton>
            <HostButton label={copy.open} onClick={() => void openWorkbook()}>{Icons.folder(13)} {copy.open}</HostButton>
          </div>
        </div>
      ) : null}

      {insertDialog?.kind === 'hyperlink' ? (
        <ExcelHyperlinkDialog
          context={insertDialog.context}
          locale={config.locale}
          onCancel={() => setInsertDialog(null)}
          onConfirm={(options) => {
            setInsertDialog(null)
            void runEditorOperation((editor) => editor.run('insert-hyperlink', options), 'document.edit', insertDialog.tabId)
          }}
        />
      ) : null}
      {insertDialog?.kind === 'pivot' ? (
        <ExcelPivotTableDialog
          context={insertDialog.context}
          locale={config.locale}
          onCancel={() => setInsertDialog(null)}
          onConfirm={(options) => {
            setInsertDialog(null)
            void runEditorOperation((editor) => editor.run('insert-pivot-table', options), 'document.edit', insertDialog.tabId)
          }}
        />
      ) : null}
      {formulaDialog ? (
        <ExcelFormulaWizardDialog
          initialFormula={formulaDialog.initialFormula}
          locale={config.locale}
          onCancel={() => setFormulaDialog(null)}
          onConfirm={(formula, name) => {
            if (formulaDialog.tabId !== activeTabId) return
            void runEditorOperation((editor) => {
              editor.setFormulaAt(formulaDialog.sheetId, formulaDialog.targetAddress, formula)
            }, 'document.edit', formulaDialog.tabId)
            rememberRecentFunction(name)
            setFormulaDialog(null)
          }}
          onEvaluate={(formula) => formulaDialog.tabId === activeTabId
            ? editorRef.current?.previewFormula(
              formulaDialog.sheetId,
              formulaDialog.targetAddress,
              formula,
            ) ?? Promise.resolve({ errorCode: '#ERROR!' })
            : Promise.resolve({ errorCode: '#REF!' })}
          recentFunctions={recentFunctions}
          selectionAddress={selection.address}
          selectionSheetName={selection.sheetName}
          targetAddress={formulaDialog.targetAddress}
          targetSheetName={formulaDialog.sheetName}
        />
      ) : null}
    </main>
  )
}

function HostButton({ children, disabled, label, onClick }: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-border-subtle bg-bg-surface px-2 text-[11px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
