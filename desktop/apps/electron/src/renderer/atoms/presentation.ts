import { atom } from 'jotai'
import { i18n } from '@/lib/i18n'
import { createDefaultPresentationTransition } from '@/lib/presentationTransitions'
import { viewedSessionIdAtom } from './navigation'

export const PRESENTATION_WIDTH = 1280
export const PRESENTATION_HEIGHT = 720
export const PRESENTATION_STANDARD_WIDTH = 960

export type PresentationPageSizePreset = 'wide' | 'standard'

export interface PresentationPageSize {
  height: number
  preset: PresentationPageSizePreset
  width: number
}

export const PRESENTATION_PAGE_SIZES: Record<PresentationPageSizePreset, PresentationPageSize> = {
  wide: { width: PRESENTATION_WIDTH, height: PRESENTATION_HEIGHT, preset: 'wide' },
  standard: { width: PRESENTATION_STANDARD_WIDTH, height: PRESENTATION_HEIGHT, preset: 'standard' },
}

export function getPresentationPageSize(document: Pick<PresentationDocument, 'pageSize'> | null | undefined): PresentationPageSize {
  const size = document?.pageSize
  return size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
    ? size
    : PRESENTATION_PAGE_SIZES.wide
}

export type PresentationAnimationEffect =
  | 'none'
  | 'appear'
  | 'fade'
  | 'blinds'
  | 'checkerboard'
  | 'dissolve'
  | 'flyIn'
  | 'floatIn'
  | 'split'
  | 'wipeIn'
  | 'zoomIn'
  | 'zoom'
  | 'fillColor'
  | 'textColor'
  | 'disappear'
  | 'blindsOut'
export type PresentationAnimationStart = 'onClick' | 'withPrevious' | 'afterPrevious'
export type PresentationAnimationTrigger = 'slideClick' | 'elementClick'
export type PresentationTransitionEffect = 'none' | 'fade' | 'push' | 'wipe' | 'reveal' | 'cover' | 'zoom' | 'flip' | 'cube'
export type PresentationTransitionDirection = 'left' | 'right' | 'up' | 'down' | 'in' | 'out'
export type PresentationSlideLayout = 'blank' | 'title' | 'titleContent' | 'twoContent'

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

export interface PresentationTransition {
  effect: PresentationTransitionEffect
  durationMs: number
  direction?: PresentationTransitionDirection
  throughBlack?: boolean
}

export type PresentationShapeType =
  | 'line'
  | 'lineArrow'
  | 'lineDoubleArrow'
  | 'elbowConnector'
  | 'elbowArrow'
  | 'curvedConnector'
  | 'curvedArrow'
  | 'rect'
  | 'roundRect'
  | 'snip1Rect'
  | 'snip2DiagRect'
  | 'round1Rect'
  | 'round2SameRect'
  | 'frame'
  | 'ellipse'
  | 'triangle'
  | 'rtTriangle'
  | 'parallelogram'
  | 'trapezoid'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'octagon'
  | 'decagon'
  | 'dodecagon'
  | 'pie'
  | 'teardrop'
  | 'plus'
  | 'star4'
  | 'star5'
  | 'star6'
  | 'star8'
  | 'heart'
  | 'lightningBolt'
  | 'sun'
  | 'moon'
  | 'cloud'
  | 'donut'
  | 'arc'
  | 'smileyFace'
  | 'can'
  | 'cube'
  | 'bevel'
  | 'bracePair'
  | 'bracketPair'
  | 'rightArrow'
  | 'leftArrow'
  | 'upArrow'
  | 'downArrow'
  | 'leftRightArrow'
  | 'upDownArrow'
  | 'quadArrow'
  | 'bentArrow'
  | 'bentUpArrow'
  | 'uturnArrow'
  | 'circularArrow'
  | 'chevron'
  | 'notchedRightArrow'
  | 'stripedRightArrow'
  | 'rightArrowCallout'
  | 'leftArrowCallout'
  | 'upArrowCallout'
  | 'downArrowCallout'
  | 'mathPlus'
  | 'mathMinus'
  | 'mathMultiply'
  | 'mathDivide'
  | 'mathEqual'
  | 'mathNotEqual'
  | 'flowChartProcess'
  | 'flowChartAlternateProcess'
  | 'flowChartDecision'
  | 'flowChartInputOutput'
  | 'flowChartDocument'
  | 'flowChartMultidocument'
  | 'flowChartTerminator'
  | 'flowChartPreparation'
  | 'flowChartManualInput'
  | 'flowChartManualOperation'
  | 'flowChartConnector'
  | 'flowChartOffpageConnector'
  | 'flowChartDelay'
  | 'flowChartDisplay'
  | 'flowChartPredefinedProcess'
  | 'flowChartInternalStorage'

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

