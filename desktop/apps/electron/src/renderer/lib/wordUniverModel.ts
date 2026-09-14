import {
  BaselineOffset,
  BooleanNumber,
  CustomRangeType,
  DataStreamTreeTokenType,
  DocumentFlavor,
  DrawingTypeEnum,
  HorizontalAlign,
  ImageSourceType,
  NamedStyleType,
  ObjectRelativeFromH,
  ObjectRelativeFromV,
  PageOrientType,
  PositionedObjectLayoutType,
  PRESET_LIST_TYPE,
  PresetListType,
  TableAlignmentType,
  TableRowHeightRule,
  TableSizeType,
  TableTextWrapType,
  WrapTextType,
  getPlainText,
  type IDocumentBody,
  type IDocumentData,
  type IParagraph,
  type ITable,
  type ITableCell,
  type ITableRow,
  type ITextRun,
  type ITextStyle,
} from '@univerjs/core'

import type {
  WordAppendBlock,
  WordCitationEntry,
  WordFootnote,
  WordHeaderFooterSettings,
  WordPageSettings,
  WordTableOfContentsEntry,
} from './wordDomain'

const PAGE_SIZE = {
  a4: { width: 794, height: 1124 },
  letter: { width: 816, height: 1056 },
} as const

const PAGE_MARGIN = {
  narrow: 38,
  normal: 72,
  wide: 96,
} as const

const HEADER_ID = 'bridgic-word-header'
const FOOTER_ID = 'bridgic-word-footer'
const DEFAULT_TABLE_WIDTH = 650

export interface WordReferenceMetadata {
  citations: WordCitationEntry[]
  footnotes: WordFootnote[]
}

interface ParsedBlock {
  text: string
  textRuns: Array<{ end: number; start: number; style: ITextStyle }>
  paragraphStyle?: IParagraph['paragraphStyle']
  bullet?: IParagraph['bullet']
  customRanges: NonNullable<IDocumentBody['customRanges']>
  drawings: NonNullable<IDocumentData['drawings']>
  customBlocks: NonNullable<IDocumentBody['customBlocks']>
  table?: {
    paragraphs: IParagraph[]
    sectionBreaks: NonNullable<IDocumentBody['sectionBreaks']>
    source: ITable
  }
}

interface ParsedTableCell {
  columnSpan: number
  covered: boolean
  element: HTMLElement | null
  rowSpan: number
}

/** Create the canonical Univer document snapshot used by a Session Word tab. */
export function createUniverDocumentSnapshot(
  id: string,
  title: string,
  page: WordPageSettings,
  headerFooter: WordHeaderFooterSettings,
  html = '<p><br></p>',
): IDocumentData {
  const snapshot = htmlToUniverSnapshot(html, id, title)
  return applyHeaderFooterToSnapshot(applyPageSettingsToSnapshot(snapshot, page), headerFooter)
}

/** Normalize persisted or externally supplied data into a complete Univer snapshot. */
export function normalizeUniverDocumentSnapshot(
  value: unknown,
  id: string,
  title: string,
  page: WordPageSettings,
  headerFooter: WordHeaderFooterSettings,
): IDocumentData {
  if (!isRecord(value) || !isRecord(value.documentStyle) || !isRecord(value.body) || typeof value.body.dataStream !== 'string') {
    return createUniverDocumentSnapshot(id, title, page, headerFooter)
  }
  const snapshot = clone(value as unknown as IDocumentData)
  snapshot.id = id
  snapshot.title = title
  snapshot.body = normalizeBody(snapshot.body)
  snapshot.documentStyle = { ...snapshot.documentStyle }
  snapshot.drawings ??= {}
  snapshot.drawingsOrder ??= []
  snapshot.headers ??= {}
  snapshot.footers ??= {}
  return applyHeaderFooterToSnapshot(applyPageSettingsToSnapshot(snapshot, page), headerFooter)
}

