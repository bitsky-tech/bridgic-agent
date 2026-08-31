import {
  Workbook,
  type BorderStyle,
  type Cell,
  type Color,
  type ConditionalFormattingRule,
  type DataValidation,
  type Style,
  type Worksheet,
} from 'exceljs'
import JSZip from 'jszip'
import {
  BooleanNumber,
  BorderStyleTypes,
  CellValueType,
  DrawingTypeEnum,
  HorizontalAlign,
  LocaleType,
  VerticalAlign,
  WrapStrategy,
  type ICellData,
  type IBorderStyleData,
  type IRange,
  type IStyleData,
  type IWorkbookData,
} from '@univerjs/core'

const DEFAULT_ROWS = 1_000
const DEFAULT_COLUMNS = 26
const FILTER_RESOURCE = 'SHEET_FILTER_PLUGIN'
const DATA_VALIDATION_RESOURCE = 'SHEET_DATA_VALIDATION_PLUGIN'
const CONDITIONAL_FORMATTING_RESOURCE = 'SHEET_CONDITIONAL_FORMATTING_PLUGIN'
const DRAWING_RESOURCE = 'SHEET_DRAWING_PLUGIN'
const COMPATIBILITY_CUSTOM_KEY = 'bridgicXlsxUnsupportedFeatures'

type ResourceMap = Record<string, unknown>
// Univer's plugin resource boundary is JSON but the installed packages do not export a shared schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResourceRule = Record<string, any>

/** An .xlsx object that the open-source conversion path cannot reproduce safely. */
export class UnsupportedWorkbookFeatureError extends Error {
  constructor(readonly features: string[]) {
    super(`This workbook contains unsupported Excel objects: ${features.join(', ')}`)
    this.name = 'UnsupportedWorkbookFeatureError'
  }
}

