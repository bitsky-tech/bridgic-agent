import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  BorderStyleTypes,
  BorderType,
  CommandType,
  LocaleType,
  LogLevel,
  Univer,
  mergeLocales,
  type IWorkbookData,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/lib/facade'
import {
  OpenConditionalFormattingOperator,
  UniverSheetsConditionalFormattingPreset,
} from '@univerjs/preset-sheets-conditional-formatting'
import conditionalFormattingEnUS from '@univerjs/preset-sheets-conditional-formatting/locales/en-US'
import conditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import {
  InsertFunctionOperation,
  MoreFunctionsOperation,
  SetBoldCommand,
  SetItalicCommand,
  SetStrikeThroughCommand,
  SetUnderlineCommand,
  UniverSheetsCorePreset,
} from '@univerjs/preset-sheets-core'
import coreEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import coreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import {
  UniverSheetsDataValidationPreset,
} from '@univerjs/preset-sheets-data-validation'
import dataValidationEnUS from '@univerjs/preset-sheets-data-validation/locales/en-US'
import dataValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN'
import {
  InsertFloatImageCommand,
  UniverSheetsDrawingPreset,
} from '@univerjs/preset-sheets-drawing'
import drawingEnUS from '@univerjs/preset-sheets-drawing/locales/en-US'
import drawingZhCN from '@univerjs/preset-sheets-drawing/locales/zh-CN'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import filterEnUS from '@univerjs/preset-sheets-filter/locales/en-US'
import filterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import sortEnUS from '@univerjs/preset-sheets-sort/locales/en-US'
import sortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import { defaultTheme } from '@univerjs/themes'
import type { ExcelHostConfig } from '../../shared/types'
import { Icons } from '../components/amphi/Icons'
import {
  clearUnsupportedWorkbookFeatures,
  createEmptyWorkbook,
  exportXlsx,
  importXlsx,
  unsupportedWorkbookFeatures,
} from '../lib/excelWorkbook'
import {
  ExcelRibbon,
  type ExcelRibbonAction,
  type ExcelRibbonTab,
} from './ExcelRibbon'
import {
  EXCEL_OPEN_SOURCE_FEATURES,
  EXCEL_SHEETS_UI_CONFIG,
  type ExcelOpenSourceFeature,
} from './excelUiConfig'

interface WorkbookTab {
  tabId: string
  documentId: string | null
  fileName: string
  snapshot: IWorkbookData
  mtimeMs: number | null
  dirty: boolean
  changeVersion: number
  revision: number
}

interface ExcelRecoveryState {
  version: 1
  tabs: WorkbookTab[]
  activeTabId: string | null
  nextWorkbookOrdinal: number
}

interface SheetEditorHandle {
  run(action: ExcelRibbonAction, value?: string | number): Promise<void>
  selectRange(address: string): void
  setFormulaBarValue(value: string): void
  snapshot(): IWorkbookData | null
}

interface SheetSelectionState {
  address: string
  value: string
}

type BusyAction = 'opening' | 'saving' | null

interface Copy {
  close: string
  closeUnsaved: string
  dismissError: string
  localOnly: string
  lossyOverwrite: string
  lossySaveAs: string
  new: string
  open: string
  openFailed: string
  save: string
  saveAs: string
  saveConflict: string
  saveFailed: string
  saved: string
  saving: string
  opening: string
  unsaved: string
  workbook: string
  emptyTitle: string
  emptyDetail: string
}

