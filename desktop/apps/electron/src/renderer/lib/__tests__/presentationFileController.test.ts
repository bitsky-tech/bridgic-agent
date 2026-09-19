import { describe, expect, it, mock } from 'bun:test'
import { createBlankPresentationDocument, type PresentationWorkspace } from '@/atoms/presentation'
import { createPresentationEditorDriver } from '../presentationEditorDriver'
import { createOfficeEditorBinding } from '../office/officeEditorBinding'
import { createPresentationFileController } from '../presentationFileController'
import { isPresentationDirty } from '../presentationWorkspaceRuntime'
import type { OfficeFilesAPI } from '../../../shared/office-files'

function setup(automatic = false, onSaveStatus?: (status: 'saving' | 'saved' | 'error', error?: string) => void) {
  const document = { ...createBlankPresentationDocument('Report'), source: { path: '/Report.pptx', mtimeMs: 42 }, savedRevision: 1 }
  let workspace: PresentationWorkspace = { activeDocumentId: document.id, documents: [document] }
  let recovery: string | null = null
  const files: OfficeFilesAPI = {
    inspect: async (_kind, path) => ({ path, mtimeMs: 42 }),
    save: mock(async () => ({ ok: true as const, fileName: 'Report.pptx', source: { path: '/Report.pptx', mtimeMs: 43 } })),
    confirmClose: mock(async () => 'cancel' as const),
    getRecovery: async () => recovery,
    setRecovery: async (_kind, _session, value) => { recovery = value },
  }
  const controller = createPresentationFileController({ automatic, onSaveStatus, sessionId: 'session-a', files, read: () => workspace, write: (value) => { workspace = value; controller.schedule() }, encode: async () => new Uint8Array([1]), flushEditor: async () => undefined, locale: () => 'en' })
  return { controller, files, read: () => workspace, edit: () => { workspace = { ...workspace, documents: [{ ...workspace.documents[0]!, revision: workspace.documents[0]!.revision + 1 }] } } }
}

describe('PowerPoint explicit saving', () => {
  it('uses Save as when Save is chosen while closing a protected imported file', async () => {
    const { controller, files, read, edit } = setup()
    await controller.restore()
    read().documents[0]!.sourceProtected = true
    edit()
    files.confirmClose = async () => 'save'
    expect(await controller.beforeClose(read().activeDocumentId)).toBe(true)
    expect(files.save).toHaveBeenCalledWith(expect.objectContaining({ saveAs: true, preserveSource: true }))
    controller.recovery.dispose()
  })

  it('requires a distinct Save as for a converted source and clears protection only after saving', async () => {
    const { controller, files, read, edit } = setup()
    await controller.restore()
    read().documents[0]!.sourceProtected = true
    edit()
    await expect(controller.save(read().activeDocumentId)).rejects.toThrow()
    expect(files.save).not.toHaveBeenCalled()
    files.save = mock(async () => ({ ok: false as const, reason: 'source-protected' as const }))
    await expect(controller.save(read().activeDocumentId, true)).rejects.toThrow()
    expect(read().documents[0]!.sourceProtected).toBe(true)
    files.save = mock(async () => ({ ok: true as const, source: { path: '/Copy.pptx', mtimeMs: 43 }, fileName: 'Copy.pptx' }))
    expect(await controller.save(read().activeDocumentId, true)).toBe(true)
    expect(files.save).toHaveBeenCalledWith(expect.objectContaining({ preserveSource: true }))
    expect(read().documents[0]!.sourceProtected).toBe(false)
    controller.recovery.dispose()
  })

  it('checkpoints edits without writing the source, then saves only on an explicit request', async () => {
    const { controller, files, read, edit } = setup()
    await controller.restore()
    edit()
    controller.schedule()
    await controller.flush()
    expect(files.save).not.toHaveBeenCalled()
    expect(isPresentationDirty(read().documents[0]!)).toBe(true)
    expect(await controller.save(read().activeDocumentId)).toBe(true)
    expect(files.save).toHaveBeenCalledTimes(1)
    expect(isPresentationDirty(read().documents[0]!)).toBe(false)
    controller.recovery.dispose()
  })
  it('does not clear newer edits made during saving', async () => {
    const { controller, files, read, edit } = setup()
    await controller.restore()
    edit()
    files.save = async () => { edit(); return { ok: true, source: { path: '/Report.pptx', mtimeMs: 43 }, fileName: 'Report.pptx' } }
    expect(await controller.save(read().activeDocumentId)).toBe(false)
    expect(isPresentationDirty(read().documents[0]!)).toBe(true)
    controller.recovery.dispose()
  })
  it('canceled closing keeps the draft and never saves implicitly', async () => {
    const { controller, files, read, edit } = setup()
    await controller.restore()
    edit()
    expect(await controller.beforeClose(read().activeDocumentId)).toBe(false)
    expect(files.save).not.toHaveBeenCalled()
    controller.recovery.dispose()
  })
})

