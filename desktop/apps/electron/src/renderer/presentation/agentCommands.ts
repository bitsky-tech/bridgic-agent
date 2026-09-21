import {
  PRESENTATION_SHAPE_TYPES,
  createBlankPresentationSlide,
  replacePresentationPages,
  type PresentationProject,
  type PresentationElement,
  type PresentationFileSource,
  type PresentationComment,
  type PresentationSlide,
} from '@/atoms/presentation'
import { applyPresentationDesign, presentationThemeTextColors, type PresentationDesignPatch } from '@/lib/presentationDesign'
import {
  clearPresentationHyperlinksToPages,
  createPresentationAsset,
  detachPresentationCommentsFromElements,
  duplicatePresentationSlide,
  mergePresentationAssets,
} from './project'
import { validatePresentationProject } from './model/reducer'

interface PresentationCommandResult {
  changedElementIds: string[]
  changedPageIds: string[]
  designChanged: boolean
  project: PresentationProject
}

type PresentationAssetInputs = Record<string, PresentationFileSource>

const shapeTypes = new Set<string>(PRESENTATION_SHAPE_TYPES)
const commonElementKeys = [
  'x', 'y', 'width', 'height', 'rotation', 'flipHorizontal', 'flipVertical', 'opacity', 'shadow', 'groupId',
  'hyperlink', 'animation', 'animationDuration', 'animationDelay', 'animationStart', 'animationTrigger', 'animationColor',
] as const
const textElementKeys = [
  'src',
  'text', 'fontSize', 'fontFamily', 'fontWeight', 'italic', 'underline', 'strikethrough', 'baseline',
  'highlightColor', 'characterSpacing', 'color', 'align', 'verticalAlign', 'lineHeight', 'lineSpacing', 'indentLevel',
  'listStyle', 'textDirection', 'wordWrap', 'textInsets', 'textRuns', 'paragraphs',
] as const
const shapeElementKeys = [
  'fill', 'fillOpacity', 'gradientFill', 'patternFill', 'borderColor', 'borderWidth', 'borderOpacity', 'radius', 'customGeometry', 'connectorPath',
] as const
const imageElementKeys = ['src', 'altText', 'fit', 'clipShape', 'crop', 'softEdgeRadius'] as const
const mediaElementKeys = ['src', 'autoplay', 'loop', 'muted'] as const
const tableElementKeys = [
  'cells', 'headerRow', 'headerFill', 'headerTextColor', 'bodyFill', 'textColor', 'borderColor', 'fontSize',
] as const
const chartElementKeys = [
  'chartType', 'categories', 'series', 'showLegend', 'showValue', 'title', 'colors', 'displayBlanksAs', 'holeSize',
  'chartAreaFill', 'plotAreaFill', 'categoryAxisLabelColor', 'valueAxisLabelColor', 'gridLineColor', 'dataLabelColor',
] as const

