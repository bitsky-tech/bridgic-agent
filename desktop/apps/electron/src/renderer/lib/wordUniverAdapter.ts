import {
  BooleanNumber,
  DOC_RANGE_TYPE,
  DrawingTypeEnum,
  getBodySlice,
  ImageSourceType,
  NamedStyleType,
  ObjectRelativeFromH,
  ObjectRelativeFromV,
  PositionedObjectLayoutType,
  WrapTextType,
  type IDocumentBody,
  type IDocumentData,
} from '@univerjs/core'
import {
  AlignCenterCommand,
  AlignJustifyCommand,
  AlignLeftCommand,
  AlignRightCommand,
  BulletListCommand,
  ChangeListNestingLevelCommand,
  ChangeListNestingLevelType,
  CheckListCommand,
  CreateDocTableCommand,
  DocCopyCommand,
  DocCutCommand,
  DocPasteCommand,
  DocTableDeleteColumnsCommand,
  DocTableDeleteRowsCommand,
  DocTableDeleteTableCommand,
  DocTableInsertColumnLeftCommand,
  DocTableInsertColumnRightCommand,
  DocTableInsertRowAboveCommand,
  DocTableInsertRowBellowCommand,
  HorizontalLineCommand,
  InsertCustomRangeCommand,
  OrderListCommand,
  ReplaceSelectionCommand,
  ReplaceSnapshotCommand,
  SetInlineFormatBoldCommand,
  SetInlineFormatFontFamilyCommand,
  SetInlineFormatFontSizeCommand,
  SetInlineFormatItalicCommand,
  SetInlineFormatStrikethroughCommand,
  SetInlineFormatSubscriptCommand,
  SetInlineFormatSuperscriptCommand,
  SetInlineFormatTextBackgroundColorCommand,
  SetInlineFormatTextColorCommand,
  SetInlineFormatUnderlineCommand,
  SetParagraphNamedStyleCommand,
} from '@univerjs/docs-ui'
import { InsertDocDrawingCommand } from '@univerjs/preset-docs-drawing'

import type { WordEditorCommand, WordFormattingCommand, WordTableAction } from './wordDomain'
import { htmlToUniverSnapshot } from './wordUniverModel'

const ADD_HYPERLINK_COMMAND = 'docs.command.add-hyper-link'
const FONT_SIZE_STEPS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 36, 48, 72]
const PARAGRAPH_SETTING_COMMAND = 'doc-paragraph-setting.command'

export interface WordUniverDocumentFacade {
  appendText(text: string): Promise<boolean>
  getSnapshot(): IDocumentData
  insertParagraph(text?: string): Promise<boolean>
  insertText(text: string): Promise<boolean>
  redo(): Promise<boolean>
  setSelection(startOffset: number, endOffset: number): void
  undo(): Promise<boolean>
}

export interface WordUniverFacade {
  executeCommand(id: string, params?: object): Promise<boolean>
}

export interface WordUniverSelection {
  endOffset: number
  rangeType?: DOC_RANGE_TYPE
  startNodePosition?: { path: Array<string | number> } | null
  startOffset: number
}

export interface WordUniverCommandContext {
  document: WordUniverDocumentFacade
  getSelection: () => WordUniverSelection | null
  onReferenceCommand: (command: Extract<WordEditorCommand, { type: 'editor.reference.remove' | 'editor.reference.update' }>) => Promise<boolean>
  unitId: string
  univerAPI: WordUniverFacade
}

