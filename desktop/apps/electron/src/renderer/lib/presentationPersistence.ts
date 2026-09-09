import type { PresentationDocument, PresentationWorkspace } from '@/atoms/presentation'
import { createOfficePersistenceScheduler, OfficePersistenceError, type OfficePersistenceScheduler, type OfficePersistenceSnapshot } from './office/officePersistence'
import { PowerPointProtocolError, type PowerPointRequest } from './powerPointProtocol'

interface PresentationSourceWrite {
  document: PresentationDocument
  target: string
}

const SOURCE_MUTATIONS = new Set([
  'update_ppt_design', 'edit_ppt_page', 'insert_ppt_element', 'remove_ppt_element',
  'insert_ppt_page', 'remove_ppt_page', 'move_ppt_page',
])

/** Source-file checkpoints only; unbound tabs have no implied save destination. */
export function createPresentationPersistence(options: {
  sessionId: string
  encode: (document: PresentationDocument) => Promise<Uint8Array>
  write: (target: string, bytes: Uint8Array) => Promise<void>
}) {
  let binding: { documentId: string; target: string } | null = null
  let disposed = false
  const listeners = new Set<(snapshot: OfficePersistenceSnapshot) => void>()
  const writers = new Map<string, OfficePersistenceScheduler<PresentationSourceWrite>>()
  const policy = Object.freeze({ appKind: 'presentation', sessionId: options.sessionId, kind: 'source', storage: 'source-file', automatic: true } as const)
  const idleSnapshot: OfficePersistenceSnapshot = Object.freeze({ policy, status: 'idle', pendingCount: 0, error: null })
  const key = ({ document, target }: PresentationSourceWrite) => JSON.stringify([target, document.id, document.version])
  const writerFor = (target: string) => {
    const existing = writers.get(target)
    if (existing) return existing
    const writer = createOfficePersistenceScheduler<PresentationSourceWrite>({
      policy,
      coalesce: false,
      key,
      write: async ({ document, target }) => {
        const bytes = await options.encode(document)
        await options.write(target, bytes)
      },
      onStatusChange: (snapshot) => {
        if (binding?.target === target) for (const listener of listeners) listener(snapshot)
      },
    })
    writers.set(target, writer)
    return writer
  }

  const sourceWrite = (workspace: PresentationWorkspace): PresentationSourceWrite | null => {
    const source = binding
    if (!source || source.documentId !== workspace.activeDocumentId) return null
    const document = workspace.documents.find((item) => item.id === source.documentId)
    return document ? { document, target: source.target } : null
  }

  const flush = async () => { await Promise.all([...writers.values()].map((writer) => writer.flush())) }
  const getSnapshot = () => binding ? writerFor(binding.target).getSnapshot() : idleSnapshot

  return {
    getSnapshot,
    subscribe(listener: (snapshot: OfficePersistenceSnapshot) => void) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Bind only documents opened by view_ppt, including an explicitly created target. */
    bindTarget(target: string, workspace: PresentationWorkspace, imported: boolean) {
      if (disposed) throw new OfficePersistenceError('disposed', 'This PowerPoint persistence channel is closed.')
      const document = workspace.documents.find((item) => item.id === workspace.activeDocumentId)
      if (!document) throw new Error('The PowerPoint target has no active document.')
      binding = { documentId: document.id, target }
      const writer = writerFor(target)
      if (imported) writer.acknowledge(key({ document, target }))
      for (const listener of listeners) listener(writer.getSnapshot())
    },
    targetFor(workspace: PresentationWorkspace): string | null {
      return sourceWrite(workspace)?.target ?? null
    },
    /** Called inside the workspace command queue, before decoding or mutating a document. */
    async prepareProtocol(request: PowerPointRequest, readWorkspace: () => PresentationWorkspace, writeWorkspace: (workspace: PresentationWorkspace) => void): Promise<void> {
      const workspace = readWorkspace()
      if (request.method === 'view_ppt' && typeof request.params?.target === 'string') {
        const target = request.params.target.trim()
        const source = binding
        const existing = source?.target === target ? workspace.documents.find((document) => document.id === source.documentId) : undefined
        if (existing) {
          if (workspace.activeDocumentId !== existing.id) writeWorkspace({ ...workspace, activeDocumentId: existing.id })
          await writerFor(target).flush()
          return
        }
        const writer = writers.get(target)
        if (writer && (writer.getSnapshot().pendingCount > 0 || writer.getSnapshot().status === 'error')) {
          await writer.flush()
          // The caller read content_base64 before this flush and must fetch the file again.
          throw new PowerPointProtocolError('The PowerPoint source was still being saved. Call view_ppt again to read its latest contents.', 'document_changed')
        }
      }
      if (SOURCE_MUTATIONS.has(request.method) && !sourceWrite(workspace)) {
        throw new PowerPointProtocolError('The active PowerPoint has no associated source file. Call view_ppt before editing it.', 'document_changed')
      }
    },
    persist(workspace: PresentationWorkspace): Promise<void> {
      if (disposed) return Promise.reject(new OfficePersistenceError('disposed', 'This PowerPoint persistence channel is closed.'))
      const source = sourceWrite(workspace)
      return source ? writerFor(source.target).persist(source) : Promise.resolve()
    },
    flush,
    /** Include edits made while encoding, then close only after their file acknowledgements. */
    async checkpoint(readWorkspace: () => PresentationWorkspace): Promise<void> {
      while (true) {
        if (disposed) throw new OfficePersistenceError('disposed', 'This PowerPoint persistence channel is closed.')
        const source = sourceWrite(readWorkspace())
        if (source) await writerFor(source.target).persist(source)
        await flush()
        const latest = sourceWrite(readWorkspace())
        if ((latest ? key(latest) : null) === (source ? key(source) : null)) return
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      for (const writer of writers.values()) writer.dispose()
    },
  }
}