/** Convert legacy, sanitized HTML workspaces to Univer's native document model. */
export function htmlToUniverSnapshot(html: string, id: string, title: string): IDocumentData {
  const template = document.createElement('template')
  template.innerHTML = html
  const blocks = parseBlocks(template.content)
  if (blocks.length === 0) blocks.push(emptyBlock())

  let dataStream = ''
  const paragraphs: IParagraph[] = []
  const textRuns: ITextRun[] = []
  const customRanges: NonNullable<IDocumentBody['customRanges']> = []
  const customBlocks: NonNullable<IDocumentBody['customBlocks']> = []
  const sectionBreaks: NonNullable<IDocumentBody['sectionBreaks']> = []
  const tables: NonNullable<IDocumentBody['tables']> = []
  const tableSource: NonNullable<IDocumentData['tableSource']> = {}
  const drawings: NonNullable<IDocumentData['drawings']> = {}
  const drawingsOrder: string[] = []

  for (const block of blocks) {
    if (block.table) {
      if (!dataStream.endsWith(DataStreamTreeTokenType.PARAGRAPH)) {
        dataStream += DataStreamTreeTokenType.PARAGRAPH
        paragraphs.push({ startIndex: dataStream.length - 1 })
      }
      const offset = dataStream.length
      dataStream += block.text
      paragraphs.push(...blockParagraphsAtOffset(block, offset))
      textRuns.push(...block.textRuns.map((run) => ({ st: offset + run.start, ed: offset + run.end, ts: run.style })))
      customRanges.push(...block.customRanges.map((range) => ({ ...range, startIndex: offset + range.startIndex, endIndex: offset + range.endIndex })))
      customBlocks.push(...block.customBlocks.map((customBlock) => ({ ...customBlock, startIndex: offset + customBlock.startIndex })))
      sectionBreaks.push(...block.table.sectionBreaks.map((section) => ({ ...section, startIndex: offset + section.startIndex })))
      tables.push({ startIndex: offset, endIndex: dataStream.length, tableId: block.table.source.tableId })
      tableSource[block.table.source.tableId] = block.table.source
      appendBlockDrawings(block, drawings, drawingsOrder)
      continue
    }
    const offset = dataStream.length
    dataStream += `${block.text}\r`
    paragraphs.push({
      startIndex: dataStream.length - 1,
      ...(block.paragraphStyle ? { paragraphStyle: block.paragraphStyle } : {}),
      ...(block.bullet ? { bullet: block.bullet } : {}),
    })
    for (const run of block.textRuns) {
      if (run.end > run.start) textRuns.push({ st: offset + run.start, ed: offset + run.end, ts: run.style })
    }
    for (const range of block.customRanges) {
      customRanges.push({ ...range, startIndex: offset + range.startIndex, endIndex: offset + range.endIndex })
    }
    for (const customBlock of block.customBlocks) {
      customBlocks.push({ ...customBlock, startIndex: offset + customBlock.startIndex })
    }
    appendBlockDrawings(block, drawings, drawingsOrder)
  }
  dataStream += '\n'
  sectionBreaks.push({ startIndex: dataStream.length - 1 })

  const lists: NonNullable<IDocumentData['lists']> = {}
  for (const paragraph of paragraphs) {
    const bullet = paragraph.bullet
    if (!bullet || lists[bullet.listId]) continue
    const preset = PRESET_LIST_TYPE[bullet.listType]
    if (preset) lists[bullet.listId] = { ...clone(preset), listType: bullet.listType }
  }
  for (const drawing of Object.values(drawings)) {
    drawing.unitId = id
    drawing.subUnitId = id
  }

  return {
    id,
    title,
    body: {
      dataStream,
      textRuns,
      paragraphs,
      sectionBreaks,
      customBlocks,
      customRanges,
      tables,
    },
    documentStyle: {
      documentFlavor: DocumentFlavor.TRADITIONAL,
      pageSize: { ...PAGE_SIZE.a4 },
      pageOrient: PageOrientType.PORTRAIT,
      marginTop: PAGE_MARGIN.normal,
      marginBottom: PAGE_MARGIN.normal,
      marginLeft: PAGE_MARGIN.normal,
      marginRight: PAGE_MARGIN.normal,
      marginHeader: 30,
      marginFooter: 30,
      renderConfig: { zeroWidthParagraphBreak: BooleanNumber.FALSE },
    },
    drawings,
    drawingsOrder,
    headers: {},
    footers: {},
    lists,
    tableSource,
    settings: { zoomRatio: 1 },
  }
}

export function applyPageSettingsToSnapshot(snapshot: IDocumentData, page: WordPageSettings): IDocumentData {
  const result = clone(snapshot)
  const margin = PAGE_MARGIN[page.margins]
  result.documentStyle = {
    ...result.documentStyle,
    pageSize: { ...PAGE_SIZE[page.size] },
    pageOrient: page.orientation === 'portrait' ? PageOrientType.PORTRAIT : PageOrientType.LANDSCAPE,
    marginTop: margin,
    marginBottom: margin,
    marginLeft: margin,
    marginRight: margin,
  }
  return result
}

export function applyHeaderFooterToSnapshot(snapshot: IDocumentData, settings: WordHeaderFooterSettings): IDocumentData {
  const result = clone(snapshot)
  const headerText = htmlToPlainText(settings.headerHtml)
  const footerText = htmlToPlainText(settings.footerHtml)
  result.headers = headerText ? { [HEADER_ID]: { headerId: HEADER_ID, body: textBody(headerText) } } : {}
  result.footers = footerText ? { [FOOTER_ID]: { footerId: FOOTER_ID, body: textBody(footerText) } } : {}
  result.documentStyle = {
    ...result.documentStyle,
    defaultHeaderId: headerText ? HEADER_ID : '',
    defaultFooterId: footerText ? FOOTER_ID : '',
    firstPageHeaderId: settings.differentFirstPage ? '' : undefined,
    firstPageFooterId: settings.differentFirstPage ? '' : undefined,
    useFirstPageHeaderFooter: settings.differentFirstPage ? BooleanNumber.TRUE : BooleanNumber.FALSE,
    pageNumberStart: settings.pageNumberStart,
  }
  return result
}

