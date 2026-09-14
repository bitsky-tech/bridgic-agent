import {
  createBlankPresentationDocument,
  type PresentationAgentChange,
  type PresentationDocument,
  type PresentationFileSource,
  type PresentationSlide,
  type PresentationWorkspace,
} from '@/atoms/presentation'
import {
  applyPresentationDesign,
  normalizePresentationDesignColor,
  type PresentationDesignPatch,
  type PresentationThemePresetId,
} from '@/lib/presentationDesign'
import {
  compilePresentationElementMarkdown,
  compilePresentationSlideMarkdown,
  decompilePresentationSlideMarkdown,
  inspectPresentationMarkdownAssets,
  type PresentationMarkdownAssets,
} from '@/lib/presentationMarkdown'
import { importPresentationPptx } from '@/lib/presentationPptxImport'

export const POWERPOINT_PROTOCOL_VERSION = 5 as const

export type PowerPointMethod =
  | 'view_ppt'
  | 'inspect_ppt_assets'
  | 'get_ppt_page'
  | 'update_ppt_design'
  | 'edit_ppt_page'
  | 'insert_ppt_element'
  | 'remove_ppt_element'
  | 'insert_ppt_page'
  | 'remove_ppt_page'
  | 'move_ppt_page'
  | 'goto_ppt_page'

export interface PowerPointRequest {
  method: PowerPointMethod
  params?: Record<string, unknown>
}

export interface PowerPointRuntimeContext {
  currentTarget: string | null
  fileName: string
}

export interface PowerPointDispatchResult {
  agentChange?: Omit<PresentationAgentChange, 'changeId'>
  result: unknown
  workspace?: PresentationWorkspace
  target?: string
  persist?: boolean
}

export class PowerPointProtocolError extends Error {
  constructor(message: string, readonly code: 'deck_changed' | 'document_changed' | 'page_changed') {
    super(message)
    this.name = 'PowerPointProtocolError'
  }
}

