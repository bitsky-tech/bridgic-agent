import {
  createBlankPresentationProject,
  createPresentationId,
  orderPresentationPages,
  type PresentationAsset,
  type PresentationAssetKind,
  type PresentationElement,
  type PresentationFileSource,
  type PresentationProject,
  type PresentationSlide,
  type PresentationTheme,
} from '@/atoms/presentation'
import { normalizePresentationTransition } from '@/lib/presentationTransitions'
import { presentationProjectSchema } from './schema'
import { resolvedPresentationSource } from './sources'

type PresentationAssetElement = Extract<PresentationElement, { type: 'image' | 'audio' | 'video' }> | (Extract<PresentationElement, { type: 'text' }> & { sourceAssetId: string })

function sameAssetSource(left: PresentationAsset, right: PresentationAsset): boolean {
  return left.source === right.source && left.mimeType === right.mimeType
}

export function createPresentationAsset(kind: PresentationAssetKind, source: PresentationFileSource, id = source.assetId ?? createPresentationId('asset')): PresentationAsset {
  return { id, kind, mimeType: source.mimeType, name: source.fileName, source: source.source ?? source.path ?? source.dataUrl }
}

export function isPresentationAssetElement(element: PresentationElement): element is PresentationAssetElement {
  return element.type === 'image' || element.type === 'audio' || element.type === 'video' || (element.type === 'text' && Boolean(element.sourceAssetId))
}

export function presentationAsset(project: Pick<PresentationProject, 'assets'>, assetId: string | undefined): PresentationAsset | undefined {
  return assetId ? project.assets.find((asset) => asset.id === assetId) : undefined
}

export function mergePresentationAssets(current: readonly PresentationAsset[], incoming: readonly PresentationAsset[]): PresentationAsset[] {
  const merged = [...current]
  const byId = new Map(merged.map((asset) => [asset.id, asset]))
  for (const asset of incoming) {
    const existing = byId.get(asset.id)
    if (existing) {
      if (existing.kind !== asset.kind || existing.name !== asset.name || !sameAssetSource(existing, asset)) {
        throw new Error(`PowerPoint asset identity collision: ${asset.id}`)
      }
      continue
    }
    merged.push(asset)
    byId.set(asset.id, asset)
  }
  return merged
}

export function presentationElementSource(project: Pick<PresentationProject, 'assets'>, element: PresentationAssetElement, sources: Readonly<Record<string, string>> = {}): PresentationFileSource | undefined {
  const asset = presentationAsset(project, element.sourceAssetId)
  return resolvedPresentationSource(asset, sources)
}

/** Build a bounded asset collection for an explicitly selected page subset. */
export function presentationAssetsForPages(assets: readonly PresentationAsset[], pages: readonly PresentationSlide[]): PresentationAsset[] {
  const referencedAssetIds = new Set(pages.flatMap((page) => page.elements.flatMap((element) => (
    isPresentationAssetElement(element) && element.sourceAssetId ? [element.sourceAssetId] : []
  ))))
  return assets.filter((asset) => referencedAssetIds.has(asset.id))
}

/** Keep review comments valid when their target elements are removed. */
export function detachPresentationCommentsFromElements(slide: PresentationSlide, removedElementIds: ReadonlySet<string>): PresentationSlide {
  if (!slide.comments?.some((comment) => comment.elementId && removedElementIds.has(comment.elementId))) return slide
  return {
    ...slide,
    comments: slide.comments.map((comment) => {
      if (!comment.elementId || !removedElementIds.has(comment.elementId)) return comment
      const { elementId: _removedElementId, ...detached } = comment
      return detached
    }),
  }
}

/** Remove internal links that would otherwise point at deleted pages. */
export function clearPresentationHyperlinksToPages(pages: readonly PresentationSlide[], removedPageIds: ReadonlySet<string>): PresentationSlide[] {
  return pages.map((page) => {
    let changed = false
    const elements = page.elements.map((element): PresentationElement => {
      if (element.hyperlink?.type !== 'slide' || !removedPageIds.has(element.hyperlink.slideId)) return element
      const { hyperlink: _removedHyperlink, ...rest } = element
      changed = true
      return rest as PresentationElement
    })
    return changed ? { ...page, elements } : page
  })
}

/** Clone one page with independent element and comment identities. */
export function duplicatePresentationSlide(slide: PresentationSlide, name: string): PresentationSlide {
  const elementIds = new Map(slide.elements.map((element) => [element.id, createPresentationId(element.type)]))
  const comments = slide.comments?.map((comment) => {
    const { id: _sourceCommentId, elementId, ...rest } = comment
    const duplicatedElementId = elementId ? elementIds.get(elementId) : undefined
    return {
      ...rest,
      id: createPresentationId('comment'),
      ...(duplicatedElementId ? { elementId: duplicatedElementId } : {}),
    }
  })
  return {
    ...slide,
    id: createPresentationId('slide'),
    name,
    elements: slide.elements.map((element) => ({ ...element, id: elementIds.get(element.id)! })),
    ...(comments ? { comments } : {}),
  }
}