/** Apply a validated, all-or-nothing command batch to one page. */
export function editPresentationPage(
  document: PresentationProject,
  pageId: string,
  operations: unknown,
  assets: PresentationAssetInputs = {},
): PresentationCommandResult {
  const commands = commandList(operations, 'page operations')
  let next = structuredClone(document)
  let page = requirePage(next, pageId)
  const changedElementIds = new Set<string>()

  for (const value of commands) {
    const type = requiredString(value.type, 'operation.type')
    if (type === 'set-page') {
      assertKeys(value, ['type', 'patch'], type)
      const patch = recordValue(value.patch, 'set-page.patch')
      if (Object.keys(patch).length === 0) throw new Error('set-page.patch requires at least one property')
      page = patchPage(page, patch)
    } else if (type === 'add') {
      assertKeys(value, ['type', 'element', 'before', 'after'], type)
      const created = createElement(next, recordValue(value.element, 'add.element'), assets)
      if (page.elements.some((element) => element.id === created.element.id)) {
        throw new Error(`PowerPoint element already exists: ${created.element.id}`)
      }
      next = { ...next, assets: mergePresentationAssets(next.assets, created.assets) }
      page = { ...page, elements: placeById(page.elements, created.element, optionalString(value.before, 'add.before'), optionalString(value.after, 'add.after')) }
      changedElementIds.add(created.element.id)
    } else if (type === 'patch') {
      assertKeys(value, ['type', 'id', 'element_type', 'patch'], type)
      const id = requiredString(value.id, 'patch.id')
      const index = page.elements.findIndex((element) => element.id === id)
      if (index < 0) throw new Error(`Unknown PowerPoint element: ${id}`)
      const elementType = requiredString(value.element_type, 'patch.element_type')
      if (page.elements[index]!.type !== elementType) {
        throw new Error(`PowerPoint element ${id} is ${page.elements[index]!.type}, not ${elementType}`)
      }
      const patched = patchElement(page.elements[index]!, recordValue(value.patch, 'patch.patch'), assets)
      next = { ...next, assets: mergePresentationAssets(next.assets, patched.assets) }
      page = { ...page, elements: page.elements.map((element) => element.id === id ? patched.element : element) }
      changedElementIds.add(id)
    } else if (type === 'remove') {
      assertKeys(value, ['type', 'id'], type)
      const id = requiredString(value.id, 'remove.id')
      if (!page.elements.some((element) => element.id === id)) throw new Error(`Unknown PowerPoint element: ${id}`)
      page = detachPresentationCommentsFromElements(
        { ...page, elements: page.elements.filter((element) => element.id !== id) },
        new Set([id]),
      )
      changedElementIds.add(id)
    } else if (type === 'reorder') {
      assertKeys(value, ['type', 'id', 'before', 'after'], type)
      const id = requiredString(value.id, 'reorder.id')
      const element = page.elements.find((item) => item.id === id)
      if (!element) throw new Error(`Unknown PowerPoint element: ${id}`)
      page = { ...page, elements: placeById(page.elements, element, optionalString(value.before, 'reorder.before'), optionalString(value.after, 'reorder.after'), true) }
      changedElementIds.add(id)
    } else if (type === 'add-comment') {
      assertKeys(value, ['type', 'comment'], type)
      const raw = recordValue(value.comment, 'add-comment.comment')
      assertKeys(raw, ['id', 'author', 'createdAt', 'resolved', 'text', 'elementId'], 'add-comment.comment')
      const id = requiredString(raw.id, 'add-comment.comment.id')
      if (page.comments?.some((comment) => comment.id === id)) throw new Error(`PowerPoint comment already exists: ${id}`)
      const elementId = optionalString(raw.elementId, 'add-comment.comment.elementId')
      if (elementId && !page.elements.some((element) => element.id === elementId)) {
        throw new Error(`Unknown PowerPoint comment element: ${elementId}`)
      }
      page = {
        ...page,
        comments: [...(page.comments ?? []), {
          id,
          author: optionalString(raw.author, 'add-comment.comment.author') ?? 'Agent',
          createdAt: optionalString(raw.createdAt, 'add-comment.comment.createdAt') ?? new Date().toISOString(),
          resolved: optionalBoolean(raw.resolved, 'add-comment.comment.resolved') ?? false,
          text: requiredString(raw.text, 'add-comment.comment.text'),
          ...(elementId ? { elementId } : {}),
        }],
      }
    } else if (type === 'patch-comment') {
      assertKeys(value, ['type', 'id', 'patch'], type)
      const id = requiredString(value.id, 'patch-comment.id')
      const patch = recordValue(value.patch, 'patch-comment.patch')
      assertKeys(patch, ['author', 'resolved', 'text', 'elementId'], 'patch-comment.patch')
      if (Object.keys(patch).length === 0) throw new Error('patch-comment.patch requires at least one property')
      const comment = page.comments?.find((item) => item.id === id)
      if (!comment) throw new Error(`Unknown PowerPoint comment: ${id}`)
      const elementId = patch.elementId === null
        ? undefined
        : optionalString(patch.elementId, 'patch-comment.patch.elementId')
      if (elementId && !page.elements.some((element) => element.id === elementId)) {
        throw new Error(`Unknown PowerPoint comment element: ${elementId}`)
      }
      const nextComment: PresentationComment = {
        ...comment,
        ...(patch.author === undefined ? {} : { author: requiredString(patch.author, 'patch-comment.patch.author') }),
        ...(patch.resolved === undefined ? {} : { resolved: optionalBoolean(patch.resolved, 'patch-comment.patch.resolved')! }),
        ...(patch.text === undefined ? {} : { text: requiredString(patch.text, 'patch-comment.patch.text') }),
        ...(patch.elementId === undefined ? {} : { elementId }),
      }
      if (nextComment.elementId === undefined) delete nextComment.elementId
      page = { ...page, comments: page.comments!.map((item) => item.id === id ? nextComment : item) }
    } else if (type === 'remove-comment') {
      assertKeys(value, ['type', 'id'], type)
      const id = requiredString(value.id, 'remove-comment.id')
      if (!page.comments?.some((comment) => comment.id === id)) throw new Error(`Unknown PowerPoint comment: ${id}`)
      page = { ...page, comments: page.comments.filter((comment) => comment.id !== id) }
    } else {
      throw new Error(`Unsupported PowerPoint page operation: ${type}`)
    }
  }

  next = replacePage(next, page, pageId)
  return {
    changedElementIds: [...changedElementIds],
    changedPageIds: [pageId],
    designChanged: false,
    project: validatePresentationProject(next),
  }
}

