/**
 * Tests for the agent-facing Univer bridge. The facade is faked structurally:
 * the real `FUniver` is checked against the same interface at compile time in
 * `main.ts`, so these tests only need to cover the bridge's own behavior.
 */
import { describe, expect, test } from 'bun:test'
import { SheetBridge, SheetBridgeError, type CellValue } from '../bridge'

interface FakeSheetOptions {
  name: string
  values?: unknown[][]
}

function fakeFacade(sheets: FakeSheetOptions[] = [{ name: 'Sheet1' }]) {
  const calls: string[] = []
  const worksheets = sheets.map((options, index) => {
    let values: unknown[][] = options.values ?? [[null]]
    return {
      getSheetId: () => `id-${index}`,
      getSheetName: () => options.name,
      getRange: (a1: string) => {
        if (a1 === 'bad') return null as never
        return {
          clear: () => calls.push(`clear ${options.name}!${a1}`),
          getValues: () => values,
          setFormula: (formula: string) => calls.push(`formula ${options.name}!${a1} ${formula}`),
          setValues: (next: { v: CellValue }[][]) => {
            values = next.map((row) => row.map((cell) => cell.v))
            calls.push(`write ${options.name}!${a1}`)
          },
        }
      },
    }
  })
  const workbook = {
    getActiveSheet: () => worksheets[0]!,
    getName: () => 'Book',
    getSheets: () => worksheets,
    getSnapshot: () => ({ id: 'snapshot' }),
    redo: () => calls.push('redo'),
    undo: () => calls.push('undo'),
  }
  return {
    calls,
    facade: { getActiveWorkbook: () => workbook },
    facadeWithoutWorkbook: { getActiveWorkbook: () => null },
  }
}

describe('SheetBridge — status', () => {
  test('reports every sheet and the active one', () => {
    const { facade } = fakeFacade([{ name: 'Sheet1' }, { name: 'Data' }])
    const status = new SheetBridge(facade).status()
    expect(status.ready).toBe(true)
    expect(status.workbookName).toBe('Book')
    expect(status.activeSheetName).toBe('Sheet1')
    expect(status.sheets.map((sheet) => sheet.name)).toEqual(['Sheet1', 'Data'])
    expect(status.revision).toBe(0)
  })

  test('reports not ready before the workbook exists instead of throwing', () => {
    const { facadeWithoutWorkbook } = fakeFacade()
    const status = new SheetBridge(facadeWithoutWorkbook).status()
    expect(status.ready).toBe(false)
    expect(status.sheets).toEqual([])
  })
})

describe('SheetBridge — reads and writes', () => {
  test('read normalizes empty cells and rich text to null', () => {
    const richText = { body: { dataStream: 'ignored' } }
    const { facade } = fakeFacade([{ name: 'Sheet1', values: [['a', undefined, 2, richText]] }])
    expect(new SheetBridge(facade).readRange('A1:D1').values).toEqual([['a', null, 2, null]])
  })

  test('write sends cell data so a null clears the cell', () => {
    const { facade } = fakeFacade([{ name: 'Sheet1', values: [['old']] }])
    const bridge = new SheetBridge(facade)
    bridge.writeRange('A1:B1', [['x', null]])
    expect(bridge.readRange('A1:B1').values).toEqual([['x', null]])
  })

  test('write applies values and bumps the revision', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade)
    const result = bridge.writeRange('A1:B2', [['a', 'b'], ['c', 'd']])
    expect(result).toEqual({ a1: 'A1:B2', columns: 2, rows: 2 })
    expect(calls).toEqual(['write Sheet1!A1:B2'])
    expect(bridge.status().revision).toBe(1)
  })

  test('write targets a named sheet when asked', () => {
    const { calls, facade } = fakeFacade([{ name: 'Sheet1' }, { name: 'Data' }])
    new SheetBridge(facade).writeRange('A1', [['x']], 'Data')
    expect(calls).toEqual(['write Data!A1'])
  })

  test('write rejects a shape that is not rows of cells', () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade)
    expect(() => bridge.writeRange('A1', [])).toThrow(SheetBridgeError)
    expect(() => bridge.writeRange('A1', ['a' as unknown as CellValue[]])).toThrow(SheetBridgeError)
  })

  test('setFormula requires a leading "="', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade)
    expect(() => bridge.setFormula('A1', 'SUM(B1:B2)')).toThrow(SheetBridgeError)
    bridge.setFormula('A1', '=SUM(B1:B2)')
    expect(calls).toEqual(['formula Sheet1!A1 =SUM(B1:B2)'])
  })

  test('an unknown sheet name and an invalid range both fail loudly', () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade)
    expect(() => bridge.readRange('A1', 'Nope')).toThrow(SheetBridgeError)
    expect(() => bridge.readRange('bad')).toThrow(SheetBridgeError)
    expect(() => bridge.readRange('')).toThrow(SheetBridgeError)
  })
})

