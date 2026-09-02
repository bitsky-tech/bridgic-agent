import { dump, load } from 'js-yaml'
import { marked, type Token, type Tokens } from 'marked'
import {
  PRESENTATION_PAGE_SIZES,
  createBlankPresentationDocument,
  createBlankPresentationSlide,
  type PresentationChartElement,
  type PresentationDocument,
  type PresentationElement,
  type PresentationFileSource,
  type PresentationFooter,
  type PresentationPageSize,
  type PresentationShapeType,
  type PresentationSlide,
  type PresentationSlideLayout,
  type PresentationTextElement,
  type PresentationTransition,
} from '@/atoms/presentation'
import { normalizePresentationDesignColor, presentationThemeTextColors } from '@/lib/presentationDesign'

export type PresentationMarkdownAssets = Record<string, PresentationFileSource>

interface CompilePresentationMarkdownOptions {
  assets?: PresentationMarkdownAssets
  existingDocument?: PresentationDocument
}

interface CompilePresentationMarkdownResult {
  diagnostics: string[]
  document: PresentationDocument
}

interface CompilePresentationSlideMarkdownOptions extends CompilePresentationMarkdownOptions {
  document: PresentationDocument
}

interface CompilePresentationSlideMarkdownResult {
  diagnostics: string[]
  slide: PresentationSlide
}

interface CompilePresentationElementMarkdownOptions extends CompilePresentationMarkdownOptions {
  document: PresentationDocument
  elementId?: string
  slide: PresentationSlide
}

interface CompilePresentationElementMarkdownResult {
  diagnostics: string[]
  element: PresentationElement
}

interface ParsedSlideSource {
  body: string
  frontmatter: Record<string, unknown>
  index: number
}

interface ParsedBody {
  body: string
  notes: string
}

interface LayoutCursor {
  full: number
  left: number
  right: number
  slot: 'full' | 'left' | 'right'
}

interface ElementCompilerContext {
  assets: PresentationMarkdownAssets
  cursor: LayoutCursor
  diagnostics: string[]
  elementOrdinal: number
  existingDocument?: PresentationDocument
  pageSize: PresentationPageSize
  slideId: string
  usedElementIds: Set<string>
}

interface NativeComponent {
  attrs: Record<string, string>
  body: string
  name: 'PptAudio' | 'PptChart' | 'PptImage' | 'PptShape' | 'PptTable' | 'PptText' | 'PptVideo'
}

const MAX_SLIDES = 200
const MAX_ELEMENTS_PER_SLIDE = 1_000
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/
const NATIVE_COMPONENT_PATTERN = /^<Ppt(Text|Shape|Image|Audio|Video|Table|Chart)\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/Ppt\1\s*>)/
const SHAPE_TYPES = new Set<PresentationShapeType>([
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
])
const LAYOUTS = new Set<PresentationSlideLayout>(['blank', 'title', 'titleContent', 'twoContent'])
const TRANSITION_EFFECTS = new Set<PresentationTransition['effect']>([
  'none', 'fade', 'push', 'wipe', 'reveal', 'cover', 'zoom', 'flip', 'cube',
])
const TRANSITION_DIRECTIONS = new Set<NonNullable<PresentationTransition['direction']>>([
  'left', 'right', 'up', 'down', 'in', 'out',
])
const ANIMATION_EFFECTS = new Set([
  'none', 'appear', 'fade', 'blinds', 'checkerboard', 'dissolve', 'flyIn', 'floatIn',
  'split', 'wipeIn', 'zoomIn', 'zoom', 'fillColor', 'textColor', 'disappear', 'blindsOut',
])
const ANIMATION_STARTS = new Set(['onClick', 'withPrevious', 'afterPrevious'])
const ANIMATION_TRIGGERS = new Set(['slideClick', 'elementClick'])
const MEDIA_COMPONENT_NAMES = new Set<NativeComponent['name']>(['PptImage', 'PptAudio', 'PptVideo'])
const COMMON_COMPONENT_ATTRS = new Set([
  'id', 'ref', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'groupId', 'shadow',
  'flipHorizontal', 'flipVertical',
  'animation', 'animationDuration', 'animationDelay', 'animationStart', 'animationTrigger',
  'animationColor', 'href', 'slideHref', 'tooltip',
])
const COMPONENT_ATTRS: Record<NativeComponent['name'], Set<string>> = {
  PptText: new Set([
    ...COMMON_COMPONENT_ATTRS,
    'fontSize', 'fontFamily', 'fontWeight', 'italic', 'underline', 'strikethrough', 'baseline',
    'highlightColor', 'characterSpacing', 'lineHeight', 'indentLevel', 'listStyle', 'color', 'align',
    'verticalAlign', 'textDirection', 'wordWrap', 'insetLeft', 'insetTop', 'insetRight', 'insetBottom',
  ]),
  PptShape: new Set([...COMMON_COMPONENT_ATTRS, 'kind', 'type', 'fill', 'borderColor', 'borderWidth', 'radius']),
  PptImage: new Set([
    ...COMMON_COMPONENT_ATTRS,
    'src', 'alt', 'altText', 'fit', 'clipShape', 'cropLeft', 'cropTop', 'cropRight', 'cropBottom',
  ]),
  PptAudio: new Set([...COMMON_COMPONENT_ATTRS, 'src', 'autoplay', 'loop', 'muted']),
  PptVideo: new Set([...COMMON_COMPONENT_ATTRS, 'src', 'autoplay', 'loop', 'muted']),
  PptTable: new Set([
    ...COMMON_COMPONENT_ATTRS,
    'headerRow', 'headerFill', 'bodyFill', 'textColor', 'borderColor', 'fontSize',
  ]),
  PptChart: new Set([
    ...COMMON_COMPONENT_ATTRS,
    'type', 'chartType', 'showLegend', 'showValue', 'title', 'colors', 'chartAreaFill',
    'plotAreaFill', 'categoryAxisLabelColor', 'valueAxisLabelColor', 'gridLineColor', 'dataLabelColor',
  ]),
}

