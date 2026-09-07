import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

import { importDocxToHtml } from '../wordDocxImport'

describe('importDocxToHtml', () => {
  it('converts DOCX OOXML bytes into semantic HTML', async () => {
    const fixture = resolve(import.meta.dir, '../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer())

    const result = await importDocxToHtml(bytes)

    expect(result.html).toBe('<p>Walking on imported air</p>')
    expect(result.warnings).toEqual([])
  })

  it('rejects an empty file before invoking the converter', async () => {
    await expect(importDocxToHtml(new Uint8Array())).rejects.toThrow('empty')
  })
})
