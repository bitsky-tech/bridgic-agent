import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'

import type { WordDocumentReadResult } from '../shared/types'

export const MAX_WORD_DOCUMENT_BYTES = 50 * 1024 * 1024

/** Read a user-selected DOCX while keeping the preload capability file-type scoped. */
export async function readWordDocumentFile(path: unknown): Promise<WordDocumentReadResult> {
  if (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLocaleLowerCase() !== '.docx') {
    throw new TypeError('Word document path must be an absolute .docx path')
  }
  const canonicalPath = await realpath(path)
  const metadata = await stat(canonicalPath)
  if (!metadata.isFile()) throw new TypeError('Word document path must reference a file')
  if (metadata.size > MAX_WORD_DOCUMENT_BYTES) throw new RangeError('Word document exceeds the 50 MB limit')

  const bytes = new Uint8Array(await readFile(canonicalPath))
  if (bytes.byteLength > MAX_WORD_DOCUMENT_BYTES) throw new RangeError('Word document exceeds the 50 MB limit')
  return { path: canonicalPath, bytes, fileName: basename(canonicalPath), mtimeMs: metadata.mtimeMs }
}
