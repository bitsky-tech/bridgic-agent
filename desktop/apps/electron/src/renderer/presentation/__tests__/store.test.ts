import { describe, expect, it, mock } from 'bun:test'
import { createBlankPresentationProject, type PresentationProject } from '@/atoms/presentation'
import { createPresentationImageElement } from '@/lib/presentationInsert'
import type { PresentationWorkspace } from '@/presentation/workspace'
import type { OfficeFilesAPI } from '../../../shared/office-files'
import { createOfficeEditorBinding } from '@/lib/office/officeEditorBinding'
import { createMemoryWorkspacePersistence } from '@/test-fixtures/presentation-workspace'
import { PresentationStore } from '../store'
import { presentationPptxSource } from '../sourceReference'

function setup(importPptx: (encoded: string, fileName: string) => Promise<PresentationProject> = async (_encoded, fileName) => createBlankPresentationProject(fileName.replace(/\.pptx$/i, ''))) {
  const project = createBlankPresentationProject('Store project')
  const workspace: PresentationWorkspace = {
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
    projectMetadata: { [project.id]: { revision: 1 } },
  }
  const workspaces = createMemoryWorkspacePersistence(workspace, 'presentation-store-test')
  const save = mock(async () => ({
    ok: true as const,
    fileName: 'Store project.pptx',
    source: { path: '/Store project.pptx', mtimeMs: 2 },
  }))
  const confirmClose = mock(async () => 'cancel' as 'cancel' | 'discard' | 'save')
  const mountedSource = {
    id: 'source-mount', name: 'source.png', path: '/sources/source.png', kind: 'file' as const,
    exists: true, size_bytes: 4, item_count: null, removable: true, created_at: new Date(0).toISOString(),
  }
  const mountPresentationSource = mock(async () => mountedSource)
  const files: OfficeFilesAPI = {
    inspect: async (_kind, path) => ({ path, mtimeMs: 1 }),
    save,
    confirmClose,
    getRecovery: async () => null,
    setRecovery: async () => undefined,
    listPresentationMounts: async () => [mountedSource],
    mountPresentationSource,
  }
  const store = new PresentationStore('presentation-store-test', {
    workspacePersistence: workspaces.persistence,
    encode: async () => new Uint8Array([1, 2, 3]),
    files,
    importPptx,
    managedFiles: false,
  })
  return { workspaces, confirmClose, files, mountPresentationSource, project, save, store }
}