const COPY: Record<ExcelHostConfig['locale'], Copy> = {
  'en-US': {
    close: 'Close workbook',
    closeUnsaved: 'This workbook has unsaved changes. Close it and discard those changes?',
    dismissError: 'Dismiss error',
    localOnly: 'Local .xlsx files stay on this device.',
    lossyOverwrite: 'This file contains Excel objects that cannot be reproduced safely ({features}). The original will not be overwritten. Use Save as to create a simplified copy.',
    lossySaveAs: 'This workbook contains Excel objects that cannot be reproduced safely ({features}). Save a simplified copy without those objects?',
    new: 'New',
    open: 'Open',
    openFailed: 'Could not open this workbook',
    save: 'Save',
    saveAs: 'Save as',
    saveConflict: 'The file changed on disk. Use Save as to keep both versions.',
    saveFailed: 'Could not save this workbook',
    saved: 'Saved',
    saving: 'Saving…',
    opening: 'Opening…',
    unsaved: 'Unsaved changes',
    workbook: 'Workbook',
    emptyTitle: 'No workbook tabs',
    emptyDetail: 'Create a workbook or open an existing .xlsx file.',
  },
  'zh-CN': {
    close: '关闭工作簿',
    closeUnsaved: '此工作簿有未保存的更改。要关闭并放弃这些更改吗？',
    dismissError: '关闭错误提示',
    localOnly: '本地 .xlsx 文件只保留在此设备上。',
    lossyOverwrite: '此文件包含当前无法安全还原的 Excel 对象（{features}）。为保护原文件，不会执行覆盖保存；请使用“另存为”创建简化副本。',
    lossySaveAs: '此工作簿包含当前无法安全还原的 Excel 对象（{features}）。是否另存一个不含这些对象的简化副本？',
    new: '新建',
    open: '打开',
    openFailed: '无法打开此工作簿',
    save: '保存',
    saveAs: '另存为',
    saveConflict: '磁盘中的文件已被修改。请使用“另存为”保留两个版本。',
    saveFailed: '无法保存此工作簿',
    saved: '已保存',
    saving: '正在保存…',
    opening: '正在打开…',
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

function univerLocale(config: ExcelHostConfig): LocaleType {
  return config.locale === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US
}

type SheetsPreset = ReturnType<typeof UniverSheetsCorePreset>

const openSourcePresetFactories: Record<ExcelOpenSourceFeature, () => SheetsPreset> = {
  filter: UniverSheetsFilterPreset,
  sort: UniverSheetsSortPreset,
  'conditional-formatting': UniverSheetsConditionalFormattingPreset,
  'data-validation': () => UniverSheetsDataValidationPreset({
    showEditOnDropdown: true,
    showSearchOnDropdown: true,
  }),
  drawing: UniverSheetsDrawingPreset,
}

function createSheetsUniver(presets: SheetsPreset[], config: ConstructorParameters<typeof Univer>[0]) {
  const univer = new Univer({ logLevel: LogLevel.WARN, ...config })
  for (const preset of presets) {
    for (const plugin of preset.plugins) {
      if (Array.isArray(plugin)) univer.registerPlugin(plugin[0], plugin[1])
      else univer.registerPlugin(plugin)
    }
  }
  return { univer, univerAPI: FUniver.newAPI(univer) }
}

type SheetsUniverApi = ReturnType<typeof createSheetsUniver>['univerAPI']
const ADD_DATA_VALIDATION_AND_OPEN_COMMAND_ID = 'data-validation.command.addRuleAndOpen'
const CREATE_CONDITIONAL_FORMAT_RULE = 1

async function runSheetAction(univerAPI: SheetsUniverApi, action: ExcelRibbonAction, value?: string | number) {
  if (action === 'undo') {
    await univerAPI.undo()
    return
  }
  if (action === 'redo') {
    await univerAPI.redo()
    return
  }
  if (action === 'print') {
    window.print()
    return
  }

  const workbook = univerAPI.getActiveWorkbook()
  const sheet = workbook?.getActiveSheet()
  if (!workbook || !sheet) return
  const range = workbook.getActiveRange() ?? sheet.getRange('A1')

  switch (action) {
    case 'font-family':
      range.setFontFamily(String(value))
      break
    case 'font-size':
      range.setFontSize(Number(value))
      break
    case 'bold':
      await univerAPI.executeCommand(SetBoldCommand.id)
      break
    case 'italic':
      await univerAPI.executeCommand(SetItalicCommand.id)
      break
    case 'underline':
      await univerAPI.executeCommand(SetUnderlineCommand.id)
      break
    case 'strikethrough':
      await univerAPI.executeCommand(SetStrikeThroughCommand.id)
      break
    case 'font-color':
      range.setFontColor(String(value))
      break
    case 'fill-color':
      range.setBackgroundColor(String(value))
      break
    case 'borders':
      range.setBorder(BorderType.ALL, BorderStyleTypes.THIN, '#d1d5db')
      break
    case 'align-left':
      range.setHorizontalAlignment('left')
      break
    case 'align-center':
      range.setHorizontalAlignment('center')
      break
    case 'align-right':
      range.setHorizontalAlignment('normal')
      break
    case 'wrap':
      range.setWrap(!range.getWrap())
      break
    case 'merge-center':
      range.merge()
      range.setHorizontalAlignment('center')
      break
    case 'merge-cells':
      range.merge()
      break
    case 'merge-across':
      range.mergeAcross()
      break
    case 'unmerge':
      range.breakApart()
      break
    case 'number-format':
      range.setNumberFormat(String(value))
      break
    case 'percent':
      range.setNumberFormat('0.00%')
      break
    case 'currency':
      range.setNumberFormat('$#,##0.00')
      break
    case 'clear-format':
      range.clearFormat()
      break
    case 'insert-row-above':
      sheet.insertRowsBefore(range.getRow(), 1)
      break
    case 'insert-row-below':
      sheet.insertRowsAfter(range.getLastRow(), 1)
      break
    case 'insert-column-left':
      sheet.insertColumnsBefore(range.getColumn(), 1)
      break
    case 'insert-column-right':
      sheet.insertColumnsAfter(range.getLastColumn(), 1)
      break
    case 'insert-sheet':
      workbook.insertSheet()
      break
    case 'insert-image':
      await univerAPI.executeCommand(InsertFloatImageCommand.id)
      break
    case 'toggle-filter': {
      const filter = sheet.getFilter()
      if (filter) filter.remove()
      else range.createFilter()
      break
    }
    case 'clear-filter':
      sheet.getFilter()?.removeFilterCriteria()
      break
    case 'sort-ascending':
      range.sort({ column: 0, ascending: true })
      break
    case 'sort-descending':
      range.sort({ column: 0, ascending: false })
      break
    case 'data-validation':
      await univerAPI.executeCommand(ADD_DATA_VALIDATION_AND_OPEN_COMMAND_ID)
      break
    case 'conditional-formatting':
      await univerAPI.executeCommand(OpenConditionalFormattingOperator.id, {
        value: CREATE_CONDITIONAL_FORMAT_RULE,
      })
      break
    case 'formula-sum':
    case 'formula-average':
    case 'formula-count':
    case 'formula-max':
    case 'formula-min': {
      const formulaNames = {
        'formula-sum': 'SUM',
        'formula-average': 'AVERAGE',
        'formula-count': 'COUNT',
        'formula-max': 'MAX',
        'formula-min': 'MIN',
      } as const
      const target = sheet.getRange(range.getLastRow() + 1, range.getColumn())
      target.setFormula(`=${formulaNames[action]}(${range.getA1Notation()})`)
      sheet.setActiveRange(target)
      break
    }
    case 'formula-insert':
      await univerAPI.executeCommand(InsertFunctionOperation.id, { value: String(value) })
      break
    case 'formula-more':
      await univerAPI.executeCommand(MoreFunctionsOperation.id)
      break
    case 'toggle-gridlines':
      sheet.setHiddenGridlines(!sheet.hasHiddenGridLines())
      break
    case 'freeze-first-row':
      sheet.setFrozenRows(1)
      break
    case 'freeze-first-column':
      sheet.setFrozenColumns(1)
      break
    case 'unfreeze':
      sheet.setFrozenRows(0)
      sheet.setFrozenColumns(0)
      break
  }
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

function recoveryState(value: unknown): ExcelRecoveryState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<ExcelRecoveryState>
  if (candidate.version !== 1 || !Array.isArray(candidate.tabs)) return null
  if (!candidate.tabs.every((tab) => tab
    && typeof tab === 'object'
    && typeof tab.tabId === 'string'
    && typeof tab.fileName === 'string'
    && tab.snapshot
    && typeof tab.snapshot === 'object')) return null
  return {
    version: 1,
    tabs: candidate.tabs,
    activeTabId: typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null,
    nextWorkbookOrdinal: Number.isInteger(candidate.nextWorkbookOrdinal)
      ? Math.max(1, candidate.nextWorkbookOrdinal!)
      : candidate.tabs.length + 1,
  }
}

/** Workbook tabs for one Agent Session, all inside this single CDP target. */
export function ExcelHostApp() {
  const api = window.excelHostApi
  if (!api) throw new Error('Excel host preload is unavailable')
  const [config, setConfig] = useState(readConfig)
  const nextWorkbookOrdinal = useRef(2)
  const [tabs, setTabs] = useState<WorkbookTab[]>(() => [newWorkbookTab(readConfig(), 1)])
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.tabId ?? null)
  const [recoveryLoaded, setRecoveryLoaded] = useState(false)
  const [ribbonTab, setRibbonTab] = useState<ExcelRibbonTab>('home')
  const [selection, setSelection] = useState<SheetSelectionState>({ address: 'A1', value: '' })
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<SheetEditorHandle>(null)
  const copy = COPY[config.locale]
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.tabId === activeTabId) ?? null,
    [activeTabId, tabs],
  )

  useEffect(() => api.onConfigChanged((next) => {
    if (next.sessionId === config.sessionId) setConfig(next)
  }), [api, config.sessionId])

  useEffect(() => {
    let disposed = false
    void api.getRecoveryState().then((value) => {
      if (disposed) return
      const recovered = recoveryState(value)
      if (recovered) {
        setTabs(recovered.tabs)
        setActiveTabId(recovered.tabs.some((tab) => tab.tabId === recovered.activeTabId)
          ? recovered.activeTabId
          : recovered.tabs[0]?.tabId ?? null)
        nextWorkbookOrdinal.current = recovered.nextWorkbookOrdinal
      }
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause))
    }).finally(() => {
      if (!disposed) setRecoveryLoaded(true)
    })
    return () => {
      disposed = true
    }
  }, [api])

  useEffect(() => {
    document.documentElement.dataset.theme = config.theme
    document.documentElement.lang = config.locale
    document.title = `Excel · ${config.sessionId}`
  }, [config])

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
    const timeout = window.setTimeout(() => {
      const state: ExcelRecoveryState = {
        version: 1,
        tabs,
        activeTabId,
        nextWorkbookOrdinal: nextWorkbookOrdinal.current,
      }
      void api.setRecoveryState(state).catch((cause) => setError(errorMessage(cause)))
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [activeTabId, api, recoveryLoaded, tabs])

  const updateTab = useCallback((tabId: string, update: (current: WorkbookTab) => WorkbookTab) => {
    setTabs((current) => current.map((tab) => tab.tabId === tabId ? update(tab) : tab))
  }, [])

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

  const addBlankTab = () => {
    const tab = newWorkbookTab(config, nextWorkbookOrdinal.current)
    nextWorkbookOrdinal.current += 1
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.tabId)
    setError(null)
  }

  const openWorkbook = async () => {
    setBusy('opening')
    setError(null)
    try {
      const result = await api.open()
      if (result.canceled) return
      const snapshot = await importXlsx(result.document.bytes, univerLocale(config))
      const tab: WorkbookTab = {
        tabId: crypto.randomUUID(),
        documentId: result.document.documentId,
        fileName: result.document.fileName,
        snapshot,
        mtimeMs: result.document.mtimeMs,
        dirty: false,
        changeVersion: 0,
        revision: 0,
      }
      setTabs((current) => [...current, tab])
      setActiveTabId(tab.tabId)
    } catch (cause) {
      setError(`${copy.openFailed}: ${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const persistWorkbook = useCallback(async (tab: WorkbookTab, saveAs: boolean) => {
    const snapshot = tab.tabId === activeTabId
      ? editorRef.current?.snapshot() ?? tab.snapshot
      : tab.snapshot
    const savedChangeVersion = tab.changeVersion
    setBusy('saving')
    setError(null)
    try {
      const incompatible = unsupportedWorkbookFeatures(snapshot)
      const featureList = incompatible.join(', ')
      if (incompatible.length > 0 && !saveAs) {
        setError(copy.lossyOverwrite.replace('{features}', featureList))
        return
      }
      if (incompatible.length > 0 && saveAs
        && !window.confirm(copy.lossySaveAs.replace('{features}', featureList))) return
      const bytes = await exportXlsx(snapshot, { allowLossy: saveAs })
      const result = saveAs || !tab.documentId || tab.mtimeMs === null
        ? await api.saveAs({ bytes, suggestedName: tab.fileName })
        : await api.save({
          documentId: tab.documentId,
          bytes,
          expectedMtimeMs: tab.mtimeMs,
        })
      if (!result.ok) {
        if (result.reason === 'conflict') setError(copy.saveConflict)
        return
      }
      updateTab(tab.tabId, (current) => {
        const changedWhileSaving = current.changeVersion !== savedChangeVersion
        const savedSnapshot = incompatible.length > 0 && saveAs
          ? clearUnsupportedWorkbookFeatures(snapshot)
          : snapshot
        return {
          ...current,
          documentId: result.documentId,
          fileName: result.fileName,
          snapshot: changedWhileSaving ? current.snapshot : savedSnapshot,
          mtimeMs: result.mtimeMs,
          dirty: changedWhileSaving,
        }
      })
    } catch (cause) {
      setError(`${copy.saveFailed}: ${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }, [
    activeTabId,
    api,
    copy.lossyOverwrite,
    copy.lossySaveAs,
    copy.saveConflict,
    copy.saveFailed,
    updateTab,
  ])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 's' || !activeTab) return
      event.preventDefault()
      void persistWorkbook(activeTab, event.shiftKey)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTab, persistWorkbook])

  const closeTab = (tab: WorkbookTab) => {
    if (tab.dirty && !window.confirm(copy.closeUnsaved)) return
    if (tabs.length === 1) {
      void api.closeSession().catch((cause) => setError(errorMessage(cause)))
      return
    }
    const index = tabs.findIndex((candidate) => candidate.tabId === tab.tabId)
    const nextActive = tabs[index + 1] ?? tabs[index - 1] ?? null
    setTabs((current) => current.filter((candidate) => candidate.tabId !== tab.tabId))
    if (activeTabId === tab.tabId) setActiveTabId(nextActive?.tabId ?? null)
  }

  const runRibbonAction = useCallback((action: ExcelRibbonAction, value?: string | number) => {
    void editorRef.current?.run(action, value).catch((cause) => setError(errorMessage(cause)))
  }, [])
  const selectFormulaRange = useCallback((address: string) => {
    try {
      editorRef.current?.selectRange(address)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  const setFormulaBarValue = useCallback((value: string) => {
    try {
      editorRef.current?.setFormulaBarValue(value)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])

  let status = activeTab?.dirty ? copy.unsaved : copy.saved
  if (busy === 'opening') status = copy.opening
  else if (busy === 'saving') status = copy.saving

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-bg-surface text-text-primary">
      <header className="flex h-10 shrink-0 items-end gap-1 border-b border-border-subtle bg-bg-app px-2">
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.tabId}
              className={`group flex h-8 max-w-56 shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11px] ${tab.tabId === activeTabId ? 'border-border-subtle bg-bg-surface text-text-primary' : 'border-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}`}
            >
              <button
                aria-selected={tab.tabId === activeTabId}
                className="flex min-w-0 flex-1 items-center gap-1"
                onClick={() => setActiveTabId(tab.tabId)}
                role="tab"
                type="button"
              >
                <span className="flex shrink-0 text-emerald-600">{Icons.spreadsheet(12)}</span>
                <span className="truncate">{tab.fileName}</span>
                {tab.dirty ? <span aria-label={copy.unsaved} className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
              </button>
              <button
                aria-label={`${copy.close}: ${tab.fileName}`}
                className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-50 hover:bg-black/10 hover:opacity-100"
                onClick={() => closeTab(tab)}
                type="button"
              >
                {Icons.x(11)}
              </button>
            </div>
          ))}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-1 pb-1">
          <HostButton disabled={busy !== null} label={copy.new} onClick={addBlankTab}>{Icons.plus(13)} {copy.new}</HostButton>
          <HostButton disabled={busy !== null} label={copy.open} onClick={() => void openWorkbook()}>{Icons.folder(13)} {copy.open}</HostButton>
          {activeTab ? (
            <>
              <HostButton disabled={busy !== null} label={copy.save} onClick={() => void persistWorkbook(activeTab, false)}>{Icons.save(13)} {copy.save}</HostButton>
              <HostButton disabled={busy !== null} label={copy.saveAs} onClick={() => void persistWorkbook(activeTab, true)}>{Icons.download(13)} {copy.saveAs}</HostButton>
            </>
          ) : null}
          <span className="ml-1 max-w-32 truncate text-[10px] text-text-tertiary">{activeTab ? status : copy.localOnly}</span>
        </div>
      </header>

      {activeTab ? (
        <ExcelRibbon
          activeTab={ribbonTab}
          disabled={busy !== null}
          locale={config.locale}
          onAction={runRibbonAction}
          onActiveTabChange={setRibbonTab}
          onAddressSubmit={selectFormulaRange}
          onFormulaSubmit={setFormulaBarValue}
          selectionAddress={selection.address}
          selectionValue={selection.value}
        />
      ) : null}

      {error ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-status-error/20 bg-status-error/10 px-3 py-2 text-xs text-status-error" role="alert">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button aria-label={copy.dismissError} className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setError(null)} type="button">{Icons.x(13)}</button>
        </div>
      ) : null}

      {activeTab ? (
        <UniverSheetEditor
          key={`${activeTab.tabId}:${activeTab.revision}`}
          ref={editorRef}
          config={config}
          onChange={handleEditorChange}
          onSelectionChange={setSelection}
          snapshot={activeTab.snapshot}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">{Icons.spreadsheet(30)}</span>
          <h1 className="text-sm font-semibold">{copy.emptyTitle}</h1>
          <p className="mt-1 text-xs text-text-tertiary">{copy.emptyDetail}</p>
          <div className="mt-4 flex gap-2">
            <HostButton label={copy.new} onClick={addBlankTab}>{Icons.plus(13)} {copy.new}</HostButton>
            <HostButton label={copy.open} onClick={() => void openWorkbook()}>{Icons.folder(13)} {copy.open}</HostButton>
          </div>
        </div>
      )}
    </main>
  )
}

