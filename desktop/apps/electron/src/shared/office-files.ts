import type { PresentationMountedSource, PresentationSourceMount } from './presentation-host'

export type OfficeFileKind = 'word' | 'excel' | 'presentation'
export type OfficeCloseDecision = 'save' | 'discard' | 'cancel'
export interface OfficeFileSource { path: string; mtimeMs: number | null }
export interface OfficeFileSaveRequest {
  kind: OfficeFileKind
  bytes: Uint8Array
  suggestedName: string
  source?: OfficeFileSource
  saveAs?: boolean
  preserveSource?: boolean
  destination?: string
  managed?: boolean
  documentId?: string
}
export type OfficeFileSaveResult =
  | { ok: true; source: OfficeFileSource; fileName: string }
  | { ok: false; reason: 'canceled' | 'conflict' | 'source-protected' }
export interface OfficeFilesAPI {
  prepare?(kind: OfficeFileKind, path: string): Promise<OfficeFileSource>
  readBase64?(kind: OfficeFileKind, path: string): Promise<string>
  readImage?(kind: OfficeFileKind, url: string): Promise<string>
  onChanged?(callback: (sessionId: string) => void): () => void
  listPresentationMounts?(): Promise<PresentationSourceMount[]>
  mountPresentationSource?(source: { dataBase64?: string; fileName: string; mimeType: string; path?: string }): Promise<PresentationMountedSource>
  inspect(kind: OfficeFileKind, path: string): Promise<OfficeFileSource>
  save(request: OfficeFileSaveRequest): Promise<OfficeFileSaveResult>
  confirmClose(fileName: string, locale: string): Promise<OfficeCloseDecision>
}

declare global { interface Window { officeFiles?: OfficeFilesAPI } }
