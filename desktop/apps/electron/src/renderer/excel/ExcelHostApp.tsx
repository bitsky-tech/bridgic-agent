import { createOfficeAutoSave } from '../lib/office/officeAutoSave'
import { confirmOfficeClose } from '../lib/office/officeFileClient'
import { OfficeSaveActions } from '../components/app/OfficeSaveActions'
import { OfficeLaunchEmptyState } from '../components/app/OfficeLaunchEmptyState'
import { useTranslation } from 'react-i18next'
import { i18n } from '../lib/i18n'
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react'
import type { IWorkbookData } from '@univerjs/core'
import type { ExcelDocumentHandle, ExcelHostConfig, ExcelWorkbookOpenTicket } from '../../shared/types'
import { Icons } from '../components/amphi/Icons'
import { OfficeDocumentTabs } from '../components/app/OfficeWorkbenchChrome'
import { createExcelWorkspace, type ExcelWorkspaceTab } from '../lib/office/excelWorkspace'
import { createExcelRecoveryPersistence, writeExcelWorkbookSource } from '../lib/office/excelPersistence'
import { OfficeOperationError, type OfficeOperationContext } from '../lib/office/officeWorkspaceRuntime'
import {
  clearUnsupportedWorkbookFeatures, createEmptyWorkbook, exportXlsx, unsupportedWorkbookFeatures,
  type ExcelImportProgress,
} from '../lib/excelWorkbook'
import { importExcelWorkbook } from '../lib/excelWorkbookImport'
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

function readConfig(): ExcelHostConfig {
  const params = new URLSearchParams(window.location.search)
  const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  return { sessionId: params.get('sessionId') || 'unknown', locale, theme }
}

function newWorkbookTab(config: ExcelHostConfig, ordinal: number): WorkbookTab {
  const name = i18n.t('excel.host.newWorkbookName', { lng: config.locale, ordinal })
  return {
    tabId: crypto.randomUUID(),
    documentId: null,
    fileName: `${name}.xlsx`,
    snapshot: createEmptyWorkbook(univerLocale(config), name),
    mtimeMs: null,
    dirty: true,
    changeVersion: 0,
    revision: 0,
  }
}

function openedWorkbookTab(document: ExcelDocumentHandle, snapshot: IWorkbookData): WorkbookTab {
  return {
    tabId: crypto.randomUUID(),
    documentId: document.documentId,
    source: document.source,
    fileName: document.fileName,
    snapshot,
    mtimeMs: document.mtimeMs,
    dirty: false,
    changeVersion: 0,
    revision: 0,
  }
}

function isPristineInitialWorkbook(tab: WorkbookTab): boolean {
  return tab.documentId === null && tab.changeVersion === 0
}

