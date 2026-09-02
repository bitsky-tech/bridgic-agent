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
  const zh = locale === 'zh-CN'
  const messages: Record<string, [string, string]> = {
    '#CALC!': ['当前函数无法完成计算，请检查参数。', 'The function could not complete its calculation. Check its arguments.'],
    '#CYCLE!': ['公式引用了自身，会产生循环引用。', 'The formula refers to itself and creates a circular reference.'],
    '#DIV/0!': ['除数为 0 或所引用的单元格为空。', 'The divisor is zero or refers to an empty cell.'],
    '#ERROR!': ['公式无法计算，请检查语法和参数。', 'The formula could not be calculated. Check its syntax and arguments.'],
    '#GETTING_DATA': ['公式正在等待数据。', 'The formula is waiting for data.'],
    '#N/A': ['没有找到匹配的数据。', 'No matching data was found.'],
    '#NAME?': ['函数名、命名区域或文本参数无法识别；文本值请使用双引号。', 'A function, named range, or text argument is not recognized; wrap text values in double quotes.'],
    '#NULL!': ['区域交集运算没有找到交叉单元格。', 'The range intersection does not contain a common cell.'],
    '#NUM!': ['数值参数超出函数允许的范围。', 'A numeric argument is outside the range accepted by the function.'],
    '#REF!': ['公式中包含无效或已删除的单元格引用。', 'The formula contains an invalid or deleted cell reference.'],
    '#SPILL!': ['数组结果所需的区域已被其他数据占用。', 'The array result cannot expand because its destination range is occupied.'],
    '#VALUE!': ['参数类型、数量或区域尺寸不符合该函数的要求。', 'An argument type, count, or range size is not valid for this function.'],
  }
  return messages[errorCode]?.[zh ? 0 : 1]
    ?? (zh ? `无法计算此公式（${errorCode}）。` : `This formula could not be calculated (${errorCode}).`)
}
