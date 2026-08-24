import { describe, expect, it } from 'bun:test'
import JSZip from 'jszip'
import { createInitialPresentationDocument } from '@/atoms/presentation'
import { createPresentationPptx } from '../presentationPptx'

describe('createPresentationPptx', () => {
  it('exports every slide into a valid PowerPoint Open XML archive', async () => {
    const document = createInitialPresentationDocument()
    const title = document.slides[0]?.elements.find((element) => element.type === 'text')
    if (document.slides[0]) document.slides[0].notes = 'Speaker note exported from Bridgic.'
    if (title?.type === 'text') {
      title.italic = true
      title.underline = true
    }
    const bytes = await createPresentationPptx(document)

    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4B)

    const archive = await JSZip.loadAsync(bytes)
    expect(archive.file('[Content_Types].xml')).not.toBeNull()
    expect(archive.file('ppt/presentation.xml')).not.toBeNull()
    expect(archive.file('ppt/slides/slide1.xml')).not.toBeNull()
    expect(archive.file(`ppt/slides/slide${document.slides.length}.xml`)).not.toBeNull()

    const firstSlideXml = await archive.file('ppt/slides/slide1.xml')?.async('text')
    expect(firstSlideXml).toContain(' i="1"')
    expect(firstSlideXml).toContain(' u="sng"')
    const firstNotesXml = await archive.file('ppt/notesSlides/notesSlide1.xml')?.async('text')
    expect(firstNotesXml).toContain('Speaker note exported from Bridgic.')
  })
})
