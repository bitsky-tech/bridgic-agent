import { describe, expect, it, mock } from 'bun:test'
import { createBlankPresentationProject } from '@/atoms/presentation'
import type { PresentationWorkspace } from '@/presentation/workspace'
import type { OfficeFilesAPI } from '../../../shared/office-files'
import { createPresentationFileController } from '../presentationFileController'

function setup() {
  const project = createBlankPresentationProject('Deck')
  let workspace: PresentationWorkspace = {
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
    projectMetadata: { [project.id]: { revision: 2 } },
  }
  const save = mock(async () => ({ ok: true as const, fileName: 'Deck.pptx', source: { path: '/Deck.pptx', mtimeMs: 2 } }))
  const files: OfficeFilesAPI = {
    confirmClose: async () => 'cancel', getRecovery: async () => null,
    inspect: async (_kind, path) => ({ path, mtimeMs: null }), save, setRecovery: async () => undefined,
  }
  const controller = createPresentationFileController({
    files, read: () => workspace, encode: async () => new Uint8Array([1, 2, 3]), flushEditor: async () => undefined, managed: false,
    commitExport: (projectId, _fileName, source, exportedRevision) => {
      workspace = { ...workspace, projectMetadata: { ...workspace.projectMetadata,
        [projectId]: { revision: 2, savedRevision: exportedRevision, source, sourceProtected: false } } }
    },
  })
  return { controller, project, save, workspace: () => workspace }
}

describe('presentation file controller', () => {
  it('exports PPTX only on an explicit save request', async () => {
    const { controller, project, save, workspace } = setup()
    expect(await controller.save(project.id)).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(workspace().projectMetadata[project.id]).toMatchObject({ savedRevision: 2, source: { path: '/Deck.pptx' } })
  })

  it('does not rewrite a clean project', async () => {
    const { controller, project, save, workspace } = setup()
    workspace().projectMetadata[project.id] = { revision: 2, savedRevision: 2, source: { path: '/Deck.pptx', mtimeMs: 2 } }
    expect(await controller.save(project.id)).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('protects imported files from implicit overwrite', async () => {
    const { controller, project, save, workspace } = setup()
    workspace().projectMetadata[project.id] = { revision: 2, savedRevision: 1, source: { path: '/Imported.pptx', mtimeMs: 1 }, sourceProtected: true }
    await expect(controller.save(project.id)).rejects.toThrow()
    expect(save).not.toHaveBeenCalled()
  })
})