/** Compile a complete Slidev-style Markdown deck into the native editable PPT IR. */
export function compilePresentationMarkdown(
  markdown: string,
  options: CompilePresentationMarkdownOptions = {},
): CompilePresentationMarkdownResult {
  const sources = parsePresentationMarkdown(markdown)
  if (sources.length > MAX_SLIDES) throw new Error(`A presentation may contain at most ${MAX_SLIDES} slides`)
  const blank = createBlankPresentationDocument(optionalString(sources[0]!.frontmatter.title) ?? '')
  const pageSize = parsePageSize(sources[0]!.frontmatter.pageSize)
  const master = parseMaster(sources[0]!.frontmatter.master, blank.master)
  const usedSlideIds = new Set<string>()
  const usedElementIds = new Set<string>()
  const diagnostics: string[] = []
  const slides = sources.map((source) => compileSlideSource(source, {
    assets: options.assets ?? {},
    diagnostics,
    existingDocument: options.existingDocument,
    pageSize,
    usedElementIds,
    usedSlideIds,
  }))
  const existingSelection = options.existingDocument?.selectedSlideId
  const selectedSlideId = existingSelection && slides.some((slide) => slide.id === existingSelection)
    ? existingSelection
    : slides[0]!.id
  return {
    diagnostics,
    document: {
      id: options.existingDocument?.id ?? blank.id,
      master,
      pageSize,
      selectedSlideId,
      slides,
      title: optionalString(sources[0]!.frontmatter.title) ?? options.existingDocument?.title ?? '',
      version: options.existingDocument?.version ?? 1,
    },
  }
}

/** Compile exactly one slide Markdown fragment against an existing document. */
export function compilePresentationSlideMarkdown(
  markdown: string,
  options: CompilePresentationSlideMarkdownOptions,
): CompilePresentationSlideMarkdownResult {
  const sources = parsePresentationMarkdown(markdown)
  if (sources.length !== 1) throw new Error('A slide update must contain exactly one Markdown slide')
  const usedSlideIds = new Set(options.document.slides.map((slide) => slide.id))
  const requestedId = optionalString(sources[0]!.frontmatter.id)
  if (requestedId) usedSlideIds.delete(requestedId)
  const usedElementIds = new Set(options.document.slides.flatMap((slide) => (
    slide.id === requestedId ? [] : slide.elements.map((element) => element.id)
  )))
  const diagnostics: string[] = []
  const slide = compileSlideSource(sources[0]!, {
    assets: options.assets ?? {},
    diagnostics,
    existingDocument: options.existingDocument ?? options.document,
    pageSize: options.document.pageSize,
    usedElementIds,
    usedSlideIds,
  })
  return { diagnostics, slide }
}

/** Compile exactly one canonical Ppt* element fragment against a live slide. */
export function compilePresentationElementMarkdown(
  markdown: string,
  options: CompilePresentationElementMarkdownOptions,
): CompilePresentationElementMarkdownResult {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new TypeError('PowerPoint element Markdown is required')
  const components = parseNativeComponents(markdown)
  if (!components || components.length !== 1) {
    throw new Error('PowerPoint element Markdown must contain exactly one Ppt* element')
  }
  const component = components[0]!
  const requested = componentRef(component.attrs)
  if (options.elementId) {
    if (requested && requested !== options.elementId) {
      throw new Error(`PowerPoint element ref must remain ${options.elementId}`)
    }
    component.attrs.ref = options.elementId
    delete component.attrs.id
  } else if (requested) {
    throw new Error('A new PowerPoint element must not provide id or ref; the editor assigns its ref')
  }
  const usedElementIds = new Set(options.document.slides.flatMap((slide) => (
    slide.elements.flatMap((element) => element.id === options.elementId ? [] : [element.id])
  )))
  const diagnostics: string[] = []
  const context: ElementCompilerContext = {
    assets: options.assets ?? {},
    cursor: { full: 56, left: 76, right: 76, slot: 'full' },
    diagnostics,
    elementOrdinal: options.slide.elements.length,
    existingDocument: options.existingDocument ?? options.document,
    pageSize: options.document.pageSize,
    slideId: options.slide.id,
    usedElementIds,
  }
  return { diagnostics, element: compileNativeComponent(component, context) }
}

/** Return the local paths referenced by parsed Markdown without mutating any presentation state. */
export function inspectPresentationMarkdownAssets(markdown: string): string[] {
  const paths = new Set<string>()
  if (markdown.trimStart().startsWith('<Ppt')) {
    const components = parseNativeComponents(markdown)
    if (!components || components.length !== 1) {
      throw new Error('PowerPoint element Markdown must contain exactly one Ppt* element')
    }
    const component = components[0]!
    if (MEDIA_COMPONENT_NAMES.has(component.name)) collectAssetPath(component.attrs.src, paths)
    return [...paths]
  }
  for (const source of parsePresentationMarkdown(markdown)) {
    const parsed = extractNotes(source.body)
    const tokens = marked.lexer(parsed.body, { gfm: true })
    for (const token of tokens) {
      if (token.type === 'code') continue
      const components = parseNativeComponents(token.raw)
      if (components) {
        for (const component of components) {
          if (MEDIA_COMPONENT_NAMES.has(component.name)) collectAssetPath(component.attrs.src, paths)
        }
        continue
      }
      marked.walkTokens([token], (nestedToken) => {
        if (nestedToken.type === 'image') collectAssetPath((nestedToken as Tokens.Image).href, paths)
      })
    }
  }
  return [...paths]
}

/** Produce one canonical, self-contained slide Markdown fragment. */
export function decompilePresentationSlideMarkdown(
  slide: PresentationSlide,
): string {
  return decompileSlide(slide)
}

/** Produce one canonical Agent-editable element fragment with a stable ref. */
export function decompilePresentationElementMarkdown(element: PresentationElement): string {
  return decompileElement(element)
}

