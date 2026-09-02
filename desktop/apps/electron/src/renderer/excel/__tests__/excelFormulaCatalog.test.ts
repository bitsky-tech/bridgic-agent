import { ALL_IMPLEMENTED_FUNCTIONS_SET } from '@univerjs/engine-formula'
import { describe, expect, it } from 'bun:test'
import {
  EXCEL_FORMULA_CATEGORIES,
  excelFormulaLibrary,
  filterFormulaLibrary,
  isImplementedFormula,
  rememberFormula,
} from '../excelFormulaCatalog'

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
    expect(Object.values(EXCEL_FORMULA_CATEGORIES).flat().every(isImplementedFormula)).toBeTrue()
  })

  it('only exposes registered implementations with localized metadata', () => {
    const library = excelFormulaLibrary('zh-CN')
    const xlookup = library.find((formula) => formula.name === 'XLOOKUP')
    expect(library).toHaveLength(505)
    expect(library.every((formula) => ALL_IMPLEMENTED_FUNCTIONS_SET.has(formula.name as never))).toBeTrue()
    expect(library.some((formula) => formula.name === 'CUBEMEMBER')).toBeFalse()
    expect(library.some((formula) => formula.name === 'NETWORKDAYS.INTL')).toBeTrue()
    expect(library.some((formula) => formula.name === 'NETWORKDAYS_INTL')).toBeFalse()
    expect(xlookup?.syntax).toContain('查找值')
    expect(xlookup?.description.length).toBeGreaterThan(10)
    expect(xlookup?.parameters.length).toBeGreaterThanOrEqual(3)
    expect(filterFormulaLibrary(library, '搜索', 'all').some((formula) => formula.name === 'XLOOKUP')).toBeTrue()
    expect(filterFormulaLibrary(library, '', 'financial').some((formula) => formula.name === 'PMT')).toBeTrue()
    expect(filterFormulaLibrary(library, '', 'math').some((formula) => formula.name === 'SUM')).toBeTrue()
  })

  it('keeps recently inserted functions unique and ordered', () => {
    expect(rememberFormula(['SUM', 'IF'], 'sum')).toEqual(['SUM', 'IF'])
    expect(rememberFormula(['SUM', 'IF'], 'XLOOKUP')).toEqual(['XLOOKUP', 'SUM', 'IF'])
    expect(rememberFormula(['SUM', 'CUBEMEMBER'], 'WEBSERVICE')).toEqual(['SUM'])
  })
})
