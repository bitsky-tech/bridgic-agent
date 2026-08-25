import { describe, expect, it } from 'bun:test'
import JSZip from 'jszip'
import {
  createBlankPresentationSlide,
  createInitialPresentationDocument,
  type PresentationTransition,
} from '@/atoms/presentation'
import { createPresentationPptx } from '../presentationPptx'

describe('createPresentationPptx', () => {
  async function exportTransitionSlides(transitions: PresentationTransition[]): Promise<JSZip> {
    const document = createInitialPresentationDocument()
    document.slides = transitions.map((transition, index) => ({
      ...createBlankPresentationSlide(`Transition ${index + 1}`),
      id: `transition-slide-${index + 1}`,
      transition,
    }))
    document.selectedSlideId = document.slides[0]!.id
    return JSZip.loadAsync(await createPresentationPptx(document))
  }

  async function readSlideXml(archive: JSZip, slideNumber: number): Promise<string> {
    const slide = archive.file(`ppt/slides/slide${slideNumber}.xml`)
    if (!slide) throw new Error(`Missing slide ${slideNumber}`)
    return slide.async('text')
  }

  it('exports every slide into a valid PowerPoint Open XML archive', async () => {
    const document = createInitialPresentationDocument()
    const title = document.slides[0]?.elements.find((element) => element.type === 'text')
    if (document.slides[0]) {
      document.slides[0].notes = 'Speaker note exported from Bridgic.'
      document.slides[0].transition = { effect: 'fade', durationMs: 500 }
    }
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

  it('writes standard transitions with exact duration, fallback speed, direction, and through-black options', async () => {
    const archive = await exportTransitionSlides([
      { effect: 'none', durationMs: 500 },
      { effect: 'fade', durationMs: 750, throughBlack: true },
      { effect: 'push', durationMs: 1_500, direction: 'right' },
      { effect: 'wipe', durationMs: 500, direction: 'up' },
      { effect: 'cover', durationMs: 1_000, direction: 'down' },
      { effect: 'zoom', durationMs: 600, direction: 'out' },
    ])

    const noneXml = await readSlideXml(archive, 1)
    const fadeXml = await readSlideXml(archive, 2)
    const pushXml = await readSlideXml(archive, 3)
    const wipeXml = await readSlideXml(archive, 4)
    const coverXml = await readSlideXml(archive, 5)
    const zoomXml = await readSlideXml(archive, 6)

    expect(noneXml).not.toContain('<p:transition')
    expect(noneXml).not.toContain('xmlns:p14=')
    expect(fadeXml).toContain('xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"')
    expect(fadeXml).toContain('xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"')
    expect(fadeXml).toContain('mc:Ignorable="p14"')
    expect(fadeXml).toContain('<p:transition spd="med" p14:dur="750"><p:fade thruBlk="1"/></p:transition>')
    expect(pushXml).toContain('<p:transition spd="slow" p14:dur="1500"><p:push dir="l"/></p:transition>')
    expect(wipeXml).toContain('<p:transition spd="fast" p14:dur="500"><p:wipe dir="d"/></p:transition>')
    expect(coverXml).toContain('<p:transition spd="med" p14:dur="1000"><p:cover dir="u"/></p:transition>')
    expect(zoomXml).toContain('<p:transition spd="med" p14:dur="600"><p:zoom dir="out"/></p:transition>')
    expect(fadeXml).not.toContain('<mc:AlternateContent>')
    expect(fadeXml.indexOf('</p:clrMapOvr>')).toBeLessThan(fadeXml.indexOf('<p:transition'))
    expect(fadeXml.indexOf('<p:transition')).toBeLessThan(fadeXml.indexOf('</p:sld>'))
  })

  it('normalizes a legacy cut transition to no transition instead of exporting p:cut', async () => {
    const legacyCut = { effect: 'cut', durationMs: 250, throughBlack: true } as unknown as PresentationTransition
    const archive = await exportTransitionSlides([legacyCut])
    const slideXml = await readSlideXml(archive, 1)

    expect(slideXml).not.toContain('<p:transition')
    expect(slideXml).not.toContain('<p:cut')
    expect(slideXml).not.toContain('xmlns:p14=')
  })

  it('wraps Office extension transitions with a standard fade fallback', async () => {
    const archive = await exportTransitionSlides([
      { effect: 'reveal', durationMs: 1_500, direction: 'right', throughBlack: true },
      { effect: 'flip', durationMs: 900, direction: 'left' },
      { effect: 'cube', durationMs: 500, direction: 'down' },
    ])

    const revealXml = await readSlideXml(archive, 1)
    const flipXml = await readSlideXml(archive, 2)
    const cubeXml = await readSlideXml(archive, 3)

    expect(revealXml).toContain('<mc:AlternateContent><mc:Choice Requires="p14">')
    expect(revealXml).toContain('<p:transition spd="slow" p14:dur="1500"><p14:reveal dir="l" thruBlk="1"/></p:transition>')
    expect(revealXml).toContain('<mc:Fallback><p:transition spd="slow"><p:fade thruBlk="1"/></p:transition></mc:Fallback>')
    expect(flipXml).toContain('<p:transition spd="med" p14:dur="900"><p14:flip dir="r"/></p:transition>')
    expect(flipXml).toContain('<mc:Fallback><p:transition spd="med"><p:fade/></p:transition></mc:Fallback>')
    // PowerPoint serializes the cube-style effect as the Office 2010 prism extension.
    expect(cubeXml).toContain('<p14:prism dir="u" isContent="0" isInverted="0"/>')
    expect(cubeXml).not.toContain('<p14:cube')
    expect(cubeXml).toContain('<mc:Fallback><p:transition spd="fast"><p:fade/></p:transition></mc:Fallback>')
    expect(cubeXml.indexOf('</p:clrMapOvr>')).toBeLessThan(cubeXml.indexOf('<mc:AlternateContent>'))
    expect(cubeXml.indexOf('<mc:AlternateContent>')).toBeLessThan(cubeXml.indexOf('</p:sld>'))
  })
})
