import { importDocxToHtml } from '../lib/wordDocxImport'

/** Browser worker transport for component tests; conversion still uses Mammoth. */
export function installWordImportWorker(): () => void {
  const original = globalThis.Worker
  class ImportWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    onmessageerror: (() => void) | null = null
    private stopped = false
    postMessage(bytes: Uint8Array) {
      void importDocxToHtml(bytes).then(
        (value) => { if (!this.stopped) this.onmessage?.({ data: { ok: true, value } } as MessageEvent) },
        (error) => { if (!this.stopped) this.onmessage?.({ data: { ok: false, error: String(error) } } as MessageEvent) },
      )
    }
    terminate() { this.stopped = true }
  }
  globalThis.Worker = ImportWorker as unknown as typeof Worker
  return () => { globalThis.Worker = original }
}