/** Compatibility information travels with the snapshot through Univer edits. */
export function unsupportedWorkbookFeatures(snapshot: IWorkbookData): string[] {
  const value = snapshot.custom?.[COMPATIBILITY_CUSTOM_KEY]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Remove source-only compatibility metadata after an explicit simplified Save As. */
export function clearUnsupportedWorkbookFeatures(snapshot: IWorkbookData): IWorkbookData {
  if (!snapshot.custom || !(COMPATIBILITY_CUSTOM_KEY in snapshot.custom)) return snapshot
  const custom = { ...snapshot.custom }
  delete custom[COMPATIBILITY_CUSTOM_KEY]
  return { ...snapshot, custom: Object.keys(custom).length > 0 ? custom : undefined }
}

function rgb(color?: Partial<Color>): string | undefined {
  const argb = color?.argb?.replace(/^#/, '')
  if (!argb) return undefined
  const value = argb.length === 8 ? argb.slice(2) : argb
  return value.length === 6 ? `#${value.toUpperCase()}` : undefined
}

function argb(color?: { rgb?: string | null | undefined | void } | null | void): Partial<Color> | undefined {
  const value = color?.rgb?.replace(/^#/, '')
  return value?.length === 6 ? { argb: `FF${value.toUpperCase()}` } : undefined
}

const BORDER_FROM_EXCEL: Partial<Record<BorderStyle, BorderStyleTypes>> = {
  thin: BorderStyleTypes.THIN,
  hair: BorderStyleTypes.HAIR,
  dotted: BorderStyleTypes.DOTTED,
  dashed: BorderStyleTypes.DASHED,
  dashDot: BorderStyleTypes.DASH_DOT,
  dashDotDot: BorderStyleTypes.DASH_DOT_DOT,
  double: BorderStyleTypes.DOUBLE,
  medium: BorderStyleTypes.MEDIUM,
  mediumDashed: BorderStyleTypes.MEDIUM_DASHED,
  mediumDashDot: BorderStyleTypes.MEDIUM_DASH_DOT,
  mediumDashDotDot: BorderStyleTypes.MEDIUM_DASH_DOT_DOT,
  slantDashDot: BorderStyleTypes.SLANT_DASH_DOT,
  thick: BorderStyleTypes.THICK,
}

const BORDER_TO_EXCEL: Partial<Record<BorderStyleTypes, BorderStyle>> = {
  [BorderStyleTypes.THIN]: 'thin',
  [BorderStyleTypes.HAIR]: 'hair',
  [BorderStyleTypes.DOTTED]: 'dotted',
  [BorderStyleTypes.DASHED]: 'dashed',
  [BorderStyleTypes.DASH_DOT]: 'dashDot',
  [BorderStyleTypes.DASH_DOT_DOT]: 'dashDotDot',
  [BorderStyleTypes.DOUBLE]: 'double',
  [BorderStyleTypes.MEDIUM]: 'medium',
  [BorderStyleTypes.MEDIUM_DASHED]: 'mediumDashed',
  [BorderStyleTypes.MEDIUM_DASH_DOT]: 'mediumDashDot',
  [BorderStyleTypes.MEDIUM_DASH_DOT_DOT]: 'mediumDashDotDot',
  [BorderStyleTypes.SLANT_DASH_DOT]: 'slantDashDot',
  [BorderStyleTypes.THICK]: 'thick',
}

function excelStyle(cell: Cell): IStyleData | undefined {
  const style: IStyleData = {}
  if (cell.font?.name) style.ff = cell.font.name
  if (cell.font?.size) style.fs = cell.font.size
  if (cell.font?.bold) style.bl = BooleanNumber.TRUE
  if (cell.font?.italic) style.it = BooleanNumber.TRUE
  if (cell.font?.underline && cell.font.underline !== 'none') {
    style.ul = { s: BooleanNumber.TRUE }
  }
  if (cell.font?.strike) style.st = { s: BooleanNumber.TRUE }
  const fontColor = rgb(cell.font?.color)
  if (fontColor) style.cl = { rgb: fontColor }
  if (cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid') {
    const fillColor = rgb(cell.fill.fgColor)
    if (fillColor) style.bg = { rgb: fillColor }
  }
  if (cell.numFmt && cell.numFmt !== 'General') style.n = { pattern: cell.numFmt }

  const horizontal = cell.alignment?.horizontal
  if (horizontal === 'left') style.ht = HorizontalAlign.LEFT
  else if (horizontal === 'center' || horizontal === 'centerContinuous') style.ht = HorizontalAlign.CENTER
  else if (horizontal === 'right') style.ht = HorizontalAlign.RIGHT
  else if (horizontal === 'justify') style.ht = HorizontalAlign.JUSTIFIED
  else if (horizontal === 'distributed') style.ht = HorizontalAlign.DISTRIBUTED
  const vertical = cell.alignment?.vertical
  if (vertical === 'top') style.vt = VerticalAlign.TOP
  else if (vertical === 'middle') style.vt = VerticalAlign.MIDDLE
  else if (vertical === 'bottom') style.vt = VerticalAlign.BOTTOM
  if (cell.alignment?.wrapText) style.tb = WrapStrategy.WRAP

  const border = (edge: 'top' | 'right' | 'bottom' | 'left') => {
    const source = cell.border?.[edge]
    const borderStyle = source?.style ? BORDER_FROM_EXCEL[source.style] : undefined
    if (borderStyle === undefined) return undefined
    return { s: borderStyle, cl: { rgb: rgb(source?.color) ?? '#000000' } }
  }
  const top = border('top')
  const right = border('right')
  const bottom = border('bottom')
  const left = border('left')
  if (top || right || bottom || left) style.bd = { t: top, r: right, b: bottom, l: left }
  return Object.keys(style).length > 0 ? style : undefined
}

function cellValue(cell: Cell): ICellData | null {
  const raw = cell.value
  let value: string | number | boolean | null = null
  let formula: string | undefined
  if (raw instanceof Date) {
    value = raw.getTime() / 86_400_000 + 25_569
  } else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    value = raw
  } else if (raw && typeof raw === 'object' && 'formula' in raw) {
    formula = `=${raw.formula}`
    const result = raw.result
    if (result instanceof Date) value = result.getTime() / 86_400_000 + 25_569
    else if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') value = result
  } else if (raw && typeof raw === 'object' && 'sharedFormula' in raw) {
    formula = `=${cell.formula}`
    const result = raw.result
    if (result instanceof Date) value = result.getTime() / 86_400_000 + 25_569
    else if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') value = result
  } else if (raw && typeof raw === 'object' && 'richText' in raw) {
    value = raw.richText.map((run) => run.text).join('')
  } else if (raw && typeof raw === 'object' && 'hyperlink' in raw) {
    value = raw.text || raw.hyperlink
  } else if (raw !== null) {
    value = cell.text
  }

  const style = excelStyle(cell)
  if (value === null && !formula && !style) return null
  let type: CellValueType | undefined
  if (typeof value === 'number') type = CellValueType.NUMBER
  else if (typeof value === 'boolean') type = CellValueType.BOOLEAN
  else if (typeof value === 'string') type = CellValueType.STRING
  return { v: value, t: type, f: formula, s: style }
}

function columnIndex(label: string): number {
  let index = 0
  for (const char of label.toUpperCase()) index = index * 26 + char.charCodeAt(0) - 64
  return index - 1
}

function parseCellAddress(address: string): { row: number; column: number } {
  const match = /^([A-Z]+)(\d+)$/i.exec(address)
  if (!match) throw new Error(`Unsupported cell address: ${address}`)
  return { row: Number(match[2]!) - 1, column: columnIndex(match[1]!) }
}

function parseMerge(address: string): IRange {
  const [startAddress, endAddress = startAddress] = address.split(':')
  const start = parseCellAddress(startAddress!)
  const end = parseCellAddress(endAddress!)
  return {
    startRow: start.row,
    startColumn: start.column,
    endRow: end.row,
    endColumn: end.column,
  }
}

function parseRange(address: string): IRange {
  return parseMerge(address.replace(/\$/g, ''))
}

function rangeAddress(range: IRange): string {
  const start = `${columnLabel(range.startColumn)}${range.startRow + 1}`
  const end = `${columnLabel(range.endColumn)}${range.endRow + 1}`
  return start === end ? start : `${start}:${end}`
}

function setResource(snapshot: IWorkbookData, name: string, data: ResourceMap): void {
  if (Object.keys(data).length === 0) return
  snapshot.resources ??= []
  snapshot.resources.push({ name, data: JSON.stringify(data) })
}

function resourceMap(snapshot: IWorkbookData, name: string): ResourceMap {
  const resource = snapshot.resources?.find((candidate) => candidate.name === name)
  if (!resource?.data) return {}
  try {
    const value = JSON.parse(resource.data)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function autoFilterRange(autoFilter: Worksheet['autoFilter']): IRange | null {
  if (!autoFilter) return null
  if (typeof autoFilter === 'string') return parseRange(autoFilter)
  const point = (value: string | { row: number; column: number }) => {
    if (typeof value === 'string') return parseCellAddress(value.replace(/\$/g, ''))
    return { row: value.row - 1, column: value.column - 1 }
  }
  const start = point(autoFilter.from)
  const end = point(autoFilter.to)
  return {
    startRow: start.row,
    startColumn: start.column,
    endRow: end.row,
    endColumn: end.column,
  }
}

function excelDataValidationRule(validation: DataValidation, range: IRange): ResourceRule {
  const [formula1, formula2] = validation.formulae ?? []
  return {
    uid: crypto.randomUUID(),
    type: validation.type,
    operator: validation.operator,
    formula1: formula1 === undefined ? undefined : String(formula1),
    formula2: formula2 === undefined ? undefined : String(formula2),
    allowBlank: validation.allowBlank,
    showErrorMessage: validation.showErrorMessage,
    error: validation.error,
    errorStyle: validation.errorStyle,
    errorTitle: validation.errorTitle,
    showInputMessage: validation.showInputMessage,
    prompt: validation.prompt,
    promptTitle: validation.promptTitle,
    ranges: [range],
  }
}

function conditionalStyle(source: Partial<Style> | undefined): IStyleData {
  if (!source) return {}
  const style: IStyleData = {}
  if (source.font?.name) style.ff = source.font.name
  if (source.font?.size) style.fs = source.font.size
  if (source.font?.bold) style.bl = BooleanNumber.TRUE
  if (source.font?.italic) style.it = BooleanNumber.TRUE
  if (source.font?.underline && source.font.underline !== 'none') style.ul = { s: BooleanNumber.TRUE }
  if (source.font?.strike) style.st = { s: BooleanNumber.TRUE }
  const fontColor = rgb(source.font?.color)
  if (fontColor) style.cl = { rgb: fontColor }
  if (source.fill?.type === 'pattern' && source.fill.pattern === 'solid') {
    const fillColor = rgb(source.fill.fgColor)
    if (fillColor) style.bg = { rgb: fillColor }
  }
  return style
}

function excelConditionalRule(rule: ConditionalFormattingRule): ResourceRule | null {
  const source = rule as ConditionalFormattingRule & { style?: Partial<Style>; formulae?: unknown[] }
  const style = conditionalStyle(source.style)
  if (source.type === 'cellIs') {
    const formulae = source.formulae ?? []
    return {
      type: 'highlightCell',
      subType: 'number',
      operator: source.operator,
      value: source.operator === 'between'
        ? [Number(formulae[0]), Number(formulae[1])]
        : Number(formulae[0]),
      style,
    }
  }
  if (source.type === 'expression') {
    return {
      type: 'highlightCell',
      subType: 'formula',
      value: `=${String(source.formulae?.[0] ?? '')}`,
      style,
    }
  }
  if (source.type === 'containsText') {
    return {
      type: 'highlightCell',
      subType: 'text',
      operator: source.operator,
      value: source.text,
      style,
    }
  }
  if (source.type === 'timePeriod') {
    return {
      type: 'highlightCell',
      subType: 'timePeriod',
      operator: source.timePeriod,
      style,
    }
  }
  if (source.type === 'top10') {
    return {
      type: 'highlightCell',
      subType: 'rank',
      isBottom: source.bottom,
      isPercent: source.percent,
      value: source.rank,
      style,
    }
  }
  if (source.type === 'aboveAverage') {
    return {
      type: 'highlightCell',
      subType: 'average',
      operator: source.aboveAverage ? 'greaterThan' : 'lessThan',
      style,
    }
  }
  if (source.type === 'colorScale') {
    return {
      type: 'colorScale',
      config: (source.cfvo ?? []).map((value, index) => ({
        index,
        type: value.type,
        value: value.value,
        color: rgb(source.color?.[index]) ?? '#FFFFFF',
      })),
    }
  }
  if (source.type === 'dataBar') {
    return {
      type: 'dataBar',
      isShowValue: source.showValue !== false,
      config: {
        min: source.cfvo?.[0] ?? { type: 'min' },
        max: source.cfvo?.[1] ?? { type: 'max' },
        isGradient: source.gradient !== false,
        positiveColor: '#638EC6',
        nativeColor: '#FF0000',
      },
    }
  }
  return null
}

async function unsupportedFeatures(bytes: Uint8Array, workbook: Workbook): Promise<string[]> {
  const features = new Set<string>()
  const zip = await JSZip.loadAsync(bytes)
  const paths = Object.keys(zip.files)
  const archiveFeatures: Array<[RegExp, string]> = [
    [/^xl\/charts\//, 'charts'],
    [/^xl\/pivot(?:Tables|Cache)\//, 'pivot tables'],
    [/^xl\/tables\//, 'Excel tables'],
    [/^xl\/externalLinks\//, 'external links'],
    [/^xl\/(?:slicer|timeline)/, 'slicers or timelines'],
    [/^xl\/comments|^xl\/threadedComments\//, 'cell comments'],
    [/^xl\/embeddings\//, 'embedded objects'],
    [/^xl\/(?:activeX|ctrlProps)\//, 'form controls'],
    [/^customXml\//, 'custom XML'],
  ]
  for (const [pattern, label] of archiveFeatures) {
    if (paths.some((path) => pattern.test(path))) features.add(label)
  }
  const workbookXml = zip.file('xl/workbook.xml')
  if (workbookXml && /<definedName\b/.test(await workbookXml.async('text'))) {
    features.add('named ranges or print areas')
  }
  for (const path of paths.filter((candidate) => /^xl\/worksheets\/sheet\d+\.xml$/.test(candidate))) {
    const xml = await zip.file(path)?.async('text') ?? ''
    if (/<filterColumn\b/.test(xml)) features.add('active filter criteria')
    if (/<sheetProtection\b/.test(xml)) features.add('sheet protection')
    if (/<(?:headerFooter|rowBreaks|colBreaks|printOptions)\b/.test(xml)) features.add('print settings')
  }
  for (const path of paths.filter((candidate) => /^xl\/drawings\/drawing\d+\.xml$/.test(candidate))) {
    const xml = await zip.file(path)?.async('text') ?? ''
    if (/<xdr:(?:sp|grpSp|graphicFrame|cxnSp)\b/.test(xml)) features.add('shapes or drawing objects')
  }
  workbook.eachSheet((worksheet) => {
    const pageSetup = worksheet.pageSetup
    const margins = pageSetup.margins
    if (pageSetup.orientation === 'landscape'
      || pageSetup.paperSize !== undefined
      || pageSetup.blackAndWhite
      || pageSetup.draft
      || pageSetup.horizontalCentered
      || pageSetup.verticalCentered
      || (margins && (
        margins.left !== 0.7
        || margins.right !== 0.7
        || margins.top !== 0.75
        || margins.bottom !== 0.75
        || margins.header !== 0.3
        || margins.footer !== 0.3
      ))) features.add('print settings')
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value
        if (value && typeof value === 'object' && 'hyperlink' in value) features.add('hyperlinks')
        if (value && typeof value === 'object' && 'richText' in value) features.add('rich text')
      })
    })
    const conditionalFormattings = (worksheet as Worksheet & {
      conditionalFormattings?: Array<{ rules?: ConditionalFormattingRule[] }>
    }).conditionalFormattings ?? []
    if (conditionalFormattings.some((format) => format.rules?.some((rule) => !excelConditionalRule(rule)))) {
      features.add('unsupported conditional formatting rules')
    }
    if (conditionalFormattings.some((format) => format.rules?.some((rule) => {
      const style = (rule as ConditionalFormattingRule & { style?: Partial<Style> }).style
      return Boolean(style?.alignment || style?.border || style?.numFmt || style?.protection)
    }))) {
      features.add('advanced conditional formatting styles')
    }
  })
  return [...features].sort()
}

/** Convert the broadly-supported ExcelJS subset into a Univer workbook snapshot. */
export async function importXlsx(bytes: Uint8Array, locale: LocaleType): Promise<IWorkbookData> {
  const workbook = new Workbook()
  const input = bytes.slice().buffer as ArrayBuffer
  await workbook.xlsx.load(input)
  const snapshot = workbookSnapshot(locale, workbook.title || 'Workbook')
  const filterResources: ResourceMap = {}
  const dataValidationResources: ResourceMap = {}
  const conditionalFormattingResources: ResourceMap = {}
  const drawingResources: ResourceMap = {}

  workbook.eachSheet((worksheet) => {
    const sheetId = crypto.randomUUID()
    const cellData: NonNullable<IWorkbookData['sheets'][string]['cellData']> = {}
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const data = cellValue(cell)
        if (!data) return
        const rowIndex = rowNumber - 1
        cellData[rowIndex] ??= {}
        cellData[rowIndex][columnNumber - 1] = data
      })
    })
    const rowData: NonNullable<IWorkbookData['sheets'][string]['rowData']> = {}
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (row.height || row.hidden) {
        rowData[rowNumber - 1] = {
          h: row.height ? Math.round(row.height * 4 / 3) : undefined,
          hd: row.hidden ? BooleanNumber.TRUE : undefined,
        }
      }
    })
    const columnData: NonNullable<IWorkbookData['sheets'][string]['columnData']> = {}
    const maxColumn = Math.max(worksheet.columnCount, DEFAULT_COLUMNS)
    for (let columnNumber = 1; columnNumber <= worksheet.columnCount; columnNumber += 1) {
      const column = worksheet.getColumn(columnNumber)
      if (column.width || column.hidden) {
        columnData[columnNumber - 1] = {
          w: column.width ? Math.round(column.width * 7 + 5) : undefined,
          hd: column.hidden ? BooleanNumber.TRUE : undefined,
        }
      }
    }
    const views = worksheet.views ?? []
    const frozen = views.find((view) => view.state === 'frozen') as
      | { xSplit?: number; ySplit?: number }
      | undefined
    snapshot.sheetOrder.push(sheetId)
    snapshot.sheets[sheetId] = {
      id: sheetId,
      name: worksheet.name,
      hidden: worksheet.state === 'visible' ? BooleanNumber.FALSE : BooleanNumber.TRUE,
      rowCount: Math.max(worksheet.rowCount, DEFAULT_ROWS),
      columnCount: maxColumn,
      cellData,
      rowData,
      columnData,
      mergeData: (worksheet.model.merges ?? []).map((merge) => parseMerge(String(merge))),
      freeze: {
        xSplit: frozen?.xSplit ?? 0,
        ySplit: frozen?.ySplit ?? 0,
        startRow: frozen?.ySplit ?? 0,
        startColumn: frozen?.xSplit ?? 0,
      },
      showGridlines: views[0]?.showGridLines === false
        ? BooleanNumber.FALSE
        : BooleanNumber.TRUE,
    }

    const filterRange = autoFilterRange(worksheet.autoFilter)
    if (filterRange) {
      filterResources[sheetId] = { ref: filterRange, filterColumns: [] }
    }

    const validationRules: ResourceRule[] = []
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        const validation = cell.dataValidation
        if (!validation?.type) return
        validationRules.push(excelDataValidationRule(validation, {
          startRow: rowNumber - 1,
          endRow: rowNumber - 1,
          startColumn: columnNumber - 1,
          endColumn: columnNumber - 1,
        }))
      })
    })
    if (validationRules.length > 0) dataValidationResources[sheetId] = validationRules

    const conditionalRules: ResourceRule[] = []
    const conditionalFormattings = (worksheet as Worksheet & {
      conditionalFormattings?: Array<{ ref: string; rules: ConditionalFormattingRule[] }>
    }).conditionalFormattings ?? []
    for (const formatting of conditionalFormattings) {
      for (const rule of formatting.rules) {
        const converted = excelConditionalRule(rule)
        if (!converted) continue
        conditionalRules.push({
          cfId: crypto.randomUUID(),
          ranges: formatting.ref.split(/\s+/).filter(Boolean).map(parseRange),
          stopIfTrue: false,
          rule: converted,
        })
      }
    }
    if (conditionalRules.length > 0) conditionalFormattingResources[sheetId] = conditionalRules

    const sheetDrawings: ResourceMap = {}
    for (const image of worksheet.getImages()) {
      const source = workbook.getImage(Number(image.imageId))
      const extension = source.extension === 'jpeg' || source.extension === 'gif' ? source.extension : 'png'
      const base64 = source.base64
        ?? (source.buffer ? bytesToBase64(new Uint8Array(source.buffer)) : null)
      if (!base64) continue
      const drawingId = crypto.randomUUID()
      const range = image.range as unknown as {
        tl: { col: number; row: number }
        br: { col: number; row: number }
      }
      const sheetTransform = {
        from: anchorPosition(range.tl),
        to: anchorPosition(range.br),
      }
      sheetDrawings[drawingId] = {
        drawingId,
        drawingType: DrawingTypeEnum.DRAWING_IMAGE,
        imageSourceType: 'BASE64',
        source: base64.startsWith('data:') ? base64 : `data:image/${extension};base64,${base64}`,
        unitId: snapshot.id,
        subUnitId: sheetId,
        sheetTransform,
        axisAlignSheetTransform: sheetTransform,
      }
    }
    if (Object.keys(sheetDrawings).length > 0) drawingResources[sheetId] = sheetDrawings
  })
  if (snapshot.sheetOrder.length === 0) return createEmptyWorkbook(locale, snapshot.name)
  setResource(snapshot, FILTER_RESOURCE, filterResources)
  setResource(snapshot, DATA_VALIDATION_RESOURCE, dataValidationResources)
  setResource(snapshot, CONDITIONAL_FORMATTING_RESOURCE, conditionalFormattingResources)
  setResource(snapshot, DRAWING_RESOURCE, drawingResources)
  const incompatible = await unsupportedFeatures(bytes, workbook)
  if (incompatible.length > 0) {
    snapshot.custom = { ...snapshot.custom, [COMPATIBILITY_CUSTOM_KEY]: incompatible }
  }
  return snapshot
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function anchorPosition(anchor: { col: number; row: number }) {
  const column = Math.max(0, Math.floor(anchor.col))
  const row = Math.max(0, Math.floor(anchor.row))
  return {
    column,
    row,
    columnOffset: Math.max(0, anchor.col - column) * 64,
    rowOffset: Math.max(0, anchor.row - row) * 20,
  }
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + value % 26) + label
    value = Math.floor(value / 26)
  }
  return label
}

