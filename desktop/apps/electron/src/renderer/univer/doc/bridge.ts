/**
 * The agent-facing control surface of the embedded Univer document.
 *
 * It mirrors the spreadsheet bridge's contract — JSON in, JSON out, reached
 * through the embedded browser — but the document facade is much thinner than
 * the spreadsheet one, and this file is deliberately honest about that rather
 * than papering over it:
 *
 * - Univer's `insertText` writes at the *current selection*, which is the
 *   person's own caret. Every write here therefore sets the selection
 *   explicitly first; the agent must say where it is writing.
 * - There is no document equivalent of the spreadsheet's cell-editor events, so
 *   there is no edit lock and no attributed change log. `status()` reports the
 *   character count instead, which is what lets an agent notice that a person
 *   has been typing.
 */

export interface DocBridgeStatus {
  /** Length of the underlying data stream; also the end-of-document offset. */
  characters: number
  name: string
  ready: boolean
  /** Counts this bridge's own writes; it does not see a person's edits. */
  revision: number
}

export interface DocText {
  characters: number
  text: string
}

export interface DocWriteResult {
  characters: number
  offset: number
}

interface FacadeDocument {
  appendText(text: string): Promise<boolean>
  getName(): string
  getSnapshot(): { body?: { dataStream?: string } }
  insertText(text: string): Promise<boolean>
  redo(): Promise<boolean>
  setSelection(startOffset: number, endOffset: number): void
  undo(): Promise<boolean>
}

export interface DocFacadeApi {
  getActiveDocument(): FacadeDocument | null
}

/** Raised when the agent asks for work the page cannot do right now. */
export class DocBridgeError extends Error {}

/**
 * Render the data stream as text without changing any offset.
 *
 * This is the reason the substitution is one character for one character:
 * offsets the agent computes from `read()` are the same offsets `insert` and
 * `replace` take, so it can act on what it read. Univer separates paragraphs
 * with `\r` and sections with `\v`; anything else in the C0 range is a marker
 * for content this bridge does not expose (custom blocks and ranges) and
 * becomes a space so it still occupies its one position.
 */
export function renderDataStream(dataStream: string): string {
  let text = ''
  for (const character of dataStream) {
    if (character === '\r' || character === '\v' || character === '\n') {
      text += '\n'
    } else if (character === '\t' || character >= ' ') {
      text += character
    } else {
      text += ' '
    }
  }
  return text
}

export class DocBridge {
  /** Names the open workbench so a mismatched tool call can say which one it is. */
  readonly kind = 'document'

  private revision = 0

  constructor(private readonly facade: DocFacadeApi) {}

  status(): DocBridgeStatus {
    const document = this.facade.getActiveDocument()
    if (!document) {
      return { characters: 0, name: '', ready: false, revision: this.revision }
    }
    return {
      characters: this.dataStream(document).length,
      name: document.getName(),
      ready: true,
      revision: this.revision,
    }
  }

  read(): DocText {
    const dataStream = this.dataStream(this.document())
    return { characters: dataStream.length, text: renderDataStream(dataStream) }
  }

  /** Append at the end of the document, the one write that cannot disturb a caret. */
  async append(text: string): Promise<DocWriteResult> {
    const document = this.document()
    const offset = this.dataStream(document).length
    await document.appendText(this.requireText(text))
    this.revision += 1
    return { characters: this.dataStream(document).length, offset }
  }

  /** Insert at an explicit offset; this moves the person's caret there. */
  async insert(text: string, offset: number): Promise<DocWriteResult> {
    return this.write(text, offset, offset)
  }

  /** Replace the text between two offsets, which may be a person's paragraph. */
  async replace(startOffset: number, endOffset: number, text: string): Promise<DocWriteResult> {
    if (endOffset < startOffset) {
      throw new DocBridgeError('endOffset must not be before startOffset')
    }
    return this.write(text, startOffset, endOffset)
  }

  snapshot(): unknown {
    return this.document().getSnapshot()
  }

  async undo(): Promise<void> {
    await this.document().undo()
  }

  async redo(): Promise<void> {
    await this.document().redo()
  }

  private async write(text: string, start: number, end: number): Promise<DocWriteResult> {
    const document = this.document()
    const body = this.requireText(text)
    const limit = this.dataStream(document).length
    if (!Number.isInteger(start) || start < 0 || start > limit) {
      throw new DocBridgeError(`offset must be an integer between 0 and ${limit}`)
    }
    if (end > limit) throw new DocBridgeError(`endOffset must not exceed ${limit}`)
    document.setSelection(start, end)
    await document.insertText(body)
    this.revision += 1
    return { characters: this.dataStream(document).length, offset: start }
  }

  private requireText(text: string): string {
    if (typeof text !== 'string' || text.length === 0) {
      throw new DocBridgeError('text must be a non-empty string')
    }
    return text
  }

  private document(): FacadeDocument {
    const document = this.facade.getActiveDocument()
    if (!document) throw new DocBridgeError('the document is not ready yet')
    return document
  }

  private dataStream(document: FacadeDocument): string {
    return document.getSnapshot().body?.dataStream ?? ''
  }
}
