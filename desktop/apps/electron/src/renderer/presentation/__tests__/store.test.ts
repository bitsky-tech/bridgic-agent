import { describe, expect, it, mock } from 'bun:test'
import { createBlankPresentationProject, type PresentationProject } from '@/atoms/presentation'
import type { OfficeFilesAPI } from '../../../shared/office-files'
import { createOfficeEditorBinding } from '@/lib/office/officeEditorBinding'
import { PresentationStore } from '../store'

function setup() {
  const project = createBlankPresentationProject('Store project')
  let recovery: string | null = JSON.stringify({
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
    projectMetadata: { [project.id]: { revision: 1 } },
  })
  const save = mock(async () => ({
    ok: true as const,
    fileName: 'Store project.pptx',
    source: { path: '/Store project.pptx', mtimeMs: 2 },
  }))
  const confirmClose = mock(async () => 'cancel' as 'cancel' | 'discard' | 'save')
  const files: OfficeFilesAPI = {
    inspect: async (_kind, path) => ({ path, mtimeMs: 1 }),
    save,
    confirmClose,
    getRecovery: async () => recovery,
    setRecovery: async (_kind, _sessionId, value) => { recovery = value },
  }
  const store = new PresentationStore('presentation-store-test', {
    encode: async () => new Uint8Array([1, 2, 3]),
    files,
    importPptx: async (_encoded, fileName) => createBlankPresentationProject(fileName.replace(/\.pptx$/i, '')),
    managedFiles: false,
  })
  return { confirmClose, files, project, readRecovery: () => recovery, save, store }
}

