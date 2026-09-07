import { describe, expect, it } from 'bun:test'
import {
  EXCEL_LIVE_ANALYSIS_CUSTOM_KEY,
  rangesIntersect,
  readLiveAnalysis,
  updateLiveAnalysisForStructureChange,
  upsertLiveBinding,
  withLiveAnalysis,
} from '../excelLiveAnalysis'

const chart = {
  id: 'chart-1',
  kind: 'chart' as const,
  sourceAddress: 'A1:B4',
  sourceSheetId: 'source',
  targetSheetId: 'source',
  drawingId: 'drawing-1',
  chartType: 'line' as const,
}

describe('Excel live analysis metadata', () => {
  it('round-trips valid bindings without overwriting unrelated workbook metadata', () => {
    const custom = withLiveAnalysis({ owner: 'Bridgic' }, upsertLiveBinding({ version: 1, bindings: [] }, chart))
    expect(custom.owner).toBe('Bridgic')
    expect(readLiveAnalysis(custom)).toEqual({ version: 1, bindings: [chart] })
    expect(custom[EXCEL_LIVE_ANALYSIS_CUSTOM_KEY]).toBeDefined()
  })

  it('drops malformed metadata instead of trusting workbook-controlled JSON', () => {
    expect(readLiveAnalysis({
      [EXCEL_LIVE_ANALYSIS_CUSTOM_KEY]: {
        version: 1,
        bindings: [chart, { ...chart, id: 7 }, { ...chart, id: 'bad-range', sourceAddress: 'not a range' }, { kind: 'pivot' }],
      },
    }).bindings).toEqual([chart])
  })

  it('matches overlapping source changes without refreshing adjacent cells', () => {
    const source = { startRow: 1, endRow: 4, startColumn: 1, endColumn: 3 }
    expect(rangesIntersect(source, { startRow: 4, endRow: 5, startColumn: 3, endColumn: 4 })).toBeTrue()
    expect(rangesIntersect(source, { startRow: 5, endRow: 6, startColumn: 1, endColumn: 3 })).toBeFalse()
  })

  it('keeps chart sources aligned when rows are inserted before or inside the range', () => {
    const shifted = updateLiveAnalysisForStructureChange(
      { version: 1, bindings: [chart] },
      {
        axis: 'row',
        kind: 'insert',
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 },
        sheetId: 'source',
      },
    )
    expect(shifted.bindingIds).toEqual(['chart-1'])
    expect(shifted.state.bindings[0]?.sourceAddress).toBe('A3:B6')

    const expanded = updateLiveAnalysisForStructureChange(
      shifted.state,
      {
        axis: 'row',
        kind: 'insert',
        range: { startRow: 3, endRow: 3, startColumn: 0, endColumn: 0 },
        sheetId: 'source',
      },
    )
    expect(expanded.state.bindings[0]?.sourceAddress).toBe('A3:B7')
  })

  it('updates both pivot source fields when columns are inserted or removed', () => {
    const pivot = {
      id: 'pivot-1',
      kind: 'pivot' as const,
      sourceAddress: 'B2:E8',
      sourceSheetId: 'source',
      targetSheetId: 'pivot-sheet',
      options: {
        sourceAddress: 'B2:E8',
        rowField: 0,
        columnField: null,
        valueField: 1,
        aggregate: 'sum' as const,
      },
      renderedColumns: 3,
      renderedRows: 8,
    }
    const shifted = updateLiveAnalysisForStructureChange(
      { version: 1, bindings: [pivot] },
      {
        axis: 'column',
        kind: 'insert',
        range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
        sheetId: 'source',
      },
    )
    expect(shifted.state.bindings[0]).toMatchObject({
      sourceAddress: 'C2:F8',
      options: { sourceAddress: 'C2:F8' },
    })

    const reduced = updateLiveAnalysisForStructureChange(
      shifted.state,
      {
        axis: 'column',
        kind: 'remove',
        range: { startRow: 0, endRow: 0, startColumn: 3, endColumn: 4 },
        sheetId: 'source',
      },
    )
    expect(reduced.state.bindings[0]).toMatchObject({
      sourceAddress: 'C2:D8',
      options: { sourceAddress: 'C2:D8' },
    })
  })

  it('collapses a fully deleted source to a surviving neighbor', () => {
    const removed = updateLiveAnalysisForStructureChange(
      { version: 1, bindings: [{ ...chart, sourceAddress: 'A10:B12' }] },
      {
        axis: 'row',
        kind: 'remove',
        range: { startRow: 9, endRow: 11, startColumn: 0, endColumn: 0 },
        sheetId: 'source',
      },
    )
    expect(removed.state.bindings[0]?.sourceAddress).toBe('A9:B9')
  })
})
