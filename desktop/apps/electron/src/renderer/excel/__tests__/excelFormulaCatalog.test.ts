import { describe, expect, it } from 'bun:test'
import { EXCEL_FORMULA_CATEGORIES } from '../excelFormulaCatalog'

describe('Excel formula catalog', () => {
  it('covers the main Excel function families supported by the open-source formula engine', () => {
    expect(Object.keys(EXCEL_FORMULA_CATEGORIES)).toEqual([
      'common',
      'financial',
      'logical',
      'text',
      'date',
      'lookup',
      'math',
      'statistical',
    ])
    expect(EXCEL_FORMULA_CATEGORIES.financial).toContain('PMT')
    expect(EXCEL_FORMULA_CATEGORIES.logical).toContain('IFERROR')
    expect(EXCEL_FORMULA_CATEGORIES.text).toContain('TEXTJOIN')
    expect(EXCEL_FORMULA_CATEGORIES.date).toContain('WORKDAY')
    expect(EXCEL_FORMULA_CATEGORIES.lookup).toContain('XLOOKUP')
    expect(EXCEL_FORMULA_CATEGORIES.math).toContain('SUMIFS')
    expect(EXCEL_FORMULA_CATEGORIES.statistical).toContain('COUNTIFS')
    expect(Object.values(EXCEL_FORMULA_CATEGORIES).flat().length).toBeGreaterThanOrEqual(80)
  })
})