export interface PresentationShapeElement extends PresentationElementBase {
  type: PresentationShapeType
  fill: string
  borderColor: string
  borderWidth: number
  radius?: number
}

export interface PresentationImageElement extends PresentationElementBase {
  type: 'image'
  source: PresentationFileSource
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
  source: PresentationFileSource
  autoplay: boolean
  loop: boolean
  muted: boolean
}

export interface PresentationVideoElement extends PresentationElementBase {
  type: 'video'
  source: PresentationFileSource
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
  bodyFill: string
  textColor: string
  borderColor: string
  fontSize: number
}

export type PresentationChartType = 'column' | 'bar' | 'line' | 'pie' | 'doughnut'

export interface PresentationChartSeries {
  name: string
  values: number[]
}

export interface PresentationChartElement extends PresentationElementBase {
  type: 'chart'
  chartType: PresentationChartType
  categories: string[]
  series: PresentationChartSeries[]
  showLegend: boolean
  showValue?: boolean
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
  columns: string[]
  rowAdvance: number
  rowsPerColumn: number
}

/** Flow upright glyphs down the text frame, then continue in columns from right to left. */
export function layoutPresentationVerticalText(element: PresentationTextElement): PresentationVerticalTextLayout {
  const insets = element.textInsets ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const contentHeight = Math.max(element.fontSize, element.height - insets.top - insets.bottom)
  const rowAdvance = Math.max(1, element.fontSize * (element.lineHeight ?? 1.08))
  const rowsPerColumn = Math.max(1, Math.floor((contentHeight - element.fontSize) / rowAdvance) + 1)
  const columns = element.text.split('\n').flatMap((paragraph) => {
    const glyphs = Array.from(paragraph).filter((glyph) => !/\s/u.test(glyph))
    if (glyphs.length === 0) return ['']
    return Array.from({ length: Math.ceil(glyphs.length / rowsPerColumn) }, (_, index) => (
      glyphs.slice(index * rowsPerColumn, (index + 1) * rowsPerColumn).join('')
    ))
  })
  return {
    columnAdvance: element.fontSize * 1.2,
    columns,
    rowAdvance,
    rowsPerColumn,
  }
}

/** Add visual list markers while keeping the underlying editable text marker-free. */
export function formatPresentationText(element: PresentationTextElement): string {
  const listed = !element.listStyle || element.listStyle === 'none'
    ? element.text
    : element.text.split('\n').map((line, index) => {
      if (!line.trim()) return line
      return element.listStyle === 'bullet' ? `• ${line}` : `${index + 1}. ${line}`
    }).join('\n')
  if (element.textDirection !== 'eastAsianVertical' && element.textDirection !== 'stacked') return listed
  const columns = layoutPresentationVerticalText({ ...element, text: listed }).columns.map((column) => Array.from(column))
  const rowCount = Math.max(0, ...columns.map((column) => column.length))
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    [...columns].reverse().map((column) => column[rowIndex] ?? '　').join('　')
  )).join('\n')
}

/** Remove markers generated by formatPresentationText after direct canvas editing. */
export function stripPresentationTextFormatting(text: string, element: PresentationTextElement): string {
  let unformatted = text
  if (element.textDirection === 'eastAsianVertical' || element.textDirection === 'stacked') {
    // Vertical text is rendered as a composed group and is edited through the
    // text inspector, so the display projection must never overwrite source.
    unformatted = element.text
  }
  return stripPresentationListMarkers(unformatted, element.listStyle)
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
  background: string
  comments?: PresentationComment[]
  elements: PresentationElement[]
  notes?: string
  footer?: PresentationFooter
  transition: PresentationTransition
}

export interface PresentationMaster {
  background: string
  bodyFontFamily: string
  footer: PresentationFooter
  titleFontFamily: string
}

export const DEFAULT_PRESENTATION_MASTER: PresentationMaster = {
  background: '#FFFFFF',
  bodyFontFamily: 'Aptos',
  footer: { text: '', showDate: false, showSlideNumber: false },
  titleFontFamily: 'Aptos Display',
}

export interface PresentationDocument {
  id: string
  master: PresentationMaster
  title: string
  version: number
  pageSize: PresentationPageSize
  slides: PresentationSlide[]
  selectedSlideId: string
}

export interface PresentationWorkspace {
  activeDocumentId: string
  documents: PresentationDocument[]
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
    background: '#FFFFFF',
    elements: [],
    notes: '',
    transition: createDefaultPresentationTransition(),
  }
}

