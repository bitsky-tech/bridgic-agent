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
  Dimension,
  ImageSourceType,
  InterceptorEffectEnum,
  LocaleType,
  LogLevel,
  ThemeService,
  Univer,
  mergeLocales,
  type IRange,
  type IWorkbookData,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/lib/facade'
import { FormulaResultStatus, RegisterOtherFormulaService } from '@univerjs/engine-formula'
import {
  INTERCEPTOR_POINT,
  SheetInterceptorService,
} from '@univerjs/sheets'
import {
  OpenConditionalFormattingOperator,
  UniverSheetsConditionalFormattingPreset,
} from '@univerjs/preset-sheets-conditional-formatting'
import conditionalFormattingEnUS from '@univerjs/preset-sheets-conditional-formatting/locales/en-US'
import conditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import {
  InsertColMutation,
  InsertRowMutation,
  RemoveColMutation,
  RemoveRowMutation,
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
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import hyperLinkEnUS from '@univerjs/preset-sheets-hyper-link/locales/en-US'
import hyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import sortEnUS from '@univerjs/preset-sheets-sort/locales/en-US'
import sortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import { defaultTheme } from '@univerjs/themes'
import type { ExcelHostConfig } from '../../shared/types'
import { Icons } from '../components/amphi/Icons'
import {
  EXCEL_SHOW_ZEROS_CUSTOM_KEY,
  clearUnsupportedWorkbookFeatures,
  createEmptyWorkbook,
  excelSheetShowsZeros,
  exportXlsx,
  importXlsx,
  unsupportedWorkbookFeatures,
} from '../lib/excelWorkbook'
import {
  ExcelRibbon,
  type ExcelHighlightMode,
  type ExcelRibbonAction,
  type ExcelRibbonTab,
  type ExcelViewState,
} from './ExcelRibbon'
import {
  ExcelDataOperationError,
  detectTableFooterRows,
  detectTableHeaderOffset,
  excelDataOperationMessage,
  resolveFilterTarget,
  resolveSortTarget,
} from './excelDataOperations'
import {
  ExcelHyperlinkDialog,
  ExcelPivotTableDialog,
} from './ExcelInsertDialogs'
import { ExcelFormulaWizardDialog } from './ExcelFormulaWizardDialog'
import { rememberFormula } from './excelFormulaCatalog'
import { formulaPreviewResult, type ExcelFormulaPreviewResult } from './excelFormulaWizard'
import {
  contiguousDataStart,
  quickFormulaExpression,
  quickFormulaTargets,
  type ExcelQuickFormulaName,
} from './excelQuickFormula'
import {
  buildChartSvg,
  buildEmptyChartSvg,
  buildPivotTable,
  excelInsertValidationMessage,
  svgDataUrl,
  type ExcelChartType,
  type ExcelCellValue,
  type ExcelHyperlinkOptions,
  type ExcelInsertContext,
  type ExcelPivotOptions,
  type ExcelPivotResult,
  type ExcelRibbonActionValue,
} from './excelInsert'
import {
  rangesIntersect,
  readLiveAnalysis,
  updateLiveAnalysisForStructureChange,
  upsertLiveBinding,
  withLiveAnalysis,
  type ExcelLiveAnalysisBinding,
  type ExcelLivePivotBinding,
  type ExcelLiveStructureChange,
} from './excelLiveAnalysis'
import { adjustDecimalPlaces } from './excelNumberFormat'
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
  insertContext(expandDataRegion: boolean): ExcelInsertContext | null
  previewFormula(sheetId: string, address: string, formula: string): Promise<ExcelFormulaPreviewResult>
  run(action: ExcelRibbonAction, value?: ExcelRibbonActionValue): Promise<void>
  selectRange(address: string): void
  setFormulaAt(sheetId: string, address: string, formula: string): void
  setFormulaBarValue(value: string): void
  snapshot(): IWorkbookData | null
}

interface SheetSelectionState {
  address: string
  sheetId: string
  sheetName: string
  targetAddress: string
  value: string
}

type ExcelViewPreferences = Pick<ExcelViewState, 'highlightMode'>

type BusyAction = 'opening' | 'saving' | null
type InsertDialogState = { kind: 'hyperlink' | 'pivot'; context: ExcelInsertContext } | null
interface FormulaDialogState {
  initialFormula: string
  sheetId: string
  sheetName: string
  tabId: string
  targetAddress: string
}
type OperationNotice = { id: number; message: string } | null
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
  closeUnsaved: string
  dismissError: string
  dismissNotice: string
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
    dismissNotice: 'Dismiss message',
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
    dismissNotice: '关闭操作提示',
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
  hyperlink: UniverSheetsHyperLinkPreset,
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
type SheetsWorkbook = NonNullable<ReturnType<SheetsUniverApi['getActiveWorkbook']>>
type SheetsWorksheet = ReturnType<SheetsWorkbook['getActiveSheet']>
type SheetsRange = ReturnType<SheetsWorksheet['getRange']>
const ADD_DATA_VALIDATION_AND_OPEN_COMMAND_ID = 'data-validation.command.addRuleAndOpen'
const CREATE_CONDITIONAL_FORMAT_RULE = 1
const CHART_TYPES = new Set<ExcelChartType>(['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'])

