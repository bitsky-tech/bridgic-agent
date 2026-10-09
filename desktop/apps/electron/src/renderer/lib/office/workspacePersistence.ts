import type { OfficeAppKind } from './officeSurfaceStatus'
import {
  createOfficePersistenceScheduler,
  type OfficePersistenceScheduler,
} from './officePersistence'

export interface WorkspacePersistence<T> extends OfficePersistenceScheduler<T> {
  load(): Promise<unknown | null>
}

/** Persist one Session-owned structured workspace directly in the renderer. */
export function createIndexedDbWorkspacePersistence<T>(options: {
  appKind: OfficeAppKind
  databaseName: string
  sessionId: string
  storeName: string
  version?: number
  delayMs?: number
  indexedDB?: IDBFactory
}): WorkspacePersistence<T> {
  let databasePromise: Promise<IDBDatabase> | null = null
  let disposed = false

  const openDatabase = (): Promise<IDBDatabase> => {
    if (databasePromise) return databasePromise
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const indexedDB = options.indexedDB ?? window.indexedDB
      if (!indexedDB) {
        reject(new Error('IndexedDB is unavailable.'))
        return
      }
      const request = indexedDB.open(options.databaseName, options.version ?? 1)
      request.onerror = () => reject(request.error ?? new Error(`Unable to open ${options.appKind} project storage.`))
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(options.storeName)) {
          request.result.createObjectStore(options.storeName)
        }
      }
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => {
          database.close()
          databasePromise = null
        }
        resolve(database)
      }
    })
    databasePromise = opening.catch((error) => {
      databasePromise = null
      throw error
    })
    return databasePromise
  }

  const load = async (): Promise<unknown | null> => {
    if (disposed) throw new Error('This workspace store is closed.')
    const database = await openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(options.storeName, 'readonly')
      const request = transaction.objectStore(options.storeName).get(options.sessionId)
      request.onerror = () => reject(request.error ?? new Error(`Unable to read the ${options.appKind} workspace.`))
      request.onsuccess = () => resolve(request.result ?? null)
    })
  }

  const scheduler = createOfficePersistenceScheduler<T>({
    policy: {
      appKind: options.appKind,
      sessionId: options.sessionId,
      kind: 'workspace',
      storage: 'browser-storage',
      automatic: true,
    },
    delayMs: options.delayMs ?? 150,
    write: async (workspace) => {
      const database = await openDatabase()
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(options.storeName, 'readwrite')
        transaction.onabort = () => reject(transaction.error ?? new Error(`Unable to save the ${options.appKind} workspace.`))
        transaction.onerror = () => reject(transaction.error ?? new Error(`Unable to save the ${options.appKind} workspace.`))
        transaction.oncomplete = () => resolve()
        transaction.objectStore(options.storeName).put(workspace, options.sessionId)
      })
    },
  })

  return {
    ...scheduler,
    load,
    dispose() {
      if (disposed) return
      disposed = true
      scheduler.dispose()
      void scheduler.flush().catch(() => undefined).finally(() => {
        const pendingDatabase = databasePromise
        databasePromise = null
        if (pendingDatabase) void pendingDatabase.then((database) => database.close(), () => undefined)
      })
    },
  }
}