/** Apply a validated, all-or-nothing command batch to deck structure or design. */
export function managePresentationDeck(document: PresentationProject, operations: unknown): PresentationCommandResult {
  const commands = commandList(operations, 'deck operations')
  let next = structuredClone(document)
  const changedPageIds = new Set<string>()
  let designChanged = false

  for (const value of commands) {
    const type = requiredString(value.type, 'operation.type')
    if (type === 'set-design') {
      assertKeys(value, ['type', 'patch'], type)
      next = applyPresentationDesign(next, designPatch(recordValue(value.patch, 'set-design.patch'), next))
      next.slides.pages.forEach((page) => changedPageIds.add(page.id))
      designChanged = true
    } else if (type === 'insert-page') {
      assertKeys(value, ['type', 'page', 'before', 'after'], type)
      const raw = recordValue(value.page, 'insert-page.page')
      assertKeys(raw, ['id', 'name', 'layout', 'background', 'notes', 'footer', 'transition'], 'insert-page.page')
      const id = requiredString(raw.id, 'insert-page.page.id')
      if (next.slides.pages.some((page) => page.id === id)) throw new Error(`PowerPoint page already exists: ${id}`)
      const created = patchPage({ ...createBlankPresentationSlide(optionalString(raw.name, 'insert-page.page.name') ?? `Slide ${next.slides.pages.length + 1}`), id }, raw)
      const pages = placeById(next.slides.pages, created, optionalString(value.before, 'insert-page.before'), optionalString(value.after, 'insert-page.after'))
      next = { ...next, slides: replacePresentationPages(next.slides, pages, id) }
      changedPageIds.add(id)
    } else if (type === 'duplicate-page') {
      assertKeys(value, ['type', 'pageId', 'id', 'name', 'before', 'after'], type)
      const sourceId = requiredString(value.pageId, 'duplicate-page.pageId')
      const id = requiredString(value.id, 'duplicate-page.id')
      if (next.slides.pages.some((page) => page.id === id)) throw new Error(`PowerPoint page already exists: ${id}`)
      const source = requirePage(next, sourceId)
      const created = { ...duplicatePresentationSlide(source, optionalString(value.name, 'duplicate-page.name') ?? `${source.name} copy`), id }
      const pages = placeById(next.slides.pages, created, optionalString(value.before, 'duplicate-page.before'), optionalString(value.after, 'duplicate-page.after'))
      next = { ...next, slides: replacePresentationPages(next.slides, pages, id) }
      changedPageIds.add(id)
    } else if (type === 'remove-page') {
      assertKeys(value, ['type', 'pageId'], type)
      const pageId = requiredString(value.pageId, 'remove-page.pageId')
      const index = next.slides.pages.findIndex((page) => page.id === pageId)
      if (index < 0) throw new Error(`Unknown PowerPoint page: ${pageId}`)
      if (next.slides.pages.length === 1) throw new Error('A PowerPoint must keep at least one page')
      const pages = clearPresentationHyperlinksToPages(next.slides.pages.filter((page) => page.id !== pageId), new Set([pageId]))
      const selected = next.slides.selectedPageId === pageId
        ? pages[Math.min(index, pages.length - 1)]!.id
        : next.slides.selectedPageId
      next = { ...next, slides: replacePresentationPages(next.slides, pages, selected) }
      changedPageIds.add(pageId)
    } else if (type === 'move-page') {
      assertKeys(value, ['type', 'pageId', 'before', 'after'], type)
      const pageId = requiredString(value.pageId, 'move-page.pageId')
      const page = requirePage(next, pageId)
      const pages = placeById(next.slides.pages, page, optionalString(value.before, 'move-page.before'), optionalString(value.after, 'move-page.after'), true)
      next = { ...next, slides: replacePresentationPages(next.slides, pages, pageId) }
      changedPageIds.add(pageId)
    } else {
      throw new Error(`Unsupported PowerPoint deck operation: ${type}`)
    }
  }

  return {
    changedElementIds: [],
    changedPageIds: [...changedPageIds],
    designChanged,
    project: validatePresentationProject(next),
  }
}