/** Execute one page-level PPT request against the same native model used by the editor. */
export async function executePowerPointRequest(
  current: PresentationWorkspace,
  request: PowerPointRequest,
  context: PowerPointRuntimeContext = { currentTarget: null, fileName: 'Untitled.pptx' },
): Promise<PowerPointDispatchResult> {
  if (!request || typeof request !== 'object') throw new TypeError('PowerPoint request is required')
  const params = request.params ?? {}

  if (request.method === 'view_ppt') {
    const target = requiredString(params.target, 'target')
    const fileName = requiredString(params.file_name, 'file_name')
    if (context.currentTarget === target) {
      return { result: { ...deckOverview(requireActiveDocument(current), fileName), reused: true }, target }
    }
    const encoded = optionalString(params.content_base64, 'content_base64')
    const document = encoded
      ? await importPresentationPptx(decodeBase64(encoded), fileName)
      : createBlankPresentationDocument(fileName.replace(/\.pptx$/i, ''))
    const workspace = { activeDocumentId: document.id, documents: [document] }
    return { result: { ...deckOverview(document, fileName), reused: false }, workspace, target, persist: !encoded }
  }

  if (request.method === 'inspect_ppt_assets') {
    return { result: inspectPresentationMarkdownAssets(requiredString(params.markdown, 'markdown')) }
  }

  const document = requireActiveDocument(current)
  if (request.method === 'get_ppt_page') {
    return { result: pageView(document, requireSlide(document, requiredString(params.page_id, 'page_id'))) }
  }

  if (request.method === 'goto_ppt_page') {
    const slide = requireSlide(document, requiredString(params.page_id, 'page_id'))
    const nextDocument = { ...document, selectedSlideId: slide.id }
    return {
      result: { page_id: slide.id, index: document.slides.indexOf(slide), visible: true },
      workspace: replaceDocument(current, nextDocument),
    }
  }

  if (request.method === 'update_ppt_design') {
    assertDocumentRevision(document, requiredString(params.expected_document_revision, 'expected_document_revision'))
    const designed = applyPresentationDesign(document, designPatch(params.design, document))
    const nextDocument = { ...designed, version: document.version + 1 }
    const selectedSlide = requireSlide(nextDocument, nextDocument.selectedSlideId)
    return {
      agentChange: {
        elementIds: selectedSlide.elements.map((element) => element.id),
        kind: 'design',
        slideId: selectedSlide.id,
      },
      result: deckOverview(nextDocument, context.fileName),
      workspace: replaceDocument(current, nextDocument),
      persist: true,
    }
  }

  if (request.method === 'edit_ppt_page') {
    const slide = requireSlide(document, requiredString(params.page_id, 'page_id'))
    assertPageRevision(slide, requiredString(params.expected_revision, 'expected_revision'))
    const ref = requiredString(params.ref, 'ref')
    const elementIndex = slide.elements.findIndex((element) => element.id === ref)
    if (elementIndex < 0) throw new Error(`Unknown PowerPoint element ref: ${ref}`)
    const compiled = compileElement(
      requiredString(params.replacement, 'replacement'), document, slide, assetsValue(params.assets), ref,
    )
    if ('invalid' in compiled) return { result: compiled.invalid }
    const elements = [...slide.elements]
    elements[elementIndex] = compiled.element
    const replacement = { ...slide, elements }
    const nextDocument = replaceSlide(document, replacement)
    return {
      agentChange: {
        elementIds: [ref],
        kind: 'content',
        slideId: replacement.id,
      },
      result: {
        status: 'ready',
        diagnostics: diagnostics(compiled.diagnostics),
        document_revision: documentRevision(nextDocument),
        element_ref: ref,
        ...pageView(nextDocument, replacement),
      },
      workspace: replaceDocument(current, nextDocument),
      persist: true,
    }
  }

  if (request.method === 'insert_ppt_element') {
    const slide = requireSlide(document, requiredString(params.page_id, 'page_id'))
    assertPageRevision(slide, requiredString(params.expected_revision, 'expected_revision'))
    const compiled = compileElement(
      requiredString(params.element, 'element'), document, slide, assetsValue(params.assets),
    )
    if ('invalid' in compiled) return { result: compiled.invalid }
    const replacement = { ...slide, elements: [...slide.elements, compiled.element] }
    const nextDocument = replaceSlide(document, replacement)
    return {
      agentChange: {
        elementIds: [compiled.element.id],
        kind: 'content',
        slideId: replacement.id,
      },
      result: {
        status: 'ready',
        diagnostics: diagnostics(compiled.diagnostics),
        document_revision: documentRevision(nextDocument),
        element_ref: compiled.element.id,
        ...pageView(nextDocument, replacement),
      },
      workspace: replaceDocument(current, nextDocument),
      persist: true,
    }
  }

  if (request.method === 'remove_ppt_element') {
    const slide = requireSlide(document, requiredString(params.page_id, 'page_id'))
    assertPageRevision(slide, requiredString(params.expected_revision, 'expected_revision'))
    const ref = requiredString(params.ref, 'ref')
    if (!slide.elements.some((element) => element.id === ref)) {
      throw new Error(`Unknown PowerPoint element ref: ${ref}`)
    }
    const replacement = { ...slide, elements: slide.elements.filter((element) => element.id !== ref) }
    const nextDocument = replaceSlide(document, replacement)
    return {
      agentChange: { elementIds: [], kind: 'content', slideId: replacement.id },
      result: {
        status: 'ready',
        diagnostics: [],
        document_revision: documentRevision(nextDocument),
        element_ref: ref,
        ...pageView(nextDocument, replacement),
      },
      workspace: replaceDocument(current, nextDocument),
      persist: true,
    }
  }

  if (request.method === 'insert_ppt_page') {
    const compiled = compilePage(requiredString(params.markdown, 'markdown'), document, assetsValue(params.assets))
    if ('invalid' in compiled) return { result: compiled.invalid }
    const afterPageId = optionalString(params.after_page_id, 'after_page_id')
    const insertionIndex = afterPageId
      ? document.slides.findIndex((slide) => slide.id === afterPageId) + 1
      : document.slides.length
    if (afterPageId && insertionIndex === 0) throw new Error(`Unknown PowerPoint page: ${afterPageId}`)
    const slides = [...document.slides]
    slides.splice(insertionIndex, 0, compiled.slide)
    const nextDocument = { ...document, selectedSlideId: compiled.slide.id, slides, version: document.version + 1 }
    return {
      agentChange: {
        elementIds: compiled.slide.elements.map((element) => element.id),
        kind: 'content',
        slideId: compiled.slide.id,
      },
      result: {
        status: 'ready',
        diagnostics: diagnostics(compiled.diagnostics),
        ...deckOverview(nextDocument, context.fileName),
        ...pageView(nextDocument, compiled.slide),
      },
      workspace: replaceDocument(current, nextDocument),
      persist: true,
    }
  }

  if (request.method === 'remove_ppt_page') {
    const slide = requireSlide(document, requiredString(params.page_id, 'page_id'))
    assertPageRevision(slide, requiredString(params.expected_revision, 'expected_revision'))
    assertDeckRevision(document, requiredString(params.expected_deck_revision, 'expected_deck_revision'))
    if (document.slides.length === 1) throw new Error('A PowerPoint must keep at least one page')
    const oldIndex = document.slides.indexOf(slide)
    const slides = document.slides.filter((item) => item.id !== slide.id)
    const selectedSlideId = document.selectedSlideId === slide.id
      ? slides[Math.min(oldIndex, slides.length - 1)]!.id
      : document.selectedSlideId
    const nextDocument = { ...document, selectedSlideId, slides, version: document.version + 1 }
    return {
      result: deckOverview(nextDocument, context.fileName),
      workspace: replaceDocument(current, nextDocument),
      persist: true,
    }
  }

  if (request.method === 'move_ppt_page') {
    assertDeckRevision(document, requiredString(params.expected_deck_revision, 'expected_deck_revision'))
    const slide = requireSlide(document, requiredString(params.page_id, 'page_id'))
    const target = requireSlide(document, requiredString(params.target_page_id, 'target_page_id'))
    const position = requiredString(params.position, 'position')
    if (slide.id === target.id) throw new Error('A PowerPoint page cannot be moved relative to itself')
    if (position !== 'before' && position !== 'after') throw new Error("position must be 'before' or 'after'")
    const slides = document.slides.filter((item) => item.id !== slide.id)
    const targetIndex = slides.findIndex((item) => item.id === target.id)
    slides.splice(targetIndex + (position === 'after' ? 1 : 0), 0, slide)
    const nextDocument = { ...document, slides, version: document.version + 1 }
    return {
      result: deckOverview(nextDocument, context.fileName),
      workspace: replaceDocument(current, nextDocument),
      persist: true,
    }
  }

  throw new Error(`Unsupported PowerPoint method: ${String(request.method)}`)
}

