import {
  createBlankPresentationProject,
  selectPresentationPage,
  type PresentationAgentChange,
  type PresentationFileSource,
  type PresentationProject,
  type PresentationSlide,
} from '@/atoms/presentation'
import { decompilePresentationSlideMarkdown } from '@/lib/presentationMarkdown'
import { importPresentationPptx } from '@/lib/presentationPptxImport'
import { editPresentationPage, managePresentationDeck } from '@/presentation/agentCommands'
import { editPresentationProject } from '@/presentation/model/reducer'
import { presentationAsset, presentationElementSource } from '@/presentation/project'

export const POWERPOINT_PROTOCOL_VERSION = 7 as const

export type PowerPointMethod =
  | 'open'
  | 'read_deck'
  | 'read_page'
  | 'inspect'
  | 'edit_page'
  | 'manage_deck'
  | 'save'

export interface PowerPointRequest {
  method: PowerPointMethod
  params?: Record<string, unknown>
}

export interface PowerPointRuntimeContext {
  currentTarget: string | null
  fileNameOf?: (projectId: string) => string | undefined
  importPptx?: (encoded: string, fileName: string) => Promise<PresentationProject>
  revisionOf?: (projectId: string) => number
}

export interface PowerPointProjectCollection {
  activeProjectId: string
  projects: PresentationProject[]
}

export interface PowerPointDispatchResult {
  agentChange?: Omit<PresentationAgentChange, 'changeId'>
  contentChanged?: boolean
  changedProjectId?: string
  projects?: PowerPointProjectCollection
  result: unknown
  target?: string
}

export type PowerPointProtocolErrorCode = 'document_changed' | 'document_not_found' | 'page_changed'

export class PowerPointProtocolError extends Error {
  constructor(message: string, readonly code: PowerPointProtocolErrorCode) {
    super(message)
    this.name = 'PowerPointProtocolError'
  }
}

