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
import { createExcelEditorBinding } from '../lib/office/excelEditorBinding'
import { OfficeOperationError } from '../lib/office/officeWorkspaceRuntime'
import { EXCEL_SHOW_ZEROS_CUSTOM_KEY, excelSheetShowsZeros } from '../lib/excelWorkbook'
import type { ExcelHighlightMode, ExcelRibbonAction, ExcelViewState } from './ExcelRibbon'
import {
  ExcelDataOperationError,
  detectTableFooterRows,
  detectTableHeaderOffset,
  resolveFilterTarget,
  resolveSortTarget,
} from './excelDataOperations'
import { formulaPreviewResult, type ExcelFormulaPreviewResult } from './excelFormulaWizard'
import { contiguousDataStart, quickFormulaExpression, quickFormulaTargets, type ExcelQuickFormulaName } from './excelQuickFormula'
import {
  buildChartSvg, buildEmptyChartSvg, buildPivotTable, excelInsertValidationMessage, svgDataUrl,
  type ExcelChartType, type ExcelCellValue, type ExcelHyperlinkOptions, type ExcelInsertContext,
  type ExcelPivotOptions, type ExcelPivotResult, type ExcelRibbonActionValue,
} from './excelInsert'
import {
  rangesIntersect, readLiveAnalysis, updateLiveAnalysisForStructureChange, upsertLiveBinding, withLiveAnalysis,
  type ExcelLiveAnalysisBinding, type ExcelLivePivotBinding, type ExcelLiveStructureChange,
} from './excelLiveAnalysis'
import { adjustDecimalPlaces } from './excelNumberFormat'
import { EXCEL_OPEN_SOURCE_FEATURES, EXCEL_SHEETS_UI_CONFIG, type ExcelOpenSourceFeature } from './excelUiConfig'

export interface SheetEditorHandle {
  readonly documentId: string
  insertContext(expandDataRegion: boolean): ExcelInsertContext | null
  previewFormula(sheetId: string, address: string, formula: string): Promise<ExcelFormulaPreviewResult>
  run(action: ExcelRibbonAction, value?: ExcelRibbonActionValue): Promise<void>
  selectRange(address: string): void
  setFormulaAt(sheetId: string, address: string, formula: string): void
  setFormulaBarValue(value: string): void
  flush(): Promise<void>
  snapshot(): IWorkbookData | null
}

export interface SheetSelectionState {
  address: string
  sheetId: string
  sheetName: string
  targetAddress: string
  value: string
}

export type ExcelViewPreferences = Pick<ExcelViewState, 'highlightMode'>

export interface ExcelUniverAdapter extends SheetEditorHandle {
  setTheme(theme: ExcelHostConfig['theme']): void
  dispose(): void
}