class SheetViewController {
  private highlightDisposable: { dispose(): void } | null = null
  private highlightMode: ExcelHighlightMode
  private showZeros: boolean
  private readonly zeroValueDisposable: { dispose(): void }

  constructor(
    private readonly univer: Univer,
    private readonly univerAPI: SheetsUniverApi,
    preferences: ExcelViewPreferences,
    private readonly onStateChange: (state: ExcelViewState) => void,
    private readonly onSnapshotChange: (snapshot: IWorkbookData) => void,
  ) {
    this.highlightMode = preferences.highlightMode
    this.showZeros = this.readShowZeros()
    this.zeroValueDisposable = univer.__getInjector().get(SheetInterceptorService).intercept(
      INTERCEPTOR_POINT.CELL_CONTENT,
      {
        effect: InterceptorEffectEnum.Style,
        priority: 100,
        handler: (cell, _location, next) => {
          const resolved = next(cell)
          if (this.showZeros || resolved?.v !== 0) return resolved
          return {
            ...resolved,
            fontRenderExtension: {
              ...resolved.fontRenderExtension,
              isSkip: true,
            },
          }
        },
      },
    )
  }

  dispose() {
    this.highlightDisposable?.dispose()
    this.highlightDisposable = null
    this.zeroValueDisposable.dispose()
  }

  publish() {
    const sheet = this.univerAPI.getActiveWorkbook()?.getActiveSheet()
    if (!sheet) return
    this.showZeros = this.readShowZeros()
    this.onStateChange({
      darkMode: this.univer.__getInjector().get(ThemeService).darkMode,
      gridlines: !sheet.hasHiddenGridLines(),
      highlightMode: this.highlightMode,
      showZeros: this.showZeros,
      zoom: sheet.getZoom(),
    })
  }

  selectionChanged() {
    this.showZeros = this.readShowZeros()
    this.renderHighlight()
    this.publish()
  }

  setHighlightMode(mode: ExcelHighlightMode) {
    this.highlightMode = mode
    this.renderHighlight()
    this.publish()
  }

  toggleZeroValues() {
    const workbook = this.univerAPI.getActiveWorkbook()
    const sheet = workbook?.getActiveSheet()
    if (!workbook || !sheet) return
    this.showZeros = !this.readShowZeros()
    const current = sheet.getCustomMetadata()
    const custom = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}
    if (this.showZeros) delete custom[EXCEL_SHOW_ZEROS_CUSTOM_KEY]
    else custom[EXCEL_SHOW_ZEROS_CUSTOM_KEY] = false
    sheet.setCustomMetadata(Object.keys(custom).length > 0 ? custom : undefined)
    sheet.refreshCanvas()
    this.onSnapshotChange(workbook.getSnapshot())
    this.publish()
  }

  private readShowZeros(): boolean {
    return excelSheetShowsZeros(this.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getCustomMetadata())
  }

  private renderHighlight() {
    this.highlightDisposable?.dispose()
    this.highlightDisposable = null
    if (this.highlightMode === 'none') return
    const workbook = this.univerAPI.getActiveWorkbook()
    const sheet = workbook?.getActiveSheet()
    const range = workbook?.getActiveRange()
    if (!sheet || !range) return
    const ranges = []
    if (this.highlightMode === 'row' || this.highlightMode === 'both') {
      ranges.push(sheet.getRange(range.getRow(), 0, 1, sheet.getMaxColumns()))
    }
    if (this.highlightMode === 'column' || this.highlightMode === 'both') {
      ranges.push(sheet.getRange(0, range.getColumn(), sheet.getMaxRows(), 1))
    }
    this.highlightDisposable = sheet.highlightRanges(ranges, {
      fill: 'rgba(59, 130, 246, 0.08)',
      stroke: 'rgba(59, 130, 246, 0.22)',
      strokeWidth: 1,
    })
  }
}

function insertQuickFormula(sheet: SheetsWorksheet, selectedRange: SheetsRange, formulaName: ExcelQuickFormulaName) {
  const selection = selectedRange.getRange()
  const isSingleCell = selection.startRow === selection.endRow && selection.startColumn === selection.endColumn
  if (isSingleCell && selectedRange.isBlank()) {
    const row = selection.startRow
    const column = selection.startColumn
    if (row > 0) {
      const valuesAbove = sheet.getRange(0, column, row, 1).getValues().map((values) => values[0])
      const startRow = contiguousDataStart(valuesAbove)
      if (startRow !== null) {
        const source = sheet.getRange(startRow, column, row - startRow, 1)
        selectedRange.setFormula(quickFormulaExpression(formulaName, source.getA1Notation()))
        sheet.setActiveRange(selectedRange)
        return
      }
    }
    if (column > 0) {
      const valuesLeft = sheet.getRange(row, 0, 1, column).getValues()[0] ?? []
      const startColumn = contiguousDataStart(valuesLeft)
      if (startColumn !== null) {
        const source = sheet.getRange(row, startColumn, 1, column - startColumn)
        selectedRange.setFormula(quickFormulaExpression(formulaName, source.getA1Notation()))
        sheet.setActiveRange(selectedRange)
        return
      }
    }
    selectedRange.setFormula(quickFormulaExpression(formulaName, ''))
    sheet.setActiveRange(selectedRange)
    return
  }

  const targets = quickFormulaTargets(selection)
  const lastTargetRow = Math.max(...targets.map((target) => target.target.endRow))
  const lastTargetColumn = Math.max(...targets.map((target) => target.target.endColumn))
  if (lastTargetRow >= sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows() - 1, lastTargetRow - sheet.getMaxRows() + 1)
  }
  if (lastTargetColumn >= sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(sheet.getMaxColumns() - 1, lastTargetColumn - sheet.getMaxColumns() + 1)
  }
  for (const target of targets) {
    const source = sheet.getRange(
      target.source.startRow,
      target.source.startColumn,
      target.source.endRow - target.source.startRow + 1,
      target.source.endColumn - target.source.startColumn + 1,
    )
    sheet.getRange(target.target.startRow, target.target.startColumn)
      .setFormula(quickFormulaExpression(formulaName, source.getA1Notation()))
  }
  const first = targets[0]!.target
  const last = targets.at(-1)!.target
  sheet.setActiveRange(sheet.getRange(
    first.startRow,
    first.startColumn,
    last.endRow - first.startRow + 1,
    last.endColumn - first.startColumn + 1,
  ))
}

