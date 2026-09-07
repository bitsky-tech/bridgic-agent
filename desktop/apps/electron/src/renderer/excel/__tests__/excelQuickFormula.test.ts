import { describe, expect, it } from 'bun:test'
import { contiguousDataStart, quickFormulaExpression, quickFormulaTargets } from '../excelQuickFormula'

describe('Excel quick formulas', () => {
  it('places a vertical total below every selected column', () => {
    expect(quickFormulaTargets({ startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 })).toEqual([
      {
        source: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 0 },
        target: { startRow: 4, endRow: 4, startColumn: 0, endColumn: 0 },
      },
      {
        source: { startRow: 0, endRow: 3, startColumn: 1, endColumn: 1 },
        target: { startRow: 4, endRow: 4, startColumn: 1, endColumn: 1 },
      },
    ])
  })

  it('places a horizontal aggregate to the right of the selected row', () => {
    expect(quickFormulaTargets({ startRow: 2, endRow: 2, startColumn: 1, endColumn: 4 })).toEqual([{
      source: { startRow: 2, endRow: 2, startColumn: 1, endColumn: 4 },
      target: { startRow: 2, endRow: 2, startColumn: 5, endColumn: 5 },
    }])
  })

  it('finds the adjacent populated run and builds supported formulas', () => {
    expect(contiguousDataStart([null, 10, 20, 30])).toBe(1)
    expect(contiguousDataStart([10, 20, '', 30, 40])).toBe(3)
    expect(contiguousDataStart([null, '', null])).toBeNull()
    expect(quickFormulaExpression('SUM', 'A1:A4')).toBe('=SUM(A1:A4)')
    expect(quickFormulaExpression('AVERAGE', 'B2:B5')).toBe('=AVERAGE(B2:B5)')
  })
})
