import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import { i18n } from '@/lib/i18n'
import { createDefaultPresentationTransition } from '@/lib/presentationTransitions'
import { presentationTextDisplaySegments, presentationTextGraphemes, presentationTextParagraphs, presentationParagraphSegments, presentationParagraphTextStyle, patchPresentationText, usesPresentationUprightVerticalGlyph, usesPresentationVerticalGlyphLayout } from '@/lib/presentationText'
import { viewedSessionIdAtom } from './navigation'

export const PRESENTATION_WIDTH = 1280
export const PRESENTATION_HEIGHT = 720
export const PRESENTATION_STANDARD_WIDTH = 960

export type PresentationPageSizePreset = 'wide' | 'standard'

export type PresentationPaneView = 'progress' | 'sources' | 'outline' | 'templates'

export const presentationPaneViewFamily = atomFamily(
  (_sessionId: string) => atom<PresentationPaneView>('progress'),
)

export const presentationTemplateSelectionFamily = atomFamily(
  (_requestId: string) => atom<string | null>(null),
)

/** Release the transient selection shared by one template interaction and its gallery. */
export function releasePresentationTemplateSelectionState(requestId: string | null | undefined): void {
  if (requestId) presentationTemplateSelectionFamily.remove(requestId)
}

export interface PresentationPageSize {
  height: number
  preset: PresentationPageSizePreset
  width: number
}

export const PRESENTATION_PAGE_SIZES: Record<PresentationPageSizePreset, PresentationPageSize> = {
  wide: { width: PRESENTATION_WIDTH, height: PRESENTATION_HEIGHT, preset: 'wide' },
  standard: { width: PRESENTATION_STANDARD_WIDTH, height: PRESENTATION_HEIGHT, preset: 'standard' },
}

export function getPresentationPageSize(document: Pick<PresentationProject, 'pageSize'> | null | undefined): PresentationPageSize {
  const size = document?.pageSize
  return size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
    ? size
    : PRESENTATION_PAGE_SIZES.wide
}

export const PRESENTATION_ANIMATION_EFFECTS = [
  'none', 'appear', 'fade', 'blinds', 'checkerboard', 'dissolve', 'flyIn', 'floatIn',
  'split', 'wipeIn', 'zoomIn', 'zoom', 'fillColor', 'textColor', 'disappear', 'blindsOut',
] as const
export const PRESENTATION_ANIMATION_STARTS = ['onClick', 'withPrevious', 'afterPrevious'] as const
export const PRESENTATION_ANIMATION_TRIGGERS = ['slideClick', 'elementClick'] as const
export const PRESENTATION_TRANSITION_EFFECTS = ['none', 'fade', 'push', 'wipe', 'reveal', 'cover', 'zoom', 'flip', 'cube'] as const
export const PRESENTATION_TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down', 'in', 'out'] as const
export const PRESENTATION_SLIDE_LAYOUTS = ['blank', 'title', 'titleContent', 'twoContent'] as const

export type PresentationAnimationEffect = (typeof PRESENTATION_ANIMATION_EFFECTS)[number]
export type PresentationAnimationStart = (typeof PRESENTATION_ANIMATION_STARTS)[number]
export type PresentationAnimationTrigger = (typeof PRESENTATION_ANIMATION_TRIGGERS)[number]
export type PresentationTransitionEffect = (typeof PRESENTATION_TRANSITION_EFFECTS)[number]
export type PresentationTransitionDirection = (typeof PRESENTATION_TRANSITION_DIRECTIONS)[number]
export type PresentationSlideLayout = (typeof PRESENTATION_SLIDE_LAYOUTS)[number]

export type PresentationHyperlink =
  | { type: 'url'; url: string; tooltip?: string }
  | { type: 'slide'; slideId: string; tooltip?: string }

export interface PresentationFileSource {
  assetId?: string
  dataUrl: string
  fileName: string
  mimeType: string
  path?: string
}

export type PresentationAssetKind = 'image' | 'audio' | 'video'
export type PresentationAssetSource = Omit<PresentationFileSource, 'assetId'>

/** One project-owned media resource referenced by slide elements. */
export interface PresentationAsset {
  id: string
  kind: PresentationAssetKind
  name: string
  source: PresentationAssetSource
}

