import { createInitialPresentationProject, replacePresentationPages, type PresentationProject } from '@/atoms/presentation'
import type { OfficeFilesAPI } from '../../shared/office-files'
import { PresentationStore } from '@/presentation/store'

export async function createPresentationTestStore(sessionId: string, project: PresentationProject = createInitialPresentationProject()): Promise<PresentationStore> {
  project = { ...project, slides: replacePresentationPages(project.slides, project.slides.pages) }
  let recovery: string | null = JSON.stringify({
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
    projectMetadata: { [project.id]: { revision: 1 } },
  })
  const files: OfficeFilesAPI = {
    confirmClose: async () => 'cancel',
    getRecovery: async () => recovery,
    inspect: async (_kind, path) => ({ path, mtimeMs: null }),
    save: async () => ({ ok: false, reason: 'canceled' }),
    setRecovery: async (_kind, _sessionId, value) => { recovery = value },
  }
  const store = new PresentationStore(sessionId, {
    encode: async () => new Uint8Array(),
    files,
    importPptx: async () => { throw new Error('PPTX import is not configured for this test') },
    managedFiles: false,
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
