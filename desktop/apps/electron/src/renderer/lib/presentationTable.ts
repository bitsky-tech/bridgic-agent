import type { PresentationTableElement, PresentationTextStyle } from '@/atoms/presentation'

function tableSizes(values: number[] | undefined, count: number, extent: number): number[] {
  const known = values?.filter(value => Number.isFinite(value) && value > 0) ?? []
  const fallback = known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : 1
  const weights = Array.from({ length: count }, (_, index) => {
    const value = values?.[index]
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
  })
  const total = weights.reduce((sum, value) => sum + value, 0)
  return weights.map(value => extent * value / total)
}

export function presentationTableGrid(element: PresentationTableElement) {
  const rows = Math.max(1, element.cells.length)
  const columns = Math.max(1, ...element.cells.map(row => row.length))
  const columnWidths = tableSizes(element.columnWidths, columns, element.width)
  const rowHeights = tableSizes(element.rowHeights, rows, element.height)
  const columnOffsets = columnWidths.map((_, index) => columnWidths.slice(0, index).reduce((sum, size) => sum + size, 0))
  const rowOffsets = rowHeights.map((_, index) => rowHeights.slice(0, index).reduce((sum, size) => sum + size, 0))
  return { rows, columns, columnWidths, rowHeights, columnOffsets, rowOffsets }
}

export function presentationTableCellAppearance(element: PresentationTableElement, row: number, column: number) {
  const style = element.cellStyles?.[row]?.[column]
  const header = element.headerRow && row === 0
  const columns = Math.max(1, ...element.cells.map(cells => cells.length))
  return {
    fill: style?.fill ?? (header ? element.headerFill : element.bodyFill),
    textColor: style?.textColor ?? (header ? element.headerTextColor ?? '#FFFFFF' : element.textColor),
    borderColor: style?.borderColor ?? element.borderColor,
    fontSize: style?.fontSize ?? element.fontSize,
    fontFamily: style?.fontFamily ?? 'Aptos',
    bold: style?.bold ?? header,
    align: style?.align ?? 'left',
    verticalAlign: style?.verticalAlign ?? 'middle',
    padding: style?.padding ?? { left: 10, right: 10, top: 4, bottom: 4 },
    colSpan: Math.min(Math.max(1, style?.colSpan ?? 1), columns - column),
    rowSpan: Math.min(Math.max(1, style?.rowSpan ?? 1), element.cells.length - row),
    covered: style?.covered ?? false,
  }
}

export function presentationTableCellSegments(element: PresentationTableElement, row: number, column: number): Array<{ text: string; style: PresentationTextStyle }> {
  const text = element.cells[row]?.[column] ?? ''
  const runs = element.cellStyles?.[row]?.[column]?.textRuns ?? []
  const segments: Array<{ text: string; style: PresentationTextStyle }> = []
  let offset = 0
  for (const run of runs) {
    if (run.start > offset) segments.push({ text: text.slice(offset, run.start), style: {} })
    if (run.end > run.start && run.end <= text.length) segments.push({ text: text.slice(run.start, run.end), style: run.style })
    offset = Math.max(offset, run.end)
  }
  if (offset < text.length) segments.push({ text: text.slice(offset), style: {} })
  return segments
}

export function presentationTableCellsPatch(element: PresentationTableElement, value: string[][]): Partial<PresentationTableElement> {
  const cells = value.map(row => [...row])
  if (!element.cellStyles?.length) return { cells }
  const cellStyles = cells.map((row, rowIndex) => row.map((text, columnIndex) => {
    const style = element.cellStyles?.[rowIndex]?.[columnIndex] ?? {}
    if (text === element.cells[rowIndex]?.[columnIndex]) return style
    const formatting = { ...style }
    delete formatting.textRuns
    return formatting
  }))
  return { cells, cellStyles }
}
