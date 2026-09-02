/**
 * The agent-facing control surface of the embedded Univer workbook.
 *
 * The page installs one instance on `window.__univerBridge`; the Python agent
 * reaches it through the embedded browser's `evaluate_javascript`, exactly the
 * way it already drives any other page. Everything here therefore has to be
 * JSON-serializable in and out — no facade objects cross the boundary.
 *
 * The bridge is deliberately Univer-agnostic beyond a narrow structural view of
 * the facade (`FacadeApi` below, which the real `FUniver` satisfies). Event
 * wiring lives in `main.ts` where the real Univer types are available; the
 * bridge only receives the resulting notifications.
 */

/** A value a spreadsheet cell can carry once it has crossed the JSON boundary. */
export type CellValue = string | number | boolean | null

export type ChangeSource = 'agent' | 'human'

export interface SheetChange {
  a1: string
  at: number
  source: ChangeSource
}

export interface SheetSummary {
  id: string
  name: string
}

export interface SheetBridgeStatus {
  activeSheetId: string
  activeSheetName: string
  /** True while a person has a cell editor open; agent writes are refused. */
  humanEditing: boolean
  ready: boolean
  /** Monotonic counter over every recorded change; cheap change detection. */
  revision: number
  sheets: SheetSummary[]
  workbookName: string
}

export interface RangeValues {
  a1: string
  values: CellValue[][]
}

export interface WriteResult {
  a1: string
  columns: number
  rows: number
}

/** Everything `format` can set in one pass; an omitted key is left alone. */
export interface CellFormat {
  background?: string
  bold?: boolean
  fontColor?: string
  fontSize?: number
  horizontalAlign?: HorizontalAlign
  italic?: boolean
  numberFormat?: string
  verticalAlign?: VerticalAlign
  wrap?: boolean
}

export type HorizontalAlign = 'left' | 'center' | 'normal'
export type VerticalAlign = 'top' | 'middle' | 'bottom'
export type MergeMode = 'all' | 'across' | 'vertically' | 'break'
export type LineAxis = 'rows' | 'columns'
/** Univer's border types are a string enum, so the names travel as-is. */
export const BORDER_TYPES = [
  'all', 'bottom', 'horizontal', 'inside', 'left', 'none',
  'outside', 'right', 'top', 'vertical',
] as const
export type BorderType = (typeof BORDER_TYPES)[number]

export interface RangeSummary {
  a1: string
  columns: number
  rows: number
}

export interface SelectionSummary {
  /** The person's primary range, or null when nothing is selected. */
  active: string | null
  ranges: string[]
}

export interface DataValidationSpec {
  max?: number
  min?: number
  type: 'list' | 'numberBetween' | 'checkbox'
  values?: string[]
}

export interface ConditionalFormatSpec {
  background?: string
  bold?: boolean
  fontColor?: string
  max?: number
  min?: number
  text?: string
  value?: number
  when: 'greaterThan' | 'lessThan' | 'between' | 'textContains' | 'duplicates'
}

/** Border style names mapped to Univer's numeric enum, supplied by the page. */
export type BorderStyles = Readonly<Record<string, number>>

/**
 * The slice of Univer's `FRange` this bridge uses.
 *
 * `getValues` is typed as `unknown` and narrowed at runtime because a cell can
 * also hold rich text, which must not reach the JSON boundary. Writes go
 * through Univer's cell-data form (`{ v }`) rather than bare values so that a
 * `null` clears the cell instead of being rejected.
 */
