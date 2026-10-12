import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { WordWorkspacePersister } from '../wordPersistence'
import { createWordIndexedDbMemory } from '../../test-fixtures/wordIndexedDb'

GlobalRegistrator.register()
const { createEmptyWordWorkspace, createWordWorkspace } = await import('../wordDomain')
const { createWordWorkspacePersister, loadPersistedWordWorkspace } = await import('../wordPersistence')
const originalIndexedDb = window.indexedDB
const originalLocalStorage = window.localStorage
const persisters = new Set<WordWorkspacePersister>()

function persisterFor(sessionId: string, onStatus: (status: string) => void = () => undefined) {
  const persister = createWordWorkspacePersister(sessionId, onStatus)
  persisters.add(persister)
  return persister
}

afterEach(async () => {
  for (const persister of persisters) persister.dispose()
  await Promise.all([...persisters].map((persister) => persister.flush().catch(() => undefined)))
  persisters.clear()
  await new Promise((resolve) => setTimeout(resolve, 0))
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: originalIndexedDb })
  Object.defineProperty(window, 'localStorage', { configurable: true, value: originalLocalStorage })
  originalLocalStorage.clear()
})
afterAll(() => GlobalRegistrator.unregister())

function installIndexedWorkspaceStorage() {
  const memory = createWordIndexedDbMemory()
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: memory.factory })
  return memory
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('Word structured workspace persistence', () => {
  it('stores the current structured workspace separately from source-file saving', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const statuses: string[] = []
    const workspace = createWordWorkspace('session-persisted', 'Untitled')
    const persister = persisterFor(workspace.sessionId, (status) => statuses.push(status))
    expect(await loadPersistedWordWorkspace(workspace.sessionId)).toBeNull()
    persister.save(workspace)
    await persister.flush()
    expect(statuses).toEqual(['saving', 'saved'])
    expect(indexed.records.get(workspace.sessionId)).toEqual(workspace)
    expect(await loadPersistedWordWorkspace(workspace.sessionId)).toEqual(workspace)
    expect(persister.getSnapshot().policy).toEqual({
      appKind: 'word', sessionId: workspace.sessionId, kind: 'workspace', storage: 'browser-storage', automatic: true,
    })
    expect(workspace.documents[0]!.sourcePath).toBeUndefined()
    expect(workspace.documents[0]!.savedContentVersion).toBeUndefined()
    expect(indexed.connections.every((connection) => connection.name === 'bridgic-word' && connection.version === 1)).toBe(true)
  })

  it('coalesces pending snapshots and drains edits queued during an in-flight write', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const first = createWordWorkspace('session-concurrent-save', 'First')
    const second = { ...first, documents: first.documents.map((document) => ({ ...document, title: 'Second' })) }
    const latest = { ...second, documents: second.documents.map((document) => ({ ...document, title: 'Latest' })) }
    const gate = deferred()
    const started = deferred()
    indexed.state.beforeWrite = async () => { started.resolve(); await gate.promise }
    const persister = persisterFor(first.sessionId)
    persister.save(first)
    persister.save(second)
    const flushing = persister.flush()
    await started.promise
    persister.save(latest)
    expect(persister.getSnapshot()).toMatchObject({ status: 'saving', pendingCount: 2 })
    gate.resolve()
    await flushing
    expect(indexed.writes).toEqual([second, latest])
    expect(await loadPersistedWordWorkspace(first.sessionId)).toEqual(latest)
    expect(persister.getSnapshot()).toMatchObject({ status: 'saved', pendingCount: 0 })
  })

  it('acknowledges an explicit empty close checkpoint only after its transaction commits', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const workspace = createWordWorkspace('session-close', 'Retained document')
    const persister = persisterFor(workspace.sessionId)
    await persister.persist(workspace)
    const gate = deferred()
    const started = deferred()
    indexed.state.beforeWrite = async () => { started.resolve(); await gate.promise }
    const empty = createEmptyWordWorkspace(workspace.sessionId)
    let acknowledged = false
    const closing = persister.persist(empty).then(() => { acknowledged = true })
    await started.promise
    expect(acknowledged).toBe(false)
    expect(indexed.records.get(workspace.sessionId)).toEqual(workspace)
    gate.resolve()
    await closing
    expect(acknowledged).toBe(true)
    expect(await loadPersistedWordWorkspace(workspace.sessionId)).toEqual(empty)
  })

  it('keeps explicit checkpoint receipts separate from later scheduled edits', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const workspace = createWordWorkspace('session-explicit-order', 'First')
    const gate = deferred()
    const started = deferred()
    indexed.state.beforeWrite = async () => { started.resolve(); await gate.promise }
    const persister = persisterFor(workspace.sessionId)
    const firstWrite = persister.persist(workspace)
    await started.promise
    const empty = createEmptyWordWorkspace(workspace.sessionId)
    const closeWrite = persister.persist(empty)
    const newer = { ...workspace, documents: workspace.documents.map((document) => ({ ...document, title: 'Newer' })) }
    persister.save(newer)
    gate.resolve()
    await Promise.all([firstWrite, closeWrite, persister.flush()])
    expect(indexed.writes).toEqual([workspace, empty, newer])
    expect(indexed.records.get(workspace.sessionId)).toEqual(newer)
  })

  it('rejects a failed close checkpoint without replacing the durable open workspace and permits retry', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const workspace = createWordWorkspace('session-close-error', 'Retained document')
    const statuses: string[] = []
    const persister = persisterFor(workspace.sessionId, (status) => statuses.push(status))
    await persister.persist(workspace)
    indexed.state.failWrites = true
    const empty = createEmptyWordWorkspace(workspace.sessionId)
    await expect(persister.persist(empty)).rejects.toThrow('Storage transaction failed')
    await expect(persister.flush()).rejects.toThrow('Storage transaction failed')
    expect(persister.getSnapshot()).toMatchObject({ status: 'error', error: { message: 'Storage transaction failed' } })
    expect(await loadPersistedWordWorkspace(workspace.sessionId)).toEqual(workspace)
    expect(statuses.at(-1)).toBe('error')
    indexed.state.failWrites = false
    await persister.persist(empty)
    await persister.flush()
    expect(await loadPersistedWordWorkspace(workspace.sessionId)).toEqual(empty)
    expect(statuses.at(-1)).toBe('saved')
  })

  it('reports IndexedDB unavailability without reading or writing localStorage', async () => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined })
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('localStorage must not be accessed') } })
    const persister = persisterFor('session-unavailable')
    persister.save(createWordWorkspace('session-unavailable', 'Report'))
    await expect(persister.flush()).rejects.toThrow('IndexedDB is unavailable')
    expect(persister.getSnapshot().status).toBe('error')
    await expect(loadPersistedWordWorkspace('session-unavailable')).rejects.toThrow('IndexedDB is unavailable')
  })

  it('reports unreadable IndexedDB records without rewriting them and allows a later read retry', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const workspace = createWordWorkspace('session-read-error', 'Retained document')
    indexed.records.set(workspace.sessionId, workspace)
    indexed.state.failReads = true
    await expect(loadPersistedWordWorkspace(workspace.sessionId)).rejects.toThrow('Storage read failed')
    expect(indexed.records.get(workspace.sessionId)).toEqual(workspace)
    expect(indexed.writes).toEqual([])
    indexed.state.failReads = false
    expect(await loadPersistedWordWorkspace(workspace.sessionId)).toEqual(workspace)
    indexed.state.failOpen = true
    await expect(loadPersistedWordWorkspace(workspace.sessionId)).rejects.toThrow('Storage open failed')
  })

  it('rejects incompatible or damaged current records instead of inventing a blank workspace', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const workspace = createWordWorkspace('session-invalid', 'Report')
    const document = workspace.documents[0]!
    const invalidRecords = [
      { ...workspace, version: 1 },
      { ...workspace, sessionId: 'another-session' },
      { ...workspace, activeDocumentId: 'missing' },
      { ...workspace, documents: [document, document] },
      { ...workspace, documents: [{ ...document, snapshot: { ...document.snapshot, body: {} } }] },
      { ...workspace, documents: [{ ...document, snapshot: { ...document.snapshot, id: 'another-document' } }] },
      { ...workspace, documents: [{ ...document, contentVersion: -1 }] },
      { ...workspace, documents: [{ ...document, sourceMtimeMs: Number.NaN }] },
      { ...createEmptyWordWorkspace(workspace.sessionId), activeDocumentId: document.id },
    ]
    for (const invalid of invalidRecords) {
      indexed.records.set(workspace.sessionId, invalid)
      await expect(loadPersistedWordWorkspace(workspace.sessionId)).rejects.toThrow()
      expect(indexed.records.get(workspace.sessionId)).toEqual(invalid)
    }
    expect(indexed.writes).toEqual([])
  })

  it('rejects cross-Session writes before scheduling them', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const persister = persisterFor('session-owner')
    const foreign = createWordWorkspace('another-session', 'Untitled')
    expect(() => persister.save(foreign)).toThrow('another Session')
    await expect(persister.persist(foreign)).rejects.toThrow('another Session')
    expect(persister.getSnapshot().pendingCount).toBe(0)
    expect(indexed.writes).toEqual([])
  })

  it('flushes accepted work on disposal, closes its connection, and rejects new explicit writes', async () => {
    const indexed = installIndexedWorkspaceStorage()
    const workspace = createWordWorkspace('session-disposed', 'Final snapshot')
    const persister = persisterFor(workspace.sessionId)
    const observed: string[] = []
    persister.subscribe((snapshot) => observed.push(snapshot.status))
    persister.save(workspace)
    persister.dispose()
    persister.save(createEmptyWordWorkspace(workspace.sessionId))
    await expect(persister.persist(workspace)).rejects.toMatchObject({ code: 'disposed' })
    await persister.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(indexed.records.get(workspace.sessionId)).toEqual(workspace)
    expect(indexed.state.closed).toBe(1)
    expect(persister.getSnapshot().status).toBe('disposed')
    expect(observed).toEqual(['pending'])
  })
})