export interface PresentationTransition {
  effect: PresentationTransitionEffect
  durationMs: number
  direction?: PresentationTransitionDirection
  throughBlack?: boolean
}

export const PRESENTATION_SHAPE_TYPES = [
  'line', 'lineArrow', 'lineDoubleArrow', 'elbowConnector', 'elbowArrow', 'curvedConnector',
  'curvedArrow', 'rect', 'roundRect', 'snip1Rect', 'snip2DiagRect', 'round1Rect',
  'round2SameRect', 'frame', 'ellipse', 'triangle', 'rtTriangle', 'parallelogram', 'trapezoid',
  'diamond', 'pentagon', 'hexagon', 'octagon', 'decagon', 'dodecagon', 'pie', 'teardrop',
  'plus', 'star4', 'star5', 'star6', 'star8', 'heart', 'lightningBolt', 'sun', 'moon',
  'cloud', 'donut', 'arc', 'smileyFace', 'can', 'cube', 'bevel', 'bracePair', 'bracketPair',
  'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', 'upDownArrow',
  'quadArrow', 'bentArrow', 'bentUpArrow', 'uturnArrow', 'circularArrow', 'chevron',
  'notchedRightArrow', 'stripedRightArrow', 'rightArrowCallout', 'leftArrowCallout',
  'upArrowCallout', 'downArrowCallout', 'mathPlus', 'mathMinus', 'mathMultiply', 'mathDivide',
  'mathEqual', 'mathNotEqual', 'flowChartProcess', 'flowChartAlternateProcess',
  'flowChartDecision', 'flowChartInputOutput', 'flowChartDocument', 'flowChartMultidocument',
  'flowChartTerminator', 'flowChartPreparation', 'flowChartManualInput',
  'flowChartManualOperation', 'flowChartConnector', 'flowChartOffpageConnector',
  'flowChartDelay', 'flowChartDisplay', 'flowChartPredefinedProcess', 'flowChartInternalStorage',
] as const

export type PresentationShapeType = (typeof PRESENTATION_SHAPE_TYPES)[number]

export interface PresentationElementBase {
  id: string
  /** Elements sharing a group id behave as one visual object for selection and animation. */
  groupId?: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  /** Mirror the element around its own horizontal or vertical axis. */
  flipHorizontal?: boolean
  flipVertical?: boolean
  /** Visual opacity in the inclusive range 0..1. */
  opacity?: number
  animation?: PresentationAnimationEffect
  animationDuration?: number
  animationDelay?: number
  animationStart?: PresentationAnimationStart
  animationTrigger?: PresentationAnimationTrigger
  animationColor?: string
  shadow?: boolean
  hyperlink?: PresentationHyperlink
}

export interface PresentationTextElement extends PresentationElementBase {
  type: 'text'
  text: string
  /** Inline style ranges use UTF-16 offsets into text, excluding generated list markers. */
  textRuns?: PresentationTextRun[]
  /** Paragraph ranges exclude their terminating newline; internal newlines are soft breaks. */
  paragraphs?: PresentationTextParagraph[]
  fontSize: number
  fontFamily: string
  fontWeight: 400 | 500 | 600 | 700
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  baseline?: 'normal' | 'superscript' | 'subscript'
  highlightColor?: string
  characterSpacing?: number
  lineHeight?: number
  /** Fixed line advance in model pixels, independent of run font sizes. */
  lineSpacing?: number
  indentLevel?: number
  listStyle?: 'none' | 'bullet' | 'number'
  color: string
  align: 'left' | 'center' | 'right' | 'justify'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  /** Text flow inside the box. East Asian vertical text keeps glyphs upright. */
  textDirection?: 'horizontal' | 'eastAsianVertical' | 'vertical' | 'vertical270' | 'stacked'
  /** PowerPoint text boxes can deliberately allow text to overflow without wrapping. */
  wordWrap?: boolean
  textInsets?: {
    left: number
    top: number
    right: number
    bottom: number
  }
}

export type PresentationTextStyle = Partial<Pick<PresentationTextElement,
  'fontSize' | 'fontFamily' | 'fontWeight' | 'italic' | 'underline' | 'strikethrough'
  | 'baseline' | 'highlightColor' | 'characterSpacing' | 'color'
