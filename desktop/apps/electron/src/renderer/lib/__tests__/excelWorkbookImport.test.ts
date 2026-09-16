import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { LocaleType, type IWorkbookData } from '@univerjs/core'
import { importExcelWorkbook, type ExcelImportWorkerResponse } from '../excelWorkbookImport'

const originalWorker = globalThis.Worker
let workers: ImportWorker[] = []

class ImportWorker {
  onmessage: ((event: MessageEvent<ExcelImportWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = mock((_message: unknown, _transfer: Transferable[]) => {})
  terminate = mock(() => {})

  constructor() { workers.push(this) }

  reply(response: ExcelImportWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<ExcelImportWorkerResponse>)
  }
}

beforeEach(() => {
  workers = []
  globalThis.Worker = ImportWorker as unknown as typeof Worker
})
afterEach(() => { globalThis.Worker = originalWorker })

describe('background workbook import', () => {
  it('transfers a copy of the input, reports progress, and releases the worker on success', async () => {
    const input = new Uint8Array([1, 2, 3])
    const onProgress = mock(() => {})
    const result = importExcelWorkbook(input, LocaleType.EN_US, { onProgress })
    const worker = workers[0]!
    const [request, transfer] = worker.postMessage.mock.calls[0]! as [{ bytes: Uint8Array; locale: LocaleType }, Transferable[]]
    expect(request.bytes).toEqual(input)
    expect(request.bytes.buffer).not.toBe(input.buffer)
    expect(transfer).toEqual([request.bytes.buffer])
    worker.reply({ type: 'progress', progress: { phase: 'reading' } })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'reading' })
    const snapshot = { id: 'imported', sheets: {}, sheetOrder: [] } as unknown as IWorkbookData
    worker.reply({ type: 'complete', snapshot })
    expect(await result).toBe(snapshot)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.onmessage).toBeNull()
  })

  it('cancels a running import without accepting late results or progress', async () => {
    const controller = new AbortController()
    const onProgress = mock(() => {})
    const result = importExcelWorkbook(new Uint8Array(), LocaleType.EN_US, { signal: controller.signal, onProgress })
    const worker = workers[0]!
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    worker.reply({ type: 'progress', progress: { phase: 'reading' } })
    expect(onProgress).not.toHaveBeenCalled()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('does not start a worker for an already canceled import', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(importExcelWorkbook(new Uint8Array(), LocaleType.EN_US, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(workers).toHaveLength(0)
  })

  it('surfaces conversion errors and worker failures instead of leaving an import pending', async () => {
    const invalidFile = importExcelWorkbook(new Uint8Array(), LocaleType.EN_US)
    workers[0]!.reply({ type: 'error', message: 'Invalid workbook archive' })
    await expect(invalidFile).rejects.toThrow('Invalid workbook archive')
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)

    const failedWorker = importExcelWorkbook(new Uint8Array(), LocaleType.EN_US)
    workers[1]!.onerror?.({ message: 'Worker failed' } as ErrorEvent)
    await expect(failedWorker).rejects.toThrow('Worker failed')
    expect(workers[1]!.terminate).toHaveBeenCalledTimes(1)
  })
})
