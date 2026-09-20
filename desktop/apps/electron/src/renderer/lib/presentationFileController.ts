import type { PresentationProject } from '@/atoms/presentation'
import type { OfficeFileSource, OfficeFilesAPI } from '../../shared/office-files'
import {
  migratePresentationCheckpoint,
  type PresentationCheckpoint,
  type PresentationProjectMetadata,
} from '@/presentation/checkpoint'
import { createOfficePersistenceScheduler } from './office/officePersistence'
import { i18n } from './i18n'

/** PPTX is an import/export boundary; automatic persistence stores only project checkpoints. */
export function createPresentationFileController(options: {
  sessionId: string
  files: OfficeFilesAPI
  read: () => PresentationCheckpoint
  commitExport: (projectId: string, fileName: string, source: OfficeFileSource, exportedRevision: number) => void
  encode: (project: PresentationProject) => Promise<Uint8Array>
  flushEditor: () => Promise<void>
  /** Whether the destination is a Session-managed file rather than a user-owned import. */
  managed: boolean
  onExportStatus?: (status: 'saving' | 'saved' | 'error', error?: string) => void
}) {
  const recovery = createOfficePersistenceScheduler<PresentationCheckpoint>({
    policy: { appKind: 'presentation', sessionId: options.sessionId, kind: 'recovery', storage: 'recovery-file', automatic: true },
    delayMs: 150,
    write: (checkpoint) => options.files.setRecovery('presentation', options.sessionId, JSON.stringify(checkpoint)),
  })
  let ready = false

  const save = async (projectId: string, saveAs = false, destination?: string): Promise<boolean> => {
    await options.flushEditor()
    const checkpoint = options.read()
    const project = checkpoint.projects.find((item) => item.id === projectId)
    const metadata = checkpoint.projectMetadata[projectId]
    if (!project || !metadata) throw new Error('The presentation project is no longer open')
    if (!saveAs && !isPresentationProjectDirty(metadata)) {
      await recovery.persist(options.read())
      const current = options.read().projectMetadata[projectId]
      return Boolean(current && !isPresentationProjectDirty(current))
    }
    if (metadata.sourceProtected && !saveAs && !options.managed) throw new Error(i18n.t('office.protectedSave'))
    const exportedRevision = metadata.revision
    const result = await options.files.save({
      kind: 'presentation',
      managed: options.managed,
      documentId: projectId,
      source: metadata.source,
      preserveSource: metadata.sourceProtected,
      saveAs,
      destination,
      suggestedName: `${project.title.replace(/\.pptx$/i, '') || 'Untitled'}.pptx`,
      bytes: await options.encode(project),
    })
    if (!result.ok) {
      if (result.reason === 'conflict') throw new Error('The file changed outside the editor. Your edits have been retained; retry after resolving the file change.')
      if (result.reason === 'source-protected') throw new Error(i18n.t('office.protectedSave'))
      return false
    }
    await options.flushEditor()
    options.commitExport(projectId, result.fileName, result.source, exportedRevision)
    await recovery.persist(options.read())
    const current = options.read().projectMetadata[projectId]
    return Boolean(current && !isPresentationProjectDirty(current))
  }

  return {
    recovery,
    async restore(): Promise<PresentationCheckpoint | null> {
      const serialized = await options.files.getRecovery('presentation', options.sessionId)
      const checkpoint = serialized === null ? null : migratePresentationCheckpoint(JSON.parse(serialized))
      ready = true
      return checkpoint
    },
    schedule() {
      if (ready) recovery.schedule(options.read())
    },
    async flush() {
      if (!ready) throw new Error('PowerPoint recovery is not ready')
      await options.flushEditor()
      await recovery.persist(options.read())
    },
    async save(projectId: string, saveAs = false, destination?: string) {
      options.onExportStatus?.('saving')
      try {
        const saved = await save(projectId, saveAs, destination)
        options.onExportStatus?.(saved ? 'saved' : 'saving')
        return saved
      } catch (error) {
        options.onExportStatus?.('error', error instanceof Error ? error.message : String(error))
        throw error
      }
    },
  }
}

export function isPresentationProjectDirty(metadata: PresentationProjectMetadata): boolean {
  return !metadata.source || metadata.source.mtimeMs === null || metadata.savedRevision !== metadata.revision
}
