import { importPresentationPptx } from './presentationPptxImport'
import type { PresentationImportRequest } from './presentationImport'
import type { PresentationProject } from '@/atoms/presentation'
import type { OfficeImportWorkerReply } from './office/officeImportWorker'

self.onmessage = async ({ data }: MessageEvent<PresentationImportRequest>) => {
  let response: OfficeImportWorkerReply<PresentationProject>
  try {
    const bytes = typeof data.input === 'string'
      ? Uint8Array.from(atob(data.input), (character) => character.charCodeAt(0))
      : data.input
    response = { ok: true, value: await importPresentationPptx(bytes, data.fileName, data.options) }
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  self.postMessage(response)
}