it('retries a failed PPT recovery write after the source is saved and clears the failure only on success', async () => {
  const status = mock(() => undefined)
  const { controller, files, read, edit } = setup(true, status)
  let fail = true
  let checkpoint: string | null = null
  files.setRecovery = mock(async (_kind, _session, value) => {
    if (fail) throw new Error('Recovery unavailable')
    checkpoint = value
  })
  try {
    await controller.restore()
    edit()
    controller.schedule()
    await expect(controller.autoSave.flush()).rejects.toThrow('Recovery unavailable')
    expect(isPresentationDirty(read().documents[0]!)).toBe(false)
    expect(files.save).toHaveBeenCalledTimes(1)
    await expect(controller.save(read().activeDocumentId)).rejects.toThrow('Recovery unavailable')
    expect(status).toHaveBeenLastCalledWith('error', 'Recovery unavailable')
    fail = false
    expect(await controller.save(read().activeDocumentId)).toBe(true)
    expect(JSON.parse(checkpoint!)).toEqual(read())
    expect(files.save).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenLastCalledWith('saved')
    expect(controller.recovery.getSnapshot().status).toBe('saved')
  } finally { controller.autoSave.dispose(); controller.recovery.dispose() }
})

it('keeps PPT edits made during a clean-file recovery retry pending', async () => {
  const status = mock(() => undefined)
  const { controller, files, read, edit } = setup(true, status)
  try {
    await controller.restore()
    files.setRecovery = async () => { edit() }
    expect(await controller.save(read().activeDocumentId)).toBe(false)
    expect(isPresentationDirty(read().documents[0]!)).toBe(true)
    expect(files.save).not.toHaveBeenCalled()
    expect(status).toHaveBeenLastCalledWith('saving')
  } finally { controller.autoSave.dispose(); controller.recovery.dispose() }
})


it('automatically saves PPT edits and retains a failed write for retry without a discard dialog', async () => {
  const { controller, files, read, edit } = setup(true)
  await controller.restore()
  read().documents[0]!.sourceProtected = true
  edit()
  controller.schedule()
  await controller.autoSave.flush()
  expect(files.save).toHaveBeenCalledWith(expect.objectContaining({ managed: true, documentId: read().activeDocumentId }))
  expect(isPresentationDirty(read().documents[0]!)).toBe(false)
  files.save = async () => { throw new Error('disk full') }
  edit()
  controller.schedule()
  await expect(controller.autoSave.flush()).rejects.toThrow('disk full')
  await expect(controller.beforeClose(read().activeDocumentId)).rejects.toThrow('disk full')
  expect(isPresentationDirty(read().documents[0]!)).toBe(true)
  expect(files.confirmClose).not.toHaveBeenCalled()
  files.save = async () => ({ ok: true, fileName: 'Report.pptx', source: { path: '/Report.pptx', mtimeMs: 44 } })
  await controller.autoSave.flush()
  expect(isPresentationDirty(read().documents[0]!)).toBe(false)
  controller.autoSave.dispose()
  controller.recovery.dispose()
})


it('background PPT saves leave active text and IME input intact, while close commits the final text', async () => {
  const document = { ...createBlankPresentationDocument('Report'), source: { path: '/Report.pptx', mtimeMs: 42 }, savedRevision: 0 }
  let workspace: PresentationWorkspace = { activeDocumentId: document.id, documents: [document] }
  const writes: string[] = []
  let exits = 0
  const editing = {
    isEditing: true, inCompositionMode: true,
    exitEditing() {
      exits++
      editing.isEditing = false
      workspace = { ...workspace, documents: workspace.documents.map((item) => ({ ...item, revision: item.revision + 1, title: 'Completed text' })) }
    },
  }
  const binding = createOfficeEditorBinding<PresentationWorkspace['documents'][number]>({ appKind: 'presentation', sessionId: 's', documentId: document.id })
  binding.attach(createPresentationEditorDriver({ readSnapshot: () => workspace.documents[0]!, readEditingObject: () => editing, flushPendingEdit: () => undefined, dispose: () => undefined }))
  const controller = createPresentationFileController({
    sessionId: 's', automatic: true, read: () => workspace, write: (next) => { workspace = next },
    flushEditor: binding.flush, encode: async (item) => new TextEncoder().encode(item.title), locale: () => 'en',
    files: {
      inspect: async () => document.source,
      save: async (request) => { writes.push(new TextDecoder().decode(request.bytes)); return { ok: true, source: document.source, fileName: 'Report.pptx' } },
      getRecovery: async () => null, setRecovery: async () => undefined, confirmClose: async () => 'cancel',
    },
  })
  try {
    await controller.restore()
    await controller.autoSave.flush()
    expect(writes).toEqual(['Report'])
    expect(editing.isEditing).toBe(true)
    expect(exits).toBe(0)
    await expect(controller.beforeClose(document.id)).rejects.toThrow('Finish composing')
    editing.inCompositionMode = false
    expect(await controller.beforeClose(document.id)).toBe(true)
    expect(exits).toBe(1)
    expect(writes).toEqual(['Report', 'Completed text'])
  } finally { controller.autoSave.dispose(); controller.recovery.dispose(); binding.dispose() }
})
