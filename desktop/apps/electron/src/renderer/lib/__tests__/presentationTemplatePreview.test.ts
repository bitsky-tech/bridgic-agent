import { beforeEach, describe, expect, it } from 'bun:test'
import type { PresentationTemplateCandidate } from '@shared/types'
import { createPresentationTestDocument } from '@/test-fixtures/presentation'
import { createPresentationPptx } from '../presentationPptx'
import {
  clearPresentationTemplatePreviewCache,
  loadPresentationTemplatePreview,
  presentationTemplatePreviewSlideNumbers,
  presentationTemplateSourceUrl,
} from '../presentationTemplatePreview'

function candidate(patch: Partial<PresentationTemplateCandidate> = {}): PresentationTemplateCandidate {
  return {
    templateId: 'template-preview',
    version: 'version-1',
    title: 'Preview template',
    slideCount: 12,
    semanticTags: [],
    strengths: [],
    colors: [],
    fonts: [],
    previewPaths: [],
    agenticUseForRoles: [],
    agenticRisks: [],
    materializeRef: { url: 'https://templates.example/preview.pptx' },
    ...patch,
  }
}

beforeEach(() => clearPresentationTemplatePreviewCache())

describe('presentation template renderer previews', () => {
  it('uses the cover and unique representative source pages in index order', () => {
    const slideNumbers = presentationTemplatePreviewSlideNumbers(candidate({
      structuralEvidence: {
        representative_slides: [
          { slide_number: 1 },
          { slide_number: 8 },
          { slide_number: 3 },
          { slide_number: 8 },
          { slide_number: 99 },
        ],
      },
    }))

    expect(slideNumbers).toEqual([1, 8, 3])
  })

  it('accepts a provider URL and rejects non-http remote materialization', () => {
    expect(presentationTemplateSourceUrl(candidate())).toBe('https://templates.example/preview.pptx')
    expect(presentationTemplateSourceUrl(candidate({ materializeRef: { url: 'javascript:alert(1)' } }))).toBeNull()
  })

  it('imports only the selected pages into an isolated read-only preview model', async () => {
    const source = createPresentationTestDocument()
    const first = source.slides[0]!
    const second = structuredClone(first)
    second.id = 'template-source-2'
    const third = structuredClone(first)
    third.id = 'template-source-3'
    source.slides = [first, second, third]
    source.selectedSlideId = first.id
    const bytes = await createPresentationPptx(source)
    const template = candidate({
      slideCount: 3,
      structuralEvidence: {
        representative_slides: [{ slide_number: 3 }, { slide_number: 2 }],
      },
    })
    let requests = 0

    const preview = await loadPresentationTemplatePreview(template, async () => {
      requests += 1
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      return new Response(body, { status: 200 })
    })

    expect(requests).toBe(1)
    expect(preview?.pages.map(page => page.slideNumber)).toEqual([1, 3, 2])
    expect(preview?.pages.map(page => page.slide.name)).toEqual(['Slide 1', 'Slide 3', 'Slide 2'])
    expect(source.slides).toHaveLength(3)
  })
})
