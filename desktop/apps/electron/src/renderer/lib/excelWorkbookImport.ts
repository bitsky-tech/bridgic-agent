import type { IWorkbookData, LocaleType } from '@univerjs/core'
import type { ExcelImportProgress } from './excelWorkbook'

export type ExcelImportWorkerResponse =
  | { type: 'progress'; progress: ExcelImportProgress }
  | { type: 'complete'; snapshot: IWorkbookData }
  | { type: 'error'; message: string }

/** Keep decompression and workbook conversion off the editor's UI thread. */
export function importExcelWorkbook(bytes: Uint8Array, locale: LocaleType, options: {
  signal?: AbortSignal
  onProgress?: (progress: ExcelImportProgress) => void
} = {}): Promise<IWorkbookData> {
  return new Promise((resolve, reject) => {
    const { signal, onProgress } = options
    if (signal?.aborted) {
      reject(new DOMException('Workbook import canceled.', 'AbortError'))
      return
    }
    const worker = new Worker(new URL('./excelWorkbook.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const abort = () => fail(new DOMException('Workbook import canceled.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<ExcelImportWorkerResponse>) => {
      const response = event.data
      if (response.type === 'progress') onProgress?.(response.progress)
      else if (response.type === 'complete') {
        cleanup()
        resolve(response.snapshot)
      } else fail(new Error(response.message))
    }
    worker.onerror = (event) => fail(new Error(event.message || 'Workbook import worker failed.'))
    worker.onmessageerror = () => fail(new Error('The imported workbook could not be transferred.'))
    try {
      const input = bytes.slice()
      worker.postMessage({ bytes: input, locale }, [input.buffer])
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
