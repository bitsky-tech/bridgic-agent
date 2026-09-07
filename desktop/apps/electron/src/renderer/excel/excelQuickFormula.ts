import type { IRange } from '@univerjs/core'

export type ExcelQuickFormulaName = 'SUM' | 'AVERAGE' | 'COUNT' | 'MAX' | 'MIN'

export interface ExcelQuickFormulaTarget {
  source: IRange
  target: IRange
}

function cellRange(row: number, column: number): IRange {
  return { startRow: row, endRow: row, startColumn: column, endColumn: column }
}

export function quickFormulaTargets(selection: IRange): ExcelQuickFormulaTarget[] {
  const rowCount = selection.endRow - selection.startRow + 1
  const columnCount = selection.endColumn - selection.startColumn + 1
  if (rowCount === 1 && columnCount > 1) {
    return [{
      source: { ...selection },
      target: cellRange(selection.startRow, selection.endColumn + 1),
    }]
  }
  return Array.from({ length: columnCount }, (_, offset) => {
    const column = selection.startColumn + offset
    return {
      source: {
        startRow: selection.startRow,
        endRow: selection.endRow,
        startColumn: column,
        endColumn: column,
      },
      target: cellRange(selection.endRow + 1, column),
    }
  })
}

export function contiguousDataStart(values: readonly unknown[]): number | null {
  let start = values.length
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] === null || values[index] === undefined || values[index] === '') break
    start = index
  }
  return start === values.length ? null : start
}

export function quickFormulaExpression(formulaName: ExcelQuickFormulaName, address: string): string {
  return `=${formulaName}(${address})`
}
