import {
  createBlankPresentationDocument,
  createPresentationId,
  orderPresentationPages,
  type PresentationAsset,
  type PresentationAssetKind,
  type PresentationDocument,
  type PresentationElement,
  type PresentationFileSource,
  type PresentationProject,
  type PresentationSlide,
  type PresentationTheme,
} from '@/atoms/presentation'
import { normalizePresentationTransition } from '@/lib/presentationTransitions'
import { presentationProjectSchema } from './schema'

type PresentationAssetElement = Extract<PresentationElement, { type: 'image' | 'audio' | 'video' }>

function assetSourceOf(source: PresentationFileSource): PresentationAsset['source'] {
  const { assetId: _sourceAssetId, ...assetSource } = source
  return assetSource
}

function sameAssetSource(left: PresentationAsset['source'], right: PresentationAsset['source']): boolean {
  return left.dataUrl === right.dataUrl
    && left.fileName === right.fileName
    && left.mimeType === right.mimeType
    && left.path === right.path
}

export function createPresentationAsset(kind: PresentationAssetKind, source: PresentationFileSource, id = source.assetId ?? createPresentationId('asset')): PresentationAsset {
  return { id, kind, name: source.fileName, source: assetSourceOf(source) }
}

export function isPresentationAssetElement(element: PresentationElement): element is PresentationAssetElement {
  return element.type === 'image' || element.type === 'audio' || element.type === 'video'
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
      if (existing.kind !== asset.kind || existing.name !== asset.name || !sameAssetSource(existing.source, asset.source)) {
        throw new Error(`PowerPoint asset identity collision: ${asset.id}`)
      }
      continue
    }
    merged.push(asset)
    byId.set(asset.id, asset)
  }
  return merged
}