function createElement(document: PresentationProject, value: Record<string, unknown>, assets: PresentationAssetInputs): { assets: PresentationProject['assets']; element: PresentationElement } {
  const id = requiredString(value.id, 'element.id')
  const type = requiredString(value.type, 'element.type')
  assertKeys(value, ['id', 'type', ...commonElementKeys, ...specificElementKeys(type)], 'element')
  const base = { id, type, x: 120, y: 120, width: 480, height: 120, rotation: 0 }
  let element: Record<string, unknown>
  let createdAssets: PresentationProject['assets'] = []
  const source = () => {
    if (value.sourceAssetId !== undefined) throw new Error('Use element.src instead of sourceAssetId')
    const path = requiredString(value.src, 'element.src')
    const resolved = assets[path]
    if (!resolved) throw new Error(`PowerPoint asset was not supplied: ${path}`)
    const asset = createPresentationAsset(type as 'image' | 'audio' | 'video' | 'text', resolved)
    createdAssets = [asset]
    return asset.id
  }
  if (type === 'text') {
    const colors = presentationThemeTextColors(document.theme.background)
    const sourceAssetId = value.src === undefined ? undefined : source()
    element = {
      ...base,
      text: '', fontSize: 28, fontFamily: document.theme.bodyFontFamily, fontWeight: 400,
      color: colors.primary, align: 'left', ...without(value, ['src']), ...(sourceAssetId ? { sourceAssetId } : {}),
    }
  } else if (type === 'image') {
    element = { ...base, width: 640, height: 360, altText: '', fit: 'contain', ...without(value, ['src']), sourceAssetId: source() }
  } else if (type === 'audio' || type === 'video') {
    element = {
      ...base, width: type === 'audio' ? 64 : 640, height: type === 'audio' ? 64 : 360,
      autoplay: false, loop: false, muted: false, ...without(value, ['src']), sourceAssetId: source(),
    }
  } else if (type === 'table') {
    element = {
      ...base, width: 720, height: 300, cells: [['Header 1', 'Header 2'], ['', '']], headerRow: true,
      headerFill: document.theme.accentColors[0]!, bodyFill: '#FFFFFF', textColor: '#20202B',
      borderColor: '#D8D9E0', fontSize: 18, ...value,
    }
  } else if (type === 'chart') {
    element = {
      ...base, width: 760, height: 380, chartType: 'column', categories: [], series: [], showLegend: true,
      colors: [...document.theme.accentColors], ...value,
    }
  } else if (shapeTypes.has(type)) {
    element = { ...base, fill: document.theme.accentColors[0]!, borderColor: document.theme.accentColors[0]!, borderWidth: 1, ...value }
  } else {
    throw new Error(`Unsupported PowerPoint element type: ${type}`)
  }
  return { assets: createdAssets, element: element as unknown as PresentationElement }
}

function patchElement(current: PresentationElement, patch: Record<string, unknown>, assets: PresentationAssetInputs): { assets: PresentationProject['assets']; element: PresentationElement } {
  if (Object.keys(patch).length === 0) throw new Error('patch.patch requires at least one property')
  assertKeys(patch, [...commonElementKeys, ...specificElementKeys(current.type)], 'patch.patch')
  let createdAssets: PresentationProject['assets'] = []
  const normalized = { ...patch }
  if (normalized.src !== undefined) {
    if (current.type !== 'image' && current.type !== 'audio' && current.type !== 'video' && current.type !== 'text') throw new Error('This element does not accept src')
    const path = requiredString(normalized.src, 'patch.src')
    const source = assets[path]
    if (!source) throw new Error(`PowerPoint asset was not supplied: ${path}`)
    const asset = createPresentationAsset(current.type, source)
    createdAssets = [asset]
    normalized.sourceAssetId = asset.id
    delete normalized.src
  }
  if (shapeTypes.has(current.type) && normalized.fill !== undefined && normalized.gradientFill === undefined) {
    if (normalized.fillOpacity === undefined) normalized.fillOpacity = null
    normalized.gradientFill = null
    if (normalized.patternFill === undefined) normalized.patternFill = null
  }
  if (shapeTypes.has(current.type) && normalized.gradientFill !== undefined && normalized.patternFill === undefined) normalized.patternFill = null
  if (shapeTypes.has(current.type) && normalized.patternFill !== undefined && normalized.gradientFill === undefined) normalized.gradientFill = null
  return { assets: createdAssets, element: nullablePatch(current as unknown as Record<string, unknown>, normalized) as unknown as PresentationElement }
}