describe('PresentationStore', () => {
  it('restores an empty Session without inventing a project', async () => {
    const { files, store } = setup()
    files.getRecovery = async () => null
    try {
      await store.restore()
      expect(store.getSnapshot()).toMatchObject({ activeProjectId: '', project: null, projects: [], ready: true })
      await store.createProject()
      expect(store.getSnapshot().projects).toHaveLength(1)
    } finally {
      store.dispose()
    }
  })

  it('owns UI commits, undo, redo, and recovery without treating PPTX as live state', async () => {
    const { readRecovery, save, store } = setup()
    try {
      await store.restore()
      const updates: string[] = []
      const unsubscribe = store.subscribe(() => { updates.push(store.getSnapshot().project?.title ?? '') })
      const current = store.getSnapshot().project!
      store.commitProject(current, { ...current, title: 'Edited in UI' })

      expect(store.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false, project: { title: 'Edited in UI' }, saveStatus: 'saving' })
      expect(updates.at(-1)).toBe('Edited in UI')
      expect(save).not.toHaveBeenCalled()

      expect(store.undo()?.title).toBe('Store project')
      expect(store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true })
      expect(store.redo()?.title).toBe('Edited in UI')
      await store.flush()

      expect(JSON.parse(readRecovery()!).projects[0].title).toBe('Edited in UI')
      expect(save).not.toHaveBeenCalled()
      expect(store.getSnapshot()).toMatchObject({ persistenceError: null, saveStatus: 'saved' })
      unsubscribe()
    } finally {
      store.dispose()
    }
  })

  it('commits Agent commands into the same project and history', async () => {
    const { readRecovery, save, store } = setup()
    try {
      await store.restore()
      const project = store.getSnapshot().project!
      const page = project.slides.pages[0]!
      const read = await store.dispatch({ method: 'read_page', params: { document_id: project.id, page_id: page.id, format: 'model' } })
      expect(read.ok).toBe(true)
      const revision = (read as { ok: true; value: { revision: string } }).value.revision

      const edited = await store.dispatch({
        method: 'edit_page',
        params: {
          document_id: project.id,
          page_id: page.id,
          expected_revision: revision,
          operations: [{ type: 'set-page', patch: { name: 'Agent page' } }],
        },
      })

      expect(edited.ok).toBe(true)
      expect(store.getSnapshot().project?.slides.pages[0]?.name).toBe('Agent page')
      expect(store.getSnapshot().canUndo).toBe(true)
      await store.flush()
      expect(JSON.parse(readRecovery()!).projects[0].slides.pages[0].name).toBe('Agent page')
      expect(save).not.toHaveBeenCalled()
      expect(store.getSnapshot().saveStatus).toBe('saved')
      expect(store.undo()?.slides.pages[0]?.name).toBe('Slide 1')
    } finally {
      store.dispose()
    }
  })

  it('imports PPTX into a pure project while the Store owns source metadata', async () => {
    const { store } = setup()
    try {
      await store.restore()
      const opened = await store.dispatch({
        method: 'open',
        params: { target: '/Imported.pptx', file_name: 'Imported.pptx', content_base64: 'AQ==' },
      })

      expect(opened.ok).toBe(true)
      const snapshot = store.getSnapshot()
      expect(snapshot.project).toMatchObject({ title: 'Imported' })
      expect(snapshot.project).not.toHaveProperty('source')
      expect(snapshot.project).not.toHaveProperty('revision')
      expect(snapshot.projectMetadata[snapshot.activeProjectId]).toEqual({
        revision: 1,
        savedRevision: 1,
        source: { path: '/Imported.pptx', mtimeMs: 1 },
        sourceProtected: true,
      })
    } finally {
      store.dispose()
    }
  })

  it('reports project checkpoint failures independently from PPTX export', async () => {
    const { files, save, store } = setup()
    try {
      await store.restore()
      files.setRecovery = async () => { throw new Error('Checkpoint unavailable') }
      const current = store.getSnapshot().project!
      store.commitProject(current, { ...current, title: 'Retained in memory' })

      await expect(store.flush()).rejects.toThrow('Checkpoint unavailable')
      expect(store.getSnapshot()).toMatchObject({
        persistenceError: 'Checkpoint unavailable',
        project: { title: 'Retained in memory' },
        saveStatus: 'error',
      })
      expect(store.getSnapshot().exportError).toBeNull()
      expect(save).not.toHaveBeenCalled()
    } finally {
      store.dispose()
    }
  })

  it('keeps a dirty project open on cancel and closes it only after discard', async () => {
    const { confirmClose, project, save, store } = setup()
    try {
      await store.restore()
      expect(await store.closeProject(project.id)).toEqual({ closeSurface: false })
      expect(store.getSnapshot().projects).toHaveLength(1)
      expect(save).not.toHaveBeenCalled()

      confirmClose.mockResolvedValue('discard')
      expect(await store.closeProject(project.id)).toEqual({ closeSurface: true })
      expect(store.getSnapshot().projects).toHaveLength(0)
      expect(confirmClose).toHaveBeenCalledTimes(2)
    } finally {
      store.dispose()
    }
  })

  it('exports a dirty project before closing the PowerPoint surface when requested', async () => {
    const { confirmClose, readRecovery, save, store } = setup()
    confirmClose.mockResolvedValue('save')
    try {
      await store.restore()
      expect(await store.closeAll()).toBe(true)
      expect(save).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot().projects).toHaveLength(0)
      expect(JSON.parse(readRecovery()!).projects).toEqual([])
    } finally {
      store.dispose()
    }
  })

  it('flushes the Store-bound native editor before changing projects', async () => {
    const { store } = setup()
    const binding = createOfficeEditorBinding<PresentationProject>({
      appKind: 'presentation',
      documentId: null,
      sessionId: 'presentation-store-test',
    })
    let flushes = 0
    binding.attach({
      dispose: () => undefined,
      flush: () => { flushes += 1 },
      readSnapshot: () => null,
    })
    try {
      await store.restore()
      binding.bindDocument(store.getSnapshot().project!.id)
      const unbind = store.bindEditor(binding)
      await store.createProject()
      expect(flushes).toBe(1)
      unbind()
    } finally {
      binding.dispose()
      store.dispose()
    }
  })
})
