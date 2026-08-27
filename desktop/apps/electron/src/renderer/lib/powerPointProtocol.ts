import {
  PRESENTATION_PAGE_SIZES,
  createBlankPresentationDocument,
  createBlankPresentationSlide,
  createPresentationId,
  type PresentationAnimationEffect,
  type PresentationDocument,
  type PresentationElement,
  type PresentationPageSizePreset,
  type PresentationSlide,
  type PresentationWorkspace,
} from '@/atoms/presentation'

export const POWERPOINT_PROTOCOL_VERSION = 1 as const

export interface PowerPointRequest {
  method: 'list' | 'snapshot' | 'apply'
  params?: Record<string, unknown>
}

export interface PowerPointDispatchResult {
  result: unknown
  workspace?: PresentationWorkspace
}

type PowerPointOperation = Record<string, unknown> & { type?: unknown }

const ANIMATION_EFFECTS = new Set<PresentationAnimationEffect>([
  'none', 'appear', 'fade', 'blinds', 'checkerboard', 'dissolve', 'flyIn', 'floatIn',
  'split', 'wipeIn', 'zoomIn', 'zoom', 'fillColor', 'textColor', 'disappear', 'blindsOut',
])
const ANIMATION_STARTS = new Set(['onClick', 'withPrevious', 'afterPrevious'])
const ANIMATION_TRIGGERS = new Set(['slideClick', 'elementClick'])

/** Execute one stable renderer-domain request without depending on DOM structure. */
export function executePowerPointRequest(
  current: PresentationWorkspace,
  request: PowerPointRequest,
): PowerPointDispatchResult {
  if (!request || typeof request !== 'object') throw new TypeError('PowerPoint request is required')
  if (request.method === 'list') return { result: listWorkspace(current) }
  if (request.method === 'snapshot') {
    const documentId = optionalString(request.params?.document_id, 'document_id')
    if (!documentId) return { result: structuredClone(current) }
    return { result: structuredClone(requireDocument(current, documentId)) }
  }
  if (request.method !== 'apply') throw new Error(`Unsupported PowerPoint method: ${String(request.method)}`)
  const operations = request.params?.operations
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError('apply requires a non-empty operations array')
  }
  if (operations.length > 200) throw new Error('A PowerPoint batch may contain at most 200 operations')

  let workspace = structuredClone(current)
  const results: unknown[] = []
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('Every PowerPoint operation must be an object')
    }
    const applied = applyOperation(workspace, raw as PowerPointOperation)
    workspace = applied.workspace
    results.push(applied.result)
  }
  return {
    workspace,
    result: { applied: results.length, results, state: listWorkspace(workspace) },
  }
}