async function calculateFormulaPreview(
  univer: Univer,
  univerAPI: SheetsUniverApi,
  sheetId: string,
  address: string,
  formula: string,
): Promise<ExcelFormulaPreviewResult> {
  const workbook = univerAPI.getActiveWorkbook()
  const sheet = workbook?.getSheetBySheetId(sheetId)
  if (!workbook || !sheet) return { errorCode: '#REF!' }
  const selected = sheet.getRange(address).getRange()
  const target = {
    startRow: selected.startRow,
    endRow: selected.startRow,
    startColumn: selected.startColumn,
    endColumn: selected.startColumn,
  }
  const service = univer.__getInjector().get(RegisterOtherFormulaService)
  const formulaId = service.registerFormulaWithRange(
    workbook.getId(),
    sheetId,
    formula,
    [target],
    undefined,
    undefined,
    'excel-formula-preview',
  )
  let timeout: number | null = null
  try {
    const result = await Promise.race([
      service.getFormulaValue(workbook.getId(), sheetId, formulaId),
      new Promise<null>((resolve) => {
        timeout = window.setTimeout(() => resolve(null), 2500)
      }),
    ])
    if (!result || result.status !== FormulaResultStatus.SUCCESS) return { errorCode: '#ERROR!' }
    return formulaPreviewResult(result.result?.[0]?.[0])
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
    service.deleteFormula(workbook.getId(), sheetId, [formulaId])
  }
}

function insertContext(univerAPI: SheetsUniverApi, expandDataRegion: boolean): ExcelInsertContext | null {
  const workbook = univerAPI.getActiveWorkbook()
  const sheet = workbook?.getActiveSheet()
  if (!workbook || !sheet) return null
  const selection = workbook.getActiveRange() ?? sheet.getRange('A1')
  const range = expandDataRegion
    && selection.getRow() === selection.getLastRow()
    && selection.getColumn() === selection.getLastColumn()
    ? selection.getDataRegion()
    : selection
  const values = range.getValues().map((row) => row.map((cell): ExcelCellValue => {
    if (cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell
    return String(cell)
  }))
  return { address: range.getA1Notation(), values }
}

async function chartPng(svg: string): Promise<string> {
  const image = new window.Image()
  image.src = svgDataUrl(svg)
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 720
  canvas.height = 420
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Chart rendering is unavailable in this window.')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function isHyperlinkOptions(value: ExcelRibbonActionValue | undefined): value is ExcelHyperlinkOptions {
  return Boolean(value && typeof value === 'object'
    && 'url' in value && typeof value.url === 'string'
    && 'label' in value && typeof value.label === 'string')
}

function isPivotOptions(value: ExcelRibbonActionValue | undefined): value is ExcelPivotOptions {
  return Boolean(value && typeof value === 'object'
    && 'sourceAddress' in value && typeof value.sourceAddress === 'string'
    && 'rowField' in value && typeof value.rowField === 'number'
    && 'valueField' in value && typeof value.valueField === 'number'
    && 'aggregate' in value && typeof value.aggregate === 'string')
}

function uniqueSheetName(workbook: NonNullable<ReturnType<SheetsUniverApi['getActiveWorkbook']>>, base: string): string {
  const names = new Set(workbook.getSheets().map((sheet) => sheet.getSheetName()))
  if (!names.has(base)) return base
  let ordinal = 2
  while (names.has(`${base} ${ordinal}`)) ordinal += 1
  return `${base} ${ordinal}`
}

interface LiveAnalysisController {
  dispose(): void
  register(binding: ExcelLiveAnalysisBinding): void
  schedule(changes: Array<{ range: IRange; sheetId: string }>): void
  structureChanged(change: ExcelLiveStructureChange): void
}

function liveStructureChange(commandId: string, params: unknown): ExcelLiveStructureChange | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const candidate = params as { range?: Partial<IRange>; subUnitId?: unknown }
  const range = candidate.range
  if (!range || typeof candidate.subUnitId !== 'string') return null
  let axis: ExcelLiveStructureChange['axis']
  let kind: ExcelLiveStructureChange['kind']
  if (commandId === InsertRowMutation.id) {
    axis = 'row'
    kind = 'insert'
  } else if (commandId === RemoveRowMutation.id) {
    axis = 'row'
    kind = 'remove'
  } else if (commandId === InsertColMutation.id) {
    axis = 'column'
    kind = 'insert'
  } else if (commandId === RemoveColMutation.id) {
    axis = 'column'
    kind = 'remove'
  } else return null
  const start = axis === 'row' ? range.startRow : range.startColumn
  const end = axis === 'row' ? range.endRow : range.endColumn
  if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 0 || Number(end) < Number(start)) return null
  return {
    axis,
    kind,
    range: {
      startRow: Number(range.startRow ?? 0),
      endRow: Number(range.endRow ?? 0),
      startColumn: Number(range.startColumn ?? 0),
      endColumn: Number(range.endColumn ?? 0),
    },
    sheetId: candidate.subUnitId,
  }
}

