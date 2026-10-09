import type { IWorkbookData, LocaleType } from '@univerjs/core'
import { COMPATIBILITY_CUSTOM_KEY, unsupportedWorkbookFeatures, type ExcelImportProgress } from './excelWorkbook'
import { prepareOfficeImage } from './office/officeImage'

async function prepareWorkbookImages(snapshot: IWorkbookData, signal?: AbortSignal): Promise<IWorkbookData> {
  const resource = snapshot.resources?.find((value) => value.name === 'SHEET_DRAWING_PLUGIN')
  if (!resource) return snapshot
  const drawings = JSON.parse(resource.data) as Record<string, { data: Record<string, { source?: string }>; order: string[] }>
  for (const sheet of Object.values(drawings)) {
    for (const [id, drawing] of Object.entries(sheet.data)) {
      if (signal?.aborted) throw new DOMException('Workbook import canceled.', 'AbortError')
      if (!drawing.source) continue
      try {
        drawing.source = (await prepareOfficeImage(drawing.source, 'excel')).dataUrl
      } catch {
        // One unsupported image must not hide an otherwise readable workbook.
        // Compatibility metadata prevents an automatic lossy overwrite of the source.
        delete sheet.data[id]
        sheet.order = sheet.order.filter((drawingId) => drawingId !== id)
        snapshot.custom = { ...snapshot.custom, [COMPATIBILITY_CUSTOM_KEY]: [...new Set([...unsupportedWorkbookFeatures(snapshot), 'unrenderable embedded images'])] }
      }
    }
  }
  if (signal?.aborted) throw new DOMException('Workbook import canceled.', 'AbortError')
  resource.data = JSON.stringify(drawings)
  return snapshot
}

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
        void prepareWorkbookImages(response.snapshot, signal).then(resolve, reject)
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
