import { describe, expect, it, mock } from 'bun:test'
import { createBlankPresentationProject, type PresentationProject } from '@/atoms/presentation'
import type { PresentationCheckpoint } from '@/presentation/checkpoint'
import { createPresentationEditorDriver } from '../presentationEditorDriver'
import { createOfficeEditorBinding } from '../office/officeEditorBinding'
import { createPresentationFileController, isPresentationProjectDirty } from '../presentationFileController'
import type { OfficeFileSource, OfficeFilesAPI } from '../../../shared/office-files'

function setup(managed = false, onExportStatus?: (status: 'saving' | 'saved' | 'error', error?: string) => void) {
  const project = createBlankPresentationProject('Report')
  let checkpoint: PresentationCheckpoint = {
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
    projectMetadata: { [project.id]: { revision: 1, source: { path: '/Report.pptx', mtimeMs: 42 }, savedRevision: 1 } },
  }
  let recovery: string | null = null
  const files: OfficeFilesAPI = {
    inspect: async (_kind, path) => ({ path, mtimeMs: 42 }),
    save: mock(async () => ({ ok: true as const, fileName: 'Report.pptx', source: { path: '/Report.pptx', mtimeMs: 43 } })),
    confirmClose: mock(async () => 'cancel' as const),
    getRecovery: async () => recovery,
    setRecovery: async (_kind, _session, value) => { recovery = value },
  }
  const commitExport = (projectId: string, _fileName: string, source: OfficeFileSource, exportedRevision: number) => {
    checkpoint = {
      ...checkpoint,
      projectMetadata: {
        ...checkpoint.projectMetadata,
        [projectId]: { ...checkpoint.projectMetadata[projectId]!, source, sourceProtected: false, savedRevision: exportedRevision },
      },
    }
  }
  const controller = createPresentationFileController({
    encode: async () => new Uint8Array([1]),
    files,
    flushEditor: async () => undefined,
    managed,
    onExportStatus,
    read: () => checkpoint,
    commitExport,
    sessionId: 'session-a',
  })
  return {
    controller,
    files,
    read: () => checkpoint,
    readRecovery: () => recovery,
    writeRecovery: (value: string | null) => { recovery = value },
    edit: () => {
      const metadata = checkpoint.projectMetadata[project.id]!
      checkpoint = {
        ...checkpoint,
        projectMetadata: { ...checkpoint.projectMetadata, [project.id]: { ...metadata, revision: metadata.revision + 1 } },
      }
    },
  }
}

