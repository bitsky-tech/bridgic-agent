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

const BORDER_STYLES = { none: 0, thin: 1, medium: 8, thick: 13 }

function validationBuilder(calls: string[], parts: string[] = []) {
  const self = {
    build: () => ({ rule: parts.join(' ') }),
    requireCheckbox: () => validationBuilder(calls, [...parts, 'checkbox']),
    requireNumberBetween: (start: number, end: number) =>
      validationBuilder(calls, [...parts, `between ${start} ${end}`]),
    requireValueInList: (values: string[]) =>
      validationBuilder(calls, [...parts, `list ${values.join(',')}`]),
  }
  return self
}

function highlightBuilder(parts: string[]) {
  const next = (part: string) => highlightBuilder([...parts, part])
  return {
    build: () => ({ rule: parts.join(' ') }),
    setBackground: (color?: string) => next(`bg ${color}`),
    setBold: (isBold: boolean) => next(`bold ${isBold}`),
    setFontColor: (color?: string) => next(`fg ${color}`),
    setRanges: (ranges: unknown[]) => next(`ranges ${JSON.stringify(ranges)}`),
  }
}

function conditionBuilder() {
  const next = (part: string) => highlightBuilder([part])
  return {
    setDuplicateValues: () => next('duplicates'),
    whenNumberGreaterThan: (value: number) => next(`gt ${value}`),
    whenNumberLessThan: (value: number) => next(`lt ${value}`),
    whenNumberBetween: (start: number, end: number) => next(`between ${start} ${end}`),
    whenTextContains: (text: string) => next(`contains ${text}`),
  }
}

function textFinder(calls: string[]) {
  return {
    findAll: () => [{}, {}],
    matchCaseAsync: async (matchCase: boolean) => {
      calls.push(`matchCase ${matchCase}`)
      return {}
    },
    replaceAllWithAsync: async (replaceText: string) => {
      calls.push(`replaceAll ${replaceText}`)
      return 2
    },
  }
}