export function appendTextBlockToSnapshot(snapshot: IDocumentData, text: string, block: WordAppendBlock): IDocumentData {
  const result = clone(snapshot)
  const body = normalizeBody(result.body)
  const sectionIndex = Math.max(0, body.dataStream.length - 1)
  const content = text.replace(/\r?\n/g, '\r')
  const insertion = `${content}\r`
  body.dataStream = `${body.dataStream.slice(0, sectionIndex)}${insertion}${body.dataStream.slice(sectionIndex)}`
  const paragraphStyle = namedStyleForBlock(block)
  body.paragraphs = shiftIndexes(body.paragraphs ?? [], sectionIndex, insertion.length)
  body.paragraphs.push({
    startIndex: sectionIndex + insertion.length - 1,
    ...(paragraphStyle ? { paragraphStyle } : {}),
  })
  body.paragraphs.sort((a, b) => a.startIndex - b.startIndex)
  body.sectionBreaks = shiftIndexes(body.sectionBreaks ?? [], sectionIndex, insertion.length)
  body.textRuns = shiftRanges(body.textRuns ?? [], sectionIndex, insertion.length)
  body.customRanges = shiftRanges(body.customRanges ?? [], sectionIndex, insertion.length)
  body.customBlocks = shiftIndexes(body.customBlocks ?? [], sectionIndex, insertion.length)
  result.body = body
  return result
}

export function insertReferenceInSnapshot(
  snapshot: IDocumentData,
  reference: { id: string; kind: 'citation'; text: string } | { id: string; kind: 'footnote'; number: number; text: string },
): IDocumentData {
  const result = clone(snapshot)
  const body = normalizeBody(result.body)
  const sectionIndex = Math.max(0, body.dataStream.lastIndexOf('\r'))
  const display = reference.kind === 'footnote' ? String(reference.number) : `(${reference.text})`
  body.dataStream = `${body.dataStream.slice(0, sectionIndex)}${display}${body.dataStream.slice(sectionIndex)}`
  body.customRanges = shiftRanges(body.customRanges ?? [], sectionIndex, display.length)
  body.customRanges.push({
    startIndex: sectionIndex,
    endIndex: sectionIndex + display.length - 1,
    rangeId: reference.id,
    rangeType: CustomRangeType.CUSTOM,
    wholeEntity: true,
    properties: {
      bridgicKind: reference.kind,
      id: reference.id,
      text: reference.text,
      ...(reference.kind === 'footnote' ? { number: reference.number } : {}),
    },
  })
  body.paragraphs = shiftIndexes(body.paragraphs ?? [], sectionIndex, display.length)
  body.sectionBreaks = shiftIndexes(body.sectionBreaks ?? [], sectionIndex, display.length)
  body.customBlocks = shiftIndexes(body.customBlocks ?? [], sectionIndex, display.length)
  body.textRuns = shiftTextRuns(body.textRuns ?? [], sectionIndex, display.length)
  result.body = body
  return result
}

export function updateReferenceInSnapshot(snapshot: IDocumentData, kind: 'citation' | 'footnote', id: string, text: string): IDocumentData {
  const result = clone(snapshot)
  const body = normalizeBody(result.body)
  const target = (body.customRanges ?? []).find((range) => range.rangeType === CustomRangeType.CUSTOM && range.rangeId === id && range.properties?.bridgicKind === kind)
  if (!target) return result

  if (kind === 'citation') {
    replaceCustomRangeDisplay(body, target, `(${text})`, { ...target.properties, text })
  } else {
    target.properties = { ...target.properties, text }
  }
  result.body = body
  return result
}

export function removeReferenceFromSnapshot(snapshot: IDocumentData, kind: 'citation' | 'footnote', id: string): IDocumentData {
  const result = clone(snapshot)
  const body = normalizeBody(result.body)
  const target = (body.customRanges ?? []).find((range) => range.rangeId === id && range.properties?.bridgicKind === kind)
  if (!target) return result
  const start = target.startIndex
  const length = target.endIndex - target.startIndex + 1
  body.dataStream = `${body.dataStream.slice(0, start)}${body.dataStream.slice(start + length)}`
  body.customRanges = (body.customRanges ?? [])
    .filter((range) => range !== target)
    .map((range) => shiftRangeAfterDelete(range, start, length))
  body.textRuns = (body.textRuns ?? []).map((run) => shiftRangeAfterDelete(run, start, length))
  body.paragraphs = shiftIndexesAfterDelete(body.paragraphs ?? [], start, length)
  body.sectionBreaks = shiftIndexesAfterDelete(body.sectionBreaks ?? [], start, length)
  body.customBlocks = shiftIndexesAfterDelete(body.customBlocks ?? [], start, length)
  body.tables = (body.tables ?? []).map((table) => shiftRangeAfterDelete(table, start, length))
  if (kind === 'footnote') renumberFootnoteReferences(body)
  result.body = body
  return result
}