function rangeValues(sheet: SheetsWorksheet, address: string): ExcelCellValue[][] {
  return sheet.getRange(address).getValues().map((row) => row.map((cell): ExcelCellValue => {
    if (cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell
    return String(cell)
  }))
}

function ensureSheetSize(sheet: SheetsWorksheet, rowCount: number, columnCount: number) {
  if (rowCount > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows() - 1, rowCount - sheet.getMaxRows())
  }
  if (columnCount > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(sheet.getMaxColumns() - 1, columnCount - sheet.getMaxColumns())
  }
}

function renderPivotResult(target: SheetsWorksheet, pivot: ExcelPivotResult, previousRows: number, previousColumns: number) {
  const rowCount = pivot.values.length
  const columnCount = Math.max(...pivot.values.map((row) => row.length))
  ensureSheetSize(target, Math.max(previousRows, rowCount), Math.max(previousColumns, columnCount))
  target.getRange(0, 0, Math.max(previousRows, rowCount), Math.max(previousColumns, columnCount)).clear()
  const targetRange = target.getRange(0, 0, rowCount, columnCount)
  targetRange.setValues(pivot.values.map((row) => row.map((cell) => cell ?? '')))
  targetRange.setBorder(BorderType.ALL, BorderStyleTypes.THIN, '#dfe3e8')
  target.getRange(0, 0, 1, columnCount)
    .setBackgroundColor('#DDF4EA')
    .setFontColor('#165C46')
    .setFontWeight('bold')
  target.getRange(rowCount - 1, 0, 1, columnCount)
    .setBackgroundColor('#F1F5F4')
    .setFontWeight('bold')
  target.getRange(1, 0, Math.max(1, rowCount - 2), 1).setFontWeight('bold')
  if (columnCount > pivot.numericStartColumn) {
    target.getRange(1, pivot.numericStartColumn, Math.max(1, rowCount - 1), columnCount - pivot.numericStartColumn)
      .setNumberFormat('#,##0.00')
  }
  target.setColumnWidth(0, 150)
  if (columnCount > 1) target.setColumnWidths(1, columnCount - 1, 96)
  target.setRowHeight(0, 28)
  return { columnCount, rowCount, targetRange }
}

function renderPivotMessage(target: SheetsWorksheet, message: string, previousRows: number, previousColumns: number) {
  ensureSheetSize(target, Math.max(1, previousRows), Math.max(1, previousColumns))
  target.getRange(0, 0, Math.max(1, previousRows), Math.max(1, previousColumns)).clear()
  target.getRange('A1')
    .setValue(message)
    .setBackgroundColor('#FFF7E6')
    .setFontColor('#8A5A00')
    .setFontWeight('bold')
  target.setColumnWidth(0, 360)
}

