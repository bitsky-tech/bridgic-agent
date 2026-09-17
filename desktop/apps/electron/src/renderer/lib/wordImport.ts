import type { ImportedDocx } from './wordDocxImport'
import { runOfficeImportWorker } from './office/officeImportWorker'

export function importDocxInBackground(bytes: Uint8Array, signal?: AbortSignal): Promise<ImportedDocx> {
  const owned = bytes.slice()
  return runOfficeImportWorker<ImportedDocx>(
    () => new Worker(new URL('./wordImport.worker.ts', import.meta.url), { type: 'module' }),
    owned,
    [owned.buffer],
    signal,
  )
}
