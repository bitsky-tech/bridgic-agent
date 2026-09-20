import {
  createInitialPresentationProject,
  type PresentationAgentChange,
  type PresentationProject,
} from '@/atoms/presentation'
import type { OfficeFileSource, OfficeFilesAPI } from '../../shared/office-files'
import { createPresentationFileController, isPresentationProjectDirty } from '@/lib/presentationFileController'
import type { OfficeEditorBinding } from '@/lib/office/officeEditorBinding'
import { createOfficeWorkspaceRuntime } from '@/lib/office/officeWorkspaceRuntime'
import { i18n } from '@/lib/i18n'
import {
  executePowerPointRequest,
  POWERPOINT_PROTOCOL_VERSION,
  PowerPointProtocolError,
  type PowerPointDispatchResult,
  type PowerPointRequest,
  type PowerPointRuntimeContext,
} from '@/lib/powerPointProtocol'
import {
  initialPresentationProjectMetadata,
  validatePresentationInventory,
  type PresentationCheckpoint,
  type PresentationProjectMetadata,
} from './checkpoint'
import {
  createPresentationHistoryEntry,
  trimPresentationHistoryEntries,
  trimPresentationHistoryPair,
  type PresentationHistoryEntry,
} from './history'
import { editPresentationProject } from './model/reducer'

const POWERPOINT_METHODS = [
  'open', 'read_deck', 'read_page', 'inspect', 'edit_page', 'manage_deck',
] as const

export const PRESENTATION_STORE_CAPABILITIES = [
  'document.create', 'document.activate', 'document.close', 'document.edit', 'document.save', 'document.saveAs',
  ...POWERPOINT_METHODS.map((method) => `powerpoint.${method}`),
] as const

export interface PresentationStoreSnapshot {
  activeProjectId: string
  agentChange: PresentationAgentChange | null
  canRedo: boolean
  canUndo: boolean
  exportError: string | null
  persistenceError: string | null
  project: PresentationProject | null
  projectMetadata: Readonly<Record<string, PresentationProjectMetadata>>
  projects: readonly PresentationProject[]
  ready: boolean
  saveStatus: 'error' | 'loading' | 'saved' | 'saving'
}

export interface PresentationStoreOptions {
  encode: (project: PresentationProject) => Promise<Uint8Array>
  files: OfficeFilesAPI
  importPptx: NonNullable<PowerPointRuntimeContext['importPptx']>
  managedFiles: boolean
}

export type PresentationStoreDispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code?: string }

type PresentationHistory = { past: PresentationHistoryEntry[]; future: PresentationHistoryEntry[] }

/** The single in-memory authority for editable PowerPoint projects in one Session. */
export class PresentationStore {
  readonly protocolVersion = POWERPOINT_PROTOCOL_VERSION
  private readonly listeners = new Set<() => void>()
  private readonly histories = new Map<string, PresentationHistory>()
  private readonly officeRuntime
  private readonly fileController
  private readonly unsubscribeRecovery
  private state: PresentationStoreSnapshot
  private editor: OfficeEditorBinding<PresentationProject> | null = null
  private agentChangeId = 0
  private openingSource: OfficeFileSource | null = null
  private refreshing = false
  private closing: Promise<boolean> | null = null

