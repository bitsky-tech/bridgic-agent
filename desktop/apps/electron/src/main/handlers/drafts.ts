/**
 * Composer drafts IPC handlers — thin adapter over `main/json-blob-file.ts`.
 *
 * The contract carries the WHOLE drafts map (sessionId → Segment[]); the
 * renderer debounces saves. The map is opaque here — main just persists JSON.
 */
import { DRAFTS_FILE_NAME } from '../../shared/app-meta'
import { IPC } from '../../shared/ipc-channels'
import { readJsonBlob, writeJsonBlob, type JsonBlobMap } from '../json-blob-file'
import { amphiUserFile } from '../paths'
import { loggedHandle } from './logged-handle'

function draftsFilePath(): string {
  return amphiUserFile(DRAFTS_FILE_NAME)
}

export function registerDraftsHandlers(): void {
  loggedHandle(IPC.drafts.load, async (): Promise<JsonBlobMap> => {
    return readJsonBlob(draftsFilePath(), 'drafts')
  })

  loggedHandle(IPC.drafts.save, async (_event, drafts: JsonBlobMap): Promise<void> => {
    writeJsonBlob(drafts, draftsFilePath())
  })
}
