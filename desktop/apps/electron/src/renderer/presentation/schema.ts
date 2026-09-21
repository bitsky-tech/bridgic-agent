import { z } from 'zod'
import {
  PRESENTATION_ANIMATION_EFFECTS,
  PRESENTATION_ANIMATION_STARTS,
  PRESENTATION_ANIMATION_TRIGGERS,
  PRESENTATION_CHART_TYPES,
  PRESENTATION_SHAPE_TYPES,
  PRESENTATION_SLIDE_LAYOUTS,
  PRESENTATION_TRANSITION_DIRECTIONS,
  PRESENTATION_TRANSITION_EFFECTS,
  type PresentationProject,
} from '@/atoms/presentation'
import { PRESENTATION_NUMBER_FORMATS } from '@/lib/presentationText'
import { isValidPresentationSource } from './sourceReference'
import {
  MAX_PRESENTATION_TRANSITION_DURATION_MS,
  MIN_PRESENTATION_TRANSITION_DURATION_MS,
  getPresentationTransitionDefinition,
} from '@/lib/presentationTransitions'

const id = z.string().min(1)
const finite = z.number().finite()
const nonnegative = finite.nonnegative()
const positive = finite.positive()

const asset = z.strictObject({
  id,
  kind: z.enum(['image', 'audio', 'video', 'text']),
  mimeType: z.string().min(1),
  name: z.string().min(1),
  source: z.string().min(1).refine(isValidPresentationSource, 'Invalid stored PowerPoint source'),
  imageEffects: z.strictObject({
    colorChange: z.strictObject({ from: z.string(), to: z.string(), opacity: finite.min(0).max(1) }).optional(),
    grayscale: z.boolean().optional(),
    biLevelThreshold: finite.min(0).max(1).optional(),
    backgroundRemoval: z.strictObject({
      layerSource: z.string().min(1).refine(isValidPresentationSource, 'Invalid Office image layer source'),
      bounds: z.strictObject({ top: finite, bottom: finite, left: finite, right: finite }),
      foregroundMarks: z.array(z.strictObject({ x1: finite, y1: finite, x2: finite, y2: finite })),
      backgroundMarks: z.array(z.strictObject({ x1: finite, y1: finite, x2: finite, y2: finite })),
    }).optional(),
  }).optional(),
  sourceModifiedAt: nonnegative.optional(),
  sourceSize: finite.int().nonnegative().optional(),
})
const hyperlink = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('url'), url: z.string().min(1), tooltip: z.string().optional() }),
  z.strictObject({ type: z.literal('slide'), slideId: id, tooltip: z.string().optional() }),
])
const elementBase = {
  id,
  groupId: id.optional(),
  x: finite,
  y: finite,
  width: positive,
  height: positive,
  rotation: finite,
  flipHorizontal: z.boolean().optional(),
  flipVertical: z.boolean().optional(),
  opacity: finite.min(0).max(1).optional(),
  animation: z.enum(PRESENTATION_ANIMATION_EFFECTS).optional(),
  animationDuration: nonnegative.optional(),
  animationDelay: nonnegative.optional(),
  animationStart: z.enum(PRESENTATION_ANIMATION_STARTS).optional(),
  animationTrigger: z.enum(PRESENTATION_ANIMATION_TRIGGERS).optional(),
  animationColor: z.string().optional(),
  shadow: z.boolean().optional(),
  hyperlink: hyperlink.optional(),
}
const textStyle = z.strictObject({
  fontSize: positive.optional(),
  fontFamily: z.string().min(1).optional(),
  fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]).optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  baseline: z.enum(['normal', 'superscript', 'subscript']).optional(),
  highlightColor: z.string().optional(),
  characterSpacing: finite.optional(),
  color: z.string().optional(),
  opacity: finite.min(0).max(1).optional(),
})
const paragraphStyle = z.strictObject({
  align: z.enum(['left', 'center', 'right', 'justify']).optional(),
  lineHeight: positive.optional(),
  lineSpacing: nonnegative.optional(),
  indentLevel: finite.int().min(0).max(8).optional(),
  listStyle: z.enum(['none', 'bullet', 'number']).optional(),
  spaceBefore: nonnegative.optional(),
  spaceAfter: nonnegative.optional(),
  listStartAt: finite.int().min(1).max(32_767).optional(),
  listNumberFormat: z.string().refine((value) => PRESENTATION_NUMBER_FORMATS.has(value), 'Unsupported list number format').optional(),
  listBulletChar: z.string().min(1).max(128).refine((value) => !/[\r\n]/.test(value), 'Bullet character must stay on one line').optional(),
  listMarkerFontFamily: z.string().min(1).max(128).refine((value) => !/[\r\n]/.test(value), 'Marker font family must stay on one line').optional(),
})
const textElement = z.strictObject({
  ...elementBase,
  type: z.literal('text'),
  sourceAssetId: id.optional(),
  text: z.string(),
  textRuns: z.array(z.strictObject({ start: finite.int().nonnegative(), end: finite.int().nonnegative(), style: textStyle })).optional(),
  paragraphs: z.array(z.strictObject({
    start: finite.int().nonnegative(),
    end: finite.int().nonnegative(),
    style: paragraphStyle,
    endStyle: textStyle.optional(),
  })).min(1).optional(),
  fontSize: positive,
  fontFamily: z.string().min(1),
  fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  baseline: z.enum(['normal', 'superscript', 'subscript']).optional(),
  highlightColor: z.string().optional(),
  characterSpacing: finite.optional(),
  lineHeight: positive.optional(),
  lineSpacing: nonnegative.optional(),
  indentLevel: finite.int().min(0).max(8).optional(),
  listStyle: z.enum(['none', 'bullet', 'number']).optional(),
  color: z.string(),
  align: z.enum(['left', 'center', 'right', 'justify']),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  textDirection: z.enum(['horizontal', 'eastAsianVertical', 'vertical', 'vertical270', 'stacked']).optional(),
  wordWrap: z.boolean().optional(),
  textInsets: z.strictObject({ left: nonnegative, top: nonnegative, right: nonnegative, bottom: nonnegative }).optional(),
}).superRefine((value, context) => {
  let previousEnd = 0
  value.textRuns?.forEach((run, index) => {
    if (run.start < previousEnd || run.end <= run.start || run.end > value.text.length) {
      context.addIssue({ code: 'custom', path: ['textRuns', index], message: 'Text runs must be ordered, non-overlapping ranges inside the text' })
    }
    previousEnd = run.end
  })
  let expectedStart = 0
  value.paragraphs?.forEach((paragraph, index) => {
    const final = index === value.paragraphs!.length - 1
    if (paragraph.start !== expectedStart || paragraph.end < paragraph.start || paragraph.end > value.text.length
      || (final ? paragraph.end !== value.text.length : value.text[paragraph.end] !== '\n')) {
      context.addIssue({ code: 'custom', path: ['paragraphs', index], message: 'Paragraphs must partition the text at paragraph breaks' })
    }
    expectedStart = paragraph.end + 1
  })
})
const shapeElement = z.strictObject({
  ...elementBase,
  type: z.enum(PRESENTATION_SHAPE_TYPES),
  fill: z.string(),
  fillOpacity: finite.min(0).max(1).optional(),
  gradientFill: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('linear'),
      angle: finite,
      stops: z.array(z.strictObject({ offset: finite.min(0).max(1), color: z.string(), opacity: finite.min(0).max(1) })).min(1),
    }),
    z.strictObject({
      type: z.literal('radial'),
      stops: z.array(z.strictObject({ offset: finite.min(0).max(1), color: z.string(), opacity: finite.min(0).max(1) })).min(1),
    }),
  ]).optional(),
  borderColor: z.string(),
  borderWidth: nonnegative,
  borderOpacity: finite.min(0).max(1).optional(),
  radius: nonnegative.optional(),
  customGeometry: z.strictObject({
    paths: z.array(z.strictObject({
      width: positive,
      height: positive,
      fill: z.enum(['normal', 'none']),
      stroke: z.boolean(),
      commands: z.array(z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('moveTo'), x: finite, y: finite }),
        z.strictObject({ type: z.literal('lineTo'), x: finite, y: finite }),
        z.strictObject({ type: z.literal('cubicBezierTo'), x1: finite, y1: finite, x2: finite, y2: finite, x: finite, y: finite }),
        z.strictObject({ type: z.literal('quadraticBezierTo'), x1: finite, y1: finite, x: finite, y: finite }),
        z.strictObject({ type: z.literal('arcTo'), widthRadius: nonnegative, heightRadius: nonnegative, startAngle: finite, sweepAngle: finite }),
        z.strictObject({ type: z.literal('close') }),
      ])).min(1),
    })).min(1),
  }).optional(),
  connectorPath: z.string().optional(),
})
const imageElement = z.strictObject({
  ...elementBase,
  type: z.literal('image'),
  sourceAssetId: id,
  altText: z.string(),
  fit: z.enum(['contain', 'cover', 'stretch']),
  softEdgeRadius: nonnegative.optional(),
  clipShape: z.literal('ellipse').optional(),
  crop: z.strictObject({
    left: finite.min(0).max(1),
    top: finite.min(0).max(1),
    right: finite.min(0).max(1),
    bottom: finite.min(0).max(1),
  }).superRefine((value, context) => {
    if (value.left + value.right >= 1) context.addIssue({ code: 'custom', path: ['right'], message: 'Horizontal crop must leave visible content' })
    if (value.top + value.bottom >= 1) context.addIssue({ code: 'custom', path: ['bottom'], message: 'Vertical crop must leave visible content' })
  }).optional(),
})
const audioElement = z.strictObject({
  ...elementBase,
  type: z.literal('audio'),
  sourceAssetId: id,
  autoplay: z.boolean(),
  loop: z.boolean(),
  muted: z.boolean(),
})
const videoElement = z.strictObject({
  ...elementBase,
  type: z.literal('video'),
  sourceAssetId: id,
  autoplay: z.boolean(),
  loop: z.boolean(),
  muted: z.boolean(),
})
const tableElement = z.strictObject({
  ...elementBase,
  type: z.literal('table'),
  cells: z.array(z.array(z.string())).min(1),
  headerRow: z.boolean(),
  headerFill: z.string(),
  headerTextColor: z.string().optional(),
  bodyFill: z.string(),
  textColor: z.string(),
  borderColor: z.string(),
  fontSize: positive,
})
const chartElement = z.strictObject({
  ...elementBase,
  type: z.literal('chart'),
  chartType: z.enum(PRESENTATION_CHART_TYPES),
  categories: z.array(z.string()),
  series: z.array(z.strictObject({ name: z.string(), values: z.array(finite.nullable()) })),
  showLegend: z.boolean(),
  showValue: z.boolean().optional(),
  displayBlanksAs: z.enum(['gap', 'zero', 'span']).optional(),
  holeSize: finite.min(0).max(100).optional(),
  title: z.string().optional(),
  colors: z.array(z.string()),
  chartAreaFill: z.string().optional(),
  plotAreaFill: z.string().optional(),
  categoryAxisLabelColor: z.string().optional(),
  valueAxisLabelColor: z.string().optional(),
  gridLineColor: z.string().optional(),
  dataLabelColor: z.string().optional(),
})
const element = z.union([textElement, shapeElement, imageElement, audioElement, videoElement, tableElement, chartElement])
const transition = z.strictObject({
  effect: z.enum(PRESENTATION_TRANSITION_EFFECTS),
  durationMs: finite.min(MIN_PRESENTATION_TRANSITION_DURATION_MS).max(MAX_PRESENTATION_TRANSITION_DURATION_MS),
  direction: z.enum(PRESENTATION_TRANSITION_DIRECTIONS).optional(),
  throughBlack: z.boolean().optional(),
}).superRefine((value, context) => {
  const definition = getPresentationTransitionDefinition(value.effect)
  if (value.direction !== undefined && !definition.directions.includes(value.direction)) {
    context.addIssue({ code: 'custom', path: ['direction'], message: 'Transition direction is not supported by this effect' })
  }
  if (value.throughBlack !== undefined && !definition.supportsThroughBlack) {
    context.addIssue({ code: 'custom', path: ['throughBlack'], message: 'This transition does not support through-black playback' })
  }
})
const footer = z.strictObject({ text: z.string(), showDate: z.boolean(), showSlideNumber: z.boolean() })
const comment = z.strictObject({
  author: z.string(),
  createdAt: z.string(),
  elementId: id.optional(),
  id,
  resolved: z.boolean(),
  text: z.string(),
})
const page = z.strictObject({
  id,
  layout: z.enum(PRESENTATION_SLIDE_LAYOUTS).optional(),
  name: z.string(),
  background: z.string().optional(),
  comments: z.array(comment).optional(),
  elements: z.array(element),
  notes: z.string().optional(),
  footer: footer.optional(),
  transition,
})
const theme = z.strictObject({
  accentColors: z.array(z.string()).min(1),
  background: z.string(),
  bodyFontFamily: z.string().min(1),
  footer,
  titleFontFamily: z.string().min(1),
})

