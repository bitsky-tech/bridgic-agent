import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import {
  PRESENTATION_HEIGHT,
  PRESENTATION_WIDTH,
  type PresentationDocument,
  type PresentationTransition,
  type PresentationTransitionDirection,
} from '@/atoms/presentation'
import { getPresentationLineEnds, isPresentationLineShape } from '@/lib/presentationShapes'
import { normalizePresentationTransition } from '@/lib/presentationTransitions'

const SLIDE_WIDTH_INCHES = 13.333
const SLIDE_HEIGHT_INCHES = 7.5

function withoutHash(color: string): string {
  return color.replace(/^#/, '')
}

/** Convert the renderer-owned presentation model into an Office-compatible PPTX archive. */
export async function createPresentationPptx(document: PresentationDocument): Promise<Uint8Array> {
  async function addNativeSlideTransitions(bytes: Uint8Array): Promise<Uint8Array> {
    const transitions = document.slides.map((slide) => normalizePresentationTransition(slide.transition))
    if (transitions.every((transition) => transition.effect === 'none')) return bytes

    const p14Namespace = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
    const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

    const transitionDuration = (transition: PresentationTransition): number => (
      Number.isFinite(transition.durationMs) && transition.durationMs >= 0
        ? Math.round(transition.durationMs)
        : 500
    )
    const transitionSpeed = (durationMs: number): 'fast' | 'med' | 'slow' => {
      if (durationMs <= 500) return 'fast'
      if (durationMs <= 1_000) return 'med'
      return 'slow'
    }
    const cardinalDirection = (direction?: PresentationTransitionDirection): 'l' | 'r' | 'u' | 'd' => {
      // The model stores the incoming edge ("From left"), while OOXML stores
      // the direction the slides move (right in that example).
      if (direction === 'right') return 'l'
      if (direction === 'up') return 'd'
      if (direction === 'down') return 'u'
      return 'r'
    }
    const horizontalDirection = (direction?: PresentationTransitionDirection): 'l' | 'r' => (
      direction === 'right' ? 'l' : 'r'
    )
    const throughBlackAttribute = (transition: PresentationTransition): string => (
      transition.throughBlack ? ' thruBlk="1"' : ''
    )

    const standardEffectXml = (transition: PresentationTransition): string => {
      switch (transition.effect) {
        case 'cut':
          return `<p:cut${throughBlackAttribute(transition)}/>`
        case 'fade':
          return `<p:fade${throughBlackAttribute(transition)}/>`
        case 'push':
          return `<p:push dir="${cardinalDirection(transition.direction)}"/>`
        case 'wipe':
          return `<p:wipe dir="${cardinalDirection(transition.direction)}"/>`
        case 'cover':
          return `<p:cover dir="${cardinalDirection(transition.direction)}"/>`
        case 'zoom':
          return `<p:zoom dir="${transition.direction === 'out' ? 'out' : 'in'}"/>`
        default:
          throw new Error(`Unsupported standard presentation transition: ${transition.effect}`)
      }
    }

    const extendedEffectXml = (transition: PresentationTransition): string => {
      switch (transition.effect) {
        case 'reveal':
          return `<p14:reveal dir="${horizontalDirection(transition.direction)}"${throughBlackAttribute(transition)}/>`
        case 'flip':
          return `<p14:flip dir="${horizontalDirection(transition.direction)}"/>`
        case 'cube':
          // Office exposes cube-style slide motion through p14:prism; there is no p14:cube element.
          return `<p14:prism dir="${cardinalDirection(transition.direction)}" isContent="0" isInverted="0"/>`
        default:
          throw new Error(`Unsupported extended presentation transition: ${transition.effect}`)
      }
    }

    const transitionXml = (transition: PresentationTransition): string => {
      const durationMs = transitionDuration(transition)
      const speed = transitionSpeed(durationMs)
      if (transition.effect === 'reveal' || transition.effect === 'flip' || transition.effect === 'cube') {
        const fallbackThroughBlack = transition.effect === 'reveal'
          ? throughBlackAttribute(transition)
          : ''
        return '<mc:AlternateContent>'
          + '<mc:Choice Requires="p14">'
          + `<p:transition spd="${speed}" p14:dur="${durationMs}">${extendedEffectXml(transition)}</p:transition>`
          + '</mc:Choice>'
          + '<mc:Fallback>'
          + `<p:transition spd="${speed}"><p:fade${fallbackThroughBlack}/></p:transition>`
          + '</mc:Fallback>'
          + '</mc:AlternateContent>'
      }
      return `<p:transition spd="${speed}" p14:dur="${durationMs}">${standardEffectXml(transition)}</p:transition>`
    }

    const ensureTransitionNamespaces = (xml: string): string => {
      const slideTagMatch = xml.match(/<p:sld\b[^>]*>/)
      if (!slideTagMatch || slideTagMatch.index === undefined) {
        throw new Error('PPTX exporter produced slide XML without a p:sld root element')
      }

      let slideTag = slideTagMatch[0]
      const attributes: string[] = []
      if (!/\bxmlns:p14\s*=/.test(slideTag)) attributes.push(`xmlns:p14="${p14Namespace}"`)
      if (!/\bxmlns:mc\s*=/.test(slideTag)) attributes.push(`xmlns:mc="${markupCompatibilityNamespace}"`)

      const ignorableMatch = slideTag.match(/\bmc:Ignorable=(['"])(.*?)\1/)
      if (ignorableMatch) {
        const prefixes = ignorableMatch[2]!.split(/\s+/).filter(Boolean)
        if (!prefixes.includes('p14')) {
          prefixes.push('p14')
          slideTag = slideTag.replace(ignorableMatch[0], `mc:Ignorable=${ignorableMatch[1]}${prefixes.join(' ')}${ignorableMatch[1]}`)
        }
      } else {
        attributes.push('mc:Ignorable="p14"')
      }
      if (attributes.length > 0) slideTag = slideTag.replace(/>$/, ` ${attributes.join(' ')}>`)

      const start = slideTagMatch.index
      return xml.slice(0, start) + slideTag + xml.slice(start + slideTagMatch[0].length)
    }

    const insertTransitionXml = (xml: string, transitionMarkup: string): string => {
      const commonSlideEnd = xml.indexOf('</p:cSld>')
      if (commonSlideEnd < 0) {
        throw new Error('PPTX exporter produced slide XML without a closing p:cSld element')
      }

      const tailStart = commonSlideEnd + '</p:cSld>'.length
      const tail = xml.slice(tailStart)
      const insertionOffsets = ['<p:timing', '<p:extLst', '</p:sld>']
        .map((marker) => tail.indexOf(marker))
        .filter((offset) => offset >= 0)
      if (insertionOffsets.length === 0) {
        throw new Error('PPTX exporter produced slide XML without a valid transition insertion point')
      }
      const insertionPoint = tailStart + Math.min(...insertionOffsets)
      return xml.slice(0, insertionPoint) + transitionMarkup + xml.slice(insertionPoint)
    }

    const archive = await JSZip.loadAsync(bytes)
    await Promise.all(transitions.map(async (transition, index) => {
      if (transition.effect === 'none') return
      const slidePath = `ppt/slides/slide${index + 1}.xml`
      const slideFile = archive.file(slidePath)
      if (!slideFile) throw new Error(`PPTX exporter did not create ${slidePath}`)
      const xml = await slideFile.async('text')
      const namespacedXml = ensureTransitionNamespaces(xml)
      archive.file(slidePath, insertTransitionXml(namespacedXml, transitionXml(transition)))
    }))
    return archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  }

  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Bridgic'
  pptx.company = 'Bridgic'
  pptx.subject = document.title
  pptx.title = document.title
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
  }

  const x = (pixels: number) => (pixels / PRESENTATION_WIDTH) * SLIDE_WIDTH_INCHES
  const y = (pixels: number) => (pixels / PRESENTATION_HEIGHT) * SLIDE_HEIGHT_INCHES

  for (const sourceSlide of document.slides) {
    const slide = pptx.addSlide()
    slide.background = { color: withoutHash(sourceSlide.background) }
    if (sourceSlide.notes?.trim()) slide.addNotes(sourceSlide.notes)
    for (const element of sourceSlide.elements) {
      if (element.type === 'text') {
        let bullet: true | { type: 'number'; numberType: 'arabicPeriod' } | undefined
        if (element.listStyle === 'bullet') bullet = true
        else if (element.listStyle === 'number') bullet = { type: 'number', numberType: 'arabicPeriod' }
        slide.addText(element.text, {
          x: x(element.x),
          y: y(element.y),
          w: x(element.width),
          h: y(element.height),
          rotate: element.rotation,
          margin: 0,
          breakLine: false,
          valign: 'middle',
          align: element.align,
          bold: element.fontWeight >= 600,
          italic: Boolean(element.italic),
          underline: element.underline ? { style: 'sng' } : undefined,
          strike: Boolean(element.strikethrough),
          superscript: element.baseline === 'superscript',
          subscript: element.baseline === 'subscript',
          highlight: element.highlightColor ? withoutHash(element.highlightColor) : undefined,
          charSpacing: element.characterSpacing,
          lineSpacingMultiple: element.lineHeight,
          bullet,
          indentLevel: element.listStyle && element.listStyle !== 'none' ? element.indentLevel ?? 0 : undefined,
          color: withoutHash(element.color),
          fontFace: element.fontFamily,
          fontSize: element.fontSize,
          fit: 'shrink',
          shadow: element.shadow
            ? { type: 'outer', color: '20202B', opacity: 0.28, blur: 3, angle: 45, offset: 2 }
            : undefined,
        })
        continue
      }
      let shapeType: PptxGenJS.ShapeType
      if (isPresentationLineShape(element.type)) shapeType = pptx.ShapeType.line
      else if (element.type === 'rect' && (element.radius ?? 0) > 0) shapeType = pptx.ShapeType.roundRect
      else shapeType = pptx.ShapeType[element.type as keyof typeof pptx.ShapeType]
      const lineShape = isPresentationLineShape(element.type)
      slide.addShape(
        shapeType,
        {
          x: x(element.x),
          y: y(element.y),
          w: x(element.width),
          h: y(element.height),
          rotate: element.rotation,
          fill: lineShape ? { color: 'FFFFFF', transparency: 100 } : { color: withoutHash(element.fill) },
          line: {
            color: withoutHash(element.borderColor),
            width: lineShape ? Math.max(1, element.borderWidth) : element.borderWidth,
            transparency: !lineShape && element.borderWidth === 0 ? 100 : 0,
            ...getPresentationLineEnds(element.type),
          },
          shadow: element.shadow
            ? { type: 'outer', color: '20202B', opacity: 0.22, blur: 3, angle: 45, offset: 2 }
            : undefined,
        },
      )
    }
  }

  const output = await pptx.write({ outputType: 'uint8array', compression: true })
  if (!(output instanceof Uint8Array)) {
    throw new Error('PPTX exporter returned an unexpected output type')
  }
  return addNativeSlideTransitions(output)
}