/** One mounted Univer unit is the authority for this Session document's live content. */
export function mountExcelUniverAdapter(options: {
  container: HTMLElement
  config: ExcelHostConfig
  documentId: string
  snapshot: IWorkbookData
  viewPreferences: ExcelViewPreferences
  onChange: (snapshot: IWorkbookData) => void
  onActionFailure: (cause: unknown) => void
  onSelectionChange: (selection: SheetSelectionState) => void
  onViewStateChange: (state: ExcelViewState) => void
}): ExcelUniverAdapter {
  const { container, config, documentId, onActionFailure, onSelectionChange, onViewStateChange } = options
  const { univer, univerAPI } = createSheetsUniver([
    UniverSheetsCorePreset({ container, ...EXCEL_SHEETS_UI_CONFIG }),
    ...EXCEL_OPEN_SOURCE_FEATURES.map((feature) => openSourcePresetFactories[feature]()),
  ], {
    darkMode: config.theme === 'dark',
    locale: univerLocale(config),
    locales: {
      [LocaleType.EN_US]: mergeLocales(coreEnUS, filterEnUS, sortEnUS, conditionalFormattingEnUS, dataValidationEnUS, drawingEnUS, hyperLinkEnUS),
      [LocaleType.ZH_CN]: mergeLocales(coreZhCN, filterZhCN, sortZhCN, conditionalFormattingZhCN, dataValidationZhCN, drawingZhCN, hyperLinkZhCN),
    },
    theme: defaultTheme,
  })
  univerAPI.createWorkbook(options.snapshot)
  let formulaPreviewDepth = 0
  const binding = createExcelEditorBinding<IWorkbookData>({
    sessionId: config.sessionId,
    documentId,
    onChange: options.onChange,
    readSnapshot: () => univerAPI.getActiveWorkbook()?.getSnapshot() ?? null,
    async flushNative(lease) {
      const workbook = univerAPI.getActiveWorkbook()
      if (!workbook) throw new OfficeOperationError('document_not_ready', 'The workbook editor is not ready.')
      // Univer commits the cell through its own command stack, retaining native undo.
      if (workbook.isCellEditing()) {
        const committed = await workbook.endEditingAsync(true)
        lease.assertCurrent()
        if (!committed || workbook.isCellEditing()) {
          throw new OfficeOperationError('editor_flush_failed', 'The current cell edit could not be committed.')
        }
      }
    },
    disposeNative() {
      observer.disconnect()
      for (const subscription of subscriptions) subscription.dispose()
      liveAnalysis?.dispose()
      sheetView.dispose()
      univer.dispose()
      container.replaceChildren()
    },
  })
  const lease = binding.capture()
  const liveAnalysis = createLiveAnalysisController(univerAPI, config.locale, onActionFailure)
  const sheetView = new SheetViewController(univer, univerAPI, options.viewPreferences, onViewStateChange, binding.publishChange)
  const publishSelection = () => {
    if (!lease.isCurrent()) return
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
  const subscriptions = [
    univerAPI.addEvent(univerAPI.Event.SelectionChanged, publishSelection),
    univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, publishSelection),
    univerAPI.addEvent(univerAPI.Event.SheetZoomChanged, () => {
      sheetView.publish()
      binding.scheduleChange()
    }),
    univerAPI.addEvent(univerAPI.Event.SheetValueChanged, (event) => {
      liveAnalysis?.schedule(event.effectedRanges.map((range) => ({ range: range.getRange(), sheetId: range.getSheetId() })))
      publishSelection()
      binding.scheduleChange()
    }),
    univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      const structureChange = liveStructureChange(event.id, event.params)
      if (structureChange) liveAnalysis?.structureChanged(structureChange)
      if (event.type === CommandType.MUTATION && formulaPreviewDepth === 0) binding.scheduleChange()
    }),
  ]
  const observer = new ResizeObserver(() => {
    if (lease.isCurrent()) univerAPI.getActiveWorkbook()?.getActiveSheet()?.refreshCanvas()
  })
  observer.observe(container)
  queueMicrotask(publishSelection)

  return {
    documentId,
    dispose: binding.dispose,
    flush: binding.flush,
    snapshot: binding.readSnapshot,
    setTheme(theme) {
      lease.assertCurrent()
      univerAPI.toggleDarkMode(theme === 'dark')
      sheetView.publish()
    },
    insertContext(expandDataRegion) {
      lease.assertCurrent()
      return insertContext(univerAPI, expandDataRegion)
    },
    previewFormula(sheetId, address, formula) {
      if (!lease.isCurrent()) return Promise.resolve({ errorCode: '#REF!' })
      formulaPreviewDepth += 1
      return calculateFormulaPreview(univer, univerAPI, sheetId, address, formula, lease.isCurrent).then((result) => (
        lease.isCurrent() ? result : { errorCode: '#REF!' }
      )).finally(() => {
        window.setTimeout(() => { formulaPreviewDepth = Math.max(0, formulaPreviewDepth - 1) }, 0)
      })
    },
    run(action, value) {
      return runSheetAction(univerAPI, action, value, liveAnalysis, sheetView, lease.assertCurrent)
    },
    selectRange(address) {
      lease.assertCurrent()
      const sheet = univerAPI.getActiveWorkbook()?.getActiveSheet()
      if (!sheet) throw new OfficeOperationError('document_not_ready', 'The workbook editor is not ready.')
      if (!address) throw new OfficeOperationError('invalid_operation', 'A range address is required.')
      sheet.setActiveRange(sheet.getRange(address))
    },
    setFormulaAt(sheetId, address, formula) {
      lease.assertCurrent()
      const sheet = univerAPI.getActiveWorkbook()?.getSheetBySheetId(sheetId)
      if (!sheet) throw new OfficeOperationError('document_not_found', 'The requested worksheet is unavailable.')
      const selected = sheet.getRange(address)
      const target = sheet.getRange(selected.getRow(), selected.getColumn())
      sheet.activate()
      target.setFormula(formula)
      sheet.setActiveRange(target)
    },
    setFormulaBarValue(value) {
      lease.assertCurrent()
      const workbook = univerAPI.getActiveWorkbook()
      const sheet = workbook?.getActiveSheet()
      if (!workbook || !sheet) throw new OfficeOperationError('document_not_ready', 'The workbook editor is not ready.')
      const range = workbook.getActiveRange() ?? sheet.getRange('A1')
      if (value.startsWith('=')) range.setFormula(value)
      else {
        const trimmed = value.trim()
        const numericValue = trimmed === '' ? null : Number(trimmed)
        range.setValue(numericValue !== null && Number.isFinite(numericValue) ? numericValue : value)
      }
    },
  }
}

export function univerLocale(config: ExcelHostConfig): LocaleType {
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
  isCurrent: () => boolean,
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
    if (isCurrent()) service.deleteFormula(workbook.getId(), sheetId, [formulaId])
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
  assertCurrent: () => void = () => undefined,
) {
  assertCurrent()
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
  if (!workbook || !sheet) throw new OfficeOperationError('document_not_ready', 'The workbook editor is not ready.')
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
      if (!source) throw new OfficeOperationError('document_not_ready', 'The chart source is unavailable.')
      const png = await chartPng(buildChartSvg(source.values, value as ExcelChartType))
      assertCurrent()
      const image = await sheet.newOverGridImage()
        .setSource(png, ImageSourceType.BASE64)
        .setColumn(range.getColumn())
        .setRow(Math.min(sheet.getMaxRows() - 1, range.getLastRow() + 2))
        .setWidth(540)
        .setHeight(315)
        .buildAsync()
      assertCurrent()
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
      if (!Number.isFinite(height) || height < 8 || height > 409) throw new OfficeOperationError('invalid_operation', 'Row height must be between 8 and 409.')
      sheet.setRowHeights(range.getRow(), range.getLastRow() - range.getRow() + 1, height)
      break
    }
    case 'set-column-width': {
      const width = Number(value)
      if (!Number.isFinite(width) || width < 8 || width > 1024) throw new OfficeOperationError('invalid_operation', 'Column width must be between 8 and 1024.')
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
      if (!Number.isFinite(zoom) || zoom < 0.1 || zoom > 4) throw new OfficeOperationError('invalid_operation', 'Zoom must be between 10% and 400%.')
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
    case 'formula-more':
    case 'formula-insert':
      throw new OfficeOperationError('unsupported_operation', 'This action requires the workbook host dialog.')
    default:
      throw new OfficeOperationError('unsupported_operation', 'This workbook action is not supported.')
  }
}