export function createInitialPresentationDocument(): PresentationDocument {
  const document = createBlankPresentationDocument('')
  const slide = document.slides[0]!
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
      fontFamily: isTitle ? document.master.titleFontFamily : document.master.bodyFontFamily,
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
    createTextBox('title', { x: 120, y: 105, width: document.pageSize.width - 240, height: 90 }),
    createTextBox('subtitle', { x: 160, y: 220, width: document.pageSize.width - 320, height: 60 }),
    createTextBox('body', { x: 120, y: 320, width: document.pageSize.width - 240, height: Math.max(180, document.pageSize.height - 425) }),
  ]
  return document
}

export function createBlankPresentationDocument(title: string, slideName = 'Slide 1'): PresentationDocument {
  const slide = createBlankPresentationSlide(slideName)
  return {
    id: createPresentationId('presentation'),
    master: { ...DEFAULT_PRESENTATION_MASTER, footer: { ...DEFAULT_PRESENTATION_MASTER.footer } },
    title,
    version: 1,
    pageSize: { ...PRESENTATION_PAGE_SIZES.wide },
    slides: [slide],
    selectedSlideId: slide.id,
  }
}

export function createInitialPresentationWorkspace(): PresentationWorkspace {
  const document = createInitialPresentationDocument()
  return {
    activeDocumentId: document.id,
    documents: [document],
  }
}

const fallbackPresentationWorkspace = createInitialPresentationWorkspace()
const fallbackPresentationDocument = fallbackPresentationWorkspace.documents[0]!
const presentationWorkspacesBySessionAtom = atom<ReadonlyMap<string, PresentationWorkspace>>(new Map())
const expandedPresentationSessionsAtom = atom<ReadonlySet<string>>(new Set<string>())
/** Dedicated PowerPoint renderers pin their exact Session independently of main navigation. */
export const powerPointSessionIdOverrideAtom = atom<string | null>(null)
export const presentationSessionIdAtom = atom((get) => (
  get(powerPointSessionIdOverrideAtom) ?? get(viewedSessionIdAtom)
))

/** Every open presentation tab owned by the viewed Session. */
export const currentPresentationWorkspaceAtom = atom(
  (get) => {
    const sessionId = get(presentationSessionIdAtom)
    return sessionId
      ? get(presentationWorkspacesBySessionAtom).get(sessionId) ?? fallbackPresentationWorkspace
      : fallbackPresentationWorkspace
  },
  (get, set, update: SessionStateUpdate<PresentationWorkspace>) => {
    const sessionId = get(presentationSessionIdAtom)
    if (!sessionId) return
    const current = get(currentPresentationWorkspaceAtom)
    const next = typeof update === 'function' ? update(current) : update
    const workspaces = new Map(get(presentationWorkspacesBySessionAtom))
    workspaces.set(sessionId, next)
    set(presentationWorkspacesBySessionAtom, workspaces)
  },
)

/** The active presentation tab's editable document. */
export const currentPresentationDocumentAtom = atom(
  (get) => {
    const workspace = get(currentPresentationWorkspaceAtom)
    return workspace.documents.find((document) => document.id === workspace.activeDocumentId)
      ?? workspace.documents[0]
      ?? fallbackPresentationDocument
  },
  (get, set, update: SessionStateUpdate<PresentationDocument>) => {
    const workspace = get(currentPresentationWorkspaceAtom)
    const current = get(currentPresentationDocumentAtom)
    const next = typeof update === 'function' ? update(current) : update
    const hasActiveDocument = workspace.documents.some((document) => document.id === current.id)
    set(currentPresentationWorkspaceAtom, {
      activeDocumentId: next.id,
      documents: hasActiveDocument
        ? workspace.documents.map((document) => document.id === current.id ? next : document)
        : [...workspace.documents, next],
    })
  },
)

/** Whether the viewed Session's presentation owns the work area. */
export const presentationExpandedAtom = atom(
  (get) => {
    const sessionId = get(presentationSessionIdAtom)
    return sessionId ? get(expandedPresentationSessionsAtom).has(sessionId) : false
  },
  (get, set, update: SessionStateUpdate<boolean>) => {
    const sessionId = get(presentationSessionIdAtom)
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
  const workspaces = get(presentationWorkspacesBySessionAtom)
  if (workspaces.has(sessionId)) {
    const nextWorkspaces = new Map(workspaces)
    nextWorkspaces.delete(sessionId)
    set(presentationWorkspacesBySessionAtom, nextWorkspaces)
  }
  const expandedSessions = get(expandedPresentationSessionsAtom)
  if (expandedSessions.has(sessionId)) {
    const nextExpandedSessions = new Set(expandedSessions)
    nextExpandedSessions.delete(sessionId)
    set(expandedPresentationSessionsAtom, nextExpandedSessions)
  }
})
