import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { createWordDomainStore, createWordWorkspace } = await import('../wordDomain')
const { appendTextBlockToSnapshot, getUniverDocumentText } = await import('../wordUniverModel')

afterAll(async () => { await GlobalRegistrator.unregister() })

function createStore() {
  return createWordDomainStore(createWordWorkspace('word-session', 'Untitled'), { defaultTitle: 'Untitled' })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Word common workspace runtime', () => {
  it('publishes immutable metadata from the authoritative domain without duplicating document content', async () => {
    const store = createStore()
    const reader = store.api.workspace
    const initial = reader.getSnapshot()
    const revisions: number[] = []
    const unsubscribe = reader.subscribe((snapshot) => revisions.push(snapshot.revision))
    expect(initial).toMatchObject({ appKind: 'word', sessionId: 'word-session', revision: 0 })
    expect(initial.documents[0]).toEqual({ id: initial.activeDocumentId!, title: 'Untitled', revision: 0, dirty: null })
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.documents)).toBe(true)
    expect(Object.isFrozen(initial.documents[0])).toBe(true)
    expect(reader.supports('document.update')).toBe(true)
    expect(reader.supports('document.saveAs')).toBe(false)

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