export function extractWordReferences(snapshot: IDocumentData): WordReferenceMetadata {
  const citations: WordCitationEntry[] = []
  const footnotes: WordFootnote[] = []
  const seen = new Set<string>()
  for (const range of snapshot.body?.customRanges ?? []) {
    const properties = range.properties
    const kind = properties?.bridgicKind
    const id = typeof properties?.id === 'string' ? properties.id : range.rangeId
    const text = typeof properties?.text === 'string' ? properties.text.trim() : ''
    if (!id || !text || seen.has(`${kind}:${id}`)) continue
    if (kind === 'citation') citations.push({ id, text })
    if (kind === 'footnote') {
      footnotes.push({ id, number: positiveInteger(properties?.number, footnotes.length + 1), text })
    }
    seen.add(`${kind}:${id}`)
  }
  return {
    citations,
    footnotes: footnotes.map((footnote, index) => ({ ...footnote, number: index + 1 })),
  }
}

export function getUniverDocumentText(snapshot: IDocumentData): string {
  return getPlainText(snapshot.body?.dataStream ?? '')
}

export function getUniverWordCount(snapshot: IDocumentData): number {
  const text = getUniverDocumentText(snapshot).trim()
  if (!text) return 0
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const withoutCjk = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
  const words = withoutCjk.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0
  return cjk + words
}

export function getUniverHeadings(snapshot: IDocumentData): WordTableOfContentsEntry[] {
  const body = snapshot.body
  if (!body) return []
  const entries: WordTableOfContentsEntry[] = []
  let previous = 0
  for (const paragraph of body.paragraphs ?? []) {
    const level = headingLevel(paragraph.paragraphStyle?.namedStyleType)
    if (level === 0) {
      previous = paragraph.startIndex + 1
      continue
    }
    const text = getPlainText(body.dataStream.slice(previous, paragraph.startIndex)).trim()
    if (text) entries.push({ level, text })
    previous = paragraph.startIndex + 1
  }
  return entries
}

export function getUniverPageCount(snapshot: IDocumentData): number {
  const explicitPages = 1 + ((snapshot.body?.dataStream.match(/\f/g) ?? []).length)
  const page = snapshot.documentStyle.pageSize ?? PAGE_SIZE.a4
  const marginHeight = (snapshot.documentStyle.marginTop ?? 72) + (snapshot.documentStyle.marginBottom ?? 72)
  const usableHeight = Math.max(300, (page.height ?? PAGE_SIZE.a4.height) - marginHeight)
  const estimatedLines = getUniverDocumentText(snapshot).split(/\r?\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 55)), 0)
  return Math.max(explicitPages, Math.ceil((estimatedLines * 24) / usableHeight), 1)
}

export function snapshotSignature(snapshot: IDocumentData): string {
  return JSON.stringify(snapshot)
}

function renumberFootnoteReferences(body: IDocumentBody): void {
  const footnoteIds = [...(body.customRanges ?? [])]
    .filter((range) => range.rangeType === CustomRangeType.CUSTOM && range.properties?.bridgicKind === 'footnote')
    .sort((left, right) => left.startIndex - right.startIndex)
    .map((range) => range.rangeId)

  footnoteIds.forEach((rangeId, index) => {
    const target = (body.customRanges ?? []).find((range) => range.rangeId === rangeId && range.properties?.bridgicKind === 'footnote')
    if (!target) return
    const number = index + 1
    replaceCustomRangeDisplay(body, target, String(number), { ...target.properties, number })
  })
}

function replaceCustomRangeDisplay(
  body: IDocumentBody,
  target: NonNullable<IDocumentBody['customRanges']>[number],
  display: string,
  properties: NonNullable<IDocumentBody['customRanges']>[number]['properties'],
): void {
  const start = target.startIndex
  const end = target.endIndex + 1
  const delta = display.length - (end - start)
  body.dataStream = `${body.dataStream.slice(0, start)}${display}${body.dataStream.slice(end)}`
  body.textRuns = (body.textRuns ?? []).map((run) => shiftTextRunAfterReplace(run, start, end, display.length, delta))
  body.paragraphs = shiftIndexesAfterReplace(body.paragraphs ?? [], end, delta)
  body.sectionBreaks = shiftIndexesAfterReplace(body.sectionBreaks ?? [], end, delta)
  body.customBlocks = shiftIndexesAfterReplace(body.customBlocks ?? [], end, delta)
  body.tables = (body.tables ?? []).map((table) => shiftContainerRangeAfterReplace(table, start, end, delta))
  body.customRanges = (body.customRanges ?? []).map((range) => range === target
    ? { ...range, endIndex: start + display.length - 1, properties }
    : shiftInclusiveRangeAfterReplace(range, start, end, delta))
}