function fakeFacade(sheets: FakeSheetOptions[] = [{ name: 'Sheet1' }]) {
  const calls: string[] = []
  const worksheets: FakeWorksheet[] = []

  interface FakeWorksheet {
    addConditionalFormattingRule(rule: unknown): void
    cancelFreeze(): void
    deleteColumns(position: number, howMany: number): void
    deleteRows(position: number, howMany: number): void
    getDataRange(): ReturnType<FakeWorksheet['getRange']>
    getFilter(): { remove(): boolean } | null
    getMaxColumns(): number
    getMaxRows(): number
    newConditionalFormattingRule(): ReturnType<typeof conditionBuilder>
    getRange(a1: string): {
      breakApart(): void
      clear(): void
      getA1Notation(): string
      getValues(): unknown[][]
      merge(): void
      mergeAcross(): void
      mergeVertically(): void
      setBackground(color: string): void
      setBorder(type: string, style: number, color?: string): void
      setFontColor(color: string | null): void
      setFontSize(size: number | null): void
      setFontStyle(style: string | null): void
      setFontWeight(weight: string | null): void
      setFormula(formula: string): void
      setHorizontalAlignment(alignment: string): void
      setNumberFormat(pattern: string): void
      setValues(values: { v: CellValue }[][]): void
      setVerticalAlignment(alignment: string): void
      setWrap(wrap: boolean): void
      addCommentAsync(content: unknown): Promise<boolean>
      createFilter(): { remove(): boolean } | null
      getRange(): unknown
      setDataValidation(rule: unknown): void
      setHyperLink(url: string, label?: string): Promise<boolean>
      sort(column: { ascending: boolean; column: number }): void
    }
    getSelection(): {
      getActiveRange(): ReturnType<FakeWorksheet['getRange']> | null
      getActiveRangeList(): ReturnType<FakeWorksheet['getRange']>[]
    } | null
    getSheetId(): string
    getSheetName(): string
    insertColumns(index: number, count?: number): void
    insertRows(index: number, count?: number): void
    setColumnWidths(start: number, count: number, width: number): void
    setFrozenColumns(columns: number): void
    setFrozenRows(rows: number): void
    setName(name: string): void
    setRowHeights(start: number, count: number, height: number): void
  }

  function makeSheet(options: FakeSheetOptions, index: number): FakeWorksheet {
    let values: unknown[][] = options.values ?? [[null]]
    let name = options.name
    let selectionA1: string | null = null
    let filter: { remove(): boolean } | null = null
    const range = (a1: string) => ({
      breakApart: () => calls.push(`break ${name}!${a1}`),
      clear: () => calls.push(`clear ${name}!${a1}`),
      getA1Notation: () => a1,
      getValues: () => values,
      merge: () => calls.push(`merge ${name}!${a1}`),
      mergeAcross: () => calls.push(`mergeAcross ${name}!${a1}`),
      mergeVertically: () => calls.push(`mergeVertically ${name}!${a1}`),
      setBackground: (color: string) => calls.push(`background ${a1} ${color}`),
      setBorder: (type: string, style: number, color?: string) =>
        calls.push(`border ${a1} ${type} ${style} ${color ?? '-'}`),
      setFontColor: (color: string | null) => calls.push(`fontColor ${a1} ${color}`),
      setFontSize: (size: number | null) => calls.push(`fontSize ${a1} ${size}`),
      setFontStyle: (style: string | null) => calls.push(`fontStyle ${a1} ${style}`),
      setFontWeight: (weight: string | null) => calls.push(`fontWeight ${a1} ${weight}`),
      setFormula: (formula: string) => calls.push(`formula ${name}!${a1} ${formula}`),
      setHorizontalAlignment: (alignment: string) => calls.push(`hAlign ${a1} ${alignment}`),
      setNumberFormat: (pattern: string) => calls.push(`numberFormat ${a1} ${pattern}`),
      setValues: (next: { v: CellValue }[][]) => {
        values = next.map((row) => row.map((cell) => cell.v))
        calls.push(`write ${name}!${a1}`)
      },
      setVerticalAlignment: (alignment: string) => calls.push(`vAlign ${a1} ${alignment}`),
      setWrap: (wrap: boolean) => calls.push(`wrap ${a1} ${wrap}`),
      addCommentAsync: async (content: unknown) => {
        calls.push(`comment ${a1} ${JSON.stringify(content)}`)
        return true
      },
      createFilter: () => {
        calls.push(`createFilter ${a1}`)
        filter = {
          remove: () => {
            calls.push('removeFilter')
            filter = null
            return true
          },
        }
        return filter
      },
      getRange: () => ({ a1 }),
      setDataValidation: (rule: unknown) =>
        calls.push(`validation ${a1} ${JSON.stringify(rule)}`),
      setHyperLink: async (url: string, label?: string) => {
        calls.push(`link ${a1} ${url} ${label ?? '-'}`)
        return true
      },
      sort: (column: { ascending: boolean; column: number }) =>
        calls.push(`sort ${a1} ${column.column} ${column.ascending}`),
    })
    return {
      cancelFreeze: () => calls.push(`cancelFreeze ${name}`),
      deleteColumns: (position, howMany) => calls.push(`deleteColumns ${position} ${howMany}`),
      deleteRows: (position, howMany) => calls.push(`deleteRows ${position} ${howMany}`),
      getDataRange: () => range('A1:B2'),
      getMaxColumns: () => 20,
      getMaxRows: () => 100,
      getRange: (a1: string) => (a1 === 'bad' ? (null as never) : range(a1)),
      getSelection: () => (selectionA1 === null
        ? null
        : {
          getActiveRange: () => range(selectionA1 as string),
          getActiveRangeList: () => [range(selectionA1 as string)],
        }),
      getSheetId: () => `id-${index}`,
      getSheetName: () => name,
      insertColumns: (at, count) => calls.push(`insertColumns ${at} ${count}`),
      insertRows: (at, count) => calls.push(`insertRows ${at} ${count}`),
      setColumnWidths: (start, count, width) =>
        calls.push(`columnWidths ${start} ${count} ${width}`),
      setFrozenColumns: (columns) => calls.push(`frozenColumns ${columns}`),
      setFrozenRows: (rows) => calls.push(`frozenRows ${rows}`),
      setName: (next: string) => {
        name = next
      },
      setRowHeights: (start, count, height) =>
        calls.push(`rowHeights ${start} ${count} ${height}`),
      addConditionalFormattingRule: (rule: unknown) =>
        calls.push(`cf ${JSON.stringify(rule)}`),
      getFilter: () => filter,
      newConditionalFormattingRule: () => conditionBuilder(),
      // Exposed only to the tests, to stand in for a person selecting cells.
      select: (a1: string | null) => {
        selectionA1 = a1
      },
    } as FakeWorksheet & { select(a1: string | null): void }
  }

  sheets.forEach((options, index) => worksheets.push(makeSheet(options, index)))

  const workbook = {
    deleteSheet: (sheetId: string) => {
      const at = worksheets.findIndex((sheet) => sheet.getSheetId() === sheetId)
      if (at >= 0) worksheets.splice(at, 1)
      calls.push(`deleteSheet ${sheetId}`)
    },
    getActiveSheet: () => worksheets[0]!,
    getName: () => 'Book',
    getSheets: () => worksheets,
    getSnapshot: () => ({ id: 'snapshot' }),
    insertSheet: (name?: string) => {
      const sheet = makeSheet({ name: name ?? 'Sheet2' }, worksheets.length)
      worksheets.push(sheet)
      calls.push(`insertSheet ${name}`)
      return sheet
    },
    redo: () => calls.push('redo'),
    setActiveSheet: (sheetId: string) => calls.push(`activate ${sheetId}`),
    undo: () => calls.push('undo'),
  }
  const workbookLevel = {
    createTextFinderAsync: async (text: string) => {
      calls.push(`find ${text}`)
      return textFinder(calls)
    },
    newDataValidation: () => validationBuilder(calls),
    newTheadComment: () => ({
      setContent: (content: unknown) => ({ build: () => ({ content }) }),
    }),
  }
  return {
    calls,
    facade: { ...workbookLevel, getActiveWorkbook: () => workbook },
    facadeWithoutWorkbook: { ...workbookLevel, getActiveWorkbook: () => null },
    worksheets: worksheets as (FakeWorksheet & { select(a1: string | null): void })[],
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
    const bridge = new SheetBridge(facade, BORDER_STYLES, () => (clock += 1))
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

describe('SheetBridge — formatting', () => {
  test('applies every requested style in one pass and skips the rest', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.format('A1:B2', {
      background: '#fff2cc',
      bold: true,
      italic: false,
      numberFormat: '#,##0.00',
      wrap: true,
    })
    expect(calls).toEqual([
      'background A1:B2 #fff2cc',
      'fontWeight A1:B2 bold',
      'fontStyle A1:B2 normal',
      'wrap A1:B2 true',
      'numberFormat A1:B2 #,##0.00',
    ])
    expect(bridge.status().revision).toBe(1)
  })

  test('refuses a format call that would change nothing', () => {
    const { facade } = fakeFacade()
    expect(() => new SheetBridge(facade, BORDER_STYLES).format('A1', {}))
      .toThrow(/at least one property/)
  })

  test('border maps a style name to the page’s own enum value', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.border('A1:C3', 'all', 'medium', '#d9d9d9')
    expect(calls).toEqual(['border A1:C3 all 8 #d9d9d9'])
  })

  test('border names an unknown type or style instead of guessing', () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    expect(() => bridge.border('A1', 'diagonal' as never, 'thin')).toThrow(/unknown border type/)
    expect(() => bridge.border('A1', 'all', 'wavy')).toThrow(/unknown border style/)
  })

  test('merge routes each mode to its own operation', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.merge('A1:C1', 'all')
    bridge.merge('A2:C2', 'across')
    bridge.merge('A3:C3', 'vertically')
    bridge.merge('A4:C4', 'break')
    expect(calls).toEqual([
      'merge Sheet1!A1:C1',
      'mergeAcross Sheet1!A2:C2',
      'mergeVertically Sheet1!A3:C3',
      'break Sheet1!A4:C4',
    ])
  })

  test('formatting is refused while a person has a cell editor open', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.setHumanEditing(true)
    expect(() => bridge.format('A1', { bold: true })).toThrow(/person is editing/)
    expect(calls).toEqual([])
  })
})