interface FacadeRange {
  breakApart(): unknown
  clear(): unknown
  getA1Notation(): string
  getValues(): unknown[][]
  merge(): unknown
  mergeAcross(): unknown
  mergeVertically(): unknown
  setBackground(color: string): unknown
  // Univer types this as a string enum, whose members a plain string literal
  // cannot satisfy, so the name is validated here instead of by the compiler.
  setBorder(type: string, style: number, color?: string): unknown
  setFontColor(color: string | null): unknown
  setFontSize(size: number | null): unknown
  setFontStyle(style: 'normal' | 'italic' | null): unknown
  setFontWeight(weight: 'normal' | 'bold' | null): unknown
  setFormula(formula: string): unknown
  setHorizontalAlignment(alignment: HorizontalAlign): unknown
  setNumberFormat(pattern: string): unknown
  setValues(values: { v: CellValue }[][]): unknown
  setVerticalAlignment(alignment: VerticalAlign): unknown
  setWrap(wrap: boolean): unknown

  // Contributed by the feature presets. Each is present only because its
  // preset is registered in `main.ts`; none of them is a Pro package.
  addCommentAsync(content: unknown): Promise<boolean>
  createFilter(): FacadeFilter | null
  getRange(): unknown
  setDataValidation(rule: unknown): unknown
  setHyperLink(url: string, label?: string): Promise<boolean>
  sort(column: { ascending: boolean; column: number }): unknown
}

interface FacadeFilter {
  remove(): boolean
}

interface FacadeValidationBuilder {
  build(): unknown
  requireCheckbox(): FacadeValidationBuilder
  requireNumberBetween(start: number, end: number): FacadeValidationBuilder
  requireValueInList(values: string[]): FacadeValidationBuilder
}

/**
 * Univer's conditional-format builder is two-staged: the entry builder only
 * chooses the condition, and choosing one hands back the builder that can
 * carry the styling and the ranges.
 */
interface FacadeConditionStart {
  setDuplicateValues(): FacadeConditionHighlight
  whenNumberBetween(start: number, end: number): FacadeConditionHighlight
  whenNumberGreaterThan(value: number): FacadeConditionHighlight
  whenNumberLessThan(value: number): FacadeConditionHighlight
  whenTextContains(text: string): FacadeConditionHighlight
}

interface FacadeConditionHighlight {
  build(): unknown
  setBackground(color?: string): FacadeConditionHighlight
  setBold(isBold: boolean): FacadeConditionHighlight
  setFontColor(color?: string): FacadeConditionHighlight
  setRanges(ranges: unknown[]): FacadeConditionHighlight
}

interface FacadeTextFinder {
  findAll(): unknown[]
  matchCaseAsync(matchCase: boolean): Promise<unknown>
  replaceAllWithAsync(replaceText: string): Promise<number>
}

interface FacadeSelection {
  getActiveRange(): FacadeRange | null
  getActiveRangeList(): FacadeRange[]
}

interface FacadeWorksheet {
  cancelFreeze(): unknown
  deleteColumns(position: number, howMany: number): unknown
  deleteRows(position: number, howMany: number): unknown
  getDataRange(): FacadeRange
  getMaxColumns(): number
  getMaxRows(): number
  getRange(a1: string): FacadeRange
  getSelection(): FacadeSelection | null
  getSheetId(): string
  getSheetName(): string
  addConditionalFormattingRule(rule: unknown): unknown
  getFilter(): FacadeFilter | null
  insertColumns(index: number, count?: number): unknown
  insertRows(index: number, count?: number): unknown
  newConditionalFormattingRule(): FacadeConditionStart
  setColumnWidths(start: number, count: number, width: number): unknown
  setFrozenColumns(columns: number): unknown
  setFrozenRows(rows: number): unknown
  setName(name: string): unknown
  setRowHeights(start: number, count: number, height: number): unknown
}

interface FacadeWorkbook {
  /** Univer identifies a sheet here by id, not by name. */
  deleteSheet(sheetId: string): unknown
  getActiveSheet(): FacadeWorksheet
  getName(): string
  getSheets(): FacadeWorksheet[]
  getSnapshot(): unknown
  insertSheet(name?: string): FacadeWorksheet
  redo(): unknown
  setActiveSheet(sheetId: string): unknown
  undo(): unknown
}