/** Execute one structured PPT request against the editor's authoritative model. */
export async function executePowerPointRequest(
  current: PowerPointProjectCollection,
  request: PowerPointRequest,
  context: PowerPointRuntimeContext = { currentTarget: null },
): Promise<PowerPointDispatchResult> {
  if (!request || typeof request !== 'object') throw new TypeError('PowerPoint request is required')
  const params = request.params ?? {}

  if (request.method === 'open') {
    const target = requiredString(params.target, 'target')
    const fileName = requiredString(params.file_name, 'file_name')
    if (context.currentTarget === target) {
      const project = requireActiveProject(current)
      return { result: { ...deckRead(project, fileName, revisionOf(context, project.id)), reused: true }, target }
    }
    const encoded = optionalString(params.content_base64, 'content_base64')
    const project = encoded
      ? await (context.importPptx
        ? context.importPptx(encoded, fileName)
        : importPresentationPptx(decodeBase64(encoded), fileName, { restoreEditorModel: true }))
      : createBlankPresentationProject(fileName.replace(/\.pptx$/i, ''))
    const projects = { activeProjectId: project.id, projects: [project] }
    return { result: { ...deckRead(project, fileName, 1), reused: false }, projects, target }
  }

  const documentId = requiredString(params.document_id, 'document_id')
  const project = requireProject(current, documentId)
  const activeProjects = current.activeProjectId === project.id
    ? current
    : { ...current, activeProjectId: project.id }
  const projectRevision = revisionOf(context, project.id)

  if (request.method === 'read_deck') {
    assertKeys(params, ['document_id', 'include_theme'], 'read_deck')
    const includeTheme = optionalBoolean(params.include_theme, 'include_theme') ?? false
    const fileName = context.fileNameOf?.(project.id) || `${project.title.replace(/\.pptx$/i, '') || 'Untitled'}.pptx`
    return {
      result: deckRead(project, fileName, projectRevision, includeTheme),
      ...(activeProjects === current ? {} : { projects: activeProjects }),
    }
  }

  if (request.method === 'read_page') {
    assertKeys(params, ['document_id', 'page_id', 'format', 'element_ids'], 'read_page')
    const slide = requireSlide(project, requiredString(params.page_id, 'page_id'))
    const format = enumValue(params.format ?? 'compact', new Set(['compact', 'model', 'both'] as const), 'format')
    const elementIds = stringArray(params.element_ids, 'element_ids')
    return {
      result: pageRead(project, slide, format, elementIds),
      ...(activeProjects === current ? {} : { projects: activeProjects }),
    }
  }

  if (request.method === 'inspect') {
    assertKeys(params, ['document_id', 'kind', 'page_id'], 'inspect')
    if (params.kind !== 'render') throw new Error(`Unsupported PowerPoint inspection: ${String(params.kind)}`)
    const slide = requireSlide(project, optionalString(params.page_id, 'page_id') ?? project.slides.selectedPageId)
    const nextProject = { ...project, slides: selectPresentationPage(project.slides, slide.id) }
    return {
      result: {
        kind: 'render',
        document_id: project.id,
        document_revision: projectRevision,
        page_id: slide.id,
        index: project.slides.pages.indexOf(slide),
        revision: pageRevision(project, slide),
      },
      projects: replaceProject(activeProjects, nextProject),
      changedProjectId: project.id,
      contentChanged: false,
    }
  }

  if (request.method === 'edit_page') {
    assertKeys(params, ['document_id', 'page_id', 'expected_revision', 'operations', 'assets', 'validate_only'], 'edit_page')
    const pageId = requiredString(params.page_id, 'page_id')
    const slide = requireSlide(project, pageId)
    assertPageRevision(project, slide, requiredString(params.expected_revision, 'expected_revision'))
    const edited = editPresentationPage(project, pageId, params.operations, assetsValue(params.assets))
    const validateOnly = optionalBoolean(params.validate_only, 'validate_only') ?? false
    if (validateOnly) {
      return { result: { status: 'validated', document_id: project.id, page_id: pageId, changed_page_ids: edited.changedPageIds, changed_element_ids: edited.changedElementIds } }
    }
    const nextProject = editPresentationProject(project, edited.project)
    const nextSlide = requireSlide(nextProject, pageId)
    const nextRevision = projectRevision + 1
    return {
      agentChange: { elementIds: edited.changedElementIds, kind: 'content', slideId: pageId },
      result: {
        status: 'ready',
        document_id: project.id,
        page_id: pageId,
        changed_page_ids: edited.changedPageIds,
        changed_element_ids: edited.changedElementIds,
        revision: pageRevision(nextProject, nextSlide),
        deck_revision: documentRevision(nextProject, nextRevision),
      },
      projects: replaceProject(activeProjects, nextProject),
      changedProjectId: project.id,
      contentChanged: true,
    }
  }

  if (request.method === 'manage_deck') {
    assertKeys(params, ['document_id', 'expected_revision', 'operations', 'validate_only'], 'manage_deck')
    assertDocumentRevision(project, projectRevision, requiredString(params.expected_revision, 'expected_revision'))
    const edited = managePresentationDeck(project, params.operations)
    const validateOnly = optionalBoolean(params.validate_only, 'validate_only') ?? false
    if (validateOnly) {
      return { result: { status: 'validated', document_id: project.id, changed_page_ids: edited.changedPageIds } }
    }
    const nextProject = editPresentationProject(project, edited.project)
    const selected = requireSlide(nextProject, nextProject.slides.selectedPageId)
    return {
      agentChange: { elementIds: selected.elements.map((element) => element.id), kind: edited.designChanged ? 'design' : 'content', slideId: selected.id },
      result: { status: 'ready', document_id: project.id, changed_page_ids: edited.changedPageIds, revision: documentRevision(nextProject, projectRevision + 1) },
      projects: replaceProject(activeProjects, nextProject),
      changedProjectId: project.id,
      contentChanged: true,
    }
  }

  throw new Error(`Unsupported PowerPoint method: ${String(request.method)}`)
}

