import type { WordWorkspaceState } from './wordDomain'

const WORD_DATABASE_NAME = 'bridgic-word'
const WORD_DATABASE_VERSION = 1
const WORD_STORE_NAME = 'workspaces'
const WORD_STORAGE_PREFIX = 'bridgic.word.workspace.'

export type WordPersistenceStatus = 'error' | 'saved' | 'saving'

export interface WordWorkspacePersister {
  dispose(): void
  flush(): Promise<void>
  save(state: WordWorkspaceState): void
}

export async function loadPersistedWordWorkspace(sessionId: string): Promise<unknown | null> {
  try {
    const stored = await readIndexedWorkspace(sessionId)
    if (stored !== null) return stored
  } catch {
    // The legacy localStorage value remains available when IndexedDB is disabled.
  }

  try {
    const key = `${WORD_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`
    const legacy = window.localStorage.getItem(key)
    if (!legacy) return null
    const parsed = JSON.parse(legacy) as unknown
    try {
      await writeIndexedWorkspace(sessionId, parsed)
      window.localStorage.removeItem(key)
    } catch {
      // Keep the legacy value until a durable IndexedDB migration succeeds.
    }
    return parsed
  } catch {
    return null
  }
}

export function createWordWorkspacePersister(onStatusChange: (status: WordPersistenceStatus) => void): WordWorkspacePersister {
  let disposed = false
  let pending: WordWorkspaceState | null = null
  let running: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (running) return running
    let failed = false
    running = (async () => {
      while (pending) {
        const state = pending
        pending = null
        try {
          await persistWordWorkspace(state)
        } catch {
          failed = true
          if (!pending) pending = state
          if (!disposed) onStatusChange('error')
          return
        }
      }
      if (!disposed) onStatusChange('saved')
    })().finally(() => {
      running = null
      if (pending && !disposed && !failed) void flush()
    })
    return running
  }

  return {
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      void flush()
    },
    flush,
    save(state) {
      pending = state
      if (!disposed) onStatusChange('saving')
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => void flush(), 120)
    },
  }
}

async function persistWordWorkspace(state: WordWorkspaceState): Promise<void> {
  try {
    await writeIndexedWorkspace(state.sessionId, state)
    return
  } catch (indexedDbError) {
    try {
      window.localStorage.setItem(
        `${WORD_STORAGE_PREFIX}${encodeURIComponent(state.sessionId)}`,
        JSON.stringify(state),
      )
      return
    } catch {
      throw indexedDbError
    }
  }
}

async function readIndexedWorkspace(sessionId: string): Promise<unknown | null> {
  const database = await openWordDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(WORD_STORE_NAME, 'readonly')
      const request = transaction.objectStore(WORD_STORE_NAME).get(sessionId)
      request.onerror = () => reject(request.error ?? new Error('Unable to read the Word workspace.'))
      request.onsuccess = () => resolve(request.result ?? null)
    })
  } finally {
    database.close()
  }
}

async function writeIndexedWorkspace(sessionId: string, state: unknown): Promise<void> {
  const database = await openWordDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(WORD_STORE_NAME, 'readwrite')
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to save the Word workspace.'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save the Word workspace.'))
      transaction.oncomplete = () => resolve()
      transaction.objectStore(WORD_STORE_NAME).put(state, sessionId)
    })
  } finally {
    database.close()
  }
}

async function openWordDatabase(): Promise<IDBDatabase> {
  if (!window.indexedDB) throw new Error('IndexedDB is unavailable.')
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(WORD_DATABASE_NAME, WORD_DATABASE_VERSION)
    request.onerror = () => reject(request.error ?? new Error('Unable to open Word storage.'))
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WORD_STORE_NAME)) {
        request.result.createObjectStore(WORD_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}
