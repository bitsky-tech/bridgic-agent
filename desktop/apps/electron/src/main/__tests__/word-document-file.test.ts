import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readWordDocumentFile } from '../word-document-file'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe('readWordDocumentFile', () => {
  it('returns bytes and metadata for an absolute DOCX path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridgic-word-read-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'Quarterly Plan.DOCX')
    await writeFile(path, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

    const result = await readWordDocumentFile(path)

    expect(result.fileName).toBe('Quarterly Plan.DOCX')
    expect([...result.bytes]).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(result.mtimeMs).toBeGreaterThan(0)
  })

  it('rejects relative paths and non-DOCX extensions before reading', async () => {
    await expect(readWordDocumentFile('report.docx')).rejects.toThrow('absolute .docx path')
    await expect(readWordDocumentFile('/tmp/report.doc')).rejects.toThrow('absolute .docx path')
  })
})
