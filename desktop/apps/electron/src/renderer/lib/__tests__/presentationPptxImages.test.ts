import { describe, expect, it } from 'bun:test'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { createBlankPresentationDocument, createBlankPresentationSlide, type PresentationFileSource, type PresentationImageElement } from '@/atoms/presentation'
import { createPresentationPptx } from '../presentationPptx'
import { importPresentationPptx } from '../presentationPptxImport'

const pixel: PresentationFileSource = {
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9N8AAAAASUVORK5CYII=',
  fileName: 'pixel.png',
  mimeType: 'image/png',
}

function picture(id: string, source = pixel): PresentationImageElement {
  return { id, type: 'image', source, altText: id, fit: 'contain', x: 10, y: 20, width: 200, height: 100, rotation: 0 }
}

async function imageRelationships(archive: JSZip, slideNumber: number) {
  const xml = await archive.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)!.async('text')
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  return Array.from(document.getElementsByTagName('Relationship'))
    .filter((node) => node.getAttribute('Type')?.endsWith('/image'))
    .map((node) => ({ id: node.getAttribute('Id')!, path: node.getAttribute('Target')!.replace('../', 'ppt/') }))
}

describe('PPTX shared image export', () => {
  it('deduplicates payloads across slides while keeping distinct images, frames, crops and links', async () => {
    const differentPixel = { ...pixel, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==' }
    const document = createBlankPresentationDocument('Shared images')
    const first = document.slides[0]!
    const second = createBlankPresentationSlide('Second')
    document.slides.push(second)
    first.elements = [
      picture('original'),
      { ...picture('cropped'), crop: { left: 0.1, top: 0.2, right: 0.15, bottom: 0.05 }, x: 240, rotation: 20, flipHorizontal: true, hyperlink: { type: 'url', url: 'https://example.com' } },
      picture('different-content', differentPixel),
    ]
    second.elements = [picture('same-bytes-new-object', { ...pixel, fileName: 'renamed.png' })]
    const before = structuredClone(document)
    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    expect(document).toEqual(before)
    const media = Object.keys(archive.files).filter((name) => name.startsWith('ppt/media/') && !name.endsWith('/'))
    expect(media).toHaveLength(2)
    const firstImages = await imageRelationships(archive, 1)
    const secondImages = await imageRelationships(archive, 2)
    expect(firstImages).toHaveLength(3)
    expect(new Set(firstImages.map((image) => image.id)).size).toBe(3)
    expect(firstImages[0]!.path).toBe(firstImages[1]!.path)
    expect(firstImages[0]!.path).toBe(secondImages[0]!.path)
    expect(firstImages[2]!.path).not.toBe(firstImages[0]!.path)
    for (const [index, source] of [pixel, pixel, differentPixel].entries()) {
      expect(await archive.file(firstImages[index]!.path)!.async('base64')).toBe(source.dataUrl.split(',')[1]!)
    }
    const slideXml = await archive.file('ppt/slides/slide1.xml')!.async('text')
    expect(slideXml.match(/<p:pic>/g)).toHaveLength(3)
    expect(slideXml).toContain('flipH="1"')
    expect(slideXml).toContain('rot="1200000"')
    expect(slideXml).toContain('<a:srcRect')
    expect(slideXml).toContain('<a:hlinkClick')
    const relationships = await archive.file('ppt/slides/_rels/slide1.xml.rels')!.async('text')
    expect(relationships).toContain('https://example.com')
    const reopened = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }))
    const cropped = reopened.slides[0]!.elements[1]!
    expect(cropped.type).toBe('image')
    if (cropped.type !== 'image') throw new Error('Expected image')
    expect(cropped.crop?.left).toBeCloseTo(0.1, 3)
    expect(cropped.crop?.top).toBeCloseTo(0.2, 3)
    expect(cropped.rotation).toBeCloseTo(20, 3)
    expect(cropped.flipHorizontal).toBe(true)
    expect(reopened.slides.map((slide) => slide.elements.length)).toEqual([3, 1])
  })

  it('keeps repeated save and reopen cycles compact after editing an imported deck', async () => {
    const document = createBlankPresentationDocument('Shared backgrounds')
    document.slides = Array.from({ length: 30 }, (_, index) => ({ ...createBlankPresentationSlide(`Page ${index + 1}`), elements: [picture(`image-${index}`)] }))
    document.selectedSlideId = document.slides[0]!.id
    let bytes = await createPresentationPptx(document)
    const initialSize = bytes.length
    for (let cycle = 0; cycle < 2; cycle++) {
      const imported = await importPresentationPptx(bytes, 'shared.pptx')
      imported.slides[29]!.notes = `Edit ${cycle}`
      imported.slides[29]!.elements[0]!.x = 120 + cycle
      bytes = await createPresentationPptx(imported)
      const archive = await JSZip.loadAsync(bytes)
      const media = Object.keys(archive.files).filter((name) => name.startsWith('ppt/media/') && !name.endsWith('/'))
      expect(media).toHaveLength(1)
      for (let number = 1; number <= 30; number++) expect((await imageRelationships(archive, number))[0]!.path).toBe(media[0]!)
      expect(bytes.length).toBeLessThan(initialSize + 4096)
      const reopened = await importPresentationPptx(bytes)
      expect(reopened.slides).toHaveLength(30)
      expect(reopened.slides[29]!.notes).toContain(`Edit ${cycle}`)
      expect(reopened.slides[29]!.elements[0]!.x).toBeCloseTo(120 + cycle, 1)
    }
  })

  it('retains SVG source and PNG fallback relationships when SVG images are reused', async () => {
    const svg = (color: string): PresentationFileSource => ({ dataUrl: `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="${color}"/></svg>`)}`, fileName: 'shape.svg', mimeType: 'image/svg+xml' })
    const red = svg('red')
    const blue = svg('blue')
    const document = createBlankPresentationDocument('SVG sharing')
    document.slides[0]!.elements = [picture('red', red), picture('blue', blue)]
    document.slides.push({ ...createBlankPresentationSlide('Scaled SVG'), elements: [{ ...picture('scaled-red', { ...red }), width: 400, height: 300 }] })
    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const svgFiles = Object.keys(archive.files).filter((name) => name.startsWith('ppt/media/') && name.endsWith('.svg'))
    expect(svgFiles).toHaveLength(2)
    const images = [await imageRelationships(archive, 1), await imageRelationships(archive, 2)]
    expect(images[0]).toHaveLength(4)
    expect(images[1]).toHaveLength(2)
    expect(images[0]![1]!.path).toBe(images[1]![1]!.path)
    for (const image of images.flat()) expect(archive.file(image.path)).not.toBeNull()
    for (let number = 1; number <= 2; number++) {
      const xml = await archive.file(`ppt/slides/slide${number}.xml`)!.async('text')
      const parsed = new DOMParser().parseFromString(xml, 'application/xml')
      const ids = new Set(images[number - 1]!.map((image) => image.id))
      for (const tag of ['a:blip', 'asvg:svgBlip']) {
        const references = Array.from(parsed.getElementsByTagName(tag))
        expect(references.length).toBeGreaterThan(0)
        for (const node of references) expect(ids.has(node.getAttribute('r:embed')!)).toBe(true)
      }
    }
  })
})
