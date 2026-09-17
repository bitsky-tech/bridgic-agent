import type { PresentationDocument, PresentationWorkspace } from '@/atoms/presentation'
import type { OfficeFilesAPI } from '../../shared/office-files'
import { createOfficePersistenceScheduler } from './office/officePersistence'
import { isPresentationDirty } from './presentationWorkspaceRuntime'
import { i18n } from './i18n'
import { createOfficeAutoSave } from './office/officeAutoSave'

/** Source files and recovery checkpoints have deliberately separate writers. */
export function createPresentationFileController(options: {
  sessionId: string
  files: OfficeFilesAPI
  read: () => PresentationWorkspace
  write: (workspace: PresentationWorkspace) => void
  encode: (document: PresentationDocument) => Promise<Uint8Array>
  flushEditor: () => Promise<void>
  locale: () => string
  automatic?: boolean
  runAutoSave?: (save: () => Promise<void>) => Promise<void>
  onSaveStatus?: (status: 'saving' | 'saved' | 'error', error?: string) => void
}) {
  const { files, read, write } = options
  let ready = false
  const recovery = createOfficePersistenceScheduler<PresentationWorkspace>({
    policy: { appKind: 'presentation', sessionId: options.sessionId, kind: 'recovery', storage: 'recovery-file', automatic: true },
    delayMs: 150,
    write: (workspace) => files.setRecovery('presentation', options.sessionId, JSON.stringify(workspace)),
  })
  const save = async (documentId: string, saveAs = false, destination?: string, background = false): Promise<boolean> => {
    if (!background) await options.flushEditor()
    const document = read().documents.find((item) => item.id === documentId)
    if (!document) throw new Error('The presentation is no longer open')
    if (!saveAs && !isPresentationDirty(document)) return true
    if (document.sourceProtected && !saveAs && !options.automatic) throw new Error(i18n.t('office.protectedSave'))
    const result = await files.save({ kind: 'presentation', managed: options.automatic, documentId, source: document.source, preserveSource: document.sourceProtected, saveAs, destination, suggestedName: `${document.title.replace(/\.pptx$/i, '') || 'Untitled'}.pptx`, bytes: await options.encode(document) })
    if (!result.ok) {
      if (result.reason === 'conflict') throw new Error('The file changed outside the editor. Your edits have been retained; retry after resolving the file change.')
      if (result.reason === 'source-protected') throw new Error(i18n.t('office.protectedSave'))
      return false
    }
    if (!background) await options.flushEditor()
    const current = read()
    write({ ...current, documents: current.documents.map((item) => {
      if (item.id === documentId) return { ...item, title: result.fileName.replace(/\.pptx$/i, ''), source: result.source, sourceProtected: false, savedVersion: document.version }
      return item.source?.path === result.source.path ? { ...item, source: undefined, savedVersion: undefined } : item
    }) })
    await recovery.persist(read())
    return !isPresentationDirty(read().documents.find((item) => item.id === documentId)!)
  }
  const saveDirty = async (requireComplete = false, background = false) => {
    if (!background) await options.flushEditor()
    for (const document of read().documents.filter(isPresentationDirty)) {
      if (!await save(document.id, false, undefined, background) && requireComplete) throw new Error(i18n.t('office.changedDuringClose'))
    }
  }
  const autoSave = createOfficeAutoSave(() => options.runAutoSave ? options.runAutoSave(() => saveDirty(false, true)) : saveDirty(false, true), options.onSaveStatus)
  return {
    recovery,
    autoSave,
    saveDirty,
    async restore() {
      const serialized = await files.getRecovery('presentation', options.sessionId)
      if (serialized !== null) {
        const workspace = JSON.parse(serialized) as PresentationWorkspace
        if (!Array.isArray(workspace.documents) || typeof workspace.activeDocumentId !== 'string'
          || workspace.documents.some((document) => !document.id || !Array.isArray(document.slides) || !document.master || !Number.isFinite(document.version))) throw new Error('The PowerPoint recovery checkpoint is invalid')
        if (workspace.documents.length) write({ ...workspace, documents: workspace.documents.map((document) => ({
          ...document, sourceProtected: document.sourceProtected ?? Boolean(document.source && document.source.mtimeMs !== null),
        })) })
      }
      ready = true
      if (options.automatic) autoSave.schedule(read().documents.filter(isPresentationDirty).map((document) => `${document.id}:${document.version}`).join('|'))
    },
    schedule() {
      if (!ready) return
      recovery.schedule(read())
      if (options.automatic) autoSave.schedule(read().documents.filter(isPresentationDirty).map((document) => `${document.id}:${document.version}`).join('|'))
    },
    async flush() {
      if (!ready) throw new Error('PowerPoint recovery is not ready')
      await options.flushEditor()
      await recovery.persist(read())
    },
    save,
    async beforeClose(documentId: string): Promise<boolean> {
      await options.flushEditor()
      const document = read().documents.find((item) => item.id === documentId)
      if (!document || !isPresentationDirty(document)) return true
      if (options.automatic) return save(documentId)
      const decision = await files.confirmClose(`${document.title.replace(/\.pptx$/i, '')}.pptx`, options.locale())
      if (decision === 'cancel') return false
      if (decision === 'save') return save(documentId, Boolean(document.sourceProtected))
      await options.flushEditor()
      return read().documents.find((item) => item.id === documentId)?.version === document.version
    },
  }
}
