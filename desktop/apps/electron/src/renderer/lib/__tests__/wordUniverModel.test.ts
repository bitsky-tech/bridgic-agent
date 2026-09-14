import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { BooleanNumber, DOC_RANGE_TYPE, NamedStyleType } from '@univerjs/core'

GlobalRegistrator.register()

const {
  appendTextBlockToSnapshot,
  createUniverDocumentSnapshot,
  extractWordReferences,
  getUniverDocumentText,
  getUniverHeadings,
  getUniverPageCount,
  getUniverWordCount,
  htmlToUniverSnapshot,
  insertReferenceInSnapshot,
  removeReferenceFromSnapshot,
  updateReferenceInSnapshot,
} = await import('../wordUniverModel')
const { executeUniverWordCommand, isUniverSelectionInsideTable, selectUniverText } = await import('../wordUniverAdapter')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const page = { size: 'a4', orientation: 'portrait', margins: 'normal' } as const
const headerFooter = {
  headerHtml: '',
  footerHtml: '',
  showPageNumbers: false,
  differentFirstPage: false,
  pageNumberStart: 1,
}

describe('Univer Word model', () => {
  it('converts legacy HTML into native paragraphs, text styles, lists, and headings', () => {
    const snapshot = htmlToUniverSnapshot(
      '<h1>Overview</h1><p><strong>Hello</strong> world</p><ul><li>First</li><li>Second</li></ul>',
      'word-1',
      'Plan',
    )

    expect(getUniverDocumentText(snapshot)).toContain('Overview')
    expect(snapshot.body?.paragraphs?.[0]?.paragraphStyle?.namedStyleType).toBe(NamedStyleType.HEADING_1)
    expect(snapshot.body?.textRuns?.[0]?.ts?.bl).toBe(1)
    expect(snapshot.body?.paragraphs?.[2]?.bullet?.listType).toBe('BULLET_LIST')
    expect(getUniverHeadings(snapshot)).toEqual([{ level: 1, text: 'Overview' }])
  })

  it('stores page layout and header/footer in the Univer snapshot', () => {
    const snapshot = createUniverDocumentSnapshot('word-1', 'Plan', {
      size: 'letter',
      orientation: 'landscape',
      margins: 'narrow',
    }, {
      ...headerFooter,
      headerHtml: '<b>Quarterly plan</b>',
      footerHtml: 'Internal',
      differentFirstPage: true,
      pageNumberStart: 3,
    })

    expect(snapshot.documentStyle.pageSize).toEqual({ width: 816, height: 1056 })
    expect(snapshot.documentStyle.pageOrient).toBe(1)
    expect(snapshot.documentStyle.marginLeft).toBe(38)
    expect(snapshot.documentStyle.pageNumberStart).toBe(3)
    expect(snapshot.headers?.['bridgic-word-header']?.body.dataStream).toContain('Quarterly plan')
    expect(snapshot.footers?.['bridgic-word-footer']?.body.dataStream).toContain('Internal')
  })

  it('keeps references in the same native snapshot lifecycle as their visible ranges', () => {
    let snapshot = createUniverDocumentSnapshot('word-1', 'Plan', page, headerFooter, '<p>Body</p>')
    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'footnote', id: 'note-1', number: 1, text: 'Source' })
    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'citation', id: 'cite-1', text: 'Author, 2026' })

    expect(extractWordReferences(snapshot)).toEqual({
      citations: [{ id: 'cite-1', text: 'Author, 2026' }],
      footnotes: [{ id: 'note-1', number: 1, text: 'Source' }],
    })
    snapshot = updateReferenceInSnapshot(snapshot, 'citation', 'cite-1', 'Author, 2027')
    expect(extractWordReferences(snapshot).citations).toEqual([{ id: 'cite-1', text: 'Author, 2027' }])
    expect(getUniverDocumentText(snapshot)).toContain('(Author, 2027)')
    expect(getUniverDocumentText(snapshot)).not.toContain('(Author, 2026)')
    snapshot = removeReferenceFromSnapshot(snapshot, 'footnote', 'note-1')
    expect(extractWordReferences(snapshot).footnotes).toEqual([])
    expect(getUniverDocumentText(snapshot)).not.toContain('1')
  })

  it('renumbers visible footnote markers after an earlier footnote is removed', () => {
    let snapshot = createUniverDocumentSnapshot('word-1', 'Plan', page, headerFooter, '<p>Body</p>')
    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'footnote', id: 'note-1', number: 1, text: 'First' })
    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'footnote', id: 'note-2', number: 2, text: 'Second' })
    snapshot = removeReferenceFromSnapshot(snapshot, 'footnote', 'note-1')

    expect(getUniverDocumentText(snapshot)).toBe('Body1')
    expect(extractWordReferences(snapshot).footnotes).toEqual([{ id: 'note-2', number: 1, text: 'Second' }])
    expect(snapshot.body?.customRanges?.find((range) => range.rangeId === 'note-2')?.properties?.number).toBe(1)

    snapshot = insertReferenceInSnapshot(snapshot, { kind: 'footnote', id: 'note-3', number: 2, text: 'Third' })
    expect(getUniverDocumentText(snapshot)).toBe('Body12')
    expect(extractWordReferences(snapshot).footnotes.map((footnote) => footnote.number)).toEqual([1, 2])
  })

  it('appends structured headings and counts words and explicit pages', () => {
    let snapshot = createUniverDocumentSnapshot('word-1', 'Plan', page, headerFooter, '<p>Hello world，你好</p>')
    snapshot = appendTextBlockToSnapshot(snapshot, 'Risks', 'heading2')
    snapshot.body!.dataStream = snapshot.body!.dataStream.replace(/\n$/, '\f\n')

    expect(getUniverWordCount(snapshot)).toBe(5)
    expect(getUniverHeadings(snapshot)).toContainEqual({ level: 2, text: 'Risks' })
    expect(getUniverPageCount(snapshot)).toBe(2)
  })

  it('keeps imported HTML tables as editable native Univer tables', () => {
    const snapshot = htmlToUniverSnapshot(
      '<table><thead><tr><th>Name</th><th>Score</th></tr></thead><tbody><tr><td>Ada</td><td>98</td></tr></tbody></table>',
      'word-table',
      'Scores',
    )
    const tableRange = snapshot.body?.tables?.[0]
    expect(tableRange).toBeDefined()
    const table = tableRange ? snapshot.tableSource?.[tableRange.tableId] : undefined
    expect(table?.tableRows).toHaveLength(2)
    expect(table?.tableColumns).toHaveLength(2)
    expect(table?.tableRows[0]?.repeatHeaderRow).toBe(BooleanNumber.TRUE)
    expect(getUniverDocumentText(snapshot)).toContain('Name')
    expect(getUniverDocumentText(snapshot)).toContain('98')
  })

  it('maps the stable renderer command contract to Univer commands', async () => {
    const calls: Array<{ id: string; params?: object }> = []
    const snapshot = createUniverDocumentSnapshot('word-1', 'Plan', page, headerFooter, '<p>Hello world</p>')
    const selections: Array<[number, number]> = []
    const context = {
      unitId: 'word-1',
      document: {
        appendText: async () => true,
        getSnapshot: () => snapshot,
        insertParagraph: async () => true,
        insertText: async () => true,
        redo: async () => true,
        setSelection: (start: number, end: number) => selections.push([start, end]),
        undo: async () => true,
      },
      getSelection: () => ({ startOffset: 0, endOffset: 5 }),
      univerAPI: {
        executeCommand: async (id: string, params?: object) => {
          calls.push({ id, params })
          return true
        },
      },
      onReferenceCommand: async () => true,
    }

    expect(await executeUniverWordCommand(context, { type: 'editor.format', action: 'bold' })).toBe(true)
    expect(await executeUniverWordCommand(context, { type: 'editor.format', action: 'copy' })).toBe(true)
    expect(await executeUniverWordCommand(context, { type: 'editor.format', action: 'cut' })).toBe(true)
    expect(await executeUniverWordCommand(context, { type: 'editor.format', action: 'paste' })).toBe(true)
    expect(await executeUniverWordCommand(context, { type: 'editor.insert', kind: 'table', rows: 3, cols: 4 })).toBe(true)
    expect(selectUniverText(context.document, 'world')).toBe(true)
    expect(calls.map((call) => call.id)).toEqual([
      'doc.command.set-inline-format-bold',
      'univer.command.copy',
      'univer.command.cut',
      'univer.command.paste',
      'doc.command.create-table',
    ])
    expect(selections).toEqual([[6, 11]])
  })

  it('propagates Univer failures and preserves styles while changing case', async () => {
    const calls: Array<{ id: string; params?: Record<string, unknown> }> = []
    const snapshot = createUniverDocumentSnapshot('word-1', 'Plan', page, headerFooter, '<p><strong>Straße</strong></p>')
    const context = {
      unitId: 'word-1',
      document: {
        appendText: async () => true,
        getSnapshot: () => snapshot,
        insertParagraph: async () => true,
        insertText: async () => true,
        redo: async () => true,
        setSelection: () => undefined,
        undo: async () => true,
      },
      getSelection: () => ({ startOffset: 0, endOffset: 6 }),
      univerAPI: {
        executeCommand: async (id: string, params?: object) => {
          calls.push({ id, params: params as Record<string, unknown> | undefined })
          return id !== 'univer.command.paste'
        },
      },
      onReferenceCommand: async () => true,
    }

    expect(await executeUniverWordCommand(context, { type: 'editor.format', action: 'paste' })).toBe(false)
    expect(await executeUniverWordCommand(context, { type: 'editor.format', action: 'uppercase' })).toBe(true)
    const replaceParams = calls.at(-1)?.params as { body?: { dataStream?: string; textRuns?: unknown[] } } | undefined
    expect(replaceParams?.body?.dataStream).toBe('STRASSE')
    expect(replaceParams?.body?.textRuns).toHaveLength(1)
  })

  it('preserves structure when clearing formatting and applies native character spacing', async () => {
    const calls: Array<{ id: string; params?: Record<string, unknown> }> = []
    const snapshot = createUniverDocumentSnapshot('word-1', 'Plan', page, headerFooter, '<h1><strong>Heading</strong></h1><p>Body</p>')
    const selection = { startOffset: 0, endOffset: snapshot.body!.dataStream.length - 1 }
    const context = {
      unitId: 'word-1',
      document: {
        appendText: async () => true,
        getSnapshot: () => snapshot,
        insertParagraph: async () => true,
        insertText: async () => true,
        redo: async () => true,
        setSelection: () => undefined,
        undo: async () => true,
      },
      getSelection: () => selection,
      univerAPI: {
        executeCommand: async (id: string, params?: object) => {
          calls.push({ id, params: params as Record<string, unknown> | undefined })
          return true
        },
      },
      onReferenceCommand: async () => true,
    }

    expect(await executeUniverWordCommand(context, { type: 'editor.format', action: 'removeFormat' })).toBe(true)
    const cleared = calls.at(-1)?.params?.body as typeof snapshot.body
    expect(cleared?.paragraphs).toHaveLength(2)
    expect(cleared?.paragraphs?.[0]?.paragraphStyle).toBeUndefined()
    expect(cleared?.textRuns).toEqual([])

    expect(await executeUniverWordCommand(context, { type: 'editor.format', action: 'letterSpacing', value: '1.5' })).toBe(true)
    const spaced = calls.at(-1)?.params?.body as typeof snapshot.body
    expect(spaced?.paragraphs).toHaveLength(2)
    expect(spaced?.textRuns?.every((run) => run.ts?.sc === 1.5)).toBe(true)
    expect(spaced?.textRuns?.some((run) => run.ts?.bl === BooleanNumber.TRUE)).toBe(true)
  })

  it('marks a newly inserted table header without creating another history entry', async () => {
    const calls: Array<{ id: string; params?: Record<string, unknown> }> = []
    const snapshot = createUniverDocumentSnapshot('word-1', 'Plan', page, headerFooter, '<table><tr><td>A</td><td>B</td></tr></table>')
    const context = {
      unitId: 'word-1',
      document: {
        appendText: async () => true,
        getSnapshot: () => snapshot,
        insertParagraph: async () => true,
        insertText: async () => true,
        redo: async () => true,
        setSelection: () => undefined,
        undo: async () => true,
      },
      getSelection: () => ({ startOffset: 0, endOffset: 0 }),
      univerAPI: {
        executeCommand: async (id: string, params?: object) => {
          calls.push({ id, params: params as Record<string, unknown> | undefined })
          return true
        },
      },
      onReferenceCommand: async () => true,
    }

    expect(await executeUniverWordCommand(context, { type: 'editor.insert', kind: 'table', rows: 2, cols: 2, withHeaderRow: true })).toBe(true)
    expect(calls.map((call) => call.id)).toEqual(['doc.command.create-table', 'doc.command-replace-snapshot'])
    const replacedSnapshot = calls[1]?.params?.snapshot as typeof snapshot
    const tableId = replacedSnapshot.body?.tables?.[0]?.tableId
    expect(tableId).toBeDefined()
    expect(replacedSnapshot.tableSource?.[tableId!]?.tableRows[0]).toMatchObject({
      isFirstRow: BooleanNumber.TRUE,
      repeatHeaderRow: BooleanNumber.TRUE,
    })
    expect(calls[1]?.params?.options).toEqual({ noHistory: true })
  })

  it('recognizes Univer table selections by node path or rectangular range', () => {
    expect(isUniverSelectionInsideTable({
      startOffset: 0,
      endOffset: 0,
      startNodePosition: { path: ['sections', 0, 'tables', 0, 'rows', 0, 'cells', 0] },
    })).toBe(true)
    expect(isUniverSelectionInsideTable({ startOffset: 0, endOffset: 0, rangeType: DOC_RANGE_TYPE.RECT })).toBe(true)
    expect(isUniverSelectionInsideTable({ startOffset: 0, endOffset: 0, startNodePosition: { path: ['sections', 0] } })).toBe(false)
  })
})
