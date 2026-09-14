import { describe, expect, it } from 'bun:test'
import {
  ExcelDataOperationError,
  detectTableFooterRows,
  detectTableHeaderOffset,
  excelDataOperationMessage,
  resolveFilterTarget,
  resolveSortTarget,
} from '../excelDataOperations'

const cell = { startRow: 3, endRow: 3, startColumn: 2, endColumn: 2 }
const table = { startRow: 1, endRow: 8, startColumn: 1, endColumn: 4 }

describe('Excel data operations', () => {
  it('expands a single cell to its adjacent table for filtering', () => {
    expect(resolveFilterTarget(cell, table)).toEqual({
      ...table,
      columnCount: 4,
      rowCount: 8,
    })
  })

  it('preserves the table header and sorts by the active column', () => {
    expect(resolveSortTarget(cell, table)).toEqual({
      startRow: 2,
      endRow: 8,
      startColumn: 1,
      endColumn: 4,
      columnCount: 4,
      rowCount: 7,
      sortColumn: 1,
    })
  })

  it('uses the active filter range and returns friendly validation text', () => {
    const filterRange = { startRow: 5, endRow: 12, startColumn: 4, endColumn: 7 }
    expect(resolveSortTarget(cell, table, filterRange).sortColumn).toBe(0)
    expect(() => resolveSortTarget(cell, cell)).toThrow(ExcelDataOperationError)
    try {
      resolveSortTarget(cell, cell)
    } catch (cause) {
      expect(excelDataOperationMessage(cause, 'zh-CN')).toContain('至少两行数据')
    }
  })

  it('recognizes report titles and total rows without treating them as sortable data', () => {
    const values = [
      ['佛教历史 · 章节概览', null, null, null],
      ['章节', '时期范围', '大事记录数', '核心内容'],
      ['佛教的起源', '公元前', 5, '内容'],
      ['合计', null, 5, null],
    ]
    expect(detectTableHeaderOffset(values)).toBe(1)
    expect(detectTableFooterRows(values)).toBe(1)
    expect(resolveFilterTarget(table, table, 1).startRow).toBe(2)
    expect(resolveSortTarget(table, table, undefined, 1, 1)).toMatchObject({
      startRow: 3,
      endRow: 7,
      rowCount: 5,
    })
  })
})
