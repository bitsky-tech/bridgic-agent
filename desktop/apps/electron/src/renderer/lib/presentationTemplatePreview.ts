import type { PresentationTemplateCandidate } from '@shared/types'
import type { PresentationPageSize, PresentationSlide } from '@/atoms/presentation'
import {
  parseLocalResourceReference,
  toLocalResourceDisplayUrl,
} from '@/components/markdown/localResource'
import { importPresentationPptx } from './presentationPptxImport'

const MAX_PREVIEW_SLIDES = 6
const MAX_PREVIEW_FILE_BYTES = 128 * 1024 * 1024
const MAX_CACHED_TEMPLATES = 12
const MAX_CONCURRENT_IMPORTS = 2

export interface PresentationTemplatePreviewPage {
  slide: PresentationSlide
  slideNumber: number
}

export interface PresentationTemplatePreviewDeck {
  pageSize: PresentationPageSize
  pages: PresentationTemplatePreviewPage[]
}

type PreviewFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const previewCache = new Map<string, Promise<PresentationTemplatePreviewDeck | null>>()
const pendingImports: Array<() => void> = []
let activeImports = 0

function drainImportQueue(): void {
  while (activeImports < MAX_CONCURRENT_IMPORTS) {
    const run = pendingImports.shift()
    if (!run) return
    activeImports += 1
    run()
  }
}

function scheduleImport<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pendingImports.push(() => {
      void operation()
        .then(resolve, reject)
        .finally(() => {
          activeImports -= 1
          drainImportQueue()
        })
    })
    drainImportQueue()
  })
}

function materializeString(candidate: PresentationTemplateCandidate, key: string): string | null {
  const value = candidate.materializeRef?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Resolve either a future remote asset URL or today's local template path. */
export function presentationTemplateSourceUrl(candidate: PresentationTemplateCandidate): string | null {
  const remote = materializeString(candidate, 'download_url') ?? materializeString(candidate, 'url')
  if (remote) {
    try {
      const url = new URL(remote)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href
    } catch {
      return null
    }
  }
  const source = materializeString(candidate, 'path')
  if (!source) return null
  const local = parseLocalResourceReference(source)
  return local ? toLocalResourceDisplayUrl(local.fileUrl) : null
}

/** Pick the cover plus the representative pages retained by the RAG index. */
export function presentationTemplatePreviewSlideNumbers(candidate: PresentationTemplateCandidate): number[] {
  const result = [1]
  const representatives = candidate.structuralEvidence?.representative_slides
  if (Array.isArray(representatives)) {
    for (const representative of representatives) {
      let slideNumber: unknown = representative
      if (representative && typeof representative === 'object' && !Array.isArray(representative)) {
        slideNumber = (representative as Record<string, unknown>).slide_number
      }
      if (
        typeof slideNumber === 'number'
        && Number.isInteger(slideNumber)
        && slideNumber >= 1
        && (candidate.slideCount == null || slideNumber <= candidate.slideCount)
        && !result.includes(slideNumber)
      ) {
        result.push(slideNumber)
      }
      if (result.length === MAX_PREVIEW_SLIDES) break
    }
  }
  return result
}

async function importTemplatePreview(
  candidate: PresentationTemplateCandidate,
  sourceUrl: string,
  fetcher: PreviewFetcher,
): Promise<PresentationTemplatePreviewDeck> {
  const response = await fetcher(sourceUrl, { cache: 'no-store' })
  if (!response.ok) throw new Error(`PowerPoint template request failed with status ${response.status}`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_FILE_BYTES) {
    throw new Error('PowerPoint template is too large to preview')
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_PREVIEW_FILE_BYTES) throw new Error('PowerPoint template is too large to preview')
  const slideNumbers = presentationTemplatePreviewSlideNumbers(candidate)
  const document = await importPresentationPptx(bytes, `${candidate.title}.pptx`, { slideNumbers })
  return {
    pageSize: document.pageSize,
    pages: document.slides.map((slide, index) => ({
      slide,
      slideNumber: slideNumbers[index] ?? index + 1,
    })),
  }
}

/** Load a bounded, read-only renderer model without touching the Session presentation atoms. */
export function loadPresentationTemplatePreview(
  candidate: PresentationTemplateCandidate,
  fetcher: PreviewFetcher = globalThis.fetch.bind(globalThis),
): Promise<PresentationTemplatePreviewDeck | null> {
  const sourceUrl = presentationTemplateSourceUrl(candidate)
  if (!sourceUrl) return Promise.resolve(null)
  const cacheKey = `${candidate.templateId}:${candidate.version}:${sourceUrl}`
  const cached = previewCache.get(cacheKey)
  if (cached) return cached
  if (previewCache.size >= MAX_CACHED_TEMPLATES) {
    const oldest = previewCache.keys().next().value
    if (typeof oldest === 'string') previewCache.delete(oldest)
  }
  const loading = scheduleImport(() => importTemplatePreview(candidate, sourceUrl, fetcher))
    .catch((error: unknown) => {
      previewCache.delete(cacheKey)
      console.warn('[presentation-template] Native preview could not be loaded', error)
      return null
    })
  previewCache.set(cacheKey, loading)
  return loading
}

/** Test and lifecycle helper; a production gallery otherwise keeps its small LRU cache. */
export function clearPresentationTemplatePreviewCache(): void {
  previewCache.clear()
}