function resolveStyle(snapshot: IWorkbookData, value: ICellData['s']): IStyleData | undefined {
  if (!value) return undefined
  return typeof value === 'string' ? snapshot.styles[value] ?? undefined : value
}

function univerStyle(style: IStyleData | undefined): Partial<Style> {
  if (!style) return {}
  const result: Partial<Style> = {}
  const fontColor = argb(style.cl)
  if (style.ff || style.fs || style.bl || style.it || style.ul || style.st || fontColor) {
    result.font = {
      name: style.ff ?? undefined,
      size: style.fs,
      bold: style.bl === BooleanNumber.TRUE,
      italic: style.it === BooleanNumber.TRUE,
      underline: style.ul?.s === BooleanNumber.TRUE,
      strike: style.st?.s === BooleanNumber.TRUE,
      color: fontColor,
    }
  }
  const fillColor = argb(style.bg)
  if (fillColor) result.fill = { type: 'pattern', pattern: 'solid', fgColor: fillColor }
  if (style.n?.pattern) result.numFmt = style.n.pattern

  let horizontal: 'left' | 'center' | 'right' | 'justify' | 'distributed' | undefined
  if (style.ht === HorizontalAlign.LEFT) horizontal = 'left'
  else if (style.ht === HorizontalAlign.CENTER) horizontal = 'center'
  else if (style.ht === HorizontalAlign.RIGHT) horizontal = 'right'
  else if (style.ht === HorizontalAlign.JUSTIFIED) horizontal = 'justify'
  else if (style.ht === HorizontalAlign.DISTRIBUTED) horizontal = 'distributed'
  let vertical: 'top' | 'middle' | 'bottom' | undefined
  if (style.vt === VerticalAlign.TOP) vertical = 'top'
  else if (style.vt === VerticalAlign.MIDDLE) vertical = 'middle'
  else if (style.vt === VerticalAlign.BOTTOM) vertical = 'bottom'
  if (horizontal || vertical || style.tb === WrapStrategy.WRAP) {
    result.alignment = { horizontal, vertical, wrapText: style.tb === WrapStrategy.WRAP }
  }

  const border = (source: IBorderStyleData | null | undefined | void) => {
    if (!source) return undefined
    const borderStyle = BORDER_TO_EXCEL[source.s]
    return borderStyle ? { style: borderStyle, color: argb(source.cl) } : undefined
  }
  if (style.bd) {
    result.border = {
      top: border(style.bd.t),
      right: border(style.bd.r),
      bottom: border(style.bd.b),
      left: border(style.bd.l),
    }
  }
  return result
}

