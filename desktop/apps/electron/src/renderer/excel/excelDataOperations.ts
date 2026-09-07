import type { IRange } from '@univerjs/core'

type GridRange = Pick<IRange, 'endColumn' | 'endRow' | 'startColumn' | 'startRow'>

export type ExcelDataOperationErrorCode =
  | 'filter-range-required'
  | 'filter-not-active'
  | 'sort-range-required'

export class ExcelDataOperationError extends Error {
  constructor(readonly code: ExcelDataOperationErrorCode) {
    super(code)
    this.name = 'ExcelDataOperationError'
  }
}

export interface ExcelDataRangeTarget extends GridRange {
  columnCount: number
  rowCount: number
}

export interface ExcelSortTarget extends ExcelDataRangeTarget {
  sortColumn: number
}

function normalizeRange(range: GridRange): ExcelDataRangeTarget {
  return {
    startColumn: range.startColumn,
    endColumn: range.endColumn,
    startRow: range.startRow,
    endRow: range.endRow,
    columnCount: range.endColumn - range.startColumn + 1,
    rowCount: range.endRow - range.startRow + 1,
  }
}

function operationRange(selection: GridRange, dataRegion: GridRange, filterRange?: GridRange): ExcelDataRangeTarget {
  if (filterRange) return normalizeRange(filterRange)
  const selected = normalizeRange(selection)
  return selected.rowCount > 1 || selected.columnCount > 1 ? selected : normalizeRange(dataRegion)
}

/** Uses an explicit selection when present and otherwise expands the active cell to its adjacent data table. */
export function resolveFilterTarget(selection: GridRange, dataRegion: GridRange, headerOffset = 0): ExcelDataRangeTarget {
  const original = operationRange(selection, dataRegion)
  const offset = Math.max(0, Math.min(headerOffset, original.rowCount - 1))
  const target = {
    ...original,
    startRow: original.startRow + offset,
    rowCount: original.rowCount - offset,
  }
  if (target.rowCount < 2 || target.columnCount < 1) throw new ExcelDataOperationError('filter-range-required')
  return target
}

/** Sorts the table body while preserving its first row as the header. */
export function resolveSortTarget(
  selection: GridRange,
  dataRegion: GridRange,
  filterRange?: GridRange,
  headerOffset = 0,
  footerRows = 0,
): ExcelSortTarget {
  const original = operationRange(selection, dataRegion, filterRange)
  const offset = Math.max(0, Math.min(headerOffset, original.rowCount - 1))
  const footer = Math.max(0, Math.min(footerRows, original.rowCount - offset - 1))
  const table = {
    ...original,
    startRow: original.startRow + offset,
    endRow: original.endRow - footer,
    rowCount: original.rowCount - offset - footer,
  }
  if (table.rowCount < 3 || table.columnCount < 1) throw new ExcelDataOperationError('sort-range-required')
  const activeColumn = Math.max(table.startColumn, Math.min(selection.startColumn, table.endColumn))
  return {
    startColumn: table.startColumn,
    endColumn: table.endColumn,
    startRow: table.startRow + 1,
    endRow: table.endRow,
    columnCount: table.columnCount,
    rowCount: table.rowCount - 1,
    sortColumn: activeColumn - table.startColumn,
  }
}

/** Detects a sparse title row above a denser header row, as commonly found in report-style workbooks. */
export function detectTableHeaderOffset(values: unknown[][]): number {
  if (values.length < 2 || (values[0]?.length ?? 0) < 2) return 0
  const populated = values.slice(0, Math.min(values.length - 1, 5)).map((row) => row
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '').length)
  const first = populated[0] ?? 0
  const densest = Math.max(...populated)
  const offset = populated.findIndex((count) => count === densest)
  return offset > 0 && first <= Math.max(1, Math.floor(densest / 2)) ? offset : 0
}

export function detectTableFooterRows(values: unknown[][]): number {
  const last = values.at(-1)
  if (!last) return 0
  const label = last.find((value) => typeof value === 'string' && value.trim())
  return typeof label === 'string'
    && /^(?:(?:合计|总计|小计)(?:$|\s|[:：])|(?:total|grand total|subtotal)\b)/i.test(label.trim()) ? 1 : 0
}

export function excelDataOperationMessage(cause: unknown, locale: 'en-US' | 'zh-CN'): string | null {
  if (!(cause instanceof ExcelDataOperationError)) return null
  const messages = locale === 'zh-CN' ? {
    'filter-range-required': '请先选中包含表头和至少一行数据的区域。',
    'filter-not-active': '当前工作表还没有启用筛选。',
    'sort-range-required': '请先选中包含表头和至少两行数据的区域。',
  } : {
    'filter-range-required': 'Select a range with a header and at least one data row first.',
    'filter-not-active': 'Filtering is not enabled on this sheet yet.',
    'sort-range-required': 'Select a range with a header and at least two data rows first.',
  }
  return messages[cause.code]
}
