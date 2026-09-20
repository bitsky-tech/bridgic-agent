import type { PresentationProject } from '@/atoms/presentation'
import type { OfficeFileSource } from '../../shared/office-files'
import { migratePresentationProject } from './project'

export interface PresentationProjectMetadata {
  revision: number
  savedRevision?: number
  source?: OfficeFileSource
  sourceProtected?: boolean
}

export interface PresentationCheckpoint {
  schemaVersion: 1
  activeProjectId: string
  projects: PresentationProject[]
  projectMetadata: Record<string, PresentationProjectMetadata>
}

export function initialPresentationProjectMetadata(): PresentationProjectMetadata {
  return { revision: 1 }
}

export function migratePresentationCheckpoint(value: unknown): PresentationCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The PowerPoint recovery checkpoint is invalid')
  const raw = value as Record<string, unknown>
  const legacyDocuments = Array.isArray(raw.documents) ? raw.documents : null
  const rawProjects = Array.isArray(raw.projects) ? raw.projects : legacyDocuments
  let rawActiveProjectId: string | null = null
  if (typeof raw.activeProjectId === 'string') rawActiveProjectId = raw.activeProjectId
  else if (typeof raw.activeDocumentId === 'string') rawActiveProjectId = raw.activeDocumentId
  if (!rawProjects || rawActiveProjectId === null) throw new Error('The PowerPoint recovery checkpoint is invalid')

  const projects = rawProjects.map((project) => migratePresentationProject(project))
  const projectMetadata: Record<string, PresentationProjectMetadata> = {}
  const suppliedMetadata = raw.projectMetadata && typeof raw.projectMetadata === 'object' && !Array.isArray(raw.projectMetadata)
    ? raw.projectMetadata as Record<string, unknown>
    : {}
  rawProjects.forEach((rawProject, index) => {
    const project = projects[index]!
    const legacy = rawProject && typeof rawProject === 'object' && !Array.isArray(rawProject)
      ? rawProject as Record<string, unknown>
      : {}
    const supplied = suppliedMetadata[project.id] && typeof suppliedMetadata[project.id] === 'object' && !Array.isArray(suppliedMetadata[project.id])
      ? suppliedMetadata[project.id] as Record<string, unknown>
      : {}
    const source = officeFileSource(supplied.source ?? legacy.source)
    const revision = finiteRevision(supplied.revision ?? legacy.revision ?? (raw.schemaVersion === undefined ? legacy.version : undefined))
    const savedRevision = finiteOptionalRevision(supplied.savedRevision ?? legacy.savedRevision ?? legacy.savedVersion)
    const suppliedSourceProtected = supplied.sourceProtected ?? legacy.sourceProtected
    const sourceProtected = typeof suppliedSourceProtected === 'boolean'
      ? suppliedSourceProtected
      : Boolean(source && source.mtimeMs !== null)
    projectMetadata[project.id] = {
      revision,
      ...(savedRevision === undefined ? {} : { savedRevision }),
      ...(source ? { source } : {}),
      ...(source ? { sourceProtected } : {}),
    }
  })

  validatePresentationInventory(rawActiveProjectId, projects)
  return { schemaVersion: 1, activeProjectId: rawActiveProjectId, projects, projectMetadata }
}

export function validatePresentationInventory(activeProjectId: string, projects: readonly PresentationProject[]): void {
  const projectIds = new Set(projects.map((project) => project.id))
  if (projectIds.size !== projects.length
    || (projects.length > 0 && !projectIds.has(activeProjectId))
    || (projects.length === 0 && activeProjectId !== '')) {
    throw new Error('The PowerPoint recovery checkpoint has an invalid project inventory')
  }
}

function finiteRevision(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1
}

function finiteOptionalRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
}

function officeFileSource(value: unknown): OfficeFileSource | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The PowerPoint recovery checkpoint has invalid source metadata')
  }
  const source = value as Record<string, unknown>
  if (typeof source.path !== 'string' || !source.path
    || (source.mtimeMs !== null && (typeof source.mtimeMs !== 'number' || !Number.isFinite(source.mtimeMs) || source.mtimeMs < 0))) {
    throw new Error('The PowerPoint recovery checkpoint has invalid source metadata')
  }
  return { path: source.path, mtimeMs: source.mtimeMs as number | null }
}
