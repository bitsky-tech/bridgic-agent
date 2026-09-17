import mammoth from 'mammoth'
import JSZip from 'jszip'
import type { WordDocumentState } from './wordDomain'
import { readOfficeRoundTrip } from './office/officeRoundTrip'

export type WordFileDocument = Pick<WordDocumentState, 'snapshot' | 'page' | 'headerFooter' | 'footnotes' | 'citations'>

export interface ImportedDocx {
  html: string
  warnings: string[]
  document?: WordFileDocument
  sourceProtected?: boolean
}

/** Convert DOCX OOXML bytes into sanitized-at-dispatch semantic HTML for Univer. */
export async function importDocxToHtml(bytes: Uint8Array): Promise<ImportedDocx> {
  if (bytes.byteLength === 0) throw new Error('The Word document is empty')
  const ownedBytes = new Uint8Array(bytes.byteLength)
  ownedBytes.set(bytes)
  const input = typeof Buffer === 'undefined'
    ? { arrayBuffer: ownedBytes.buffer }
    : { buffer: Buffer.from(ownedBytes) }
  const result = await mammoth.convertToHtml(input)
  const stored = await readOfficeRoundTrip(await JSZip.loadAsync(ownedBytes), 'word') as Partial<WordFileDocument> | null
  const document = stored?.snapshot?.body && typeof stored.snapshot.body.dataStream === 'string'
    && stored.page && stored.headerFooter && Array.isArray(stored.footnotes) && Array.isArray(stored.citations)
    ? stored as WordFileDocument : undefined
  return {
    html: result.value.trim() || '<p><br></p>',
    warnings: result.messages.map((message) => message.message),
    document,
    sourceProtected: !document,
  }
}