function parseBlocks(root: ParentNode): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim() ?? ''
      if (text) blocks.push(textBlock(text))
      continue
    }
    if (!(node instanceof HTMLElement)) continue
    const tag = node.tagName.toLowerCase()
    if (tag === 'ul' || tag === 'ol') {
      const listType = tag === 'ol' ? PresetListType.ORDER_LIST : PresetListType.BULLET_LIST
      parseList(node, listType, blocks, 0, `list-${Math.random().toString(36).slice(2)}`)
      continue
    }
    if (tag === 'table') {
      blocks.push(parseTable(node as HTMLTableElement))
      continue
    }
    if (tag === 'hr') {
      blocks.push(textBlock('────────────────'))
      continue
    }
    if (node.dataset.wordPageBreak === 'true') {
      blocks.push(textBlock('\f'))
      continue
    }
    if (isBlockTag(tag)) {
      blocks.push(inlineBlock(node, paragraphStyleForElement(node)))
      continue
    }
    const nested = parseBlocks(node)
    if (nested.length > 0) blocks.push(...nested)
    else blocks.push(inlineBlock(node))
  }
  return blocks
}

function parseList(element: HTMLElement, listType: PresetListType, target: ParsedBlock[], nestingLevel: number, listId: string): void {
  for (const child of element.children) {
    if (child.tagName.toLowerCase() !== 'li') continue
    const holder = child.cloneNode(true) as HTMLElement
    for (const nested of holder.querySelectorAll('ul,ol')) nested.remove()
    const block = inlineBlock(holder)
    block.bullet = { listType, listId, nestingLevel }
    target.push(block)
    for (const nested of child.children) {
      if (nested instanceof HTMLElement && (nested.tagName === 'UL' || nested.tagName === 'OL')) {
        const nestedListType = nested.tagName === 'OL' ? PresetListType.ORDER_LIST : PresetListType.BULLET_LIST
        parseList(nested, nestedListType, target, nestingLevel + 1, listId)
      }
    }
  }
}

function parseTable(element: HTMLTableElement): ParsedBlock {
  const block = emptyBlock()
  const rows = Array.from(element.rows)
  const grid = buildTableGrid(rows)
  const columnCount = Math.max(1, ...grid.map((row) => row.length))
  const source = createTableSource(columnCount)
  const paragraphs: IParagraph[] = []
  const sectionBreaks: NonNullable<IDocumentBody['sectionBreaks']> = []

  block.text = DataStreamTreeTokenType.TABLE_START
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    const parsedRow = grid[rowIndex]!
    const row = createTableRow()
    const rowElement = rows[rowIndex]
    if (rowElement && Array.from(rowElement.cells).some((cell) => cell.tagName === 'TH')) {
      row.isFirstRow = BooleanNumber.TRUE
      row.repeatHeaderRow = BooleanNumber.TRUE
    }
    source.tableRows.push(row)
    block.text += DataStreamTreeTokenType.TABLE_ROW_START

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const parsedCell = parsedRow[columnIndex] ?? emptyParsedTableCell()
      row.tableCells.push(createTableCell(parsedCell))
      block.text += DataStreamTreeTokenType.TABLE_CELL_START

      const contentBlocks = parsedCell.element
        ? parseBlocks(parsedCell.element).map((content) => content.table ? textBlock(parsedCell.element?.textContent ?? '') : content)
        : []
      if (contentBlocks.length === 0) contentBlocks.push(emptyBlock())
      for (const content of contentBlocks) appendTableCellParagraph(block, content, paragraphs)

      sectionBreaks.push({ startIndex: block.text.length })
      block.text += `${DataStreamTreeTokenType.SECTION_BREAK}${DataStreamTreeTokenType.TABLE_CELL_END}`
    }
    block.text += DataStreamTreeTokenType.TABLE_ROW_END
  }
  block.text += DataStreamTreeTokenType.TABLE_END
  block.table = { paragraphs, sectionBreaks, source }
  return block
}

function buildTableGrid(rows: HTMLTableRowElement[]): ParsedTableCell[][] {
  const grid = rows.map(() => [] as ParsedTableCell[])
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    let columnIndex = 0
    for (const cell of Array.from(rows[rowIndex]!.cells)) {
      while (grid[rowIndex]![columnIndex]) columnIndex += 1
      const rowSpan = Math.max(1, Math.min(cell.rowSpan || 1, rows.length - rowIndex))
      const columnSpan = Math.max(1, Math.min(cell.colSpan || 1, 50))
      grid[rowIndex]![columnIndex] = { columnSpan, covered: false, element: cell, rowSpan }
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
          if (rowOffset === 0 && columnOffset === 0) continue
          grid[rowIndex + rowOffset]![columnIndex + columnOffset] = {
            columnSpan: 0,
            covered: true,
            element: null,
            rowSpan: 0,
          }
        }
      }
      columnIndex += columnSpan
    }
  }
  return grid
}