function parsePresentationMarkdown(markdown: string): ParsedSlideSource[] {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new TypeError('PowerPoint Markdown is required')
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const delimiters = findTopLevelDelimiters(lines)
  const firstContentLine = lines.findIndex((line) => line.trim())
  if (firstContentLine < 0 || delimiters[0] !== firstContentLine) {
    throw new Error('PowerPoint Markdown must begin with a --- frontmatter block')
  }
  if (delimiters.length < 2 || delimiters.length % 2 !== 0) {
    throw new Error('Every PowerPoint slide must have a closed --- frontmatter block')
  }
  const slides: ParsedSlideSource[] = []
  for (let pair = 0; pair < delimiters.length; pair += 2) {
    const open = delimiters[pair]!
    const close = delimiters[pair + 1]!
    const next = delimiters[pair + 2] ?? lines.length
    if (close <= open + 0) throw new Error(`Slide ${pair / 2 + 1} has invalid frontmatter`)
    const yamlSource = lines.slice(open + 1, close).join('\n')
    let value: unknown
    try {
      value = load(yamlSource) ?? {}
    } catch (error) {
      throw new Error(`Invalid YAML in slide ${pair / 2 + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRecord(value)) throw new TypeError(`Slide ${pair / 2 + 1} frontmatter must be a YAML mapping`)
    slides.push({ body: lines.slice(close + 1, next).join('\n').trim(), frontmatter: value, index: pair / 2 })
  }
  if (slides.length === 0) throw new Error('A presentation must contain at least one slide')
  return slides
}

function findTopLevelDelimiters(lines: string[]): number[] {
  const delimiters: number[] = []
  let fence: { character: '`' | '~'; length: number } | null = null
  let inComment = false
  let opaqueTag: 'script' | 'style' | 'template' | null = null
  let nativeComponent: { name: string; openingTag: boolean } | null = null
  lines.forEach((line, index) => {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`).test(line)) fence = null
      return
    }
    if (inComment) {
      if (line.includes('-->')) inComment = false
      return
    }
    if (opaqueTag) {
      if (new RegExp(`</${opaqueTag}\\s*>`, 'i').test(line)) opaqueTag = null
      return
    }
    if (nativeComponent) {
      if (nativeComponent.openingTag) {
        if (/\/\s*>/.test(line)) nativeComponent = null
        else if (/>/.test(line)) {
          nativeComponent = new RegExp(`</${nativeComponent.name}\\s*>`).test(line)
            ? null
            : { ...nativeComponent, openingTag: false }
        }
      } else if (new RegExp(`</${nativeComponent.name}\\s*>`).test(line)) {
        nativeComponent = null
      }
      return
    }
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      fence = {
        character: fenceMatch[1]![0] as '`' | '~',
        length: fenceMatch[1]!.length,
      }
      return
    }
    const commentStart = line.indexOf('<!--')
    if (commentStart >= 0 && line.indexOf('-->', commentStart + 4) < 0) {
      inComment = true
      return
    }
    const opaqueMatch = line.match(/<(script|style|template)\b/i)
    if (opaqueMatch && !new RegExp(`</${opaqueMatch[1]}\\s*>`, 'i').test(line)) {
      opaqueTag = opaqueMatch[1]!.toLowerCase() as 'script' | 'style' | 'template'
      return
    }
    const nativeMatch = line.match(/<(Ppt(?:Text|Shape|Image|Audio|Video|Table|Chart))\b/)
    if (nativeMatch && !/\/\s*>/.test(line) && !new RegExp(`</${nativeMatch[1]}\\s*>`).test(line)) {
      nativeComponent = { name: nativeMatch[1]!, openingTag: !/>/.test(line) }
      return
    }
    if (/^---\s*$/.test(line)) delimiters.push(index)
  })
  return delimiters
}

function compileSlideSource(
  source: ParsedSlideSource,
  context: Omit<ElementCompilerContext, 'cursor' | 'elementOrdinal' | 'slideId'> & { usedSlideIds: Set<string> },
): PresentationSlide {
  const frontmatter = source.frontmatter
  const id = optionalString(frontmatter.id) ?? `slide-${source.index + 1}`
  validateId(id, 'slide id')
  if (context.usedSlideIds.has(id)) throw new Error(`Duplicate slide id: ${id}`)
  context.usedSlideIds.add(id)
  const template = createBlankPresentationSlide(optionalString(frontmatter.name) ?? `Slide ${source.index + 1}`)
  const parsedBody = extractNotes(source.body)
  const cursor: LayoutCursor = { full: 56, left: 76, right: 76, slot: 'full' }
  const elementContext: ElementCompilerContext = { ...context, cursor, elementOrdinal: 0, slideId: id }
  const elements = compileMarkdownBlocks(parsedBody.body, elementContext)
  if (elements.length > MAX_ELEMENTS_PER_SLIDE) {
    throw new Error(`Slide ${id} may contain at most ${MAX_ELEMENTS_PER_SLIDE} elements`)
  }
  return {
    ...template,
    background: optionalString(frontmatter.background) ?? context.existingDocument?.master.background ?? '#FFFFFF',
    ...(frontmatter.comments === undefined ? {} : { comments: parseComments(frontmatter.comments, id) }),
    elements,
    ...(frontmatter.footer === undefined ? {} : { footer: parseFooter(frontmatter.footer, 'footer') }),
    id,
    layout: parseLayout(frontmatter.layout),
    name: optionalString(frontmatter.name) ?? `Slide ${source.index + 1}`,
    notes: parsedBody.notes,
    transition: parseTransition(frontmatter.transition, template.transition),
  }
}

function extractNotes(body: string): ParsedBody {
  const match = body.match(/(?:^|\n)\s*<!--\s*(?:notes\b)?\s*\n?([\s\S]*?)-->\s*$/i)
  if (!match || match.index === undefined) return { body, notes: '' }
  return { body: body.slice(0, match.index).trimEnd(), notes: match[1]!.trim() }
}

function parseNativeComponents(source: string): NativeComponent[] | null {
  let remaining = source.trim()
  const components: NativeComponent[] = []
  while (remaining) {
    const match = remaining.match(NATIVE_COMPONENT_PATTERN)
    if (!match) return null
    components.push({
      attrs: parseComponentAttrs(match[2] ?? ''),
      body: (match[3] ?? '').replace(/^\n/, '').replace(/\n$/, ''),
      name: `Ppt${match[1]}` as NativeComponent['name'],
    })
    remaining = remaining.slice(match[0].length).trimStart()
  }
  return components.length > 0 ? components : null
}

function parseComponentAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const consumed = source.replace(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, key: string, double: string, single: string) => {
    attrs[key] = decodeEntities(double ?? single ?? '')
    return ' '
  })
  for (const token of consumed.trim().split(/\s+/).filter(Boolean)) {
    if (!/^[A-Za-z_][\w:.-]*$/.test(token)) throw new Error(`Invalid native component attributes: ${source.trim()}`)
    attrs[token] = 'true'
  }
  return attrs
}

