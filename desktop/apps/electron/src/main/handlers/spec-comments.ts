/**
 * Staged spec-comment IPC handlers — thin adapter over `main/json-blob-file.ts`.
 *
 * The contract carries the whole map (sessionId → PendingComment[]); the
 * renderer debounces the save. The map is opaque at this layer — main only
 * persists JSON.
 */
import { SPEC_COMMENTS_FILE_NAME } from '../../shared/app-meta'
import { IPC } from '../../shared/ipc-channels'
import { readJsonBlob, writeJsonBlob, type JsonBlobMap } from '../json-blob-file'
import { amphiUserFile } from '../paths'
import { loggedHandle } from './logged-handle'

function specCommentsFilePath(): string {
  return amphiUserFile(SPEC_COMMENTS_FILE_NAME)
}

export function registerSpecCommentsHandlers(): void {
  loggedHandle(IPC.specComments.load, async (): Promise<JsonBlobMap> => {
    return readJsonBlob(specCommentsFilePath(), 'spec-comments')
  })

  loggedHandle(IPC.specComments.save, async (_event, map: JsonBlobMap): Promise<void> => {
    writeJsonBlob(map, specCommentsFilePath())
  })
}
