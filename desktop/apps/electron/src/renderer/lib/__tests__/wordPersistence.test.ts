import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { createWordWorkspace } = await import('../wordDomain')
const { createWordWorkspacePersister, loadPersistedWordWorkspace } = await import('../wordPersistence')

const originalIndexedDb = window.indexedDB
const originalLocalStorage = window.localStorage

afterEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: originalLocalStorage })
  window.localStorage.clear()
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: originalIndexedDb })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function installIndexedWorkspaceStorage() {
  const values = new Map<string, unknown>()
  const connections: Array<{ name: string; version?: number }> = []
  const state = { failWrites: false, failReads: false }
  const database = {
    close: () => undefined,
    objectStoreNames: { contains: () => true },
    transaction(storeName: string) {
      expect(storeName).toBe('workspaces')
      const transaction = {
        error: new Error('Storage transaction failed'),
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: () => ({
          get(key: string) {
            const request = { result: values.get(key), error: new Error('Storage read failed'), onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
            queueMicrotask(() => { if (state.failReads) request.onerror?.(); else request.onsuccess?.() })
            return request
          },
          put(value: unknown, key: string) {
            queueMicrotask(() => {
              if (state.failWrites) { transaction.onerror?.(); return }
              values.set(key, structuredClone(value))
              transaction.oncomplete?.()
            })
          },
        }),
      }
      return transaction
    },
  }
  Object.defineProperty(window, 'indexedDB', {
    configurable: true,
    value: {
      open(name: string, version?: number) {
        connections.push({ name, version })
        const request = { result: database, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
        queueMicrotask(() => request.onsuccess?.())
        return request
      },
    },
  })
  return { values, connections, state }
}

function withoutRecoveryMetadata(value: unknown): unknown {
  const workspace = { ...value as Record<string, unknown> }
  delete workspace.__bridgicWordRecovery
  return workspace
}

function recoveryMetadata(value: unknown): { version: number; sequence: number; legacyAlternatives?: unknown[] } {
  return (value as { __bridgicWordRecovery: { version: number; sequence: number; legacyAlternatives?: unknown[] } }).__bridgicWordRecovery
}

describe('Word workspace persistence', () => {
  it('falls back to localStorage and reports a completed durable save when IndexedDB is unavailable', async () => {
    const statuses: string[] = []
    const state = createWordWorkspace('session-persisted', 'Untitled')
    const persister = createWordWorkspacePersister(state.sessionId, (status) => statuses.push(status))

    persister.save(state)
    await persister.flush()

    expect(statuses).toEqual(['saving', 'saved'])
    expect(await loadPersistedWordWorkspace('session-persisted')).toEqual(state)
    persister.dispose()
  })

  it('reports a save error instead of claiming success when every storage backend fails', async () => {
    const statuses: string[] = []
    const localStorage = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError')
        },
      },
    })
    const persister = createWordWorkspacePersister('session-full', (status) => statuses.push(status))

    persister.save(createWordWorkspace('session-full', 'Untitled'))
    await expect(persister.flush()).rejects.toThrow()

    expect(statuses).toEqual(['saving', 'error'])
    Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorage })
    await persister.flush()
    expect(statuses.at(-1)).toBe('saved')
    expect((await loadPersistedWordWorkspace('session-full')) as object).toMatchObject({ sessionId: 'session-full' })
    persister.dispose()
  })

  it('waits for edits queued during an in-flight flush before acknowledging completion', async () => {
    const state = createWordWorkspace('session-concurrent-save', 'First')
    const updated = { ...state, documents: state.documents.map((document) => ({ ...document, title: 'Latest' })) }
    const persister = createWordWorkspacePersister(state.sessionId, () => undefined)
    persister.save(state)
    const firstFlush = persister.flush()
    persister.save(updated)
    await Promise.all([firstFlush, persister.flush()])
    expect(await loadPersistedWordWorkspace(state.sessionId)).toEqual(updated)
    persister.dispose()
  })

  it('declares browser workspace recovery separately from source-file saving and rejects other Sessions', () => {
    const persister = createWordWorkspacePersister('session-policy', () => undefined)
    expect(persister.getSnapshot().policy).toEqual({
      appKind: 'word', sessionId: 'session-policy', kind: 'recovery', storage: 'browser-storage', automatic: true,
    })
    expect(() => persister.save(createWordWorkspace('another-session', 'Untitled'))).toThrow('another Session')
    expect(persister.getSnapshot().pendingCount).toBe(0)
    persister.dispose()
  })

  it('restores a newer local fallback before an older IndexedDB record and migrates only after acknowledgement', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const first = createWordWorkspace('session-fallback', 'First')
    const latest = { ...first, documents: first.documents.map((document) => ({ ...document, title: 'Latest' })) }
    const key = `bridgic.word.workspace.${encodeURIComponent(first.sessionId)}`
    const persister = createWordWorkspacePersister(first.sessionId, () => undefined)
    persister.save(first)
    await persister.flush()
    indexed.state.failWrites = true
    persister.save(latest)
    await persister.flush()
    expect(withoutRecoveryMetadata(indexed.values.get(first.sessionId))).toEqual(first)
    expect(withoutRecoveryMetadata(JSON.parse(window.localStorage.getItem(key)!))).toEqual(latest)

    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
    expect(window.localStorage.getItem(key)).not.toBeNull()
    indexed.state.failWrites = false
    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
    expect(withoutRecoveryMetadata(indexed.values.get(first.sessionId))).toEqual(latest)
    expect(window.localStorage.getItem(key)).toBeNull()
    expect(indexed.connections.every((connection) => connection.name === 'bridgic-word' && connection.version === 1)).toBe(true)
    persister.dispose()
  })

  it('clears an obsolete fallback when a subsequent save succeeds in IndexedDB', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const first = createWordWorkspace('session-recovered-writes', 'First')
    const latest = { ...first, documents: first.documents.map((document) => ({ ...document, title: 'Latest' })) }
    const key = `bridgic.word.workspace.${encodeURIComponent(first.sessionId)}`
    window.localStorage.setItem(key, JSON.stringify(first))
    const persister = createWordWorkspacePersister(first.sessionId, () => undefined)
    persister.save(latest)
    await persister.flush()
    expect(window.localStorage.getItem(key)).toBeNull()
    expect(withoutRecoveryMetadata(indexed.values.get(first.sessionId))).toEqual(latest)
    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
    persister.dispose()
  })

  it('keeps malformed recovery data and reports read failures instead of treating them as empty workspaces', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const key = 'bridgic.word.workspace.session-corrupt'
    const saved = '{incomplete json'
    window.localStorage.setItem(key, saved)
    await expect(loadPersistedWordWorkspace('session-corrupt')).rejects.toThrow()
    expect(window.localStorage.getItem(key)).toBe(saved)
    expect(indexed.values.size).toBe(0)
    window.localStorage.removeItem(key)
    indexed.state.failReads = true
    await expect(loadPersistedWordWorkspace('session-corrupt')).rejects.toThrow('Storage read failed')
    indexed.state.failReads = false
    expect(await loadPersistedWordWorkspace('session-corrupt')).toBeNull()
  })

  it('rejects incompatible or damaged document records without migrating a blank replacement', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const key = 'bridgic.word.workspace.session-damaged'
    const state = createWordWorkspace('session-damaged', 'Original')
    const damaged = { ...state, documents: [{ ...state.documents[0], snapshot: {} }] }
    window.localStorage.setItem(key, JSON.stringify(damaged))
    await expect(loadPersistedWordWorkspace(state.sessionId)).rejects.toThrow('content is invalid')
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(damaged)
    expect(indexed.values.size).toBe(0)
  })

  it('keeps newer legacy IndexedDB edits when an earlier failed write left an obsolete fallback', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const initial = createWordWorkspace('session-upgrade-obsolete-fallback', 'Original')
    const first = { ...initial, documents: initial.documents.map((document) => ({ ...document, updatedAt: 100 })) }
    const latest = { ...first, documents: first.documents.map((document) => ({ ...document, title: 'Important new edits', updatedAt: 200 })) }
    const key = `bridgic.word.workspace.${first.sessionId}`
    // The previous writer did not remove its fallback when IndexedDB resumed accepting writes.
    window.localStorage.setItem(key, JSON.stringify(first))
    indexed.values.set(first.sessionId, latest)

    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
    expect(withoutRecoveryMetadata(indexed.values.get(first.sessionId))).toEqual(latest)
    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
  })

  it('migrates a demonstrably newer legacy fallback without discarding its edits', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const initial = createWordWorkspace('session-upgrade-newer-fallback', 'Original')
    const first = { ...initial, documents: initial.documents.map((document) => ({ ...document, updatedAt: 100 })) }
    const latest = { ...first, documents: first.documents.map((document) => ({ ...document, title: 'New fallback edits', updatedAt: 200 })) }
    const key = `bridgic.word.workspace.${first.sessionId}`
    indexed.values.set(first.sessionId, first)
    window.localStorage.setItem(key, JSON.stringify(latest))

    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
    expect(withoutRecoveryMetadata(indexed.values.get(first.sessionId))).toEqual(latest)
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('orders tab activation, document removal, and an empty workspace by checkpoint instead of document timestamps', async () => {
    const indexed = installIndexedWorkspaceStorage()
    for (const change of ['activate', 'remove', 'empty'] as const) {
      const initial = createWordWorkspace(`session-checkpoint-${change}`, 'First')
      const second = createWordWorkspace(initial.sessionId, 'Second').documents[0]!
      const first = { ...initial, documents: [...initial.documents, second] }
      let latest = { ...first, activeDocumentId: second.id }
      if (change === 'remove') latest = { ...first, activeDocumentId: second.id, documents: [second] }
      if (change === 'empty') latest = { ...first, activeDocumentId: '', documents: [] }
      const key = `bridgic.word.workspace.${first.sessionId}`
      const persister = createWordWorkspacePersister(first.sessionId, () => undefined)
      indexed.state.failWrites = false
      persister.save(first)
      await persister.flush()
      const previousSequence = recoveryMetadata(indexed.values.get(first.sessionId)).sequence
      indexed.state.failWrites = true
      persister.save(latest)
      await persister.flush()
      const fallback = JSON.parse(window.localStorage.getItem(key)!)
      expect(recoveryMetadata(fallback).sequence).toBeGreaterThan(previousSequence)
      expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
      indexed.state.failWrites = false
      expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
      expect(withoutRecoveryMetadata(indexed.values.get(first.sessionId))).toEqual(latest)
      persister.dispose()
    }
  })

  it('preserves same-timestamp legacy conflicts through subsequent IndexedDB and fallback checkpoints', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const initial = createWordWorkspace('session-legacy-conflicting-edit', 'First')
    const second = createWordWorkspace(initial.sessionId, 'Second').documents[0]!
    const primary = {
      ...initial,
      documents: [{ ...initial.documents[0]!, updatedAt: 200 }, { ...second, updatedAt: 100 }],
    }
    const alternative = {
      ...primary,
      documents: [{ ...primary.documents[0]!, updatedAt: 100 }, { ...primary.documents[1]!, title: 'Different text in the same millisecond' }],
    }
    const key = `bridgic.word.workspace.${primary.sessionId}`
    indexed.values.set(primary.sessionId, primary)
    window.localStorage.setItem(key, JSON.stringify(alternative))

    expect(await loadPersistedWordWorkspace(primary.sessionId)).toEqual(primary)
    expect(indexed.values.get(primary.sessionId)).toEqual(primary)
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(alternative)
    const edited = { ...primary, documents: primary.documents.map((document) => ({ ...document, title: `${document.title} edited`, updatedAt: 300 })) }
    const persister = createWordWorkspacePersister(primary.sessionId, () => undefined)
    persister.save(edited)
    await persister.flush()
    const checkpoint = indexed.values.get(primary.sessionId)
    expect(withoutRecoveryMetadata(checkpoint)).toEqual(edited)
    expect(recoveryMetadata(checkpoint).legacyAlternatives).toContainEqual(alternative)
    expect(window.localStorage.getItem(key)).toBeNull()
    expect(await loadPersistedWordWorkspace(primary.sessionId)).toEqual(edited)

    const empty = { ...edited, documents: [], activeDocumentId: '' }
    indexed.state.failWrites = true
    persister.save(empty)
    await persister.flush()
    const fallback = JSON.parse(window.localStorage.getItem(key)!)
    expect(withoutRecoveryMetadata(fallback)).toEqual(empty)
    expect(recoveryMetadata(fallback).legacyAlternatives).toContainEqual(alternative)
    expect(await loadPersistedWordWorkspace(primary.sessionId)).toEqual(empty)
    persister.dispose()
  })

  it('continues the persisted checkpoint order after restoring into a fresh persister', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const first = createWordWorkspace('session-checkpoint-restart', 'Restored')
    const alternate = { ...first, documents: first.documents.map((document) => ({ ...document, title: 'Retained legacy alternative' })) }
    const sequence = Date.now() + 10_000
    indexed.values.set(first.sessionId, {
      ...first,
      __bridgicWordRecovery: { version: 1, sequence, legacyAlternatives: [alternate] },
    })

    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(first)
    const persister = createWordWorkspacePersister(first.sessionId, () => undefined)
    const empty = { ...first, documents: [], activeDocumentId: '' }
    persister.save(empty)
    await persister.flush()
    const checkpoint = indexed.values.get(first.sessionId)
    expect(recoveryMetadata(checkpoint).sequence).toBeGreaterThan(sequence)
    expect(recoveryMetadata(checkpoint).legacyAlternatives).toContainEqual(alternate)
    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(empty)
    persister.dispose()
  })

  it('retains the alternate legacy workspace when document membership cannot establish a save order', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const alternate = createWordWorkspace('session-legacy-empty-conflict', 'Previously open document')
    const primary = { ...alternate, activeDocumentId: '', documents: [] }
    const key = `bridgic.word.workspace.${primary.sessionId}`
    indexed.values.set(primary.sessionId, primary)
    window.localStorage.setItem(key, JSON.stringify(alternate))

    expect(await loadPersistedWordWorkspace(primary.sessionId)).toEqual(primary)
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(alternate)
    const persister = createWordWorkspacePersister(primary.sessionId, () => undefined)
    indexed.state.failWrites = true
    persister.save(primary)
    await persister.flush()
    const fallback = JSON.parse(window.localStorage.getItem(key)!)
    expect(withoutRecoveryMetadata(fallback)).toEqual(primary)
    expect(recoveryMetadata(fallback).legacyAlternatives).toContainEqual(alternate)
    expect(await loadPersistedWordWorkspace(primary.sessionId)).toEqual(primary)
    persister.dispose()
  })

  it('does not restore an older fallback if cleanup fails after a newer IndexedDB checkpoint succeeds', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const first = createWordWorkspace('session-remove-fallback-failure', 'First')
    const latest = { ...first, documents: first.documents.map((document) => ({ ...document, title: 'Latest' })) }
    const key = `bridgic.word.workspace.${first.sessionId}`
    const persister = createWordWorkspacePersister(first.sessionId, () => undefined)
    indexed.state.failWrites = true
    persister.save(first)
    await persister.flush()
    const fallback = window.localStorage.getItem(key)
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => originalLocalStorage.getItem(key),
      setItem: (key: string, value: string) => originalLocalStorage.setItem(key, value),
      removeItem: () => { throw new DOMException('Storage access denied', 'SecurityError') },
    } })
    indexed.state.failWrites = false
    persister.save(latest)
    await persister.flush()
    expect(persister.getSnapshot().status).toBe('saved')
    expect(window.localStorage.getItem(key)).toBe(fallback)
    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
    expect(withoutRecoveryMetadata(indexed.values.get(first.sessionId))).toEqual(latest)
    persister.dispose()
  })

  it('preserves both records and rejects recovery until an unreadable IndexedDB primary can be checked', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const fallback = createWordWorkspace('session-unread-indexed-primary', 'Fallback')
    const unread = { ...fallback, documents: fallback.documents.map((document) => ({ ...document, title: 'Unread IndexedDB document' })) }
    const key = `bridgic.word.workspace.${fallback.sessionId}`
    indexed.values.set(fallback.sessionId, unread)
    window.localStorage.setItem(key, JSON.stringify(fallback))
    indexed.state.failReads = true

    await expect(loadPersistedWordWorkspace(fallback.sessionId)).rejects.toThrow('Storage read failed')
    expect(indexed.values.get(fallback.sessionId)).toEqual(unread)
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(fallback)
    indexed.state.failReads = false
    expect(await loadPersistedWordWorkspace(fallback.sessionId)).toEqual(unread)
    expect(indexed.values.get(fallback.sessionId)).toEqual(unread)
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(fallback)
  })

})
