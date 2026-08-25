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
      title.strikethrough = true
      title.baseline = 'superscript'
      title.highlightColor = '#FFF200'
      title.characterSpacing = 100
      title.lineHeight = 1.5
      title.listStyle = 'bullet'
      title.shadow = true
    }
    document.slides[0]?.elements.push(
      {
        id: 'heart-shape',
        type: 'heart',
        x: 900,
        y: 480,
        width: 180,
        height: 160,
        rotation: 0,
        fill: '#E85D75',
        borderColor: '#B02A45',
        borderWidth: 2,
      },
      {
        id: 'double-arrow-line',
        type: 'lineDoubleArrow',
        x: 820,
        y: 650,
        width: 260,
        height: 20,
        rotation: 0,
        fill: 'transparent',
        borderColor: '#8B7CFF',
        borderWidth: 3,
      },
    )
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
    expect(firstSlideXml).toContain(' strike="sngStrike"')
    expect(firstSlideXml).toContain('<a:highlight>')
    expect(firstSlideXml).toContain('<a:buChar')
    expect(firstSlideXml).toContain(' baseline="30000"')
    expect(firstSlideXml).toContain('prst="heart"')
    expect(firstSlideXml).toContain('<a:headEnd type="arrow"')
    expect(firstSlideXml).toContain('<a:tailEnd type="arrow"')
    const firstNotesXml = await archive.file('ppt/notesSlides/notesSlide1.xml')?.async('text')
    expect(firstNotesXml).toContain('Speaker note exported from Bridgic.')
  })
})
