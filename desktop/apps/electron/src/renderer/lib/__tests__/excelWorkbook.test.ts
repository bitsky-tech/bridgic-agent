import { describe, expect, it } from 'bun:test'
import { BooleanNumber, LocaleType } from '@univerjs/presets'
import { Workbook } from 'exceljs'
import JSZip from 'jszip'
import {
  UnsupportedWorkbookFeatureError,
  createEmptyWorkbook,
  exportXlsx,
  importXlsx,
  unsupportedWorkbookFeatures,
} from '../excelWorkbook'

describe('Excel workbook conversion', () => {
  it('round-trips values, formulas, formats, dimensions, merges, and sheets through .xlsx', async () => {
    const source = createEmptyWorkbook(LocaleType.EN_US, 'Quarterly plan')
    const firstId = source.sheetOrder[0]!
    const first = source.sheets[firstId]!
    first.name = 'Summary'
    first.cellData = {
      0: {
        0: { v: 'Revenue', s: { bl: BooleanNumber.TRUE, bg: { rgb: '#D1FAE5' } } },
      },
      1: {
        0: { v: 1200, s: { n: { pattern: '$#,##0.00' } } },
      },
      2: {
        0: { v: 1200, f: '=SUM(A2:A2)' },
      },
    }
    first.mergeData = [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }]
    first.rowData = { 1: { h: 32 } }
    first.columnData = { 0: { w: 140 } }
    first.freeze = { xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 }

    const secondId = crypto.randomUUID()
    source.sheetOrder.push(secondId)
    source.sheets[secondId] = {
      id: secondId,
      name: 'Notes',
      rowCount: 100,
      columnCount: 10,
      cellData: { 0: { 0: { v: 'Local workbook' } } },
    }

    const bytes = await exportXlsx(source)
    const restored = await importXlsx(bytes, LocaleType.EN_US)
    const summary = restored.sheets[restored.sheetOrder[0]!]!
    const notes = restored.sheets[restored.sheetOrder[1]!]!

    expect(bytes.byteLength).toBeGreaterThan(1_000)
    expect(restored.sheetOrder).toHaveLength(2)
    expect(summary.name).toBe('Summary')
    expect(summary.cellData?.[1]?.[0]?.v).toBe(1200)
    expect(summary.cellData?.[2]?.[0]?.f).toBe('=SUM(A2:A2)')
    expect(summary.cellData?.[1]?.[0]?.s).toMatchObject({ n: { pattern: '$#,##0.00' } })
    expect(summary.mergeData).toHaveLength(1)
    expect(summary.mergeData?.[0]).toMatchObject({
      startRow: 0,
      startColumn: 0,
      endRow: 0,
      endColumn: 1,
    })
    expect(summary.rowData?.[1]?.h).toBe(32)
    expect(summary.freeze).toMatchObject({ xSplit: 1, ySplit: 1 })
    expect(notes.cellData?.[0]?.[0]?.v).toBe('Local workbook')
  })

  it('round-trips filters, data validation, conditional formatting, and images', async () => {
    const source = new Workbook()
    const sheet = source.addWorksheet('Advanced')
    sheet.addRows([['Status', 'Score'], ['Open', 12]])
    sheet.autoFilter = 'A1:B2'
    sheet.getCell('A2').dataValidation = {
      type: 'list',
      formulae: ['"Open,Closed"'],
      allowBlank: true,
    }
    sheet.addConditionalFormatting({
      ref: 'B2:B10',
      rules: [{
        type: 'cellIs',
        operator: 'greaterThan',
        formulae: [10],
        priority: 1,
        style: { font: { color: { argb: 'FFFF0000' } } },
      }],
    })
    const imageId = source.addImage({
      extension: 'png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    })
    sheet.addImage(imageId, { tl: { col: 2, row: 1 }, br: { col: 3, row: 3 } } as never)

    const originalBytes = new Uint8Array(await source.xlsx.writeBuffer())
    const snapshot = await importXlsx(originalBytes, LocaleType.EN_US)
    const exportedBytes = await exportXlsx(snapshot)
    const restored = new Workbook()
    await restored.xlsx.load(exportedBytes.slice().buffer as ArrayBuffer)
    const restoredSheet = restored.getWorksheet('Advanced')!

    expect(restoredSheet.autoFilter).toBe('A1:B2')
    expect(restoredSheet.getCell('A2').dataValidation).toMatchObject({
      type: 'list',
      formulae: ['"Open,Closed"'],
      allowBlank: true,
    })
    expect((restoredSheet as typeof restoredSheet & { conditionalFormattings: unknown[] })
      .conditionalFormattings).toHaveLength(1)
    expect(restoredSheet.getImages()).toHaveLength(1)
  })

  it('refuses to overwrite workbook objects that cannot be reproduced losslessly', async () => {
    const source = new Workbook()
    source.addWorksheet('Chart data').addRow(['Month', 'Revenue'])
    const zip = await JSZip.loadAsync(await source.xlsx.writeBuffer())
    zip.file('xl/charts/chart1.xml', '<chartSpace/>')
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))
    const snapshot = await importXlsx(bytes, LocaleType.EN_US)

    expect(unsupportedWorkbookFeatures(snapshot)).toContain('charts')
    expect(exportXlsx(snapshot)).rejects.toBeInstanceOf(UnsupportedWorkbookFeatureError)
    expect((await exportXlsx(snapshot, { allowLossy: true })).byteLength).toBeGreaterThan(1_000)
  })
})
