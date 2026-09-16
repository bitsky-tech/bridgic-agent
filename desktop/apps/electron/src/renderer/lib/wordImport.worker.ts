import { importDocxToHtml, type ImportedDocx } from './wordDocxImport'
import type { OfficeImportWorkerReply } from './office/officeImportWorker'

self.onmessage = async ({ data }: MessageEvent<Uint8Array>) => {
  let response: OfficeImportWorkerReply<ImportedDocx>
  try { response = { ok: true, value: await importDocxToHtml(data) } } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  self.postMessage(response)
}