function createLiveAnalysisController(
  univerAPI: SheetsUniverApi,
  locale: ExcelHostConfig['locale'],
  onFailure: (cause: unknown) => void,
): LiveAnalysisController | null {
  const workbook = univerAPI.getActiveWorkbook()
  if (!workbook) return null
  let state = readLiveAnalysis(workbook.getCustomMetadata())
  let timeout: number | null = null
  let disposed = false
  let refreshing = false
  const pending = new Set<string>()

  const persist = () => {
    workbook.setCustomMetadata(withLiveAnalysis(workbook.getCustomMetadata(), state))
  }
  const refreshBinding = async (binding: ExcelLiveAnalysisBinding): Promise<ExcelLiveAnalysisBinding | null> => {
    const source = workbook.getSheetBySheetId(binding.sourceSheetId)
    const target = workbook.getSheetBySheetId(binding.targetSheetId)
    if (!source || !target) return null
    if (binding.kind === 'chart') {
      const image = target.getImageById(binding.drawingId)
      if (!image) return null
      let svg: string
      try {
        svg = buildChartSvg(rangeValues(source, binding.sourceAddress), binding.chartType)
      } catch (cause) {
        const message = excelInsertValidationMessage(cause, locale)
        if (!message) throw cause
        svg = buildEmptyChartSvg(message)
      }
      image.setSource(await chartPng(svg), ImageSourceType.BASE64)
      return binding
    }
    try {
      const pivot = buildPivotTable(rangeValues(source, binding.sourceAddress), binding.options)
      const rendered = renderPivotResult(target, pivot, binding.renderedRows, binding.renderedColumns)
      return { ...binding, renderedColumns: rendered.columnCount, renderedRows: rendered.rowCount }
    } catch (cause) {
      const message = excelInsertValidationMessage(cause, locale)
      if (!message) throw cause
      renderPivotMessage(target, message, binding.renderedRows, binding.renderedColumns)
      return { ...binding, renderedColumns: 1, renderedRows: 1 }
    }
  }
  const flush = async () => {
    timeout = null
    if (disposed || refreshing || pending.size === 0) return
    refreshing = true
    const ids = new Set(pending)
    pending.clear()
    try {
      const next: ExcelLiveAnalysisBinding[] = []
      for (const binding of state.bindings) {
        if (!ids.has(binding.id)) {
          next.push(binding)
          continue
        }
        try {
          const refreshed = await refreshBinding(binding)
          if (refreshed) next.push(refreshed)
        } catch (cause) {
          next.push(binding)
          onFailure(cause)
        }
      }
      state = { version: 1, bindings: next }
      persist()
    } finally {
      refreshing = false
      if (pending.size > 0 && !disposed) timeout = window.setTimeout(() => void flush(), 220)
    }
  }
  const requestFlush = () => {
    if (pending.size === 0) return
    if (timeout !== null) window.clearTimeout(timeout)
    timeout = window.setTimeout(() => void flush(), 220)
  }

  return {
    dispose: () => {
      disposed = true
      if (timeout !== null) window.clearTimeout(timeout)
    },
    register: (binding) => {
      state = upsertLiveBinding(state, binding)
      persist()
    },
    schedule: (changes) => {
      for (const binding of state.bindings) {
        const source = workbook.getSheetBySheetId(binding.sourceSheetId)
        if (!source) continue
        const sourceRange = source.getRange(binding.sourceAddress).getRange()
        if (changes.some((change) => change.sheetId === binding.sourceSheetId
          && rangesIntersect(sourceRange, change.range))) pending.add(binding.id)
      }
      requestFlush()
    },
    structureChanged: (change) => {
      const result = updateLiveAnalysisForStructureChange(state, change)
      if (result.bindingIds.length === 0) return
      state = result.state
      result.bindingIds.forEach((id) => pending.add(id))
      persist()
      requestFlush()
    },
  }
}