/** Return a durable project value without retaining fields from legacy envelopes. */
export function presentationProjectOf(project: PresentationProject): PresentationProject {
  const projectKeys = ['schemaVersion', 'version', 'id', 'title', 'theme', 'pageSize', 'assets', 'slides'] as const
  const sourceKeys = Object.keys(project)
  if (sourceKeys.length === projectKeys.length && sourceKeys.every((key) => (projectKeys as readonly string[]).includes(key))) {
    return project
  }
  const { schemaVersion, version, id, title, theme, pageSize, assets, slides } = project
  return { schemaVersion, version, id, title, theme, pageSize, assets, slides }
}

/** Normalize ordering and remove obsolete rendering-only fields. */
export function normalizePresentationProject(project: PresentationProject): PresentationProject {
  const pageIds = project.slides.pages.map((page) => page.id)
  const requestedOrder = project.slides.slideOrder
  const orderIsComplete = requestedOrder.length === pageIds.length
    && new Set(requestedOrder).size === requestedOrder.length
    && requestedOrder.every((pageId) => pageIds.includes(pageId))
  const sourcePages = orderIsComplete
    ? orderPresentationPages(project.slides.pages, requestedOrder)
    : project.slides.pages
  const orderChanged = sourcePages.some((page, index) => page !== project.slides.pages[index])
  let pagesChanged = false
  const pages = sourcePages.map((page) => {
    let pageChanged = false
    const elements = page.elements.map((sourceElement): PresentationElement => {
      const legacyElement = sourceElement as PresentationElement & { zIndex?: unknown }
      const { zIndex: _legacyZIndex, ...elementWithoutZIndex } = legacyElement
      const element = _legacyZIndex === undefined ? sourceElement : elementWithoutZIndex as PresentationElement
      if (_legacyZIndex !== undefined) pageChanged = true
      if (!isPresentationAssetElement(element)) return element
      const asset = presentationAsset(project, element.sourceAssetId)
      if (asset && asset.kind !== element.type) throw new Error(`PowerPoint asset ${asset.id} cannot be used by a ${element.type} element`)
      return element
    })
    if (!pageChanged) return page
    pagesChanged = true
    return { ...page, elements }
  })
  if (!pagesChanged && !orderChanged) return project
  const selectedPageId = pages.some((page) => page.id === project.slides.selectedPageId)
    ? project.slides.selectedPageId
    : pages[0]!.id
  return {
    ...project,
    slides: {
      pages,
      slideOrder: orderIsComplete ? pages.map((page) => page.id) : project.slides.slideOrder,
      selectedPageId,
    },
  }
}

/** Upgrade the former flat PresentationProject shape and validate current projects. */
export function migratePresentationProject(value: unknown, fallbackTitle = ''): PresentationProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The PowerPoint project must be an object')
  const raw = value as Record<string, unknown>
  const hasSchemaVersion = raw.schemaVersion !== undefined
  if (hasSchemaVersion && raw.schemaVersion !== 1) throw new Error(`Unsupported PowerPoint schema version: ${String(raw.schemaVersion)}`)
  if (hasSchemaVersion && raw.version !== 1) throw new Error(`Unsupported PowerPoint project version: ${String(raw.version)}`)
  const base = createBlankPresentationProject(typeof raw.title === 'string' ? raw.title : fallbackTitle)
  const rawSlides = raw.slides
  let pages = base.slides.pages
  if (!hasSchemaVersion && Array.isArray(rawSlides)) pages = rawSlides as PresentationSlide[]
  else if (hasSchemaVersion && rawSlides && typeof rawSlides === 'object' && Array.isArray((rawSlides as { pages?: unknown }).pages)) {
    pages = (rawSlides as { pages: PresentationSlide[] }).pages
  } else {
    throw new Error('The PowerPoint project has an unsupported slide collection')
  }
  if (!pages.length) throw new Error('A PowerPoint project must keep at least one page')
  pages = pages.map((page) => ({ ...page, transition: normalizePresentationTransition(page.transition) }))
  const slideState = hasSchemaVersion && rawSlides && !Array.isArray(rawSlides) && typeof rawSlides === 'object'
    ? rawSlides as { selectedPageId?: unknown; slideOrder?: unknown }
    : null
  let requestedSelection = pages[0]!.id
  if (typeof raw.selectedSlideId === 'string') requestedSelection = raw.selectedSlideId
  if (typeof slideState?.selectedPageId === 'string') requestedSelection = slideState.selectedPageId
  const selectedPageId = pages.some((page) => page.id === requestedSelection) ? requestedSelection : pages[0]!.id
  const requestedOrder = Array.isArray(slideState?.slideOrder)
    ? slideState.slideOrder.filter((pageId): pageId is string => typeof pageId === 'string')
    : pages.map((page) => page.id)
  const project = normalizePresentationProject({
    ...base,
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    title: typeof raw.title === 'string' ? raw.title : fallbackTitle,
    theme: (raw.theme ?? raw.master ?? base.theme) as PresentationTheme,
    pageSize: (raw.pageSize ?? base.pageSize) as PresentationProject['pageSize'],
    assets: Array.isArray(raw.assets) ? raw.assets as PresentationProject['assets'] : [],
    slides: { pages, slideOrder: requestedOrder, selectedPageId },
  })
  const parsed = presentationProjectSchema.safeParse(presentationProjectOf(project))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const location = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new Error(`Invalid PowerPoint project${location}: ${issue?.message ?? 'unknown model error'}`)
  }
  return project
}
