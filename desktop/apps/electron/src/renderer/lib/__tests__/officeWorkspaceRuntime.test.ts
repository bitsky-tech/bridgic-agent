import { describe, expect, it } from 'bun:test'
import {
  createOfficeOperationQueue,
  createOfficeWorkspaceRuntime,
  OfficeOperationError,
  type OfficeWorkspaceInventory,
  type OfficeWorkspaceSnapshot,
} from '../office/officeWorkspaceRuntime'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(sessionId = 'session-a') {
  let inventory: OfficeWorkspaceInventory = {
    activeDocumentId: 'blank',
    documents: [{ id: 'blank', title: 'Untitled', revision: 0, dirty: null }],
  }
  const runtime = createOfficeWorkspaceRuntime({
    appKind: 'word', sessionId,
    capabilities: ['document.edit', 'document.close'],
    read: () => inventory,
  })
  return { runtime, setInventory: (next: OfficeWorkspaceInventory) => { inventory = next } }
}

describe('Office workspace runtime', () => {
  it('reports blank documents and unknown dirty state without exposing mutable authority', () => {
    const { runtime } = fixture()
    const snapshot = runtime.getSnapshot()
    expect(snapshot.documents).toEqual([{ id: 'blank', title: 'Untitled', revision: 0, dirty: null }])
    expect(snapshot.sessionId).toBe('session-a')
    expect(snapshot.activeDocumentId).toBe('blank')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.documents)).toBe(true)
    expect(Object.isFrozen(snapshot.documents[0])).toBe(true)
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true)
    expect(runtime.getSnapshot()).toBe(snapshot)
  })

  it('publishes versioned native changes even if a snapshot reader observes them first', () => {
    const { runtime, setInventory } = fixture()
    const observed: OfficeWorkspaceSnapshot[] = []
    const unsubscribe = runtime.subscribe((snapshot) => observed.push(snapshot))
    setInventory({ activeDocumentId: 'blank', documents: [{ id: 'blank', title: 'Edited', revision: 1, dirty: null }] })
    const current = runtime.getSnapshot()
    runtime.publish()
    runtime.publish()
    expect(observed).toEqual([current])
    expect(current.revision).toBe(1)
    unsubscribe()
    setInventory({ activeDocumentId: null, documents: [] })
    runtime.publish()
    expect(observed).toHaveLength(1)
    expect(runtime.getSnapshot().documents).toHaveLength(0)
  })

  it('rejects cross-Session and unsupported operations before touching an editor', async () => {
    const { runtime } = fixture()
    let applied = false
    const apply = () => { applied = true }
    expect(await runtime.execute({ sessionId: 'session-b', capability: 'document.edit' }, apply))
      .toMatchObject({ ok: false, error: { code: 'session_mismatch' } })
    expect(await runtime.execute({ sessionId: 'session-a', capability: 'document.save' }, apply))
      .toMatchObject({ ok: false, error: { code: 'unsupported_operation' } })
    expect(applied).toBe(false)
    expect(runtime.supports('document.edit')).toBe(true)
    expect(runtime.supports('document.save')).toBe(false)
  })

  it('orders asynchronous operations and keeps processing after structured or unexpected failure', async () => {
    const { runtime } = fixture()
    const gate = deferred<void>()
    const calls: string[] = []
    const operation = { sessionId: 'session-a', capability: 'document.edit', documentId: 'blank' }
    const first = runtime.execute(operation, async () => {
      calls.push('start')
      await gate.promise
      throw new OfficeOperationError('editor_unavailable', 'Editor unavailable')
    })
    const second = runtime.execute(operation, () => { calls.push('second'); throw new Error('Driver failure') })
    const third = runtime.execute(operation, () => { calls.push('third'); return 3 })
    expect(calls).toEqual(['start'])
    gate.resolve()
    expect(await first).toMatchObject({ ok: false, error: { code: 'editor_unavailable' } })
    expect(await second).toMatchObject({ ok: false, error: { code: 'operation_failed' } })
    expect(await third).toEqual({ ok: true, value: 3 })
    expect(calls).toEqual(['start', 'second', 'third'])
  })

  it('pins queued routing envelopes and checks document revisions when execution begins', async () => {
    const { runtime, setInventory } = fixture()
    const gate = deferred<void>()
    const first = runtime.execute({ sessionId: 'session-a', capability: 'document.edit' }, () => gate.promise)
    const operation = { sessionId: 'session-a', capability: 'document.edit', documentId: 'blank', expectedDocumentRevision: 0 }
    let applied = false
    const next = runtime.execute(operation, () => { applied = true })
    operation.sessionId = 'another-session'
    operation.expectedDocumentRevision = 1
    setInventory({ activeDocumentId: 'blank', documents: [{ id: 'blank', title: 'Untitled', revision: 1, dirty: null }] })
    runtime.publish()
    gate.resolve()
    await first
    expect(await next).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
    expect(applied).toBe(false)
  })

  it('does not retarget an operation when the active document changes', async () => {
    const { runtime, setInventory } = fixture()
    const gate = deferred<void>()
    void runtime.execute({ sessionId: 'session-a', capability: 'document.edit' }, () => gate.promise)
    const target = runtime.execute({ sessionId: 'session-a', capability: 'document.edit', documentId: 'blank' }, (context) => context.documentId)
    setInventory({
      activeDocumentId: 'other',
      documents: [
        { id: 'blank', title: 'Untitled', revision: 0, dirty: null },
        { id: 'other', title: 'Other', revision: 0, dirty: null },
      ],
    })
    gate.resolve()
    expect(await target).toEqual({ ok: true, value: 'blank' })
  })

  it('rejects work whose explicit document was closed while queued', async () => {
    const { runtime, setInventory } = fixture()
    const gate = deferred<void>()
    void runtime.execute({ sessionId: 'session-a', capability: 'document.close' }, () => gate.promise)
    let applied = false
    const target = runtime.execute({ sessionId: 'session-a', capability: 'document.edit', documentId: 'blank' }, () => { applied = true })
    setInventory({ activeDocumentId: null, documents: [] })
    gate.resolve()
    expect(await target).toMatchObject({ ok: false, error: { code: 'document_not_found' } })
    expect(applied).toBe(false)
  })

  it('lets async import preparation revalidate native edits before committing', async () => {
    const { runtime, setInventory } = fixture()
    const gate = deferred<void>()
    let applied = false
    const operation = runtime.execute({ sessionId: 'session-a', capability: 'document.edit', expectedRevision: 0 }, async (context) => {
      await gate.promise
      context.assertCurrent()
      applied = true
    })
    setInventory({ activeDocumentId: 'blank', documents: [{ id: 'blank', title: 'Typed', revision: 1, dirty: null }] })
    runtime.publish()
    gate.resolve()
    expect(await operation).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
    expect(applied).toBe(false)
  })

  it('keeps partial driver changes visible on failure', async () => {
    const { runtime, setInventory } = fixture()
    let reported = 0
    runtime.subscribe(() => { reported++ })
    const result = await runtime.execute({ sessionId: 'session-a', capability: 'document.edit' }, () => {
      setInventory({ activeDocumentId: 'blank', documents: [{ id: 'blank', title: 'Partial edit', revision: 1, dirty: null }] })
      throw new Error('Driver could not complete')
    })
    expect(result.ok).toBe(false)
    expect(reported).toBe(1)
    expect(runtime.getSnapshot().documents[0]!.title).toBe('Partial edit')
  })

  it('invalidates queued and asynchronously prepared operations on disposal', async () => {
    const { runtime } = fixture()
    const gate = deferred<void>()
    let applied = false
    const first = runtime.execute({ sessionId: 'session-a', capability: 'document.edit' }, async (context) => {
      await gate.promise
      context.assertCurrent()
      applied = true
    })
    const second = runtime.execute({ sessionId: 'session-a', capability: 'document.edit' }, () => { applied = true })
    runtime.dispose()
    gate.resolve()
    expect(await first).toMatchObject({ ok: false, error: { code: 'runtime_disposed' } })
    expect(await second).toMatchObject({ ok: false, error: { code: 'runtime_disposed' } })
    expect(applied).toBe(false)
  })

  it('does not let one Session block another and waits for its own queued operations', async () => {
    const first = fixture('first').runtime
    const second = fixture('second').runtime
    const gate = deferred<void>()
    void first.execute({ sessionId: 'first', capability: 'document.edit' }, () => gate.promise)
    let idle = false
    const wait = first.whenIdle().then(() => { idle = true })
    expect(await second.execute({ sessionId: 'second', capability: 'document.edit' }, () => 'done')).toEqual({ ok: true, value: 'done' })
    expect(idle).toBe(false)
    gate.resolve()
    await wait
    expect(idle).toBe(true)
  })

  it('rejects invalid revision preconditions instead of ignoring them', async () => {
    const { runtime } = fixture()
    for (const scope of [{ expectedRevision: -1 }, { expectedRevision: NaN }, { expectedDocumentRevision: 0 }]) {
      expect(await runtime.execute({ sessionId: 'session-a', capability: 'document.edit', ...scope }, () => 'unexpected'))
        .toMatchObject({ ok: false, error: { code: 'invalid_operation' } })
    }
  })

  it('allows an existing protocol and domain runtime to share one ordering boundary', async () => {
    const queue = createOfficeOperationQueue()
    const runtime = createOfficeWorkspaceRuntime({
      sessionId: 'ppt', appKind: 'presentation', capabilities: ['document.close'],
      read: () => ({ activeDocumentId: null, documents: [] }), queue,
    })
    const gate = deferred<void>()
    const calls: string[] = []
    const protocol = queue.enqueue(async () => { calls.push('protocol'); await gate.promise })
    const ui = runtime.execute({ sessionId: 'ppt', capability: 'document.close' }, () => { calls.push('close') })
    expect(calls).toEqual(['protocol'])
    gate.resolve()
    await protocol
    expect((await ui).ok).toBe(true)
    await runtime.whenIdle()
    expect(calls).toEqual(['protocol', 'close'])
  })
})
