import JSZip from 'jszip'
import { DOMParser as XmldomParser } from '@xmldom/xmldom'
import {
  DEFAULT_PRESENTATION_MASTER,
  PRESENTATION_PAGE_SIZES,
  createPresentationId,
  type PresentationDocument,
  type PresentationElement,
  type PresentationPageSize,
  type PresentationImageElement,
  type PresentationShapeElement,
  type PresentationShapeType,
  type PresentationSlide,
  type PresentationTableElement,
  type PresentationChartElement,
  type PresentationTextElement,
  type PresentationTransition,
} from '@/atoms/presentation'
import { getPresentationShapeDefinition, isSupportedPresentationShapeType } from '@/lib/presentationShapes'
import {
  presentationCharacterSpacingFromPoints,
  presentationFontSizeFromPoints,
  presentationTextUsesCjk,
} from '@/lib/presentationText'
import { createDefaultPresentationTransition } from '@/lib/presentationTransitions'

const EMU_PER_INCH = 914_400
const SLIDE_HEIGHT_PX = 720

function elementsByLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((element) => element.localName === name)
}

function firstByLocalName(root: Document | Element, name: string): Element | null {
  return elementsByLocalName(root, name)[0] ?? null
}

function directChildrenByLocalName(root: Element, name: string): Element[] {
  return Array.from(root.childNodes).filter((node): node is Element => (
    node.nodeType === 1 && (node as Element).localName === name
  ))
}

function parseXml(xml: string): Document {
  const Parser = XmldomParser as unknown as typeof DOMParser
  const parsed = new Parser().parseFromString(xml, 'application/xml')
  if (elementsByLocalName(parsed, 'parsererror').length > 0) throw new Error('Invalid PowerPoint XML')
  return parsed
}

function resolveOpcPath(sourcePath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = `${sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1)}${target}`.split('/')
  const normalized: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  return normalized.join('/')
}

function relationshipPath(sourcePath: string): string {
  const separator = sourcePath.lastIndexOf('/')
  const directory = separator >= 0 ? sourcePath.slice(0, separator + 1) : ''
  const fileName = sourcePath.slice(separator + 1)
  return `${directory}_rels/${fileName}.rels`
}

async function relationshipTargets(archive: JSZip, sourcePath: string): Promise<Map<string, string>> {
  const file = archive.file(relationshipPath(sourcePath))
  if (!file) return new Map()
  const document = parseXml(await file.async('text'))
  return new Map(elementsByLocalName(document, 'Relationship').flatMap((relationship) => {
    const id = relationship.getAttribute('Id')
    const target = relationship.getAttribute('Target')
    return id && target ? [[id, resolveOpcPath(sourcePath, target)] as const] : []
  }))
}

async function themeColorsFromArchive(archive: JSZip): Promise<Map<string, string>> {
  const themePath = Object.keys(archive.files).find((path) => /^ppt\/theme\/theme\d+\.xml$/i.test(path))
  const themeFile = themePath ? archive.file(themePath) : null
  if (!themeFile) return new Map(defaultThemeColors)
  const document = parseXml(await themeFile.async('text'))
  const scheme = firstByLocalName(document, 'clrScheme')
  const colors = new Map(defaultThemeColors)
  if (!scheme) return colors
  for (const node of Array.from(scheme.childNodes)) {
    if (node.nodeType !== 1) continue
    const colorNode = node as Element
    const value = colorFrom(colorNode, '', colors).replace(/^#/, '')
    if (/^[\dA-F]{6}$/i.test(value)) colors.set(colorNode.localName, value.toUpperCase())
  }
  return colors
}

function numberAttribute(element: Element | null, name: string, fallback = 0): number {
  const parsed = Number(element?.getAttribute(name))
  return Number.isFinite(parsed) ? parsed : fallback
}

interface ImportedColor {
  color: string
  opacity: number
}

interface CoordinateTransform {
  scaleX: number
  scaleY: number
  translateX: number
  translateY: number
  rotation: number
}

const ROOT_COORDINATE_TRANSFORM: CoordinateTransform = {
  scaleX: 1,
  scaleY: 1,
  translateX: 0,
  translateY: 0,
  rotation: 0,
}

const defaultThemeColors = new Map<string, string>([
  ['dk1', '000000'], ['lt1', 'FFFFFF'], ['dk2', '1F1F1F'], ['lt2', 'E7E6E6'],
  ['accent1', '4472C4'], ['accent2', 'ED7D31'], ['accent3', 'A5A5A5'],
  ['accent4', 'FFC000'], ['accent5', '5B9BD5'], ['accent6', '70AD47'],
  ['hlink', '0563C1'], ['folHlink', '954F72'], ['tx1', '000000'], ['bg1', 'FFFFFF'],
  ['tx2', '1F1F1F'], ['bg2', 'E7E6E6'],
])

function colorFrom(root: Element | null, fallback: string, themeColors: ReadonlyMap<string, string> = defaultThemeColors): string {
  if (!root) return fallback
  const srgb = firstByLocalName(root, 'srgbClr')?.getAttribute('val')
  if (srgb && /^[\dA-F]{6}$/i.test(srgb)) return `#${srgb.toUpperCase()}`
  const system = firstByLocalName(root, 'sysClr')?.getAttribute('lastClr')
  if (system && /^[\dA-F]{6}$/i.test(system)) return `#${system.toUpperCase()}`
  const scheme = firstByLocalName(root, 'schemeClr')?.getAttribute('val')
  const themed = scheme ? themeColors.get(scheme) : null
  return themed && /^[\dA-F]{6}$/i.test(themed) ? `#${themed.toUpperCase()}` : fallback
}

function opacityFrom(root: Element | null): number {
  if (!root) return 1
  const alpha = firstByLocalName(root, 'alpha')
  const alphaMod = firstByLocalName(root, 'alphaModFix')
  const raw = alpha?.getAttribute('val') ?? alphaMod?.getAttribute('amt')
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed / 100_000)) : 1
}

function importedColorFrom(root: Element | null, fallback: string, themeColors: ReadonlyMap<string, string> = defaultThemeColors): ImportedColor {
  const colorRoot = root ? firstByLocalName(root, 'solidFill') ?? root : null
  const colorNode = colorRoot
    ? firstByLocalName(colorRoot, 'srgbClr') ?? firstByLocalName(colorRoot, 'sysClr') ?? firstByLocalName(colorRoot, 'schemeClr')
    : null
  return {
    color: colorFrom(colorRoot, fallback, themeColors),
    opacity: opacityFrom(colorNode),
  }
}