function applyOperation(
  workspace: PresentationWorkspace,
  operation: PowerPointOperation,
): { workspace: PresentationWorkspace; result: unknown } {
  const type = requiredString(operation.type, 'type')
  if (type === 'create_document') {
    const document = createBlankPresentationDocument(optionalString(operation.title, 'title') ?? '')
    return {
      workspace: { activeDocumentId: document.id, documents: [...workspace.documents, document] },
      result: { document_id: document.id, slide_id: document.selectedSlideId },
    }
  }

  const documentId = optionalString(operation.document_id, 'document_id') ?? workspace.activeDocumentId
  const document = requireDocument(workspace, documentId)

  if (type === 'select_document') {
    return { workspace: { ...workspace, activeDocumentId: document.id }, result: { document_id: document.id } }
  }
  if (type === 'rename_document') {
    return replaceDocument(workspace, { ...document, title: requiredString(operation.title, 'title') })
  }
  if (type === 'close_document') {
    const documents = workspace.documents.filter((item) => item.id !== document.id)
    if (documents.length === 0) documents.push(createBlankPresentationDocument(''))
    const activeDocumentId = workspace.activeDocumentId === document.id
      ? documents[0]!.id
      : workspace.activeDocumentId
    return { workspace: { activeDocumentId, documents }, result: { document_id: document.id } }
  }
  if (type === 'set_page_size') {
    const preset = requiredString(operation.preset, 'preset') as PresentationPageSizePreset
    if (!(preset in PRESENTATION_PAGE_SIZES)) throw new Error(`Unsupported page-size preset: ${preset}`)
    return replaceDocument(workspace, {
      ...document,
      pageSize: { ...PRESENTATION_PAGE_SIZES[preset] },
    })
  }
  if (type === 'update_master') {
    const patch = recordValue(operation.patch, 'patch')
    return replaceDocument(workspace, {
      ...document,
      master: {
        ...document.master,
        ...(typeof patch.background === 'string' ? { background: patch.background } : {}),
        ...(typeof patch.bodyFontFamily === 'string' ? { bodyFontFamily: patch.bodyFontFamily } : {}),
        ...(typeof patch.titleFontFamily === 'string' ? { titleFontFamily: patch.titleFontFamily } : {}),
        ...(isRecord(patch.footer) ? { footer: { ...document.master.footer, ...patch.footer } } : {}),
      },
    })
  }

  if (type === 'add_slide') {
    const slide = createBlankPresentationSlide(
      optionalString(operation.name, 'name') ?? `Slide ${document.slides.length + 1}`,
    )
    if (typeof operation.background === 'string') slide.background = operation.background
    if (typeof operation.layout === 'string') slide.layout = operation.layout as PresentationSlide['layout']
    const afterSlideId = optionalString(operation.after_slide_id, 'after_slide_id')
    const index = afterSlideId
      ? document.slides.findIndex((item) => item.id === afterSlideId) + 1
      : document.slides.length
    if (afterSlideId && index === 0) throw new Error(`Unknown slide: ${afterSlideId}`)
    const slides = [...document.slides]
    slides.splice(index, 0, slide)
    return replaceDocument(workspace, { ...document, slides, selectedSlideId: slide.id }, { slide_id: slide.id })
  }

  const slideId = optionalString(operation.slide_id, 'slide_id') ?? document.selectedSlideId
  const slide = requireSlide(document, slideId)
  if (type === 'select_slide') {
    return replaceDocument(workspace, { ...document, selectedSlideId: slide.id }, { slide_id: slide.id })
  }
  if (type === 'update_slide') {
    const patch = recordValue(operation.patch, 'patch')
    const next = {
      ...slide,
      ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
      ...(typeof patch.background === 'string' ? { background: patch.background } : {}),
      ...(typeof patch.notes === 'string' ? { notes: patch.notes } : {}),
      ...(typeof patch.layout === 'string' ? { layout: patch.layout as PresentationSlide['layout'] } : {}),
    }
    return replaceSlide(workspace, document, next)
  }
  if (type === 'delete_slide') {
    if (document.slides.length === 1) throw new Error('A presentation must keep at least one slide')
    const index = document.slides.findIndex((item) => item.id === slide.id)
    const slides = document.slides.filter((item) => item.id !== slide.id)
    const selectedSlideId = document.selectedSlideId === slide.id
      ? slides[Math.min(index, slides.length - 1)]!.id
      : document.selectedSlideId
    return replaceDocument(workspace, { ...document, slides, selectedSlideId }, { slide_id: slide.id })
  }
  if (type === 'set_transition') {
    const transition = recordValue(operation.transition, 'transition')
    return replaceSlide(workspace, document, {
      ...slide,
      transition: { ...slide.transition, ...transition },
    })
  }
  if (type === 'add_comment') {
    const comment = {
      id: createPresentationId('comment'),
      author: optionalString(operation.author, 'author') ?? 'Agent',
      createdAt: new Date().toISOString(),
      elementId: optionalString(operation.element_id, 'element_id'),
      resolved: false,
      text: requiredString(operation.text, 'text'),
    }
    return replaceSlide(workspace, document, {
      ...slide,
      comments: [...(slide.comments ?? []), comment],
    }, { comment_id: comment.id })
  }
  if (type === 'add_element') {
    const element = normalizeElement(recordValue(operation.element, 'element'))
    return replaceSlide(workspace, document, {
      ...slide,
      elements: [...slide.elements, element],
    }, { element_id: element.id })
  }

  const elementId = requiredString(operation.element_id, 'element_id')
  const element = slide.elements.find((item) => item.id === elementId)
  if (!element) throw new Error(`Unknown element: ${elementId}`)
  if (type === 'delete_element') {
    return replaceSlide(workspace, document, {
      ...slide,
      elements: slide.elements.filter((item) => item.id !== elementId),
    }, { element_id: elementId })
  }
  if (type === 'update_element') {
    const patch = recordValue(operation.patch, 'patch')
    if ('id' in patch || 'type' in patch) throw new Error('Element id and type cannot be changed')
    return replaceElement(workspace, document, slide, { ...element, ...patch } as PresentationElement)
  }
  if (type === 'reorder_element') {
    const index = integerValue(operation.index, 'index')
    const elements = slide.elements.filter((item) => item.id !== elementId)
    elements.splice(Math.max(0, Math.min(index, elements.length)), 0, element)
    return replaceSlide(workspace, document, { ...slide, elements }, { element_id: elementId })
  }
  if (type === 'add_animation') {
    const effect = requiredString(operation.effect, 'effect') as PresentationAnimationEffect
    if (!ANIMATION_EFFECTS.has(effect)) throw new Error(`Unsupported animation effect: ${effect}`)
    const start = optionalString(operation.start, 'start') ?? 'onClick'
    if (!ANIMATION_STARTS.has(start)) throw new Error(`Unsupported animation start: ${start}`)
    const trigger = optionalString(operation.trigger, 'trigger')
    if (trigger && !ANIMATION_TRIGGERS.has(trigger)) {
      throw new Error(`Unsupported animation trigger: ${trigger}`)
    }
    const duration = optionalNumber(operation.duration, 'duration') ?? 0.5
    const delay = optionalNumber(operation.delay, 'delay') ?? 0
    if (duration < 0 || delay < 0) throw new Error('Animation duration and delay cannot be negative')
    const animated = {
      ...element,
      animation: effect,
      animationStart: start,
      animationDuration: duration,
      animationDelay: delay,
      ...(trigger ? { animationTrigger: trigger } : {}),
      ...(operation.color ? { animationColor: requiredString(operation.color, 'color') } : {}),
    } as PresentationElement
    return replaceElement(workspace, document, slide, animated)
  }
  if (type === 'clear_animation') {
    const animated = { ...element }
    delete animated.animation
    delete animated.animationStart
    delete animated.animationDuration
    delete animated.animationDelay
    delete animated.animationTrigger
    delete animated.animationColor
    return replaceElement(workspace, document, slide, animated)
  }
  throw new Error(`Unsupported PowerPoint operation: ${type}`)
}