function compileMarkdownBlocks(source: string, context: ElementCompilerContext): PresentationElement[] {
  if (!source.trim()) return []
  const elements: PresentationElement[] = []
  for (const token of marked.lexer(source, { gfm: true })) {
    if (token.type === 'space') continue
    if (token.type !== 'code') {
      const components = parseNativeComponents(token.raw)
      if (components) {
        for (const component of components) {
          const element = compileNativeComponent(component, context)
          elements.push(element)
          const slot = context.cursor.slot
          context.cursor[slot] = Math.max(context.cursor[slot], element.y + element.height + 18)
        }
        continue
      }
    }
    if (token.type === 'html') {
      const raw = token.raw.trim()
      if (/^<!--[\s\S]*-->$/.test(raw)) continue
      if (/^<style\b[\s\S]*<\/style>$/i.test(raw)) {
        context.diagnostics.push(`[slide_ref=${context.slideId}] <style> is accepted but ignored by the native PPT compiler`)
        continue
      }
      throw new Error(`Unsupported HTML or Vue block on slide ${context.slideId}; use Markdown or a Ppt* component`)
    }
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      const parsed = extractBlockId(inlineText(heading.tokens))
      let fontSize = 24
      if (heading.depth === 1) fontSize = 42
      else if (heading.depth === 2) fontSize = 32
      elements.push(createTextElement(context, parsed.text, {
        explicitId: parsed.id,
        fontSize,
        fontWeight: 700,
        height: heading.depth === 1 ? 72 : 54,
        kind: `h${heading.depth}`,
      }))
      continue
    }
    if (token.type === 'paragraph') {
      const paragraph = token as Tokens.Paragraph
      const meaningful = paragraph.tokens.filter((item) => item.type !== 'space')
      if (meaningful.length === 1 && meaningful[0]?.type === 'image') {
        const image = meaningful[0] as Tokens.Image
        const parsed = extractBlockId(image.text)
        elements.push(createImageElement(context, image.href, parsed.text, parsed.id))
        continue
      }
      const parsed = extractBlockId(inlineText(paragraph.tokens))
      if (parsed.text === '::left::' || parsed.text === '::right::' || parsed.text === '::default::') {
        context.cursor.slot = parsed.text === '::default::' ? 'full' : parsed.text.slice(2, -2) as 'left' | 'right'
        continue
      }
      elements.push(createTextElement(context, parsed.text, {
        explicitId: parsed.id,
        fontSize: 22,
        fontWeight: 400,
        height: Math.max(46, parsed.text.split('\n').length * 30),
        kind: 'paragraph',
      }))
      continue
    }
    if (token.type === 'list') {
      const list = token as Tokens.List
      const trailing = list.raw.match(/\n\s*\{#([A-Za-z0-9_.:-]+)\}\s*$/)
      const text = list.items.map((item) => inlineText(item.tokens)).join('\n')
      elements.push(createTextElement(context, text, {
        explicitId: trailing?.[1],
        fontSize: 22,
        fontWeight: 400,
        height: Math.max(58, list.items.length * 34),
        kind: 'list',
        listStyle: list.ordered ? 'number' : 'bullet',
      }))
      continue
    }
    if (token.type === 'table') {
      const table = token as Tokens.Table
      const box = allocateBox(context, Math.max(100, (table.rows.length + 1) * 42))
      const id = reserveElementId(context, undefined, 'table')
      elements.push({
        ...box,
        id,
        type: 'table',
        rotation: 0,
        cells: [table.header.map((cell) => inlineText(cell.tokens)), ...table.rows.map((row) => row.map((cell) => inlineText(cell.tokens)))],
        headerRow: true,
        headerFill: '#E8EAF0',
        bodyFill: '#FFFFFF',
        textColor: '#20202B',
        borderColor: '#B8BCC8',
        fontSize: 18,
      })
      continue
    }
    if (token.type === 'code') {
      const code = token as Tokens.Code
      elements.push(createTextElement(context, code.text, {
        fontFamily: 'Aptos Mono',
        fontSize: 18,
        fontWeight: 400,
        height: Math.max(70, code.text.split('\n').length * 25 + 24),
        kind: 'code',
      }))
      continue
    }
    if (token.type === 'blockquote') {
      const quote = token as Tokens.Blockquote
      elements.push(createTextElement(context, inlineText(quote.tokens), {
        fontSize: 24,
        fontWeight: 400,
        height: 72,
        italic: true,
        kind: 'quote',
      }))
      continue
    }
    if (token.type === 'hr') continue
    throw new Error(`Unsupported Markdown block ${token.type} on slide ${context.slideId}`)
  }
  return elements
}

function compileNativeComponent(component: NativeComponent, context: ElementCompilerContext): PresentationElement {
  const attrs = component.attrs
  for (const name of Object.keys(attrs)) {
    if (!COMPONENT_ATTRS[component.name].has(name)) {
      throw new Error(`Unsupported ${component.name} attribute: ${name}`)
    }
  }
  if (component.name === 'PptText') {
    const defaults = allocateBox(context, numberAttr(attrs.height, 80))
    const textColors = presentationThemeTextColors(context.existingDocument?.master.background ?? '#FFFFFF')
    return withCommonAttrs({
      ...defaults,
      id: reserveElementId(context, componentRef(attrs), 'text'),
      type: 'text',
      text: decodeEntities(component.body),
      fontSize: numberAttr(attrs.fontSize, 28),
      fontFamily: attrs.fontFamily ?? context.existingDocument?.master.bodyFontFamily ?? 'Aptos',
      fontWeight: enumNumberAttr(attrs.fontWeight, new Set([400, 500, 600, 700]), 400),
      italic: booleanAttr(attrs.italic, false),
      underline: booleanAttr(attrs.underline, false),
      strikethrough: booleanAttr(attrs.strikethrough, false),
      baseline: enumAttr(attrs.baseline, new Set<NonNullable<PresentationTextElement['baseline']>>(['normal', 'superscript', 'subscript']), 'normal'),
      ...(attrs.highlightColor ? { highlightColor: attrs.highlightColor } : {}),
      characterSpacing: numberAttr(attrs.characterSpacing, 0),
      lineHeight: numberAttr(attrs.lineHeight, 1.08),
      indentLevel: numberAttr(attrs.indentLevel, 0),
      listStyle: enumAttr(attrs.listStyle, new Set<NonNullable<PresentationTextElement['listStyle']>>(['none', 'bullet', 'number']), 'none'),
      color: attrs.color ?? textColors.secondary,
      align: enumAttr(attrs.align, new Set(['left', 'center', 'right', 'justify']), 'left'),
      verticalAlign: enumAttr(attrs.verticalAlign, new Set<NonNullable<PresentationTextElement['verticalAlign']>>(['top', 'middle', 'bottom']), 'top'),
      textDirection: enumAttr(attrs.textDirection, new Set<NonNullable<PresentationTextElement['textDirection']>>([
        'horizontal', 'eastAsianVertical', 'vertical', 'vertical270', 'stacked',
      ]), 'horizontal'),
      wordWrap: booleanAttr(attrs.wordWrap, true),
      ...(hasAnyAttr(attrs, ['insetLeft', 'insetTop', 'insetRight', 'insetBottom']) ? {
        textInsets: {
          left: numberAttr(attrs.insetLeft, 0),
          top: numberAttr(attrs.insetTop, 0),
          right: numberAttr(attrs.insetRight, 0),
          bottom: numberAttr(attrs.insetBottom, 0),
        },
      } : {}),
    }, attrs)
  }
  if (component.name === 'PptShape') {
    const kind = enumAttr(attrs.kind ?? attrs.type, SHAPE_TYPES, 'rect')
    const defaults = allocateBox(context, numberAttr(attrs.height, 120))
    const accent = context.existingDocument?.master.accentColors[0] ?? '#5B67F1'
    return withCommonAttrs({
      ...defaults,
      id: reserveElementId(context, componentRef(attrs), kind),
      type: kind,
      fill: attrs.fill ?? accent,
      borderColor: attrs.borderColor ?? accent,
      borderWidth: numberAttr(attrs.borderWidth, 1),
      ...(attrs.radius === undefined ? {} : { radius: numberAttr(attrs.radius, 0) }),
    }, attrs)
  }
  if (component.name === 'PptImage') {
    const defaults = allocateBox(context, numberAttr(attrs.height, 260))
    const id = reserveElementId(context, componentRef(attrs), 'image')
    return withCommonAttrs({
      ...defaults,
      id,
      type: 'image',
      source: resolveMediaSource(attrs.src, 'image', id, context),
      altText: attrs.alt ?? attrs.altText ?? '',
      fit: enumAttr(attrs.fit, new Set(['contain', 'cover']), 'contain'),
      ...(attrs.clipShape === undefined ? {} : {
        clipShape: enumAttr(attrs.clipShape, new Set(['ellipse'] as const), 'ellipse'),
      }),
      ...(hasAnyAttr(attrs, ['cropLeft', 'cropTop', 'cropRight', 'cropBottom']) ? {
        crop: {
          left: numberAttr(attrs.cropLeft, 0),
          top: numberAttr(attrs.cropTop, 0),
          right: numberAttr(attrs.cropRight, 0),
          bottom: numberAttr(attrs.cropBottom, 0),
        },
      } : {}),
    }, attrs)
  }
  if (component.name === 'PptAudio' || component.name === 'PptVideo') {
    const type = component.name === 'PptAudio' ? 'audio' : 'video'
    const defaults = allocateBox(context, numberAttr(attrs.height, type === 'audio' ? 80 : 260))
    const id = reserveElementId(context, componentRef(attrs), type)
    return withCommonAttrs({
      ...defaults,
      id,
      type,
      source: resolveMediaSource(attrs.src, type, id, context),
      autoplay: booleanAttr(attrs.autoplay, false),
      loop: booleanAttr(attrs.loop, false),
      muted: booleanAttr(attrs.muted, false),
    }, attrs) as PresentationElement
  }
  if (component.name === 'PptTable') {
    const cells = parseMarkdownTable(component.body)
    const defaults = allocateBox(context, numberAttr(attrs.height, Math.max(100, cells.length * 42)))
    const background = context.existingDocument?.master.background ?? '#FFFFFF'
    const accent = context.existingDocument?.master.accentColors[0] ?? '#5B67F1'
    const textColors = presentationThemeTextColors(background)
    return withCommonAttrs({
      ...defaults,
      id: reserveElementId(context, componentRef(attrs), 'table'),
      type: 'table',
      cells,
      headerRow: booleanAttr(attrs.headerRow, true),
      headerFill: attrs.headerFill ?? accent,
      bodyFill: attrs.bodyFill ?? background,
      textColor: attrs.textColor ?? textColors.primary,
      borderColor: attrs.borderColor ?? '#B8BCC8',
      fontSize: numberAttr(attrs.fontSize, 18),
    }, attrs)
  }
  const chartData = parseChartData(component.body)
  const defaults = allocateBox(context, numberAttr(attrs.height, 300))
  const chartColors = context.existingDocument?.master.accentColors ?? ['#5B67F1']
  return withCommonAttrs({
    ...defaults,
    id: reserveElementId(context, componentRef(attrs), 'chart'),
    type: 'chart',
    chartType: enumAttr(attrs.type ?? attrs.chartType, new Set(['column', 'bar', 'line', 'pie', 'doughnut']), 'column'),
    categories: chartData.categories,
    series: chartData.series,
    showLegend: booleanAttr(attrs.showLegend, true),
    showValue: booleanAttr(attrs.showValue, false),
    ...(attrs.title ? { title: attrs.title } : {}),
    colors: stringListAttr(attrs.colors, chartColors),
    ...(attrs.chartAreaFill ? { chartAreaFill: attrs.chartAreaFill } : {}),
    ...(attrs.plotAreaFill ? { plotAreaFill: attrs.plotAreaFill } : {}),
    ...(attrs.categoryAxisLabelColor ? { categoryAxisLabelColor: attrs.categoryAxisLabelColor } : {}),
    ...(attrs.valueAxisLabelColor ? { valueAxisLabelColor: attrs.valueAxisLabelColor } : {}),
    ...(attrs.gridLineColor ? { gridLineColor: attrs.gridLineColor } : {}),
    ...(attrs.dataLabelColor ? { dataLabelColor: attrs.dataLabelColor } : {}),
  }, attrs)
}

function createTextElement(
  context: ElementCompilerContext,
  text: string,
  options: {
    explicitId?: string
    fontFamily?: string
    fontSize: number
    fontWeight: 400 | 500 | 600 | 700
    height: number
    italic?: boolean
    kind: string
    listStyle?: PresentationTextElement['listStyle']
  },
): PresentationTextElement {
  const master = context.existingDocument?.master
  const title = options.fontWeight >= 600 || options.fontSize >= 30
  const textColors = presentationThemeTextColors(master?.background ?? '#FFFFFF')
  return {
    ...allocateBox(context, options.height),
    id: reserveElementId(context, options.explicitId, options.kind),
    type: 'text',
    text,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily ?? (title ? master?.titleFontFamily : master?.bodyFontFamily) ?? 'Aptos',
    fontWeight: options.fontWeight,
    italic: options.italic ?? false,
    listStyle: options.listStyle ?? 'none',
    color: title ? textColors.primary : textColors.secondary,
    align: 'left',
    rotation: 0,
  }
}

function createImageElement(
  context: ElementCompilerContext,
  src: string,
  altText: string,
  explicitId?: string,
): PresentationElement {
  const id = reserveElementId(context, explicitId, 'image')
  return {
    ...allocateBox(context, 280),
    id,
    type: 'image',
    source: resolveMediaSource(src, 'image', id, context),
    altText,
    fit: 'contain',
    rotation: 0,
  }
}

function withCommonAttrs<T extends PresentationElement>(element: T, attrs: Record<string, string>): T {
  const next = {
    ...element,
    x: numberAttr(attrs.x, element.x),
    y: numberAttr(attrs.y, element.y),
    width: numberAttr(attrs.width, element.width),
    height: numberAttr(attrs.height, element.height),
    rotation: numberAttr(attrs.rotation, 0),
    ...(attrs.flipHorizontal === undefined ? {} : { flipHorizontal: booleanAttr(attrs.flipHorizontal, false) }),
    ...(attrs.flipVertical === undefined ? {} : { flipVertical: booleanAttr(attrs.flipVertical, false) }),
    ...(attrs.opacity === undefined ? {} : { opacity: boundedNumberAttr(attrs.opacity, 0, 1) }),
    ...(attrs.groupId ? { groupId: attrs.groupId } : {}),
    ...(attrs.shadow === undefined ? {} : { shadow: booleanAttr(attrs.shadow, false) }),
    ...(attrs.animation ? {
      animation: enumAttr(attrs.animation, ANIMATION_EFFECTS, 'none'),
      animationDuration: nonNegativeNumberAttr(attrs.animationDuration, 0.5),
      animationDelay: nonNegativeNumberAttr(attrs.animationDelay, 0),
      animationStart: enumAttr(attrs.animationStart, ANIMATION_STARTS, 'onClick'),
      ...(attrs.animationTrigger ? { animationTrigger: enumAttr(attrs.animationTrigger, ANIMATION_TRIGGERS, 'slideClick') } : {}),
      ...(attrs.animationColor ? { animationColor: attrs.animationColor } : {}),
    } : {}),
    ...(attrs.href ? { hyperlink: { type: 'url' as const, url: attrs.href, ...(attrs.tooltip ? { tooltip: attrs.tooltip } : {}) } } : {}),
    ...(attrs.slideHref ? { hyperlink: { type: 'slide' as const, slideId: attrs.slideHref, ...(attrs.tooltip ? { tooltip: attrs.tooltip } : {}) } } : {}),
  }
  validateGeometry(next)
  return next as T
}

function allocateBox(context: ElementCompilerContext, height: number): Pick<PresentationElement, 'height' | 'width' | 'x' | 'y' | 'rotation'> {
  const gap = 18
  const slot = context.cursor.slot
  const columnWidth = (context.pageSize.width - 210) / 2
  let x = context.pageSize.width / 2 + 35
  if (slot === 'full') x = 80
  else if (slot === 'left') x = 70
  const width = slot === 'full' ? context.pageSize.width - 160 : columnWidth
  const y = context.cursor[slot]
  context.cursor[slot] = y + height + gap
  return { x, y, width, height, rotation: 0 }
}

function reserveElementId(context: ElementCompilerContext, requested: string | undefined, kind: string): string {
  context.elementOrdinal += 1
  if (requested) {
    validateId(requested, 'element ref')
    if (context.usedElementIds.has(requested)) throw new Error(`Duplicate element ref: ${requested}`)
    context.usedElementIds.add(requested)
    return requested
  }
  let generated = `${context.slideId}-${kind}-${context.elementOrdinal}`
  while (context.usedElementIds.has(generated)) {
    context.elementOrdinal += 1
    generated = `${context.slideId}-${kind}-${context.elementOrdinal}`
  }
  context.usedElementIds.add(generated)
  return generated
}

function componentRef(attrs: Record<string, string>): string | undefined {
  const id = optionalString(attrs.id)
  const ref = optionalString(attrs.ref)
  if (id && ref && id !== ref) throw new Error('PowerPoint element id and ref must match when both are provided')
  return ref ?? id
}

function resolveMediaSource(
  rawSrc: string | undefined,
  type: 'audio' | 'image' | 'video',
  elementId: string,
  context: ElementCompilerContext,
): PresentationFileSource {
  const src = optionalString(rawSrc)
  if (!src) throw new Error(`${type} ${elementId} requires src`)
  if (src.startsWith('@existing/')) {
    const existingId = src.slice('@existing/'.length)
    const existing = context.existingDocument?.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.id === existingId && element.type === type)
    if (!existing || (existing.type !== 'image' && existing.type !== 'audio' && existing.type !== 'video')) {
      throw new Error(`Unknown existing PowerPoint ${type} element: ${existingId}`)
    }
    return { ...existing.source }
  }
  if (/^(?:data:|https?:|file:|\/|[A-Za-z]:[\\/])/i.test(src)) {
    throw new Error(`${type} ${elementId} src must be a Session-workspace-relative path or @existing reference`)
  }
  const asset = context.assets[src]
  if (!asset?.assetId || !asset.dataUrl) throw new Error(`PowerPoint asset was not registered: ${src}`)
  if (asset.mimeType && !asset.mimeType.startsWith(`${type}/`)) {
    throw new Error(`PowerPoint ${type} src has incompatible media type: ${asset.mimeType}`)
  }
  return { ...asset, path: src }
}