describe('SheetBridge — structure', () => {
  test('inserts, deletes and resizes rows and columns', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.insertLines('rows', 2, 3)
    bridge.deleteLines('columns', 1, 2)
    bridge.resizeLines('rows', 0, 1, 32)
    expect(calls).toEqual(['insertRows 2 3', 'deleteColumns 1 2', 'rowHeights 0 1 32'])
    expect(bridge.recentChanges().map((change) => change.a1)).toEqual([
      'Sheet1: insert 3 rows at 2',
      'Sheet1: delete 2 columns at 1',
      'Sheet1: resize 1 rows at 0 to 32px',
    ])
  })

  test('an insert may target the end of the sheet but a delete may not', () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.insertLines('rows', 100, 1)
    expect(() => bridge.deleteLines('rows', 100, 1)).toThrow(/between 0 and 99/)
    expect(() => bridge.insertLines('rows', 101, 1)).toThrow(/between 0 and 100/)
    expect(() => bridge.insertLines('rows', 0, 0)).toThrow(/one or more/)
    expect(() => bridge.resizeLines('rows', 0, 1, 0)).toThrow(/positive number/)
  })

  test('freeze sets both axes and zero releases them', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.freeze(1, 2)
    bridge.freeze(0, 0)
    expect(calls).toEqual(['frozenRows 1', 'frozenColumns 2', 'cancelFreeze Sheet1'])
    expect(() => bridge.freeze(-1, 0)).toThrow(/zero or more/)
  })

  test('structure changes are refused while a person is editing', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.setHumanEditing(true)
    expect(() => bridge.insertLines('rows', 0, 1)).toThrow(/person is editing/)
    expect(() => bridge.freeze(1, 0)).toThrow(/person is editing/)
    expect(calls).toEqual([])
  })
})