/** Workbook tabs for one Agent Session, all inside this single CDP target. */
export function ExcelHostApp() {
  const api = window.excelHostApi
  if (!api) throw new Error('Excel host preload is unavailable')
  const [config, setConfig] = useState(readConfig)
  const [editorTheme, setEditorTheme] = useState<ExcelHostConfig['theme']>(config.theme)
  const [createInitialWorkbook] = useState(() => new URLSearchParams(window.location.search).get('initialWorkbook') !== 'empty')
  const nextWorkbookOrdinal = useRef(createInitialWorkbook ? 2 : 1)
  const [workspace] = useState(() => {
    const tab = createInitialWorkbook ? newWorkbookTab(config, 1) : null
    return createExcelWorkspace<IWorkbookData>({ sessionId: config.sessionId, tabs: tab ? [tab] : [], activeTabId: tab?.tabId ?? null })
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
    files: window.officeFiles,
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
  const [importProgress, setImportProgress] = useState<ExcelImportProgress | null>(null)
  const importControllerRef = useRef<AbortController | null>(null)
  const [pendingWorkbookOpenTickets, setPendingWorkbookOpenTickets] = useState<ExcelWorkbookOpenTicket[]>([])
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null)
  const autoSaveRef = useRef<ReturnType<typeof createOfficeAutoSave> | null>(null)
  const persistRef = useRef<(context: OfficeOperationContext) => Promise<void>>(async () => undefined)
  const automatic = Boolean(window.officeFiles?.prepare)
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
  const { t } = useTranslation(undefined, { i18n, lng: config.locale })
  const copy = t('excel.host', { returnObjects: true }) as Copy
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
          importControllerRef.current?.abort()
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
        if (recovered.tabs.length > 0 || !createInitialWorkbook) {
          workspace.replace(recovered.tabs, recovered.activeTabId)
          nextWorkbookOrdinal.current = recovered.nextWorkbookOrdinal
        }
      }
      setRecoveryFailure(null)
      setRecoveryLoaded(true)
    }).finally(() => {
      if (!disposed) setRecoveryRestoring(false)
    })
    return () => {
      disposed = true
    }
  }, [createInitialWorkbook, recovery, recoveryAttempt, workspace])

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
    if (recoveryLoaded) {
      void api.reportState({ documentCount: tabs.length, dirty: hasUnsaved })
        .catch((cause) => setError(errorMessage(cause)))
    }
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

  const activeRevision = activeTab?.revision
  const handleEditorChange = useCallback((snapshot: IWorkbookData) => {
    if (!activeTabId) return
    // A replaced native editor can emit its final snapshot while unmounting.
    updateTab(activeTabId, (current) => current.revision !== activeRevision ? current : ({
      ...current,
      snapshot,
      dirty: true,
      changeVersion: current.changeVersion + 1,
    }))
  }, [activeRevision, activeTabId, updateTab])

  const importOpenedWorkbook = useCallback(async (
    document: ExcelDocumentHandle,
    replaceInitialBlank: boolean,
    context: OfficeOperationContext,
  ) => {
    const { assertCurrent } = context
    await flushActiveEditor(assertCurrent)
    await persistRef.current(context)
    if (window.officeFiles?.prepare && document.source) {
      const source = await window.officeFiles.prepare('excel', document.source.path)
      const bytes = window.officeFiles.readBase64
        ? Uint8Array.from(atob(await window.officeFiles.readBase64('excel', source.path)), (character) => character.charCodeAt(0))
        : document.bytes
      document = { ...document, source, bytes, documentId: source.path, mtimeMs: source.mtimeMs!, fileName: source.path.split(/[\\/]/).pop()! }
      assertCurrent()
    }
    const existing = workspace.getState().tabs.find((tab) => (tab.documentId === document.documentId || (document.source && tab.source?.path === document.source.path)))
    if (existing) {
      if (existing.mtimeMs === document.mtimeMs) {
        workspace.activate(existing.tabId)
        return
      }
      if (existing.dirty) {
        workspace.activate(existing.tabId)
        throw new OfficeOperationError('source_conflict', copy.saveConflict)
      }
    }
    const controller = new AbortController()
    importControllerRef.current = controller
    setImportProgress({ phase: 'reading' })
    let snapshot: IWorkbookData
    try {
      snapshot = await importExcelWorkbook(document.bytes, univerLocale(config), {
        signal: controller.signal,
        onProgress: setImportProgress,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      throw error
    } finally {
      importControllerRef.current = null
      setImportProgress(null)
    }
    assertCurrent()
    await flushActiveEditor(assertCurrent)
    if (existing) {
      const current = workspace.getState().tabs.find((tab) => tab.tabId === existing.tabId)!
      // Native typing is not queued behind parsing; recheck after its final flush.
      if (current.dirty) {
        workspace.activate(current.tabId)
        throw new OfficeOperationError('source_conflict', copy.saveConflict)
      }
      updateTab(current.tabId, (tab) => ({
        ...tab, snapshot, fileName: document.fileName, mtimeMs: document.mtimeMs, source: document.source,
        revision: tab.revision + 1, changeVersion: tab.changeVersion + 1,
      }))
      workspace.activate(current.tabId)
      return
    }
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
  }, [config, copy.saveConflict, flushActiveEditor, updateTab, workspace])

  const addBlankTab = () => executeWorkspaceOperation('document.create', null, async (context) => {
    await flushActiveEditor(context.assertCurrent)
    await persistRef.current(context)
    setFormulaDialog(null)
    setInsertDialog(null)
    const tab = newWorkbookTab(config, nextWorkbookOrdinal.current)
    nextWorkbookOrdinal.current += 1
    workspace.replace([...workspace.getState().tabs, tab], tab.tabId)
    setError(null)
  })

  const openWorkbook = () => executeWorkspaceOperation('document.open', null, async (context) => {
    setFormulaDialog(null)
    setInsertDialog(null)
    setBusy('opening')
    setError(null)
    try {
      const result = await api.open()
      if (result.canceled) return
      await importOpenedWorkbook(result.document, false, context)
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
          if (!result.canceled) await importOpenedWorkbook(result.document, ticket.replaceInitialBlank, context)
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

  const persistWorkbookNow = useCallback(async (requestedTab: WorkbookTab, saveAs: boolean, context: OfficeOperationContext, destination?: string, background = false): Promise<boolean> => {
      if (!background && workspace.getState().activeTabId === requestedTab.tabId) await flushActiveEditor(context.assertCurrent)
      const state = workspace.getState()
      const tab = state.tabs.find((candidate) => candidate.tabId === requestedTab.tabId)!
      const snapshot = !background && tab.tabId === state.activeTabId && editorRef.current?.documentId === tab.tabId
        ? editorRef.current?.snapshot() ?? tab.snapshot
        : tab.snapshot
      const savedChangeVersion = tab.changeVersion
      if (!background) setBusy((current) => current ?? 'saving')
      setError(null)
      try {
        const incompatible = unsupportedWorkbookFeatures(snapshot)
        const outcome = await writeExcelWorkbookSource({
          api,
          files: window.officeFiles,
          tab,
          saveAs,
          destination,
          preserveSource: incompatible.length > 0,
          protectedSourceMessage: t('office.protectedSave'),
          conflictMessage: copy.saveConflict,
          assertCurrent: context.assertCurrent,
          prepare: async () => {
            const featureList = incompatible.join(', ')
            if (incompatible.length > 0 && !saveAs && !automatic) {
              throw new OfficeOperationError('unsupported_format', t('excel.host.lossyOverwrite', { features: featureList }))
            }
            if (incompatible.length > 0 && saveAs && !destination && !automatic
              && !window.confirm(t('excel.host.lossySaveAs', { features: featureList }))) return null
            return exportXlsx(snapshot, { allowLossy: automatic || saveAs })
          },
        })
        if (outcome.status === 'canceled') return false
        if (outcome.status === 'conflict') throw new OfficeOperationError('source_conflict', outcome.message)
        if (outcome.status === 'failed') {
          const message = outcome.error.code === 'unsupported_format'
            ? outcome.error.message
            : `${copy.saveFailed}: ${outcome.error.message}`
          throw new OfficeOperationError(outcome.error.code, message)
        }
        const result = outcome.value
        context.assertCurrent()
        // Background saves never finish a cell the user is still typing.
        if (!background) await flushActiveEditor(context.assertCurrent)
        const retainedDrafts = workspace.completeSave(tab.tabId, {
          changeVersion: savedChangeVersion,
          documentId: result.documentId,
          source: result.source,
          fileName: result.fileName,
          mtimeMs: result.mtimeMs,
          snapshot: incompatible.length > 0 && (automatic || saveAs)
            ? clearUnsupportedWorkbookFeatures(snapshot)
            : snapshot,
        }, (fileName) => t('excel.host.unsavedCopyName', { name: fileName.replace(/\.xlsx$/i, '') }))
        if (retainedDrafts.length > 0) {
          setNotice({ id: nextNoticeId.current++, message: t('excel.host.savedDraftsPreserved', { names: retainedDrafts.join(', ') }) })
        }
        return !workspace.getState().tabs.find((current) => current.tabId === tab.tabId)?.dirty
      } catch (cause) {
        if (cause instanceof OfficeOperationError) throw cause
        throw new Error(`${copy.saveFailed}: ${errorMessage(cause)}`)
      } finally {
        if (!background) setBusy((current) => current === 'saving' ? null : current)
      }
  }, [
    api,
    automatic,
    t,
    copy.saveConflict,
    copy.saveFailed,
    flushActiveEditor,
    workspace,
  ])

  useLayoutEffect(() => { persistRef.current = async (context) => {
    if (!automatic) return
    for (const tab of workspace.getState().tabs.filter((item) => item.dirty)) {
      if (!await persistWorkbookNow(tab, false, context)) throw new OfficeOperationError('save_incomplete', t('office.changedDuringClose'))
    }
  } }, [automatic, persistWorkbookNow, t, workspace])

  useEffect(() => {
    if (!automatic || !recoveryLoaded) return
    const autoSave = createOfficeAutoSave(async () => {
      const result = await runtime.execute({ sessionId: config.sessionId, capability: 'document.save' }, async (context) => {
        for (const tab of workspace.getState().tabs.filter((item) => item.dirty)) await persistWorkbookNow(tab, false, context, undefined, true)
      })
      if (!result.ok) throw new Error(result.error.message)
    }, (status, message) => setAutoSaveError(status === 'error' ? message ?? t('office.saveFailed') : null))
    autoSaveRef.current = autoSave
    const schedule = () => autoSave.schedule(workspace.getState().tabs.filter((tab) => tab.dirty).map((tab) => `${tab.tabId}:${tab.changeVersion}`).join('|'))
    const unsubscribe = workspace.subscribe(schedule)
    schedule()
    return () => { unsubscribe(); autoSave.dispose(); if (autoSaveRef.current === autoSave) autoSaveRef.current = null }
  }, [automatic, config.sessionId, persistWorkbookNow, recoveryLoaded, runtime, t, workspace])

  const persistWorkbook = useCallback((tab: WorkbookTab, saveAs: boolean) => executeWorkspaceOperation(saveAs ? 'document.saveAs' : 'document.save', tab.tabId, async (context) => { await persistWorkbookNow(tab, saveAs, context) }), [executeWorkspaceOperation, persistWorkbookNow])

  useEffect(() => {
    const flush = async () => {
      await runtime.whenIdle()
      await flushActiveEditor(() => undefined)
      await autoSaveRef.current?.flush()
      const state = workspace.getState()
      recovery.schedule({ version: 1, ...state, nextWorkbookOrdinal: nextWorkbookOrdinal.current })
      await recovery.flush()
    }
    const close = () => executeWorkspaceOperation('document.close', null, async (context) => {
      await flushActiveEditor(context.assertCurrent)
      const approved = new Map<string, number>()
      for (const candidate of workspace.getState().tabs) {
        await flushActiveEditor(context.assertCurrent)
        const tab = workspace.getState().tabs.find((item) => item.tabId === candidate.tabId)
        if (!tab) continue
        if (tab.dirty && !(automatic ? await persistWorkbookNow(tab, false, context) : await confirmOfficeClose(tab.fileName, () => persistWorkbookNow(tab, unsupportedWorkbookFeatures(tab.snapshot).length > 0, context)))) return
        approved.set(tab.tabId, workspace.getState().tabs.find((item) => item.tabId === tab.tabId)?.changeVersion ?? tab.changeVersion)
        context.assertCurrent()
      }
      await flushActiveEditor(context.assertCurrent)
      if (workspace.getState().tabs.some((tab) => tab.dirty && approved.get(tab.tabId) !== tab.changeVersion)) throw new Error(t('office.changedDuringClose'))
      workspace.replace([], null)
      recovery.schedule({ version: 1, tabs: [], activeTabId: null, nextWorkbookOrdinal: nextWorkbookOrdinal.current })
      await recovery.flush()
      await api.requestClose()
    })
    const domain = {
      sessionId: config.sessionId,
      workspace: { getSnapshot: runtime.getSnapshot, subscribe: runtime.subscribe, supports: runtime.supports },
      flush, close,
      dispatch: async (command: { type: string; documentId?: string; destination?: string }) => {
        if (!command || !['document.save', 'document.saveAs'].includes(command.type)) return { ok: false, error: { code: 'unsupported_command', message: 'Unsupported Excel command' } }
        if (command.destination !== undefined && (command.type !== 'document.saveAs' || typeof command.destination !== 'string' || !command.destination)) return { ok: false, error: { code: 'invalid_destination', message: 'Only Save as accepts a destination path' } }
        const tab = workspace.getState().tabs.find((item) => item.tabId === (command.documentId ?? workspace.getState().activeTabId))
        if (!tab) return { ok: false, error: { code: 'document_not_found', message: 'The workbook is not open' } }
        return runtime.execute({ sessionId: config.sessionId, capability: command.type, documentId: tab.tabId }, async (context) => {
          if (!await persistWorkbookNow(tab, command.type === 'document.saveAs', context, command.destination)) throw new OfficeOperationError('save_incomplete', 'The save was canceled or newer edits remain unsaved')
          return { saved: true }
        })
      },
    }
    window.__bridgicExcel = domain
    return () => { if (window.__bridgicExcel === domain) delete window.__bridgicExcel }
  }, [api, automatic, config.sessionId, executeWorkspaceOperation, flushActiveEditor, persistWorkbookNow, recovery, runtime, t, workspace])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 's' || !activeTab || !recoveryLoaded) return
      event.preventDefault()
      void persistWorkbook(activeTab, false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTab, persistWorkbook, recoveryLoaded])

  const closeTab = (requestedTab: WorkbookTab) => {
    void executeWorkspaceOperation('document.close', requestedTab.tabId, async (context) => {
      if (workspace.getState().activeTabId === requestedTab.tabId) await flushActiveEditor(context.assertCurrent)
      let state = workspace.getState()
      const tab = state.tabs.find((candidate) => candidate.tabId === requestedTab.tabId)!
      if (tab.dirty && !(automatic ? await persistWorkbookNow(tab, false, context) : await confirmOfficeClose(tab.fileName, () => persistWorkbookNow(tab, unsupportedWorkbookFeatures(tab.snapshot).length > 0, context)))) return
      context.assertCurrent()
      state = workspace.getState()
      setFormulaDialog(null)
      setInsertDialog(null)
      if (state.tabs.length === 1) {
        workspace.replace([], null)
        recovery.schedule({ version: 1, tabs: [], activeTabId: null, nextWorkbookOrdinal: nextWorkbookOrdinal.current })
        await recovery.flush()
        await api.requestClose()
        return
      }
      const index = state.tabs.findIndex((candidate) => candidate.tabId === tab.tabId)
      const nextActive = state.tabs[index + 1] ?? state.tabs[index - 1] ?? null
      workspace.replace(
        workspace.getState().tabs.filter((candidate) => candidate.tabId !== tab.tabId),
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

  if (!activeTab && recoveryLoaded && !recoveryFailure && !error && busy === null && pendingWorkbookOpenTickets.length === 0) {
    return <OfficeLaunchEmptyState kind="excel" onCreate={addBlankTab} onOpen={openWorkbook} />
  }

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-bg-surface text-text-primary">
      <OfficeDocumentTabs
        actions={activeTab ? <OfficeSaveActions error={autoSaveError} dirty={activeTab.dirty} disabled={!recoveryLoaded || busy !== null} onSave={(saveAs) => { void persistWorkbook(activeTab, saveAs) }} /> : undefined}
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
            await persistRef.current(context)
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

      {importProgress ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-app px-3 py-2 text-xs" role="status" aria-live="polite">
          <span className="min-w-0 flex-1">
            {importProgress.phase === 'reading'
              ? t('excel.host.importReading')
              : t('excel.host.importConverting', { completed: importProgress.completed, total: importProgress.total })}
          </span>
          <button className="shrink-0 underline underline-offset-2" onClick={() => importControllerRef.current?.abort()} type="button">
            {t('excel.host.importCancel')}
          </button>
        </div>
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
      {!activeTab && recoveryLoaded && (busy === 'opening' || pendingWorkbookOpenTickets.length > 0) ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-text-tertiary" role="status">
          {t('excel.host.importReading')}
        </div>
      ) : null}
      {!activeTab && recoveryLoaded && busy === null && pendingWorkbookOpenTickets.length === 0 ? (
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

declare global {
  interface Window {
    __bridgicExcel?: {
      sessionId: string
      workspace: import('../lib/office/officeWorkspaceRuntime').OfficeWorkspaceReader
      flush(): Promise<void>
      close(): Promise<unknown>
      dispatch(command: { type: string; documentId?: string; destination?: string }): Promise<unknown>
    }
  }
}