async function runSheetAction(
  univerAPI: SheetsUniverApi,
  action: ExcelRibbonAction,
  value?: ExcelRibbonActionValue,
  liveAnalysis?: LiveAnalysisController | null,
  view?: SheetViewController | null,
) {
  if (action === 'undo') {
    await univerAPI.undo()
    return
  }
  if (action === 'redo') {
    await univerAPI.redo()
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
    case 'align-top':
      range.setVerticalAlignment('top')
      break
    case 'align-middle':
      range.setVerticalAlignment('middle')
      break
    case 'align-bottom':
      range.setVerticalAlignment('bottom')
      break
    case 'rotate-text':
      range.setTextRotation(45)
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
    case 'thousands-separator':
      range.setNumberFormat('#,##0.00')
      break
    case 'increase-decimal':
      range.setNumberFormat(adjustDecimalPlaces(range.getNumberFormat(), 1))
      break
    case 'decrease-decimal':
      range.setNumberFormat(adjustDecimalPlaces(range.getNumberFormat(), -1))
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
    case 'insert-cells-right':
      range.insertCells(Dimension.COLUMNS)
      break
    case 'insert-cells-down':
      range.insertCells(Dimension.ROWS)
      break
    case 'insert-sheet':
      workbook.insertSheet()
      break
    case 'insert-image':
      await univerAPI.executeCommand(InsertFloatImageCommand.id)
      break
    case 'insert-hyperlink':
      if (!isHyperlinkOptions(value)) throw new Error('Hyperlink details are required.')
      if (!await range.setHyperLink(value.url, value.label)) throw new Error('The hyperlink could not be inserted.')
      break
    case 'insert-chart': {
      if (typeof value !== 'string' || !CHART_TYPES.has(value as ExcelChartType)) throw new Error('Choose a supported chart type.')
      const source = insertContext(univerAPI, true)
      if (!source) return
      const png = await chartPng(buildChartSvg(source.values, value as ExcelChartType))
      const image = await sheet.newOverGridImage()
        .setSource(png, ImageSourceType.BASE64)
        .setColumn(range.getColumn())
        .setRow(Math.min(sheet.getMaxRows() - 1, range.getLastRow() + 2))
        .setWidth(540)
        .setHeight(315)
        .buildAsync()
      sheet.insertImages([image])
      liveAnalysis?.register({
        id: crypto.randomUUID(),
        kind: 'chart',
        sourceAddress: source.address,
        sourceSheetId: sheet.getSheetId(),
        targetSheetId: sheet.getSheetId(),
        drawingId: image.drawingId,
        chartType: value as ExcelChartType,
      })
      break
    }
    case 'insert-pivot-table': {
      if (!isPivotOptions(value)) throw new Error('Pivot table fields are required.')
      const source = sheet.getRange(value.sourceAddress).getValues().map((row) => row.map((cell): ExcelCellValue => {
        if (cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell
        return String(cell)
      }))
      const pivot = buildPivotTable(source, value)
      const target = workbook.insertSheet(uniqueSheetName(workbook, 'PivotTable'))
      const rendered = renderPivotResult(target, pivot, 0, 0)
      const binding: ExcelLivePivotBinding = {
        id: crypto.randomUUID(),
        kind: 'pivot',
        sourceAddress: value.sourceAddress,
        sourceSheetId: sheet.getSheetId(),
        targetSheetId: target.getSheetId(),
        options: value,
        renderedColumns: rendered.columnCount,
        renderedRows: rendered.rowCount,
      }
      liveAnalysis?.register(binding)
      target.activate()
      target.setActiveRange(rendered.targetRange)
      break
    }
    case 'toggle-filter': {
      const selection = range.getRange()
      const dataRegion = range.getDataRegion().getRange()
      const base = resolveFilterTarget(selection, dataRegion)
      const baseRange = sheet.getRange(base.startRow, base.startColumn, base.rowCount, base.columnCount)
      if (baseRange.isBlank()) throw new ExcelDataOperationError('filter-range-required')
      const target = resolveFilterTarget(selection, dataRegion, detectTableHeaderOffset(baseRange.getValues()))
      const filter = sheet.getFilter()
      const targetRange = sheet.getRange(target.startRow, target.startColumn, target.rowCount, target.columnCount)
      if (filter?.getRange().getA1Notation() === targetRange.getA1Notation()) break
      filter?.remove()
      if (!targetRange.createFilter()) throw new ExcelDataOperationError('filter-range-required')
      break
    }
    case 'clear-filter': {
      const filter = sheet.getFilter()
      if (!filter) throw new ExcelDataOperationError('filter-not-active')
      filter.removeFilterCriteria()
      break
    }
    case 'remove-filter': {
      const filter = sheet.getFilter()
      if (!filter) throw new ExcelDataOperationError('filter-not-active')
      filter.remove()
      break
    }
    case 'sort-ascending':
    case 'sort-descending': {
      const filterRange = sheet.getFilter()?.getRange().getRange()
      const selection = range.getRange()
      const dataRegion = range.getDataRegion().getRange()
      const base = filterRange ?? resolveFilterTarget(selection, dataRegion)
      const values = sheet.getRange(
        base.startRow,
        base.startColumn,
        base.endRow - base.startRow + 1,
        base.endColumn - base.startColumn + 1,
      ).getValues()
      const target = resolveSortTarget(
        selection,
        dataRegion,
        filterRange,
        filterRange ? 0 : detectTableHeaderOffset(values),
        detectTableFooterRows(values),
      )
      sheet.getRange(target.startRow, target.startColumn, target.rowCount, target.columnCount).sort({
        column: target.sortColumn,
        ascending: action === 'sort-ascending',
      })
      break
    }
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
      insertQuickFormula(sheet, range, formulaNames[action])
      break
    }
    case 'toggle-gridlines':
      sheet.setHiddenGridlines(!sheet.hasHiddenGridLines())
      view?.publish()
      break
    case 'toggle-zero-values':
      view?.toggleZeroValues()
      break
    case 'highlight-row-column':
      view?.setHighlightMode('both')
      break
    case 'highlight-row':
      view?.setHighlightMode('row')
      break
    case 'highlight-column':
      view?.setHighlightMode('column')
      break
    case 'highlight-none':
      view?.setHighlightMode('none')
      break
    case 'set-row-height': {
      const height = Number(value)
      if (!Number.isFinite(height) || height < 8 || height > 409) return
      sheet.setRowHeights(range.getRow(), range.getLastRow() - range.getRow() + 1, height)
      break
    }
    case 'set-column-width': {
      const width = Number(value)
      if (!Number.isFinite(width) || width < 8 || width > 1024) return
      sheet.setColumnWidths(range.getColumn(), range.getLastColumn() - range.getColumn() + 1, width)
      break
    }
    case 'auto-fit-rows':
      sheet.autoResizeRows(range.getRow(), range.getLastRow() - range.getRow() + 1)
      break
    case 'auto-fit-columns':
      sheet.autoResizeColumns(range.getColumn(), range.getLastColumn() - range.getColumn() + 1)
      break
    case 'set-zoom': {
      const zoom = Number(value)
      if (!Number.isFinite(zoom) || zoom < 0.1 || zoom > 4) return
      sheet.zoom(zoom)
      view?.publish()
      break
    }
    case 'freeze-selection':
      sheet.setFrozenRows(range.getRow())
      sheet.setFrozenColumns(range.getColumn())
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
    case 'toggle-dark-mode':
      // Theme changes are handled by the host so the ribbon and canvas switch together.
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
  const [editorTheme, setEditorTheme] = useState<ExcelHostConfig['theme']>(config.theme)
  const nextWorkbookOrdinal = useRef(2)
  const [tabs, setTabs] = useState<WorkbookTab[]>(() => [newWorkbookTab(readConfig(), 1)])
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.tabId ?? null)
  const [recoveryLoaded, setRecoveryLoaded] = useState(false)
  const [ribbonTab, setRibbonTab] = useState<ExcelRibbonTab>('home')
  const [selection, setSelection] = useState<SheetSelectionState>({
    address: 'A1', sheetId: '', sheetName: 'Sheet1', targetAddress: 'A1', value: '',
  })
  const [insertDialog, setInsertDialog] = useState<InsertDialogState>(null)
  const [formulaDialog, setFormulaDialog] = useState<FormulaDialogState | null>(null)
  const [recentFunctions, setRecentFunctions] = useState(loadRecentFormulas)
  const [busy, setBusy] = useState<BusyAction>(null)
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
  const editorRef = useRef<SheetEditorHandle>(null)
  const copy = COPY[config.locale]
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.tabId === activeTabId) ?? null,
    [activeTabId, tabs],
  )
  const effectiveConfig = useMemo(() => ({ ...config, theme: editorTheme }), [config, editorTheme])

  useEffect(() => api.onConfigChanged((next) => {
    if (next.sessionId === config.sessionId) {
      setConfig(next)
      setEditorTheme(next.theme)
    }
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
    setFormulaDialog(null)
    const tab = newWorkbookTab(config, nextWorkbookOrdinal.current)
    nextWorkbookOrdinal.current += 1
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.tabId)
    setError(null)
  }

  const openWorkbook = async () => {
    setFormulaDialog(null)
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
    setFormulaDialog(null)
    if (tabs.length === 1) {
      void api.closeSession().catch((cause) => setError(errorMessage(cause)))
      return
    }
    const index = tabs.findIndex((candidate) => candidate.tabId === tab.tabId)
    const nextActive = tabs[index + 1] ?? tabs[index - 1] ?? null
    setTabs((current) => current.filter((candidate) => candidate.tabId !== tab.tabId))
    if (activeTabId === tab.tabId) setActiveTabId(nextActive?.tabId ?? null)
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
      setInsertDialog({ kind: action === 'insert-pivot-table' ? 'pivot' : 'hyperlink', context })
      return
    }
    void editorRef.current?.run(action, value).catch(reportActionFailure)
  }, [activeTabId, reportActionFailure, selection])
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
                onClick={() => {
                  setFormulaDialog(null)
                  setActiveTabId(tab.tabId)
                }}
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

      {notice ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-12 z-[9998] flex justify-center px-4" role="status">
          <div className="pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border border-status-warning/25 bg-bg-surface px-3 py-2 text-[11px] text-text-secondary shadow-xl">
            <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-status-warning/15 text-[10px] font-semibold text-status-warning">!</span>
            <span className="min-w-0 leading-4">{notice.message}</span>
            <button aria-label={copy.dismissNotice} className="ml-1 shrink-0 text-text-tertiary hover:text-text-primary" onClick={() => setNotice(null)} type="button">{Icons.x(12)}</button>
          </div>
        </div>
      ) : null}

      {activeTab ? (
        <UniverSheetEditor
          key={`${activeTab.tabId}:${activeTab.revision}`}
          ref={editorRef}
          config={effectiveConfig}
          onActionFailure={reportActionFailure}
          onChange={handleEditorChange}
          onSelectionChange={setSelection}
          onViewStateChange={handleViewStateChange}
          snapshot={activeTab.snapshot}
          viewPreferences={viewPreferences}
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

      {insertDialog?.kind === 'hyperlink' ? (
        <ExcelHyperlinkDialog
          context={insertDialog.context}
          locale={config.locale}
          onCancel={() => setInsertDialog(null)}
          onConfirm={(options) => {
            setInsertDialog(null)
            void editorRef.current?.run('insert-hyperlink', options).catch(reportActionFailure)
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
            void editorRef.current?.run('insert-pivot-table', options).catch(reportActionFailure)
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
            editorRef.current?.setFormulaAt(formulaDialog.sheetId, formulaDialog.targetAddress, formula)
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

const UniverSheetEditor = forwardRef<SheetEditorHandle, {
  config: ExcelHostConfig
  onActionFailure: (cause: unknown) => void
  onChange: (snapshot: IWorkbookData) => void
  onSelectionChange: (selection: SheetSelectionState) => void
  onViewStateChange: (state: ExcelViewState) => void
  snapshot: IWorkbookData
  viewPreferences: ExcelViewPreferences
}>(function UniverSheetEditor({ config, onActionFailure, onChange, onSelectionChange, onViewStateChange, snapshot, viewPreferences }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const univerRef = useRef<Univer | null>(null)
  const apiRef = useRef<ReturnType<typeof createSheetsUniver>['univerAPI'] | null>(null)
  const liveAnalysisRef = useRef<LiveAnalysisController | null>(null)
  const sheetViewRef = useRef<SheetViewController | null>(null)
  const formulaPreviewDepthRef = useRef(0)
  const snapshotRef = useRef(snapshot)
  const viewPreferencesRef = useRef(viewPreferences)
  const configRef = useRef(config)

  useEffect(() => {
    configRef.current = config
  }, [config])

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    viewPreferencesRef.current = viewPreferences
  }, [viewPreferences])

  useEffect(() => {
    apiRef.current?.toggleDarkMode(config.theme === 'dark')
    sheetViewRef.current?.publish()
  }, [config.theme])

  useImperativeHandle(ref, () => ({
    insertContext: (expandDataRegion) => {
      const univerAPI = apiRef.current
      return univerAPI ? insertContext(univerAPI, expandDataRegion) : null
    },
    previewFormula: (sheetId, address, formula) => {
      const univer = univerRef.current
      const univerAPI = apiRef.current
      if (!univer || !univerAPI) return Promise.resolve({ errorCode: '#ERROR!' })
      formulaPreviewDepthRef.current += 1
      return calculateFormulaPreview(univer, univerAPI, sheetId, address, formula).finally(() => {
        window.setTimeout(() => {
          formulaPreviewDepthRef.current = Math.max(0, formulaPreviewDepthRef.current - 1)
        }, 0)
      })
    },
    run: (action, value) => {
      const univerAPI = apiRef.current
      if (!univerAPI) return Promise.resolve()
      return runSheetAction(univerAPI, action, value, liveAnalysisRef.current, sheetViewRef.current)
    },
    selectRange: (address) => {
      const sheet = apiRef.current?.getActiveWorkbook()?.getActiveSheet()
      if (!sheet || !address) return
      sheet.setActiveRange(sheet.getRange(address))
    },
    setFormulaAt: (sheetId, address, formula) => {
      const workbook = apiRef.current?.getActiveWorkbook()
      const sheet = workbook?.getSheetBySheetId(sheetId)
      if (!sheet) return
      const selected = sheet.getRange(address)
      const target = sheet.getRange(selected.getRow(), selected.getColumn())
      sheet.activate()
      target.setFormula(formula)
      sheet.setActiveRange(target)
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
    const currentConfig = configRef.current
    const locale = univerLocale(currentConfig)
    const { univer, univerAPI } = createSheetsUniver([
      UniverSheetsCorePreset({
        container,
        ...EXCEL_SHEETS_UI_CONFIG,
      }),
      ...EXCEL_OPEN_SOURCE_FEATURES.map((feature) => openSourcePresetFactories[feature]()),
    ], {
      darkMode: currentConfig.theme === 'dark',
      locale,
      locales: {
        [LocaleType.EN_US]: mergeLocales(
          coreEnUS,
          filterEnUS,
          sortEnUS,
          conditionalFormattingEnUS,
          dataValidationEnUS,
          drawingEnUS,
          hyperLinkEnUS,
        ),
        [LocaleType.ZH_CN]: mergeLocales(
          coreZhCN,
          filterZhCN,
          sortZhCN,
          conditionalFormattingZhCN,
          dataValidationZhCN,
          drawingZhCN,
          hyperLinkZhCN,
        ),
      },
      theme: defaultTheme,
    })
    univerRef.current = univer
    apiRef.current = univerAPI
    univerAPI.createWorkbook(snapshotRef.current)
    const liveAnalysis = createLiveAnalysisController(univerAPI, currentConfig.locale, onActionFailure)
    const sheetView = new SheetViewController(
      univer,
      univerAPI,
      viewPreferencesRef.current,
      onViewStateChange,
      onChange,
    )
    liveAnalysisRef.current = liveAnalysis
    sheetViewRef.current = sheetView
    let disposed = false
    let snapshotPending = false
    const publishSelection = () => {
      const workbook = univerAPI.getActiveWorkbook()
      const sheet = workbook?.getActiveSheet()
      const range = workbook?.getActiveRange() ?? sheet?.getRange('A1')
      if (!sheet || !range) return
      const formula = range.getFormula()
      const value = range.getValue()
      onSelectionChange({
        address: range.getA1Notation(),
        sheetId: sheet.getSheetId(),
        sheetName: sheet.getSheetName(),
        targetAddress: sheet.getRange(range.getRow(), range.getColumn()).getA1Notation(),
        value: formula || (value === null ? '' : String(value)),
      })
      sheetView.selectionChanged()
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
    const activeSheetChanged = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, publishSelection)
    const zoomChanged = univerAPI.addEvent(univerAPI.Event.SheetZoomChanged, () => {
      sheetView.publish()
      publishSnapshot()
    })
    const valuesChanged = univerAPI.addEvent(univerAPI.Event.SheetValueChanged, (event) => {
      liveAnalysis?.schedule(event.effectedRanges.map((range) => ({
        range: range.getRange(),
        sheetId: range.getSheetId(),
      })))
      publishSelection()
      publishSnapshot()
    })
    const workbookChanged = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      const structureChange = liveStructureChange(event.id, event.params)
      if (structureChange) liveAnalysis?.structureChanged(structureChange)
      if (event.type === CommandType.MUTATION && formulaPreviewDepthRef.current === 0) publishSnapshot()
    })
    const observer = new ResizeObserver(() => {
      univerAPI.getActiveWorkbook()?.getActiveSheet()?.refreshCanvas()
    })
    observer.observe(container)
    return () => {
      disposed = true
      observer.disconnect()
      activeSheetChanged.dispose()
      selectionChanged.dispose()
      zoomChanged.dispose()
      valuesChanged.dispose()
      workbookChanged.dispose()
      liveAnalysis?.dispose()
      liveAnalysisRef.current = null
      sheetView.dispose()
      sheetViewRef.current = null
      univerRef.current = null
      apiRef.current = null
      univer.dispose()
      container.replaceChildren()
    }
  }, [config.locale, onActionFailure, onChange, onSelectionChange, onViewStateChange])

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