function appendTableCellParagraph(target: ParsedBlock, content: ParsedBlock, paragraphs: IParagraph[]): void {
  const offset = target.text.length
  target.text += `${content.text}${DataStreamTreeTokenType.PARAGRAPH}`
  paragraphs.push({
    startIndex: target.text.length - 1,
    ...(content.paragraphStyle ? { paragraphStyle: content.paragraphStyle } : {}),
    ...(content.bullet ? { bullet: content.bullet } : {}),
  })
  target.textRuns.push(...content.textRuns.map((run) => ({ ...run, start: offset + run.start, end: offset + run.end })))
  target.customRanges.push(...content.customRanges.map((range) => ({ ...range, startIndex: offset + range.startIndex, endIndex: offset + range.endIndex })))
  target.customBlocks.push(...content.customBlocks.map((customBlock) => ({ ...customBlock, startIndex: offset + customBlock.startIndex })))
  appendBlockDrawings(content, target.drawings, [])
}

function createTableSource(columnCount: number): ITable {
  return {
    tableRows: [],
    tableColumns: Array.from({ length: columnCount }, () => ({
      size: { type: TableSizeType.SPECIFIED, width: { v: DEFAULT_TABLE_WIDTH / columnCount } },
    })),
    tableId: `table-${Math.random().toString(36).slice(2)}`,
    align: TableAlignmentType.START,
    indent: { v: 0 },
    textWrap: TableTextWrapType.NONE,
    position: {
      positionH: { relativeFrom: ObjectRelativeFromH.PAGE, posOffset: 0 },
      positionV: { relativeFrom: ObjectRelativeFromV.PAGE, posOffset: 0 },
    },
    dist: { distB: 0, distL: 0, distR: 0, distT: 0 },
    cellMargin: { start: { v: 10 }, end: { v: 10 }, top: { v: 5 }, bottom: { v: 5 } },
    size: { type: TableSizeType.UNSPECIFIED, width: { v: DEFAULT_TABLE_WIDTH } },
  }
}

function createTableRow(): ITableRow {
  return {
    tableCells: [],
    trHeight: { val: { v: 30 }, hRule: TableRowHeightRule.AUTO },
  }
}

function createTableCell(cell: ParsedTableCell): ITableCell {
  const result: ITableCell = {
    margin: { start: { v: 10 }, end: { v: 10 }, top: { v: 5 }, bottom: { v: 5 } },
  }
  if (cell.covered) return { ...result, rowSpan: 0, columnSpan: 0 }
  if (cell.rowSpan > 1) result.rowSpan = cell.rowSpan
  if (cell.columnSpan > 1) result.columnSpan = cell.columnSpan
  const backgroundColor = cell.element?.style.backgroundColor
  if (backgroundColor) result.backgroundColor = { rgb: backgroundColor }
  return result
}

function emptyParsedTableCell(): ParsedTableCell {
  return { columnSpan: 1, covered: false, element: null, rowSpan: 1 }
}

function blockParagraphsAtOffset(block: ParsedBlock, offset: number): IParagraph[] {
  return (block.table?.paragraphs ?? []).map((paragraph) => ({ ...paragraph, startIndex: offset + paragraph.startIndex }))
}

function appendBlockDrawings(block: ParsedBlock, target: NonNullable<IDocumentData['drawings']>, order: string[]): void {
  for (const [drawingId, drawing] of Object.entries(block.drawings)) {
    target[drawingId] = drawing
    order.push(drawingId)
  }
}

function inlineBlock(element: HTMLElement, paragraphStyle?: IParagraph['paragraphStyle']): ParsedBlock {
  const block = emptyBlock()
  block.paragraphStyle = paragraphStyle

  const visit = (node: Node, inherited: ITextStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? ''
      const start = block.text.length
      block.text += value
      if (value && Object.keys(inherited).length > 0) block.textRuns.push({ start, end: block.text.length, style: inherited })
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === 'BR') {
      block.text += '\r'
      return
    }
    if (node.tagName === 'IMG') {
      const source = node.getAttribute('src') ?? ''
      if (source) {
        const drawingId = `drawing-${block.customBlocks.length + 1}-${Math.random().toString(36).slice(2)}`
        const startIndex = block.text.length
        block.text += '\b'
        block.customBlocks.push({ startIndex, blockId: drawingId })
        block.drawings[drawingId] = imageDrawing(drawingId, source, node.getAttribute('alt') ?? '', node.getAttribute('title') ?? '')
      }
      return
    }
    const style = styleForElement(node, inherited)
    const reference = referenceForElement(node)
    const startIndex = block.text.length
    for (const child of node.childNodes) visit(child, style)
    if (reference && block.text.length > startIndex) {
      block.customRanges.push({
        startIndex,
        endIndex: block.text.length - 1,
        rangeId: reference.id,
        rangeType: CustomRangeType.CUSTOM,
        wholeEntity: true,
        properties: reference,
      })
    }
  }

  for (const child of element.childNodes) visit(child, {})
  if (!block.text) block.text = ''
  return block
}