function compilePage(markdown: string, document: PresentationDocument, assets: PresentationMarkdownAssets):
  | { slide: PresentationSlide; diagnostics: string[] }
  | { invalid: { status: 'invalid'; diagnostics: Array<Record<string, string>> } } {
  try {
    return compilePresentationSlideMarkdown(markdown, { assets, document, existingDocument: document })
  } catch (error) {
    return {
      invalid: {
        status: 'invalid',
        diagnostics: [{
          code: 'markdown_compile_error',
          message: error instanceof Error ? error.message : String(error),
          severity: 'error',
        }],
      },
    }
  }
}

function compileElement(
  markdown: string,
  document: PresentationDocument,
  slide: PresentationSlide,
  assets: PresentationMarkdownAssets,
  elementId?: string,
):
  | { element: PresentationSlide['elements'][number]; diagnostics: string[] }
  | { invalid: { status: 'invalid'; diagnostics: Array<Record<string, string>> } } {
  try {
    return compilePresentationElementMarkdown(markdown, {
      assets,
      document,
      elementId,
      existingDocument: document,
      slide,
    })
  } catch (error) {
    return {
      invalid: {
        status: 'invalid',
        diagnostics: [{
          code: 'element_compile_error',
          message: error instanceof Error ? error.message : String(error),
          severity: 'error',
        }],
      },
    }
  }
}

function deckOverview(document: PresentationDocument, fileName: string): Record<string, unknown> {
  const selectedIndex = Math.max(0, document.slides.findIndex((slide) => slide.id === document.selectedSlideId))
  return {
    identity: {
      document_id: document.id,
      name: document.title || fileName.replace(/\.pptx$/i, ''),
      file_name: fileName,
    },
    meta: {
      title: document.title,
      theme: structuredClone(document.master),
      page_size: structuredClone(document.pageSize),
      total_pages: document.slides.length,
      current_page_id: document.selectedSlideId,
      current_page_index: selectedIndex,
      current_position: selectedIndex + 1,
    },
    deck_revision: deckRevision(document),
    document_revision: documentRevision(document),
    pages: document.slides.map((slide, index) => pageSummary(slide, index)),
  }
}