>> & { opacity?: number }

export interface PresentationTextRun {
  start: number
  end: number
  style: PresentationTextStyle
}

export type PresentationParagraphStyle = Partial<Pick<PresentationTextElement,
  'align' | 'lineHeight' | 'lineSpacing' | 'indentLevel' | 'listStyle'
>> & {
  spaceBefore?: number
  spaceAfter?: number
  /** Start of a numbering sequence; repeated values at the same level continue that sequence. */
  listStartAt?: number
  listNumberFormat?: string
  listBulletChar?: string
  listMarkerFontFamily?: string
}

export interface PresentationTextParagraph {
  start: number
  end: number
  style: PresentationParagraphStyle
  endStyle?: PresentationTextStyle
}

export interface PresentationShapeElement extends PresentationElementBase {
  type: PresentationShapeType
  fill: string
  borderColor: string
  borderWidth: number
  radius?: number
  /** Connector geometry in a 100 x 100 coordinate space. */
  connectorPath?: string
}

export interface PresentationImageElement extends PresentationElementBase {
  type: 'image'
  sourceAssetId: string
  altText: string
  fit: 'contain' | 'cover'
  /** Preserve an OOXML picture-filled shape as an editable image crop. */
  clipShape?: 'ellipse'
  /** Normalized source crop fractions copied from OOXML a:srcRect. */
  crop?: {
    left: number
    top: number
    right: number
    bottom: number
  }
}

export interface PresentationAudioElement extends PresentationElementBase {
  type: 'audio'
  sourceAssetId: string
  autoplay: boolean
  loop: boolean
  muted: boolean
}

export interface PresentationVideoElement extends PresentationElementBase {
  type: 'video'
  sourceAssetId: string
  autoplay: boolean
  loop: boolean
  muted: boolean
}

export type PresentationMediaElement = PresentationAudioElement | PresentationVideoElement

export interface PresentationTableElement extends PresentationElementBase {
  type: 'table'
  cells: string[][]
  headerRow: boolean
  headerFill: string
  headerTextColor?: string
  bodyFill: string
  textColor: string
  borderColor: string
  fontSize: number
}

export const PRESENTATION_CHART_TYPES = ['column', 'bar', 'line', 'pie', 'doughnut'] as const
export type PresentationChartType = (typeof PRESENTATION_CHART_TYPES)[number]

export interface PresentationChartSeries {
  name: string
  values: Array<number | null>
}

export interface PresentationChartElement extends PresentationElementBase {
  type: 'chart'
  chartType: PresentationChartType
  categories: string[]
  series: PresentationChartSeries[]
  showLegend: boolean
  showValue?: boolean
  displayBlanksAs?: 'gap' | 'zero' | 'span'
  holeSize?: number
  title?: string
  colors: string[]
  chartAreaFill?: string
  plotAreaFill?: string
  categoryAxisLabelColor?: string
  valueAxisLabelColor?: string
  gridLineColor?: string
  dataLabelColor?: string
}

export type PresentationElement =
  | PresentationTextElement
  | PresentationShapeElement
  | PresentationImageElement
  | PresentationMediaElement
  | PresentationTableElement
  | PresentationChartElement

export interface PresentationFooter {
  text: string
  showDate: boolean
  showSlideNumber: boolean
}

export interface PresentationComment {
  author: string
  createdAt: string
  elementId?: string
  id: string
  resolved: boolean
  text: string
}

export interface PresentationVerticalTextLayout {
  columnAdvance: number
  columnOffsets: number[]
  columns: string[]
  items: PresentationVerticalTextLayoutItem[][]
  rowAdvance: number
  rowsPerColumn: number
  sourceOffsets: number[][]
  glyphStyles: PresentationTextStyle[][]
  rowOffsets: number[][]
  columnHeights: number[]
}

export interface PresentationVerticalTextLayoutItem {
  blockSize: number
  inlineSize: number
  rotation: 0 | 90
  rowOffset: number
  sourceOffset: number
  style: PresentationTextStyle
  text: string
}

