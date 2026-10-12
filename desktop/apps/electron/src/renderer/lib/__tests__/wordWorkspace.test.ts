import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { WordDomainStore, WordWorkspaceState } from '../wordDomain'
import type { WordWorkspacePersister } from '../wordPersistence'
import { createWordIndexedDbMemory } from '../../test-fixtures/wordIndexedDb'

GlobalRegistrator.register()

const { createWordDomainStore, createWordWorkspace } = await import('../wordDomain')
const { appendTextBlockToSnapshot, getUniverDocumentText } = await import('../wordUniverModel')
const { createWordWorkspacePersister, loadPersistedWordWorkspace } = await import('../wordPersistence')

afterAll(async () => { await GlobalRegistrator.unregister() })

function createStore() {
  return createWordDomainStore(createWordWorkspace('word-session', 'Untitled'), { defaultTitle: 'Untitled' })
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function closeWorkspace(store: WordDomainStore, operation: 'closeAll' | 'document.close' | 'closeDocumentTab', documentId: string) {
  if (operation === 'closeAll') return store.closeAllDocuments()
  if (operation === 'document.close') return store.dispatch({ type: 'document.close', documentId })
  return store.closeDocumentTab(documentId)
}

async function withPersistedStore(sessionId: string, run: (store: WordDomainStore, indexed: ReturnType<typeof createWordIndexedDbMemory>, persister: WordWorkspacePersister) => Promise<void>) {
  const originalIndexedDb = Object.getOwnPropertyDescriptor(window, 'indexedDB')
  const indexed = createWordIndexedDbMemory()
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: indexed.factory })
  const initial = createWordWorkspace(sessionId, 'Retained document')
  const persister = createWordWorkspacePersister(sessionId, () => undefined)
  const store = createWordDomainStore(initial, {
    defaultTitle: 'Untitled',
    confirmClose: async () => 'discard',
    onChange: (state) => persister.save(state),
    persistWorkspace: (state) => persister.persist(state),
  })
  try {
    await persister.persist(initial)
    await run(store, indexed, persister)
  } finally {
    store.dispose()
    persister.dispose()
    await persister.flush().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (originalIndexedDb) Object.defineProperty(window, 'indexedDB', originalIndexedDb)
    else Reflect.deleteProperty(window, 'indexedDB')
  }
}

