import mammoth from 'mammoth'

export interface ImportedDocx {
  html: string
  warnings: string[]
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
  return {
    html: result.value.trim() || '<p><br></p>',
    warnings: result.messages.map((message) => message.message),
  }
}