export function presentationElementSource(project: Pick<PresentationProject, 'assets'>, element: PresentationAssetElement): PresentationFileSource | undefined {
  const asset = presentationAsset(project, element.sourceAssetId)
  return asset ? { ...asset.source, assetId: asset.id } : undefined
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

/** Strip renderer/file metadata and expose only the durable project document. */
export function presentationProjectOf(document: PresentationDocument): PresentationProject {
  const { schemaVersion, version, id, title, theme, pageSize, assets, slides } = document
  return { schemaVersion, version, id, title, theme, pageSize, assets, slides }
}

/**
 * Move legacy element-local media payloads into the project asset library.
 * New edits therefore have one source of truth even when an older checkpoint is opened.
 */
export function normalizePresentationProject(document: PresentationDocument): PresentationDocument {
  let assetsChanged = false
  const assets: PresentationAsset[] = document.assets.map((asset) => {
    const legacySource = asset.source as PresentationFileSource
    if (legacySource.assetId === undefined) return asset
    const { assetId: _sourceAssetId, ...source } = legacySource
    assetsChanged = true
    return { ...asset, source }
  })
  const pageIds = document.slides.pages.map((page) => page.id)
  const requestedOrder = document.slides.slideOrder
  const orderIsComplete = requestedOrder.length === pageIds.length
    && new Set(requestedOrder).size === requestedOrder.length
    && requestedOrder.every((pageId) => pageIds.includes(pageId))
  const sourcePages = orderIsComplete
    ? orderPresentationPages(document.slides.pages, requestedOrder)
    : document.slides.pages
  const orderChanged = sourcePages.some((page, index) => page !== document.slides.pages[index])
  let pagesChanged = false
  const pages = sourcePages.map((page) => {
    let pageChanged = false
    const elements = page.elements.map((sourceElement): PresentationElement => {
      const legacyElement = sourceElement as PresentationElement & { zIndex?: unknown }
      const { zIndex: _legacyZIndex, ...elementWithoutZIndex } = legacyElement
      const element = _legacyZIndex === undefined ? sourceElement : elementWithoutZIndex as PresentationElement
      if (_legacyZIndex !== undefined) pageChanged = true
      if (!isPresentationAssetElement(element)) return element
      const legacySource = (element as PresentationAssetElement & { source?: PresentationFileSource }).source
      let asset = presentationAsset({ assets }, element.sourceAssetId)
      if (asset && asset.kind !== element.type) throw new Error(`PowerPoint asset ${asset.id} cannot be used by a ${element.type} element`)
      if (asset && legacySource && !sameAssetSource(asset.source, assetSourceOf(legacySource))) {
        throw new Error(`PowerPoint asset identity collision: ${asset.id}`)
      }
      if (!asset && legacySource) {
        const source = assetSourceOf(legacySource)
        asset = assets.find((candidate) => candidate.kind === element.type && sameAssetSource(candidate.source, source))
        if (!asset) {
          asset = createPresentationAsset(element.type, legacySource, element.sourceAssetId)
          assets.push(asset)
        }
      }
      if (!asset) return element
      if (element.sourceAssetId === asset.id && !legacySource) return element
      const { source: _legacySource, ...rest } = element as PresentationAssetElement & { source?: PresentationFileSource }
      pageChanged = true
      return { ...rest, sourceAssetId: asset.id } as PresentationElement
    })
    if (!pageChanged) return page
    pagesChanged = true
    return { ...page, elements }
  })
  if (!pagesChanged && !assetsChanged && !orderChanged) return document
  const selectedPageId = pages.some((page) => page.id === document.slides.selectedPageId)
    ? document.slides.selectedPageId
    : pages[0]!.id
  return {
    ...document,
    assets,
    slides: {
      pages,
      slideOrder: orderIsComplete ? pages.map((page) => page.id) : document.slides.slideOrder,
      selectedPageId,
    },
  }
}

/** Upgrade the former flat PresentationDocument shape and current project checkpoints. */
export function migratePresentationDocument(value: unknown, fallbackTitle = ''): PresentationDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The PowerPoint project must be an object')
  const raw = value as Record<string, unknown>
  const hasSchemaVersion = raw.schemaVersion !== undefined
  if (hasSchemaVersion && raw.schemaVersion !== 1) throw new Error(`Unsupported PowerPoint schema version: ${String(raw.schemaVersion)}`)
  if (hasSchemaVersion && raw.version !== 1) throw new Error(`Unsupported PowerPoint project version: ${String(raw.version)}`)
  const base = createBlankPresentationDocument(typeof raw.title === 'string' ? raw.title : fallbackTitle)
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
  let legacyRevision = 1
  if (!hasSchemaVersion && typeof raw.version === 'number') legacyRevision = raw.version
  if (typeof raw.revision === 'number') legacyRevision = raw.revision
  const savedRevision = typeof raw.savedRevision === 'number'
    ? raw.savedRevision
    : raw.savedVersion
  const requestedOrder = Array.isArray(slideState?.slideOrder)
    ? slideState.slideOrder.filter((pageId): pageId is string => typeof pageId === 'string')
    : pages.map((page) => page.id)
  const document = normalizePresentationProject({
    ...base,
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    title: typeof raw.title === 'string' ? raw.title : fallbackTitle,
    theme: (raw.theme ?? raw.master ?? base.theme) as PresentationTheme,
    pageSize: (raw.pageSize ?? base.pageSize) as PresentationDocument['pageSize'],
    assets: Array.isArray(raw.assets) ? raw.assets as PresentationDocument['assets'] : [],
    slides: { pages, slideOrder: requestedOrder, selectedPageId },
    revision: Number.isFinite(legacyRevision) ? legacyRevision : 1,
    ...(raw.source && typeof raw.source === 'object' ? { source: raw.source as PresentationDocument['source'] } : {}),
    ...(typeof raw.sourceProtected === 'boolean' ? { sourceProtected: raw.sourceProtected } : {}),
    ...(typeof savedRevision === 'number' ? { savedRevision } : {}),
  })
  const parsed = presentationProjectSchema.safeParse(presentationProjectOf(document))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const location = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new Error(`Invalid PowerPoint project${location}: ${issue?.message ?? 'unknown model error'}`)
  }
  return document
}