/** Map Bridgic's stable Word domain commands to Univer OSS commands. */
export async function executeUniverWordCommand(context: WordUniverCommandContext, command: WordEditorCommand): Promise<boolean> {
  if (command.type === 'editor.reference.remove' || command.type === 'editor.reference.update') {
    return context.onReferenceCommand(command)
  }
  if (command.type === 'editor.table') return executeTableAction(context, command.action)
  if (command.type === 'editor.format') return executeFormattingCommand(context, command.action, command.value)
  if (command.kind === 'pageBreak') return schedule(context.document.insertText('\f'))
  if (command.kind === 'html') {
    const body = htmlToUniverSnapshot(command.html, context.unitId, '').body
    return body ? execute(context, ReplaceSelectionCommand.id, { unitId: context.unitId, body }) : false
  }
  if (command.kind === 'link') {
    return execute(context, ADD_HYPERLINK_COMMAND, { unitId: context.unitId, payload: command.href })
  }
  if (command.kind === 'image') {
    return execute(context, InsertDocDrawingCommand.id, {
      unitId: context.unitId,
      drawings: [createImageDrawing(context.unitId, command.src, command.alt ?? '', command.title ?? '')],
    })
  }
  if (command.kind === 'table') {
    const insertionOffset = context.getSelection()?.startOffset ?? 0
    const created = await execute(context, CreateDocTableCommand.id, { rowCount: command.rows, colCount: command.cols })
    if (!created || command.withHeaderRow !== true) return created
    const snapshot = markInsertedTableHeader(context.document.getSnapshot(), insertionOffset)
    if (!snapshot) return false
    return execute(context, ReplaceSnapshotCommand.id, {
      unitId: context.unitId,
      snapshot,
      textRanges: undefined,
      options: { noHistory: true },
    })
  }
  if (command.kind === 'footnote') {
    return execute(context, InsertCustomRangeCommand.id, {
      unitId: context.unitId,
      rangeId: command.id,
      text: String(command.number),
      wholeEntity: true,
      properties: { bridgicKind: 'footnote', id: command.id, number: command.number, text: command.text },
    })
  }
  if (command.kind === 'citation') {
    return execute(context, InsertCustomRangeCommand.id, {
      unitId: context.unitId,
      rangeId: command.id,
      text: `(${command.text})`,
      wholeEntity: true,
      properties: { bridgicKind: 'citation', id: command.id, text: command.text },
    })
  }
  if (command.kind === 'tableOfContents') {
    const text = [command.title, ...command.entries.map((entry) => `${'  '.repeat(entry.level - 1)}${entry.text}`)].join('\n')
    return schedule(context.document.insertParagraph(text))
  }
  return false
}

export function selectUniverText(document: WordUniverDocumentFacade, query: string): boolean {
  const stream = document.getSnapshot().body?.dataStream ?? ''
  const start = stream.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (start < 0) return false
  document.setSelection(start, start + query.length)
  return true
}

async function executeFormattingCommand(context: WordUniverCommandContext, action: WordFormattingCommand, value?: string): Promise<boolean> {
  if (action === 'copy') return execute(context, DocCopyCommand.id)
  if (action === 'cut') return execute(context, DocCutCommand.id)
  if (action === 'paste') return execute(context, DocPasteCommand.id)
  if (action === 'increaseFontSize' || action === 'decreaseFontSize') {
    return execute(context, SetInlineFormatFontSizeCommand.id, { value: nextFontSize(context, action === 'increaseFontSize') })
  }
  const command = formattingCommand(action)
  if (command) return execute(context, command.id, formattingValue(action, value))
  if (action === 'undo') return schedule(context.document.undo())
  if (action === 'redo') return schedule(context.document.redo())
  if (action === 'insertHorizontalRule') return execute(context, HorizontalLineCommand.id)
  if (action === 'insertUnorderedList') return execute(context, BulletListCommand.id)
  if (action === 'insertOrderedList') return execute(context, OrderListCommand.id)
  if (action === 'toggleTaskList') return execute(context, CheckListCommand.id)
  if (action === 'indent' || action === 'outdent') return changeIndent(context, action === 'indent')
  if (action === 'justifyLeft') return execute(context, AlignLeftCommand.id)
  if (action === 'justifyCenter') return execute(context, AlignCenterCommand.id)
  if (action === 'justifyRight') return execute(context, AlignRightCommand.id)
  if (action === 'justifyFull') return execute(context, AlignJustifyCommand.id)
  if (action === 'formatBlock') {
    if (value === 'blockquote') {
      return execute(context, PARAGRAPH_SETTING_COMMAND, { paragraph: { indentStart: { v: 24 } } })
    }
    return execute(context, SetParagraphNamedStyleCommand.id, { value: namedStyle(value) })
  }
  if (action === 'lineHeight') {
    const lineSpacing = Number(value)
    if (!Number.isFinite(lineSpacing) || lineSpacing <= 0) return false
    return execute(context, PARAGRAPH_SETTING_COMMAND, { paragraph: { lineSpacing } })
  }
  if (action === 'letterSpacing') {
    const letterSpacing = Number(value)
    if (!Number.isFinite(letterSpacing) || letterSpacing < -20 || letterSpacing > 100) return false
    const selection = context.getSelection()
    if (!selection || selection.startOffset === selection.endOffset) return false
    const documentBody = context.document.getSnapshot().body
    if (!documentBody) return false
    return execute(context, ReplaceSelectionCommand.id, {
      unitId: context.unitId,
      selection: { ...selection, collapsed: false },
      body: applyTextStyleToSelection(documentBody, selection.startOffset, selection.endOffset, { sc: letterSpacing }),
    })
  }
  if (action === 'removeFormat' || action === 'uppercase' || action === 'toggleCase') {
    const selection = context.getSelection()
    if (!selection || selection.startOffset === selection.endOffset) return false
    const documentBody = context.document.getSnapshot().body
    const source = documentBody?.dataStream.slice(selection.startOffset, selection.endOffset) ?? ''
    let text = source
    if (action === 'uppercase') text = source.toLocaleUpperCase()
    if (action === 'toggleCase') {
      text = source === source.toLocaleUpperCase() ? source.toLocaleLowerCase() : source.toLocaleUpperCase()
    }
    let replacementBody: IDocumentBody
    if (!documentBody) replacementBody = selectionBody(text)
    else if (action === 'removeFormat') replacementBody = clearSelectionFormatting(documentBody, selection.startOffset, selection.endOffset)
    else replacementBody = transformSelectionBody(documentBody, selection.startOffset, selection.endOffset, source, text)
    return execute(context, ReplaceSelectionCommand.id, {
      unitId: context.unitId,
      selection: { ...selection, collapsed: false },
      body: replacementBody,
    })
  }
  return false
}