function collectAssetPath(rawSrc: string | undefined, paths: Set<string>): void {
  const src = optionalString(rawSrc)
  if (!src || src.startsWith('@existing/') || /^(?:data:|https?:|file:|\/|[A-Za-z]:[\\/]|#)/i.test(src)) return
  paths.add(src)
}

function parsePageSize(raw: unknown): PresentationPageSize {
  if (raw === undefined || raw === null) return { ...PRESENTATION_PAGE_SIZES.wide }
  if (typeof raw === 'string') {
    if (!(raw in PRESENTATION_PAGE_SIZES)) throw new Error(`Unsupported page-size preset: ${raw}`)
    return { ...PRESENTATION_PAGE_SIZES[raw as keyof typeof PRESENTATION_PAGE_SIZES] }
  }
  if (!isRecord(raw)) throw new TypeError('pageSize must be a preset name or mapping')
  const preset = optionalString(raw.preset) ?? 'wide'
  if (!(preset in PRESENTATION_PAGE_SIZES)) throw new Error(`Unsupported page-size preset: ${preset}`)
  const fallback = PRESENTATION_PAGE_SIZES[preset as keyof typeof PRESENTATION_PAGE_SIZES]
  return {
    preset: preset as PresentationPageSize['preset'],
    width: positiveNumber(raw.width, fallback.width, 'pageSize.width'),
    height: positiveNumber(raw.height, fallback.height, 'pageSize.height'),
  }
}

function parseMaster(raw: unknown, fallback: PresentationDocument['master']): PresentationDocument['master'] {
  if (raw === undefined || raw === null) return structuredClone(fallback)
  if (!isRecord(raw)) throw new TypeError('master must be a mapping')
  return {
    accentColors: raw.accentColors === undefined
      ? [...fallback.accentColors]
      : parseColorList(raw.accentColors, 'master.accentColors'),
    background: optionalString(raw.background) ?? fallback.background,
    bodyFontFamily: optionalString(raw.bodyFontFamily) ?? fallback.bodyFontFamily,
    footer: raw.footer === undefined ? { ...fallback.footer } : parseFooter(raw.footer, 'master.footer'),
    titleFontFamily: optionalString(raw.titleFontFamily) ?? fallback.titleFontFamily,
  }
}

function parseColorList(raw: unknown, name: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((value) => typeof value !== 'string')) {
    throw new TypeError(`${name} must be a non-empty string array`)
  }
  return raw.map((value) => normalizePresentationDesignColor(value as string))
}

function parseFooter(raw: unknown, name: string): PresentationFooter {
  if (!isRecord(raw)) throw new TypeError(`${name} must be a mapping`)
  return {
    text: optionalString(raw.text) ?? '',
    showDate: optionalBoolean(raw.showDate, false, `${name}.showDate`),
    showSlideNumber: optionalBoolean(raw.showSlideNumber, false, `${name}.showSlideNumber`),
  }
}

function parseTransition(raw: unknown, fallback: PresentationTransition): PresentationTransition {
  if (raw === undefined || raw === null) return { ...fallback }
  if (!isRecord(raw)) throw new TypeError('transition must be a mapping')
  const effect = optionalString(raw.effect) ?? fallback.effect
  if (!TRANSITION_EFFECTS.has(effect as PresentationTransition['effect'])) throw new Error(`Unsupported transition effect: ${effect}`)
  const direction = optionalString(raw.direction)
  if (direction && !TRANSITION_DIRECTIONS.has(direction as NonNullable<PresentationTransition['direction']>)) {
    throw new Error(`Unsupported transition direction: ${direction}`)
  }
  return {
    effect: effect as PresentationTransition['effect'],
    durationMs: nonNegativeNumber(raw.durationMs, fallback.durationMs, 'transition.durationMs'),
    ...(direction ? { direction: direction as NonNullable<PresentationTransition['direction']> } : {}),
    ...(raw.throughBlack === undefined ? {} : { throughBlack: optionalBoolean(raw.throughBlack, false, 'transition.throughBlack') }),
  }
}

function parseLayout(raw: unknown): PresentationSlideLayout {
  const aliases: Record<string, PresentationSlideLayout> = {
    cover: 'title',
    'title-content': 'titleContent',
    'two-cols': 'twoContent',
    freeform: 'blank',
  }
  const requested = optionalString(raw) ?? 'blank'
  const layout = aliases[requested] ?? requested
  if (!LAYOUTS.has(layout as PresentationSlideLayout)) throw new Error(`Unsupported slide layout: ${requested}`)
  return layout as PresentationSlideLayout
}

function parseComments(raw: unknown, slideId: string): NonNullable<PresentationSlide['comments']> {
  if (!Array.isArray(raw)) throw new TypeError('comments must be an array')
  return raw.map((value, index) => {
    if (!isRecord(value)) throw new TypeError(`comments[${index}] must be a mapping`)
    return {
      author: optionalString(value.author) ?? 'Agent',
      createdAt: optionalString(value.createdAt) ?? new Date().toISOString(),
      ...(optionalString(value.elementId) ? { elementId: optionalString(value.elementId) } : {}),
      id: optionalString(value.id) ?? `${slideId}-comment-${index + 1}`,
      resolved: optionalBoolean(value.resolved, false, `comments[${index}].resolved`),
      text: requiredString(value.text, `comments[${index}].text`),
    }
  })
}

function parseChartData(body: string): Pick<PresentationChartElement, 'categories' | 'series'> {
  let raw: unknown
  try {
    raw = load(body) ?? {}
  } catch (error) {
    throw new Error(`Invalid PptChart YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(raw)) throw new TypeError('PptChart body must be a YAML mapping')
  if (!Array.isArray(raw.categories) || raw.categories.some((value) => typeof value !== 'string')) {
    throw new TypeError('PptChart categories must be a string array')
  }
  const categories = raw.categories as string[]
  if (!Array.isArray(raw.series)) throw new TypeError('PptChart series must be an array')
  const series = raw.series.map((value, index) => {
    if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.values)) {
      throw new TypeError(`PptChart series[${index}] must contain name and values`)
    }
    if (value.values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
      throw new TypeError(`PptChart series[${index}].values must contain finite numbers`)
    }
    return { name: value.name, values: value.values as number[] }
  })
  if (series.some((item) => item.values.length !== categories.length)) {
    throw new Error('Every PptChart series must match the categories length')
  }
  return { categories, series }
}

function parseMarkdownTable(source: string): string[][] {
  const token = marked.lexer(source, { gfm: true }).find((item) => item.type === 'table') as Tokens.Table | undefined
  if (!token) throw new Error('PptTable body must contain one Markdown table')
  return [
    token.header.map((cell) => inlineText(cell.tokens).replace(/<br\s*\/?>/gi, '\n')),
    ...token.rows.map((row) => row.map((cell) => inlineText(cell.tokens).replace(/<br\s*\/?>/gi, '\n'))),
  ]
}

function inlineText(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  return tokens.map((token) => {
    if (token.type === 'br') return '\n'
    if (token.type === 'image') return (token as Tokens.Image).text
    if ('tokens' in token && Array.isArray(token.tokens)) return inlineText(token.tokens as Token[])
    if ('text' in token && typeof token.text === 'string') return decodeEntities(token.text)
    return ''
  }).join('')
}

function extractBlockId(text: string): { id?: string; text: string } {
  const match = text.match(/\s*\{#([A-Za-z0-9_.:-]+)\}\s*$/)
  return match ? { id: match[1], text: text.slice(0, match.index).trimEnd() } : { text }
}

function decompileSlide(slide: PresentationSlide): string {
  const frontmatter: Record<string, unknown> = {
    id: slide.id,
    name: slide.name,
    layout: slide.layout ?? 'blank',
    background: slide.background,
    transition: slide.transition,
    ...(slide.footer ? { footer: slide.footer } : {}),
    ...(slide.comments?.length ? { comments: slide.comments } : {}),
  }
  const yaml = dump(frontmatter, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd()
  const body = slide.elements.map(decompileElement).join('\n\n')
  const notes = slide.notes?.trim() ? `\n\n<!-- notes\n${slide.notes.trim()}\n-->` : ''
  return `---\n${yaml}\n---\n\n${body}${notes}`.trimEnd()
}

function decompileElement(element: PresentationElement): string {
  const common: Record<string, unknown> = {
    ref: element.id,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    ...(element.flipHorizontal === undefined ? {} : { flipHorizontal: element.flipHorizontal }),
    ...(element.flipVertical === undefined ? {} : { flipVertical: element.flipVertical }),
    ...(element.opacity === undefined ? {} : { opacity: element.opacity }),
    ...(element.groupId ? { groupId: element.groupId } : {}),
    ...(element.shadow === undefined ? {} : { shadow: element.shadow }),
    ...(element.animation ? {
      animation: element.animation,
      ...(element.animationDuration === undefined ? {} : { animationDuration: element.animationDuration }),
      ...(element.animationDelay === undefined ? {} : { animationDelay: element.animationDelay }),
      ...(element.animationStart === undefined ? {} : { animationStart: element.animationStart }),
      ...(element.animationTrigger === undefined ? {} : { animationTrigger: element.animationTrigger }),
      ...(element.animationColor === undefined ? {} : { animationColor: element.animationColor }),
    } : {}),
    ...(element.hyperlink?.type === 'url' ? { href: element.hyperlink.url } : {}),
    ...(element.hyperlink?.type === 'slide' ? { slideHref: element.hyperlink.slideId } : {}),
    ...(element.hyperlink?.tooltip ? { tooltip: element.hyperlink.tooltip } : {}),
  }
  if (element.type === 'text') {
    return component('PptText', {
      ...common,
      fontSize: element.fontSize,
      fontFamily: element.fontFamily,
      fontWeight: element.fontWeight,
      ...(element.italic === undefined ? {} : { italic: element.italic }),
      ...(element.underline === undefined ? {} : { underline: element.underline }),
      ...(element.strikethrough === undefined ? {} : { strikethrough: element.strikethrough }),
      ...(element.baseline === undefined ? {} : { baseline: element.baseline }),
      ...(element.highlightColor === undefined ? {} : { highlightColor: element.highlightColor }),
      ...(element.characterSpacing === undefined ? {} : { characterSpacing: element.characterSpacing }),
      ...(element.lineHeight === undefined ? {} : { lineHeight: element.lineHeight }),
      ...(element.indentLevel === undefined ? {} : { indentLevel: element.indentLevel }),
      ...(element.listStyle === undefined ? {} : { listStyle: element.listStyle }),
      color: element.color,
      align: element.align,
      ...(element.verticalAlign === undefined ? {} : { verticalAlign: element.verticalAlign }),
      ...(element.textDirection === undefined ? {} : { textDirection: element.textDirection }),
      ...(element.wordWrap === undefined ? {} : { wordWrap: element.wordWrap }),
      ...(element.textInsets ? {
        insetLeft: element.textInsets.left,
        insetTop: element.textInsets.top,
        insetRight: element.textInsets.right,
        insetBottom: element.textInsets.bottom,
      } : {}),
    }, escapeText(element.text))
  }
  if (element.type === 'image') {
    return component('PptImage', {
      ...common,
      src: element.source.path ?? `@existing/${element.id}`,
      alt: element.altText,
      fit: element.fit,
      ...(element.clipShape ? { clipShape: element.clipShape } : {}),
      ...(element.crop ? {
        cropLeft: element.crop.left,
        cropTop: element.crop.top,
        cropRight: element.crop.right,
        cropBottom: element.crop.bottom,
      } : {}),
    })
  }
  if (element.type === 'audio' || element.type === 'video') {
    return component(element.type === 'audio' ? 'PptAudio' : 'PptVideo', {
      ...common,
      src: element.source.path ?? `@existing/${element.id}`,
      autoplay: element.autoplay,
      loop: element.loop,
      muted: element.muted,
    })
  }
  if (element.type === 'table') {
    return component('PptTable', {
      ...common,
      headerRow: element.headerRow,
      headerFill: element.headerFill,
      bodyFill: element.bodyFill,
      textColor: element.textColor,
      borderColor: element.borderColor,
      fontSize: element.fontSize,
    }, markdownTable(element.cells))
  }
  if (element.type === 'chart') {
    return component('PptChart', {
      ...common,
      type: element.chartType,
      showLegend: element.showLegend,
      ...(element.showValue === undefined ? {} : { showValue: element.showValue }),
      ...(element.title === undefined ? {} : { title: element.title }),
      colors: element.colors.join(','),
      ...(element.chartAreaFill === undefined ? {} : { chartAreaFill: element.chartAreaFill }),
      ...(element.plotAreaFill === undefined ? {} : { plotAreaFill: element.plotAreaFill }),
      ...(element.categoryAxisLabelColor === undefined ? {} : { categoryAxisLabelColor: element.categoryAxisLabelColor }),
      ...(element.valueAxisLabelColor === undefined ? {} : { valueAxisLabelColor: element.valueAxisLabelColor }),
      ...(element.gridLineColor === undefined ? {} : { gridLineColor: element.gridLineColor }),
      ...(element.dataLabelColor === undefined ? {} : { dataLabelColor: element.dataLabelColor }),
    }, dump({ categories: element.categories, series: element.series }, { lineWidth: -1, noRefs: true }).trimEnd())
  }
  return component('PptShape', {
    ...common,
    kind: element.type,
    fill: element.fill,
    borderColor: element.borderColor,
    borderWidth: element.borderWidth,
    ...(element.radius === undefined ? {} : { radius: element.radius }),
  })
}

function component(name: string, attrs: Record<string, unknown>, body?: string): string {
  const renderedAttrs = Object.entries(attrs).map(([key, value]) => `${key}="${escapeAttr(String(value))}"`).join(' ')
  return body === undefined
    ? `<${name} ${renderedAttrs} />`
    : `<${name} ${renderedAttrs}>\n${body}\n</${name}>`
}

function markdownTable(cells: string[][]): string {
  const width = Math.max(1, ...cells.map((row) => row.length))
  const rows = cells.length ? cells : [['']]
  const renderRow = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => (
    (row[index] ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>')
  )).join(' | ')} |`
  return [renderRow(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(renderRow)].join('\n')
}

function validateId(value: string, name: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`${name} must match ${ID_PATTERN}`)
}

function validateGeometry(element: Pick<PresentationElement, 'height' | 'width' | 'x' | 'y'>): void {
  for (const [name, value] of Object.entries({
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`)
  }
  if (element.width <= 0 || element.height <= 0) throw new Error('PowerPoint element width and height must be positive')
}

function hasAnyAttr(attrs: Record<string, string>, keys: string[]): boolean {
  return keys.some((key) => attrs[key] !== undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new TypeError('Expected a string')
  return value
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value)
  if (!result?.trim()) throw new TypeError(`${name} is required`)
  return result
}

function optionalBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function positiveNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  return value
}

function nonNegativeNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} cannot be negative`)
  return value
}

function numberAttr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`Expected a finite number, got ${value}`)
  return parsed
}

function nonNegativeNumberAttr(value: string | undefined, fallback: number): number {
  const parsed = numberAttr(value, fallback)
  if (parsed < 0) throw new TypeError('Expected a non-negative number')
  return parsed
}

function boundedNumberAttr(value: string | undefined, minimum: number, maximum: number): number {
  const parsed = numberAttr(value, minimum)
  if (parsed < minimum || parsed > maximum) throw new TypeError(`Expected a number from ${minimum} to ${maximum}`)
  return parsed
}

function booleanAttr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new TypeError(`Expected true or false, got ${value}`)
}

function enumAttr<T extends string>(value: string | undefined, allowed: Set<T>, fallback: T): T {
  if (value === undefined) return fallback
  if (!allowed.has(value as T)) throw new Error(`Unsupported value: ${value}`)
  return value as T
}

function enumNumberAttr<T extends number>(value: string | undefined, allowed: Set<T>, fallback: T): T {
  const parsed = numberAttr(value, fallback)
  if (!allowed.has(parsed as T)) throw new Error(`Unsupported numeric value: ${parsed}`)
  return parsed as T
}

function stringListAttr(value: string | undefined, fallback: string[]): string[] {
  return value === undefined ? fallback : value.split(',').map((item) => item.trim()).filter(Boolean)
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