function dataValidationFromRule(rule: ResourceRule): DataValidation | null {
  let type = rule.type
  let formula1 = rule.formula1
  if (type === 'listMultiple') type = 'list'
  if (type === 'checkbox') {
    type = 'list'
    formula1 = '"TRUE,FALSE"'
  }
  if (type === 'time') type = 'decimal'
  if (!['list', 'whole', 'decimal', 'date', 'textLength', 'custom'].includes(type)) return null
  const formulae = [formula1, rule.formula2]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => typeof value === 'string' ? value.replace(/^=/, '') : value)
  return {
    type,
    formulae,
    allowBlank: rule.allowBlank,
    operator: rule.operator,
    error: rule.error,
    errorTitle: rule.errorTitle,
    errorStyle: rule.errorStyle,
    prompt: rule.prompt,
    promptTitle: rule.promptTitle,
    showErrorMessage: rule.showErrorMessage,
    showInputMessage: rule.showInputMessage,
  } as DataValidation
}

function conditionalRuleFromResource(rule: ResourceRule, priority: number): ConditionalFormattingRule | null {
  const config = rule.rule as ResourceRule | undefined
  if (!config) return null
  const style = univerStyle(config.style as IStyleData | undefined)
  if (config.type === 'highlightCell') {
    if (config.subType === 'number') {
      const values = Array.isArray(config.value) ? config.value : [config.value]
      return {
        type: 'cellIs',
        operator: config.operator,
        formulae: values.map(String),
        priority,
        style,
      } as ConditionalFormattingRule
    }
    if (config.subType === 'formula') {
      return {
        type: 'expression',
        formulae: [String(config.value ?? '').replace(/^=/, '')],
        priority,
        style,
      }
    }
    if (config.subType === 'text') {
      return {
        type: 'containsText',
        operator: config.operator,
        text: String(config.value ?? ''),
        priority,
        style,
      } as ConditionalFormattingRule
    }
    if (config.subType === 'timePeriod') {
      return {
        type: 'timePeriod',
        timePeriod: config.operator,
        priority,
        style,
      } as ConditionalFormattingRule
    }
    if (config.subType === 'rank') {
      return {
        type: 'top10',
        rank: Number(config.value ?? 10),
        percent: Boolean(config.isPercent),
        bottom: Boolean(config.isBottom),
        priority,
        style,
      }
    }
    if (config.subType === 'average') {
      return {
        type: 'aboveAverage',
        aboveAverage: !String(config.operator).startsWith('less'),
        priority,
        style,
      }
    }
  }
  if (config.type === 'colorScale') {
    const values = Array.isArray(config.config) ? config.config : []
    return {
      type: 'colorScale',
      cfvo: values.map((value: ResourceRule) => ({ type: value.type, value: value.value })),
      color: values.map((value: ResourceRule) => argb({ rgb: value.color }) ?? { argb: 'FFFFFFFF' }),
      priority,
    } as ConditionalFormattingRule
  }
  if (config.type === 'dataBar') {
    const values = config.config as ResourceRule | undefined
    return {
      type: 'dataBar',
      showValue: config.isShowValue !== false,
      gradient: values?.isGradient !== false,
      cfvo: [values?.min ?? { type: 'min' }, values?.max ?? { type: 'max' }],
      color: argb({ rgb: values?.positiveColor }) ?? { argb: 'FF638EC6' },
      priority,
    } as ConditionalFormattingRule
  }
  if (config.type === 'iconSet') {
    const values = Array.isArray(config.config) ? config.config : []
    let iconSet = '3Arrows'
    if (values.length >= 5) iconSet = '5Arrows'
    else if (values.length === 4) iconSet = '4Arrows'
    return {
      type: 'iconSet',
      showValue: config.isShowValue !== false,
      iconSet,
      cfvo: values.map((value: ResourceRule) => ({ type: value.value?.type, value: value.value?.value })),
      priority,
    } as ConditionalFormattingRule
  }
  return null
}

