import { ALL_IMPLEMENTED_FUNCTIONS, ALL_IMPLEMENTED_FUNCTIONS_SET } from '@univerjs/engine-formula'
import formulaEnUS from '@univerjs/sheets-formula/locale/en-US'
import formulaZhCN from '@univerjs/sheets-formula/locale/zh-CN'
import type { ExcelHostConfig } from '../../shared/types'

export type ExcelFormulaCategory =
  | 'common'
  | 'financial'
  | 'logical'
  | 'text'
  | 'date'
  | 'lookup'
  | 'math'
  | 'statistical'

export interface ExcelFormulaParameter {
  detail: string
  key: string
  name: string
  required: boolean
}

export interface ExcelFormulaDescriptor {
  categories: ExcelFormulaCategory[]
  description: string
  maxParameters: number | null
  minParameters: number
  name: string
  parameters: ExcelFormulaParameter[]
  syntax: string
}

interface FormulaLocaleEntry {
  abstract?: string
  description?: string
  functionParameter?: Record<string, { detail?: string; name?: string }>
}

type FormulaLocale = {
  'sheets-formula': {
    functionList: Record<string, FormulaLocaleEntry>
  }
}

export const EXCEL_FORMULA_CATEGORIES: Record<ExcelFormulaCategory, readonly string[]> = {
  common: ['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'IF', 'SUMIF', 'COUNTIF', 'SUBTOTAL'],
  financial: ['PMT', 'PV', 'FV', 'NPV', 'IRR', 'XIRR', 'RATE', 'NPER', 'IPMT', 'PPMT'],
  logical: ['IF', 'IFS', 'AND', 'OR', 'NOT', 'XOR', 'IFERROR', 'IFNA', 'SWITCH', 'LET'],
  text: ['CONCAT', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'TEXT', 'SUBSTITUTE', 'TEXTSPLIT'],
  date: ['TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'EDATE', 'EOMONTH', 'WORKDAY', 'NETWORKDAYS'],
  lookup: ['XLOOKUP', 'VLOOKUP', 'HLOOKUP', 'INDEX', 'MATCH', 'XMATCH', 'FILTER', 'UNIQUE', 'SORT', 'OFFSET'],
  math: ['SUM', 'SUMIF', 'SUMIFS', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'MOD', 'SUMPRODUCT', 'SUBTOTAL'],
  statistical: ['AVERAGE', 'AVERAGEIF', 'AVERAGEIFS', 'COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS', 'MAX', 'MIN', 'MEDIAN'],
} as const

const CATEGORIES_BY_FUNCTION = new Map<string, ExcelFormulaCategory[]>()
for (const [category, functions] of Object.entries(EXCEL_FORMULA_CATEGORIES)) {
  for (const name of functions) {
    const categories = CATEGORIES_BY_FUNCTION.get(name) ?? []
    categories.push(category as ExcelFormulaCategory)
    CATEGORIES_BY_FUNCTION.set(name, categories)
  }
}

function functionList(locale: ExcelHostConfig['locale']): Record<string, FormulaLocaleEntry> {
  const source = (locale === 'zh-CN' ? formulaZhCN : formulaEnUS) as unknown as FormulaLocale
  return source['sheets-formula'].functionList
}

function localeKey(name: string): string {
  return name.replaceAll('.', '_')
}

export function isImplementedFormula(name: string): boolean {
  return (ALL_IMPLEMENTED_FUNCTIONS_SET as ReadonlySet<string>).has(name.trim().toUpperCase())
}

export function excelFormulaLibrary(locale: ExcelHostConfig['locale']): ExcelFormulaDescriptor[] {
  const localizedFunctions = functionList(locale)
  return ALL_IMPLEMENTED_FUNCTIONS.flatMap(([FormulaImplementation, registeredName]) => {
    const name = String(registeredName)
    const entry = localizedFunctions[localeKey(name)]
    if (!entry) return []
    const implementation = new FormulaImplementation(registeredName)
    const minParameters = implementation.minParams
    const maxParameters = implementation.maxParams < 0 ? null : implementation.maxParams
    implementation.dispose()
    const parameters = Object.entries(entry.functionParameter ?? {}).map(([key, parameter], index) => ({
      detail: parameter.detail?.trim() ?? '',
      key,
      name: parameter.name?.trim() || 'value',
      required: index < minParameters,
    }))
    if (maxParameters !== null) parameters.splice(maxParameters)
    while (parameters.length < minParameters) {
      const index = parameters.length
      parameters.push({
        detail: locale === 'zh-CN' ? '请输入此函数所需的参数。' : 'Enter the argument required by this function.',
        key: `argument${index + 1}`,
        name: locale === 'zh-CN' ? `参数 ${index + 1}` : `Argument ${index + 1}`,
        required: true,
      })
    }
    return {
      categories: CATEGORIES_BY_FUNCTION.get(name) ?? [],
      description: entry.description?.trim() || entry.abstract?.trim() || '',
      maxParameters,
      minParameters,
      name,
      parameters,
      syntax: `${name}(${parameters.map((parameter) => parameter.name).join(', ')})`,
    } satisfies ExcelFormulaDescriptor
  }).sort((left, right) => left.name.localeCompare(right.name))
}

export function filterFormulaLibrary(
  library: ExcelFormulaDescriptor[],
  query: string,
  category: ExcelFormulaCategory | 'all',
): ExcelFormulaDescriptor[] {
  const normalized = query.trim().toLocaleLowerCase()
  return library.filter((formula) => {
    if (category !== 'all' && !formula.categories.includes(category)) return false
    if (!normalized) return true
    return formula.name.toLocaleLowerCase().includes(normalized)
      || formula.description.toLocaleLowerCase().includes(normalized)
      || formula.parameters.some((parameter) => parameter.name.toLocaleLowerCase().includes(normalized))
  })
}

export function rememberFormula(recent: readonly string[], name: string, limit = 8): string[] {
  const normalized = name.trim().toUpperCase()
  const validRecent = recent.filter(isImplementedFormula)
  if (!isImplementedFormula(normalized)) return [...validRecent].slice(0, limit)
  return [normalized, ...validRecent.filter((candidate) => candidate !== normalized)].slice(0, limit)
}
