import { describe, expect, it } from 'bun:test'
import { createBlankPresentationDocument, createBlankPresentationSlide } from '@/atoms/presentation'
import { createOfficeEditorBinding } from '../office/officeEditorBinding'
import { bindPresentationNativeEdit, createPresentationEditorDriver, type PresentationEditingObject } from '../presentationEditorDriver'

function setup() {
  let document = createBlankPresentationDocument('Native edit')
  let editing: PresentationEditingObject | null = null
  let pending: (() => void) | null = null
  let disposed = 0
  const binding = createOfficeEditorBinding({ appKind: 'presentation', sessionId: 's', documentId: document.id,
    onChange: (next: typeof document) => { document = next },
  })
  binding.attach(createPresentationEditorDriver({
    readSnapshot: () => document,
    readEditingObject: () => editing,
    flushPendingEdit: () => { const change = pending; pending = null; change?.() },
    dispose: () => { disposed += 1 },
  }))
  return { binding, read: () => document, disposed: () => disposed,
    edit: (next: PresentationEditingObject | null) => { editing = next },
    defer: (change: () => void) => { pending = change },
  }
}

describe('PowerPoint native editor driver', () => {
  it('reads the existing authority and does not turn an animation projection into a native edit', async () => {
    const { binding, read, edit } = setup()
    let exits = 0
    edit({ isEditing: false, exitEditing: () => { exits += 1 } })
    const original = read()
    expect(binding.readSnapshot()).toBe(original)
    await binding.flush()
    expect(read()).toBe(original)
    expect(exits).toBe(0)
  })

  it('commits a pending transform and exits native text editing exactly once before flush completes', async () => {
    const { binding, read, edit, defer } = setup()
    const events: string[] = []
    const active = { isEditing: true, exitEditing: () => {
      events.push('text')
      active.isEditing = false
      binding.publishChange({ ...read(), title: 'Committed native text', version: read().version + 1 })
    } }
    edit(active)
    defer(() => { events.push('transform') })
    await binding.flush()
    await binding.flush()
    expect(events).toEqual(['transform', 'text'])
    expect(binding.readSnapshot()?.title).toBe('Committed native text')
  })

  it('keeps composition and pending native work intact until composition ends', async () => {
    const { binding, edit, defer } = setup()
    let transforms = 0
    let exits = 0
    const active = { isEditing: true, inCompositionMode: true, exitEditing: () => { exits += 1; active.isEditing = false } }
    edit(active)
    defer(() => { transforms += 1 })
    await expect(binding.flush()).rejects.toThrow('Finish composing')
    expect(transforms).toBe(0)
    expect(exits).toBe(0)
    active.inCompositionMode = false
    await binding.flush()
    expect(transforms).toBe(1)
    expect(exits).toBe(1)
  })

  it('drops native callbacks captured for an old slide, document, or disposed engine', () => {
    const { binding, read, disposed } = setup()
    let commits = 0
    const original = read()
    let current = original
    const callback = bindPresentationNativeEdit(binding.capture(), original.selectedSlideId, () => current, () => { commits += 1 })
    callback()
    expect(commits).toBe(1)
    current = { ...original, selectedSlideId: createBlankPresentationSlide('Another slide').id }
    callback()
    current = original
    binding.bindDocument('another-document')
    callback()
    binding.bindDocument(original.id)
    callback()
    const final = bindPresentationNativeEdit(binding.capture(), original.selectedSlideId, () => original, () => { commits += 1 })
    binding.dispose()
    final()
    expect(commits).toBe(1)
    expect(disposed()).toBe(1)
  })
})