  constructor(readonly sessionId: string, private readonly options: PresentationStoreOptions) {
    this.state = {
      activeProjectId: '',
      agentChange: null,
      canRedo: false,
      canUndo: false,
      exportError: null,
      persistenceError: null,
      project: null,
      projectMetadata: {},
      projects: [],
      ready: false,
      saveStatus: 'loading',
    }
    this.officeRuntime = createOfficeWorkspaceRuntime({
      appKind: 'presentation',
      sessionId,
      capabilities: PRESENTATION_STORE_CAPABILITIES,
      read: () => ({
        activeDocumentId: this.state.activeProjectId || null,
        documents: this.state.projects.map((project) => {
          const metadata = this.metadataOf(project.id)
          return {
            id: project.id,
            title: project.title,
            revision: metadata.revision,
            dirty: isPresentationProjectDirty(metadata),
          }
        }),
      }),
    })
    this.fileController = createPresentationFileController({
      encode: options.encode,
      files: options.files,
      flushEditor: () => this.flushEditor(),
      managed: options.managedFiles,
      onExportStatus: (status, error) => this.publish({ exportError: status === 'error' ? error ?? 'PowerPoint export failed' : null }),
      read: () => this.checkpoint(),
      commitExport: (projectId, _fileName, source, exportedRevision) => {
        const projectMetadata = Object.fromEntries(Object.entries(this.state.projectMetadata).map(([id, current]) => {
          let next = current
          if (id === projectId) next = { ...current, source, sourceProtected: false, savedRevision: exportedRevision }
          else if (current.source?.path === source.path) next = withoutPresentationSource(current)
          return [id, next]
        }))
        this.replaceInventory(this.state.activeProjectId, this.state.projects, projectMetadata)
      },
      sessionId,
    })
    this.unsubscribeRecovery = this.fileController.recovery.subscribe((snapshot) => {
      if (snapshot.status === 'disposed') return
      let saveStatus = this.state.saveStatus
      if (snapshot.status === 'error') saveStatus = 'error'
      else if (snapshot.status === 'pending' || snapshot.status === 'saving') saveStatus = 'saving'
      else if (snapshot.status === 'saved') saveStatus = 'saved'
      this.publish({
        saveStatus,
        persistenceError: snapshot.status === 'error' ? snapshot.error?.message ?? 'PowerPoint recovery failed' : null,
      })
    })
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): PresentationStoreSnapshot => this.state

  get runtime() { return this.officeRuntime }

  private publish(patch: Partial<PresentationStoreSnapshot> = {}): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private checkpoint(): PresentationCheckpoint {
    return {
      schemaVersion: 1,
      activeProjectId: this.state.activeProjectId,
      projects: [...this.state.projects],
      projectMetadata: { ...this.state.projectMetadata },
    }
  }

  private metadataOf(projectId: string): PresentationProjectMetadata {
    const metadata = this.state.projectMetadata[projectId]
    if (!metadata) throw new Error(`PowerPoint project metadata not found: ${projectId}`)
    return metadata
  }

  private replaceInventory(
    activeProjectId: string,
    projects: readonly PresentationProject[],
    projectMetadata: Readonly<Record<string, PresentationProjectMetadata>>,
  ): void {
    validatePresentationInventory(activeProjectId, projects)
    const metadata = Object.fromEntries(projects.map((project) => [
      project.id,
      projectMetadata[project.id] ?? initialPresentationProjectMetadata(),
    ]))
    const project = projects.find((item) => item.id === activeProjectId) ?? projects[0] ?? null
    const history = project ? this.historyFor(project.id) : null
    for (const projectId of this.histories.keys()) {
      if (!projects.some((candidate) => candidate.id === projectId)) this.histories.delete(projectId)
    }
    this.publish({
      activeProjectId,
      project,
      projectMetadata: metadata,
      projects: [...projects],
      canUndo: Boolean(history?.past.length),
      canRedo: Boolean(history?.future.length),
    })
    this.officeRuntime.publish()
    this.fileController.schedule()
  }

  private historyFor(projectId: string): PresentationHistory {
    let history = this.histories.get(projectId)
    if (!history) {
      history = { past: [], future: [] }
      this.histories.set(projectId, history)
    }
    return history
  }

  private remember(project: PresentationProject): void {
    const history = this.historyFor(project.id)
    const entry = createPresentationHistoryEntry(project)
    history.past = entry ? trimPresentationHistoryEntries([...history.past, entry]) : []
    history.future = []
  }

  bindEditor(binding: OfficeEditorBinding<PresentationProject>): () => void {
    const { identity } = binding.capture()
    if (identity.appKind !== 'presentation' || identity.sessionId !== this.sessionId) {
      throw new Error('The PowerPoint editor belongs to another Session.')
    }
    this.editor = binding
    return () => { if (this.editor === binding) this.editor = null }
  }

  async flushEditor(): Promise<void> {
    if (this.editor) await this.editor.flush()
  }

  commitProject(previous: PresentationProject, next: PresentationProject, contentChanged = true, recordHistory = contentChanged): PresentationProject {
    const previousMetadata = this.metadataOf(previous.id)
    this.officeRuntime.assertCurrent({
      sessionId: this.sessionId,
      capability: 'document.edit',
      documentId: previous.id,
      expectedDocumentRevision: previousMetadata.revision,
    })
    if (this.state.activeProjectId !== previous.id || next.id !== previous.id) {
      throw new PowerPointProtocolError('The active PowerPoint project changed.', 'document_changed')
    }
    const current = this.state.projects.find((project) => project.id === previous.id)
    if (current !== previous) throw new PowerPointProtocolError('The PowerPoint changed before the edit was committed.', 'document_changed')
    const committed = editPresentationProject(previous, next)
    if (recordHistory && committed !== previous) this.remember(previous)
    const metadata = contentChanged
      ? { ...previousMetadata, revision: previousMetadata.revision + 1 }
      : previousMetadata
    this.replaceInventory(
      this.state.activeProjectId,
      this.state.projects.map((project) => project.id === committed.id ? committed : project),
      { ...this.state.projectMetadata, [committed.id]: metadata },
    )
    return committed
  }

