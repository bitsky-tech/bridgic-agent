import type { PresentationProject } from '@/atoms/presentation'
import type { PresentationPptxImportOptions } from './presentationPptxImport'
import { runOfficeImportWorker } from './office/officeImportWorker'

export interface PresentationImportRequest {
  input: Uint8Array | string
  fileName: string
  options: PresentationPptxImportOptions
}

export function importPresentationInBackground(input: Uint8Array | ArrayBuffer | string, fileName: string, options: PresentationPptxImportOptions = {}): Promise<PresentationProject> {
  let owned: Uint8Array | string
  if (typeof input === 'string') owned = input
  else if (input instanceof Uint8Array) owned = input.slice()
  else owned = new Uint8Array(input.slice(0))
  return runOfficeImportWorker<PresentationProject>(
    () => new Worker(new URL('./presentationImport.worker.ts', import.meta.url), { type: 'module' }),
    { input: owned, fileName, options: { restoreEditorModel: true, ...options } } satisfies PresentationImportRequest,
    typeof owned === 'string' ? [] : [owned.buffer],
  )
}