function formattingCommand(action: WordFormattingCommand): { id: string } | null {
  if (action === 'bold') return SetInlineFormatBoldCommand
  if (action === 'italic') return SetInlineFormatItalicCommand
  if (action === 'underline') return SetInlineFormatUnderlineCommand
  if (action === 'strikeThrough') return SetInlineFormatStrikethroughCommand
  if (action === 'subscript') return SetInlineFormatSubscriptCommand
  if (action === 'superscript') return SetInlineFormatSuperscriptCommand
  if (action === 'fontName') return SetInlineFormatFontFamilyCommand
  if (action === 'fontSize') return SetInlineFormatFontSizeCommand
  if (action === 'foreColor') return SetInlineFormatTextColorCommand
  if (action === 'hiliteColor') return SetInlineFormatTextBackgroundColorCommand
  return null
}

function formattingValue(action: WordFormattingCommand, value?: string): Record<string, string | number> | undefined {
  if (action === 'fontSize') return { value: fontSize(value) }
  return value === undefined ? undefined : { value }
}

async function changeIndent(context: WordUniverCommandContext, increase: boolean): Promise<boolean> {
  const snapshot = context.document.getSnapshot()
  const selection = context.getSelection()
  const offset = selection?.startOffset ?? 0
  const paragraph = snapshot.body?.paragraphs?.find((item) => offset <= item.startIndex)
  if (paragraph?.bullet) {
    return execute(context, ChangeListNestingLevelCommand.id, {
      type: increase ? ChangeListNestingLevelType.increase : ChangeListNestingLevelType.decrease,
    })
  }
  const current = paragraph?.paragraphStyle?.indentStart?.v ?? 0
  const next = Math.max(0, Math.min(240, current + (increase ? 24 : -24)))
  return execute(context, PARAGRAPH_SETTING_COMMAND, { paragraph: { indentStart: { v: next } } })
}

function nextFontSize(context: WordUniverCommandContext, increase: boolean): number {
  const snapshot = context.document.getSnapshot()
  const offset = context.getSelection()?.startOffset ?? 0
  const run = snapshot.body?.textRuns?.find((item) => item.st <= offset && offset <= item.ed)
  const current = run?.ts?.fs ?? snapshot.documentStyle?.textStyle?.fs ?? 12
  if (increase) return FONT_SIZE_STEPS.find((size) => size > current) ?? FONT_SIZE_STEPS.at(-1)!
  return [...FONT_SIZE_STEPS].reverse().find((size) => size < current) ?? FONT_SIZE_STEPS[0]!
}