export interface FacadeApi {
  createTextFinderAsync(text: string): Promise<FacadeTextFinder | null>
  getActiveWorkbook(): FacadeWorkbook | null
  newDataValidation(): FacadeValidationBuilder
  newTheadComment(): { setContent(content: unknown): { build(): unknown } }
}

const CHANGE_LOG_LIMIT = 200
const DEFAULT_RECENT_CHANGES = 20

/** Keep rich text and any other cell payload out of the agent's JSON view. */
function toCellValue(cell: unknown): CellValue {
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    return cell
  }
  return null
}

/** Raised when the agent asks for work the page cannot do right now. */
export class SheetBridgeError extends Error {}

/**
 * A person typing in a cell owns that edit until they commit it. Writing
 * underneath them would either be discarded by the open editor or silently
 * overwrite what they are typing, so the bridge refuses instead and lets the
 * agent decide whether to wait or to report back.
 */
const HUMAN_EDITING_MESSAGE
  = 'a person is editing a cell right now — retry once sheet_status reports humanEditing=false'

export class SheetBridge {
  /** Names the open workbench so a mismatched tool call can say which one it is. */
  readonly kind = 'spreadsheet'

  private readonly changes: SheetChange[] = []
  private humanEditing = false
  private revision = 0
  private writing = false

