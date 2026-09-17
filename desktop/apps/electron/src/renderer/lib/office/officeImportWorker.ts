export type OfficeImportWorkerReply<T> = { ok: true; value: T } | { ok: false; error: string }

/** One disposable worker per import keeps CPU-heavy parsing outside the editor. */
export function runOfficeImportWorker<T>(createWorker: () => Worker, request: unknown, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Document import canceled.', 'AbortError'))
      return
    }
    const worker = createWorker()
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const abort = () => fail(new DOMException('Document import canceled.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<OfficeImportWorkerReply<T>>) => {
      cleanup()
      if (event.data.ok) resolve(event.data.value)
      else reject(new Error(event.data.error))
    }
    worker.onerror = (event) => fail(new Error(event.message || 'Document import worker failed.'))
    worker.onmessageerror = () => fail(new Error('The imported document could not be transferred.'))
    try { worker.postMessage(request, transfer) } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
