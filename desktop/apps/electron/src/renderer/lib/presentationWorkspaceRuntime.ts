import {
  createInitialPresentationDocument,
  type PresentationDocument,
  type PresentationWorkspace,
} from '@/atoms/presentation'
import { createOfficeWorkspaceRuntime } from './office/officeWorkspaceRuntime'
import type { OfficeEditorBinding } from './office/officeEditorBinding'
import {
  executePowerPointRequest,
  PowerPointProtocolError,
  type PowerPointDispatchResult,
  type PowerPointRequest,
  type PowerPointRuntimeContext,
} from './powerPointProtocol'

const POWERPOINT_METHODS = [
  'view_ppt', 'inspect_ppt_assets', 'get_ppt_page', 'update_ppt_design',
  'edit_ppt_page', 'insert_ppt_element', 'remove_ppt_element', 'insert_ppt_page',
  'remove_ppt_page', 'move_ppt_page', 'goto_ppt_page',
] as const

export const PRESENTATION_WORKSPACE_CAPABILITIES = [
  'document.create', 'document.activate', 'document.close', 'document.edit',
  ...POWERPOINT_METHODS.map((method) => `powerpoint.${method}`),
] as const

type ProtocolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code?: string }

interface PresentationWorkspaceRuntimeOptions {
  sessionId: string
  read: () => PresentationWorkspace
  write: (workspace: PresentationWorkspace) => void
}

/** Coordinate commands around the existing presentation model, never a copy of it. */
export function createPresentationWorkspaceRuntime(options: PresentationWorkspaceRuntimeOptions) {
  const { sessionId, read, write } = options
  const runtime = createOfficeWorkspaceRuntime({
    appKind: 'presentation',
    sessionId,
    capabilities: PRESENTATION_WORKSPACE_CAPABILITIES,
    read: () => {
      const workspace = read()
      return {
        activeDocumentId: workspace.activeDocumentId,
        documents: workspace.documents.map((document) => ({
          id: document.id,
          title: document.title,
          revision: document.version,
          dirty: null,
        })),
      }
    },
  })

  const publishWorkspace = (workspace: PresentationWorkspace) => {
    write(workspace)
    runtime.publish()
  }
  let editor: OfficeEditorBinding<PresentationDocument> | null = null
  const flushEditor = async () => { if (editor) await editor.flush() }

  return {
    runtime,
    bindEditor(binding: OfficeEditorBinding<PresentationDocument>) {
      const { identity } = binding.capture()
      if (identity.appKind !== 'presentation' || identity.sessionId !== sessionId) {
        throw new Error('The PowerPoint editor belongs to another Session.')
      }
      editor = binding
      return () => { if (editor === binding) editor = null }
    },
    flushEditor,
    createDocument() {
      return runtime.execute({ sessionId, capability: 'document.create' }, async (context) => {
        if (editor) await editor.flush()
        context.assertCurrent()
        const workspace = read()
        const document = createInitialPresentationDocument()
        publishWorkspace({ activeDocumentId: document.id, documents: [...workspace.documents, document] })
        return document.id
      })
    },
    activateDocument(documentId: string) {
      return runtime.execute({ sessionId, capability: 'document.activate', documentId }, async (context) => {
        if (editor) await editor.flush()
        context.assertCurrent()
        const workspace = read()
        if (workspace.activeDocumentId !== documentId) publishWorkspace({ ...workspace, activeDocumentId: documentId })
      })
    },
    closeDocument(documentId: string) {
      return runtime.execute({ sessionId, capability: 'document.close', documentId }, async (context) => {
        if (editor) await editor.flush()
        context.assertCurrent()
        const workspace = read()
        // The final tab closes the native surface; its host owns that lifecycle.
        if (workspace.documents.length <= 1) return { closeSurface: true }
        const index = workspace.documents.findIndex((document) => document.id === documentId)
        const documents = workspace.documents.filter((document) => document.id !== documentId)
        const activeDocumentId = workspace.activeDocumentId === documentId
          ? documents[Math.min(index, documents.length - 1)]!.id
          : workspace.activeDocumentId
        publishWorkspace({ activeDocumentId, documents })
        return { closeSurface: false }
      })
    },
    /** Native text input and dragging remain synchronous, with no IPC or queue hop. */
    commitDocument(previous: PresentationDocument, next: PresentationDocument, contentChanged = true) {
      runtime.assertCurrent({
        sessionId,
        capability: 'document.edit',
        documentId: previous.id,
        expectedDocumentRevision: previous.version,
      })
      const workspace = read()
      if (workspace.activeDocumentId !== previous.id || next.id !== previous.id) {
        throw new PowerPointProtocolError('The active PowerPoint document changed.', 'document_changed')
      }
      const committed = contentChanged ? { ...next, version: previous.version + 1 } : next
      publishWorkspace({
        ...workspace,
        documents: workspace.documents.map((document) => document.id === previous.id ? committed : document),
      })
      return committed
    },
    async dispatchProtocol(
      request: PowerPointRequest,
      getContext: () => PowerPointRuntimeContext,
      apply: (dispatched: PowerPointDispatchResult) => Promise<void>,
      prepare?: (request: PowerPointRequest) => Promise<void>,
    ): Promise<ProtocolResult> {
      const failure = (error: unknown): ProtocolResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof PowerPointProtocolError ? { code: error.code } : {}),
      })
      if (!request || typeof request !== 'object') return failure(new TypeError('PowerPoint request is required'))
      if (!POWERPOINT_METHODS.includes(request.method)) {
        return failure(new Error(`Unsupported PowerPoint method: ${String(request.method)}`))
      }
      const capability = `powerpoint.${request.method}`
      const result = await runtime.execute({ sessionId, capability }, async (context) => {
        try {
          if (editor) await editor.flush()
          context.assertCurrent()
          if (prepare) await prepare(request)
          context.assertCurrent()
          const workspace = read()
          const revision = runtime.getSnapshot().revision
          const dispatched = await executePowerPointRequest(workspace, request, getContext())
          if (dispatched.workspace) {
            try {
              runtime.assertCurrent({ sessionId, capability, expectedRevision: revision })
            } catch {
              throw new PowerPointProtocolError('The PowerPoint changed while the command was being prepared. Read it again before retrying.', 'document_changed')
            }
          }
          await apply(dispatched)
          runtime.publish()
          return { ok: true as const, value: dispatched.result }
        } catch (error) {
          return failure(error)
        }
      })
      // Preserve protocol v5's envelope instead of exposing the shared command contract.
      return result.ok ? result.value : { ok: false, error: result.error.message }
    },
  }
}

export type PresentationWorkspaceRuntime = ReturnType<typeof createPresentationWorkspaceRuntime>