function deckRead(document: PresentationProject, fileName: string, revision: number, includeTheme = true): Record<string, unknown> {
  const selectedIndex = Math.max(0, document.slides.pages.findIndex((slide) => slide.id === document.slides.selectedPageId))
  return {
    document_id: document.id,
    revision: documentRevision(document, revision),
    deck: {
      id: document.id,
      title: document.title,
      file_name: fileName,
      page_size: structuredClone(document.pageSize),
      total_pages: document.slides.pages.length,
      active_page_id: document.slides.selectedPageId,
      active_page_index: selectedIndex,
      ...(includeTheme ? { theme: structuredClone(document.theme) } : {}),
      pages: document.slides.pages.map((slide, index) => pageSummary(document, slide, index)),
    },
  }
}

function pageRead(document: PresentationProject, slide: PresentationSlide, format: 'both' | 'compact' | 'model', elementIds?: string[]): Record<string, unknown> {
  const index = document.slides.pages.findIndex((item) => item.id === slide.id)
  const selectedElements = elementIds?.length
    ? slide.elements.filter((element) => elementIds.includes(element.id))
    : slide.elements
  if (elementIds?.some((id) => !slide.elements.some((element) => element.id === id))) {
    throw new Error('element_ids contains an unknown PowerPoint element')
  }
  const assets = pageAssets(document, { ...slide, elements: selectedElements })
  return {
    document_id: document.id,
    page_id: slide.id,
    revision: pageRevision(document, slide),
    page: {
      ...pageSummary(document, slide, index),
      refs: selectedElements.map((element) => element.id),
      ...(format === 'compact' || format === 'both' ? { markdown: decompilePresentationSlideMarkdown({ ...slide, elements: selectedElements }, document) } : {}),
      ...(format === 'model' || format === 'both' ? {
        model: {
          id: slide.id,
          name: slide.name,
          layout: slide.layout,
          background: slide.background,
          notes: slide.notes,
          footer: slide.footer,
          transition: structuredClone(slide.transition),
          comments: structuredClone(slide.comments ?? []),
          elements: selectedElements.map((element) => pageModelElement(document, element)),
        },
      } : {}),
    },
    assets,
  }
}

function pageSummary(document: PresentationProject, slide: PresentationSlide, index: number): Record<string, unknown> {
  const text = slide.elements.flatMap((element) => (
    'text' in element && typeof element.text === 'string' ? [element.text.trim()] : []
  )).filter(Boolean).join(' ')
  return {
    id: slide.id,
    index,
    name: slide.name,
    layout: slide.layout ?? 'blank',
    summary: text.slice(0, 240) || undefined,
    has_content: slide.elements.length > 0 || Boolean(slide.notes?.trim()),
    revision: pageRevision(document, slide),
  }
}

function pageAssets(document: PresentationProject, slide: PresentationSlide): Array<{ path: string; file_name: string; mime_type: string; data_url?: string }> {
  const found = new Map<string, { path: string; file_name: string; mime_type: string; data_url?: string }>()
  for (const element of slide.elements) {
    if (element.type !== 'image' && element.type !== 'audio' && element.type !== 'video') continue
    const source = presentationElementSource(document, element)
    if (!source) continue
    const path = pageAssetPath(source, element.id)
    if (found.has(path)) continue
    found.set(path, {
      path,
      file_name: source.fileName,
      mime_type: source.mimeType,
      ...(!source.path ? { data_url: source.dataUrl } : {}),
    })
  }
  return [...found.values()]
}

