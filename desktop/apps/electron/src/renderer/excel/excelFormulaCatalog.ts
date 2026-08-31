export type ExcelFormulaCategory =
  | 'common'
  | 'financial'
  | 'logical'
  | 'text'
  | 'date'
  | 'lookup'
  | 'math'
  | 'statistical'

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
