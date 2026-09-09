import { describe, expect, it } from 'bun:test'
import { createBlankPresentationDocument, type PresentationWorkspace } from '@/atoms/presentation'
import { createPresentationPersistence } from '../presentationPersistence'
import { createPresentationWorkspaceRuntime } from '../presentationWorkspaceRuntime'

function workspace(title: string, version = 1): PresentationWorkspace {
  const document = { ...createBlankPresentationDocument(title), version }
  return { activeDocumentId: document.id, documents: [document] }
}

function changed(state: PresentationWorkspace, title: string): PresentationWorkspace {
  return { ...state, documents: state.documents.map((document) => ({ ...document, title, version: document.version + 1 })) }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('presentation source persistence', () => {
  it('declares source-file storage and does not write unbound or newly created UI tabs', async () => {
    const writes: string[] = []
    const persistence = createPresentationPersistence({ sessionId: 'session-a', encode: async () => new Uint8Array(), write: async (path) => { writes.push(path) } })
    const first = workspace('Source')
    await persistence.persist(first)
    persistence.bindTarget('/tmp/source.pptx', first, true)
    const blank = workspace('Untitled')
    const tabs = { activeDocumentId: blank.activeDocumentId, documents: [...first.documents, ...blank.documents] }
    await persistence.persist(tabs)
    expect(writes).toEqual([])
    expect(persistence.targetFor(tabs)).toBeNull()
    expect(persistence.targetFor(first)).toBe('/tmp/source.pptx')
    expect(persistence.getSnapshot().policy).toEqual({ appKind: 'presentation', sessionId: 'session-a', kind: 'source', storage: 'source-file', automatic: true })
  })

  it('returns the same actual write receipt to autosave and a matching protocol checkpoint', async () => {
    const gate = deferred()
    let writes = 0
    const persistence = createPresentationPersistence({ sessionId: 's', encode: async () => new Uint8Array(), write: async () => { writes += 1; await gate.promise } })
    const state = workspace('Source')
    persistence.bindTarget('/tmp/source.pptx', state, false)
    const autosave = persistence.persist(state)
    const protocol = persistence.persist(state)
    expect(protocol).toBe(autosave)
    let settled = false
    void protocol.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toBe(1)
    expect(settled).toBe(false)
    gate.resolve()
    await protocol
    expect(settled).toBe(true)
    await persistence.persist(state)
    expect(writes).toBe(1)
  })

  it('keeps same-target revision writes ordered and waits for each receipt', async () => {
    const firstGate = deferred()
    const written: number[] = []
    const persistence = createPresentationPersistence({
      sessionId: 's', encode: async (document) => new Uint8Array([document.version]),
      write: async (_path, bytes) => { written.push(bytes[0]!); if (bytes[0] === 1) await firstGate.promise },
    })
    const state = workspace('First')
    persistence.bindTarget('/tmp/source.pptx', state, false)
    const first = persistence.persist(state)
    const second = persistence.persist(changed(state, 'Second'))
    await Promise.resolve()
    await Promise.resolve()
    expect(written).toEqual([1])
    firstGate.resolve()
    await Promise.all([first, second])
    expect(written).toEqual([1, 2])
  })

  it('lets a newer queued write settle after an older autosave fails', async () => {
    const gate = deferred()
    const written: number[] = []
    const persistence = createPresentationPersistence({
      sessionId: 's', encode: async (document) => new Uint8Array([document.version]),
      write: async (_path, bytes) => { written.push(bytes[0]!); if (bytes[0] === 1) await gate.promise },
    })
    const state = workspace('First')
    persistence.bindTarget('/tmp/source.pptx', state, false)
    const first = persistence.persist(state)
    const firstOutcome = first.then(() => 'saved', () => 'failed')
    const second = persistence.persist(changed(state, 'Second'))
    gate.reject(new Error('First write failed'))
    expect(await firstOutcome).toBe('failed')
    await second
    await persistence.flush()
    expect(written).toEqual([1, 2])
    expect(persistence.getSnapshot().status).toBe('saved')
  })

  it('retains the latest failed write for an explicit retry and does not write bytes on encoding failure', async () => {
    let encodes = 0
    let writes = 0
    const persistence = createPresentationPersistence({
      sessionId: 's', encode: async () => { if (++encodes === 1) throw new Error('Encoding failed'); return new Uint8Array() },
      write: async () => { writes += 1 },
    })
    const state = workspace('First')
    persistence.bindTarget('/tmp/source.pptx', state, false)
    await expect(persistence.persist(state)).rejects.toThrow('Encoding failed')
    expect(writes).toBe(0)
    await persistence.flush()
    expect(writes).toBe(1)
    expect(encodes).toBe(2)
    expect(persistence.getSnapshot().status).toBe('saved')
  })

  it.each(['complete', 'fail'] as const)('keeps a previous target %s from changing a newly imported target baseline', async (outcome) => {
    const gate = deferred()
    const writes: string[] = []
    const persistence = createPresentationPersistence({
      sessionId: 's', encode: async () => new Uint8Array(),
      write: async (target) => { writes.push(target); if (target === '/tmp/first.pptx') await gate.promise },
    })
    const first = workspace('First')
    persistence.bindTarget('/tmp/first.pptx', first, false)
    const pending = persistence.persist(first)
    const completed = pending.then(() => undefined, () => undefined)
    const second = workspace('Second')
    persistence.bindTarget('/tmp/second.pptx', second, true)
    const secondStatus = persistence.getSnapshot()
    if (outcome === 'complete') gate.resolve()
    else gate.reject(new Error('Old destination unavailable'))
    await completed
    await persistence.persist(second)
    expect(persistence.getSnapshot()).toBe(secondStatus)
    expect(persistence.getSnapshot().status).toBe('saved')
    expect(writes).toEqual(['/tmp/first.pptx'])
  })

  it('continues a different target while an older destination is still saving', async () => {
    const gate = deferred()
    const writes: string[] = []
    const persistence = createPresentationPersistence({ sessionId: 's', encode: async () => new Uint8Array(), write: async (target) => { writes.push(target); if (target === '/tmp/first.pptx') await gate.promise } })
    const first = workspace('First')
    persistence.bindTarget('/tmp/first.pptx', first, false)
    const pending = persistence.persist(first)
    const second = workspace('Second')
    persistence.bindTarget('/tmp/second.pptx', second, false)
    await persistence.persist(second)
    expect(writes).toEqual(['/tmp/first.pptx', '/tmp/second.pptx'])
    gate.resolve()
    await pending
  })

  it('includes native edits made during a close checkpoint before acknowledging the close', async () => {
    const gate = deferred()
    const written: number[] = []
    const persistence = createPresentationPersistence({ sessionId: 's', encode: async (document) => new Uint8Array([document.version]), write: async (_path, bytes) => { written.push(bytes[0]!); if (bytes[0] === 1) await gate.promise } })
    let state = workspace('First')
    persistence.bindTarget('/tmp/source.pptx', state, false)
    let closed = false
    const checkpoint = persistence.checkpoint(() => state).then(() => { closed = true })
    state = changed(state, 'Typed while saving')
    expect(closed).toBe(false)
    gate.resolve()
    await checkpoint
    expect(written).toEqual([1, 2])
    expect(closed).toBe(true)
  })

  it('rejects a failed close checkpoint so its caller can preserve the editor', async () => {
    const persistence = createPresentationPersistence({ sessionId: 's', encode: async () => new Uint8Array(), write: async () => { throw new Error('Disk unavailable') } })
    const state = workspace('First')
    persistence.bindTarget('/tmp/source.pptx', state, false)
    let closed = false
    await expect(persistence.checkpoint(() => state).then(() => { closed = true })).rejects.toThrow('Disk unavailable')
    expect(closed).toBe(false)
  })

  it('returns view_ppt to its existing source document after the user selects an unbound tab', async () => {
    let writes = 0
    const persistence = createPresentationPersistence({ sessionId: 's', encode: async () => new Uint8Array(), write: async () => { writes += 1 } })
    const source = workspace('Source')
    const blank = workspace('New UI tab')
    persistence.bindTarget('/tmp/source.pptx', source, true)
    let state = { activeDocumentId: blank.activeDocumentId, documents: [...source.documents, ...blank.documents] }
    const controller = createPresentationWorkspaceRuntime({ sessionId: 's', read: () => state, write: (next) => { state = next } })
    const result = await controller.dispatchProtocol(
      { method: 'view_ppt', params: { target: '/tmp/source.pptx', file_name: 'source.pptx', content_base64: 'Not reread for a reused document' } },
      () => ({ currentTarget: persistence.targetFor(state), fileName: 'source.pptx' }),
      async () => undefined,
      (request) => persistence.prepareProtocol(request, () => state, (next) => { state = next }),
    )
    expect(result).toMatchObject({ ok: true, value: { reused: true, identity: { document_id: source.activeDocumentId } } })
    expect(state.activeDocumentId).toBe(source.activeDocumentId)
    expect(state.documents).toHaveLength(2)
    expect(writes).toBe(0)
  })

  it('rejects source mutations before they can modify an unbound UI tab', async () => {
    const persistence = createPresentationPersistence({ sessionId: 's', encode: async () => new Uint8Array(), write: async () => undefined })
    const state = workspace('Unbound')
    let commits = 0
    const controller = createPresentationWorkspaceRuntime({ sessionId: 's', read: () => state, write: () => { commits += 1 } })
    const result = await controller.dispatchProtocol(
      { method: 'insert_ppt_page', params: { markdown: '<PptSlide><PptText>Must not be applied</PptText></PptSlide>' } },
      () => ({ currentTarget: null, fileName: 'Unbound.pptx' }),
      async () => { commits += 1 },
      (request) => persistence.prepareProtocol(request, () => state, () => { commits += 1 }),
    )
    expect(result).toMatchObject({ ok: false, code: 'document_changed' })
    expect(commits).toBe(0)
    expect(state.documents[0]!.slides).toHaveLength(1)
  })

  it('requires fresh source bytes when reopening a replaced document with pending writes', async () => {
    const gate = deferred()
    const persistence = createPresentationPersistence({ sessionId: 's', encode: async () => new Uint8Array(), write: async () => gate.promise })
    const first = workspace('First')
    persistence.bindTarget('/tmp/first.pptx', first, false)
    const pending = persistence.persist(first)
    const second = workspace('Second')
    persistence.bindTarget('/tmp/second.pptx', second, true)
    const request = { method: 'view_ppt' as const, params: { target: '/tmp/first.pptx', file_name: 'first.pptx', content_base64: 'Previously read bytes' } }
    let writesToWorkspace = 0
    const preparation = persistence.prepareProtocol(request, () => second, () => { writesToWorkspace += 1 })
    gate.resolve()
    await pending
    await expect(preparation).rejects.toMatchObject({ code: 'document_changed' })
    expect(persistence.targetFor(second)).toBe('/tmp/second.pptx')
    expect(writesToWorkspace).toBe(0)
    await persistence.prepareProtocol(request, () => second, () => { writesToWorkspace += 1 })
    expect(writesToWorkspace).toBe(0)
  })
})