describe('Word common workspace runtime', () => {
  it('decides the final tab inside the close queue after an unfinished editor flush', async () => {
    const store = createStore()
    const firstId = store.getSnapshot().activeDocumentId
    await store.dispatch({ type: 'document.create', title: 'Second' })
    const secondId = store.getSnapshot().activeDocumentId
    const checkpoint = deferred()
    const detach = store.registerEditorCommandHandler(secondId, async () => true, () => checkpoint.promise)
    const firstClose = store.closeDocumentTab(firstId)
    const finalClose = store.closeDocumentTab(secondId)
    expect(store.getSnapshot().documents).toHaveLength(2)
    checkpoint.resolve()
    expect(await firstClose).toEqual({ ok: true, value: { closeSurface: false } })
    expect(await finalClose).toEqual({ ok: true, value: { closeSurface: true } })
    expect(store.getSnapshot().documents.map((document) => document.id)).toEqual([secondId])
    detach()
    store.dispose()
  })

  it('includes a queued new document when deciding whether a close should release the surface', async () => {
    const store = createStore()
    const firstId = store.getSnapshot().activeDocumentId
    const checkpoint = deferred()
    const detach = store.registerEditorCommandHandler(firstId, async () => true, () => checkpoint.promise)
    const creating = store.dispatch({ type: 'document.create', title: 'Queued document' })
    const closing = store.closeDocumentTab(firstId)
    checkpoint.resolve()
    expect((await creating).ok).toBe(true)
    expect(await closing).toEqual({ ok: true, value: { closeSurface: false } })
    expect(store.getSnapshot().documents.map((document) => document.title)).toEqual(['Queued document'])
    detach()
    store.dispose()
  })

  it('publishes immutable metadata from the authoritative domain without duplicating document content', async () => {
    const store = createStore()
    const reader = store.api.workspace
    const initial = reader.getSnapshot()
    const revisions: number[] = []
    const unsubscribe = reader.subscribe((snapshot) => revisions.push(snapshot.revision))
    expect(initial).toMatchObject({ appKind: 'word', sessionId: 'word-session', revision: 0 })
    expect(initial.documents[0]).toEqual({ id: initial.activeDocumentId!, title: 'Untitled', revision: 0, dirty: true })
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.documents)).toBe(true)
    expect(Object.isFrozen(initial.documents[0])).toBe(true)
    expect(reader.supports('document.update')).toBe(true)
    expect(reader.supports('document.saveAs')).toBe(true)

    await store.dispatch({ type: 'document.activate', documentId: initial.activeDocumentId })
    expect(reader.getSnapshot()).toBe(initial)
    const document = store.getSnapshot().documents[0]!
    store.commitEditorSnapshot(document.id, document.snapshot)
    expect(reader.getSnapshot()).toBe(initial)

    await store.dispatch({ type: 'document.update', title: 'Renamed' })
    const changed = reader.getSnapshot()
    expect(changed.revision).toBe(1)
    expect(changed.documents[0]).toMatchObject({ title: 'Renamed', revision: 1 })
    expect(initial.documents[0]?.title).toBe('Untitled')
    expect(revisions).toEqual([1])
    unsubscribe()
    await store.dispatch({ type: 'document.update', title: 'Again' })
    expect(revisions).toEqual([1])
  })

  it('rejects another Session and stale workspace or document revisions before applying changes', async () => {
    const store = createStore()
    const initial = store.api.workspace.getSnapshot()
    expect(await store.dispatch({ type: 'document.update', title: 'Wrong owner', sessionId: 'other' }))
      .toMatchObject({ ok: false, error: { code: 'session_mismatch' } })
    expect(await store.dispatch({ type: 'document.update', title: 'Correct', expectedRevision: initial.revision, expectedDocumentRevision: 0 }))
      .toMatchObject({ ok: true })
    expect(await store.dispatch({ type: 'document.update', title: 'Stale workspace', expectedRevision: initial.revision }))
      .toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
    expect(await store.dispatch({ type: 'document.update', title: 'Stale document', expectedDocumentRevision: 0 }))
      .toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
    expect(await store.dispatch({ type: 'document.update', title: 'Invalid revision', expectedRevision: -1 }))
      .toMatchObject({ ok: false, error: { code: 'invalid_revision' } })
    expect(await store.dispatch({ type: 'document.close' })).toMatchObject({ ok: false, error: { code: 'invalid_document_id' } })
    expect(store.getSnapshot().documents[0]?.title).toBe('Correct')
  })

  it('captures an omitted document target before queued tab changes and snapshots command payloads', async () => {
    const store = createStore()
    const originalId = store.getSnapshot().activeDocumentId
    const pending = deferred()
    store.registerEditorCommandHandler(originalId, async () => { await pending.promise; return true })
    const editing = store.dispatch({ type: 'editor.format', action: 'bold' })
    const creating = store.dispatch({ type: 'document.create', title: 'Second document' })
    const command = { type: 'document.append', text: 'Belongs to the first document' }
    const appending = store.dispatch(command)
    command.text = 'Mutated after submission'
    pending.resolve()
    expect((await editing).ok).toBe(true)
    expect((await creating).ok).toBe(true)
    expect((await appending).ok).toBe(true)
    const workspace = store.getSnapshot()
    expect(workspace.activeDocumentId).not.toBe(originalId)
    expect(getUniverDocumentText(workspace.documents.find((item) => item.id === originalId)!.snapshot))
      .toContain('Belongs to the first document')
    expect(getUniverDocumentText(workspace.documents.find((item) => item.id === workspace.activeDocumentId)!.snapshot))
      .not.toContain('Belongs')
  })

  it('rejects a queued command whose captured document was closed', async () => {
    const store = createStore()
    const documentId = store.getSnapshot().activeDocumentId
    const pending = deferred()
    store.registerEditorCommandHandler(documentId, async () => { await pending.promise; return true })
    const editing = store.dispatch({ type: 'editor.format', action: 'copy' })
    const closing = store.dispatch({ type: 'document.close', documentId })
    const appending = store.dispatch({ type: 'document.append', text: 'Must not create a replacement' })
    pending.resolve()
    await editing
    await closing
    expect(await appending).toMatchObject({ ok: false, error: { code: 'document_not_found' } })
    expect(store.getSnapshot().documents).toEqual([])
  })

  it('binds native operations to one editor instance and rejects replacement after asynchronous preparation', async () => {
    const store = createStore()
    const documentId = store.getSnapshot().activeDocumentId
    const pending = deferred()
    let applied = 0
    store.registerEditorCommandHandler(documentId, async (_command, context) => {
      await pending.promise
      context.assertCurrent()
      applied += 1
      return true
    })
    const first = store.dispatch({ type: 'editor.format', action: 'bold' })
    const second = store.dispatch({ type: 'editor.format', action: 'italic' })
    store.registerEditorCommandHandler(documentId, async () => { applied += 1; return true })
    pending.resolve()
    expect(await first).toMatchObject({ ok: false, error: { code: 'editor_unavailable' } })
    expect(await second).toMatchObject({ ok: false, error: { code: 'editor_unavailable' } })
    expect(applied).toBe(0)
    expect((await store.dispatch({ type: 'editor.format', action: 'bold' })).ok).toBe(true)
    expect(applied).toBe(1)
  })

  it('applies nested reference changes through a guarded reducer without entering the public queue again', async () => {
    const store = createStore()
    const documentId = store.getSnapshot().activeDocumentId
    await store.dispatch({ type: 'document.citation.add', citation: { id: 'reference', text: 'First source' } })
    store.registerEditorCommandHandler(documentId, async (command, context) => {
      if (command.type !== 'editor.reference.update' && command.type !== 'editor.reference.remove') return false
      return context.applyReferenceCommand(command)
    })
    expect(await store.dispatch({ type: 'editor.reference.update', kind: 'citation', id: 'reference', text: 'Revised source' }))
      .toMatchObject({ ok: true })
    expect(store.getSnapshot().documents[0]?.citations).toEqual([{ id: 'reference', text: 'Revised source' }])
    expect(await store.dispatch({ type: 'editor.reference.remove', kind: 'citation', id: 'reference' })).toMatchObject({ ok: true })
    expect(store.getSnapshot().documents[0]?.citations).toEqual([])
  })

  it('flushes pending native edits before a domain mutation so recent typing is preserved', async () => {
    const store = createStore()
    const document = store.getSnapshot().documents[0]!
    let flushes = 0
    store.registerEditorCommandHandler(document.id, async () => true, async () => {
      if (flushes++ === 0) store.commitEditorSnapshot(document.id, appendTextBlockToSnapshot(document.snapshot, 'Native typing', 'paragraph'))
    })
    expect((await store.dispatch({ type: 'document.append', text: 'Domain append' })).ok).toBe(true)
    const text = getUniverDocumentText(store.getSnapshot().documents[0]!.snapshot)
    expect(text).toContain('Native typing')
    expect(text).toContain('Domain append')
  })

  it('flushes native content for workspace.get while metadata reads remain immediate', async () => {
    const store = createStore()
    const document = store.getSnapshot().documents[0]!
    let flushes = 0
    store.registerEditorCommandHandler(document.id, async () => true, async () => {
      if (flushes++ === 0) store.commitEditorSnapshot(document.id, appendTextBlockToSnapshot(document.snapshot, 'Pending native typing', 'paragraph'))
    })
    expect(store.api.workspace.getSnapshot().documents[0]!.revision).toBe(0)
    expect(flushes).toBe(0)
    const contents = await store.dispatch({ type: 'workspace.get' })
    expect(contents.ok).toBe(true)
    if (contents.ok) expect(getUniverDocumentText(contents.state.documents[0]!.snapshot)).toContain('Pending native typing')
    expect(flushes).toBe(1)
    expect(store.api.workspace.getSnapshot().documents[0]!.revision).toBe(1)
    expect(flushes).toBe(1)
    store.dispose()
  })

  for (const operation of ['closeAll', 'document.close', 'closeDocumentTab'] as const) {
    it(`retains the live inventory when ${operation} cannot persist its proposed close`, async () => {
      const checkpoint = deferred()
      const enteredCheckpoint = deferred()
      const scheduled: WordWorkspaceState[] = []
      let proposed: WordWorkspaceState | null = null
      const store = createWordDomainStore(createWordWorkspace('checkpoint-failure', 'Untitled'), {
        defaultTitle: 'Untitled',
        confirmClose: async () => 'discard',
        onChange: (workspace) => { scheduled.push(workspace) },
        persistWorkspace: async (workspace) => {
          proposed = workspace
          enteredCheckpoint.resolve()
          await checkpoint.promise
        },
      })
      const initial = store.getSnapshot()
      const closing = closeWorkspace(store, operation, initial.activeDocumentId)
      await enteredCheckpoint.promise
      expect(proposed!.documents).toHaveLength(0)
      expect(store.getSnapshot()).toBe(initial)
      expect(store.api.workspace.getSnapshot().documents).toHaveLength(1)
      expect(scheduled).toEqual([])
      checkpoint.reject(new Error('Recovery storage unavailable'))
      expect(await closing).toMatchObject({ ok: false, error: { code: 'checkpoint_failed' } })
      expect(store.getSnapshot()).toBe(initial)
      expect(scheduled).toEqual([initial])
      store.dispose()
    })

    it(`rechecks native typing after the durable ${operation} checkpoint and restores its open inventory`, async () => {
      const checkpoint = deferred()
      const enteredCheckpoint = deferred()
      const scheduled: WordWorkspaceState[] = []
      let nativePending = false
      const store = createWordDomainStore(createWordWorkspace('checkpoint-race', 'Untitled'), {
        defaultTitle: 'Untitled',
        confirmClose: async () => 'discard',
        onChange: (workspace) => { scheduled.push(workspace) },
        persistWorkspace: async () => { enteredCheckpoint.resolve(); await checkpoint.promise },
      })
      const document = store.getSnapshot().documents[0]!
      store.registerEditorCommandHandler(document.id, async () => true, async () => {
        if (!nativePending) return
        nativePending = false
        store.commitEditorSnapshot(document.id, appendTextBlockToSnapshot(document.snapshot, 'Typed during the checkpoint', 'paragraph'))
      })
      const closing = closeWorkspace(store, operation, document.id)
      await enteredCheckpoint.promise
      nativePending = true
      checkpoint.resolve()
      expect(await closing).toMatchObject({ ok: false, error: { code: 'close_canceled' } })
      expect(store.getSnapshot().documents).toHaveLength(1)
      expect(getUniverDocumentText(store.getSnapshot().documents[0]!.snapshot)).toContain('Typed during the checkpoint')
      expect(scheduled.at(-1)).toBe(store.getSnapshot())
      expect(scheduled.every((workspace) => workspace.documents.length === 1)).toBe(true)
      store.dispose()
    })

    it(`durably restores the latest native edits before ${operation} acknowledges cancellation`, async () => {
      await withPersistedStore(`durable-cancellation-${operation}`, async (store, indexed) => {
        const documentId = store.getSnapshot().activeDocumentId
        let nativePending: string | null = null
        let proposedWritten = false
        let restoreTypingQueued = false
        indexed.state.beforeWrite = async () => {
          const writing = indexed.writes.at(-1) as WordWorkspaceState
          if (writing.documents.length === 0) {
            proposedWritten = true
            nativePending = 'Typed after the proposed close'
          } else if (proposedWritten && !restoreTypingQueued) {
            restoreTypingQueued = true
            nativePending = 'Typed during retained inventory restoration'
          }
        }
        store.registerEditorCommandHandler(documentId, async () => true, async () => {
          if (!nativePending) return
          const document = store.getSnapshot().documents[0]!
          const text = nativePending
          nativePending = null
          store.commitEditorSnapshot(documentId, appendTextBlockToSnapshot(document.snapshot, text, 'paragraph'))
        })
        expect(await closeWorkspace(store, operation, documentId)).toMatchObject({ ok: false, error: { code: 'close_canceled' } })
        expect(restoreTypingQueued).toBe(true)
        const retained = store.getSnapshot()
        const text = getUniverDocumentText(retained.documents[0]!.snapshot)
        expect(text).toContain('Typed after the proposed close')
        expect(text).toContain('Typed during retained inventory restoration')
        // No scheduler flush or debounce wait may be needed after cancellation returns.
        expect(indexed.records.get(retained.sessionId)).toEqual(retained)
        expect(await loadPersistedWordWorkspace(retained.sessionId)).toEqual(retained)
      })
    })

    it(`durably restores the open inventory before ${operation} reports a final native flush failure`, async () => {
      await withPersistedStore(`failed-final-flush-${operation}`, async (store, indexed) => {
        const retained = store.getSnapshot()
        const restoration = deferred()
        const enteredRestoration = deferred()
        let proposedWritten = false
        let failedFlushes = 0
        indexed.state.beforeWrite = async () => {
          if ((indexed.writes.at(-1) as WordWorkspaceState).documents.length === 0) proposedWritten = true
          else if (proposedWritten) { enteredRestoration.resolve(); await restoration.promise }
        }
        store.registerEditorCommandHandler(retained.activeDocumentId, async () => true, async () => {
          if (!proposedWritten) return
          failedFlushes++
          throw new Error('The Word editor could not synchronize its document.')
        })
        let acknowledged = false
        const closing = closeWorkspace(store, operation, retained.activeDocumentId).then((result) => { acknowledged = true; return result })
        try {
          await enteredRestoration.promise
          expect(acknowledged).toBe(false)
          expect(store.getSnapshot()).toBe(retained)
          expect((indexed.records.get(retained.sessionId) as WordWorkspaceState).documents).toHaveLength(0)
        } finally {
          restoration.resolve()
        }
        expect(await closing).toMatchObject({
          ok: false,
          error: { code: 'checkpoint_failed', message: 'The Word editor could not synchronize its document.' },
        })
        expect(failedFlushes).toBe(1)
        expect(store.getSnapshot()).toBe(retained)
        // The failed close must already be recoverable without a debounce or manual flush.
        expect(indexed.records.get(retained.sessionId)).toEqual(retained)
        expect(await loadPersistedWordWorkspace(retained.sessionId)).toEqual(retained)
      })
    })

    it(`retains native edits arriving during ${operation} recovery after a final flush failure`, async () => {
      await withPersistedStore(`failed-final-flush-race-${operation}`, async (store, indexed) => {
        const documentId = store.getSnapshot().activeDocumentId
        let proposedWritten = false
        let restoreTypingCommitted = false
        let failedFlushes = 0
        indexed.state.beforeWrite = async () => {
          const writing = indexed.writes.at(-1) as WordWorkspaceState
          if (writing.documents.length === 0) {
            proposedWritten = true
          } else if (proposedWritten && !restoreTypingCommitted) {
            restoreTypingCommitted = true
            const document = store.getSnapshot().documents[0]!
            store.commitEditorSnapshot(documentId, appendTextBlockToSnapshot(document.snapshot, 'Typed during failed-close recovery', 'paragraph'))
          }
        }
        store.registerEditorCommandHandler(documentId, async () => true, async () => {
          if (!proposedWritten) return
          failedFlushes++
          throw new Error('The Word editor could not synchronize its document.')
        })
        expect(await closeWorkspace(store, operation, documentId)).toMatchObject({ ok: false, error: { code: 'checkpoint_failed' } })
        expect(restoreTypingCommitted).toBe(true)
        expect(failedFlushes).toBe(1)
        const retained = store.getSnapshot()
        expect(getUniverDocumentText(retained.documents[0]!.snapshot)).toContain('Typed during failed-close recovery')
        expect(indexed.records.get(retained.sessionId)).toEqual(retained)
        expect(await loadPersistedWordWorkspace(retained.sessionId)).toEqual(retained)
      })
    })

    it(`retains a retry when ${operation} cannot restore recovery after a final native flush failure`, async () => {
      await withPersistedStore(`failed-final-flush-restoration-${operation}`, async (store, indexed, persister) => {
        const retained = store.getSnapshot()
        let proposedWritten = false
        indexed.state.beforeWrite = async () => {
          if ((indexed.writes.at(-1) as WordWorkspaceState).documents.length === 0) proposedWritten = true
          else if (proposedWritten) indexed.state.failWrites = true
        }
        store.registerEditorCommandHandler(retained.activeDocumentId, async () => true, async () => {
          if (proposedWritten) throw new Error('The Word editor could not synchronize its document.')
        })
        expect(await closeWorkspace(store, operation, retained.activeDocumentId)).toMatchObject({ ok: false, error: { code: 'checkpoint_failed' } })
        expect(store.getSnapshot()).toBe(retained)
        expect(persister.getSnapshot().pendingCount).toBeGreaterThan(0)
        expect((indexed.records.get(retained.sessionId) as WordWorkspaceState).documents).toHaveLength(0)
        indexed.state.beforeWrite = null
        indexed.state.failWrites = false
        await new Promise((resolve) => setTimeout(resolve, 0))
        await persister.flush()
        expect(await loadPersistedWordWorkspace(retained.sessionId)).toEqual(retained)
      })
    })

    it(`reports a failed ${operation} cancellation restoration and retains a recoverable retry`, async () => {
      await withPersistedStore(`failed-restoration-${operation}`, async (store, indexed, persister) => {
        const documentId = store.getSnapshot().activeDocumentId
        let proposedWritten = false
        let nativePending = false
        indexed.state.beforeWrite = async () => {
          const writing = indexed.writes.at(-1) as WordWorkspaceState
          if (writing.documents.length === 0) {
            proposedWritten = true
            nativePending = true
          } else if (proposedWritten) {
            indexed.state.failWrites = true
          }
        }
        store.registerEditorCommandHandler(documentId, async () => true, async () => {
          if (!nativePending) return
          nativePending = false
          const document = store.getSnapshot().documents[0]!
          store.commitEditorSnapshot(documentId, appendTextBlockToSnapshot(document.snapshot, 'Retain input after failed restoration', 'paragraph'))
        })
        expect(await closeWorkspace(store, operation, documentId)).toMatchObject({ ok: false, error: { code: 'checkpoint_failed' } })
        const retained = store.getSnapshot()
        expect(retained.documents).toHaveLength(1)
        expect(getUniverDocumentText(retained.documents[0]!.snapshot)).toContain('Retain input after failed restoration')
        expect(persister.getSnapshot().pendingCount).toBeGreaterThan(0)
        indexed.state.beforeWrite = null
        indexed.state.failWrites = false
        await new Promise((resolve) => setTimeout(resolve, 0))
        await persister.flush()
        expect(await loadPersistedWordWorkspace(retained.sessionId)).toEqual(retained)
      })
    })
  }

  it('publishes a closed inventory only after its durable checkpoint succeeds', async () => {
    const checkpoint = deferred()
    const enteredCheckpoint = deferred()
    const store = createWordDomainStore(createWordWorkspace('checkpoint-success', 'Untitled'), {
      defaultTitle: 'Untitled',
      confirmClose: async () => 'discard',
      persistWorkspace: async () => { enteredCheckpoint.resolve(); await checkpoint.promise },
    })
    const inventories: number[] = []
    store.subscribe(() => inventories.push(store.getSnapshot().documents.length))
    const closing = store.closeAllDocuments()
    await enteredCheckpoint.promise
    expect(store.getSnapshot().documents).toHaveLength(1)
    expect(inventories).toEqual([])
    checkpoint.resolve()
    expect(await closing).toMatchObject({ ok: true, state: { documents: [] } })
    expect(inventories).toEqual([0])
    store.dispose()
  })

  it('retains an inactive tab when its checkpoint would miss new typing in the remaining active tab', async () => {
    const checkpoint = deferred()
    const enteredCheckpoint = deferred()
    let nativePending = false
    const store = createWordDomainStore(createWordWorkspace('remaining-document-race', 'First'), {
      defaultTitle: 'Untitled',
      confirmClose: async () => 'discard',
      persistWorkspace: async () => { enteredCheckpoint.resolve(); await checkpoint.promise },
    })
    const closingId = store.getSnapshot().activeDocumentId
    await store.dispatch({ type: 'document.create', title: 'Second' })
    const active = store.getSnapshot().documents[1]!
    store.registerEditorCommandHandler(active.id, async () => true, async () => {
      if (!nativePending) return
      nativePending = false
      store.commitEditorSnapshot(active.id, appendTextBlockToSnapshot(active.snapshot, 'Keep this active input', 'paragraph'))
    })
    const closing = store.closeDocumentTab(closingId)
    await enteredCheckpoint.promise
    nativePending = true
    checkpoint.resolve()
    expect(await closing).toMatchObject({ ok: false, error: { code: 'close_canceled' } })
    expect(store.getSnapshot().documents).toHaveLength(2)
    expect(store.getSnapshot().activeDocumentId).toBe(active.id)
    expect(getUniverDocumentText(store.getSnapshot().documents[1]!.snapshot)).toContain('Keep this active input')
    store.dispose()
  })

  it('rechecks expected revisions after flushing pending native input', async () => {
    const store = createStore()
    const document = store.getSnapshot().documents[0]!
    store.registerEditorCommandHandler(document.id, async () => true, async () => {
      store.commitEditorSnapshot(document.id, appendTextBlockToSnapshot(document.snapshot, 'Native typing', 'paragraph'))
    })
    expect(await store.dispatch({ type: 'document.append', text: 'Stale write', expectedDocumentRevision: 0 }))
      .toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
    const text = getUniverDocumentText(store.getSnapshot().documents[0]!.snapshot)
    expect(text).toContain('Native typing')
    expect(text).not.toContain('Stale write')
  })

  it('waits for both active and queued operations before reporting idle', async () => {
    const store = createStore()
    const pending = deferred()
    store.registerEditorCommandHandler(store.getSnapshot().activeDocumentId, async () => { await pending.promise; return true })
    const editing = store.dispatch({ type: 'editor.format', action: 'bold' })
    const rename = store.dispatch({ type: 'document.update', title: 'Saved last' })
    let idle = false
    const idlePromise = store.whenIdle().then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)
    pending.resolve()
    await Promise.all([editing, rename, idlePromise])
    expect(idle).toBe(true)
    expect(store.getSnapshot().documents[0]?.title).toBe('Saved last')
  })

  it('invalidates old Session operations on disposal and keeps a failure from blocking later commands', async () => {
    const store = createStore()
    const pending = deferred()
    store.registerEditorCommandHandler(store.getSnapshot().activeDocumentId, async (_command, context) => {
      await pending.promise
      context.assertCurrent()
      return true
    })
    const editing = store.dispatch({ type: 'editor.format', action: 'bold' })
    const rename = store.dispatch({ type: 'document.update', title: 'Obsolete Session' })
    store.dispose()
    pending.resolve()
    expect(await editing).toMatchObject({ ok: false, error: { code: 'runtime_disposed' } })
    expect(await rename).toMatchObject({ ok: false, error: { code: 'runtime_disposed' } })
    expect(store.getSnapshot().documents[0]?.title).toBe('Untitled')
    await store.whenIdle()
  })
})
