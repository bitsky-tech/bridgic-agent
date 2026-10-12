export function createWordIndexedDbMemory() {
  const records = new Map<string, unknown>()
  const writes: unknown[] = []
  const connections: Array<{ name: string; version?: number }> = []
  const state = { failWrites: false, failReads: false, failOpen: false, closed: 0, beforeWrite: null as (() => Promise<void>) | null }
  const database = {
    close: () => { state.closed++ },
    objectStoreNames: { contains: () => true },
    transaction(storeName: string) {
      if (storeName !== 'workspaces') throw new Error('Unexpected Word workspace store')
      const transaction = {
        error: new Error('Storage transaction failed'),
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: () => ({
          get(key: string) {
            const request = { result: undefined as unknown, error: new Error('Storage read failed'), onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
            queueMicrotask(() => {
              if (state.failReads) request.onerror?.()
              else { request.result = structuredClone(records.get(key)); request.onsuccess?.() }
            })
            return request
          },
          put(value: unknown, key: string) {
            const checkpoint = structuredClone(value)
            writes.push(checkpoint)
            queueMicrotask(() => {
              void (async () => {
                await state.beforeWrite?.()
                if (state.failWrites) transaction.onerror?.()
                else { records.set(key, checkpoint); transaction.oncomplete?.() }
              })()
            })
          },
        }),
      }
      return transaction
    },
  }
  const factory = {
    open(name: string, version?: number) {
      connections.push({ name, version })
      const request = { result: database, error: new Error('Storage open failed'), onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
      queueMicrotask(() => { if (state.failOpen) request.onerror?.(); else request.onsuccess?.() })
      return request
    },
  } as unknown as IDBFactory
  return { factory, records, writes, connections, state }
}