  undo(): PresentationProject | null {
    const current = this.state.project
    if (!current) return null
    const history = this.historyFor(current.id)
    const previous = history.past.pop()
    if (!previous) return null
    const entry = createPresentationHistoryEntry(current)
    if (entry) history.future.push(entry)
    else history.future = []
    trimPresentationHistoryPair(history.past, history.future)
    const committed = this.commitProject(current, previous.project, true, false)
    this.publish({ canUndo: history.past.length > 0, canRedo: history.future.length > 0 })
    return committed
  }

  redo(): PresentationProject | null {
    const current = this.state.project
    if (!current) return null
    const history = this.historyFor(current.id)
    const next = history.future.pop()
    if (!next) return null
    const entry = createPresentationHistoryEntry(current)
    if (entry) history.past.push(entry)
    else history.past = []
    trimPresentationHistoryPair(history.past, history.future)
    const committed = this.commitProject(current, next.project, true, false)
    this.publish({ canUndo: history.past.length > 0, canRedo: history.future.length > 0 })
    return committed
  }

  async createProject(): Promise<void> {
    const result = await this.officeRuntime.execute({ sessionId: this.sessionId, capability: 'document.create' }, async (context) => {
      await this.flushEditor()
      context.assertCurrent()
      const project = createInitialPresentationProject()
      this.replaceInventory(
        project.id,
        [...this.state.projects, project],
        { ...this.state.projectMetadata, [project.id]: initialPresentationProjectMetadata() },
      )
    })
    if (!result.ok) throw new Error(result.error.message)
  }

  async selectProject(projectId: string): Promise<void> {
    const result = await this.officeRuntime.execute({ sessionId: this.sessionId, capability: 'document.activate', documentId: projectId }, async (context) => {
      await this.flushEditor()
      context.assertCurrent()
      if (this.state.activeProjectId !== projectId) {
        this.replaceInventory(projectId, this.state.projects, this.state.projectMetadata)
      }
    })
    if (!result.ok) throw new Error(result.error.message)
  }

  private async prepareClose(projectId: string): Promise<boolean> {
    await this.flushEditor()
    const project = this.state.projects.find((candidate) => candidate.id === projectId)
    if (!project) return true
    const metadata = this.metadataOf(projectId)
    if (!isPresentationProjectDirty(metadata)) return true
    const decision = await this.options.files.confirmClose(`${project.title.replace(/\.pptx$/i, '')}.pptx`, i18n.language)
    if (decision === 'cancel') return false
    if (decision === 'save') return this.fileController.save(projectId, metadata.sourceProtected)
    await this.flushEditor()
    return this.state.projectMetadata[projectId]?.revision === metadata.revision
  }