function pageSummary(slide: PresentationSlide, index: number): Record<string, unknown> {
  const text = slide.elements.flatMap((element) => (
    'text' in element && typeof element.text === 'string' ? [element.text.trim()] : []
  )).filter(Boolean).join(' ')
  return {
    page_id: slide.id,
    index,
    title: slide.name,
    layout: slide.layout ?? 'blank',
    summary: text.slice(0, 240) || undefined,
    has_content: slide.elements.length > 0 || Boolean(slide.notes?.trim()),
    revision: pageRevision(slide),
  }
}

function pageView(document: PresentationDocument, slide: PresentationSlide): Record<string, unknown> {
  const index = document.slides.findIndex((item) => item.id === slide.id)
  const assets = pageAssets(slide)
  return {
    page: {
      ...pageSummary(slide, index),
      markdown: decompilePresentationSlideMarkdown(slide),
      asset_paths: assets.map((asset) => asset.path),
      refs: slide.elements.map((element) => element.id),
    },
    assets,
  }
}

function pageAssets(slide: PresentationSlide): Array<{
  path: string
  file_name: string
  mime_type: string
  data_url?: string
}> {
  const found = new Map<string, {
    path: string
    file_name: string
    mime_type: string
    data_url?: string
  }>()
  for (const element of slide.elements) {
    if (element.type !== 'image' && element.type !== 'audio' && element.type !== 'video') continue
    const safeName = element.source.fileName.replace(/[^A-Za-z0-9._-]+/g, '-') || `${element.id}.bin`
    const path = element.source.path ?? `.ppt-assets/${element.id}-${safeName}`
    if (found.has(path)) continue
    found.set(path, {
      path,
      file_name: element.source.fileName,
      mime_type: element.source.mimeType,
      ...(!element.source.path ? { data_url: element.source.dataUrl } : {}),
    })
  }
  return [...found.values()]
}

function pageRevision(slide: PresentationSlide): string {
  return fingerprint(JSON.stringify(slide))
}

function deckRevision(document: PresentationDocument): string {
  return fingerprint(JSON.stringify(document.slides.map((slide) => slide.id)))
}

