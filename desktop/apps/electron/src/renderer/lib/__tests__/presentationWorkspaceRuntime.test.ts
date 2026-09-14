import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  createBlankPresentationDocument,
  createBlankPresentationSlide,
  presentationWorkspaceFamily,
  type PresentationDocument,
  type PresentationWorkspace,
} from '@/atoms/presentation'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { createPresentationWorkspaceRuntime } from '../presentationWorkspaceRuntime'
import { createOfficeEditorBinding } from '../office/officeEditorBinding'
import type { PowerPointDispatchResult, PowerPointRequest } from '../powerPointProtocol'

function setup() {
  const first = createBlankPresentationDocument('First')
  let workspace: PresentationWorkspace = { activeDocumentId: first.id, documents: [first] }
  const controller = createPresentationWorkspaceRuntime({
    sessionId: 'session-a',
    read: () => workspace,
    write: (next) => { workspace = next },
  })
  const apply = async (dispatched: PowerPointDispatchResult) => {
    if (dispatched.workspace) workspace = dispatched.workspace
  }
  const context = () => ({ currentTarget: null, fileName: 'First.pptx' })
  return { first, controller, apply, context, read: () => workspace }
}

describe('presentation workspace runtime', () => {
  it('reconciles native edits before an Agent page read without changing the v5 response', async () => {
    const { controller, first, read, context, apply } = setup()
    const binding = createOfficeEditorBinding<PresentationDocument>({ appKind: 'presentation', sessionId: 'session-a', documentId: first.id })
    binding.attach({
      readSnapshot: () => read().documents[0]!,
      flush: () => {
        const current = read().documents[0]!
        controller.commitDocument(current, { ...current, slides: current.slides.map((slide) => ({ ...slide, notes: 'Uncommitted native text' })) })
      },
      dispose: () => undefined,
    })
    controller.bindEditor(binding)
    const result = await controller.dispatchProtocol({ method: 'get_ppt_page', params: { page_id: first.selectedSlideId } }, context, apply)
    expect(result).toMatchObject({ ok: true, value: { page: { has_content: true } } })
    expect(read().documents[0]!.slides[0]!.notes).toBe('Uncommitted native text')
  })

  it('flushes the original native document before creating a new tab', async () => {
    const { controller, first, read } = setup()
    const binding = createOfficeEditorBinding<PresentationDocument>({ appKind: 'presentation', sessionId: 'session-a', documentId: first.id })
    binding.attach({ readSnapshot: () => read().documents[0]!, flush: () => {
      const current = read().documents[0]!
      controller.commitDocument(current, { ...current, title: 'Native text kept before switching' })
    }, dispose: () => undefined })
    controller.bindEditor(binding)
    const result = await controller.createDocument()
    expect(result.ok).toBe(true)
    expect(read().documents[0]!.title).toBe('Native text kept before switching')
    expect(read().activeDocumentId).not.toBe(first.id)
  })

  it('keeps the current workspace when native composition prevents a tab change or close', async () => {
    const { controller, first, read } = setup()
    let composing = true
    const binding = createOfficeEditorBinding<PresentationDocument>({ appKind: 'presentation', sessionId: 'session-a', documentId: first.id })
    binding.attach({ readSnapshot: () => first, flush: () => { if (composing) throw new Error('Finish composing') }, dispose: () => undefined })
    controller.bindEditor(binding)
    const previous = read()
    expect(await controller.createDocument()).toMatchObject({ ok: false, error: { message: 'Finish composing' } })
    expect(await controller.closeDocument(first.id)).toMatchObject({ ok: false, error: { message: 'Finish composing' } })
    expect(read()).toBe(previous)
    composing = false
    expect((await controller.createDocument()).ok).toBe(true)
  })

  it.each(['create', 'activate', 'close', 'protocol'] as const)('does not apply %s after the workspace was disposed during native flush', async (operation) => {
    const { controller, first, read, context, apply } = setup()
    let release!: () => void
    let flushing = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const binding = createOfficeEditorBinding<PresentationDocument>({ appKind: 'presentation', sessionId: 'session-a', documentId: first.id })
    binding.attach({ readSnapshot: () => first, flush: async () => { flushing = true; await gate }, dispose: () => undefined })
    controller.bindEditor(binding)
    const before = read()
    const operations = {
      create: () => controller.createDocument(),
      activate: () => controller.activateDocument(first.id),
      close: () => controller.closeDocument(first.id),
      protocol: () => controller.dispatchProtocol({ method: 'view_ppt', params: { target: '/tmp/after-close.pptx', file_name: 'after-close.pptx' } }, context, apply),
    }
    const pending = operations[operation]()
    await Promise.resolve()
    expect(flushing).toBe(true)
    controller.runtime.dispose()
    release()
    expect(await pending).toMatchObject({ ok: false })
    expect(read()).toBe(before)
  })

  it('rejects editor bindings owned by another Session', () => {
    const { controller, first } = setup()
    const binding = createOfficeEditorBinding<PresentationDocument>({ appKind: 'presentation', sessionId: 'another-session', documentId: first.id })
    expect(() => controller.bindEditor(binding)).toThrow('another Session')
  })

  it('projects blank document identity and honest capabilities without owning another model', () => {
    const { controller, first } = setup()
    expect(controller.runtime.getSnapshot()).toMatchObject({
      appKind: 'presentation', sessionId: 'session-a', activeDocumentId: first.id,
      documents: [{ id: first.id, title: 'First', revision: 1, dirty: null }],
    })
    expect(controller.runtime.supports('document.create')).toBe(true)
    expect(controller.runtime.supports('powerpoint.edit_ppt_page')).toBe(true)
    expect(controller.runtime.supports('document.save')).toBe(false)
    expect(controller.runtime.supports('document.undo')).toBe(false)
  })

  it('keeps native editing synchronous and rejects stale document commits', () => {
    const { controller, first, read } = setup()
    const revisions: number[] = []
    controller.runtime.subscribe((snapshot) => { revisions.push(snapshot.documents[0]!.revision) })
    const changed = controller.commitDocument(first, { ...first, title: 'Typed' })
    expect(read().documents[0]).toBe(changed)
    expect(changed.version).toBe(2)
    expect(revisions).toEqual([2])
    expect(() => controller.commitDocument(first, { ...first, title: 'Stale' })).toThrow()
    expect(read().documents[0]!.title).toBe('Typed')
  })

  it('does not count selecting a slide as a content revision', () => {
    const { controller, first, read } = setup()
    const nextSlide = createBlankPresentationSlide('Second')
    const withSlide = controller.commitDocument(first, { ...first, slides: [...first.slides, nextSlide] })
    const selected = controller.commitDocument(withSlide, { ...withSlide, selectedSlideId: nextSlide.id }, false)
    expect(selected.version).toBe(withSlide.version)
    expect(read().documents[0]!.selectedSlideId).toBe(nextSlide.id)
  })

  it('routes create, activate and close through the existing workspace and preserves final-tab close', async () => {
    const { controller, first, read } = setup()
    const created = await controller.createDocument()
    if (!created.ok) throw new Error(created.error.message)
    expect(read().documents).toHaveLength(2)
    expect(read().activeDocumentId).toBe(created.value)
    expect((await controller.activateDocument(first.id)).ok).toBe(true)
    expect(read().activeDocumentId).toBe(first.id)
    expect(await controller.closeDocument(first.id)).toEqual({ ok: true, value: { closeSurface: false } })
    expect(read().activeDocumentId).toBe(created.value)
    const before = read()
    expect(await controller.closeDocument(created.value)).toEqual({ ok: true, value: { closeSurface: true } })
    expect(read()).toBe(before)
    expect(await controller.closeDocument('missing')).toMatchObject({ ok: false, error: { code: 'document_not_found' } })
  })

  it('orders UI tab commands after an Agent command and its persistence acknowledgement', async () => {
    const { controller, context, apply, read } = setup()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let saving = false
    const opened = controller.dispatchProtocol({
      method: 'view_ppt', params: { target: '/tmp/queued.pptx', file_name: 'Queued.pptx' },
    }, context, async (dispatched) => {
      await apply(dispatched)
      saving = true
      await gate
    })
    const created = controller.createDocument()
    await Promise.resolve()
    await Promise.resolve()
    expect(saving).toBe(true)
    expect(read().documents).toHaveLength(1)
    expect(read().documents[0]!.title).toBe('Queued')
    release()
    expect((await opened).ok).toBe(true)
    expect((await created).ok).toBe(true)
    expect(read().documents).toHaveLength(2)
  })

  it('preserves native edits made while an Agent command prepares its workspace', async () => {
    const { controller, first, context, apply, read } = setup()
    const pending = controller.dispatchProtocol({
      method: 'view_ppt', params: { target: '/tmp/open.pptx', file_name: 'Opened.pptx' },
    }, context, apply)
    controller.commitDocument(first, { ...first, title: 'User edit' })
    expect(await pending).toMatchObject({ ok: false, code: 'document_changed' })
    expect(read().documents[0]!.title).toBe('User edit')
    expect((await controller.createDocument()).ok).toBe(true)
  })

  it('keeps protocol v5 revision errors and compiler diagnostics unchanged', async () => {
    const { controller, first, context, apply } = setup()
    const stale = await controller.dispatchProtocol({
      method: 'insert_ppt_element',
      params: { page_id: first.selectedSlideId, expected_revision: 'stale', element: '<PptText>Text</PptText>' },
    }, context, apply)
    expect(stale).toMatchObject({ ok: false, code: 'page_changed', error: expect.any(String) })
    const readPage = await controller.dispatchProtocol({ method: 'get_ppt_page', params: { page_id: first.selectedSlideId } }, context, apply)
    if (!readPage.ok) throw new Error(readPage.error)
    const revision = (readPage.value as { page: { revision: string } }).page.revision
    const invalid = await controller.dispatchProtocol({
      method: 'insert_ppt_element',
      params: { page_id: first.selectedSlideId, expected_revision: revision, element: '# Invalid element' },
    }, context, apply)
    expect(invalid).toMatchObject({ ok: true, value: { status: 'invalid' } })
    expect(await controller.dispatchProtocol({ method: 'invented' } as unknown as PowerPointRequest, context, apply))
      .toEqual({ ok: false, error: 'Unsupported PowerPoint method: invented' })
  })

  it('preserves a committed model on persistence failure and allows following commands', async () => {
    const { controller, context, apply, read } = setup()
    const failed = await controller.dispatchProtocol({
      method: 'view_ppt', params: { target: '/tmp/failure.pptx', file_name: 'Committed.pptx' },
    }, context, async (dispatched) => {
      await apply(dispatched)
      throw new Error('Disk unavailable')
    })
    expect(failed).toEqual({ ok: false, error: 'Disk unavailable' })
    expect(read().documents[0]!.title).toBe('Committed')
    expect((await controller.createDocument()).ok).toBe(true)
  })

  it('keeps queued work bound to its Session when main navigation changes', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    const atom = presentationWorkspaceFamily('session-a')
    const controller = createPresentationWorkspaceRuntime({
      sessionId: 'session-a', read: () => store.get(atom), write: (workspace) => store.set(atom, workspace),
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const blocking = controller.runtime.execute({ sessionId: 'session-a', capability: 'document.create' }, () => gate)
    const pending = controller.createDocument()
    store.set(activeSessionIdAtom, 'session-b')
    const sessionB = store.get(presentationWorkspaceFamily('session-b'))
    release()
    await blocking
    expect((await pending).ok).toBe(true)
    expect(store.get(atom).documents).toHaveLength(2)
    expect(store.get(presentationWorkspaceFamily('session-b'))).toBe(sessionB)
    const other = store.get(atom).documents[0] as PresentationDocument
    expect(() => controller.commitDocument(other, { ...other, title: 'Wrong active document' })).toThrow()
  })
})
