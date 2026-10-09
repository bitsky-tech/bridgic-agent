import type { ImportedDocx } from './wordDocxImport'
import { BooleanNumber } from '@univerjs/core'
import { runOfficeImportWorker } from './office/officeImportWorker'
import { prepareWordHtmlImages } from './wordImages'
import { createUniverDocumentSnapshot, createUniverSectionedDocumentSnapshot } from './wordUniverModel'

export async function importDocxInBackground(bytes: Uint8Array, signal?: AbortSignal): Promise<ImportedDocx> {
  const owned = bytes.slice()
  const result = await runOfficeImportWorker<ImportedDocx>(
    () => new Worker(new URL('./wordImport.worker.ts', import.meta.url), { type: 'module' }),
    owned,
    [owned.buffer],
    signal,
  )
  const warn = (message: string) => { if (!result.warnings.includes(message)) result.warnings.push(message) }
  result.html = await prepareWordHtmlImages(result.html, warn)
  if (!result.document && result.layout) {
    const { page, headerFooter } = result.layout
    headerFooter.headerHtml = await prepareWordHtmlImages(headerFooter.headerHtml, warn)
    headerFooter.footerHtml = await prepareWordHtmlImages(headerFooter.footerHtml, warn)
    const variants = result.layout.headerFooterVariants ?? []
    for (const part of variants) part.html = await prepareWordHtmlImages(part.html, warn)
    const sections = result.layout.sections
    if (sections) {
      const parts = new Map<string, string>()
      for (const section of sections) {
        section.html = await prepareWordHtmlImages(section.html, warn)
        for (const part of section.parts) {
          if (!parts.has(part.id!)) parts.set(part.id!, await prepareWordHtmlImages(part.html, warn))
          part.html = parts.get(part.id!)!
        }
      }
    }
    const snapshot = sections
      ? createUniverSectionedDocumentSnapshot('imported-word', 'Document', page, headerFooter, sections)
      : createUniverDocumentSnapshot('imported-word', 'Document', page, headerFooter, result.html, variants)
    snapshot.documentStyle.evenAndOddHeaders = result.layout.evenAndOddHeaders ? BooleanNumber.TRUE : BooleanNumber.FALSE
    result.document = { snapshot, page, headerFooter, footnotes: [], citations: [] }
  }
  if (signal?.aborted) throw new DOMException('Word import canceled.', 'AbortError')
  return result
}