const UniverSheetEditor = forwardRef<SheetEditorHandle, {
  config: ExcelHostConfig
  onChange: (snapshot: IWorkbookData) => void
  onSelectionChange: (selection: SheetSelectionState) => void
  snapshot: IWorkbookData
}>(function UniverSheetEditor({ config, onChange, onSelectionChange, snapshot }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<ReturnType<typeof createSheetsUniver>['univerAPI'] | null>(null)
  const snapshotRef = useRef(snapshot)

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useImperativeHandle(ref, () => ({
    run: (action, value) => {
      const univerAPI = apiRef.current
      if (!univerAPI) return Promise.resolve()
      return runSheetAction(univerAPI, action, value)
    },
    selectRange: (address) => {
      const sheet = apiRef.current?.getActiveWorkbook()?.getActiveSheet()
      if (!sheet || !address) return
      sheet.setActiveRange(sheet.getRange(address))
    },
    setFormulaBarValue: (value) => {
      const workbook = apiRef.current?.getActiveWorkbook()
      const sheet = workbook?.getActiveSheet()
      if (!workbook || !sheet) return
      const range = workbook.getActiveRange() ?? sheet.getRange('A1')
      if (value.startsWith('=')) range.setFormula(value)
      else {
        const trimmed = value.trim()
        const numericValue = trimmed === '' ? null : Number(trimmed)
        range.setValue(numericValue !== null && Number.isFinite(numericValue) ? numericValue : value)
      }
    },
    snapshot: () => apiRef.current?.getActiveWorkbook()?.getSnapshot() ?? snapshotRef.current,
  }), [])

  useEffect(() => {
    const container = hostRef.current
    if (!container) return
    const locale = univerLocale(config)
    const { univer, univerAPI } = createSheetsUniver([
      UniverSheetsCorePreset({
        container,
        ...EXCEL_SHEETS_UI_CONFIG,
      }),
      ...EXCEL_OPEN_SOURCE_FEATURES.map((feature) => openSourcePresetFactories[feature]()),
    ], {
      darkMode: config.theme === 'dark',
      locale,
      locales: {
        [LocaleType.EN_US]: mergeLocales(
          coreEnUS,
          filterEnUS,
          sortEnUS,
          conditionalFormattingEnUS,
          dataValidationEnUS,
          drawingEnUS,
        ),
        [LocaleType.ZH_CN]: mergeLocales(
          coreZhCN,
          filterZhCN,
          sortZhCN,
          conditionalFormattingZhCN,
          dataValidationZhCN,
          drawingZhCN,
        ),
      },
      theme: defaultTheme,
    })
    apiRef.current = univerAPI
    univerAPI.createWorkbook(snapshotRef.current)
    let disposed = false
    let snapshotPending = false
    const publishSelection = () => {
      const workbook = univerAPI.getActiveWorkbook()
      const sheet = workbook?.getActiveSheet()
      const range = workbook?.getActiveRange() ?? sheet?.getRange('A1')
      if (!range) return
      const formula = range.getFormula()
      const value = range.getValue()
      onSelectionChange({
        address: range.getA1Notation(),
        value: formula || (value === null ? '' : String(value)),
      })
    }
    const publishSnapshot = () => {
      if (snapshotPending) return
      snapshotPending = true
      queueMicrotask(() => {
        snapshotPending = false
        if (disposed) return
        const current = univerAPI.getActiveWorkbook()?.getSnapshot()
        if (current) onChange(current)
      })
    }
    queueMicrotask(publishSelection)
    const selectionChanged = univerAPI.addEvent(univerAPI.Event.SelectionChanged, publishSelection)
    const valuesChanged = univerAPI.addEvent(univerAPI.Event.SheetValueChanged, () => {
      publishSelection()
      publishSnapshot()
    })
    const workbookChanged = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      if (event.type === CommandType.MUTATION) publishSnapshot()
    })
    const observer = new ResizeObserver(() => {
      univerAPI.getActiveWorkbook()?.getActiveSheet()?.refreshCanvas()
    })
    observer.observe(container)
    return () => {
      disposed = true
      observer.disconnect()
      selectionChanged.dispose()
      valuesChanged.dispose()
      workbookChanged.dispose()
      apiRef.current = null
      univer.dispose()
      container.replaceChildren()
    }
  }, [config, onChange, onSelectionChange])

  return <div className="min-h-0 min-w-0 flex-1 overflow-hidden" ref={hostRef} data-testid="excel-univer-host" />
})

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
