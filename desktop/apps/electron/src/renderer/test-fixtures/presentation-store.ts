import { createInitialPresentationProject, replacePresentationPages, type PresentationProject } from '@/atoms/presentation'
import type { OfficeFilesAPI } from '../../shared/office-files'
import { PresentationStore } from '@/presentation/store'
import { presentationMountSource } from '@/presentation/sourceReference'
import { createMemoryWorkspacePersistence } from './presentation-workspace'

export async function createPresentationTestStore(sessionId: string, project: PresentationProject = createInitialPresentationProject()): Promise<PresentationStore> {
  const sourceValues = new Map<string, string>()
  project = {
    ...project,
    assets: project.assets.map((asset) => {
      const source = presentationMountSource(`test-${asset.id}`)
      sourceValues.set(source, asset.source)
      return { ...asset, source }
    }),
    slides: replacePresentationPages(project.slides, project.slides.pages),
  }
  const workspaces = createMemoryWorkspacePersistence({
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
    projectMetadata: { [project.id]: { revision: 1 } },
  }, sessionId)
  let mountedSourceOrdinal = 0
  const files: OfficeFilesAPI = {
    confirmClose: async () => 'discard',
    getRecovery: async () => null,
    inspect: async (_kind, path) => ({ path, mtimeMs: null }),
    listPresentationMounts: async () => [],
    mountPresentationSource: async ({ fileName }) => ({
      id: `test-mounted-${++mountedSourceOrdinal}`,
      name: fileName,
      path: `/presentation-test-assets/${fileName}`,
      kind: 'file',
      exists: true,
      size_bytes: null,
      item_count: null,
      removable: true,
      created_at: new Date(0).toISOString(),
    }),
    save: async () => ({ ok: false, reason: 'canceled' }),
    setRecovery: async () => undefined,
  }
  const store = new PresentationStore(sessionId, {
    workspacePersistence: workspaces.persistence,
    encode: async () => new Uint8Array(),
    files,
    importPptx: async () => { throw new Error('PPTX import is not configured for this test') },
    managedFiles: false,
    resolveSources: async (sourceRefs) => Object.fromEntries(sourceRefs.flatMap((source) => {
      const value = sourceValues.get(source)
      return value ? [[source, value]] : []
    })),
  })
  await store.restore()
  return store
}

export function readPresentationTestProject(store: PresentationStore): PresentationProject {
  const project = store.getSnapshot().project
  if (!project) throw new Error('The presentation test Store has no active project')
  return project
}

export function replacePresentationTestProject(store: PresentationStore, update: PresentationProject | ((current: PresentationProject) => PresentationProject)): PresentationProject {
  const current = readPresentationTestProject(store)
  const next = typeof update === 'function' ? update(current) : update
  return store.commitProject(current, next)
}
