import type { LocaleType } from '@univerjs/core'
import { importXlsx } from './excelWorkbook'
import type { ExcelImportWorkerResponse } from './excelWorkbookImport'

const reply = (response: ExcelImportWorkerResponse) => self.postMessage(response)

self.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; locale: LocaleType }>) => {
  try {
    const snapshot = await importXlsx(event.data.bytes, event.data.locale, (progress) => {
      reply({ type: 'progress', progress })
    })
    reply({ type: 'complete', snapshot })
  } catch (error) {
    reply({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
