import { i18n } from '../lib/i18n'
import type { ExcelHostConfig } from '../../shared/types'
import type { ExcelFormulaDescriptor } from './excelFormulaCatalog'

export interface ExcelFormulaPreviewResult {
  errorCode?: string
  value?: string
}

export interface ParsedFormulaCall {
  arguments: string[]
  name: string
}

const FORMULA_ERROR_CODES = new Set([
  '#CALC!', '#CYCLE!', '#DIV/0!', '#ERROR!', '#GETTING_DATA', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#SPILL!', '#VALUE!',
])

export function buildFormula(name: string, values: readonly string[]): string {
  const arguments_ = values.map((value) => value.trim())
  while (arguments_.at(-1) === '') arguments_.pop()
  return `=${name}(${arguments_.join(',')})`
}

export function missingFormulaArgument(formula: ExcelFormulaDescriptor, values: readonly string[]): number | null {
  for (let index = 0; index < formula.minParameters; index += 1) {
    if (!values[index]?.trim()) return index
  }
  return null
}

export function parseFormulaCall(value: string): ParsedFormulaCall | null {
  const match = value.trim().match(/^=\s*([A-Z][A-Z0-9.]*)\s*\((.*)\)\s*$/is)
  if (!match) return null
  const rawName = match[1]!
  const body = match[2]!
  const arguments_: string[] = []
  let current = ''
  let depth = 0
  let quoted = false
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === '"') {
      current += character
      if (quoted && body[index + 1] === '"') {
        current += body[index + 1]
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && character === '(') depth += 1
    else if (!quoted && character === ')') depth -= 1
    if (!quoted && depth === 0 && (character === ',' || character === ';')) {
      arguments_.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (quoted || depth !== 0) return null
  if (current || body.includes(',') || body.includes(';')) arguments_.push(current.trim())
  return { arguments: arguments_, name: rawName.toUpperCase() }
}

export function rangeReference(address: string, sheetName: string, targetSheetName: string): string {
  if (!sheetName || sheetName === targetSheetName) return address
  return `'${sheetName.replaceAll("'", "''")}'!${address}`
}

export function formulaPreviewResult(cell: unknown): ExcelFormulaPreviewResult {
  const value = cell && typeof cell === 'object' && 'v' in cell
    ? (cell as { v?: unknown }).v
    : cell
  if (typeof value === 'string' && FORMULA_ERROR_CODES.has(value)) return { errorCode: value }
  if (value === null || value === undefined) return { value: '' }
  if (Array.isArray(value)) {
    if (value.length === 1 && Array.isArray(value[0]) && value[0].length === 1) {
      return formulaPreviewResult(value[0][0])
    }
    const displayValue = (entry: unknown) => {
      const preview = formulaPreviewResult(entry)
      return preview.errorCode ?? preview.value ?? ''
    }
    const formatted = value.every(Array.isArray)
      ? value.map((row) => row.map(displayValue).join(', ')).join('\n')
      : value.map(displayValue).join(', ')
    return { value: formatted }
  }
  return { value: String(value) }
}

export function formulaPreviewErrorMessage(errorCode: string, locale: ExcelHostConfig['locale']): string {
  return FORMULA_ERROR_CODES.has(errorCode)
    ? i18n.t(`excel.formula.errors.${errorCode}`, { lng: locale })
    : i18n.t('excel.formula.unknownError', { lng: locale, errorCode })
}