async function executeTableAction(context: WordUniverCommandContext, action: WordTableAction): Promise<boolean> {
  if (action === 'addRowBefore') return execute(context, DocTableInsertRowAboveCommand.id)
  if (action === 'addRowAfter') return execute(context, DocTableInsertRowBellowCommand.id)
  if (action === 'addColumnBefore') return execute(context, DocTableInsertColumnLeftCommand.id)
  if (action === 'addColumnAfter') return execute(context, DocTableInsertColumnRightCommand.id)
  if (action === 'deleteRow') return execute(context, DocTableDeleteRowsCommand.id)
  if (action === 'deleteColumn') return execute(context, DocTableDeleteColumnsCommand.id)
  if (action === 'deleteTable') return execute(context, DocTableDeleteTableCommand.id)
  return false
}

function namedStyle(value: string | undefined): NamedStyleType {
  if (value === 'h1') return NamedStyleType.HEADING_1
  if (value === 'h2') return NamedStyleType.HEADING_2
  if (value === 'h3') return NamedStyleType.HEADING_3
  if (value === 'h4') return NamedStyleType.HEADING_4
  if (value === 'h5') return NamedStyleType.HEADING_5
  if (value === 'title') return NamedStyleType.TITLE
  if (value === 'subtitle') return NamedStyleType.SUBTITLE
  return NamedStyleType.NORMAL_TEXT
}

function fontSize(value: string | undefined): number {
  const sizes: Record<string, number> = { '1': 8, '2': 10, '3': 12, '4': 14, '5': 18, '6': 24, '7': 36 }
  if (value && value in sizes) return sizes[value]!
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 6 && parsed <= 96 ? parsed : 12
}

function createImageDrawing(unitId: string, source: string, alt: string, title: string) {
  const drawingId = `word-image-${typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36)}`
  return {
    unitId,
    subUnitId: unitId,
    drawingId,
    drawingType: DrawingTypeEnum.DRAWING_IMAGE,
    imageSourceType: source.startsWith('data:') ? ImageSourceType.BASE64 : ImageSourceType.URL,
    source,
    transform: { left: 0, top: 0, width: 480, height: 300 },
    docTransform: {
      size: { width: 480, height: 300 },
      positionH: { relativeFrom: ObjectRelativeFromH.PAGE, posOffset: 0 },
      positionV: { relativeFrom: ObjectRelativeFromV.PARAGRAPH, posOffset: 0 },
      angle: 0,
    },
    behindDoc: BooleanNumber.FALSE,
    title,
    description: alt,
    layoutType: PositionedObjectLayoutType.INLINE,
    wrapText: WrapTextType.BOTH_SIDES,
    distB: 0,
    distL: 0,
    distR: 0,
    distT: 0,
  }
}

async function execute(context: WordUniverCommandContext, id: string, params?: object): Promise<boolean> {
  try {
    return await context.univerAPI.executeCommand(id, params)
  } catch {
    return false
  }
}

async function schedule(result: Promise<boolean>): Promise<boolean> {
  try {
    return await result
  } catch {
    return false
  }
}

export function selectionBody(text: string): IDocumentBody {
  return { dataStream: text, textRuns: [], paragraphs: [], customBlocks: [], customRanges: [], tables: [] }
}

/** Univer identifies table-cell selections by their tree path (or a rectangular table range), not body offsets. */
export function isUniverSelectionInsideTable(selection: WordUniverSelection | null): boolean {
  return selection?.rangeType === DOC_RANGE_TYPE.RECT || selection?.startNodePosition?.path.includes('cells') === true
}

