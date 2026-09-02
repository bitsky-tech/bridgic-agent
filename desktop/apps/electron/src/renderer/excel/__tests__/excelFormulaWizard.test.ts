import { describe, expect, it } from 'bun:test'
import type { ExcelFormulaDescriptor } from '../excelFormulaCatalog'
import {
  buildFormula,
  formulaPreviewErrorMessage,
  formulaPreviewResult,
  missingFormulaArgument,
  parseFormulaCall,
  rangeReference,
} from '../excelFormulaWizard'

const formula: ExcelFormulaDescriptor = {
  categories: ['lookup'],
  description: 'Looks up a value.',
  maxParameters: 4,
  minParameters: 3,
  name: 'XLOOKUP',
  parameters: [
    { detail: '', key: 'lookupValue', name: 'Lookup value', required: true },
    { detail: '', key: 'lookupArray', name: 'Lookup array', required: true },
    { detail: '', key: 'returnArray', name: 'Return array', required: true },
    { detail: '', key: 'notFound', name: 'Not found', required: false },
  ],
  syntax: 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found])',
}

describe('Excel formula wizard helpers', () => {
  it('builds a formula while keeping meaningful empty arguments', () => {
    expect(buildFormula('XLOOKUP', ['A1', 'B1:B4', 'C1:C4', ''])).toBe('=XLOOKUP(A1,B1:B4,C1:C4)')
    expect(buildFormula('IF', ['A1', '', '0'])).toBe('=IF(A1,,0)')
  })

  it('parses nested calls, quoted commas, and semicolon separators', () => {
    expect(parseFormulaCall('=IF(A1="a,b",SUM(B1:B3),"x")')).toEqual({
      arguments: ['A1="a,b"', 'SUM(B1:B3)', '"x"'],
      name: 'IF',
    })
    expect(parseFormulaCall('=SUM(A1;B2)')).toEqual({ arguments: ['A1', 'B2'], name: 'SUM' })
    expect(parseFormulaCall('A1+B1')).toBeNull()
  })

  it('validates required arguments and formats cross-sheet references', () => {
    expect(missingFormulaArgument(formula, ['A1', '', 'C1:C4'])).toBe(1)
    expect(missingFormulaArgument(formula, ['A1', 'B1:B4', 'C1:C4'])).toBeNull()
    expect(rangeReference('B2:C8', 'Sheet1', 'Sheet1')).toBe('B2:C8')
    expect(rangeReference('B2:C8', "North's data", 'Sheet1')).toBe("'North''s data'!B2:C8")
  })

  it('turns engine results and formula errors into readable previews', () => {
    expect(formulaPreviewResult({ v: 42 })).toEqual({ value: '42' })
    expect(formulaPreviewResult({ v: '#REF!' })).toEqual({ errorCode: '#REF!' })
    expect(formulaPreviewResult({ v: [[1, 2], [3, 4]] })).toEqual({ value: '1, 2\n3, 4' })
    expect(formulaPreviewResult([[{ v: 42 }]])).toEqual({ value: '42' })
    expect(formulaPreviewResult([[{ v: '#VALUE!' }]])).toEqual({ errorCode: '#VALUE!' })
    expect(formulaPreviewErrorMessage('#DIV/0!', 'zh-CN')).toContain('除数为 0')
    expect(formulaPreviewErrorMessage('#REF!', 'en-US')).toContain('invalid')
  })
})
