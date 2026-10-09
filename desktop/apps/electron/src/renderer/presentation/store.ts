import {
  createInitialPresentationProject,
  type PresentationAgentChange,
  type PresentationAssetKind,
  type PresentationProject,
} from '@/atoms/presentation'
import type { PresentationMountReplacementValidation, PresentationMountUsage } from '@shared/presentation-host'
import type { OfficeFileSource, OfficeFilesAPI } from '../../shared/office-files'
import { createPresentationFileController, isPresentationProjectDirty } from '@/lib/presentationFileController'
import type { OfficeEditorBinding } from '@/lib/office/officeEditorBinding'
import type { WorkspacePersistence } from '@/lib/office/workspacePersistence'
import { createOfficeWorkspaceRuntime } from '@/lib/office/officeWorkspaceRuntime'
import { i18n } from '@/lib/i18n'
import {
  executePowerPointRequest,
  POWERPOINT_PROTOCOL_VERSION,
  PowerPointProtocolError,
  type PowerPointDispatchResult,
  type PowerPointProjectCollection,
  type PowerPointRequest,
  type PowerPointRuntimeContext,
} from '@/lib/powerPointProtocol'
import {
  initialPresentationProjectMetadata,
  migratePresentationWorkspace,
  validatePresentationInventory,
  type PresentationWorkspace,
  type PresentationProjectMetadata,
} from './workspace'
import {
  createPresentationHistoryEntry,
  trimPresentationHistoryEntries,
  trimPresentationHistoryPair,
  type PresentationHistoryEntry,
} from './history'
import { editPresentationProject } from './model/reducer'
import { detachPresentationCommentsFromElements } from './project'
import {
  embeddedPresentationSource,
  isDurablePresentationSource,
  mountedPresentationSource,
  presentationMountSource,
  presentationPptxSource,
} from './sourceReference'
import {
  materializePresentationProjectSources,
  presentationPptxSourceUrls,
  presentationSourceUrlForPath,
  presentationSourceUrls,
  rebasePresentationPptxSources,
} from './sources'

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
  /** Runtime URLs keyed by durable source reference; never persisted. */
  sources: Readonly<Record<string, string>>
}