describe('PowerPoint project persistence and explicit export', () => {
  it('requires Save as for a protected imported source and clears protection only after export', async () => {
    const { controller, files, read, edit } = setup()
    try {
      await controller.restore()
      read().projectMetadata[read().activeProjectId]!.sourceProtected = true
      edit()
      await expect(controller.save(read().activeProjectId)).rejects.toThrow()
      expect(files.save).not.toHaveBeenCalled()

      files.save = mock(async () => ({ ok: false as const, reason: 'source-protected' as const }))
      await expect(controller.save(read().activeProjectId, true)).rejects.toThrow()
      expect(read().projectMetadata[read().activeProjectId]!.sourceProtected).toBe(true)

      files.save = mock(async () => ({ ok: true as const, source: { path: '/Copy.pptx', mtimeMs: 43 }, fileName: 'Copy.pptx' }))
      expect(await controller.save(read().activeProjectId, true)).toBe(true)
      expect(files.save).toHaveBeenCalledWith(expect.objectContaining({ preserveSource: true, saveAs: true }))
      expect(read().projectMetadata[read().activeProjectId]!.sourceProtected).toBe(false)
    } finally {
      controller.recovery.dispose()
    }
  })

  it('checkpoints project edits without writing PPTX and exports only on an explicit request', async () => {
    const { controller, files, read, readRecovery, edit } = setup()
    try {
      await controller.restore()
      edit()
      controller.schedule()
      await controller.flush()

      expect(files.save).not.toHaveBeenCalled()
      const stored = JSON.parse(readRecovery()!) as PresentationCheckpoint
      expect(stored.projectMetadata[read().activeProjectId]!.revision).toBe(read().projectMetadata[read().activeProjectId]!.revision)
      expect(isPresentationProjectDirty(read().projectMetadata[read().activeProjectId]!)).toBe(true)

      expect(await controller.save(read().activeProjectId)).toBe(true)
      expect(files.save).toHaveBeenCalledTimes(1)
      expect(isPresentationProjectDirty(read().projectMetadata[read().activeProjectId]!)).toBe(false)
    } finally {
      controller.recovery.dispose()
    }
  })

  it('does not acknowledge edits made while an explicit export is running', async () => {
    const { controller, files, read, edit } = setup()
    try {
      await controller.restore()
      edit()
      files.save = async () => {
        edit()
        return { ok: true, source: { path: '/Report.pptx', mtimeMs: 43 }, fileName: 'Report.pptx' }
      }

      expect(await controller.save(read().activeProjectId)).toBe(false)
      expect(isPresentationProjectDirty(read().projectMetadata[read().activeProjectId]!)).toBe(true)
    } finally {
      controller.recovery.dispose()
    }
  })

  it('retries a failed recovery checkpoint without implicitly exporting PPTX', async () => {
    const { controller, files, edit } = setup()
    let fail = true
    files.setRecovery = mock(async () => {
      if (fail) throw new Error('Recovery unavailable')
    })
    try {
      await controller.restore()
      edit()
      controller.schedule()
      await expect(controller.flush()).rejects.toThrow('Recovery unavailable')
      expect(files.save).not.toHaveBeenCalled()

      fail = false
      await controller.flush()
      expect(files.save).not.toHaveBeenCalled()
      expect(controller.recovery.getSnapshot().status).toBe('saved')
    } finally {
      controller.recovery.dispose()
    }
  })

  it('does not repeat a successful PPTX export when only its recovery checkpoint failed', async () => {
    const status = mock(() => undefined)
    const { controller, files, read, edit } = setup(false, status)
    let fail = true
    files.setRecovery = mock(async () => {
      if (fail) throw new Error('Recovery unavailable')
    })
    try {
      await controller.restore()
      edit()
      await expect(controller.save(read().activeProjectId)).rejects.toThrow('Recovery unavailable')
      expect(files.save).toHaveBeenCalledTimes(1)
      expect(isPresentationProjectDirty(read().projectMetadata[read().activeProjectId]!)).toBe(false)
      expect(status).toHaveBeenLastCalledWith('error', 'Recovery unavailable')

      fail = false
      expect(await controller.save(read().activeProjectId)).toBe(true)
      expect(files.save).toHaveBeenCalledTimes(1)
      expect(status).toHaveBeenLastCalledWith('saved')
    } finally {
      controller.recovery.dispose()
    }
  })

  it('keeps edits made during a clean-project recovery write pending', async () => {
    const status = mock(() => undefined)
    const { controller, files, read, edit } = setup(false, status)
    try {
      await controller.restore()
      files.setRecovery = async () => { edit() }
      expect(await controller.save(read().activeProjectId)).toBe(false)
      expect(isPresentationProjectDirty(read().projectMetadata[read().activeProjectId]!)).toBe(true)
      expect(files.save).not.toHaveBeenCalled()
      expect(status).toHaveBeenLastCalledWith('saving')
    } finally {
      controller.recovery.dispose()
    }
  })

  it('rejects a recovery inventory whose active project is missing', async () => {
    const { controller, read, writeRecovery } = setup()
    writeRecovery(JSON.stringify({ ...read(), activeProjectId: 'missing-project' }))
    try {
      await expect(controller.restore()).rejects.toThrow('invalid project inventory')
    } finally {
      controller.recovery.dispose()
    }
  })
})

it('explicit PPTX export commits active text but refuses incomplete IME composition', async () => {
  let project: PresentationProject = createBlankPresentationProject('Report')
  const source = { path: '/Report.pptx', mtimeMs: 42 }
  let checkpoint: PresentationCheckpoint = {
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
    projectMetadata: { [project.id]: { revision: 1, source, savedRevision: 0 } },
  }
  const writes: string[] = []
  let exits = 0
  const editing = {
    isEditing: true,
    inCompositionMode: true,
    exitEditing() {
      exits++
      editing.isEditing = false
      project = { ...project, title: 'Completed text' }
      const metadata = checkpoint.projectMetadata[project.id]!
      checkpoint = {
        ...checkpoint,
        projects: [project],
        projectMetadata: { [project.id]: { ...metadata, revision: metadata.revision + 1 } },
      }
    },
  }
  const binding = createOfficeEditorBinding<PresentationProject>({ appKind: 'presentation', sessionId: 's', documentId: project.id })
  binding.attach(createPresentationEditorDriver({ readSnapshot: () => project, readEditingObject: () => editing, flushPendingEdit: () => undefined, dispose: () => undefined }))
  const controller = createPresentationFileController({
    sessionId: 's', managed: true, read: () => checkpoint,
    commitExport: (projectId, _fileName, nextSource, exportedRevision) => {
      checkpoint = {
        ...checkpoint,
        projectMetadata: { [projectId]: { ...checkpoint.projectMetadata[projectId]!, source: nextSource, savedRevision: exportedRevision } },
      }
    },
    flushEditor: binding.flush, encode: async (item) => new TextEncoder().encode(item.title),
    files: {
      inspect: async () => source,
      save: async (request) => { writes.push(new TextDecoder().decode(request.bytes)); return { ok: true, source, fileName: 'Report.pptx' } },
      getRecovery: async () => null, setRecovery: async () => undefined, confirmClose: async () => 'cancel',
    },
  })
  try {
    await controller.restore()
    await expect(controller.flush()).rejects.toThrow('Finish composing')
    await expect(controller.save(project.id)).rejects.toThrow('Finish composing')
    expect(writes).toEqual([])
    expect(exits).toBe(0)

    editing.inCompositionMode = false
    expect(await controller.save(project.id)).toBe(true)
    expect(exits).toBe(1)
    expect(writes).toEqual(['Completed text'])
  } finally {
    controller.recovery.dispose()
    binding.dispose()
  }
})