function textAlignmentFrom(value: string | null | undefined): PresentationTextElement['align'] {
  if (value === 'ctr') return 'center'
  if (value === 'r') return 'right'
  if (value === 'just') return 'justify'
  return 'left'
}

function transitionDurationFallback(speed: string | null): number {
  if (speed === 'fast') return 500
  if (speed === 'slow') return 2_000
  return 1_000
}

function transitionDirectionFrom(value: string | null): PresentationTransition['direction'] {
  if (value === 'l') return 'left'
  if (value === 'r') return 'right'
  if (value === 'u') return 'up'
  if (value === 'd') return 'down'
  return undefined
}

function animationStartFrom(value: string | null): PresentationElement['animationStart'] {
  if (value === 'withEffect') return 'withPrevious'
  if (value === 'afterEffect') return 'afterPrevious'
  return 'onClick'
}

function pageSizeFrom(presentation: Document): PresentationPageSize {
  const size = firstByLocalName(presentation, 'sldSz')
  const width = numberAttribute(size, 'cx', 13.333 * EMU_PER_INCH)
  const height = numberAttribute(size, 'cy', 7.5 * EMU_PER_INCH)
  const ratio = width / Math.max(1, height)
  if (Math.abs(ratio - (4 / 3)) < 0.04) return { ...PRESENTATION_PAGE_SIZES.standard }
  if (Math.abs(ratio - (16 / 9)) < 0.04) return { ...PRESENTATION_PAGE_SIZES.wide }
  return {
    height: SLIDE_HEIGHT_PX,
    preset: ratio < 1.55 ? 'standard' : 'wide',
    width: Math.max(320, Math.round(SLIDE_HEIGHT_PX * ratio)),
  }
}

function shapeGeometry(
  shape: Element,
  pageSize: PresentationPageSize,
  slideSizeEmu: { width: number; height: number },
  coordinateTransform = ROOT_COORDINATE_TRANSFORM,
  fallbackShape?: Element,
) {
  const shapeProperties = directChildrenByLocalName(shape, 'spPr')[0] ?? firstByLocalName(shape, 'spPr')
  const ownTransform = shapeProperties ? firstByLocalName(shapeProperties, 'xfrm') : firstByLocalName(shape, 'xfrm')
  const fallbackProperties = fallbackShape
    ? directChildrenByLocalName(fallbackShape, 'spPr')[0] ?? firstByLocalName(fallbackShape, 'spPr')
    : null
  const transform = ownTransform ?? (fallbackProperties ? firstByLocalName(fallbackProperties, 'xfrm') : null)
  const offset = transform ? firstByLocalName(transform, 'off') : null
  const extent = transform ? firstByLocalName(transform, 'ext') : null
  const scaleX = pageSize.width / slideSizeEmu.width
  const scaleY = pageSize.height / slideSizeEmu.height
  const sourceX = numberAttribute(offset, 'x')
  const sourceY = numberAttribute(offset, 'y')
  const sourceWidth = numberAttribute(extent, 'cx', EMU_PER_INCH)
  const sourceHeight = numberAttribute(extent, 'cy', EMU_PER_INCH)
  return {
    x: Math.round((sourceX * coordinateTransform.scaleX + coordinateTransform.translateX) * scaleX),
    y: Math.round((sourceY * coordinateTransform.scaleY + coordinateTransform.translateY) * scaleY),
    width: Math.max(8, Math.round(sourceWidth * coordinateTransform.scaleX * scaleX)),
    height: Math.max(8, Math.round(sourceHeight * coordinateTransform.scaleY * scaleY)),
    rotation: Math.round(numberAttribute(transform, 'rot') / 60_000 + coordinateTransform.rotation),
  }
}

function shapeTypeFrom(shape: Element): PresentationShapeType {
  const preset = firstByLocalName(shape, 'prstGeom')?.getAttribute('prst')
  if (shape.localName === 'cxnSp') {
    if (preset?.startsWith('bentConnector')) return 'elbowConnector'
    if (preset?.startsWith('curvedConnector')) return 'curvedConnector'
    return 'line'
  }
  return preset && isSupportedPresentationShapeType(preset) ? preset : 'rect'
}