export const presentationProjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.literal(1),
  id,
  title: z.string(),
  theme,
  pageSize: z.strictObject({ height: positive, preset: z.enum(['wide', 'standard']), width: positive }),
  assets: z.array(asset),
  slides: z.strictObject({ pages: z.array(page).min(1), slideOrder: z.array(id), selectedPageId: id }),
}).superRefine((project, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message })
  const unique = (values: string[]) => new Set(values).size === values.length
  const assetById = new Map(project.assets.map((value) => [value.id, value]))
  if (!unique(project.assets.map((value) => value.id))) issue(['assets'], 'Duplicate asset identity')
  project.assets.forEach((value, index) => {
    if (value.kind !== 'text' && !value.mimeType.startsWith(`${value.kind}/`)) issue(['assets', index, 'mimeType'], 'Asset media type must match its kind')
    if (value.kind === 'text' && !value.mimeType.startsWith('text/')) issue(['assets', index, 'mimeType'], 'Text asset media type must be text')
    if (value.imageEffects && value.kind !== 'image') issue(['assets', index, 'imageEffects'], 'Only images may carry picture effects')
  })
  const pages = project.slides.pages
  const pageIds = pages.map((value) => value.id)
  if (!unique(pageIds)) issue(['slides', 'pages'], 'Duplicate page identity')
  if (!unique(project.slides.slideOrder)
    || project.slides.slideOrder.length !== pageIds.length
    || project.slides.slideOrder.some((pageId, index) => pageId !== pageIds[index])) {
    issue(['slides', 'slideOrder'], 'Pages must be stored in canonical slideOrder')
  }
  if (!pageIds.includes(project.slides.selectedPageId)) issue(['slides', 'selectedPageId'], 'Selection refers to a missing page')
  for (const [pageIndex, value] of pages.entries()) {
    const elementIds = new Set<string>()
    const commentIds = value.comments?.map((item) => item.id) ?? []
    if (!unique(commentIds)) issue(['slides', 'pages', pageIndex, 'comments'], 'Duplicate comment identity')
    for (const [elementIndex, item] of value.elements.entries()) {
      const path = ['slides', 'pages', pageIndex, 'elements', elementIndex]
      if (elementIds.has(item.id)) issue([...path, 'id'], 'Duplicate element identity')
      elementIds.add(item.id)
      if (item.type === 'image' || item.type === 'audio' || item.type === 'video' || (item.type === 'text' && item.sourceAssetId)) {
        const referenced = assetById.get(item.sourceAssetId!)
        if (!referenced || referenced.kind !== item.type) issue([...path, 'sourceAssetId'], 'Source-backed element must reference an existing matching asset')
      }
      if (item.hyperlink?.type === 'slide' && !pageIds.includes(item.hyperlink.slideId)) {
        issue([...path, 'hyperlink', 'slideId'], 'Slide hyperlink refers to a missing page')
      }
    }
    value.comments?.forEach((item, commentIndex) => {
      if (item.elementId && !elementIds.has(item.elementId)) {
        issue(['slides', 'pages', pageIndex, 'comments', commentIndex, 'elementId'], 'Comment refers to a missing page element')
      }
    })
  }
}) as unknown as z.ZodType<PresentationProject>