function paragraphStyleForElement(element: HTMLElement): IParagraph['paragraphStyle'] | undefined {
  const tag = element.tagName.toLowerCase()
  let namedStyleType: NamedStyleType | undefined
  if (tag === 'h1') namedStyleType = NamedStyleType.HEADING_1
  if (tag === 'h2') namedStyleType = NamedStyleType.HEADING_2
  if (tag === 'h3') namedStyleType = NamedStyleType.HEADING_3
  if (tag === 'h4') namedStyleType = NamedStyleType.HEADING_4
  if (tag === 'h5') namedStyleType = NamedStyleType.HEADING_5
  const style: NonNullable<IParagraph['paragraphStyle']> = {}
  if (namedStyleType) style.namedStyleType = namedStyleType
  if (tag === 'blockquote') style.indentStart = { v: 24 }
  const align = element.style.textAlign
  if (align === 'center') style.horizontalAlign = HorizontalAlign.CENTER
  if (align === 'right') style.horizontalAlign = HorizontalAlign.RIGHT
  if (align === 'justify') style.horizontalAlign = HorizontalAlign.JUSTIFIED
  return Object.keys(style).length > 0 ? style : undefined
}

function styleForElement(element: HTMLElement, inherited: ITextStyle): ITextStyle {
  const style: ITextStyle = { ...inherited }
  const tag = element.tagName.toLowerCase()
  if (tag === 'strong' || tag === 'b') style.bl = BooleanNumber.TRUE
  if (tag === 'em' || tag === 'i') style.it = BooleanNumber.TRUE
  if (tag === 'u') style.ul = { s: BooleanNumber.TRUE }
  if (tag === 's') style.st = { s: BooleanNumber.TRUE }
  if (tag === 'sub') style.va = BaselineOffset.SUBSCRIPT
  if (tag === 'sup') style.va = BaselineOffset.SUPERSCRIPT
  if (tag === 'code' || tag === 'pre') style.ff = 'monospace'
  if (element.style.fontFamily) style.ff = element.style.fontFamily
  const fontSize = Number.parseFloat(element.style.fontSize)
  if (Number.isFinite(fontSize)) style.fs = fontSize
  if (element.style.color) style.cl = { rgb: element.style.color }
  if (element.style.backgroundColor) style.bg = { rgb: element.style.backgroundColor }
  return style
}

function referenceForElement(element: HTMLElement): ({ bridgicKind: 'citation' | 'footnote'; id: string; text: string; number?: number }) | null {
  const footnoteId = element.dataset.wordFootnoteId
  if (footnoteId) {
    return {
      bridgicKind: 'footnote',
      id: footnoteId,
      number: positiveInteger(Number(element.dataset.wordFootnoteNumber), 1),
      text: element.dataset.wordFootnoteText ?? element.textContent ?? '',
    }
  }
  const citationId = element.dataset.wordCitationId
  if (citationId) {
    return {
      bridgicKind: 'citation',
      id: citationId,
      text: element.dataset.wordCitationText ?? element.textContent ?? '',
    }
  }
  return null
}

function imageDrawing(drawingId: string, source: string, alt: string, title: string): NonNullable<IDocumentData['drawings']>[string] {
  return {
    unitId: '',
    subUnitId: '',
    drawingId,
    drawingType: DrawingTypeEnum.DRAWING_IMAGE,
    imageSourceType: source.startsWith('data:') ? ImageSourceType.BASE64 : ImageSourceType.URL,
    source,
    transform: { left: 0, top: 0, width: 320, height: 200 },
    docTransform: {
      size: { width: 320, height: 200 },
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
  } as NonNullable<IDocumentData['drawings']>[string]
}

function normalizeBody(body: IDocumentBody | undefined): IDocumentBody {
  if (!body || typeof body.dataStream !== 'string') return textBody('')
  let dataStream = body.dataStream
  if (!dataStream.endsWith('\n')) dataStream = `${dataStream.replace(/\0$/, '')}\n`
  if (!dataStream.includes('\r')) dataStream = `\r${dataStream}`
  return {
    ...clone(body),
    dataStream,
    textRuns: clone(body.textRuns ?? []),
    paragraphs: clone(body.paragraphs?.length ? body.paragraphs : [{ startIndex: Math.max(0, dataStream.indexOf('\r')) }]),
    sectionBreaks: clone(body.sectionBreaks?.length ? body.sectionBreaks : [{ startIndex: dataStream.length - 1 }]),
    customBlocks: clone(body.customBlocks ?? []),
    customRanges: clone(body.customRanges ?? []),
    tables: clone(body.tables ?? []),
  }
}

function textBody(text: string): IDocumentBody {
  const content = text.replace(/\r?\n/g, '\r')
  const dataStream = `${content}\r\n`
  return {
    dataStream,
    textRuns: [],
    paragraphs: [{ startIndex: content.length }],
    sectionBreaks: [{ startIndex: dataStream.length - 1 }],
    customBlocks: [],
    customRanges: [],
    tables: [],
  }
}

function textBlock(text: string): ParsedBlock {
  return { ...emptyBlock(), text }
}

function emptyBlock(): ParsedBlock {
  return { text: '', textRuns: [], customRanges: [], drawings: {}, customBlocks: [] }
}

function namedStyleForBlock(block: WordAppendBlock): IParagraph['paragraphStyle'] | undefined {
  if (block === 'heading1') return { namedStyleType: NamedStyleType.HEADING_1 }
  if (block === 'heading2') return { namedStyleType: NamedStyleType.HEADING_2 }
  if (block === 'quote') return { indentStart: { v: 24 } }
  return undefined
}

function headingLevel(value: NamedStyleType | undefined): number {
  if (value === NamedStyleType.HEADING_1) return 1
  if (value === NamedStyleType.HEADING_2) return 2
  if (value === NamedStyleType.HEADING_3) return 3
  if (value === NamedStyleType.HEADING_4) return 4
  if (value === NamedStyleType.HEADING_5) return 5
  return 0
}

function htmlToPlainText(value: string): string {
  const template = document.createElement('template')
  template.innerHTML = value
  return (template.content.textContent ?? '').trim()
}

function isBlockTag(tag: string): boolean {
  return ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'blockquote', 'pre', 'figcaption', 'nav'].includes(tag)
}