function textFrom(
  shape: Element,
  geometry: ReturnType<typeof shapeGeometry>,
  pageSize: PresentationPageSize,
  slideSizeEmu: { width: number; height: number },
  themeColors: ReadonlyMap<string, string>,
  fallbackShape?: Element,
): PresentationTextElement | null {
  const textBody = directChildrenByLocalName(shape, 'txBody')[0] ?? firstByLocalName(shape, 'txBody')
  if (!textBody) return null
  const paragraphs = elementsByLocalName(textBody, 'p').map((paragraph) => (
    elementsByLocalName(paragraph, 't').map((text) => text.textContent ?? '').join('')
  ))
  const text = paragraphs.join('\n')
  if (!text) return null
  const fallbackTextBody = fallbackShape
    ? directChildrenByLocalName(fallbackShape, 'txBody')[0] ?? firstByLocalName(fallbackShape, 'txBody')
    : null
  const runProperties = firstByLocalName(textBody, 'rPr')
    ?? firstByLocalName(textBody, 'defRPr')
    ?? firstByLocalName(textBody, 'endParaRPr')
    ?? (fallbackTextBody ? firstByLocalName(fallbackTextBody, 'rPr') ?? firstByLocalName(fallbackTextBody, 'defRPr') ?? firstByLocalName(fallbackTextBody, 'endParaRPr') : null)
  const paragraphProperties = firstByLocalName(textBody, 'pPr') ?? (fallbackTextBody ? firstByLocalName(fallbackTextBody, 'pPr') : null)
  const bodyProperties = directChildrenByLocalName(textBody, 'bodyPr')[0]
    ?? firstByLocalName(textBody, 'bodyPr')
    ?? (fallbackTextBody ? firstByLocalName(fallbackTextBody, 'bodyPr') : null)
  const fontSizePoints = Math.max(6, numberAttribute(runProperties, 'sz', 1_800) / 100)
  const fontSize = presentationFontSizeFromPoints(fontSizePoints)
  const weight = runProperties?.getAttribute('b') === '1' ? 700 : 400
  const alignment = paragraphProperties?.getAttribute('algn')
  const latinTypeface = firstByLocalName(runProperties ?? textBody, 'latin')?.getAttribute('typeface')
  const eastAsianTypeface = firstByLocalName(runProperties ?? textBody, 'ea')?.getAttribute('typeface')
  const typeface = presentationTextUsesCjk(text)
    ? eastAsianTypeface || latinTypeface
    : latinTypeface || eastAsianTypeface
  const lineSpacingPercent = numberAttribute(firstByLocalName(firstByLocalName(paragraphProperties ?? textBody, 'lnSpc') ?? textBody, 'spcPct'), 'val', 0)
  const characterSpacing = presentationCharacterSpacingFromPoints(
    numberAttribute(runProperties, 'spc', 0) / 100,
    fontSizePoints,
  )
  const baselineValue = numberAttribute(runProperties, 'baseline', 0)
  const fontReference = firstByLocalName(firstByLocalName(shape, 'style') ?? shape, 'fontRef')
  const importedColor = importedColorFrom(firstByLocalName(runProperties ?? textBody, 'solidFill') ?? fontReference, '#1D1D28', themeColors)
  const scaleX = pageSize.width / slideSizeEmu.width
  const scaleY = pageSize.height / slideSizeEmu.height
  const hasInsets = ['lIns', 'tIns', 'rIns', 'bIns'].some((name) => bodyProperties?.hasAttribute(name))
  const anchor = bodyProperties?.getAttribute('anchor')
  let verticalAlign: PresentationTextElement['verticalAlign']
  if (anchor === 'ctr') verticalAlign = 'middle'
  else if (anchor === 'b') verticalAlign = 'bottom'
  else verticalAlign = 'top'
  let listStyle: PresentationTextElement['listStyle'] = 'none'
  if (paragraphProperties && firstByLocalName(paragraphProperties, 'buAutoNum')) listStyle = 'number'
  else if (paragraphProperties && firstByLocalName(paragraphProperties, 'buChar')) listStyle = 'bullet'
  let baseline: PresentationTextElement['baseline'] | undefined
  if (baselineValue > 0) baseline = 'superscript'
  else if (baselineValue < 0) baseline = 'subscript'
  return {
    id: createPresentationId('text'),
    type: 'text',
    ...geometry,
    text,
    fontSize,
    fontFamily: typeface && !typeface.startsWith('+m') ? typeface : 'Aptos',
    fontWeight: weight,
    italic: runProperties?.getAttribute('i') === '1',
    underline: Boolean(runProperties?.getAttribute('u') && runProperties?.getAttribute('u') !== 'none'),
    strikethrough: Boolean(runProperties?.getAttribute('strike') && runProperties?.getAttribute('strike') !== 'noStrike'),
    shadow: Boolean(firstByLocalName(runProperties ?? textBody, 'outerShdw')),
    color: importedColor.color,
    ...(importedColor.opacity < 1 ? { opacity: importedColor.opacity } : {}),
    align: textAlignmentFrom(alignment),
    verticalAlign,
    wordWrap: bodyProperties?.getAttribute('wrap') !== 'none',
    ...(hasInsets ? {
      textInsets: {
        left: numberAttribute(bodyProperties, 'lIns') * scaleX,
        top: numberAttribute(bodyProperties, 'tIns') * scaleY,
        right: numberAttribute(bodyProperties, 'rIns') * scaleX,
        bottom: numberAttribute(bodyProperties, 'bIns') * scaleY,
      },
    } : {}),
    ...(lineSpacingPercent > 0 ? { lineHeight: lineSpacingPercent / 100_000 } : {}),
    ...(characterSpacing ? { characterSpacing } : {}),
    ...(baseline ? { baseline } : {}),
    ...(listStyle !== 'none' ? { listStyle, indentLevel: Math.max(0, numberAttribute(paragraphProperties, 'lvl', 0)) } : {}),
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
}

function customPathData(path: Element): string {
  const commands: string[] = []
  let currentX = 0
  let currentY = 0
  const point = (root: Element): { x: number; y: number } => {
    const target = firstByLocalName(root, 'pt')
    return { x: numberAttribute(target, 'x'), y: numberAttribute(target, 'y') }
  }
  for (const node of Array.from(path.childNodes)) {
    if (node.nodeType !== 1) continue
    const command = node as Element
    if (command.localName === 'moveTo') {
      const target = point(command)
      currentX = target.x
      currentY = target.y
      commands.push(`M ${target.x} ${target.y}`)
    } else if (command.localName === 'lnTo') {
      const target = point(command)
      currentX = target.x
      currentY = target.y
      commands.push(`L ${target.x} ${target.y}`)
    } else if (command.localName === 'cubicBezTo') {
      const targets = elementsByLocalName(command, 'pt').map((target) => ({
        x: numberAttribute(target, 'x'),
        y: numberAttribute(target, 'y'),
      }))
      if (targets.length >= 3) {
        currentX = targets[2]!.x
        currentY = targets[2]!.y
        commands.push(`C ${targets[0]!.x} ${targets[0]!.y} ${targets[1]!.x} ${targets[1]!.y} ${targets[2]!.x} ${targets[2]!.y}`)
      }
    } else if (command.localName === 'quadBezTo') {
      const targets = elementsByLocalName(command, 'pt').map((target) => ({
        x: numberAttribute(target, 'x'),
        y: numberAttribute(target, 'y'),
      }))
      if (targets.length >= 2) {
        currentX = targets[1]!.x
        currentY = targets[1]!.y
        commands.push(`Q ${targets[0]!.x} ${targets[0]!.y} ${targets[1]!.x} ${targets[1]!.y}`)
      }
    } else if (command.localName === 'arcTo') {
      const radiusX = numberAttribute(command, 'wR')
      const radiusY = numberAttribute(command, 'hR')
      const start = numberAttribute(command, 'stAng') / 60_000 * Math.PI / 180
      const sweepDegrees = numberAttribute(command, 'swAng') / 60_000
      const end = start + sweepDegrees * Math.PI / 180
      const centerX = currentX - Math.cos(start) * radiusX
      const centerY = currentY - Math.sin(start) * radiusY
      currentX = centerX + Math.cos(end) * radiusX
      currentY = centerY + Math.sin(end) * radiusY
      commands.push(`A ${radiusX} ${radiusY} 0 ${Math.abs(sweepDegrees) > 180 ? 1 : 0} ${sweepDegrees >= 0 ? 1 : 0} ${currentX} ${currentY}`)
    } else if (command.localName === 'close') commands.push('Z')
  }
  return commands.join(' ')
}

function svgGradientFrom(gradient: Element, themeColors: ReadonlyMap<string, string>): { defs: string; paint: string } {
  const stops = elementsByLocalName(gradient, 'gs').map((stop, index) => {
    const imported = importedColorFrom(stop, index === 0 ? '#000000' : '#FFFFFF', themeColors)
    const position = Math.max(0, Math.min(100, numberAttribute(stop, 'pos') / 1000))
    return `<stop offset="${position}%" stop-color="${xmlEscape(imported.color)}" stop-opacity="${imported.opacity}"/>`
  }).join('')
  const linear = firstByLocalName(gradient, 'lin')
  if (linear) {
    const angle = numberAttribute(linear, 'ang') / 60_000 * Math.PI / 180
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    const x1 = 50 - dx * 50
    const y1 = 50 - dy * 50
    const x2 = 50 + dx * 50
    const y2 = 50 + dy * 50
    return {
      defs: `<linearGradient id="shape-fill" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">${stops}</linearGradient>`,
      paint: 'url(#shape-fill)',
    }
  }
  return {
    defs: `<radialGradient id="shape-fill" cx="50%" cy="50%" r="71%">${stops}</radialGradient>`,
    paint: 'url(#shape-fill)',
  }
}

function svgShapeFrom(
  shape: Element,
  geometry: ReturnType<typeof shapeGeometry>,
  themeColors: ReadonlyMap<string, string>,
): PresentationImageElement | null {
  const shapeProperties = directChildrenByLocalName(shape, 'spPr')[0] ?? firstByLocalName(shape, 'spPr')
  if (!shapeProperties) return null
  const style = directChildrenByLocalName(shape, 'style')[0] ?? firstByLocalName(shape, 'style')
  const gradient = directChildrenByLocalName(shapeProperties, 'gradFill')[0] ?? null
  const solidFill = directChildrenByLocalName(shapeProperties, 'solidFill')[0]
    ?? (style ? firstByLocalName(style, 'fillRef') : null)
  const noFill = directChildrenByLocalName(shapeProperties, 'noFill').length > 0
  const importedFill = importedColorFrom(solidFill, 'transparent', themeColors)
  const fill = gradient
    ? svgGradientFrom(gradient, themeColors)
    : { defs: '', paint: noFill ? 'none' : importedFill.color }
  const fillOpacity = gradient || noFill ? 1 : importedFill.opacity
  const line = directChildrenByLocalName(shapeProperties, 'ln')[0] ?? null
  const lineFill = (line ? directChildrenByLocalName(line, 'solidFill')[0] ?? null : null)
    ?? (style ? firstByLocalName(style, 'lnRef') : null)
  const stroke = lineFill ? importedColorFrom(lineFill, 'transparent', themeColors) : { color: 'transparent', opacity: 1 }
  const strokeWidth = line ? Math.max(0, numberAttribute(line, 'w') / 12_700) : 0
  const customGeometry = directChildrenByLocalName(shapeProperties, 'custGeom')[0] ?? null
  const width = Math.max(1, geometry.width)
  const height = Math.max(1, geometry.height)
  let body = ''
  if (customGeometry) {
    const pathList = firstByLocalName(customGeometry, 'pathLst')
    const paths = pathList ? directChildrenByLocalName(pathList, 'path') : []
    body = paths.map((path) => {
      const pathWidth = Math.max(1, numberAttribute(path, 'w', width))
      const pathHeight = Math.max(1, numberAttribute(path, 'h', height))
      const pathFill = path.getAttribute('fill') === 'none' ? 'none' : fill.paint
      const pathStroke = path.getAttribute('stroke') === '0' ? 'none' : stroke.color
      return `<path d="${xmlEscape(customPathData(path))}" transform="scale(${width / pathWidth} ${height / pathHeight})" fill="${xmlEscape(pathFill)}" fill-opacity="${fillOpacity}" fill-rule="evenodd" stroke="${xmlEscape(pathStroke)}" stroke-opacity="${stroke.opacity}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"/>`
    }).join('')
  } else {
    const shapeType = shapeTypeFrom(shape)
    if (shapeType === 'rect') {
      body = `<rect width="${width}" height="${height}" fill="${xmlEscape(fill.paint)}" fill-opacity="${fillOpacity}" stroke="${xmlEscape(stroke.color)}" stroke-opacity="${stroke.opacity}" stroke-width="${strokeWidth}"/>`
    } else if (shapeType === 'roundRect') {
      body = `<rect width="${width}" height="${height}" rx="${Math.min(width, height) * 0.12}" ry="${Math.min(width, height) * 0.12}" fill="${xmlEscape(fill.paint)}" fill-opacity="${fillOpacity}" stroke="${xmlEscape(stroke.color)}" stroke-opacity="${stroke.opacity}" stroke-width="${strokeWidth}"/>`
    } else if (shapeType === 'ellipse') {
      body = `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${xmlEscape(fill.paint)}" fill-opacity="${fillOpacity}" stroke="${xmlEscape(stroke.color)}" stroke-opacity="${stroke.opacity}" stroke-width="${strokeWidth}"/>`
    } else {
      const definition = getPresentationShapeDefinition(shapeType)
      body = `<path d="${xmlEscape(definition.path)}" transform="scale(${width / 100} ${height / 100})" fill="${definition.strokeOnly ? 'none' : xmlEscape(fill.paint)}" fill-opacity="${fillOpacity}" fill-rule="evenodd" stroke="${xmlEscape(stroke.color)}" stroke-opacity="${stroke.opacity}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"/>`
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${fill.defs}</defs>${body}</svg>`
  const sourceId = firstByLocalName(shape, 'cNvPr')?.getAttribute('id') ?? createPresentationId('shape-svg')
  return {
    id: createPresentationId('image'),
    type: 'image',
    ...geometry,
    altText: firstByLocalName(shape, 'cNvPr')?.getAttribute('descr') ?? firstByLocalName(shape, 'cNvPr')?.getAttribute('name') ?? '',
    fit: 'contain',
    shadow: Boolean(firstByLocalName(shapeProperties, 'outerShdw')),
    source: {
      dataUrl: svgDataUrl(svg),
      fileName: `shape-${sourceId}.svg`,
      mimeType: 'image/svg+xml',
    },
  }
}

function visualShapeFrom(
  shape: Element,
  geometry: ReturnType<typeof shapeGeometry>,
  themeColors: ReadonlyMap<string, string>,
): PresentationShapeElement | PresentationImageElement | null {
  const shapeProperties = directChildrenByLocalName(shape, 'spPr')[0] ?? firstByLocalName(shape, 'spPr')
  if (!shapeProperties) return null
  if (directChildrenByLocalName(shapeProperties, 'custGeom').length > 0 || directChildrenByLocalName(shapeProperties, 'gradFill').length > 0) {
    return svgShapeFrom(shape, geometry, themeColors)
  }
  const style = directChildrenByLocalName(shape, 'style')[0] ?? firstByLocalName(shape, 'style')
  const noFill = directChildrenByLocalName(shapeProperties, 'noFill').length > 0
  const solidFill = directChildrenByLocalName(shapeProperties, 'solidFill')[0]
    ?? (style ? firstByLocalName(style, 'fillRef') : null)
  const importedFill = importedColorFrom(solidFill, 'transparent', themeColors)
  const fill = noFill ? 'transparent' : importedFill.color
  const line = directChildrenByLocalName(shapeProperties, 'ln')[0] ?? null
  const lineFill = (line ? directChildrenByLocalName(line, 'solidFill')[0] ?? null : null)
    ?? (style ? firstByLocalName(style, 'lnRef') : null)
  const borderColor = lineFill ? colorFrom(lineFill, 'transparent', themeColors) : 'transparent'
  const borderWidth = line ? Math.max(0, numberAttribute(line, 'w') / 12_700) : 0
  if (fill === 'transparent' && borderColor === 'transparent') return null
  return {
    id: createPresentationId('shape'),
    type: shapeTypeFrom(shape),
    ...geometry,
    fill,
    borderColor,
    borderWidth,
    ...(importedFill.opacity < 1 ? { opacity: importedFill.opacity } : {}),
    shadow: Boolean(firstByLocalName(shapeProperties, 'outerShdw')),
  }
}

function transitionFrom(slide: Document): PresentationTransition {
  const transition = firstByLocalName(slide, 'transition')
  if (!transition) return createDefaultPresentationTransition()
  const durationMs = numberAttribute(transition, 'dur', transitionDurationFallback(transition.getAttribute('spd')))
  for (const effect of ['fade', 'push', 'wipe', 'cover'] as const) {
    const node = firstByLocalName(transition, effect)
    if (!node) continue
    const direction = node.getAttribute('dir')
    return {
      effect,
      durationMs,
      ...(transitionDirectionFrom(direction) ? { direction: transitionDirectionFrom(direction) } : {}),
    }
  }
  return createDefaultPresentationTransition()
}

function importedAnimationEffect(presetClass: string | null, presetId: number): PresentationElement['animation'] {
  if (presetClass === 'entr') {
    return ({
      1: 'appear',
      2: 'flyIn',
      3: 'blinds',
      5: 'checkerboard',
      9: 'dissolve',
      10: 'fade',
      16: 'split',
      22: 'wipeIn',
      23: 'zoomIn',
      30: 'floatIn',
    } as const)[presetId] ?? 'fade'
  }
  if (presetClass === 'exit') return presetId === 3 ? 'blindsOut' : 'disappear'
  if (presetClass === 'emph') {
    if (presetId === 19) return 'fillColor'
    if (presetId === 3) return 'textColor'
    return 'zoom'
  }
  return 'none'
}

function applyImportedAnimations(document: Document, sourceShapeIds: ReadonlyMap<string, string>, elements: PresentationElement[]): PresentationElement[] {
  const patches = new Map<string, Partial<PresentationElement>>()
  for (const timing of elementsByLocalName(document, 'cTn')) {
    const presetId = Number(timing.getAttribute('presetID'))
    const presetClass = timing.getAttribute('presetClass')
    if (!Number.isFinite(presetId) || !presetClass) continue
    const sourceShapeId = firstByLocalName(timing, 'spTgt')?.getAttribute('spid')
    const elementId = sourceShapeId ? sourceShapeIds.get(sourceShapeId) : null
    if (!elementId) continue
    const effect = importedAnimationEffect(presetClass, presetId)
    if (effect === 'none') continue
    const durations = elementsByLocalName(timing, 'cTn')
      .map((node) => Number(node.getAttribute('dur')))
      .filter((duration) => Number.isFinite(duration) && duration > 1)
    const delay = elementsByLocalName(timing, 'cond')
      .map((condition) => Number(condition.getAttribute('delay')))
      .find((value) => Number.isFinite(value) && value >= 0) ?? 0
    const nodeType = timing.getAttribute('nodeType')
    const color = colorFrom(firstByLocalName(timing, 'to'), '#8B7CFF')
    patches.set(elementId, {
      animation: effect,
      animationColor: color,
      animationDelay: delay,
      animationDuration: durations[0] ?? 520,
      animationStart: animationStartFrom(nodeType),
    })
  }
  return elements.map((element) => {
    const patch = patches.get(element.id)
    return patch ? { ...element, ...patch } as PresentationElement : element
  })
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

function mimeTypeForPath(path: string): string {
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg'
  if (/\.gif$/i.test(path)) return 'image/gif'
  if (/\.svg$/i.test(path)) return 'image/svg+xml'
  return 'image/png'
}

async function importSlide(archive: JSZip, slidePath: string, pageSize: PresentationPageSize, slideSizeEmu: { width: number; height: number }, index: number): Promise<PresentationSlide> {
  const slideFile = archive.file(slidePath)
  if (!slideFile) throw new Error(`Missing ${slidePath}`)
  const document = parseXml(await slideFile.async('text'))
  const relationships = await relationshipTargets(archive, slidePath)
  const themeColors = await themeColorsFromArchive(archive)
  const layoutPath = [...relationships.values()].find((target) => target.includes('/slideLayouts/'))
  const layoutFile = layoutPath ? archive.file(layoutPath) : null
  const layoutDocument = layoutFile ? parseXml(await layoutFile.async('text')) : null
  const layoutRelationships = layoutPath ? await relationshipTargets(archive, layoutPath) : new Map<string, string>()
  const masterPath = [...layoutRelationships.values()].find((target) => target.includes('/slideMasters/'))
  const masterFile = masterPath ? archive.file(masterPath) : null
  const masterDocument = masterFile ? parseXml(await masterFile.async('text')) : null
  const masterRelationships = masterPath ? await relationshipTargets(archive, masterPath) : new Map<string, string>()
  let elements: PresentationElement[] = []
  const sourceShapeIds = new Map<string, string>()

  const placeholderKey = (shape: Element): { exact: string; type: string } | null => {
    const placeholder = firstByLocalName(shape, 'ph')
    if (!placeholder) return null
    const type = placeholder.getAttribute('type') || 'body'
    const indexValue = placeholder.getAttribute('idx') || ''
    return { exact: `${type}:${indexValue}`, type }
  }
  const placeholderPrototypes = new Map<string, Element>()
  const registerPlaceholderPrototypes = (source: Document | null) => {
    if (!source) return
    for (const shape of elementsByLocalName(source, 'sp')) {
      const key = placeholderKey(shape)
      if (!key) continue
      if (!placeholderPrototypes.has(`type:${key.type}`)) placeholderPrototypes.set(`type:${key.type}`, shape)
      placeholderPrototypes.set(`exact:${key.exact}`, shape)
    }
  }
  registerPlaceholderPrototypes(masterDocument)
  registerPlaceholderPrototypes(layoutDocument)
  const placeholderPrototypeFor = (shape: Element): Element | undefined => {
    const key = placeholderKey(shape)
    if (!key) return undefined
    return placeholderPrototypes.get(`exact:${key.exact}`) ?? placeholderPrototypes.get(`type:${key.type}`)
  }

  const withGroup = <T extends PresentationElement>(element: T, groupId?: string): T => (
    groupId ? { ...element, groupId } : element
  ) as T

  const importShape = (shape: Element, coordinateTransform: CoordinateTransform, parentGroupId?: string) => {
    const fallbackShape = placeholderPrototypeFor(shape)
    const geometry = shapeGeometry(shape, pageSize, slideSizeEmu, coordinateTransform, fallbackShape)
    const visual = visualShapeFrom(shape, geometry, themeColors)
    const text = textFrom(shape, geometry, pageSize, slideSizeEmu, themeColors, fallbackShape)
    const groupId = parentGroupId ?? (visual && text ? createPresentationId('group') : undefined)
    if (visual) elements.push(withGroup(visual, groupId))
    if (text) elements.push(withGroup(text, groupId))
    const sourceId = firstByLocalName(shape, 'cNvPr')?.getAttribute('id')
    const targetId = visual?.id ?? text?.id
    if (sourceId && targetId) sourceShapeIds.set(sourceId, targetId)
  }

  const importPicture = async (
    picture: Element,
    coordinateTransform: CoordinateTransform,
    relationshipMap: ReadonlyMap<string, string>,
    parentGroupId?: string,
  ) => {
    const blip = firstByLocalName(picture, 'blip')
    const svgBlip = blip ? firstByLocalName(blip, 'svgBlip') : null
    const relationshipId = blip?.getAttribute('r:embed')
      || blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
      || svgBlip?.getAttribute('r:embed')
      || svgBlip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
    const target = relationshipId ? relationshipMap.get(relationshipId) : null
    const image = target ? archive.file(target) : null
    if (!target || !image) return
    const geometry = shapeGeometry(picture, pageSize, slideSizeEmu, coordinateTransform)
    const mimeType = mimeTypeForPath(target)
    const cropNode = firstByLocalName(picture, 'srcRect')
    const crop = cropNode ? {
      left: Math.max(0, Math.min(0.999, numberAttribute(cropNode, 'l') / 100_000)),
      top: Math.max(0, Math.min(0.999, numberAttribute(cropNode, 't') / 100_000)),
      right: Math.max(0, Math.min(0.999, numberAttribute(cropNode, 'r') / 100_000)),
      bottom: Math.max(0, Math.min(0.999, numberAttribute(cropNode, 'b') / 100_000)),
    } : undefined
    const opacity = opacityFrom(blip)
    const importedImage: PresentationImageElement = withGroup({
      id: createPresentationId('image'),
      type: 'image',
      ...geometry,
      altText: firstByLocalName(picture, 'cNvPr')?.getAttribute('descr') ?? '',
      fit: crop ? 'cover' : 'contain',
      ...(crop ? { crop } : {}),
      ...(opacity < 1 ? { opacity } : {}),
      shadow: Boolean(firstByLocalName(picture, 'outerShdw')),
      source: {
        dataUrl: bytesToDataUrl(await image.async('uint8array'), mimeType),
        fileName: target.slice(target.lastIndexOf('/') + 1),
        mimeType,
      },
    }, parentGroupId)
    elements.push(importedImage)
    const sourceId = firstByLocalName(picture, 'cNvPr')?.getAttribute('id')
    if (sourceId) sourceShapeIds.set(sourceId, importedImage.id)
  }

  const cachedValues = (root: Element | null): string[] => {
    if (!root) return []
    const cache = firstByLocalName(root, 'strCache') ?? firstByLocalName(root, 'numCache') ?? root
    return elementsByLocalName(cache, 'pt')
      .map((point) => ({
        index: numberAttribute(point, 'idx'),
        value: firstByLocalName(point, 'v')?.textContent ?? '',
      }))
      .sort((left, right) => left.index - right.index)
      .map((point) => point.value)
  }

  const importGraphicFrame = async (
    frame: Element,
    coordinateTransform: CoordinateTransform,
    relationshipMap: ReadonlyMap<string, string>,
    parentGroupId?: string,
  ) => {
    const geometry = shapeGeometry(frame, pageSize, slideSizeEmu, coordinateTransform)
    const sourceId = firstByLocalName(frame, 'cNvPr')?.getAttribute('id')
    const table = firstByLocalName(frame, 'tbl')
    if (table) {
      const rows = directChildrenByLocalName(table, 'tr').map((row) => (
        directChildrenByLocalName(row, 'tc').map((cell) => (
          elementsByLocalName(cell, 'p').map((paragraph) => elementsByLocalName(paragraph, 't').map((text) => text.textContent ?? '').join('')).join('\n')
        ))
      ))
      if (rows.length === 0 || rows.every((row) => row.length === 0)) return
      const firstCell = firstByLocalName(table, 'tc')
      const firstCellProperties = firstCell ? firstByLocalName(firstCell, 'tcPr') : null
      const firstRunProperties = firstCell ? firstByLocalName(firstCell, 'rPr') : null
      const secondRow = directChildrenByLocalName(table, 'tr')[1] ?? null
      const bodyCellProperties = secondRow ? firstByLocalName(secondRow, 'tcPr') : null
      const line = firstCellProperties ? firstByLocalName(firstCellProperties, 'ln') : null
      const importedTable: PresentationTableElement = withGroup({
        id: createPresentationId('table'),
        type: 'table',
        ...geometry,
        cells: rows,
        headerRow: rows.length > 1,
        headerFill: colorFrom(firstByLocalName(firstCellProperties ?? table, 'solidFill'), '#F4F1FF', themeColors),
        bodyFill: colorFrom(firstByLocalName(bodyCellProperties ?? table, 'solidFill'), '#FFFFFF', themeColors),
        textColor: colorFrom(firstRunProperties, '#20202B', themeColors),
        borderColor: colorFrom(firstByLocalName(line ?? table, 'solidFill'), '#D9D7E2', themeColors),
        fontSize: presentationFontSizeFromPoints(Math.max(6, numberAttribute(firstRunProperties, 'sz', 1_400) / 100)),
      }, parentGroupId)
      elements.push(importedTable)
      if (sourceId) sourceShapeIds.set(sourceId, importedTable.id)
      return
    }

    const chartReference = firstByLocalName(frame, 'chart')
    const relationshipId = chartReference?.getAttribute('r:id')
      ?? chartReference?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    const chartPath = relationshipId ? relationshipMap.get(relationshipId) : null
    const chartFile = chartPath ? archive.file(chartPath) : null
    if (!chartFile) return
    const chartDocument = parseXml(await chartFile.async('text'))
    const plotArea = firstByLocalName(chartDocument, 'plotArea')
    const chartRoot = firstByLocalName(chartDocument, 'barChart')
      ?? firstByLocalName(chartDocument, 'lineChart')
      ?? firstByLocalName(chartDocument, 'pieChart')
      ?? firstByLocalName(chartDocument, 'doughnutChart')
    if (!chartRoot) return
    const chartFill = (shapeProperties: Element | null, fallback: string): string => {
      if (!shapeProperties) return fallback
      if (directChildrenByLocalName(shapeProperties, 'noFill').length > 0) return 'transparent'
      const solidFill = directChildrenByLocalName(shapeProperties, 'solidFill')[0]
      if (solidFill && opacityFrom(solidFill) === 0) return 'transparent'
      return solidFill ? colorFrom(solidFill, fallback, themeColors) : fallback
    }
    const chartChild = (root: Element | null, name: string): Element | null => (
      root ? firstByLocalName(root, name) : null
    )
    let chartType: PresentationChartElement['chartType'] = 'column'
    if (chartRoot.localName === 'lineChart') chartType = 'line'
    else if (chartRoot.localName === 'pieChart') chartType = 'pie'
    else if (chartRoot.localName === 'doughnutChart') chartType = 'doughnut'
    else if (firstByLocalName(chartRoot, 'barDir')?.getAttribute('val') === 'bar') chartType = 'bar'
    const seriesNodes = directChildrenByLocalName(chartRoot, 'ser')
    const series = seriesNodes.map((seriesNode, seriesIndex) => {
      const values = cachedValues(firstByLocalName(seriesNode, 'val')).map((value) => Number(value))
      const name = firstByLocalName(firstByLocalName(seriesNode, 'tx') ?? seriesNode, 'v')?.textContent?.trim()
      return {
        name: name || `Series ${seriesIndex + 1}`,
        values: values.map((value) => Number.isFinite(value) ? value : 0),
      }
    })
    const categories = cachedValues(firstByLocalName(seriesNodes[0] ?? chartRoot, 'cat'))
    const colors = seriesNodes.map((seriesNode, seriesIndex) => (
      colorFrom(firstByLocalName(firstByLocalName(seriesNode, 'spPr') ?? seriesNode, 'solidFill'), ['#4472C4', '#ED7D31', '#A5A5A5'][seriesIndex % 3]!, themeColors)
    ))
    const chartAreaProperties = directChildrenByLocalName(chartDocument.documentElement, 'spPr')[0] ?? null
    const plotAreaProperties = plotArea ? directChildrenByLocalName(plotArea, 'spPr')[0] ?? null : null
    const categoryAxis = plotArea ? firstByLocalName(plotArea, 'catAx') : null
    const valueAxis = plotArea ? firstByLocalName(plotArea, 'valAx') : null
    const dataLabels = directChildrenByLocalName(chartRoot, 'dLbls')[0] ?? null
    const showValue = Boolean(dataLabels && firstByLocalName(dataLabels, 'showVal')?.getAttribute('val') !== '0')
    const importedChart: PresentationChartElement = withGroup({
      id: createPresentationId('chart'),
      type: 'chart',
      ...geometry,
      chartType,
      categories: categories.length > 0 ? categories : series[0]?.values.map((_, valueIndex) => `${valueIndex + 1}`) ?? [],
      series,
      showLegend: Boolean(firstByLocalName(chartDocument, 'legend')),
      showValue,
      title: elementsByLocalName(firstByLocalName(chartDocument, 'title') ?? chartDocument, 't').map((node) => node.textContent ?? '').join('').trim() || undefined,
      colors,
      chartAreaFill: chartFill(chartAreaProperties, '#FFFFFF'),
      plotAreaFill: chartFill(plotAreaProperties, 'transparent'),
      categoryAxisLabelColor: colorFrom(chartChild(categoryAxis, 'txPr'), '#666571', themeColors),
      valueAxisLabelColor: colorFrom(chartChild(valueAxis, 'txPr'), '#666571', themeColors),
      gridLineColor: colorFrom(chartChild(chartChild(valueAxis, 'majorGridlines'), 'solidFill'), '#E9EAF0', themeColors),
      dataLabelColor: colorFrom(chartChild(dataLabels, 'txPr'), '#20202B', themeColors),
    }, parentGroupId)
    elements.push(importedChart)
    if (sourceId) sourceShapeIds.set(sourceId, importedChart.id)
  }

  const groupTransform = (group: Element, parent: CoordinateTransform): CoordinateTransform => {
    const properties = directChildrenByLocalName(group, 'grpSpPr')[0] ?? firstByLocalName(group, 'grpSpPr')
    const transform = properties ? firstByLocalName(properties, 'xfrm') : null
    if (!transform) return parent
    const offset = directChildrenByLocalName(transform, 'off')[0] ?? firstByLocalName(transform, 'off')
    const extent = directChildrenByLocalName(transform, 'ext')[0] ?? firstByLocalName(transform, 'ext')
    const childOffset = directChildrenByLocalName(transform, 'chOff')[0] ?? firstByLocalName(transform, 'chOff')
    const childExtent = directChildrenByLocalName(transform, 'chExt')[0] ?? firstByLocalName(transform, 'chExt')
    const childScaleX = numberAttribute(extent, 'cx', 1) / Math.max(1, numberAttribute(childExtent, 'cx', 1))
    const childScaleY = numberAttribute(extent, 'cy', 1) / Math.max(1, numberAttribute(childExtent, 'cy', 1))
    return {
      scaleX: parent.scaleX * childScaleX,
      scaleY: parent.scaleY * childScaleY,
      translateX: parent.translateX + parent.scaleX * (numberAttribute(offset, 'x') - numberAttribute(childOffset, 'x') * childScaleX),
      translateY: parent.translateY + parent.scaleY * (numberAttribute(offset, 'y') - numberAttribute(childOffset, 'y') * childScaleY),
      rotation: parent.rotation + numberAttribute(transform, 'rot') / 60_000,
    }
  }

  const importTree = async (
    root: Element,
    coordinateTransform: CoordinateTransform,
    relationshipMap: ReadonlyMap<string, string>,
    parentGroupId?: string,
    skipPlaceholders = false,
  ): Promise<void> => {
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType !== 1) continue
      const child = node as Element
      if (skipPlaceholders && firstByLocalName(child, 'ph')) continue
      if (child.localName === 'sp' || child.localName === 'cxnSp') importShape(child, coordinateTransform, parentGroupId)
      else if (child.localName === 'pic') await importPicture(child, coordinateTransform, relationshipMap, parentGroupId)
      else if (child.localName === 'graphicFrame') await importGraphicFrame(child, coordinateTransform, relationshipMap, parentGroupId)
      else if (child.localName === 'grpSp') {
        const groupId = parentGroupId ?? createPresentationId('group')
        const firstElementIndex = elements.length
        await importTree(child, groupTransform(child, coordinateTransform), relationshipMap, groupId, skipPlaceholders)
        const sourceId = firstByLocalName(child, 'cNvPr')?.getAttribute('id')
        const firstMember = elements[firstElementIndex]
        if (sourceId && firstMember) sourceShapeIds.set(sourceId, firstMember.id)
      } else if (child.localName === 'AlternateContent') {
        const fallback = firstByLocalName(child, 'Fallback') ?? firstByLocalName(child, 'Choice')
        if (fallback) await importTree(fallback, coordinateTransform, relationshipMap, parentGroupId, skipPlaceholders)
      }
    }
  }

  const showMasterShapes = firstByLocalName(document, 'cSld')?.getAttribute('showMasterSp') !== '0'
    && firstByLocalName(layoutDocument ?? document, 'cSld')?.getAttribute('showMasterSp') !== '0'
  const masterShapeTree = masterDocument ? firstByLocalName(masterDocument, 'spTree') : null
  if (showMasterShapes && masterShapeTree) {
    await importTree(masterShapeTree, ROOT_COORDINATE_TRANSFORM, masterRelationships, undefined, true)
  }
  const layoutShapeTree = layoutDocument ? firstByLocalName(layoutDocument, 'spTree') : null
  if (layoutShapeTree) await importTree(layoutShapeTree, ROOT_COORDINATE_TRANSFORM, layoutRelationships, undefined, true)
  sourceShapeIds.clear()
  const shapeTree = firstByLocalName(document, 'spTree')
  if (shapeTree) await importTree(shapeTree, ROOT_COORDINATE_TRANSFORM, relationships)
  elements = applyImportedAnimations(document, sourceShapeIds, elements)
  const backgroundRoot = firstByLocalName(document, 'bg')
    ?? (layoutDocument ? firstByLocalName(layoutDocument, 'bg') : null)
    ?? (masterDocument ? firstByLocalName(masterDocument, 'bg') : null)
  const background = colorFrom(backgroundRoot, '#FFFFFF', themeColors)
  const notesTarget = [...relationships.values()].find((target) => target.includes('/notesSlides/'))
  const notesFile = notesTarget ? archive.file(notesTarget) : null
  let notes = ''
  if (notesFile) {
    const notesDocument = parseXml(await notesFile.async('text'))
    notes = elementsByLocalName(notesDocument, 't').map((node) => node.textContent ?? '').filter((value) => value.trim()).join('\n')
  }
  return {
    id: createPresentationId('slide'),
    name: `Slide ${index + 1}`,
    background,
    elements,
    notes,
    transition: transitionFrom(document),
  }
}

/** Import common editable PowerPoint content from an OOXML .pptx archive. */
export async function importPresentationPptx(bytes: ArrayBuffer | Uint8Array, fileName = 'Imported presentation.pptx'): Promise<PresentationDocument> {
  const archive = await JSZip.loadAsync(bytes)
  const presentationFile = archive.file('ppt/presentation.xml')
  if (!presentationFile) throw new Error('Not a PowerPoint presentation')
  const presentation = parseXml(await presentationFile.async('text'))
  const pageSize = pageSizeFrom(presentation)
  const slideSize = firstByLocalName(presentation, 'sldSz')
  const slideSizeEmu = {
    width: numberAttribute(slideSize, 'cx', 13.333 * EMU_PER_INCH),
    height: numberAttribute(slideSize, 'cy', 7.5 * EMU_PER_INCH),
  }
  const relationships = await relationshipTargets(archive, 'ppt/presentation.xml')
  const orderedPaths = elementsByLocalName(presentation, 'sldId').flatMap((slideId) => {
    const id = slideId.getAttribute('r:id')
      ?? slideId.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    const target = id ? relationships.get(id) : null
    return target ? [target] : []
  })
  const fallbackPaths = Object.keys(archive.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]))
  const slidePaths = orderedPaths.length > 0 ? orderedPaths : fallbackPaths
  if (slidePaths.length === 0) throw new Error('The presentation contains no slides')
  const slides = await Promise.all(slidePaths.map((path, index) => importSlide(archive, path, pageSize, slideSizeEmu, index)))
  return {
    id: createPresentationId('presentation'),
    master: { ...DEFAULT_PRESENTATION_MASTER, footer: { ...DEFAULT_PRESENTATION_MASTER.footer } },
    pageSize,
    selectedSlideId: slides[0]!.id,
    slides,
    title: fileName.replace(/\.pptx$/i, '') || 'Imported presentation',
    version: 1,
  }
}