describe('SheetBridge — reading what the person did', () => {
  test('dataRange reports the used rectangle and its shape', () => {
    const { facade } = fakeFacade([{ name: 'Sheet1', values: [['a', 'b'], ['c', 'd']] }])
    expect(new SheetBridge(facade, BORDER_STYLES).dataRange())
      .toEqual({ a1: 'A1:B2', columns: 2, rows: 2 })
  })

  test('selection reports where the person is, and says so when nowhere', () => {
    const { facade, worksheets } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    expect(bridge.selection()).toEqual({ active: null, ranges: [] })
    worksheets[0]!.select('C5:D6')
    expect(bridge.selection()).toEqual({ active: 'C5:D6', ranges: ['C5:D6'] })
  })

  test('reading the selection stays available while the person types', () => {
    const { facade, worksheets } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    worksheets[0]!.select('A1')
    bridge.setHumanEditing(true)
    expect(bridge.selection().active).toBe('A1')
  })
})

describe('SheetBridge — sheet management', () => {
  test('adds, renames, activates and removes sheets', () => {
    const { calls, facade } = fakeFacade([{ name: 'Sheet1' }, { name: 'Data' }])
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    expect(bridge.addSheet('Summary')).toEqual({ id: 'id-2', name: 'Summary' })
    expect(bridge.renameSheet('Data', 'Raw')).toEqual({ id: 'id-1', name: 'Raw' })
    expect(bridge.activateSheet('Raw')).toEqual({ id: 'id-1', name: 'Raw' })
    bridge.removeSheet('Raw')
    expect(calls).toEqual(['insertSheet Summary', 'activate id-1', 'deleteSheet id-1'])
    expect(bridge.status().sheets.map((sheet) => sheet.name)).toEqual(['Sheet1', 'Summary'])
  })

  test('refuses to remove the last sheet or to use a blank name', () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    expect(() => bridge.removeSheet('Sheet1')).toThrow(/at least one sheet/)
    expect(() => bridge.addSheet('  ')).toThrow(/sheet name is required/)
    expect(() => bridge.renameSheet('Nope', 'X')).toThrow(/no sheet named/)
  })
})