/** Flow vertical glyphs and rotated Latin runs down the frame, then continue in columns from right to left. */
export function layoutPresentationVerticalText(element: PresentationTextElement, measureText?: (text: string, style: PresentationTextStyle) => number): PresentationVerticalTextLayout {
  const insets = element.textInsets ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const contentWidth = Math.max(0, element.width - insets.left - insets.right)
  const contentHeight = Math.max(element.fontSize, element.height - insets.top - insets.bottom)
  // Tracking follows the glyphs down a column; paragraph line spacing separates columns.
  const rowAdvance = Math.max(1, element.fontSize * (1 + (element.characterSpacing ?? 0) / 1_000))
  const columnAdvance = element.lineSpacing ?? element.fontSize * (element.lineHeight ?? 1.2)
  const rowsPerColumn = Math.max(1, Math.floor((contentHeight - element.fontSize) / rowAdvance) + 1)
  const columns: string[] = []
  const items: PresentationVerticalTextLayoutItem[][] = []
  const sourceOffsets: number[][] = []
  const glyphStyles: PresentationTextStyle[][] = []
  const rowOffsets: number[][] = []
  const columnWidths: number[] = []
  const columnHeights: number[] = []
  const columnParagraphs: ReturnType<typeof presentationTextParagraphs> = []
  for (const [paragraphIndex, paragraphStyle] of presentationTextParagraphs(element).entries()) {
    let column = 0
    let nextRow = 0
    const startColumn = () => {
      column = columns.length
      columns.push(''); items.push([]); sourceOffsets.push([]); rowOffsets.push([]); glyphStyles.push([])
      columnParagraphs.push(paragraphStyle)
      columnWidths.push(presentationParagraphTextStyle(element, paragraphStyle).fontSize ?? element.fontSize); columnHeights.push(0)
      nextRow = 0
    }
    const sidewaysWidth = (text: string, style: PresentationTextStyle) => {
      if (measureText) return Math.max(1, measureText(text, style))
      const size = style.fontSize ?? element.fontSize
      const glyphs = presentationTextGraphemes(text)
      const ink = glyphs.reduce((sum, glyph) => {
        let ratio = 0.6
        if (/\s/u.test(glyph)) ratio = 0.33
        else if (/[ilI1.,'!|]/u.test(glyph)) ratio = 0.3
        else if (/[mwMW@#%&]/u.test(glyph)) ratio = 0.85
        return sum + size * ratio
      }, 0)
      return Math.max(1, ink + Math.max(0, glyphs.length - 1) * size * (style.characterSpacing ?? element.characterSpacing ?? 0) / 1_000)
    }
    const appendGlyph = (glyph: string, offset: number, style: PresentationTextStyle) => {
      const size = style.fontSize ?? element.fontSize
      let last = items[column]!.at(-1)
      const sidewaysWhitespace = /^[ \t]$/u.test(glyph) && last?.rotation === 90
      const rotation = element.textDirection === 'eastAsianVertical' && (!/\s/u.test(glyph) || sidewaysWhitespace) && !usesPresentationUprightVerticalGlyph(glyph) ? 90 : 0
      let merge = rotation === 90 && last?.rotation === 90 && last.style === style
      let inlineSize = size
      if (rotation === 90) inlineSize = sidewaysWidth(merge ? last!.text + glyph : glyph, style)
      let addedSize = merge ? inlineSize - last!.inlineSize : inlineSize
      if (element.wordWrap !== false && columns[column] && nextRow + addedSize > contentHeight) {
        if (/^[ \t]$/u.test(glyph)) return
        startColumn()
        last = undefined
        merge = false
        inlineSize = rotation === 90 ? sidewaysWidth(glyph, style) : size
        addedSize = inlineSize
      }
      const glyphOffset = merge ? last!.rowOffset + last!.inlineSize : nextRow
      columns[column] += glyph
      sourceOffsets[column]!.push(offset)
      glyphStyles[column]!.push(style)
      rowOffsets[column]!.push(glyphOffset)
      if (merge) {
        last!.text += glyph
        last!.inlineSize = inlineSize
      } else {
        items[column]!.push({ blockSize: size, inlineSize, rotation, rowOffset: nextRow, sourceOffset: offset, style, text: glyph })
      }
      columnWidths[column] = Math.max(columnWidths[column]!, size)
      columnHeights[column] = Math.max(columnHeights[column]!, (merge ? last!.rowOffset : nextRow) + inlineSize)
      nextRow = (merge ? last!.rowOffset : nextRow) + inlineSize + size * (style.characterSpacing ?? element.characterSpacing ?? 0) / 1_000
    }
    startColumn()
    for (const segment of presentationParagraphSegments(element, paragraphStyle, paragraphIndex)) {
      let offset = segment.start
      for (const glyph of presentationTextGraphemes(segment.text)) {
        if (glyph === '\n') {
          startColumn()
          offset += glyph.length
          continue
        }
        const style = segment.style
        appendGlyph(glyph, offset, style)
        if (segment.end > segment.start) offset += glyph.length
      }
    }
  }
  const firstSpace = columnParagraphs[0]?.style.spaceBefore ?? 0
  const lastSpace = columnParagraphs[columnParagraphs.length - 1]?.style.spaceAfter ?? 0
  const advances = columnWidths.map((width, index) => {
    const paragraph = columnParagraphs[index]!
    const next = columnParagraphs[index + 1]
    return (paragraph.style.lineSpacing || width * (paragraph.style.lineHeight ?? 1.2))
      + (next && paragraph !== next ? (paragraph.style.spaceAfter ?? 0) + (next.style.spaceBefore ?? 0) : 0)
  })
  const blockWidth = firstSpace + lastSpace + columnWidths.reduce((sum, width, index) => sum + (index === columnWidths.length - 1 ? width : advances[index]!), 0)
  const availableWidth = Math.max(0, contentWidth - blockWidth)
  let blockLeft = 0
  if (element.align === 'right') blockLeft = availableWidth
  else if (element.align === 'center') blockLeft = availableWidth / 2
  let columnRight = blockLeft + blockWidth - firstSpace
  const columnOffsets = columnWidths.map((width, index) => {
    const left = columnRight - width
    columnRight -= advances[index]!
    return Math.round(left * 1_000_000) / 1_000_000
  })
  return {
    columnAdvance,
    columnOffsets,
    columns,
    items,
    rowAdvance,
    rowsPerColumn,
    sourceOffsets,
    glyphStyles,
    rowOffsets,
    columnHeights,
  }
}

/** Add visual list markers while keeping the underlying editable text marker-free. */
export function formatPresentationText(element: PresentationTextElement): string {
  const listed = presentationTextDisplaySegments(element).map(segment => segment.text).join('')
  if (!usesPresentationVerticalGlyphLayout(element)) return listed
  const layout = layoutPresentationVerticalText(element)
  if (layout.items.some(column => column.some(item => item.rotation === 90))) return listed
  const columns = layout.columns.map(presentationTextGraphemes)
  const rowCount = Math.max(0, ...columns.map((column) => column.length))
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    [...columns].reverse().map((column) => column[rowIndex] ?? '　').join('　')
  )).join('\n')
}

/** Remove markers generated by formatPresentationText after direct canvas editing. */
export function stripPresentationTextFormatting(text: string, element: PresentationTextElement): string {
  if (usesPresentationVerticalGlyphLayout(element)) return element.text
  if (!element.paragraphs?.length) return stripPresentationListMarkers(text, element.listStyle)
  const originalMarkers = presentationTextParagraphs(element).map(paragraph => paragraph.marker).filter(Boolean)
  let offset = 0
  const paragraphs = presentationTextParagraphs(element).map((paragraph) => {
    const prefix = paragraph.marker
    const start = offset
    offset += prefix.length + paragraph.text.length + 1
    return { ...paragraph, start, end: offset - 1 }
  })
  const displayed = { ...element, text: formatPresentationText(element), paragraphs, textRuns: undefined }
  return presentationTextParagraphs(patchPresentationText(displayed, { text })).map(paragraph => {
    const listStyle = paragraph.style.listStyle
    if (listStyle === 'bullet' || listStyle === 'number') {
      const marker = [paragraph.marker, ...originalMarkers].find(marker => marker && paragraph.text.startsWith(marker))
      if (marker) return paragraph.text.slice(marker.length)
    }
    return paragraph.text
  }).join('\n')
}

/** Remove only generated list markers from horizontal display text. */
export function stripPresentationListMarkers(text: string, listStyle: PresentationTextElement['listStyle']): string {
  if (!listStyle || listStyle === 'none') return text
  return text.split('\n').map((line) => (
    listStyle === 'bullet'
      ? line.replace(/^•\s?/, '')
      : line.replace(/^\d+\.\s?/, '')
  )).join('\n')
}

export interface PresentationSlide {
  id: string
  layout?: PresentationSlideLayout
  name: string
  /** Page-only override. Omit it to inherit theme.background. */
  background?: string
  comments?: PresentationComment[]
  elements: PresentationElement[]
  notes?: string
  /** Page-only override. Omit it to inherit theme.footer. */
  footer?: PresentationFooter
  transition: PresentationTransition
}

export interface PresentationMaster {
  accentColors: string[]
  background: string
  bodyFontFamily: string
  footer: PresentationFooter
  titleFontFamily: string
}

/** Global visual defaults shared by every page in one presentation project. */
export type PresentationTheme = PresentationMaster

export const DEFAULT_PRESENTATION_MASTER: PresentationMaster = {
  accentColors: ['#41516A', '#3478F6', '#35A3E8', '#30B26F', '#DB2B32', '#FF922B', '#FFBE0B', '#7C2AE8'],
  background: '#FFFFFF',
  bodyFontFamily: 'Aptos',
  footer: { text: '', showDate: false, showSlideNumber: false },
  titleFontFamily: 'Aptos Display',
}

/** Resolve the background seen by every editor, preview and exporter. */
export function presentationSlideBackground(theme: PresentationTheme, slide: Pick<PresentationSlide, 'background'>): string {
  return slide.background ?? theme.background
}

/** Resolve the footer seen by every editor, preview and exporter. */
export function presentationSlideFooter(theme: PresentationTheme, slide: Pick<PresentationSlide, 'footer'>): PresentationFooter {
  return slide.footer ?? theme.footer
}

export interface PresentationSlides {
  /** Pages are stored in canonical slideOrder after every model commit. */
  pages: PresentationSlide[]
  slideOrder: string[]
  /** Editor selection follows the VideoProject timeline selection convention. */
  selectedPageId: string
}

/** Replace the page collection while keeping order and selection references valid. */
export function replacePresentationPages(slides: PresentationSlides, pages: PresentationSlide[], selectedPageId = slides.selectedPageId): PresentationSlides {
  if (pages.length === 0) throw new Error('A presentation project must keep at least one page')
  const pageIds = new Set(pages.map((page) => page.id))
  const selected = pageIds.has(selectedPageId) ? selectedPageId : pages[0]!.id
  return { pages, slideOrder: pages.map((page) => page.id), selectedPageId: selected }
}

/** Resolve slideOrder at read/migration boundaries before committing canonical array order. */
export function orderPresentationPages(pages: PresentationSlide[], slideOrder: readonly string[]): PresentationSlide[] {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const ordered = slideOrder.flatMap((pageId) => {
    const page = byId.get(pageId)
    if (!page) return []
    byId.delete(pageId)
    return [page]
  })
  return [...ordered, ...byId.values()]
}

/** Update editor selection without rebuilding or duplicating page data. */
export function selectPresentationPage(slides: PresentationSlides, selectedPageId: string): PresentationSlides {
  if (!slides.pages.some((page) => page.id === selectedPageId)) throw new Error(`PowerPoint page not found: ${selectedPageId}`)
  return { ...slides, selectedPageId }
}

/** The authoritative, serializable PowerPoint model. */
export interface PresentationProject {
  schemaVersion: 1
  version: 1
  id: string
  title: string
  theme: PresentationTheme
  pageSize: PresentationPageSize
  assets: PresentationAsset[]
  slides: PresentationSlides
}

export interface PresentationAgentChange {
  changeId: number
  elementIds: string[]
  kind: 'content' | 'design'
  slideId: string
}

type SessionStateUpdate<T> = T | ((current: T) => T)

let generatedId = 0

export function createPresentationId(prefix: string): string {
  generatedId += 1
  return `${prefix}-${Date.now().toString(36)}-${generatedId.toString(36)}`
}

export function createBlankPresentationSlide(name: string): PresentationSlide {
  return {
    id: createPresentationId('slide'),
    name,
    elements: [],
    notes: '',
    transition: createDefaultPresentationTransition(),
  }
}

export function createInitialPresentationProject(): PresentationProject {
  const project = createBlankPresentationProject('')
  const slide = project.slides.pages[0]!
  const createTextBox = (
    kind: 'body' | 'subtitle' | 'title',
    geometry: Pick<PresentationTextElement, 'height' | 'width' | 'x' | 'y'>,
  ): PresentationTextElement => {
    const isTitle = kind === 'title'
    let fontSize = 24
    if (isTitle) fontSize = 42
    else if (kind === 'subtitle') fontSize = 24
    let text = i18n.t('session.presentation.clickToAddBody')
    if (isTitle) text = i18n.t('session.presentation.clickToAddTitle')
    else if (kind === 'subtitle') text = i18n.t('session.presentation.clickToAddSubtitle')
    return {
      id: createPresentationId('text'),
      type: 'text',
      ...geometry,
      rotation: 0,
      text,
      fontSize,
      fontFamily: isTitle ? project.theme.titleFontFamily : project.theme.bodyFontFamily,
      fontWeight: isTitle ? 700 : 400,
      italic: false,
      underline: false,
      strikethrough: false,
      baseline: 'normal',
      characterSpacing: 0,
      lineHeight: 1.08,
      indentLevel: 0,
      listStyle: 'none',
      color: '#20202B',
      align: kind === 'body' ? 'left' : 'center',
    }
  }
  slide.layout = 'title'
  slide.elements = [
    createTextBox('title', { x: 120, y: 105, width: project.pageSize.width - 240, height: 90 }),
    createTextBox('subtitle', { x: 160, y: 220, width: project.pageSize.width - 320, height: 60 }),
    createTextBox('body', { x: 120, y: 320, width: project.pageSize.width - 240, height: Math.max(180, project.pageSize.height - 425) }),
  ]
  return project
}

export function createBlankPresentationProject(title: string, slideName = 'Slide 1'): PresentationProject {
  const slide = createBlankPresentationSlide(slideName)
  return {
    schemaVersion: 1,
    version: 1,
    id: createPresentationId('presentation'),
    theme: {
      ...DEFAULT_PRESENTATION_MASTER,
      accentColors: [...DEFAULT_PRESENTATION_MASTER.accentColors],
      footer: { ...DEFAULT_PRESENTATION_MASTER.footer },
    },
    title,
    pageSize: { ...PRESENTATION_PAGE_SIZES.wide },
    assets: [],
    slides: {
      pages: [slide],
      slideOrder: [slide.id],
      selectedPageId: slide.id,
    },
  }
}

const expandedPresentationSessionsAtom = atom<ReadonlySet<string>>(new Set<string>())
/** Dedicated PowerPoint renderers pin their exact Session independently of main navigation. */
export const powerPointSessionIdOverrideAtom = atom<string | null>(null)
export const presentationSessionIdAtom = atom((get) => (
  get(powerPointSessionIdOverrideAtom) ?? get(viewedSessionIdAtom)
))

/** Whether the viewed Session's presentation owns the work area. */
export const presentationExpandedAtom = atom(
  (get) => {
    const sessionId = get(presentationSessionIdAtom)
    return sessionId ? get(expandedPresentationSessionsAtom).has(sessionId) : false
  },
  (get, set, update: SessionStateUpdate<boolean>, sessionId: string | null = get(presentationSessionIdAtom)) => {
    if (!sessionId) return
    const current = get(expandedPresentationSessionsAtom)
    const isExpanded = current.has(sessionId)
    const next = typeof update === 'function' ? update(isExpanded) : update
    if (next === isExpanded) return
    const sessions = new Set(current)
    if (next) sessions.add(sessionId)
    else sessions.delete(sessionId)
    set(expandedPresentationSessionsAtom, sessions)
  },
)

/** Drop presentation state when its owning Session is deleted. */
export const purgePresentationSessionAtom = atom(null, (get, set, sessionId: string) => {
  presentationPaneViewFamily.remove(sessionId)
  const expandedSessions = get(expandedPresentationSessionsAtom)
  if (expandedSessions.has(sessionId)) {
    const nextExpandedSessions = new Set(expandedSessions)
    nextExpandedSessions.delete(sessionId)
    set(expandedPresentationSessionsAtom, nextExpandedSessions)
  }
})