describe('PresentationStore', () => {
  it('restores an empty Session without inventing a project', async () => {
    const { workspaces, store } = setup()
    workspaces.replace(null)
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
    const { workspaces, save, store } = setup()
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

      expect(workspaces.read()!.projects[0]!.title).toBe('Edited in UI')
      expect(save).not.toHaveBeenCalled()
      expect(store.getSnapshot()).toMatchObject({ persistenceError: null, saveStatus: 'saved' })
      unsubscribe()
    } finally {
      store.dispose()
    }
  })

  it('commits Agent commands into the same project and history', async () => {
    const { workspaces, save, store } = setup()
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
      expect(workspaces.read()!.projects[0]!.slides.pages[0]!.name).toBe('Agent page')
      expect(save).not.toHaveBeenCalled()
      expect(store.getSnapshot().saveStatus).toBe('saved')
      expect(store.undo()?.slides.pages[0]?.name).toBe('Slide 1')
    } finally {
      store.dispose()
    }
  })

  it('publishes Agent edits before their asynchronous workspace write finishes', async () => {
    const { workspaces, store } = setup()
    try {
      await store.restore()
      workspaces.setBeforeWrite(async () => { throw new Error('Workspace unavailable') })
      const project = store.getSnapshot().project!
      const page = project.slides.pages[0]!
      const read = await store.dispatch({ method: 'read_page', params: { document_id: project.id, page_id: page.id, format: 'model' } })
      if (!read.ok) throw new Error(read.error)

      const edited = await store.dispatch({
        method: 'edit_page',
        params: {
          document_id: project.id,
          page_id: page.id,
          expected_revision: (read.value as { revision: string }).revision,
          operations: [{ type: 'set-page', patch: { name: 'Visible immediately' } }],
        },
      })

      expect(edited.ok).toBe(true)
      expect(store.getSnapshot()).toMatchObject({ project: { slides: { pages: [{ name: 'Visible immediately' }] } }, saveStatus: 'saving' })
      await expect(store.flush()).rejects.toThrow('Workspace unavailable')
      expect(store.getSnapshot()).toMatchObject({ persistenceError: 'Workspace unavailable', project: { slides: { pages: [{ name: 'Visible immediately' }] } } })
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

  it('keeps imported assets as references into the original PPTX without adding Files mounts', async () => {
    const source = { dataUrl: 'data:image/png;base64,cG5n', fileName: 'embedded.png', mimeType: 'image/png' }
    const imported = createBlankPresentationProject('Imported assets')
    const element = createPresentationImageElement(source)
    imported.assets = [{
      id: element.sourceAssetId,
      kind: 'image',
      mimeType: source.mimeType,
      name: source.fileName,
      source: presentationPptxSource(imported.id, 'ppt/media/embedded.png'),
    }]
    imported.slides.pages[0]!.elements = [element]
    const { workspaces, mountPresentationSource, store } = setup(async () => imported)
    try {
      await store.restore()
      const opened = await store.dispatch({
        method: 'open',
        params: { target: '/Imported.pptx', file_name: 'Imported.pptx', content_base64: 'AQ==' },
      })

      expect(opened.ok).toBe(true)
      expect(mountPresentationSource).not.toHaveBeenCalled()
      expect(store.getSnapshot().project!.assets[0]!.source).toBe(presentationPptxSource(imported.id, 'ppt/media/embedded.png'))
      await store.flush()
      expect(JSON.stringify(workspaces.read())).not.toContain('data:image')
    } finally {
      store.dispose()
    }
  })

  it('keeps package references bound to the stable project identity when reopening a changed PPTX', async () => {
    let importCount = 0
    const { files, store } = setup(async () => {
      const imported = createBlankPresentationProject(`Import ${++importCount}`)
      imported.assets = [{
        id: 'embedded-asset', kind: 'image', mimeType: 'image/png', name: 'embedded.png',
        source: presentationPptxSource(imported.id, 'ppt/media/embedded.png'),
      }]
      return imported
    })
    try {
      await store.restore()
      await store.dispatch({
        method: 'open',
        params: { target: '/Imported.pptx', file_name: 'Imported.pptx', content_base64: 'AQ==' },
      })
      const stableProjectId = store.getSnapshot().project!.id
      files.inspect = async (_kind, path) => ({ path, mtimeMs: 2 })

      const reopened = await store.dispatch({
        method: 'open',
        params: { target: '/Imported.pptx', file_name: 'Imported.pptx', content_base64: 'Ag==' },
      })

      expect(reopened.ok).toBe(true)
      expect(store.getSnapshot().project!.id).toBe(stableProjectId)
      expect(store.getSnapshot().project!.assets[0]!.source).toBe(presentationPptxSource(stableProjectId, 'ppt/media/embedded.png'))
    } finally {
      store.dispose()
    }
  })

  it('keeps inserted files mounted after export', async () => {
    const { mountPresentationSource, save, store } = setup()
    try {
      await store.restore()
      const source = { dataUrl: 'data:image/png;base64,cG5n', fileName: 'inserted.png', mimeType: 'image/png' }
      const asset = await store.mountFileSource('image', source, '/sources/inserted.png', 3, 10)
      const current = store.getSnapshot().project!
      const element = { ...createPresentationImageElement(source), sourceAssetId: asset.id }
      const inserted = store.commitProject(current, {
        ...current,
        assets: [asset],
        slides: { ...current.slides, pages: [{ ...current.slides.pages[0]!, elements: [element] }] },
      })
      store.commitProject(inserted, { ...inserted, title: 'Edited after insert' })

      expect(asset.source).toBe('bridgic-mount:source-mount')
      expect(await store.save(current.id)).toBe(true)

      expect(save).toHaveBeenCalledTimes(1)
      expect(mountPresentationSource).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot().project!.assets[0]!.source).toBe('bridgic-mount:source-mount')
      expect(store.mountUsage('source-mount')).toEqual({ assetCount: 1, elementCount: 1, projectCount: 1 })
      expect(store.undo()!.assets[0]!.source).toBe('bridgic-mount:source-mount')
    } finally {
      store.dispose()
    }
  })

  it('reports workspace persistence failures independently from PPTX export', async () => {
    const { workspaces, save, store } = setup()
    let fail = true
    try {
      await store.restore()
      workspaces.setBeforeWrite(async () => { if (fail) throw new Error('Workspace unavailable') })
      const current = store.getSnapshot().project!
      store.commitProject(current, { ...current, title: 'Retained in memory' })

      await expect(store.flush()).rejects.toThrow('Workspace unavailable')
      expect(store.getSnapshot()).toMatchObject({
        persistenceError: 'Workspace unavailable',
        project: { title: 'Retained in memory' },
        saveStatus: 'error',
      })
      expect(store.getSnapshot().exportError).toBeNull()
      expect(save).not.toHaveBeenCalled()

      fail = false
      await store.retryPersistence()
      expect(store.getSnapshot()).toMatchObject({ persistenceError: null, saveStatus: 'saved' })
      expect(workspaces.read()!.projects[0]!.title).toBe('Retained in memory')
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
    const { workspaces, confirmClose, save, store } = setup()
    confirmClose.mockResolvedValue('save')
    try {
      await store.restore()
      expect(await store.closeAll()).toBe(true)
      expect(save).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot().projects).toHaveLength(0)
      expect(workspaces.read()!.projects).toEqual([])
    } finally {
      store.dispose()
    }
  })

  it('keeps projects in memory when the final workspace write cannot be saved', async () => {
    const { workspaces, confirmClose, project, store } = setup()
    confirmClose.mockResolvedValue('discard')
    try {
      await store.restore()
      workspaces.setBeforeWrite(async () => { throw new Error('Workspace unavailable') })

      await expect(store.closeAll()).rejects.toThrow('Workspace unavailable')
      expect(store.getSnapshot()).toMatchObject({ activeProjectId: project.id, project: { id: project.id } })
      expect(store.getSnapshot().projects).toHaveLength(1)
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

  it('stores mounted asset references and removes referenced elements without dangling comments', async () => {
    const { workspaces, mountPresentationSource, store } = setup()
    try {
      await store.restore()
      const source = { dataUrl: 'data:image/png;base64,cG5n', fileName: 'source.png', mimeType: 'image/png' }
      const asset = await store.mountFileSource('image', source, '/sources/source.png', 4, 10)
      const current = store.getSnapshot().project!
      const page = current.slides.pages[0]!
      const element = { ...createPresentationImageElement(source), sourceAssetId: asset.id }
      store.commitProject(current, {
        ...current,
        assets: [asset],
        slides: {
          ...current.slides,
          pages: [{
            ...page,
            elements: [element],
            comments: [{
              id: 'asset-comment', author: 'Reviewer', createdAt: new Date(0).toISOString(),
              resolved: false, text: 'Keep this review', elementId: element.id,
            }],
          }],
        },
      })

      expect(mountPresentationSource).toHaveBeenCalledWith({
        fileName: 'source.png', mimeType: 'image/png', path: '/sources/source.png',
      })
      expect(asset.source).toBe('bridgic-mount:source-mount')
      expect(store.mountUsage('source-mount')).toEqual({ assetCount: 1, elementCount: 1, projectCount: 1 })
      expect(store.removeMountReferences('source-mount')).toEqual({ assetCount: 1, elementCount: 1, projectCount: 1 })
      expect(store.getSnapshot().project).toMatchObject({
        assets: [],
        slides: { pages: [{ elements: [], comments: [{ id: 'asset-comment', text: 'Keep this review' }] }] },
      })
      expect(store.getSnapshot().project!.slides.pages[0]!.comments![0]).not.toHaveProperty('elementId')
      await store.flush()
      expect(JSON.stringify(workspaces.read())).not.toContain('data:image')
    } finally {
      store.dispose()
    }
  })
})