function patchPage(page: PresentationSlide, patch: Record<string, unknown>): PresentationSlide {
  assertKeys(patch, ['id', 'name', 'layout', 'background', 'notes', 'footer', 'transition'], 'page patch')
  if (patch.id !== undefined && patch.id !== page.id) throw new Error('PowerPoint page id cannot be changed')
  const direct = without(patch, ['id', 'footer', 'transition'])
  let next = nullablePatch(page as unknown as Record<string, unknown>, direct) as unknown as PresentationSlide
  if (patch.footer !== undefined) {
    next = patch.footer === null
      ? nullablePatch(next as unknown as Record<string, unknown>, { footer: null }) as unknown as PresentationSlide
      : { ...next, footer: { ...(next.footer ?? { text: '', showDate: false, showSlideNumber: false }), ...recordValue(patch.footer, 'page.footer') } }
  }
  if (patch.transition !== undefined) {
    if (patch.transition === null) throw new Error('PowerPoint page transition cannot be removed')
    next = { ...next, transition: { ...next.transition, ...recordValue(patch.transition, 'page.transition') } }
  }
  return next
}

function specificElementKeys(type: string): readonly string[] {
  if (type === 'text') return textElementKeys
  if (type === 'image') return imageElementKeys
  if (type === 'audio' || type === 'video') return mediaElementKeys
  if (type === 'table') return tableElementKeys
  if (type === 'chart') return chartElementKeys
  if (shapeTypes.has(type)) return shapeElementKeys
  throw new Error(`Unsupported PowerPoint element type: ${type}`)
}

function designPatch(value: Record<string, unknown>, document: PresentationProject): PresentationDesignPatch {
  assertKeys(value, ['theme', 'background', 'accentColors', 'titleFontFamily', 'bodyFontFamily', 'pageSize', 'title', 'footer', 'transition'], 'set-design.patch')
  if (Object.keys(value).length === 0) throw new Error('set-design.patch requires at least one property')
  if (value.footer !== undefined) recordValue(value.footer, 'set-design.patch.footer')
  if (value.transition === undefined) return value as PresentationDesignPatch
  const transition = recordValue(value.transition, 'set-design.patch.transition')
  if (Object.keys(transition).length === 0) throw new Error('set-design.patch.transition requires at least one property')
  assertKeys(transition, ['effect', 'durationMs', 'direction', 'throughBlack'], 'set-design.patch.transition')
  const selected = requirePage(document, document.slides.selectedPageId).transition
  return { ...value, transition: { ...selected, ...transition } } as PresentationDesignPatch
}

function replacePage(document: PresentationProject, page: PresentationSlide, selectedPageId: string): PresentationProject {
  return {
    ...document,
    slides: replacePresentationPages(
      document.slides,
      document.slides.pages.map((candidate) => candidate.id === page.id ? page : candidate),
      selectedPageId,
    ),
  }
}

function placeById<T extends { id: string }>(items: readonly T[], item: T, before?: string, after?: string, requirePlacement = false): T[] {
  if (before && after) throw new Error(`${item.id} cannot specify both before and after`)
  if (requirePlacement && !before && !after) throw new Error(`${item.id} requires before or after`)
  const positioned = items.filter((candidate) => candidate.id !== item.id)
  if (!before && !after) return [...positioned, item]
  const target = before ?? after!
  if (target === item.id) throw new Error(`${item.id} cannot be positioned relative to itself`)
  const index = positioned.findIndex((candidate) => candidate.id === target)
  if (index < 0) throw new Error(`Unknown PowerPoint placement target: ${target}`)
  positioned.splice(index + (after ? 1 : 0), 0, item)
  return positioned
}

function commandList(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name} must be a non-empty array`)
  return value.map((item, index) => recordValue(item, `${name}[${index}]`))
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, name)
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key))
  if (unexpected) throw new Error(`Unsupported ${name} property: ${unexpected}`)
}

function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

function nullablePatch(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

function requirePage(document: PresentationProject, pageId: string): PresentationSlide {
  const page = document.slides.pages.find((candidate) => candidate.id === pageId)
  if (!page) throw new Error(`Unknown PowerPoint page: ${pageId}`)
  return page
}
