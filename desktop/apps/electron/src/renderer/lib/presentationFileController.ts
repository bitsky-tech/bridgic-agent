import type { PresentationProject } from '@/atoms/presentation'
import type { OfficeFileSource, OfficeFilesAPI } from '../../shared/office-files'
import {
  type PresentationWorkspace,
  type PresentationProjectMetadata,
} from '@/presentation/workspace'
import { i18n } from './i18n'

/** PPTX is an explicit import/export boundary; workspace persistence belongs to PresentationStore. */
export function createPresentationFileController(options: {
  files: OfficeFilesAPI
  read: () => PresentationWorkspace
  commitExport: (projectId: string, fileName: string, source: OfficeFileSource, exportedRevision: number) => void | Promise<void>
  encode: (project: PresentationProject) => Promise<Uint8Array>
  flushEditor: () => Promise<void>
  /** Whether the destination is a Session-managed file rather than a user-owned import. */
  managed: boolean
  onExportStatus?: (status: 'saving' | 'saved' | 'error', error?: string) => void
}) {
  const save = async (projectId: string, saveAs = false, destination?: string): Promise<boolean> => {
    await options.flushEditor()
    const workspace = options.read()
    const project = workspace.projects.find((item) => item.id === projectId)
    const metadata = workspace.projectMetadata[projectId]
    if (!project || !metadata) throw new Error('The presentation project is no longer open')
    if (!saveAs && !isPresentationProjectDirty(metadata)) {
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
    await options.commitExport(projectId, result.fileName, result.source, exportedRevision)
    const current = options.read().projectMetadata[projectId]
    return Boolean(current && !isPresentationProjectDirty(current))
  }

  return {
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