function normalizeElement(raw: Record<string, unknown>): PresentationElement {
  const type = requiredString(raw.type, 'element.type')
  const base = {
    ...raw,
    id: optionalString(raw.id, 'element.id') ?? createPresentationId(type),
    type,
    x: optionalNumber(raw.x, 'element.x') ?? 80,
    y: optionalNumber(raw.y, 'element.y') ?? 80,
    width: optionalNumber(raw.width, 'element.width') ?? 320,
    height: optionalNumber(raw.height, 'element.height') ?? 120,
    rotation: optionalNumber(raw.rotation, 'element.rotation') ?? 0,
  }
  if (type === 'text') {
    return {
      ...base,
      type: 'text',
      text: typeof raw.text === 'string' ? raw.text : '',
      fontSize: optionalNumber(raw.fontSize, 'element.fontSize') ?? 28,
      fontFamily: typeof raw.fontFamily === 'string' ? raw.fontFamily : 'Aptos',
      fontWeight: (optionalNumber(raw.fontWeight, 'element.fontWeight') ?? 400) as 400,
      color: typeof raw.color === 'string' ? raw.color : '#20202B',
      align: (typeof raw.align === 'string' ? raw.align : 'left') as 'left',
    }
  }
  if (type === 'image') {
    return { ...base, type: 'image', source: recordValue(raw.source, 'element.source') as never, altText: String(raw.altText ?? ''), fit: raw.fit === 'cover' ? 'cover' : 'contain' }
  }
  if (type === 'table') {
    return { ...base, type: 'table', cells: Array.isArray(raw.cells) ? raw.cells as string[][] : [['']], headerRow: raw.headerRow !== false, headerFill: String(raw.headerFill ?? '#E8EAF0'), bodyFill: String(raw.bodyFill ?? '#FFFFFF'), textColor: String(raw.textColor ?? '#20202B'), borderColor: String(raw.borderColor ?? '#B8BCC8'), fontSize: optionalNumber(raw.fontSize, 'element.fontSize') ?? 18 }
  }
  if (type === 'chart') {
    return { ...base, type: 'chart', chartType: (raw.chartType as 'column') ?? 'column', categories: Array.isArray(raw.categories) ? raw.categories as string[] : [], series: Array.isArray(raw.series) ? raw.series as never : [], showLegend: raw.showLegend !== false, colors: Array.isArray(raw.colors) ? raw.colors as string[] : ['#5B67F1'] }
  }
  if (type === 'audio' || type === 'video') {
    return { ...base, type, source: recordValue(raw.source, 'element.source') as never, autoplay: raw.autoplay === true, loop: raw.loop === true, muted: raw.muted === true } as PresentationElement
  }
  return {
    ...base,
    type: type as PresentationElement['type'],
    fill: typeof raw.fill === 'string' ? raw.fill : '#5B67F1',
    borderColor: typeof raw.borderColor === 'string' ? raw.borderColor : '#4348B8',
    borderWidth: optionalNumber(raw.borderWidth, 'element.borderWidth') ?? 1,
  } as PresentationElement
}

