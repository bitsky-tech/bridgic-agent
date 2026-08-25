import PptxGenJS from 'pptxgenjs'
import {
  PRESENTATION_HEIGHT,
  PRESENTATION_WIDTH,
  type PresentationDocument,
} from '@/atoms/presentation'
import { getPresentationLineEnds, isPresentationLineShape } from '@/lib/presentationShapes'

const SLIDE_WIDTH_INCHES = 13.333
const SLIDE_HEIGHT_INCHES = 7.5

function withoutHash(color: string): string {
  return color.replace(/^#/, '')
}

/** Convert the renderer-owned presentation model into an Office-compatible PPTX archive. */
export async function createPresentationPptx(document: PresentationDocument): Promise<Uint8Array> {
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
  return output
}