describe('SheetBridge — the feature presets', () => {
  test('sort forwards the column and direction', () => {
    const { calls, facade } = fakeFacade()
    new SheetBridge(facade, BORDER_STYLES).sortRange('A2:D50', 1, false)
    expect(calls).toEqual(['sort A2:D50 1 false'])
  })

  test('sort rejects a column that is not an index', () => {
    const { facade } = fakeFacade()
    expect(() => new SheetBridge(facade, BORDER_STYLES).sortRange('A1', -1))
      .toThrow(/zero-based column index/)
  })

  test('a filter is added once and removed once', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.createFilter('A1:D10')
    expect(() => bridge.createFilter('A1:D10')).toThrow(/already has a filter/)
    bridge.removeFilter()
    expect(() => bridge.removeFilter()).toThrow(/has no filter/)
    expect(calls).toEqual(['createFilter A1:D10', 'removeFilter'])
  })

  test('find counts without replacing, and replace reports both numbers', async () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    expect(await bridge.findReplace('draft', null)).toEqual({ matches: 2, replaced: 0 })
    expect(calls).toEqual(['find draft'])
    expect(await bridge.findReplace('draft', 'final', true))
      .toEqual({ matches: 2, replaced: 2 })
    expect(calls).toEqual(['find draft', 'find draft', 'matchCase true', 'replaceAll final'])
  })

  test('a replace is refused while a person is editing, a count is not', async () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.setHumanEditing(true)
    await expect(bridge.findReplace('a', 'b')).rejects.toThrow(/person is editing/)
    expect(await bridge.findReplace('a', null)).toEqual({ matches: 2, replaced: 0 })
  })

  test('a hyperlink must be http or https', async () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    await expect(bridge.setHyperlink('B4', 'javascript:alert(1)')).rejects.toThrow(/http/)
    await bridge.setHyperlink('B4', 'https://univer.ai', 'Univer')
    expect(calls).toEqual(['link B4 https://univer.ai Univer'])
  })

  test('a comment carries its text to the cell', async () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    await expect(bridge.addComment('A1', '  ')).rejects.toThrow(/comment text is required/)
    await bridge.addComment('A1', 'Check this figure')
    expect(calls[0]).toContain('Check this figure')
    expect(bridge.recentChanges()[0]?.a1).toBe('comment on A1')
  })

  test('data validation builds the rule the caller asked for', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.setDataValidation('C2:C100', { type: 'list', values: ['yes', 'no'] })
    bridge.setDataValidation('D2:D100', { max: 100, min: 1, type: 'numberBetween' })
    bridge.setDataValidation('E2:E100', { type: 'checkbox' })
    expect(calls).toEqual([
      'validation C2:C100 {"rule":"list yes,no"}',
      'validation D2:D100 {"rule":"between 1 100"}',
      'validation E2:E100 {"rule":"checkbox"}',
    ])
  })

  test('data validation refuses a rule that is missing its inputs', () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    expect(() => bridge.setDataValidation('A1', { type: 'list' })).toThrow(/needs values/)
    expect(() => bridge.setDataValidation('A1', { type: 'numberBetween' })).toThrow(/min and max/)
    expect(() => bridge.setDataValidation('A1', { type: 'nope' as never })).toThrow(/unknown/)
  })

  test('a highlight rule carries its condition, its styling and its range', () => {
    const { calls, facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    bridge.addConditionalFormat('B2:B100', {
      background: '#f4cccc',
      bold: true,
      value: 100,
      when: 'greaterThan',
    })
    expect(calls).toEqual([
      'cf {"rule":"gt 100 bg #f4cccc bold true ranges [{\\"a1\\":\\"B2:B100\\"}]"}',
    ])
  })

  test('a highlight rule refuses a condition without its number', () => {
    const { facade } = fakeFacade()
    const bridge = new SheetBridge(facade, BORDER_STYLES)
    expect(() => bridge.addConditionalFormat('A1', { when: 'greaterThan' }))
      .toThrow(/needs a number/)
    expect(() => bridge.addConditionalFormat('A1', { when: 'textContains' }))
      .toThrow(/needs text/)
  })
})