  async closeProject(projectId: string): Promise<{ closeSurface: boolean }> {
    const result = await this.officeRuntime.execute({ sessionId: this.sessionId, capability: 'document.close', documentId: projectId }, async (context) => {
      if (!await this.prepareClose(projectId)) return { closeSurface: false }
      context.assertCurrent()
      const index = this.state.projects.findIndex((project) => project.id === projectId)
      const projects = this.state.projects.filter((project) => project.id !== projectId)
      const activeProjectId = this.state.activeProjectId === projectId
        ? projects[Math.min(index, projects.length - 1)]?.id ?? ''
        : this.state.activeProjectId
      this.replaceInventory(activeProjectId, projects, this.state.projectMetadata)
      return { closeSurface: projects.length === 0 }
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  async restore(): Promise<void> {
    try {
      const restored = await this.fileController.restore()
      this.histories.clear()
      if (restored) {
        this.replaceInventory(restored.activeProjectId, restored.projects, restored.projectMetadata)
      } else {
        this.replaceInventory('', [], {})
      }
      this.publish({ agentChange: null, ready: true, saveStatus: 'saved', persistenceError: null })
    } catch (error) {
      this.publish({ ready: false, saveStatus: 'error', persistenceError: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async save(projectId: string, saveAs = false, destination?: string): Promise<boolean> {
    const result = await this.officeRuntime.execute({
      sessionId: this.sessionId,
      capability: saveAs ? 'document.saveAs' : 'document.save',
      documentId: projectId,
    }, () => this.fileController.save(projectId, saveAs, destination))
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  async flush(): Promise<void> {
    await this.officeRuntime.whenIdle()
    await this.flushEditor()
    await this.fileController.flush()
  }

  async closeAll(): Promise<boolean> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      const result = await this.officeRuntime.execute({ sessionId: this.sessionId, capability: 'document.close' }, async () => {
        const approved = new Map<string, number>()
        for (const project of this.state.projects) {
          if (!await this.prepareClose(project.id)) return false
          const metadata = this.state.projectMetadata[project.id]
          if (metadata) approved.set(project.id, metadata.revision)
        }
        await this.flushEditor()
        if (this.state.projects.some((project) => {
          const metadata = this.state.projectMetadata[project.id]
          return metadata && isPresentationProjectDirty(metadata) && approved.get(project.id) !== metadata.revision
        })) throw new Error(i18n.t('office.changedDuringClose'))
        this.replaceInventory('', [], {})
        await this.fileController.recovery.persist(this.checkpoint())
        return true
      })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    })().finally(() => { this.closing = null })
    return this.closing
  }

  async dispatch(request: PowerPointRequest): Promise<PresentationStoreDispatchResult> {
    if (!this.state.ready) return { ok: false, error: 'PowerPoint project store is not ready', code: 'document_changed' }
    if (request.method === 'save') return this.dispatchSave(request)
    const failure = (error: unknown): PresentationStoreDispatchResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof PowerPointProtocolError ? { code: error.code } : {}),
    })
    if (!(POWERPOINT_METHODS as readonly string[]).includes(request.method)) {
      return failure(new Error(`Unsupported PowerPoint method: ${String(request.method)}`))
    }
    const result = await this.officeRuntime.execute({
      sessionId: this.sessionId,
      capability: `powerpoint.${request.method}`,
    }, async (context) => {
      try {
        await this.flushEditor()
        context.assertCurrent()
        await this.prepareProtocolRequest(request)
        context.assertCurrent()
        const runtimeRevision = this.officeRuntime.getSnapshot().revision
        const dispatched = await executePowerPointRequest({
          activeProjectId: this.state.activeProjectId,
          projects: [...this.state.projects],
        }, request, this.protocolContext())
        if (dispatched.projects) {
          try {
            this.officeRuntime.assertCurrent({
              sessionId: this.sessionId,
              capability: `powerpoint.${request.method}`,
              expectedRevision: runtimeRevision,
            })
          } catch {
            throw new PowerPointProtocolError('The PowerPoint changed while the command was being prepared. Read it again before retrying.', 'document_changed')
          }
        }
        this.applyProtocolResult(dispatched)
        await this.fileController.flush()
        return { ok: true as const, value: dispatched.result }
      } catch (error) {
        return failure(error)
      } finally {
        this.openingSource = null
        this.refreshing = false
      }
    })
    return result.ok ? result.value : { ok: false, error: result.error.message, code: result.error.code }
  }

  private protocolContext(): PowerPointRuntimeContext {
    const metadata = this.state.project ? this.metadataOf(this.state.project.id) : null
    return {
      currentTarget: this.refreshing ? null : metadata?.source?.path ?? null,
      fileNameOf: (projectId) => this.state.projectMetadata[projectId]?.source?.path?.split(/[\\/]/).pop(),
      importPptx: this.options.importPptx,
      revisionOf: (projectId) => this.metadataOf(projectId).revision,
    }
  }

  private async prepareProtocolRequest(request: PowerPointRequest): Promise<void> {
    this.openingSource = null
    this.refreshing = false
    if (request.method !== 'open' || typeof request.params?.target !== 'string') return
    const target = request.params.target
    this.openingSource = this.options.files.prepare
      ? await this.options.files.prepare('presentation', target)
      : await this.options.files.inspect('presentation', target)
    if (this.openingSource.path !== target && this.openingSource.mtimeMs !== null && this.options.files.readBase64) {
      request.params.content_base64 = await this.options.files.readBase64('presentation', this.openingSource.path)
    }
    request.params.target = this.openingSource.path
    const existing = this.state.projects.find((project) => this.state.projectMetadata[project.id]?.source?.path === this.openingSource?.path)
    if (!existing) return
    const existingMetadata = this.metadataOf(existing.id)
    this.refreshing = existingMetadata.source?.mtimeMs !== this.openingSource.mtimeMs
    if (this.refreshing && isPresentationProjectDirty(existingMetadata)) {
      throw new Error('The source file changed. Export or save your project before reopening it.')
    }
    if (this.state.activeProjectId !== existing.id) {
      this.replaceInventory(existing.id, this.state.projects, this.state.projectMetadata)
    }
  }

  private applyProtocolResult(dispatched: PowerPointDispatchResult): void {
    if (dispatched.projects) {
      if (dispatched.target && this.openingSource) this.applyOpenedProject(dispatched)
      else this.applyProjectCollection(dispatched)
    }
    if (dispatched.agentChange) {
      this.publish({ agentChange: { ...dispatched.agentChange, changeId: ++this.agentChangeId } })
    }
    if (this.openingSource && dispatched.result && typeof dispatched.result === 'object') {
      Object.assign(dispatched.result, { target: this.metadataOf(this.state.activeProjectId).source?.path ?? this.openingSource.path })
    }
  }

  private applyOpenedProject(dispatched: PowerPointDispatchResult): void {
    const collection = dispatched.projects!
    const imported = collection.projects.find((project) => project.id === collection.activeProjectId)
    if (!imported || !this.openingSource) throw new Error('The imported PowerPoint project is missing')
    const existing = this.state.projects.find((project) => this.state.projectMetadata[project.id]?.source?.path === this.openingSource?.path)
    const project = { ...imported, id: existing?.id ?? imported.id }
    const revision = existing ? this.metadataOf(existing.id).revision + 1 : 1
    const metadata: PresentationProjectMetadata = {
      revision,
      source: this.openingSource,
      sourceProtected: !this.options.managedFiles,
      ...(this.openingSource.mtimeMs === null ? {} : { savedRevision: revision }),
    }
    if (existing) this.histories.delete(existing.id)
    this.replaceInventory(
      project.id,
      [...this.state.projects.filter((item) => item.id !== existing?.id), project],
      { ...this.state.projectMetadata, [project.id]: metadata },
    )
  }

  private applyProjectCollection(dispatched: PowerPointDispatchResult): void {
    const collection = dispatched.projects!
    const changedProjectId = dispatched.changedProjectId
    const previous = changedProjectId
      ? this.state.projects.find((project) => project.id === changedProjectId)
      : undefined
    if (previous && dispatched.contentChanged) this.remember(previous)
    const projectMetadata = { ...this.state.projectMetadata }
    for (const project of collection.projects) {
      const metadata = projectMetadata[project.id] ?? initialPresentationProjectMetadata()
      projectMetadata[project.id] = project.id === changedProjectId && dispatched.contentChanged
        ? { ...metadata, revision: metadata.revision + 1 }
        : metadata
    }
    this.replaceInventory(collection.activeProjectId, collection.projects, projectMetadata)
  }

  private async dispatchSave(request: PowerPointRequest): Promise<PresentationStoreDispatchResult> {
    const requestedProjectId = request.params?.document_id
    const projectId = typeof requestedProjectId === 'string' ? requestedProjectId : this.state.activeProjectId
    if (!projectId) return { ok: false, error: 'The requested PowerPoint project is not open', code: 'document_changed' }
    const destination = request.params?.save_as
    if (destination !== undefined && (typeof destination !== 'string' || !destination)) {
      return { ok: false, error: 'save_as must be an absolute PPTX path', code: 'document_changed' }
    }
    try {
      if (!await this.save(projectId, Boolean(destination), destination as string | undefined)) {
        return { ok: false, error: 'Save was canceled or newer changes remain unsaved', code: 'document_changed' }
      }
      const metadata = this.metadataOf(projectId)
      return { ok: true, value: { status: 'saved', target: metadata.source?.path, document_id: projectId } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'document_changed' }
    }
  }

  dispose(): void {
    this.unsubscribeRecovery()
    this.fileController.recovery.dispose()
    this.officeRuntime.dispose()
    this.listeners.clear()
  }
}

function withoutPresentationSource(metadata: PresentationProjectMetadata): PresentationProjectMetadata {
  const { source: _source, sourceProtected: _sourceProtected, savedRevision: _savedRevision, ...rest } = metadata
  return rest
}