function imageSource(value: string): { base64: string; extension: 'jpeg' | 'png' | 'gif' } | null {
  const match = /^data:image\/(png|jpe?g|gif);base64,(.+)$/i.exec(value)
  if (!match) return null
  const extension = match[1]!.toLocaleLowerCase()
  return {
    base64: match[2]!,
    extension: extension === 'jpg' ? 'jpeg' : extension as 'jpeg' | 'png' | 'gif',
  }
}

function fractionalAnchor(value: ResourceRule | undefined): { col: number; row: number } {
  return {
    col: Math.max(0, Number(value?.column ?? 0) + Number(value?.columnOffset ?? 0) / 64),
    row: Math.max(0, Number(value?.row ?? 0) + Number(value?.rowOffset ?? 0) / 20),
  }
}

/** Export the current Univer snapshot as an Office-compatible .xlsx payload. */
export async function exportXlsx(
  snapshot: IWorkbookData,
  options: { allowLossy?: boolean } = {},
): Promise<Uint8Array> {
  const incompatible = unsupportedWorkbookFeatures(snapshot)
  if (incompatible.length > 0 && !options.allowLossy) {
    throw new UnsupportedWorkbookFeatureError(incompatible)
  }
  const workbook = new Workbook()
  workbook.title = snapshot.name
  workbook.creator = 'Bridgic Excel'
  workbook.calcProperties.fullCalcOnLoad = true

  const filters = resourceMap(snapshot, FILTER_RESOURCE)
  const validations = resourceMap(snapshot, DATA_VALIDATION_RESOURCE)
  const conditionalFormatting = resourceMap(snapshot, CONDITIONAL_FORMATTING_RESOURCE)
  const drawings = resourceMap(snapshot, DRAWING_RESOURCE)
  const conversionFailures = new Set<string>()

  for (const sheetId of snapshot.sheetOrder) {
    const source = snapshot.sheets[sheetId]
    if (!source) continue
    const worksheet = workbook.addWorksheet(source.name || 'Sheet')
    worksheet.state = source.hidden === BooleanNumber.TRUE ? 'hidden' : 'visible'
    if ((source.freeze?.xSplit ?? 0) > 0 || (source.freeze?.ySplit ?? 0) > 0) {
      worksheet.views = [{
        state: 'frozen',
        xSplit: source.freeze?.xSplit ?? 0,
        ySplit: source.freeze?.ySplit ?? 0,
      }]
    } else if (source.showGridlines === BooleanNumber.FALSE) {
      worksheet.views = [{ state: 'normal', showGridLines: false }]
    }

    for (const [rowKey, cells] of Object.entries(source.cellData ?? {})) {
      const rowIndex = Number(rowKey)
      for (const [columnKey, data] of Object.entries(cells as Record<string, ICellData>)) {
        const columnIndex = Number(columnKey)
        const cell = worksheet.getCell(rowIndex + 1, columnIndex + 1)
        if (data.f) {
          cell.value = { formula: data.f.replace(/^=/, ''), result: data.v ?? undefined }
        } else if (data.v !== null && data.v !== undefined) {
          cell.value = data.v
        }
        cell.style = univerStyle(resolveStyle(snapshot, data.s))
      }
    }
    for (const [rowKey, row] of Object.entries(source.rowData ?? {})) {
      const target = worksheet.getRow(Number(rowKey) + 1)
      if (row.h) target.height = row.h * 3 / 4
      target.hidden = row.hd === BooleanNumber.TRUE
    }
    for (const [columnKey, column] of Object.entries(source.columnData ?? {})) {
      const target = worksheet.getColumn(Number(columnKey) + 1)
      if (column.w) target.width = Math.max(1, (column.w - 5) / 7)
      target.hidden = column.hd === BooleanNumber.TRUE
    }
    for (const merge of source.mergeData ?? []) {
      const start = `${columnLabel(merge.startColumn)}${merge.startRow + 1}`
      const end = `${columnLabel(merge.endColumn)}${merge.endRow + 1}`
      worksheet.mergeCells(`${start}:${end}`)
    }

    const filter = filters[sheetId] as ResourceRule | undefined
    if (filter?.ref) worksheet.autoFilter = rangeAddress(filter.ref as IRange)

    const sheetValidations = validations[sheetId]
    if (Array.isArray(sheetValidations)) {
      for (const rule of sheetValidations as ResourceRule[]) {
        const validation = dataValidationFromRule(rule)
        if (!validation) {
          conversionFailures.add(`data validation type ${String(rule.type)}`)
          continue
        }
        for (const range of Array.isArray(rule.ranges) ? rule.ranges as IRange[] : []) {
          for (let row = range.startRow; row <= range.endRow; row += 1) {
            for (let column = range.startColumn; column <= range.endColumn; column += 1) {
              worksheet.getCell(row + 1, column + 1).dataValidation = { ...validation }
            }
          }
        }
      }
    }

    const sheetConditionalFormatting = conditionalFormatting[sheetId]
    if (Array.isArray(sheetConditionalFormatting)) {
      let priority = 1
      for (const rule of sheetConditionalFormatting as ResourceRule[]) {
        const converted = conditionalRuleFromResource(rule, priority)
        if (!converted) {
          conversionFailures.add('conditional formatting rule')
          continue
        }
        const ranges = Array.isArray(rule.ranges) ? rule.ranges as IRange[] : []
        for (const range of ranges) {
          worksheet.addConditionalFormatting({ ref: rangeAddress(range), rules: [converted] })
        }
        priority += 1
      }
    }

    const sheetDrawings = drawings[sheetId]
    if (sheetDrawings && typeof sheetDrawings === 'object' && !Array.isArray(sheetDrawings)) {
      for (const value of Object.values(sheetDrawings as ResourceMap)) {
        const drawing = value as ResourceRule
        if (drawing.drawingType !== DrawingTypeEnum.DRAWING_IMAGE) {
          conversionFailures.add('non-image drawing')
          continue
        }
        const image = imageSource(String(drawing.source ?? ''))
        const transform = (drawing.axisAlignSheetTransform ?? drawing.sheetTransform) as ResourceRule | undefined
        if (!image || !transform?.from || !transform?.to) {
          conversionFailures.add('image with an unsupported source or anchor')
          continue
        }
        const imageId = workbook.addImage(image)
        worksheet.addImage(imageId, {
          tl: fractionalAnchor(transform.from as ResourceRule),
          br: fractionalAnchor(transform.to as ResourceRule),
          editAs: 'oneCell',
        } as never)
      }
    }
  }
  if (conversionFailures.size > 0 && !options.allowLossy) {
    throw new UnsupportedWorkbookFeatureError([...conversionFailures].sort())
  }
  if (workbook.worksheets.length === 0) workbook.addWorksheet('Sheet1')
  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer)
}

/** Create a fresh workbook with the locale used by the visible Univer UI. */
export function createEmptyWorkbook(locale: LocaleType, name = 'Workbook'): IWorkbookData {
  const snapshot = workbookSnapshot(locale, name)
  const sheetId = crypto.randomUUID()
  snapshot.sheetOrder.push(sheetId)
  snapshot.sheets[sheetId] = {
    id: sheetId,
    name: 'Sheet1',
    rowCount: DEFAULT_ROWS,
    columnCount: DEFAULT_COLUMNS,
  }
  return snapshot
}

function workbookSnapshot(locale: LocaleType, name: string): IWorkbookData {
  return {
    id: crypto.randomUUID(),
    name,
    appVersion: '0.25.1',
    locale,
    styles: {},
    sheetOrder: [],
    sheets: {},
    resources: [],
  }
}