  constructor(
    private readonly facade: FacadeApi,
    /**
     * Border styles are Univer's one *numeric* enum on this surface, so the
     * page passes the real values in rather than this file hard-coding numbers
     * that upstream is free to renumber.
     */
    private readonly borderStyles: BorderStyles = {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  status(): SheetBridgeStatus {
    const workbook = this.facade.getActiveWorkbook()
    if (!workbook) {
      return {
        activeSheetId: '',
        activeSheetName: '',
        humanEditing: this.humanEditing,
        ready: false,
        revision: this.revision,
        sheets: [],
        workbookName: '',
      }
    }
    const active = workbook.getActiveSheet()
    return {
      activeSheetId: active.getSheetId(),
      activeSheetName: active.getSheetName(),
      humanEditing: this.humanEditing,
      ready: true,
      revision: this.revision,
      sheets: workbook.getSheets().map((sheet) => ({
        id: sheet.getSheetId(),
        name: sheet.getSheetName(),
      })),
      workbookName: workbook.getName(),
    }
  }

  readRange(a1: string, sheetName?: string): RangeValues {
    const range = this.range(a1, sheetName)
    return {
      a1,
      values: range.getValues().map((row) => row.map(toCellValue)),
    }
  }

  writeRange(a1: string, values: CellValue[][], sheetName?: string): WriteResult {
    // The tools check this before calling, so reaching here means something
    // bypassed them; say the shape anyway rather than only that it is wrong.
    if (!Array.isArray(values) || values.length === 0 || values.some((row) => !Array.isArray(row))) {
      throw new SheetBridgeError(
        'values must be a non-empty array of rows, for example [["Product", "Price"], ["Mouse", 89]]',
      )
    }
    return this.mutate(a1, sheetName, (range) => {
      range.setValues(values.map((row) => row.map((cell) => ({ v: cell }))))
      return {
        a1,
        columns: Math.max(...values.map((row) => row.length)),
        rows: values.length,
      }
    })
  }

  setFormula(a1: string, formula: string, sheetName?: string): WriteResult {
    if (!formula.startsWith('=')) {
      throw new SheetBridgeError('formula must start with "="')
    }
    return this.mutate(a1, sheetName, (range) => {
      range.setFormula(formula)
      return { a1, columns: 1, rows: 1 }
    })
  }

  clearRange(a1: string, sheetName?: string): WriteResult {
    return this.mutate(a1, sheetName, (range) => {
      range.clear()
      return { a1, columns: 0, rows: 0 }
    })
  }

  /** Apply any combination of styles to a range in one command. */
  format(a1: string, format: CellFormat, sheetName?: string): WriteResult {
    const keys = Object.keys(format ?? {})
    if (keys.length === 0) throw new SheetBridgeError('format needs at least one property')
    return this.mutate(a1, sheetName, (range) => {
      if (format.background !== undefined) range.setBackground(format.background)
      if (format.fontColor !== undefined) range.setFontColor(format.fontColor)
      if (format.fontSize !== undefined) range.setFontSize(format.fontSize)
      if (format.bold !== undefined) range.setFontWeight(format.bold ? 'bold' : 'normal')
      if (format.italic !== undefined) range.setFontStyle(format.italic ? 'italic' : 'normal')
      if (format.horizontalAlign !== undefined) {
        range.setHorizontalAlignment(format.horizontalAlign)
      }
      if (format.verticalAlign !== undefined) range.setVerticalAlignment(format.verticalAlign)
      if (format.wrap !== undefined) range.setWrap(format.wrap)
      if (format.numberFormat !== undefined) range.setNumberFormat(format.numberFormat)
      return { a1, columns: 0, rows: 0 }
    })
  }

  border(
    a1: string,
    type: BorderType,
    style: string,
    color?: string,
    sheetName?: string,
  ): WriteResult {
    if (!BORDER_TYPES.includes(type)) {
      throw new SheetBridgeError(
        `unknown border type "${type}"; use one of: ${BORDER_TYPES.join(', ')}`,
      )
    }
    const styleValue = this.borderStyles[style]
    if (styleValue === undefined) {
      const known = Object.keys(this.borderStyles).join(', ')
      throw new SheetBridgeError(`unknown border style "${style}"; use one of: ${known}`)
    }
    return this.mutate(a1, sheetName, (range) => {
      range.setBorder(type, styleValue, color)
      return { a1, columns: 0, rows: 0 }
    })
  }

  merge(a1: string, mode: MergeMode, sheetName?: string): WriteResult {
    return this.mutate(a1, sheetName, (range) => {
      if (mode === 'across') range.mergeAcross()
      else if (mode === 'vertically') range.mergeVertically()
      else if (mode === 'break') range.breakApart()
      else if (mode === 'all') range.merge()
      else throw new SheetBridgeError(`unknown merge mode "${mode}"`)
      return { a1, columns: 0, rows: 0 }
    })
  }

  insertLines(axis: LineAxis, index: number, count: number, sheetName?: string): string {
    const sheet = this.sheet(sheetName)
    this.guard()
    this.requireCount(count)
    this.requireIndex(axis, index, sheet, { allowEnd: true })
    if (axis === 'rows') sheet.insertRows(index, count)
    else sheet.insertColumns(index, count)
    return this.recordSheetChange(sheet, `insert ${count} ${axis} at ${index}`)
  }

  deleteLines(axis: LineAxis, index: number, count: number, sheetName?: string): string {
    const sheet = this.sheet(sheetName)
    this.guard()
    this.requireCount(count)
    this.requireIndex(axis, index, sheet, { allowEnd: false })
    if (axis === 'rows') sheet.deleteRows(index, count)
    else sheet.deleteColumns(index, count)
    return this.recordSheetChange(sheet, `delete ${count} ${axis} at ${index}`)
  }

  resizeLines(
    axis: LineAxis,
    index: number,
    count: number,
    pixels: number,
    sheetName?: string,
  ): string {
    const sheet = this.sheet(sheetName)
    this.guard()
    this.requireCount(count)
    this.requireIndex(axis, index, sheet, { allowEnd: false })
    if (!Number.isFinite(pixels) || pixels <= 0) {
      throw new SheetBridgeError('pixels must be a positive number')
    }
    if (axis === 'rows') sheet.setRowHeights(index, count, pixels)
    else sheet.setColumnWidths(index, count, pixels)
    return this.recordSheetChange(sheet, `resize ${count} ${axis} at ${index} to ${pixels}px`)
  }

  /** Freeze leading rows and columns, or release them when both are zero. */
  freeze(rows: number, columns: number, sheetName?: string): string {
    const sheet = this.sheet(sheetName)
    this.guard()
    if (!Number.isInteger(rows) || rows < 0 || !Number.isInteger(columns) || columns < 0) {
      throw new SheetBridgeError('rows and columns must be zero or more')
    }
    if (rows === 0 && columns === 0) sheet.cancelFreeze()
    else {
      sheet.setFrozenRows(rows)
      sheet.setFrozenColumns(columns)
    }
    return this.recordSheetChange(sheet, `freeze ${rows} rows and ${columns} columns`)
  }

  /** The rectangle that actually holds content — where a person's data ends. */
  dataRange(sheetName?: string): RangeSummary {
    const range = this.sheet(sheetName).getDataRange()
    const values = range.getValues()
    return {
      a1: range.getA1Notation(),
      columns: values.reduce((widest, row) => Math.max(widest, row.length), 0),
      rows: values.length,
    }
  }

  /** What the person currently has selected, so the agent can work where they are. */
  selection(sheetName?: string): SelectionSummary {
    const selection = this.sheet(sheetName).getSelection()
    if (!selection) return { active: null, ranges: [] }
    return {
      active: selection.getActiveRange()?.getA1Notation() ?? null,
      ranges: selection.getActiveRangeList().map((range) => range.getA1Notation()),
    }
  }

  addSheet(name: string): SheetSummary {
    this.guard()
    const sheet = this.workbook().insertSheet(this.requireName(name))
    this.record('agent', `add sheet ${sheet.getSheetName()}`)
    return { id: sheet.getSheetId(), name: sheet.getSheetName() }
  }

  renameSheet(name: string, newName: string): SheetSummary {
    const sheet = this.sheet(name)
    this.guard()
    sheet.setName(this.requireName(newName))
    this.record('agent', `rename sheet to ${sheet.getSheetName()}`)
    return { id: sheet.getSheetId(), name: sheet.getSheetName() }
  }

  removeSheet(name: string): string {
    const workbook = this.workbook()
    if (workbook.getSheets().length <= 1) {
      throw new SheetBridgeError('a workbook must keep at least one sheet')
    }
    const sheet = this.sheet(name)
    this.guard()
    workbook.deleteSheet(sheet.getSheetId())
    return this.record('agent', `remove sheet ${name}`)
  }

  activateSheet(name: string): SheetSummary {
    const sheet = this.sheet(name)
    this.workbook().setActiveSheet(sheet.getSheetId())
    return { id: sheet.getSheetId(), name: sheet.getSheetName() }
  }

  sortRange(a1: string, column: number, ascending = true, sheetName?: string): WriteResult {
    if (!Number.isInteger(column) || column < 0) {
      throw new SheetBridgeError('column must be a zero-based column index')
    }
    return this.mutate(a1, sheetName, (range) => {
      range.sort({ ascending, column })
      return { a1, columns: 0, rows: 0 }
    })
  }

  /** Put a filter on a range, so the person can narrow it by hand afterwards. */
  createFilter(a1: string, sheetName?: string): string {
    const sheet = this.sheet(sheetName)
    this.guard()
    if (sheet.getFilter()) throw new SheetBridgeError('this sheet already has a filter')
    if (!this.range(a1, sheetName).createFilter()) {
      throw new SheetBridgeError(`could not put a filter on ${a1}`)
    }
    return this.recordSheetChange(sheet, `filter ${a1}`)
  }

  removeFilter(sheetName?: string): string {
    const sheet = this.sheet(sheetName)
    this.guard()
    const filter = sheet.getFilter()
    if (!filter) throw new SheetBridgeError('this sheet has no filter')
    filter.remove()
    return this.recordSheetChange(sheet, 'remove filter')
  }

  async findReplace(
    find: string,
    replace: string | null,
    matchCase = false,
  ): Promise<{ matches: number; replaced: number }> {
    if (!find) throw new SheetBridgeError('find text is required')
    if (replace !== null) this.guard()
    const finder = await this.facade.createTextFinderAsync(find)
    if (!finder) return { matches: 0, replaced: 0 }
    if (matchCase) await finder.matchCaseAsync(true)
    const matches = finder.findAll().length
    if (replace === null) return { matches, replaced: 0 }
    const replaced = await finder.replaceAllWithAsync(replace)
    this.record('agent', `replace "${find}" with "${replace}"`)
    return { matches, replaced }
  }

  async setHyperlink(
    a1: string,
    url: string,
    label?: string,
    sheetName?: string,
  ): Promise<WriteResult> {
    if (!/^https?:\/\//.test(url)) {
      throw new SheetBridgeError('url must start with http:// or https://')
    }
    this.guard()
    const range = this.range(a1, sheetName)
    this.writing = true
    try {
      await range.setHyperLink(url, label)
      this.record('agent', a1)
      return { a1, columns: 1, rows: 1 }
    } finally {
      this.writing = false
    }
  }

  /**
   * Leave a comment on a cell.
   *
   * This is the workbook's own channel back to the person: an explanation of a
   * number lands beside the number, where they will actually see it, instead of
   * scrolling back through the conversation.
   */
  async addComment(a1: string, text: string, sheetName?: string): Promise<WriteResult> {
    if (!text.trim()) throw new SheetBridgeError('comment text is required')
    this.guard()
    const range = this.range(a1, sheetName)
    const comment = this.facade.newTheadComment()
      .setContent({ dataStream: `${text}\r\n` })
      .build()
    this.writing = true
    try {
      await range.addCommentAsync(comment)
      this.record('agent', `comment on ${a1}`)
      return { a1, columns: 1, rows: 1 }
    } finally {
      this.writing = false
    }
  }

  /** Constrain what a person may type into a range. */
  setDataValidation(a1: string, rule: DataValidationSpec, sheetName?: string): WriteResult {
    return this.mutate(a1, sheetName, (range) => {
      let builder = this.facade.newDataValidation()
      if (rule.type === 'list') {
        if (!rule.values?.length) throw new SheetBridgeError('a list rule needs values')
        builder = builder.requireValueInList(rule.values)
      } else if (rule.type === 'numberBetween') {
        if (rule.min === undefined || rule.max === undefined) {
          throw new SheetBridgeError('a numberBetween rule needs min and max')
        }
        builder = builder.requireNumberBetween(rule.min, rule.max)
      } else if (rule.type === 'checkbox') {
        builder = builder.requireCheckbox()
      } else {
        throw new SheetBridgeError(`unknown data validation type "${rule.type}"`)
      }
      range.setDataValidation(builder.build())
      return { a1, columns: 0, rows: 0 }
    })
  }

  /** Colour cells by what they contain, so a report stays readable as it changes. */
  addConditionalFormat(
    a1: string,
    rule: ConditionalFormatSpec,
    sheetName?: string,
  ): string {
    const sheet = this.sheet(sheetName)
    this.guard()
    const range = this.range(a1, sheetName)
    const start = sheet.newConditionalFormattingRule()
    let builder: FacadeConditionHighlight
    if (rule.when === 'greaterThan') builder = start.whenNumberGreaterThan(this.number(rule.value))
    else if (rule.when === 'lessThan') builder = start.whenNumberLessThan(this.number(rule.value))
    else if (rule.when === 'between') {
      builder = start.whenNumberBetween(this.number(rule.min), this.number(rule.max))
    } else if (rule.when === 'textContains') {
      if (!rule.text) throw new SheetBridgeError('a textContains rule needs text')
      builder = start.whenTextContains(rule.text)
    } else if (rule.when === 'duplicates') builder = start.setDuplicateValues()
    else throw new SheetBridgeError(`unknown condition "${rule.when}"`)

    if (rule.background !== undefined) builder = builder.setBackground(rule.background)
    if (rule.fontColor !== undefined) builder = builder.setFontColor(rule.fontColor)
    if (rule.bold !== undefined) builder = builder.setBold(rule.bold)
    sheet.addConditionalFormattingRule(builder.setRanges([range.getRange()]).build())
    return this.recordSheetChange(sheet, `conditional format ${a1}`)
  }

  recentChanges(limit = DEFAULT_RECENT_CHANGES): SheetChange[] {
    const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_RECENT_CHANGES
    return this.changes.slice(-size)
  }

  snapshot(): unknown {
    return this.workbook().getSnapshot()
  }

  undo(): void {
    this.workbook().undo()
  }

  redo(): void {
    this.workbook().redo()
  }

  /** Called by the page's `BeforeSheetEditStart` / `SheetEditEnded` listeners. */
  setHumanEditing(editing: boolean): void {
    this.humanEditing = editing
  }

  /**
   * Called by the page's `SheetValueChanged` listener.
   *
   * A change raised while the bridge is inside its own write is the agent's own
   * echo and is dropped: `mutate` has already logged it with the range the agent
   * actually asked for, which is more useful than the effected-range projection.
   */
  noteExternalChange(a1: string): void {
    if (this.writing) return
    this.record('human', a1)
  }

  /** Refuse any write while a person owns an open cell editor. */
  private guard(): void {
    if (this.humanEditing) throw new SheetBridgeError(HUMAN_EDITING_MESSAGE)
  }

  private number(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SheetBridgeError('this condition needs a number')
    }
    return value
  }

  private requireCount(count: number): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new SheetBridgeError('count must be a whole number of one or more')
    }
  }

  private requireIndex(
    axis: LineAxis,
    index: number,
    sheet: FacadeWorksheet,
    options: { allowEnd: boolean },
  ): void {
    const limit = axis === 'rows' ? sheet.getMaxRows() : sheet.getMaxColumns()
    const highest = options.allowEnd ? limit : limit - 1
    if (!Number.isInteger(index) || index < 0 || index > highest) {
      throw new SheetBridgeError(`index must be between 0 and ${highest} for ${axis}`)
    }
  }

  private requireName(name: string): string {
    const trimmed = (name ?? '').trim()
    if (!trimmed) throw new SheetBridgeError('a sheet name is required')
    return trimmed
  }

  private recordSheetChange(sheet: FacadeWorksheet, what: string): string {
    return this.record('agent', `${sheet.getSheetName()}: ${what}`)
  }

  private mutate<T>(
    a1: string,
    sheetName: string | undefined,
    apply: (range: FacadeRange) => T,
  ): T {
    this.guard()
    const range = this.range(a1, sheetName)
    this.writing = true
    try {
      const result = apply(range)
      this.record('agent', a1)
      return result
    } finally {
      this.writing = false
    }
  }

  private record(source: ChangeSource, a1: string): string {
    this.revision += 1
    this.changes.push({ a1, at: this.now(), source })
    if (this.changes.length > CHANGE_LOG_LIMIT) this.changes.shift()
    return a1
  }

  private workbook(): FacadeWorkbook {
    const workbook = this.facade.getActiveWorkbook()
    if (!workbook) throw new SheetBridgeError('the workbook is not ready yet')
    return workbook
  }

  private sheet(sheetName?: string): FacadeWorksheet {
    const workbook = this.workbook()
    if (sheetName === undefined) return workbook.getActiveSheet()
    const sheet = workbook.getSheets()
      .find((candidate) => candidate.getSheetName() === sheetName)
    if (!sheet) throw new SheetBridgeError(`no sheet named "${sheetName}"`)
    return sheet
  }

  private range(a1: string, sheetName?: string): FacadeRange {
    if (!a1) throw new SheetBridgeError('a1 is required, for example "A1" or "A1:C3"')
    const sheet = this.sheet(sheetName)
    const range = sheet.getRange(a1)
    if (!range) throw new SheetBridgeError(`"${a1}" is not a valid A1 range`)
    return range
  }
}