function documentRevision(document: PresentationDocument): string {
  return fingerprint(`${document.id}:${document.version}`)
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function assertPageRevision(slide: PresentationSlide, expected: string): void {
  if (pageRevision(slide) === expected) return
  throw new PowerPointProtocolError(
    `PowerPoint page ${slide.id} changed after it was read. Call get_ppt_page again before writing.`,
    'page_changed',
  )
}

function assertDeckRevision(document: PresentationDocument, expected: string): void {
  if (deckRevision(document) === expected) return
  throw new PowerPointProtocolError(
    'The PowerPoint page order changed. Call view_ppt again before changing the structure.',
    'deck_changed',
  )
}

function assertDocumentRevision(document: PresentationDocument, expected: string): void {
  if (documentRevision(document) === expected) return
  throw new PowerPointProtocolError(
    'The PowerPoint changed after its design was read. Call view_ppt again before changing global design.',
    'document_changed',
  )
}

function designPatch(value: unknown, document: PresentationDocument): PresentationDesignPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('design must be a mapping')
  const raw = value as Record<string, unknown>
  const patch: PresentationDesignPatch = {}
  const themeIds = new Set<PresentationThemePresetId>(['lavender', 'light', 'midnight', 'paper'])
  const pageSizes = new Set(['standard', 'wide'] as const)
  const transitionEffects = new Set(['none', 'fade', 'push', 'wipe', 'reveal', 'cover', 'zoom', 'flip', 'cube'] as const)
  const transitionDirections = new Set(['left', 'right', 'up', 'down', 'in', 'out'] as const)

  if (raw.theme !== undefined) patch.theme = enumValue(raw.theme, themeIds, 'design.theme')
  if (raw.background !== undefined) patch.background = normalizePresentationDesignColor(requiredString(raw.background, 'design.background'))
  if (raw.accent_colors !== undefined) {
    if (!Array.isArray(raw.accent_colors) || raw.accent_colors.length === 0) {
      throw new TypeError('design.accent_colors must be a non-empty string array')
    }
    patch.accentColors = raw.accent_colors.map((color) => (
      normalizePresentationDesignColor(requiredString(color, 'design.accent_colors[]'))
    ))
  }
  if (raw.title_font_family !== undefined) patch.titleFontFamily = requiredString(raw.title_font_family, 'design.title_font_family')
  if (raw.body_font_family !== undefined) patch.bodyFontFamily = requiredString(raw.body_font_family, 'design.body_font_family')
  if (raw.page_size !== undefined) patch.pageSize = enumValue(raw.page_size, pageSizes, 'design.page_size')
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') throw new TypeError('design.title must be a string')
    patch.title = raw.title.trim()
  }
  if (raw.footer !== undefined) {
    if (!raw.footer || typeof raw.footer !== 'object' || Array.isArray(raw.footer)) {
      throw new TypeError('design.footer must be a mapping')
    }
    const footerRaw = raw.footer as Record<string, unknown>
    patch.footer = {
      ...(footerRaw.text === undefined ? {} : { text: stringValue(footerRaw.text, 'design.footer.text') }),
      ...(footerRaw.show_date === undefined ? {} : { showDate: booleanValue(footerRaw.show_date, 'design.footer.show_date') }),
      ...(footerRaw.show_slide_number === undefined
        ? {}
        : { showSlideNumber: booleanValue(footerRaw.show_slide_number, 'design.footer.show_slide_number') }),
    }
  }
  if (raw.transition !== undefined) {
    if (!raw.transition || typeof raw.transition !== 'object' || Array.isArray(raw.transition)) {
      throw new TypeError('design.transition must be a mapping')
    }
    const transitionRaw = raw.transition as Record<string, unknown>
    const fallback = document.slides.find((slide) => slide.id === document.selectedSlideId)?.transition
      ?? { effect: 'none' as const, durationMs: 500 }
    patch.transition = {
      effect: transitionRaw.effect === undefined
        ? fallback.effect
        : enumValue(transitionRaw.effect, transitionEffects, 'design.transition.effect'),
      durationMs: transitionRaw.duration_ms === undefined
        ? fallback.durationMs
        : nonNegativeNumber(transitionRaw.duration_ms, 'design.transition.duration_ms'),
    }
    const direction = transitionRaw.direction === undefined
      ? fallback.direction
      : enumValue(transitionRaw.direction, transitionDirections, 'design.transition.direction')
    if (direction) patch.transition.direction = direction
    const throughBlack = transitionRaw.through_black === undefined
      ? fallback.throughBlack
      : booleanValue(transitionRaw.through_black, 'design.transition.through_black')
    if (throughBlack !== undefined) patch.transition.throughBlack = throughBlack
  }
  if (Object.keys(patch).length === 0) throw new Error('update_ppt_design requires at least one design change')
  return patch
}

function diagnostics(items: string[]): Array<Record<string, string>> {
  return items.map((message) => ({ code: 'markdown_notice', message, severity: 'warning' }))
}

function assetsValue(value: unknown): PresentationMarkdownAssets {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('assets must be a mapping')
  return value as Record<string, PresentationFileSource>
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

function replaceDocument(workspace: PresentationWorkspace, document: PresentationDocument): PresentationWorkspace {
  return {
    activeDocumentId: document.id,
    documents: workspace.documents.map((item) => item.id === document.id ? document : item),
  }
}

function replaceSlide(document: PresentationDocument, slide: PresentationSlide): PresentationDocument {
  return {
    ...document,
    selectedSlideId: slide.id,
    slides: document.slides.map((item) => item.id === slide.id ? slide : item),
    version: document.version + 1,
  }
}

function requireActiveDocument(workspace: PresentationWorkspace): PresentationDocument {
  const document = workspace.documents.find((item) => item.id === workspace.activeDocumentId)
  if (!document) throw new Error('The Session has no active PowerPoint')
  return document
}

function requireSlide(document: PresentationDocument, pageId: string): PresentationSlide {
  const slide = document.slides.find((item) => item.id === pageId)
  if (!slide) throw new Error(`Unknown PowerPoint page: ${pageId}`)
  return slide
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`)
  return value.trim()
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value.trim() || undefined
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value.trim()
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`)
  }
  return value
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, name: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(', ')}`)
  }
  return value as T
}
