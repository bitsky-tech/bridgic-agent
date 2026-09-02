import { describe, expect, it } from 'bun:test'
import {
  buildChartSvg,
  buildEmptyChartSvg,
  buildPivotTable,
  defaultPivotValueField,
  excelInsertValidationMessage,
  selectionFields,
  svgDataUrl,
} from '../excelInsert'

const sales = [
  ['Region', 'Product', 'Revenue'],
  ['North', 'Desk', 12],
  ['North', 'Chair', 8],
  ['South', 'Desk', 15],
  ['South', 'Chair', 5],
] as const

describe('Excel insert helpers', () => {
  it('builds a pivot table with row totals, column totals, and a grand total', () => {
    const pivot = buildPivotTable(sales.map((row) => [...row]), {
      sourceAddress: 'A1:C5',
      rowField: 0,
      columnField: 1,
      valueField: 2,
      aggregate: 'sum',
    })

    expect(pivot.numericStartColumn).toBe(1)
    expect(pivot.values).toEqual([
      ['Region / Product', 'Desk', 'Chair', 'Grand Total'],
      ['North', 12, 8, 20],
      ['South', 15, 5, 20],
      ['Grand Total', 27, 13, 40],
    ])
  })

  it('supports count and average aggregations without a column field', () => {
    const values = sales.map((row) => [...row])
    expect(buildPivotTable(values, {
      sourceAddress: 'A1:C5', rowField: 0, columnField: null, valueField: 2, aggregate: 'average',
    }).values).toEqual([
      ['Region', 'Average of Revenue'],
      ['North', 10],
      ['South', 10],
      ['Grand Total', 10],
    ])
    expect(buildPivotTable(values, {
      sourceAddress: 'A1:C5', rowField: 1, columnField: null, valueField: 2, aggregate: 'count',
    }).values.at(-1)).toEqual(['Grand Total', 4])
  })

  it('normalizes duplicate headers and picks the first numeric value field', () => {
    const values = [['Name', 'Value', 'Value'], ['A', '4', 7]]
    expect(selectionFields(values)).toEqual(['Name', 'Value', 'Value 2'])
    expect(defaultPivotValueField(values)).toBe(1)
  })

  it('renders the common statistical chart families as self-contained SVG', () => {
    const values = [
      ['Month', 'Revenue', 'Cost'],
      ['Jan', 12, 8],
      ['Feb', 18, 11],
      ['Mar', 16, 10],
    ]
    for (const type of ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'] as const) {
      const svg = buildChartSvg(values, type)
      expect(svg).toStartWith('<svg')
      expect(svg).toContain('Revenue')
      expect(svg).not.toContain('undefined')
      expect(svgDataUrl(svg)).toStartWith('data:image/svg+xml;base64,')
    }
  })

  it('escapes labels before adding them to chart markup', () => {
    const svg = buildChartSvg([['<Quarter>', 'R&D'], ['A&B', 5]], 'column')
    expect(svg).toContain('&lt;Quarter&gt;')
    expect(svg).toContain('R&amp;D')
    expect(svg).toContain('A&amp;B')
  })

  it('turns expected insert validation failures into friendly localized guidance', () => {
    let cause: unknown
    try {
      buildChartSvg([[null]], 'column')
    } catch (error) {
      cause = error
    }
    expect(excelInsertValidationMessage(cause, 'zh-CN')).toBe('请先选中包含数值的数据区域，再插入图表。')
    expect(excelInsertValidationMessage(cause, 'en-US')).toBe('Select a range containing numeric data, then insert the chart again.')
    expect(excelInsertValidationMessage(new Error('network failed'), 'zh-CN')).toBeNull()
    expect(buildEmptyChartSvg('没有 <数据>')).toContain('没有 &lt;数据&gt;')
  })
})
