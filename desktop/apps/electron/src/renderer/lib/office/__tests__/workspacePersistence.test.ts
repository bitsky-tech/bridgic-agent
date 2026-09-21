import { expect, it } from 'bun:test'
import { createIndexedDbWorkspacePersistence } from '../workspacePersistence'

function fakeIndexedDb() {
  const records = new Map<IDBValidKey, unknown>()
  let hasStore = false
  let closed = false
  const database = {
    close: () => { closed = true },
    createObjectStore: () => { hasStore = true },
    objectStoreNames: { contains: () => hasStore },
    onversionchange: null,
    transaction: (_storeName: string, mode: IDBTransactionMode) => {
      const transaction = {
        error: null,
        onabort: null as (() => void) | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore: () => ({
          get: (key: IDBValidKey) => {
            const request = { error: null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, result: undefined as unknown }
            queueMicrotask(() => {
              request.result = records.has(key) ? structuredClone(records.get(key)) : undefined
              request.onsuccess?.()
            })
            return request
          },
          put: (value: unknown, key: IDBValidKey) => {
            records.set(key, structuredClone(value))
            queueMicrotask(() => transaction.oncomplete?.())
          },
        }),
      }
      if (mode !== 'readonly' && mode !== 'readwrite') throw new Error('Unexpected transaction mode')
      return transaction
    },
  }
  const factory = {
    open: (_name: string, _version: number) => {
      const request = {
        error: null,
        onerror: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        result: database,
      }
      queueMicrotask(() => {
        if (!hasStore) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
  return {
    closed: () => closed,
    factory: factory as unknown as IDBFactory,
    records,
  }
}

it('stores a structured Session workspace in IndexedDB and restores it', async () => {
  const indexed = fakeIndexedDb()
  const persistence = createIndexedDbWorkspacePersistence<{ title: string }>({
    appKind: 'presentation',
    databaseName: 'presentation-test',
    indexedDB: indexed.factory,
    sessionId: 'session-a',
    storeName: 'projects',
  })
  try {
    expect(await persistence.load()).toBeNull()
    persistence.schedule({ title: 'First' })
    persistence.schedule({ title: 'Latest' })
    await persistence.flush()

    expect(indexed.records.get('session-a')).toEqual({ title: 'Latest' })
    expect(await persistence.load()).toEqual({ title: 'Latest' })
    expect(persistence.getSnapshot()).toMatchObject({
      policy: { appKind: 'presentation', sessionId: 'session-a', storage: 'browser-storage' },
      status: 'saved',
    })
  } finally {
    persistence.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(indexed.closed()).toBe(true)
  }
})
