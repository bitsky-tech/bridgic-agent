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

/**
 * The slice of Univer's `FRange` this bridge uses.
 *
 * `getValues` is typed as `unknown` and narrowed at runtime because a cell can
 * also hold rich text, which must not reach the JSON boundary. Writes go
 * through Univer's cell-data form (`{ v }`) rather than bare values so that a
 * `null` clears the cell instead of being rejected.
 */
interface FacadeRange {
  clear(): unknown
  getValues(): unknown[][]
  setFormula(formula: string): unknown
  setValues(values: { v: CellValue }[][]): unknown
}

interface FacadeWorksheet {
  getRange(a1: string): FacadeRange
  getSheetId(): string
  getSheetName(): string
}

interface FacadeWorkbook {
  getActiveSheet(): FacadeWorksheet
  getName(): string
  getSheets(): FacadeWorksheet[]
  getSnapshot(): unknown
  redo(): unknown
  undo(): unknown
}

export interface FacadeApi {
  getActiveWorkbook(): FacadeWorkbook | null
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
    if (!Array.isArray(values) || values.length === 0) {
      throw new SheetBridgeError('values must be a non-empty array of rows')
    }
    if (values.some((row) => !Array.isArray(row))) {
      throw new SheetBridgeError('values must be an array of rows, each an array of cells')
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

  private mutate<T>(
    a1: string,
    sheetName: string | undefined,
    apply: (range: FacadeRange) => T,
  ): T {
    if (this.humanEditing) throw new SheetBridgeError(HUMAN_EDITING_MESSAGE)
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

  private record(source: ChangeSource, a1: string): void {
    this.revision += 1
    this.changes.push({ a1, at: this.now(), source })
    if (this.changes.length > CHANGE_LOG_LIMIT) this.changes.shift()
  }

  private workbook(): FacadeWorkbook {
    const workbook = this.facade.getActiveWorkbook()
    if (!workbook) throw new SheetBridgeError('the workbook is not ready yet')
    return workbook
  }

  private range(a1: string, sheetName?: string): FacadeRange {
    if (!a1) throw new SheetBridgeError('a1 is required, for example "A1" or "A1:C3"')
    const workbook = this.workbook()
    const sheet = sheetName === undefined
      ? workbook.getActiveSheet()
      : workbook.getSheets().find((candidate) => candidate.getSheetName() === sheetName)
    if (!sheet) throw new SheetBridgeError(`no sheet named "${sheetName}"`)
    const range = sheet.getRange(a1)
    if (!range) throw new SheetBridgeError(`"${a1}" is not a valid A1 range`)
    return range
  }
}
