/**
 * Workflow-market cache IPC handlers -- a thin adapter over `main/json-blob-file.ts`.
 *
 * One difference from the other blobs worth stating: they are keyed by sessionId,
 * this one holds a single global entry under a fixed key. The store is reused
 * rather than reimplemented because its contract is exactly what a cache wants --
 * reads never throw (missing / corrupted / non-object yields `{}`), writes are
 * atomic, and it stays out of the settings broadcast.
 *
 * The value shape is opaque here, as with drafts; the renderer owns it.
 */
import { MARKET_CACHE_FILE_NAME } from '../../shared/app-meta'
import { IPC } from '../../shared/ipc-channels'
import { readJsonBlob, writeJsonBlob, type JsonBlobMap } from '../json-blob-file'
import { amphiUserFile } from '../paths'
import { loggedHandle } from './logged-handle'

function marketCacheFilePath(): string {
  return amphiUserFile(MARKET_CACHE_FILE_NAME)
}

export function registerMarketHandlers(): void {
  loggedHandle(IPC.market.load, async (): Promise<JsonBlobMap> => {
    return readJsonBlob(marketCacheFilePath(), 'market-cache')
  })

  loggedHandle(IPC.market.save, async (_event, cache: JsonBlobMap): Promise<void> => {
    writeJsonBlob(cache, marketCacheFilePath())
  })
}