function listWorkspace(workspace: PresentationWorkspace): unknown {
  return {
    active_document_id: workspace.activeDocumentId,
    presentations: workspace.documents.map((document) => ({
      id: document.id,
      title: document.title,
      active: document.id === workspace.activeDocumentId,
      slide_count: document.slides.length,
      selected_slide_id: document.selectedSlideId,
    })),
  }
}

function replaceDocument(
  workspace: PresentationWorkspace,
  document: PresentationDocument,
  result: unknown = { document_id: document.id },
): { workspace: PresentationWorkspace; result: unknown } {
  const previous = requireDocument(workspace, document.id)
  const versionedDocument = {
    ...document,
    version: Math.max(document.version, previous.version + 1),
  }
  return {
    workspace: {
      ...workspace,
      documents: workspace.documents.map((item) => (
        item.id === versionedDocument.id ? versionedDocument : item
      )),
    },
    result,
  }
}

function replaceSlide(
  workspace: PresentationWorkspace,
  document: PresentationDocument,
  slide: PresentationSlide,
  result: unknown = { slide_id: slide.id },
): { workspace: PresentationWorkspace; result: unknown } {
  return replaceDocument(workspace, {
    ...document,
    slides: document.slides.map((item) => item.id === slide.id ? slide : item),
  }, result)
}

function replaceElement(
  workspace: PresentationWorkspace,
  document: PresentationDocument,
  slide: PresentationSlide,
  element: PresentationElement,
): { workspace: PresentationWorkspace; result: unknown } {
  return replaceSlide(workspace, document, {
    ...slide,
    elements: slide.elements.map((item) => item.id === element.id ? element : item),
  }, { element_id: element.id })
}

function requireDocument(workspace: PresentationWorkspace, id: string): PresentationDocument {
  const document = workspace.documents.find((item) => item.id === id)
  if (!document) throw new Error(`Unknown presentation: ${id}`)
  return document
}

function requireSlide(document: PresentationDocument, id: string): PresentationSlide {
  const slide = document.slides.find((item) => item.id === id)
  if (!slide) throw new Error(`Unknown slide: ${id}`)
  return slide
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`)
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`)
  return value.trim()
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`)
  return value
}

function integerValue(value: unknown, name: string): number {
  const number = optionalNumber(value, name)
  if (number === undefined || !Number.isInteger(number)) throw new TypeError(`${name} must be an integer`)
  return number
}