function shiftIndexes<T extends { startIndex: number }>(items: T[], start: number, delta: number): T[] {
  return items.map((item) => ({ ...item, startIndex: item.startIndex >= start ? item.startIndex + delta : item.startIndex }))
}

function shiftRanges<T extends { ed?: number; endIndex?: number; st?: number; startIndex?: number }>(items: T[], start: number, delta: number): T[] {
  return items.map((item) => {
    const startKey = 'st' in item ? 'st' : 'startIndex'
    const endKey = 'ed' in item ? 'ed' : 'endIndex'
    const itemStart = Number(item[startKey as keyof T])
    const itemEnd = Number(item[endKey as keyof T])
    return {
      ...item,
      [startKey]: itemStart >= start ? itemStart + delta : itemStart,
      [endKey]: itemEnd >= start ? itemEnd + delta : itemEnd,
    }
  })
}

function shiftTextRuns(items: ITextRun[], start: number, delta: number): ITextRun[] {
  return items.map((item) => ({
    ...item,
    st: item.st >= start ? item.st + delta : item.st,
    ed: item.ed > start ? item.ed + delta : item.ed,
  }))
}

function shiftRangeAfterDelete<T extends { ed?: number; endIndex?: number; st?: number; startIndex?: number }>(item: T, start: number, length: number): T {
  const startKey = 'st' in item ? 'st' : 'startIndex'
  const endKey = 'ed' in item ? 'ed' : 'endIndex'
  const itemStart = Number(item[startKey as keyof T])
  const itemEnd = Number(item[endKey as keyof T])
  return {
    ...item,
    [startKey]: itemStart > start ? Math.max(start, itemStart - length) : itemStart,
    [endKey]: itemEnd >= start ? Math.max(start - 1, itemEnd - length) : itemEnd,
  }
}

function shiftIndexesAfterDelete<T extends { startIndex: number }>(items: T[], start: number, length: number): T[] {
  return items.map((item) => ({ ...item, startIndex: item.startIndex > start ? Math.max(start, item.startIndex - length) : item.startIndex }))
}

function shiftIndexesAfterReplace<T extends { startIndex: number }>(items: T[], end: number, delta: number): T[] {
  return delta === 0 ? items : items.map((item) => ({ ...item, startIndex: item.startIndex >= end ? item.startIndex + delta : item.startIndex }))
}

function shiftTextRunAfterReplace(run: ITextRun, start: number, end: number, replacementLength: number, delta: number): ITextRun {
  if (run.ed <= start) return run
  if (run.st >= end) return { ...run, st: run.st + delta, ed: run.ed + delta }
  return {
    ...run,
    st: Math.min(run.st, start),
    ed: run.ed <= end ? start + replacementLength : run.ed + delta,
  }
}

function shiftInclusiveRangeAfterReplace<T extends { startIndex: number; endIndex: number }>(range: T, start: number, end: number, delta: number): T {
  if (range.endIndex < start) return range
  if (range.startIndex >= end) return { ...range, startIndex: range.startIndex + delta, endIndex: range.endIndex + delta }
  return { ...range, endIndex: range.endIndex + delta }
}

function shiftContainerRangeAfterReplace<T extends { startIndex: number; endIndex: number }>(range: T, start: number, end: number, delta: number): T {
  if (range.endIndex <= start) return range
  if (range.startIndex >= end) return { ...range, startIndex: range.startIndex + delta, endIndex: range.endIndex + delta }
  return { ...range, endIndex: range.endIndex + delta }
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