describe('SheetBridge — human/agent arbitration', () => {
  test('refuses to write while a person has a cell editor open', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade)
    bridge.setHumanEditing(true)
    expect(() => bridge.writeRange('A1', [['x']])).toThrow(/person is editing/)
    expect(calls).toEqual([])
    bridge.setHumanEditing(false)
    bridge.writeRange('A1', [['x']])
    expect(calls).toEqual(['write Sheet1!A1'])
  })

  test('reading stays available while a person edits', () => {
    const { facade } = fakeFacade([{ name: 'Sheet1', values: [['a']] }])
    const bridge = new SheetBridge(facade)
    bridge.setHumanEditing(true)
    expect(bridge.readRange('A1').values).toEqual([['a']])
    expect(bridge.status().humanEditing).toBe(true)
  })

  test('attributes changes to the agent or the person who made them', () => {
    let clock = 100
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade, () => (clock += 1))
    bridge.writeRange('A1', [['x']])
    bridge.noteExternalChange('B7')
    expect(bridge.recentChanges()).toEqual([
      { a1: 'A1', at: 101, source: 'agent' },
      { a1: 'B7', at: 102, source: 'human' },
    ])
  })

  test('drops the echo of the agent’s own write', () => {
    const { facade } = fakeFacade()
    const echoing = {
      getActiveWorkbook: () => {
        const workbook = facade.getActiveWorkbook()
        return {
          ...workbook,
          getActiveSheet: () => ({
            ...workbook.getActiveSheet(),
            getRange: (a1: string) => ({
              ...workbook.getActiveSheet().getRange(a1),
              setValues: () => bridge.noteExternalChange(a1),
            }),
          }),
        }
      },
    }
    const bridge = new SheetBridge(echoing as never)
    bridge.writeRange('A1', [['x']])
    expect(bridge.recentChanges()).toEqual([{ a1: 'A1', at: expect.any(Number), source: 'agent' }])
  })

  test('recentChanges honors its limit and keeps the newest entries', () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade)
    for (const cell of ['A1', 'A2', 'A3']) bridge.noteExternalChange(cell)
    expect(bridge.recentChanges(2).map((change) => change.a1)).toEqual(['A2', 'A3'])
    expect(bridge.recentChanges(0).length).toBe(3)
  })
})

describe('SheetBridge — workbook operations', () => {
  test('snapshot, undo and redo reach the workbook', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade)
    expect(bridge.snapshot()).toEqual({ id: 'snapshot' })
    bridge.undo()
    bridge.redo()
    expect(calls).toEqual(['undo', 'redo'])
  })

  test('operations before the workbook exists report a clear reason', () => {
    const { facadeWithoutWorkbook } = fakeFacade()
    const bridge = new SheetBridge(facadeWithoutWorkbook)
    expect(() => bridge.snapshot()).toThrow(/not ready/)
    expect(() => bridge.readRange('A1')).toThrow(/not ready/)
  })
})