function pageModelElement(document: PresentationProject, element: PresentationSlide['elements'][number]): Record<string, unknown> {
  if (element.type !== 'image' && element.type !== 'audio' && element.type !== 'video') {
    return structuredClone(element) as unknown as Record<string, unknown>
  }
  const source = presentationElementSource(document, element)
  if (!source) throw new Error(`PowerPoint element refers to a missing asset: ${element.id}`)
  const { sourceAssetId: _sourceAssetId, ...projected } = structuredClone(element)
  return { ...projected, src: pageAssetPath(source, element.id) }
}

function pageAssetPath(source: PresentationFileSource, elementId: string): string {
  const safeName = source.fileName.replace(/[^A-Za-z0-9._-]+/g, '-') || `${elementId}.bin`
  return source.path ?? `.ppt-assets/${encodeURIComponent(source.assetId ?? elementId)}-${safeName}`
}

const mediaRevisions = new WeakMap<object, { dataUrl: string; revision: string }>()

function pageRevision(document: PresentationProject, slide: PresentationSlide): string {
  const referencedAssets = slide.elements.flatMap((element) => {
    if (element.type !== 'image' && element.type !== 'audio' && element.type !== 'video') return []
    const asset = presentationAsset(document, element.sourceAssetId)
    return asset ? [asset] : []
  })
  return fingerprint(JSON.stringify({ slide, assets: referencedAssets, pageSize: document.pageSize, theme: document.theme }, function (key, value: unknown) {
    if (key !== 'dataUrl' || typeof value !== 'string') return value
    const source = this as object
    let cached = mediaRevisions.get(source)
    if (!cached || cached.dataUrl !== value) {
      cached = { dataUrl: value, revision: `${value.length}:${fingerprint(value)}` }
      mediaRevisions.set(source, cached)
    }
    return cached.revision
  }))
}

function documentRevision(document: PresentationProject, revision: number): string {
  return fingerprint(`${document.id}:${revision}`)
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function assertDocumentRevision(document: PresentationProject, revision: number, expected: string): void {
  if (documentRevision(document, revision) === expected) return
  throw new PowerPointProtocolError('The PowerPoint changed after it was read. Read the deck again before retrying.', 'document_changed')
}

function assertPageRevision(document: PresentationProject, slide: PresentationSlide, expected: string): void {
  if (pageRevision(document, slide) === expected) return
  throw new PowerPointProtocolError(`PowerPoint page ${slide.id} changed after it was read. Read it again before retrying.`, 'page_changed')
}

function assetsValue(value: unknown): Record<string, PresentationFileSource> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new TypeError('assets must be an object')
  return value as Record<string, PresentationFileSource>
}

function replaceProject(collection: PowerPointProjectCollection, project: PresentationProject): PowerPointProjectCollection {
  return {
    activeProjectId: project.id,
    projects: collection.projects.map((candidate) => candidate.id === project.id ? project : candidate),
  }
}

function requireActiveProject(collection: PowerPointProjectCollection): PresentationProject {
  return requireProject(collection, collection.activeProjectId)
}

function requireProject(collection: PowerPointProjectCollection, projectId: string): PresentationProject {
  const project = collection.projects.find((candidate) => candidate.id === projectId)
  if (!project) throw new PowerPointProtocolError(`PowerPoint project not found: ${projectId}`, 'document_not_found')
  return project
}

function revisionOf(context: PowerPointRuntimeContext, projectId: string): number {
  return context.revisionOf?.(projectId) ?? 1
}

function requireSlide(document: PresentationProject, pageId: string): PresentationSlide {
  const slide = document.slides.pages.find((candidate) => candidate.id === pageId)
  if (!slide) throw new Error(`PowerPoint page not found: ${pageId}`)
  return slide
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value.trim() || undefined
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${name} must be an array of non-empty strings`)
  }
  return [...new Set(value.map((item) => item.trim()))]
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, name: string): T {
  const normalized = requiredString(value, name)
  if (!allowed.has(normalized as T)) throw new Error(`Unsupported ${name}: ${normalized}`)
  return normalized as T
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key))
  if (unexpected) throw new Error(`Unsupported ${name} parameter: ${unexpected}`)
}
