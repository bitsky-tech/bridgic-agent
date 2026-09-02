import { describe, expect, it } from 'bun:test'
import { BooleanNumber, LocaleType } from '@univerjs/presets'
import { Workbook } from 'exceljs'
import JSZip from 'jszip'
import { EXCEL_LIVE_ANALYSIS_CUSTOM_KEY } from '../../excel/excelLiveAnalysis'
import {
  EXCEL_SHOW_ZEROS_CUSTOM_KEY,
  UnsupportedWorkbookFeatureError,
  createEmptyWorkbook,
  excelSheetShowsZeros,
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
    first.showGridlines = BooleanNumber.FALSE
    first.zoomRatio = 1.5
    first.custom = { [EXCEL_SHOW_ZEROS_CUSTOM_KEY]: false }

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
    const exported = new Workbook()
    await exported.xlsx.load(bytes.slice().buffer as ArrayBuffer)
    const worksheetXml = await (await JSZip.loadAsync(bytes)).file('xl/worksheets/sheet1.xml')?.async('text')
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
    expect(summary.showGridlines).toBe(BooleanNumber.FALSE)
    expect(summary.zoomRatio).toBe(1.5)
    expect(excelSheetShowsZeros(summary.custom)).toBe(false)
    expect(exported.worksheets[0]?.views[0]).toMatchObject({
      showGridLines: false,
      zoomScale: 150,
    })
    expect(worksheetXml).toContain('showZeros="0"')
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

  it('preserves live-analysis sheet and drawing identities in a very-hidden metadata sheet', async () => {
    const source = new Workbook()
    const sheet = source.addWorksheet('Sales')
    sheet.addRows([['Month', 'Revenue'], ['Jan', 12]])
    const imageId = source.addImage({
      extension: 'png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    })
    sheet.addImage(imageId, { tl: { col: 3, row: 1 }, br: { col: 6, row: 8 } } as never)
    const imported = await importXlsx(new Uint8Array(await source.xlsx.writeBuffer()), LocaleType.EN_US)
    const sheetId = imported.sheetOrder[0]!
    const drawingResource = imported.resources?.find((resource) => resource.name === 'SHEET_DRAWING_PLUGIN')
    const drawings = JSON.parse(drawingResource?.data ?? '{}') as Record<string, Record<string, unknown>>
    const drawingId = Object.keys(drawings[sheetId] ?? {})[0]!
    const liveAnalysis = {
      version: 1,
      bindings: [{
        id: 'chart-1', kind: 'chart', chartType: 'line', sourceAddress: 'A1:B2',
        sourceSheetId: sheetId, targetSheetId: sheetId, drawingId,
      }],
    }
    imported.custom = { ...imported.custom, [EXCEL_LIVE_ANALYSIS_CUSTOM_KEY]: liveAnalysis }

    const bytes = await exportXlsx(imported)
    const officeWorkbook = new Workbook()
    await officeWorkbook.xlsx.load(bytes.slice().buffer as ArrayBuffer)
    expect(officeWorkbook.worksheets.some((worksheet) => worksheet.state === 'veryHidden')).toBeTrue()

    const restored = await importXlsx(bytes, LocaleType.EN_US)
    const restoredDrawings = JSON.parse(restored.resources?.find((resource) => resource.name === 'SHEET_DRAWING_PLUGIN')?.data ?? '{}') as Record<string, Record<string, unknown>>
    expect(restored.sheetOrder[0]).toBe(sheetId)
    expect(Object.keys(restoredDrawings[sheetId] ?? {})).toContain(drawingId)
    expect(restored.custom?.[EXCEL_LIVE_ANALYSIS_CUSTOM_KEY]).toEqual(liveAnalysis)
    expect(Object.values(restored.sheets).some((worksheet) => worksheet?.name?.startsWith('__BRIDGIC_INTERNAL__'))).toBeFalse()
  })

  it('round-trips Univer and Office hyperlinks without flattening them to text', async () => {
    const snapshot = createEmptyWorkbook(LocaleType.EN_US, 'Links')
    const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!
    sheet.cellData = {
      0: {
        0: {
          t: 1,
          p: {
            body: {
              dataStream: 'Bridgic\r\n',
              customRanges: [{
                startIndex: 0,
                endIndex: 6,
                rangeId: 'link-1',
                rangeType: 0,
                properties: { url: 'https://example.com/report' },
              }],
            },
          },
        } as never,
      },
    }

    const bytes = await exportXlsx(snapshot)
    const restored = new Workbook()
    await restored.xlsx.load(bytes.slice().buffer as ArrayBuffer)

    expect(restored.getWorksheet('Sheet1')?.getCell('A1').value).toEqual({
      text: 'Bridgic',
      hyperlink: 'https://example.com/report',
    })

    const imported = await importXlsx(bytes, LocaleType.EN_US)
    const importedCell = imported.sheets[imported.sheetOrder[0]!]!.cellData?.[0]?.[0]
    expect(importedCell?.p?.body?.dataStream).toBe('Bridgic\r\n')
    expect(importedCell?.p?.body?.customRanges?.[0]).toMatchObject({
      startIndex: 0,
      endIndex: 6,
      properties: { url: 'https://example.com/report' },
    })
    expect(unsupportedWorkbookFeatures(imported)).not.toContain('hyperlinks')

    const roundTripped = new Workbook()
    const roundTrippedBytes = await exportXlsx(imported)
    await roundTripped.xlsx.load(roundTrippedBytes.slice().buffer as ArrayBuffer)
    expect(roundTripped.getWorksheet('Sheet1')?.getCell('A1').value).toEqual({
      text: 'Bridgic',
      hyperlink: 'https://example.com/report',
    })
  })

  it('does not mistake a user worksheet marker for internal metadata', async () => {
    const source = new Workbook()
    const sheet = source.addWorksheet('User data')
    sheet.getCell('A1').value = 'Bridgic Excel internal metadata v1'
    sheet.getCell('B2').value = 'keep me'

    const bytes = new Uint8Array(await source.xlsx.writeBuffer())
    const imported = await importXlsx(bytes, LocaleType.EN_US)
    const restored = Object.values(imported.sheets).find((candidate) => candidate?.name === 'User data')

    expect(restored?.cellData?.[0]?.[0]?.v).toBe('Bridgic Excel internal metadata v1')
    expect(restored?.cellData?.[1]?.[1]?.v).toBe('keep me')
  })

  it('preserves malformed reserved-looking metadata instead of crashing or deleting it', async () => {
    const source = new Workbook()
    source.addWorksheet('Data').addRows([['Month', 'Revenue'], ['Jan', 12]])
    const metadata = source.addWorksheet('__BRIDGIC_INTERNAL__')
    metadata.state = 'veryHidden'
    metadata.getCell('A1').value = 'Bridgic Excel internal metadata v1'
    metadata.getCell('A2').value = JSON.stringify({
      version: 1,
      sheetIds: { Data: 'sheet-1' },
      drawingIds: { Data: 'not-an-array' },
    })

    const bytes = new Uint8Array(await source.xlsx.writeBuffer())
    const imported = await importXlsx(bytes, LocaleType.EN_US)

    expect(Object.values(imported.sheets)
      .some((candidate) => candidate?.name === '__BRIDGIC_INTERNAL__')).toBeTrue()
    expect(Object.values(imported.sheets)
      .some((candidate) => candidate?.name === 'Data')).toBeTrue()
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
