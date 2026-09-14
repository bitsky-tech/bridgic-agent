import { presentationChartBlankDisplay, presentationChartHoleSize } from '@/lib/presentationCharts'
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
  type PresentationTextRun,
  type PresentationTextStyle,
  type PresentationTextParagraph,
  type PresentationParagraphStyle,
  type PresentationTransition,
} from '@/atoms/presentation'
import { getPresentationShapeDefinition, isPresentationLineShape, isSupportedPresentationShapeType, PRESENTATION_CONNECTOR_NAMESPACE } from '@/lib/presentationShapes'
import {
  presentationCharacterSpacingFromPoints,
  presentationFontSizeFromPoints,
  presentationTextUsesCjk,
} from '@/lib/presentationText'
import { createDefaultPresentationTransition } from '@/lib/presentationTransitions'

const EMU_PER_INCH = 914_400
const SLIDE_HEIGHT_PX = 720
const DEFAULT_TEXT_HORIZONTAL_INSET_EMU = 91_440
const DEFAULT_TEXT_VERTICAL_INSET_EMU = 45_720

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

async function themeColorsFromArchive(archive: JSZip, relatedThemePath?: string): Promise<Map<string, string>> {
  const themePath = relatedThemePath ?? Object.keys(archive.files).find((path) => /^ppt\/theme\/theme\d+\.xml$/i.test(path))
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

async function themeFontsFromArchive(archive: JSZip, relatedThemePath?: string): Promise<Map<string, string>> {
  const themePath = relatedThemePath ?? Object.keys(archive.files).find(path => /^ppt\/theme\/theme\d+\.xml$/i.test(path))
  const file = themePath ? archive.file(themePath) : null
  const fonts = new Map<string, string>()
  if (!file) return fonts
  const theme = parseXml(await file.async('text'))
  for (const [kind, prefix] of [['majorFont', '+mj'], ['minorFont', '+mn']] as const) {
    const family = firstByLocalName(theme, kind)
    if (!family) continue
    for (const [name, suffix] of [['latin', 'lt'], ['ea', 'ea'], ['cs', 'cs']] as const) {
      const typeface = directChildrenByLocalName(family, name)[0]?.getAttribute('typeface')
      if (typeface) fonts.set(`${prefix}-${suffix}`, typeface)
    }
    for (const font of directChildrenByLocalName(family, 'font')) {
      const script = font.getAttribute('script')
      const typeface = font.getAttribute('typeface')
      if (script && typeface) fonts.set(`${prefix}:${script}`, typeface)
    }
  }
  return fonts
}

function themeTextFont(reference: string | null | undefined, text: string, language: string | null, fonts: ReadonlyMap<string, string>): string {
  if (!reference) return 'Aptos'
  if (!/^\+m[jn]-(lt|ea|cs)$/.test(reference)) return reference
  const explicit = fonts.get(reference)
  if (explicit) return explicit
  const prefix = reference.slice(0, 3)
  let script = 'Hans'
  if (/^ja/i.test(language ?? '') || /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) script = 'Jpan'
  else if (/^ko/i.test(language ?? '') || /\p{Script=Hangul}/u.test(text)) script = 'Hang'
  else if (/^zh-(TW|HK|MO|Hant)/i.test(language ?? '')) script = 'Hant'
  return (reference.endsWith('-ea') ? fonts.get(`${prefix}:${script}`) : undefined)
    ?? fonts.get(`${prefix}-lt`) ?? 'Aptos'
}

interface TextImportContext {
  fonts: ReadonlyMap<string, string>
  defaultTextStyle: Element | null
  masterTextStyles: Element | null
}

function numberAttribute(element: Element | null, name: string, fallback = 0): number {
  const raw = element?.getAttribute(name)
  if (raw === null || raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

interface ImportedColor {
  color: string
  opacity: number
}

interface CoordinateTransform {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

const ROOT_COORDINATE_TRANSFORM: CoordinateTransform = {
  a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
}

function composeTransform(parent: CoordinateTransform, child: CoordinateTransform): CoordinateTransform {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    e: parent.a * child.e + parent.c * child.f + parent.e,
    f: parent.b * child.e + parent.d * child.f + parent.f,
  }
}

const defaultThemeColors = new Map<string, string>([
  ['dk1', '000000'], ['lt1', 'FFFFFF'], ['dk2', '1F1F1F'], ['lt2', 'E7E6E6'],
  ['accent1', '4472C4'], ['accent2', 'ED7D31'], ['accent3', 'A5A5A5'],
  ['accent4', 'FFC000'], ['accent5', '5B9BD5'], ['accent6', '70AD47'],
  ['hlink', '0563C1'], ['folHlink', '954F72'], ['tx1', '000000'], ['bg1', 'FFFFFF'],
  ['tx2', '1F1F1F'], ['bg2', 'E7E6E6'],
])

const presetColors = new Map<string, string>([
  ['black', '000000'], ['white', 'FFFFFF'], ['red', 'FF0000'], ['green', '008000'],
  ['blue', '0000FF'], ['yellow', 'FFFF00'], ['cyan', '00FFFF'], ['magenta', 'FF00FF'],
  ['gray', '808080'], ['grey', '808080'], ['dkGray', 'A9A9A9'], ['dkGrey', 'A9A9A9'],
  ['ltGray', 'D3D3D3'], ['ltGrey', 'D3D3D3'], ['orange', 'FFA500'], ['purple', '800080'],
])

function selfOrFirstByLocalName(root: Element, name: string): Element | null {
  return root.localName === name ? root : firstByLocalName(root, name)
}

function colorFrom(root: Element | null, fallback: string, themeColors: ReadonlyMap<string, string> = defaultThemeColors): string {
  if (!root) return fallback
  const srgb = selfOrFirstByLocalName(root, 'srgbClr')?.getAttribute('val')
  if (srgb && /^[\dA-F]{6}$/i.test(srgb)) return `#${srgb.toUpperCase()}`
  const system = selfOrFirstByLocalName(root, 'sysClr')?.getAttribute('lastClr')
  if (system && /^[\dA-F]{6}$/i.test(system)) return `#${system.toUpperCase()}`
  const preset = selfOrFirstByLocalName(root, 'prstClr')?.getAttribute('val')
  const presetValue = preset ? presetColors.get(preset) : null
  if (presetValue) return `#${presetValue}`
  const scheme = selfOrFirstByLocalName(root, 'schemeClr')?.getAttribute('val')
  const themed = scheme ? themeColors.get(scheme) : null
  return themed && /^[\dA-F]{6}$/i.test(themed) ? `#${themed.toUpperCase()}` : fallback
}

function opacityFrom(root: Element | null): number {
  if (!root) return 1
  const alpha = root.localName === 'alpha' ? root : directChildrenByLocalName(root, 'alpha')[0]
  const alphaMod = root.localName === 'alphaModFix' ? root : directChildrenByLocalName(root, 'alphaModFix')[0]
  const raw = alpha?.getAttribute('val') ?? alphaMod?.getAttribute('amt')
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed / 100_000)) : 1
}

function importedColorFrom(root: Element | null, fallback: string, themeColors: ReadonlyMap<string, string> = defaultThemeColors): ImportedColor {
  const colorRoot = root ? firstByLocalName(root, 'solidFill') ?? root : null
  const colorNode = colorRoot
    ? selfOrFirstByLocalName(colorRoot, 'srgbClr')
      ?? selfOrFirstByLocalName(colorRoot, 'sysClr')
      ?? selfOrFirstByLocalName(colorRoot, 'prstClr')
      ?? selfOrFirstByLocalName(colorRoot, 'schemeClr')
    : null
  return {
    color: colorFrom(colorRoot, fallback, themeColors),
    opacity: opacityFrom(colorNode),
  }
}

/** An explicit no-fill line overrides the theme; alpha belongs to the stroke, not the shape. */
function shapeStrokeFrom(shape: Element, shapeProperties: Element, themeColors: ReadonlyMap<string, string>) {
  const line = directChildrenByLocalName(shapeProperties, 'ln')[0]
  const style = directChildrenByLocalName(shape, 'style')[0]
  const noFill = line && directChildrenByLocalName(line, 'noFill').length > 0
  const fill = noFill ? null : (line ? directChildrenByLocalName(line, 'solidFill')[0] : null)
    ?? (style ? firstByLocalName(style, 'lnRef') : null)
  const stroke = importedColorFrom(fill, 'transparent', themeColors)
  if (noFill || stroke.opacity === 0 || stroke.color === 'transparent') return { color: 'transparent', opacity: 1, width: 0 }
  return { ...stroke, width: line ? presentationFontSizeFromPoints(Math.max(0, numberAttribute(line, 'w') / 12_700)) : 0 }
}

function textAlignmentFrom(value: string | null | undefined): PresentationTextElement['align'] {
  if (value === 'ctr') return 'center'
  if (value === 'r') return 'right'
  if (value === 'just') return 'justify'
  return 'left'
}

function textDirectionFrom(value: string | null | undefined): PresentationTextElement['textDirection'] | undefined {
  if (value === 'eaVert') return 'eastAsianVertical'
  if (value === 'vert') return 'vertical'
  if (value === 'vert270') return 'vertical270'
  if (value === 'wordArtVert' || value === 'wordArtVertRtl') return 'stacked'
  if (value === 'horz') return 'horizontal'
  return undefined
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
  const angle = numberAttribute(transform, 'rot') / 60_000 * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const matrix = coordinateTransform
  const axisX = { x: (matrix.a * cos + matrix.c * sin) * scaleX, y: (matrix.b * cos + matrix.d * sin) * scaleY }
  const axisY = { x: (-matrix.a * sin + matrix.c * cos) * scaleX, y: (-matrix.b * sin + matrix.d * cos) * scaleY }
  const width = Math.max(1, sourceWidth * Math.hypot(axisX.x, axisX.y))
  const height = Math.max(1, sourceHeight * Math.hypot(axisY.x, axisY.y))
  const rotation = Math.atan2(axisX.y, axisX.x)
  const centerX = (matrix.a * (sourceX + sourceWidth / 2) + matrix.c * (sourceY + sourceHeight / 2) + matrix.e) * scaleX
  const centerY = (matrix.b * (sourceX + sourceWidth / 2) + matrix.d * (sourceY + sourceHeight / 2) + matrix.f) * scaleY
  const mirrored = axisX.x * axisY.y - axisX.y * axisY.x < 0
  const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000
  // OOXML rotates around the frame center; the renderer stores a rotated top-left origin.
  return {
    x: rounded(centerX - (Math.cos(rotation) * width - Math.sin(rotation) * height) / 2),
    y: rounded(centerY - (Math.sin(rotation) * width + Math.cos(rotation) * height) / 2),
    width: rounded(width),
    height: rounded(height),
    rotation: rounded(rotation * 180 / Math.PI),
    ...(transform?.getAttribute('flipH') === '1' ? { flipHorizontal: true } : {}),
    ...((transform?.getAttribute('flipV') === '1') !== mirrored ? { flipVertical: true } : {}),
  }
}

function storedConnectorType(shape: Element): PresentationShapeType | undefined {
  const type = shape.getElementsByTagNameNS(PRESENTATION_CONNECTOR_NAMESPACE, 'connector')[0]?.getAttribute('type')
  return type && isSupportedPresentationShapeType(type) && isPresentationLineShape(type) ? type : undefined
}

function shapeTypeFrom(shape: Element): PresentationShapeType {
  const stored = storedConnectorType(shape)
  if (stored) return stored
  const preset = firstByLocalName(shape, 'prstGeom')?.getAttribute('prst')
  if (shape.localName === 'cxnSp' || preset === 'line' || preset?.includes('Connector')) {
    const begin = firstByLocalName(shape, 'headEnd')?.getAttribute('type')
    const end = firstByLocalName(shape, 'tailEnd')?.getAttribute('type')
    const hasBegin = Boolean(begin && begin !== 'none')
    const hasEnd = Boolean(end && end !== 'none')
    if (preset?.startsWith('bentConnector')) return hasBegin || hasEnd ? 'elbowArrow' : 'elbowConnector'
    if (preset?.startsWith('curvedConnector')) return hasBegin || hasEnd ? 'curvedArrow' : 'curvedConnector'
    if (hasBegin && hasEnd) return 'lineDoubleArrow'
    return hasBegin || hasEnd ? 'lineArrow' : 'line'
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
  coordinateTransform = ROOT_COORDINATE_TRANSFORM,
  context: TextImportContext = { fonts: new Map(), defaultTextStyle: null, masterTextStyles: null },
): PresentationTextElement | null {
  const textBody = directChildrenByLocalName(shape, 'txBody')[0] ?? firstByLocalName(shape, 'txBody')
  if (!textBody) return null
  const paragraphNodes = directChildrenByLocalName(textBody, 'p')
  const chunks = paragraphNodes.flatMap((paragraph, index) => [
    ...(index ? [{ text: '\n', node: paragraph, paragraph }] : []),
    ...Array.from(paragraph.childNodes).filter((node): node is Element => node.nodeType === 1)
      .flatMap(node => {
        if (node.localName === 'br') return [{ text: '\n', node, paragraph }]
        if (node.localName !== 'r' && node.localName !== 'fld') return []
        return [{ text: firstByLocalName(node, 't')?.textContent ?? '', node, paragraph }]
      }),
  ])
  const paragraphs = chunks.map(chunk => chunk.text)
  const text = paragraphs.join('')
  if (!text) return null
  const fallbackTextBody = fallbackShape
    ? directChildrenByLocalName(fallbackShape, 'txBody')[0] ?? firstByLocalName(fallbackShape, 'txBody')
    : null
  const placeholderType = firstByLocalName(shape, 'ph')?.getAttribute('type')
  let masterStyleName = 'otherStyle'
  if (placeholderType === 'title' || placeholderType === 'ctrTitle') masterStyleName = 'titleStyle'
  else if (firstByLocalName(shape, 'ph')) masterStyleName = 'bodyStyle'
  const masterStyle = context.masterTextStyles ? firstByLocalName(context.masterTextStyles, masterStyleName) : null
  const levelProperties = (style: Element | null, level: number): Element | null => (
    style ? directChildrenByLocalName(style, `lvl${level + 1}pPr`)[0] ?? directChildrenByLocalName(style, 'defPPr')[0] ?? null : null
  )
  const paragraphDefaults = (paragraph: Element): (Element | null)[] => {
    const own = directChildrenByLocalName(paragraph, 'pPr')[0] ?? null
    const level = Math.max(0, Math.min(8, Math.floor(numberAttribute(own, 'lvl'))))
    const fallbackParagraph = fallbackTextBody ? directChildrenByLocalName(fallbackTextBody, 'p')[0] : null
    return [
      levelProperties(context.defaultTextStyle, level),
      levelProperties(masterStyle, level),
      levelProperties(fallbackTextBody ? directChildrenByLocalName(fallbackTextBody, 'lstStyle')[0] ?? null : null, level),
      fallbackParagraph ? directChildrenByLocalName(fallbackParagraph, 'pPr')[0] ?? null : null,
      levelProperties(directChildrenByLocalName(textBody, 'lstStyle')[0] ?? null, level),
      own,
    ]
  }
  const fontReference = firstByLocalName(firstByLocalName(shape, 'style') ?? shape, 'fontRef')
    ?? (fallbackShape ? firstByLocalName(firstByLocalName(fallbackShape, 'style') ?? fallbackShape, 'fontRef') : null)
  const fontCollection = fontReference?.getAttribute('idx')
  const themeRunProperties = fontCollection === 'major' || fontCollection === 'minor'
    ? parseXml(`<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:latin typeface="+m${fontCollection === 'major' ? 'j' : 'n'}-lt"/><a:ea typeface="+m${fontCollection === 'major' ? 'j' : 'n'}-ea"/><a:cs typeface="+m${fontCollection === 'major' ? 'j' : 'n'}-cs"/></a:rPr>`).documentElement
    : null
  const resolveRunProperties = (node: Element, paragraph: Element) => {
    const merged = parseXml('<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>').documentElement
    const defaults = [
      fallbackTextBody ? firstByLocalName(fallbackTextBody, 'endParaRPr') : null,
      fallbackTextBody ? firstByLocalName(fallbackTextBody, 'defRPr') : null,
      fallbackTextBody ? firstByLocalName(fallbackTextBody, 'rPr') : null,
      ...paragraphDefaults(paragraph).slice(0, 4).map(properties => properties ? directChildrenByLocalName(properties, 'defRPr')[0] ?? null : null),
      themeRunProperties,
      ...paragraphDefaults(paragraph).slice(4).map(properties => properties ? directChildrenByLocalName(properties, 'defRPr')[0] ?? null : null),
      directChildrenByLocalName(node, node === paragraph ? 'endParaRPr' : 'rPr')[0],
    ]
    for (const properties of defaults) {
      if (!properties) continue
      for (const attribute of Array.from(properties.attributes)) merged.setAttribute(attribute.name, attribute.value)
      const childNames = new Set<string>()
      for (const child of Array.from(properties.childNodes)) {
        if (child.nodeType !== 1) continue
        const name = (child as Element).localName
        if (childNames.has(name)) continue
        childNames.add(name)
        const old = directChildrenByLocalName(merged, (child as Element).localName)[0]
        if (old) merged.removeChild(old)
        merged.appendChild(child.cloneNode(true))
      }
    }
    return merged
  }
  const firstChunk = chunks.find(chunk => chunk.text.trim()) ?? chunks[0]!
  const runProperties = resolveRunProperties(firstChunk.node, firstChunk.paragraph)
  const resolveParagraphProperties = (paragraph: Element) => {
    const paragraphProperties = parseXml('<a:pPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>').documentElement
    for (const properties of paragraphDefaults(paragraph)) {
      if (!properties) continue
      for (const attribute of Array.from(properties.attributes)) paragraphProperties.setAttribute(attribute.name, attribute.value)
      for (const child of Array.from(properties.childNodes)) {
        if (child.nodeType !== 1) continue
        const name = (child as Element).localName
        const choices = ['buNone', 'buChar', 'buAutoNum', 'buBlip']
        for (const oldName of choices.includes(name) ? choices : [name]) {
          const old = directChildrenByLocalName(paragraphProperties, oldName)[0]
          if (old) paragraphProperties.removeChild(old)
        }
        paragraphProperties.appendChild(child.cloneNode(true))
      }
    }
    return paragraphProperties
  }
  const paragraphProperties = resolveParagraphProperties(firstChunk.paragraph)
  const bodyProperties = directChildrenByLocalName(textBody, 'bodyPr')[0]
    ?? firstByLocalName(textBody, 'bodyPr')
    ?? (fallbackTextBody ? firstByLocalName(fallbackTextBody, 'bodyPr') : null)
  const fontSizePoints = Math.max(6, numberAttribute(runProperties, 'sz', 1_800) / 100)
  const pageScaleX = pageSize.width / slideSizeEmu.width
  const pageScaleY = pageSize.height / slideSizeEmu.height
  const scaleX = Math.hypot(coordinateTransform.a * pageScaleX, coordinateTransform.b * pageScaleY)
  const scaleY = Math.hypot(coordinateTransform.c * pageScaleX, coordinateTransform.d * pageScaleY)
  const autoFit = bodyProperties ? firstByLocalName(bodyProperties, 'normAutofit') : null
  const autoFitScale = Math.max(0.01, Math.min(1, numberAttribute(autoFit, 'fontScale', 100_000) / 100_000))
  const spacingReduction = Math.max(0, Math.min(1, numberAttribute(autoFit, 'lnSpcReduction') / 100_000))
  const fontScale = scaleY * EMU_PER_INCH / 96 * autoFitScale
  const fontSize = presentationFontSizeFromPoints(fontSizePoints) * fontScale
  const weight = runProperties?.getAttribute('b') === '1' ? 700 : 400
  const alignment = paragraphProperties?.getAttribute('algn')
  const latinTypeface = firstByLocalName(runProperties ?? textBody, 'latin')?.getAttribute('typeface')
  const eastAsianTypeface = firstByLocalName(runProperties ?? textBody, 'ea')?.getAttribute('typeface')
  const typeface = presentationTextUsesCjk(text)
    ? eastAsianTypeface || latinTypeface
    : latinTypeface || eastAsianTypeface
  const lineSpacingNode = firstByLocalName(paragraphProperties, 'lnSpc')
  const lineSpacingPercent = lineSpacingNode ? numberAttribute(firstByLocalName(lineSpacingNode, 'spcPct'), 'val') : 0
  const lineSpacingPoints = lineSpacingNode ? numberAttribute(firstByLocalName(lineSpacingNode, 'spcPts'), 'val') / 100 : 0
  const characterSpacing = presentationCharacterSpacingFromPoints(
    numberAttribute(runProperties, 'spc', 0) / 100,
    fontSizePoints,
  )
  const baselineValue = numberAttribute(runProperties, 'baseline', 0)
  const importedColor = importedColorFrom(firstByLocalName(runProperties ?? textBody, 'solidFill') ?? fontReference, '#1D1D28', themeColors)
  const anchor = bodyProperties?.getAttribute('anchor')
  const textDirection = textDirectionFrom(bodyProperties?.getAttribute('vert'))
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
  const textStyleFrom = (properties: Element, content: string): PresentationTextStyle => {
    const points = Math.max(6, numberAttribute(properties, 'sz', 1_800) / 100)
    const latin = firstByLocalName(properties, 'latin')?.getAttribute('typeface')
    const eastAsian = firstByLocalName(properties, 'ea')?.getAttribute('typeface')
    const family = presentationTextUsesCjk(content) ? eastAsian || latin : latin || eastAsian
    const shift = numberAttribute(properties, 'baseline')
    const runColor = importedColorFrom(firstByLocalName(properties, 'solidFill') ?? fontReference, '#1D1D28', themeColors)
    let runBaseline: PresentationTextElement['baseline'] = 'normal'
    if (shift > 0) runBaseline = 'superscript'
    else if (shift < 0) runBaseline = 'subscript'
    return {
      fontSize: presentationFontSizeFromPoints(points) * fontScale,
      fontFamily: themeTextFont(family, content, properties.getAttribute('lang'), context.fonts),
      fontWeight: properties.getAttribute('b') === '1' ? 700 : 400,
      italic: properties.getAttribute('i') === '1',
      underline: Boolean(properties.getAttribute('u') && properties.getAttribute('u') !== 'none'),
      strikethrough: Boolean(properties.getAttribute('strike') && properties.getAttribute('strike') !== 'noStrike'),
      color: runColor.color,
      ...(runColor.opacity < 1 ? { opacity: runColor.opacity } : {}),
      baseline: runBaseline,
      characterSpacing: presentationCharacterSpacingFromPoints(numberAttribute(properties, 'spc') / 100, points),
      ...(firstByLocalName(properties, 'highlight') ? { highlightColor: colorFrom(firstByLocalName(properties, 'highlight'), '#FFFF00', themeColors) } : {}),
    }
  }
  let textOffset = 0
  const textRuns: PresentationTextRun[] = chunks.map(chunk => {
    const run: PresentationTextRun = {
      start: textOffset, end: textOffset + chunk.text.length,
      style: textStyleFrom(resolveRunProperties(chunk.node, chunk.paragraph), chunk.text),
    }
    textOffset = run.end
    return run
  }).filter(run => run.end > run.start)
  let paragraphOffset = 0
  const paragraphsWithStyles: PresentationTextParagraph[] = paragraphNodes.map(paragraph => {
    const properties = resolveParagraphProperties(paragraph)
    const spacing = firstByLocalName(properties, 'lnSpc')
    const fixed = numberAttribute(spacing ? firstByLocalName(spacing, 'spcPts') : null, 'val') / 100
    const proportional = numberAttribute(spacing ? firstByLocalName(spacing, 'spcPct') : null, 'val') / 100_000
    const paragraphChunks = chunks.filter(chunk => chunk.paragraph === paragraph && chunk.node !== paragraph)
    const sourceText = paragraphChunks.map(chunk => chunk.text).join('')
    const first = paragraphChunks.find(chunk => chunk.text.trim())
    const endStyle = !sourceText ? textStyleFrom(resolveRunProperties(paragraph, paragraph), '') : undefined
    const paragraphSize = first ? presentationFontSizeFromPoints(numberAttribute(resolveRunProperties(first.node, paragraph), 'sz', 1800) / 100) * fontScale : endStyle?.fontSize ?? fontSize
    const paragraphSpace = (name: string) => {
      const space = firstByLocalName(properties, name)
      if (!space) return 0
      const points = firstByLocalName(space, 'spcPts')
      return points ? presentationFontSizeFromPoints(numberAttribute(points, 'val') / 100) * scaleY * EMU_PER_INCH / 96
        : numberAttribute(firstByLocalName(space, 'spcPct'), 'val') / 100_000 * paragraphSize
    }
    let paragraphListStyle: PresentationTextElement['listStyle'] = 'none'
    const autoNumber = firstByLocalName(properties, 'buAutoNum')
    if (autoNumber) paragraphListStyle = 'number'
    else if (firstByLocalName(properties, 'buChar')) paragraphListStyle = 'bullet'
    const style: PresentationParagraphStyle = {
      align: textAlignmentFrom(properties.getAttribute('algn')),
      lineSpacing: fixed > 0 ? presentationFontSizeFromPoints(fixed) * scaleY * EMU_PER_INCH / 96 : 0,
      lineHeight: Math.max(0.1, (proportional || (spacingReduction ? 1 : 1.08)) - spacingReduction),
      listStyle: paragraphListStyle,
      ...(autoNumber?.getAttribute('type') ? { listNumberFormat: autoNumber.getAttribute('type')! } : {}),
      ...(firstByLocalName(properties, 'buChar')?.getAttribute('char') ? { listBulletChar: firstByLocalName(properties, 'buChar')!.getAttribute('char')! } : {}),
      ...(firstByLocalName(properties, 'buFont')?.getAttribute('typeface') ? { listMarkerFontFamily: firstByLocalName(properties, 'buFont')!.getAttribute('typeface')! } : {}),
      ...(autoNumber?.hasAttribute('startAt') ? { listStartAt: Math.max(1, Math.min(32767, numberAttribute(autoNumber, 'startAt', 1))) } : {}),
      indentLevel: Math.max(0, numberAttribute(properties, 'lvl')),
      spaceBefore: paragraphSpace('spcBef'), spaceAfter: paragraphSpace('spcAft'),
    }
    const result = { start: paragraphOffset, end: paragraphOffset + sourceText.length, style, ...(endStyle ? { endStyle } : {}) }
    paragraphOffset = result.end + 1
    return result
  })
  return {
    id: createPresentationId('text'),
    type: 'text',
    ...geometry,
    text,
    ...(textRuns.length > 1 || textRuns.some(run => run.style.opacity !== undefined) ? { textRuns } : {}),
    paragraphs: paragraphsWithStyles,
    fontSize,
    fontFamily: themeTextFont(typeface, text, runProperties.getAttribute('lang'), context.fonts),
    fontWeight: weight,
    italic: runProperties?.getAttribute('i') === '1',
    underline: Boolean(runProperties?.getAttribute('u') && runProperties?.getAttribute('u') !== 'none'),
    strikethrough: Boolean(runProperties?.getAttribute('strike') && runProperties?.getAttribute('strike') !== 'noStrike'),
    shadow: Boolean(firstByLocalName(runProperties ?? textBody, 'outerShdw')),
    color: importedColor.color,
    align: textAlignmentFrom(alignment),
    verticalAlign,
    ...(textDirection ? { textDirection } : {}),
    wordWrap: bodyProperties?.getAttribute('wrap') !== 'none',
    textInsets: {
      left: numberAttribute(bodyProperties, 'lIns', DEFAULT_TEXT_HORIZONTAL_INSET_EMU) * scaleX,
      top: numberAttribute(bodyProperties, 'tIns', DEFAULT_TEXT_VERTICAL_INSET_EMU) * scaleY,
      right: numberAttribute(bodyProperties, 'rIns', DEFAULT_TEXT_HORIZONTAL_INSET_EMU) * scaleX,
      bottom: numberAttribute(bodyProperties, 'bIns', DEFAULT_TEXT_VERTICAL_INSET_EMU) * scaleY,
    },
    ...(lineSpacingPercent > 0 || spacingReduction > 0 ? { lineHeight: Math.max(0.1, (lineSpacingPercent > 0 ? lineSpacingPercent / 100_000 : 1) - spacingReduction) } : {}),
    ...(lineSpacingPoints > 0 ? { lineSpacing: presentationFontSizeFromPoints(lineSpacingPoints) * scaleY * EMU_PER_INCH / 96 } : {}),
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
  const stroke = shapeStrokeFrom(shape, shapeProperties, themeColors)
  const strokeWidth = stroke.width
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
      body = `<path d="${xmlEscape(definition.drawingPath ?? definition.path)}" transform="scale(${width / 100} ${height / 100})" fill="${definition.strokeOnly ? 'none' : xmlEscape(fill.paint)}" fill-opacity="${fillOpacity}" fill-rule="evenodd" stroke="${xmlEscape(stroke.color)}" stroke-opacity="${stroke.opacity}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"/>`
    }
  }
  // Include centered strokes and joins up to SVG's default miter limit of four.
  const padding = strokeWidth * 2
  const paddedWidth = width + padding * 2
  const paddedHeight = height + padding * 2
  const angle = geometry.rotation * Math.PI / 180
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${paddedWidth}" height="${paddedHeight}" viewBox="${-padding} ${-padding} ${paddedWidth} ${paddedHeight}"><defs>${fill.defs}</defs>${body}</svg>`
  const sourceId = firstByLocalName(shape, 'cNvPr')?.getAttribute('id') ?? createPresentationId('shape-svg')
  return {
    id: createPresentationId('image'),
    type: 'image',
    ...geometry,
    x: geometry.x - padding * Math.cos(angle) + padding * Math.sin(angle),
    y: geometry.y - padding * Math.sin(angle) - padding * Math.cos(angle),
    width: paddedWidth,
    height: paddedHeight,
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
  const type = shapeTypeFrom(shape)
  let connectorPath: string | undefined
  if (storedConnectorType(shape)) {
    const path = firstByLocalName(shapeProperties, 'path')
    if (path && numberAttribute(path, 'w') === 1000000 && numberAttribute(path, 'h') === 1000000) {
      connectorPath = customPathData(path).replace(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, value => String(Number(value) / 10000))
    }
  } else if (isPresentationLineShape(type) && type !== 'line') {
    const bent = type === 'elbowConnector' || type === 'elbowArrow'
    const curved = type === 'curvedConnector' || type === 'curvedArrow'
    connectorPath = 'M 0 0 L 100 100'
    if (bent) connectorPath = 'M 0 0 H 50 V 100 H 100'
    if (curved) connectorPath = 'M 0 0 C 50 0 50 100 100 100'
    const arrow = (name: string, atEnd: boolean) => {
      const end = firstByLocalName(shape, name)?.getAttribute('type')
      if (!end || end === 'none') return ''
      const angle = (bent || curved ? 0 : Math.atan2(geometry.height, geometry.width)) + (atEnd ? 0 : Math.PI)
      const length = Math.max(6, shapeStrokeFrom(shape, shapeProperties, themeColors).width * 3)
      const tipX = atEnd ? geometry.width : 0
      const tipY = atEnd ? geometry.height : 0
      const point = (offset: number) => `${(tipX - Math.cos(angle + offset) * length) / geometry.width * 100} ${(tipY - Math.sin(angle + offset) * length) / geometry.height * 100}`
      return ` M ${point(-Math.PI / 6)} L ${atEnd ? '100 100' : '0 0'} L ${point(Math.PI / 6)}`
    }
    connectorPath += arrow('headEnd', false) + arrow('tailEnd', true)
  }
  if ((directChildrenByLocalName(shapeProperties, 'custGeom').length > 0 && !connectorPath) || directChildrenByLocalName(shapeProperties, 'gradFill').length > 0) {
    return svgShapeFrom(shape, geometry, themeColors)
  }
  const style = directChildrenByLocalName(shape, 'style')[0] ?? firstByLocalName(shape, 'style')
  const noFill = directChildrenByLocalName(shapeProperties, 'noFill').length > 0
  const solidFill = directChildrenByLocalName(shapeProperties, 'solidFill')[0]
    ?? (style ? firstByLocalName(style, 'fillRef') : null)
  const importedFill = importedColorFrom(solidFill, 'transparent', themeColors)
  const fill = noFill || importedFill.opacity === 0 ? 'transparent' : importedFill.color
  const stroke = shapeStrokeFrom(shape, shapeProperties, themeColors)
  if (fill !== 'transparent' && stroke.width > 0 && stroke.opacity !== importedFill.opacity) return svgShapeFrom(shape, geometry, themeColors)
  const borderColor = stroke.color
  const borderWidth = stroke.width
  const opacity = fill === 'transparent' ? stroke.opacity : importedFill.opacity
  if (fill === 'transparent' && borderColor === 'transparent') return null
  return {
    id: createPresentationId('shape'),
    type,
    ...geometry,
    ...(connectorPath ? { connectorPath } : {}),
    fill,
    borderColor,
    borderWidth,
    ...(opacity < 1 ? { opacity } : {}),
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
  const layoutPath = [...relationships.values()].find((target) => target.includes('/slideLayouts/'))
  const layoutFile = layoutPath ? archive.file(layoutPath) : null
  const layoutDocument = layoutFile ? parseXml(await layoutFile.async('text')) : null
  const layoutRelationships = layoutPath ? await relationshipTargets(archive, layoutPath) : new Map<string, string>()
  const masterPath = [...layoutRelationships.values()].find((target) => target.includes('/slideMasters/'))
  const masterFile = masterPath ? archive.file(masterPath) : null
  const masterDocument = masterFile ? parseXml(await masterFile.async('text')) : null
  const masterRelationships = masterPath ? await relationshipTargets(archive, masterPath) : new Map<string, string>()
  const themePath = [...masterRelationships.values()].find(target => target.includes('/theme/'))
  const [themeColors, fonts, presentationXml] = await Promise.all([
    themeColorsFromArchive(archive, themePath), themeFontsFromArchive(archive, themePath), archive.file('ppt/presentation.xml')!.async('text'),
  ])
  const textContext: TextImportContext = {
    fonts,
    defaultTextStyle: firstByLocalName(parseXml(presentationXml), 'defaultTextStyle'),
    masterTextStyles: masterDocument ? firstByLocalName(masterDocument, 'txStyles') : null,
  }
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

  const imageSourceFromBlip = async (blip: Element | null, relationshipMap: ReadonlyMap<string, string>) => {
    const svgBlip = blip ? firstByLocalName(blip, 'svgBlip') : null
    const relationshipId = blip?.getAttribute('r:embed')
      || blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
      || svgBlip?.getAttribute('r:embed')
      || svgBlip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
    const target = relationshipId ? relationshipMap.get(relationshipId) : null
    const image = target ? archive.file(target) : null
    if (!target || !image) return null
    const mimeType = mimeTypeForPath(target)
    return {
      dataUrl: bytesToDataUrl(await image.async('uint8array'), mimeType),
      fileName: target.slice(target.lastIndexOf('/') + 1),
      mimeType,
    }
  }

  const imageCropFrom = (fill: Element | null) => {
    const cropNode = fill ? firstByLocalName(fill, 'srcRect') : null
    return cropNode ? {
      left: Math.max(0, Math.min(0.999, numberAttribute(cropNode, 'l') / 100_000)),
      top: Math.max(0, Math.min(0.999, numberAttribute(cropNode, 't') / 100_000)),
      right: Math.max(0, Math.min(0.999, numberAttribute(cropNode, 'r') / 100_000)),
      bottom: Math.max(0, Math.min(0.999, numberAttribute(cropNode, 'b') / 100_000)),
    } : undefined
  }

  const importShape = async (
    shape: Element,
    coordinateTransform: CoordinateTransform,
    relationshipMap: ReadonlyMap<string, string>,
    parentGroupId?: string,
  ) => {
    const fallbackShape = placeholderPrototypeFor(shape)
    const geometry = shapeGeometry(shape, pageSize, slideSizeEmu, coordinateTransform, fallbackShape)
    const shapeProperties = directChildrenByLocalName(shape, 'spPr')[0] ?? firstByLocalName(shape, 'spPr')
    const blipFill = shapeProperties ? directChildrenByLocalName(shapeProperties, 'blipFill')[0] ?? null : null
    const blip = blipFill ? firstByLocalName(blipFill, 'blip') : null
    const imageSource = await imageSourceFromBlip(blip, relationshipMap)
    const opacity = opacityFrom(blip)
    const crop = imageCropFrom(blipFill)
    const visual: PresentationShapeElement | PresentationImageElement | null = imageSource ? {
      id: createPresentationId('image'),
      type: 'image',
      ...geometry,
      altText: firstByLocalName(shape, 'cNvPr')?.getAttribute('descr') ?? '',
      fit: 'cover',
      ...(crop ? { crop } : {}),
      ...(shapeTypeFrom(shape) === 'ellipse' ? { clipShape: 'ellipse' as const } : {}),
      ...(opacity < 1 ? { opacity } : {}),
      shadow: Boolean(shapeProperties && firstByLocalName(shapeProperties, 'outerShdw')),
      source: imageSource,
    } : visualShapeFrom(shape, geometry, themeColors)
    const text = textFrom(shape, geometry, pageSize, slideSizeEmu, themeColors, fallbackShape, coordinateTransform, textContext)
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
    const source = await imageSourceFromBlip(blip, relationshipMap)
    if (!source) return
    const geometry = shapeGeometry(picture, pageSize, slideSizeEmu, coordinateTransform)
    const crop = imageCropFrom(picture)
    const opacity = opacityFrom(blip)
    const importedImage: PresentationImageElement = withGroup({
      id: createPresentationId('image'),
      type: 'image',
      ...geometry,
      altText: firstByLocalName(picture, 'cNvPr')?.getAttribute('descr') ?? '',
      fit: crop ? 'cover' : 'contain',
      ...(shapeTypeFrom(picture) === 'ellipse' ? { clipShape: 'ellipse' as const } : {}),
      ...(crop ? { crop } : {}),
      ...(opacity < 1 ? { opacity } : {}),
      shadow: Boolean(firstByLocalName(picture, 'outerShdw')),
      source,
    }, parentGroupId)
    elements.push(importedImage)
    const sourceId = firstByLocalName(picture, 'cNvPr')?.getAttribute('id')
    if (sourceId) sourceShapeIds.set(sourceId, importedImage.id)
  }

  const cachedValues = (root: Element | null): string[] => {
    if (!root) return []
    const cache = firstByLocalName(root, 'strCache') ?? firstByLocalName(root, 'numCache') ?? root
    const points = elementsByLocalName(cache, 'pt')
      .map((point) => ({
        index: numberAttribute(point, 'idx'),
        value: firstByLocalName(point, 'v')?.textContent ?? '',
      }))
      .filter(point => Number.isInteger(point.index) && point.index >= 0)
    const declaredCount = numberAttribute(firstByLocalName(cache, 'ptCount'), 'val')
    const count = points.reduce((size, point) => Math.max(size, point.index + 1), Math.max(0, Math.floor(declaredCount)))
    if (count > 1_048_576) throw new Error('PowerPoint chart cache exceeds the supported worksheet size')
    const values = Array.from({ length: count }, () => '')
    for (const point of points) values[point.index] = point.value
    return values
  }

  const importGraphicFrame = async (
    frame: Element,
    coordinateTransform: CoordinateTransform,
    relationshipMap: ReadonlyMap<string, string>,
    parentGroupId?: string,
  ) => {
    const geometry = shapeGeometry(frame, pageSize, slideSizeEmu, coordinateTransform)
    // A mirrored group can decompose into a half-turn plus a vertical flip.
    // Graphic frames preserve the equivalent flips without enabling rotation.
    if (Math.abs(Math.abs(geometry.rotation) - 180) < 0.000001) {
      geometry.x -= geometry.width
      geometry.y -= geometry.height
      geometry.rotation = 0
      geometry.flipHorizontal = !geometry.flipHorizontal
      geometry.flipVertical = !geometry.flipVertical
    }
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
      const headerRow = /^(1|true)$/.test(firstByLocalName(table, 'tblPr')?.getAttribute('firstRow') ?? '')
      const secondRow = directChildrenByLocalName(table, 'tr')[1] ?? null
      const bodyCell = headerRow && secondRow ? firstByLocalName(secondRow, 'tc') : firstCell
      const bodyCellProperties = bodyCell ? firstByLocalName(bodyCell, 'tcPr') : null
      const bodyRunProperties = bodyCell ? firstByLocalName(bodyCell, 'rPr') : null
      const cellFill = (properties: Element | null) => properties ? directChildrenByLocalName(properties, 'solidFill')[0] ?? null : null
      const line = firstCellProperties ? firstByLocalName(firstCellProperties, 'ln') : null
      const importedTable: PresentationTableElement = withGroup({
        id: createPresentationId('table'),
        type: 'table',
        ...geometry,
        cells: rows,
        headerRow,
        headerFill: colorFrom(cellFill(firstCellProperties), '#F4F1FF', themeColors),
        ...(headerRow ? { headerTextColor: colorFrom(firstRunProperties, '#20202B', themeColors) } : {}),
        bodyFill: colorFrom(cellFill(bodyCellProperties), '#FFFFFF', themeColors),
        textColor: colorFrom(bodyRunProperties, '#20202B', themeColors),
        borderColor: colorFrom(firstByLocalName(line ?? table, 'solidFill'), '#D9D7E2', themeColors),
        fontSize: presentationFontSizeFromPoints(Math.max(6, numberAttribute(firstRunProperties, 'sz', 1_400) / 100))
          * Math.hypot(coordinateTransform.c * pageSize.width / slideSizeEmu.width, coordinateTransform.d * pageSize.height / slideSizeEmu.height) * EMU_PER_INCH / 96,
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
      if (!solidFill) return fallback
      const imported = importedColorFrom(solidFill, fallback, themeColors)
      return imported.opacity === 0 ? 'transparent' : imported.color
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
      const values = cachedValues(firstByLocalName(seriesNode, 'val')).map(value => value.trim() === '' ? null : Number(value))
      const name = firstByLocalName(firstByLocalName(seriesNode, 'tx') ?? seriesNode, 'v')?.textContent?.trim()
      return {
        name: name || `Series ${seriesIndex + 1}`,
        values: values.map(value => value === null || Number.isFinite(value) ? value : null),
      }
    })
    const categories = cachedValues(firstByLocalName(seriesNodes[0] ?? chartRoot, 'cat'))
    const seriesColors = seriesNodes.map((seriesNode, seriesIndex) => (
      colorFrom(firstByLocalName(firstByLocalName(seriesNode, 'spPr') ?? seriesNode, 'solidFill'), ['#4472C4', '#ED7D31', '#A5A5A5'][seriesIndex % 3]!, themeColors)
    ))
    let colors = seriesColors
    if (chartType === 'pie' || chartType === 'doughnut') {
      const points = new Map(directChildrenByLocalName(seriesNodes[0] ?? chartRoot, 'dPt').map(point => [
        numberAttribute(firstByLocalName(point, 'idx'), 'val'),
        directChildrenByLocalName(point, 'spPr')[0] ?? null,
      ]))
      const varyColors = !/^(0|false)$/.test(firstByLocalName(chartRoot, 'varyColors')?.getAttribute('val') ?? '')
      colors = Array.from({ length: Math.max(categories.length, series[0]?.values.length ?? 0) }, (_, index) => {
        const fallback = (varyColors ? themeColors.get(`accent${index % 6 + 1}`) : seriesColors[0]) ?? '#4472C4'
        return colorFrom(points.get(index) ?? null, fallback, themeColors)
      })
    }
    const chartAreaProperties = directChildrenByLocalName(chartDocument.documentElement, 'spPr')[0] ?? null
    const plotAreaProperties = plotArea ? directChildrenByLocalName(plotArea, 'spPr')[0] ?? null : null
    const categoryAxis = plotArea ? firstByLocalName(plotArea, 'catAx') : null
    const valueAxis = plotArea ? firstByLocalName(plotArea, 'valAx') : null
    // Pie-family charts have no axes; their shared text color lives in the legend/title.
    const titleColor = colorFrom(firstByLocalName(chartDocument, 'title'), '#666571', themeColors)
    const chartTextColor = colorFrom(chartChild(firstByLocalName(chartDocument, 'legend'), 'txPr'), titleColor, themeColors)
    const dataLabels = directChildrenByLocalName(chartRoot, 'dLbls')[0] ?? firstByLocalName(chartRoot, 'dLbls')
    const showValue = Boolean(dataLabels && elementsByLocalName(dataLabels, 'showVal').some(node => /^(1|true)$/.test(node.getAttribute('val') ?? '')))
    const importedChart: PresentationChartElement = withGroup({
      id: createPresentationId('chart'),
      type: 'chart',
      ...geometry,
      chartType,
      categories: categories.length > 0 ? categories : series[0]?.values.map((_, valueIndex) => `${valueIndex + 1}`) ?? [],
      series,
      showLegend: Boolean(firstByLocalName(chartDocument, 'legend')),
      showValue,
      displayBlanksAs: presentationChartBlankDisplay(firstByLocalName(chartDocument, 'dispBlanksAs')?.getAttribute('val') ?? undefined),
      ...(chartType === 'doughnut' ? { holeSize: presentationChartHoleSize(numberAttribute(firstByLocalName(chartRoot, 'holeSize'), 'val', 50)) } : {}),
      title: elementsByLocalName(firstByLocalName(chartDocument, 'title') ?? chartDocument, 't').map((node) => node.textContent ?? '').join('').trim() || undefined,
      colors,
      chartAreaFill: chartFill(chartAreaProperties, '#FFFFFF'),
      plotAreaFill: chartFill(plotAreaProperties, 'transparent'),
      categoryAxisLabelColor: colorFrom(chartChild(categoryAxis, 'txPr'), chartTextColor, themeColors),
      valueAxisLabelColor: colorFrom(chartChild(valueAxis, 'txPr'), chartTextColor, themeColors),
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
    const angle = numberAttribute(transform, 'rot') / 60_000 * Math.PI / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const flipX = transform.getAttribute('flipH') === '1' ? -1 : 1
    const flipY = transform.getAttribute('flipV') === '1' ? -1 : 1
    const a = cos * childScaleX * flipX
    const b = sin * childScaleX * flipX
    const c = -sin * childScaleY * flipY
    const d = cos * childScaleY * flipY
    const childCenterX = numberAttribute(childOffset, 'x') + numberAttribute(childExtent, 'cx') / 2
    const childCenterY = numberAttribute(childOffset, 'y') + numberAttribute(childExtent, 'cy') / 2
    return composeTransform(parent, {
      a, b, c, d,
      e: numberAttribute(offset, 'x') + numberAttribute(extent, 'cx') / 2 - a * childCenterX - c * childCenterY,
      f: numberAttribute(offset, 'y') + numberAttribute(extent, 'cy') / 2 - b * childCenterX - d * childCenterY,
    })
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
      if (child.localName === 'sp' || child.localName === 'cxnSp') await importShape(child, coordinateTransform, relationshipMap, parentGroupId)
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

  const showInheritedShapes = !['0', 'false'].includes(document.documentElement.getAttribute('showMasterSp') ?? '')
  const showMasterShapes = showInheritedShapes && !['0', 'false'].includes(layoutDocument?.documentElement.getAttribute('showMasterSp') ?? '')
  const masterShapeTree = masterDocument ? firstByLocalName(masterDocument, 'spTree') : null
  if (showMasterShapes && masterShapeTree) {
    await importTree(masterShapeTree, ROOT_COORDINATE_TRANSFORM, masterRelationships, undefined, true)
  }
  const layoutShapeTree = layoutDocument ? firstByLocalName(layoutDocument, 'spTree') : null
  if (showInheritedShapes && layoutShapeTree) await importTree(layoutShapeTree, ROOT_COORDINATE_TRANSFORM, layoutRelationships, undefined, true)
  sourceShapeIds.clear()
  const shapeTree = firstByLocalName(document, 'spTree')
  if (shapeTree) await importTree(shapeTree, ROOT_COORDINATE_TRANSFORM, relationships)
  elements = applyImportedAnimations(document, sourceShapeIds, elements)
  const backgroundOwner = [
    { document, relationships },
    { document: layoutDocument, relationships: layoutRelationships },
    { document: masterDocument, relationships: masterRelationships },
  ].find(owner => owner.document && firstByLocalName(owner.document, 'bg'))
  const backgroundRoot = backgroundOwner?.document ? firstByLocalName(backgroundOwner.document, 'bg') : null
  const background = colorFrom(backgroundRoot, '#FFFFFF', themeColors)
  const backgroundBlip = backgroundRoot ? firstByLocalName(backgroundRoot, 'blip') : null
  const backgroundSource = backgroundOwner
    ? await imageSourceFromBlip(backgroundBlip, backgroundOwner.relationships)
    : null
  if (backgroundSource) {
    elements.unshift({
      id: createPresentationId('image'),
      type: 'image',
      x: 0,
      y: 0,
      width: pageSize.width,
      height: pageSize.height,
      rotation: 0,
      opacity: opacityFrom(backgroundBlip),
      altText: '',
      fit: 'cover',
      shadow: false,
      source: backgroundSource,
    })
  }
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

export interface PresentationPptxImportOptions {
  /** One-based source slide numbers. Omit to import the complete deck. */
  slideNumbers?: readonly number[]
}

/** Import common editable PowerPoint content from an OOXML .pptx archive. */
export async function importPresentationPptx(
  bytes: ArrayBuffer | Uint8Array,
  fileName = 'Imported presentation.pptx',
  options: PresentationPptxImportOptions = {},
): Promise<PresentationDocument> {
  const archive = await JSZip.loadAsync(bytes)
  const themeColors = await themeColorsFromArchive(archive)
  const accentColors = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].flatMap((name) => {
    const color = themeColors.get(name)
    return color ? [`#${color}`] : []
  })
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
  const requestedSlideNumbers = options.slideNumbers
    ? [...new Set(options.slideNumbers.filter(number => Number.isInteger(number) && number >= 1 && number <= slidePaths.length))]
    : []
  const selectedSlideNumbers = options.slideNumbers && requestedSlideNumbers.length === 0
    ? [1]
    : requestedSlideNumbers
  const selectedSlides = selectedSlideNumbers.length > 0
    ? selectedSlideNumbers.map(number => ({ path: slidePaths[number - 1]!, sourceIndex: number - 1 }))
    : slidePaths.map((path, sourceIndex) => ({ path, sourceIndex }))
  const slides = await Promise.all(selectedSlides.map(({ path, sourceIndex }) => (
    importSlide(archive, path, pageSize, slideSizeEmu, sourceIndex)
  )))
  return {
    id: createPresentationId('presentation'),
    master: {
      ...DEFAULT_PRESENTATION_MASTER,
      accentColors: accentColors.length > 0 ? accentColors : [...DEFAULT_PRESENTATION_MASTER.accentColors],
      footer: { ...DEFAULT_PRESENTATION_MASTER.footer },
    },
    pageSize,
    selectedSlideId: slides[0]!.id,
    slides,
    title: fileName.replace(/\.pptx$/i, '') || 'Imported presentation',
    version: 1,
  }
}