function transformSelectionBody(body: IDocumentBody, startOffset: number, endOffset: number, source: string, transformed: string): IDocumentBody {
  const result = getBodySliceWithSections(body, startOffset, endOffset)
  result.dataStream = transformed
  if (source.length === transformed.length) return result

  const offsetMap = buildCaseOffsetMap(source)
  const remapBoundary = (offset: number) => offsetMap[Math.max(0, Math.min(offset, source.length))] ?? transformed.length
  result.textRuns = result.textRuns?.map((run) => ({ ...run, st: remapBoundary(run.st), ed: remapBoundary(run.ed) }))
  result.paragraphs = result.paragraphs?.map((paragraph) => ({ ...paragraph, startIndex: remapBoundary(paragraph.startIndex) }))
  result.sectionBreaks = result.sectionBreaks?.map((section) => ({ ...section, startIndex: remapBoundary(section.startIndex) }))
  result.customBlocks = result.customBlocks?.map((block) => ({ ...block, startIndex: remapBoundary(block.startIndex) }))
  result.customRanges = result.customRanges?.map((range) => ({
    ...range,
    startIndex: remapBoundary(range.startIndex),
    endIndex: Math.max(remapBoundary(range.startIndex), remapBoundary(range.endIndex + 1) - 1),
  }))
  return result
}

function clearSelectionFormatting(body: IDocumentBody, startOffset: number, endOffset: number): IDocumentBody {
  const result = getBodySliceWithSections(body, startOffset, endOffset)
  result.textRuns = []
  result.paragraphs = result.paragraphs?.map(({ paragraphStyle: _paragraphStyle, ...paragraph }) => paragraph)
  return result
}

function applyTextStyleToSelection(body: IDocumentBody, startOffset: number, endOffset: number, style: NonNullable<IDocumentBody['textRuns']>[number]['ts']): IDocumentBody {
  const result = getBodySliceWithSections(body, startOffset, endOffset)
  const length = result.dataStream.length
  const textRuns = [...(result.textRuns ?? [])].sort((left, right) => left.st - right.st)
  const styledRuns: NonNullable<IDocumentBody['textRuns']> = []
  let cursor = 0
  for (const run of textRuns) {
    const start = Math.max(cursor, Math.min(length, run.st))
    const end = Math.max(start, Math.min(length, run.ed))
    if (cursor < start) styledRuns.push({ st: cursor, ed: start, ts: { ...style } })
    if (end > start) styledRuns.push({ ...run, st: start, ed: end, ts: { ...run.ts, ...style } })
    cursor = Math.max(cursor, end)
  }
  if (cursor < length) styledRuns.push({ st: cursor, ed: length, ts: { ...style } })
  result.textRuns = styledRuns
  return result
}

function getBodySliceWithSections(body: IDocumentBody, startOffset: number, endOffset: number): IDocumentBody {
  const result = getBodySlice(body, startOffset, endOffset, false)
  result.sectionBreaks = body.sectionBreaks
    ?.filter((section) => section.startIndex >= startOffset && section.startIndex < endOffset)
    .map((section) => ({ ...section, startIndex: section.startIndex - startOffset }))
  return result
}

function markInsertedTableHeader(snapshot: IDocumentData, insertionOffset: number): IDocumentData | null {
  const table = [...(snapshot.body?.tables ?? [])]
    .sort((left, right) => left.startIndex - right.startIndex)
    .find((item) => item.startIndex >= insertionOffset)
  if (!table) return null
  const source = snapshot.tableSource?.[table.tableId]
  const firstRow = source?.tableRows[0]
  if (!source || !firstRow) return null
  return {
    ...snapshot,
    tableSource: {
      ...snapshot.tableSource,
      [table.tableId]: {
        ...source,
        tableRows: [
          { ...firstRow, isFirstRow: BooleanNumber.TRUE, repeatHeaderRow: BooleanNumber.TRUE },
          ...source.tableRows.slice(1),
        ],
      },
    },
  }
}

function buildCaseOffsetMap(source: string): number[] {
  const map = new Array<number>(source.length + 1).fill(0)
  let sourceOffset = 0
  let transformedOffset = 0
  const transform = source === source.toLocaleUpperCase()
    ? (value: string) => value.toLocaleLowerCase()
    : (value: string) => value.toLocaleUpperCase()
  for (const value of source) {
    const nextSourceOffset = sourceOffset + value.length
    const nextTransformedOffset = transformedOffset + transform(value).length
    for (let index = sourceOffset; index < nextSourceOffset; index += 1) map[index] = transformedOffset
    map[nextSourceOffset] = nextTransformedOffset
    sourceOffset = nextSourceOffset
    transformedOffset = nextTransformedOffset
  }
  return map
}