export interface PresentationStoreOptions {
  workspacePersistence: WorkspacePersistence<PresentationWorkspace>
  encode: (project: PresentationProject, sources: Readonly<Record<string, string>>) => Promise<Uint8Array>
  files: OfficeFilesAPI
  importPptx: NonNullable<PowerPointRuntimeContext['importPptx']>
  managedFiles: boolean
  /** Optional host resolver; persisted projects still contain only source references. */
  resolveSources?: (sourceRefs: readonly string[]) => Promise<Record<string, string>>
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
  private readonly unsubscribePersistence
  private state: PresentationStoreSnapshot
  private editor: OfficeEditorBinding<PresentationProject> | null = null
  private agentChangeId = 0
  private openingSource: OfficeFileSource | null = null
  private refreshing = false
  private closing: Promise<boolean> | null = null
  private workspaceReady = false

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
      sources: {},
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
      encode: (project) => options.encode(project, this.state.sources),
      files: options.files,
      flushEditor: () => this.flushEditor(),
      managed: options.managedFiles,
      onExportStatus: (status, error) => this.publish({ exportError: status === 'error' ? error ?? 'PowerPoint export failed' : null }),
      read: () => this.workspace(),
      commitExport: async (projectId, _fileName, source, exportedRevision) => {
        const exported = this.state.projects.find((project) => project.id === projectId)
        const exportedMetadata = this.state.projectMetadata[projectId]
        let rebased = exported
        if (exported && exportedMetadata?.revision === exportedRevision && this.options.files.readBase64) {
          const materialized = await materializePresentationProjectSources(exported, this.state.sources)
          const encoded = await this.options.files.readBase64('presentation', source.path)
          const result = await rebasePresentationPptxSources(exported, materialized, encoded)
          rebased = result.project
          if (result.replacements.size) this.replaceHistorySources(projectId, result.replacements)
        }
        const projectMetadata = Object.fromEntries(Object.entries(this.state.projectMetadata).map(([id, current]) => {
          let next = current
          if (id === projectId) next = { ...current, source, sourceProtected: false, savedRevision: exportedRevision }
          else if (current.source?.path === source.path) next = withoutPresentationSource(current)
          return [id, next]
        }))
        const projects = rebased
          ? this.state.projects.map((project) => project.id === projectId ? rebased! : project)
          : this.state.projects
        this.replaceInventory(this.state.activeProjectId, projects, projectMetadata)
        await this.refreshSources()
      },
    })
    this.unsubscribePersistence = options.workspacePersistence.subscribe((snapshot) => {
      if (snapshot.status === 'disposed') return
      let saveStatus = this.state.saveStatus
      if (snapshot.status === 'error') saveStatus = 'error'
      else if (snapshot.status === 'pending' || snapshot.status === 'saving') saveStatus = 'saving'
      else if (snapshot.status === 'saved') saveStatus = 'saved'
      this.publish({
        saveStatus,
        persistenceError: snapshot.status === 'error' ? snapshot.error?.message ?? 'PowerPoint workspace save failed' : null,
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

  private workspace(): PresentationWorkspace {
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
    persist = true,
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
    if (persist && this.workspaceReady) this.options.workspacePersistence.schedule(this.workspace())
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
    if (next.assets.some((asset) => !isDurablePresentationSource(asset.source))) {
      throw new Error('PowerPoint project edits must reference durable sources')
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
      const stored = await this.options.workspacePersistence.load()
      const restored = stored === null ? null : migratePresentationWorkspace(stored)
      this.histories.clear()
      this.workspaceReady = true
      if (restored) {
        this.replaceInventory(restored.activeProjectId, restored.projects, restored.projectMetadata, false)
      } else {
        this.replaceInventory('', [], {}, false)
      }
      await this.refreshSources()
      this.publish({ agentChange: null, ready: true, saveStatus: 'saved', persistenceError: null })
    } catch (error) {
      this.workspaceReady = false
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
    if (result.value) await this.options.workspacePersistence.persist(this.workspace())
    return result.value
  }

  async flush(): Promise<void> {
    await this.officeRuntime.whenIdle()
    await this.flushEditor()
    if (!this.workspaceReady) throw new Error('PowerPoint workspace persistence is not ready')
    await this.options.workspacePersistence.persist(this.workspace())
  }

  async retryPersistence(): Promise<void> {
    await this.flushEditor()
    await this.options.workspacePersistence.persist(this.workspace())
  }

  async mountFileSource(kind: PresentationAssetKind, source: { dataUrl: string; fileName: string; mimeType: string }, path: string | undefined, sourceSize?: number, sourceModifiedAt?: number): Promise<PresentationProject['assets'][number]> {
    const mountSource = this.options.files.mountPresentationSource
    if (!mountSource) throw new Error('PowerPoint Session files are unavailable')
    const encoded = /^data:[^;,]+;base64,([\s\S]*)$/i.exec(source.dataUrl)?.[1]?.replace(/\s/g, '')
    const mounted = await mountSource({ fileName: source.fileName, mimeType: source.mimeType, ...(path ? { path } : { dataBase64: encoded }) })
    const reference = presentationMountSource(mounted.id, mounted.relativePath)
    const durableSize = sourceSize ?? mounted.size_bytes ?? undefined
    const asset = {
      id: crypto.randomUUID(),
      kind,
      mimeType: source.mimeType,
      name: source.fileName,
      source: reference,
      ...(durableSize === undefined ? {} : { sourceSize: durableSize }),
      ...(sourceModifiedAt === undefined ? {} : { sourceModifiedAt }),
    }
    this.publish({ sources: { ...this.state.sources, [reference]: source.dataUrl } })
    return asset
  }

  mountUsage(mountId: string): PresentationMountUsage {
    if (!this.state.ready) throw new Error('PowerPoint workspace is not ready')
    let assetCount = 0
    let elementCount = 0
    let projectCount = 0
    for (const project of this.state.projects) {
      const assetIds = new Set(project.assets.filter((asset) => mountedPresentationSource(asset.source)?.mountId === mountId).map((asset) => asset.id))
      if (assetIds.size === 0) continue
      projectCount += 1
      assetCount += assetIds.size
      elementCount += project.slides.pages.reduce((count, page) => count + page.elements.filter((element) => 'sourceAssetId' in element && element.sourceAssetId && assetIds.has(element.sourceAssetId)).length, 0)
    }
    return { assetCount, elementCount, projectCount }
  }

  async validateMountReplacement(mountId: string, path: string): Promise<PresentationMountReplacementValidation> {
    if (!this.state.ready) throw new Error('PowerPoint workspace is not ready')
    const assets = this.state.projects.flatMap((project) => project.assets).filter((asset) => mountedPresentationSource(asset.source)?.mountId === mountId)
    const inspected = new Map<string, Promise<{ mimeType: string; size?: number }>>()
    for (const asset of assets) {
      const reference = mountedPresentationSource(asset.source)!
      const candidate = reference.relativePath ? `${path.replace(/[\\/]+$/, '')}/${reference.relativePath}` : path
      let pending = inspected.get(candidate)
      if (!pending) {
        pending = (async () => {
          const url = presentationSourceUrlForPath(candidate)
          if (!url) throw new Error('PowerPoint source unavailable')
          const response = await fetch(url, { method: 'HEAD' })
          if (!response.ok) throw new Error('PowerPoint source unavailable')
          const rawSize = Number(response.headers.get('content-length'))
          return {
            mimeType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
            ...(Number.isSafeInteger(rawSize) && rawSize >= 0 ? { size: rawSize } : {}),
          }
        })()
        inspected.set(candidate, pending)
      }
      let replacement
      try { replacement = await pending } catch { return { compatible: false, reason: 'unavailable', assetName: asset.name } }
      if (replacement.mimeType && replacement.mimeType !== asset.mimeType.toLowerCase()) {
        return { compatible: false, reason: 'type-mismatch', assetName: asset.name }
      }
      if (asset.sourceSize !== undefined && replacement.size !== undefined && asset.sourceSize !== replacement.size) {
        return { compatible: false, reason: 'content-mismatch', assetName: asset.name }
      }
    }
    return { compatible: true }
  }

  removeMountReferences(mountId: string): PresentationMountUsage {
    if (!this.state.ready) throw new Error('PowerPoint workspace is not ready')
    const usage = this.mountUsage(mountId)
    if (usage.assetCount === 0) return usage
    const changedIds = new Set<string>()
    const projects = this.state.projects.map((project) => {
      const assetIds = new Set(project.assets.filter((asset) => mountedPresentationSource(asset.source)?.mountId === mountId).map((asset) => asset.id))
      if (assetIds.size === 0) return project
      changedIds.add(project.id)
      const pages = project.slides.pages.map((page) => {
        const removedElementIds = new Set(page.elements.flatMap((element) => (
          'sourceAssetId' in element && element.sourceAssetId && assetIds.has(element.sourceAssetId) ? [element.id] : []
        )))
        if (removedElementIds.size === 0) return page
        return detachPresentationCommentsFromElements({
          ...page,
          elements: page.elements.filter((element) => !removedElementIds.has(element.id)),
        }, removedElementIds)
      })
      return editPresentationProject(project, {
        ...project,
        assets: project.assets.filter((asset) => !assetIds.has(asset.id)),
        slides: { ...project.slides, pages },
      })
    })
    const metadata = Object.fromEntries(Object.entries(this.state.projectMetadata).map(([projectId, value]) => [
      projectId,
      changedIds.has(projectId) ? { ...value, revision: value.revision + 1 } : value,
    ]))
    this.histories.clear()
    this.replaceInventory(this.state.activeProjectId, projects, metadata)
    this.publish({ sources: Object.fromEntries(Object.entries(this.state.sources).filter(([source]) => mountedPresentationSource(source)?.mountId !== mountId)) })
    return usage
  }

  async refreshSources(): Promise<void> {
    const refs = this.state.projects.flatMap((project) => project.assets.map((asset) => asset.source))
    if (this.options.resolveSources) {
      try { this.publish({ sources: await this.options.resolveSources(refs) }) }
      catch { this.publish({ sources: {} }) }
      return
    }
    const sources: Record<string, string> = {}
    try {
      const mounts = await this.options.files.listPresentationMounts?.() ?? []
      Object.assign(sources, presentationSourceUrls(refs, mounts))
    } catch { /* A missing Files inventory must not hide package-owned assets. */ }
    if (this.options.files.readBase64) {
      for (const project of this.state.projects) {
        const source = this.state.projectMetadata[project.id]?.source
        if (!source) continue
        try {
          Object.assign(sources, await presentationPptxSourceUrls(project, await this.options.files.readBase64('presentation', source.path)))
        } catch { /* An unavailable original PPTX leaves only that project's embedded sources unresolved. */ }
      }
    }
    this.publish({ sources })
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
        await this.options.workspacePersistence.persist({ schemaVersion: 1, activeProjectId: '', projects: [], projectMetadata: {} })
        this.replaceInventory('', [], {}, false)
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
        await this.applyProtocolResult(dispatched)
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

  private async durableProjectCollection(collection: PowerPointProjectCollection): Promise<PowerPointProjectCollection> {
    const transient = collection.projects.flatMap((project) => project.assets).filter((asset) => !isDurablePresentationSource(asset.source))
    if (transient.length === 0) return collection
    const replacements = new Map<string, { size?: number; source: string }>()
    for (const asset of transient) {
      if (replacements.has(asset.source)) continue
      const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(asset.source)
      const mountSource = this.options.files.mountPresentationSource
      if (!mountSource) throw new Error('PowerPoint Session files are unavailable')
      const mounted = await mountSource({
        ...(dataUrl ? { dataBase64: dataUrl[2]!.replace(/\s/g, '') } : { path: asset.source }),
        fileName: asset.name,
        mimeType: asset.mimeType,
      })
      replacements.set(asset.source, {
        ...(mounted.size_bytes === null ? {} : { size: mounted.size_bytes }),
        source: presentationMountSource(mounted.id, mounted.relativePath),
      })
    }
    const projects = collection.projects.map((project) => ({
      ...project,
      assets: project.assets.map((asset) => {
        const replacement = replacements.get(asset.source)
        return replacement ? {
          ...asset,
          source: replacement.source,
          ...(asset.sourceSize === undefined && replacement.size !== undefined ? { sourceSize: replacement.size } : {}),
        } : asset
      }),
    }))
    const refs = projects.flatMap((project) => project.assets.map((asset) => asset.source))
    if (this.options.resolveSources) {
      this.publish({ sources: { ...this.state.sources, ...await this.options.resolveSources(refs) } })
    } else {
      const mounts = await this.options.files.listPresentationMounts?.() ?? []
      this.publish({ sources: { ...this.state.sources, ...presentationSourceUrls(refs, mounts) } })
    }
    return { ...collection, projects }
  }

  private replaceHistorySources(projectId: string, replacements: ReadonlyMap<string, string>): void {
    const history = this.histories.get(projectId)
    if (!history || replacements.size === 0) return
    const replace = (entry: PresentationHistoryEntry): PresentationHistoryEntry => {
      let changed = false
      const assets = entry.project.assets.map((asset) => {
        const source = replacements.get(asset.source)
        const officeLayer = asset.imageEffects?.officeLayer
        const layerSource = officeLayer ? replacements.get(officeLayer.source) : undefined
        if (!source && !layerSource) return asset
        changed = true
        return {
          ...asset,
          source: source ?? asset.source,
          ...(officeLayer && layerSource ? { imageEffects: { ...asset.imageEffects, officeLayer: { ...officeLayer, source: layerSource } } } : {}),
        }
      })
      if (!changed) return entry
      return createPresentationHistoryEntry({ ...entry.project, assets }) ?? entry
    }
    history.past = history.past.map(replace)
    history.future = history.future.map(replace)
    trimPresentationHistoryPair(history.past, history.future)
  }

  private protocolContext(): PowerPointRuntimeContext {
    const metadata = this.state.project ? this.metadataOf(this.state.project.id) : null
    return {
      currentTarget: this.refreshing ? null : metadata?.source?.path ?? null,
      fileNameOf: (projectId) => this.state.projectMetadata[projectId]?.source?.path?.split(/[\\/]/).pop(),
      importPptx: this.options.importPptx,
      materializeProject: (project) => materializePresentationProjectSources(project, this.state.sources),
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

  private async applyProtocolResult(dispatched: PowerPointDispatchResult): Promise<void> {
    if (dispatched.projects) {
      dispatched.projects = await this.durableProjectCollection(dispatched.projects)
      if (dispatched.target && this.openingSource) {
        this.applyOpenedProject(dispatched)
        await this.refreshSources()
      }
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
    const project = existing ? {
      ...imported,
      id: existing.id,
      assets: imported.assets.map((asset) => {
        const embedded = embeddedPresentationSource(asset.source)
        return embedded?.projectId === imported.id
          ? { ...asset, source: presentationPptxSource(existing.id, embedded.partPath) }
          : asset
      }),
    } : imported
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
    this.unsubscribePersistence()
    this.options.workspacePersistence.dispose()
    this.officeRuntime.dispose()
    this.listeners.clear()
  }
}

function withoutPresentationSource(metadata: PresentationProjectMetadata): PresentationProjectMetadata {
  const { source: _source, sourceProtected: _sourceProtected, savedRevision: _savedRevision, ...rest } = metadata
  return rest
}
