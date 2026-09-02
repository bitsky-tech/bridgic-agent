import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import {
  getPresentationPageSize,
  type PresentationChartType,
  type PresentationDocument,
  type PresentationElement,
  type PresentationHyperlink,
  type PresentationTransition,
  type PresentationTransitionDirection,
} from '@/atoms/presentation'
import {
  hasPresentationAnimation,
  normalizePresentationAnimation,
  type NormalizedPresentationAnimation,
} from '@/lib/presentationAnimations'
import {
  getPresentationAnimationAffectedElements,
  getPresentationAnimationTargets,
} from '@/lib/presentationGroups'
import {
  hasValidPresentationMediaSignature,
  isPresentationChartElement,
  isPresentationImageElement,
  isPresentationMediaElement,
  isPresentationShapeElement,
  isPresentationTableElement,
  isPresentationTextElement,
  normalizePresentationFileSource,
  type PresentationFileKind,
} from '@/lib/presentationInsert'
import { getPresentationLineEnds, isPresentationLineShape } from '@/lib/presentationShapes'
import {
  presentationCharacterSpacingToPoints,
  presentationFontSizeToPoints,
} from '@/lib/presentationText'
import {
  DEFAULT_PRESENTATION_TRANSITION_DURATION_MS,
  normalizePresentationTransition,
} from '@/lib/presentationTransitions'

const SLIDE_HEIGHT_INCHES = 7.5

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasValidGeometry(value: unknown): value is {
  type: string
  id?: unknown
  x: number
  y: number
  width: number
  height: number
  rotation: number
} {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  return Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && Number.isFinite(value.rotation)
    && (value.width as number) > 0
    && (value.height as number) > 0
}

function presentationColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().replace(/^#/, '')
  if (/^[\dA-F]{6}$/i.test(normalized)) return normalized.toUpperCase()
  if (/^[\dA-F]{3}$/i.test(normalized)) {
    return normalized.split('').map((character) => character + character).join('').toUpperCase()
  }
  return fallback
}

function presentationVerticalAlignment(value: unknown): 'top' | 'middle' | 'bottom' {
  if (value === 'bottom') return 'bottom'
  if (value === 'middle') return 'middle'
  return 'top'
}

function presentationTextDirection(value: unknown): 'eaVert' | 'horz' | 'vert' | 'vert270' | 'wordArtVert' | undefined {
  if (value === 'eastAsianVertical') return 'eaVert'
  if (value === 'vertical') return 'vert'
  if (value === 'vertical270') return 'vert270'
  if (value === 'stacked') return 'wordArtVert'
  if (value === 'horizontal') return 'horz'
  return undefined
}

function normalizePresentationFileSourceForExport(kind: PresentationFileKind, source: unknown) {
  if (!isRecord(source)
    || typeof source.dataUrl !== 'string'
    || typeof source.fileName !== 'string'
    || typeof source.mimeType !== 'string') return null

  const normalized = normalizePresentationFileSource(kind, {
    dataUrl: source.dataUrl,
    fileName: source.fileName,
    mimeType: source.mimeType,
  })
  return normalized
}

function presentationImageAspectRatio(dataUrl: string, fallback: number): number {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s/g, '')
  const maximumEncodedBytes = 512 * 1024
  const encodedLength = Math.min(payload.length, maximumEncodedBytes - (maximumEncodedBytes % 4))
  const truncatedPayload = payload.slice(0, encodedLength - (encodedLength % 4))
  let binary = ''
  try {
    binary = atob(truncatedPayload)
  } catch {
    return fallback
  }

  const byte = (index: number): number => binary.charCodeAt(index) & 0xFF
  const validRatio = (width: number, height: number): number | undefined => (
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? width / height
      : undefined
  )

  if (binary.length >= 24 && byte(0) === 0x89 && binary.slice(1, 4) === 'PNG') {
    const width = byte(16) * 0x1000000 + byte(17) * 0x10000 + byte(18) * 0x100 + byte(19)
    const height = byte(20) * 0x1000000 + byte(21) * 0x10000 + byte(22) * 0x100 + byte(23)
    return validRatio(width, height) ?? fallback
  }

  if (binary.length >= 10 && (binary.startsWith('GIF87a') || binary.startsWith('GIF89a'))) {
    const width = byte(6) + byte(7) * 0x100
    const height = byte(8) + byte(9) * 0x100
    return validRatio(width, height) ?? fallback
  }

  if (binary.length >= 4 && byte(0) === 0xFF && byte(1) === 0xD8) {
    let offset = 2
    while (offset + 8 < binary.length) {
      if (byte(offset) !== 0xFF) {
        offset += 1
        continue
      }
      const marker = byte(offset + 1)
      if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(marker)) {
        const height = byte(offset + 5) * 0x100 + byte(offset + 6)
        const width = byte(offset + 7) * 0x100 + byte(offset + 8)
        return validRatio(width, height) ?? fallback
      }
      const segmentLength = byte(offset + 2) * 0x100 + byte(offset + 3)
      if (segmentLength < 2) break
      offset += segmentLength + 2
    }
  }

  if (/^data:image\/svg\+xml/i.test(dataUrl)) {
    const svgStart = binary.indexOf('<svg')
    const svgTag = svgStart >= 0 ? binary.slice(svgStart, binary.indexOf('>', svgStart) + 1) : ''
    const viewBox = /\bviewBox\s*=\s*["']\s*[\d.+-]+[ ,]+[\d.+-]+[ ,]+([\d.]+)[ ,]+([\d.]+)\s*["']/i.exec(svgTag)
    const viewBoxRatio = viewBox ? validRatio(Number(viewBox[1]), Number(viewBox[2])) : undefined
    if (viewBoxRatio) return viewBoxRatio
    const width = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(svgTag)?.[1]
    const height = /\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(svgTag)?.[1]
    return validRatio(Number(width), Number(height)) ?? fallback
  }

  return fallback
}

function xmlAttributeValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function toPptxHyperlink(
  hyperlink: PresentationHyperlink | undefined,
  document: PresentationDocument,
  encodeExternalTarget = false,
): PptxGenJS.HyperlinkProps | undefined {
  if (!isRecord(hyperlink) || typeof hyperlink.type !== 'string') return undefined
  const tooltip = typeof hyperlink.tooltip === 'string' && hyperlink.tooltip.trim()
    ? hyperlink.tooltip.trim()
    : undefined

  if (hyperlink.type === 'slide' && typeof hyperlink.slideId === 'string') {
    const slideIndex = document.slides.findIndex((slide) => slide.id === hyperlink.slideId)
    return slideIndex >= 0 ? { slide: slideIndex + 1, tooltip } : undefined
  }
  if (hyperlink.type !== 'url' || typeof hyperlink.url !== 'string') return undefined

  const target = hyperlink.url.trim()
  if (!target) return undefined
  try {
    const parsed = new URL(target)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return undefined
  } catch {
    return undefined
  }
  // PptxGenJS 4.0.1 XML-escapes text/shape links, but writes image relationship
  // targets verbatim. Pre-escape only that target so URLs containing '&' remain valid XML.
  return { url: encodeExternalTarget ? xmlAttributeValue(target) : target, tooltip }
}

function presentationMediaExtension(source: unknown, type: 'audio' | 'video'): string {
  if (!isRecord(source)) return type === 'audio' ? 'mp3' : 'mp4'
  const mimeType = typeof source.mimeType === 'string' ? source.mimeType.toLowerCase() : ''
  const knownMimeExtensions: Record<string, string> = {
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'video/avi': 'avi',
    'video/mpeg': 'mpeg',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-ms-wmv': 'wmv',
  }
  const knownExtension = knownMimeExtensions[mimeType]
  if (knownExtension) return knownExtension

  const fileName = typeof source.fileName === 'string' ? source.fileName : ''
  const fileExtension = /\.([\dA-Z]{1,10})$/i.exec(fileName.trim())?.[1]?.toLowerCase()
  const allowedExtensions = type === 'audio'
    ? new Set(['aac', 'm4a', 'mp3', 'oga', 'ogg', 'wav', 'wma'])
    : new Set(['avi', 'm4v', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'wmv'])
  if (fileExtension && allowedExtensions.has(fileExtension)) return fileExtension

  const dataUrl = typeof source.dataUrl === 'string' ? source.dataUrl : ''
  const dataSubtype = /^data:(?:audio|video)\/([\dA-Z.+-]+)[;,]/i.exec(dataUrl)?.[1]?.toLowerCase()
  if (dataSubtype === 'mpeg' && type === 'audio') return 'mp3'
  if (dataSubtype === 'mp4' && type === 'audio') return 'm4a'
  const safeSubtype = dataSubtype?.replace(/^x-/, '').replace(/[^\da-z]/g, '')
  if (safeSubtype && allowedExtensions.has(safeSubtype)) return safeSubtype
  return type === 'audio' ? 'mp3' : 'mp4'
}

function chartDefinition(type: PresentationChartType | unknown): {
  type: PptxGenJS.CHART_NAME
  barDir?: 'bar' | 'col'
} | undefined {
  switch (type) {
    case 'column':
      return { type: 'bar', barDir: 'col' }
    case 'bar':
      return { type: 'bar', barDir: 'bar' }
    case 'line':
      return { type: 'line' }
    case 'pie':
      return { type: 'pie' }
    case 'doughnut':
      return { type: 'doughnut' }
    default:
      return undefined
  }
}

/** Convert the renderer-owned presentation model into an Office-compatible PPTX archive. */
export async function createPresentationPptx(document: PresentationDocument): Promise<Uint8Array> {
  const pageSize = getPresentationPageSize(document)
  const slideWidthInches = SLIDE_HEIGHT_INCHES * (pageSize.width / pageSize.height)
  async function addNativePresentationFeatures(bytes: Uint8Array): Promise<Uint8Array> {
    const transitions = document.slides.map((slide) => normalizePresentationTransition(slide.transition))
    const slidesWithAudio = document.slides.map((slide) => (
      Array.isArray(slide.elements) && (slide.elements as unknown[]).some((element) => (
        isRecord(element) && element.type === 'audio'
      ))
    ))
    const slidesWithAnimations = document.slides.map((slide) => (
      Array.isArray(slide.elements) && (slide.elements as PresentationElement[]).some(hasPresentationAnimation)
    ))
    const p14Namespace = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
    const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

    const transitionDuration = (transition: PresentationTransition): number => (
      Number.isFinite(transition.durationMs) && transition.durationMs >= 0
        ? Math.round(transition.durationMs)
        : DEFAULT_PRESENTATION_TRANSITION_DURATION_MS
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

    interface NativeAnimationEntry {
      animation: NormalizedPresentationAnimation
      element: PresentationElement
      shapeId: number
    }

    interface NativeAnimationStep {
      entries: NativeAnimationEntry[]
    }

    interface NativeAnimationGroup {
      steps: NativeAnimationStep[]
      trigger: NativeAnimationEntry
    }

    const shapeIdsByObjectName = (xml: string): Map<string, number> => {
      const result = new Map<string, number>()
      for (const tag of xml.match(/<p:cNvPr\b[^>]*>/g) ?? []) {
        const id = /\bid="(\d+)"/.exec(tag)?.[1]
        const name = /\bname="([^"]+)"/.exec(tag)?.[1]
        if (id && name) result.set(name, Number(id))
      }
      return result
    }

    const groupNativeAnimations = (entries: NativeAnimationEntry[]): NativeAnimationGroup[] => {
      const groups: NativeAnimationGroup[] = []
      let current: NativeAnimationGroup | undefined
      for (const entry of entries) {
        if (entry.animation.start === 'onClick' || !current) {
          current = { steps: [{ entries: [entry] }], trigger: entry }
          groups.push(current)
        } else if (entry.animation.start === 'withPrevious') {
          current.steps.at(-1)?.entries.push(entry)
        } else {
          current.steps.push({ entries: [entry] })
        }
      }
      return groups
    }

    const nativeAnimationDuration = (animation: NormalizedPresentationAnimation): number => (
      animation.effect === 'appear' || animation.effect === 'disappear' ? 1 : animation.durationMs
    )

    const nativeAnimationEffectXml = (entry: NativeAnimationEntry, nodeId: number): string => {
      const { animation, shapeId } = entry
      const duration = nativeAnimationDuration(animation)
      const color = presentationColor(animation.color, '8B7CFF')
      const presets: Record<Exclude<typeof animation.effect, 'none'>, { presetClass: 'entr' | 'emph' | 'exit'; presetId: number; presetSubtype: number }> = {
        appear: { presetClass: 'entr', presetId: 1, presetSubtype: 0 },
        fade: { presetClass: 'entr', presetId: 10, presetSubtype: 0 },
        blinds: { presetClass: 'entr', presetId: 3, presetSubtype: 10 },
        checkerboard: { presetClass: 'entr', presetId: 5, presetSubtype: 6 },
        dissolve: { presetClass: 'entr', presetId: 9, presetSubtype: 0 },
        flyIn: { presetClass: 'entr', presetId: 2, presetSubtype: 4 },
        floatIn: { presetClass: 'entr', presetId: 30, presetSubtype: 0 },
        split: { presetClass: 'entr', presetId: 16, presetSubtype: 21 },
        wipeIn: { presetClass: 'entr', presetId: 22, presetSubtype: 2 },
        zoomIn: { presetClass: 'entr', presetId: 23, presetSubtype: 16 },
        zoom: { presetClass: 'emph', presetId: 6, presetSubtype: 0 },
        fillColor: { presetClass: 'emph', presetId: 19, presetSubtype: 0 },
        textColor: { presetClass: 'emph', presetId: 3, presetSubtype: 2 },
        disappear: { presetClass: 'exit', presetId: 1, presetSubtype: 0 },
        blindsOut: { presetClass: 'exit', presetId: 3, presetSubtype: 10 },
      }
      if (animation.effect === 'none') return ''
      const preset = presets[animation.effect]
      const target = `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>`
      const setVisibility = (visible: boolean, id: number, delay = 0): string => (
        '<p:set><p:cBhvr>'
        + `<p:cTn id="${id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn>`
        + target
        + '<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>'
        + `</p:cBhvr><p:to><p:strVal val="${visible ? 'visible' : 'hidden'}"/></p:to></p:set>`
      )
      const filteredEffect = (transition: 'in' | 'out', filter: string, id: number): string => (
        `<p:animEffect transition="${transition}" filter="${filter}"><p:cBhvr>`
        + `<p:cTn id="${id}" dur="${duration}" fill="hold"/>${target}</p:cBhvr></p:animEffect>`
      )
      let behavior = ''
      switch (animation.effect) {
        case 'appear':
          behavior = setVisibility(true, nodeId + 1)
          break
        case 'fade':
          behavior = setVisibility(true, nodeId + 1) + filteredEffect('in', 'fade', nodeId + 2)
          break
        case 'blinds':
          behavior = setVisibility(true, nodeId + 1) + filteredEffect('in', 'blinds(horizontal)', nodeId + 2)
          break
        case 'checkerboard':
          behavior = setVisibility(true, nodeId + 1) + filteredEffect('in', 'checkerboard(across)', nodeId + 2)
          break
        case 'dissolve':
          behavior = setVisibility(true, nodeId + 1) + filteredEffect('in', 'dissolve', nodeId + 2)
          break
        case 'flyIn':
          behavior = setVisibility(true, nodeId + 1)
            + filteredEffect('in', 'slide(fromBottom)', nodeId + 2)
          break
        case 'floatIn':
          behavior = setVisibility(true, nodeId + 1)
            + filteredEffect('in', 'slide(fromBottom)', nodeId + 2)
            + filteredEffect('in', 'fade', nodeId + 3)
          break
        case 'split':
          behavior = setVisibility(true, nodeId + 1)
            + filteredEffect('in', 'barn(inVertical)', nodeId + 2)
          break
        case 'wipeIn':
          behavior = setVisibility(true, nodeId + 1)
            + filteredEffect('in', 'wipe(right)', nodeId + 2)
          break
        case 'zoomIn':
          behavior = setVisibility(true, nodeId + 1)
            + '<p:animScale><p:cBhvr>'
            + `<p:cTn id="${nodeId + 2}" dur="${duration}" fill="hold"/>${target}</p:cBhvr>`
            + '<p:from x="20000" y="20000"/><p:to x="100000" y="100000"/></p:animScale>'
          break
        case 'zoom':
          behavior = '<p:animScale><p:cBhvr>'
            + `<p:cTn id="${nodeId + 1}" dur="${duration}" fill="hold"/>${target}</p:cBhvr>`
            + '<p:by x="150000" y="150000"/></p:animScale>'
          break
        case 'fillColor':
        case 'textColor': {
          const attribute = animation.effect === 'textColor' ? 'style.color' : 'fillcolor'
          const override = animation.effect === 'textColor' ? ' override="childStyle"' : ''
          behavior = `<p:animClr clrSpc="rgb" dir="cw"><p:cBhvr${override}>`
            + `<p:cTn id="${nodeId + 1}" dur="${duration}" fill="hold"/>${target}`
            + `<p:attrNameLst><p:attrName>${attribute}</p:attrName></p:attrNameLst></p:cBhvr>`
            + `<p:to><a:srgbClr val="${color}"/></p:to></p:animClr>`
          break
        }
        case 'disappear':
          behavior = setVisibility(false, nodeId + 1)
          break
        case 'blindsOut':
          behavior = filteredEffect('out', 'blinds(horizontal)', nodeId + 1)
            + setVisibility(false, nodeId + 2, Math.max(0, duration - 1))
          break
      }
      let nodeType = 'clickEffect'
      if (animation.start === 'withPrevious') nodeType = 'withEffect'
      else if (animation.start === 'afterPrevious') nodeType = 'afterEffect'
      return '<p:par>'
        + `<p:cTn id="${nodeId}" presetID="${preset.presetId}" presetClass="${preset.presetClass}" presetSubtype="${preset.presetSubtype}" fill="hold" grpId="0" nodeType="${nodeType}">`
        + `<p:stCondLst><p:cond delay="${animation.delayMs}"/></p:stCondLst><p:childTnLst>`
        + behavior
        + '</p:childTnLst></p:cTn></p:par>'
    }

    const nativeAnimationTimingXml = (xml: string, elements: PresentationElement[]): string => {
      const shapeIds = shapeIdsByObjectName(xml)
      const entries = getPresentationAnimationTargets(elements).flatMap((target): NativeAnimationEntry[] => {
        const animation = normalizePresentationAnimation(target.animationElement)
        return getPresentationAnimationAffectedElements(target, animation.effect).flatMap((element, index) => {
          const shapeId = shapeIds.get(element.id)
          if (!shapeId) return []
          return [{
            animation: index === 0 ? animation : { ...animation, start: 'withPrevious' },
            element,
            shapeId,
          }]
        })
      })
      if (entries.length === 0) return ''
      const groups = groupNativeAnimations(entries)
      let nodeId = 3
      let body = ''
      for (const group of groups) {
        const groupTrigger = group.trigger
        const triggerCondition = groupTrigger?.animation.trigger === 'elementClick'
          ? `<p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${groupTrigger.shapeId}"/></p:tgtEl></p:cond>`
          : '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>'
        body += `<p:par><p:cTn id="${nodeId}" fill="hold"><p:stCondLst>${triggerCondition}</p:stCondLst><p:childTnLst>`
        nodeId += 1
        let cumulativeDelay = 0
        for (const step of group.steps) {
          body += `<p:par><p:cTn id="${nodeId}" fill="hold"><p:stCondLst><p:cond delay="${cumulativeDelay}"/></p:stCondLst><p:childTnLst>`
          nodeId += 1
          let stepDuration = 0
          for (const entry of step.entries) {
            body += nativeAnimationEffectXml(entry, nodeId)
            nodeId += 8
            stepDuration = Math.max(stepDuration, entry.animation.delayMs + nativeAnimationDuration(entry.animation))
          }
          body += '</p:childTnLst></p:cTn></p:par>'
          cumulativeDelay += stepDuration
        }
        body += '</p:childTnLst></p:cTn></p:par>'
      }
      const buildList = Array.from(new Set(entries.map((entry) => entry.shapeId)))
        .map((shapeId) => `<p:bldP spid="${shapeId}" grpId="0" animBg="1"/>`)
        .join('')
      return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
        + '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
        + body
        + '</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
        + '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'
        + `</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst>${buildList}</p:bldLst></p:timing>`
    }

    const insertTimingXml = (xml: string, timingMarkup: string): string => {
      const insertionOffsets = ['<p:extLst', '</p:sld>']
        .map((marker) => xml.indexOf(marker))
        .filter((offset) => offset >= 0)
      if (insertionOffsets.length === 0) throw new Error('PPTX exporter produced slide XML without a valid animation insertion point')
      const insertionPoint = Math.min(...insertionOffsets)
      return xml.slice(0, insertionPoint) + timingMarkup + xml.slice(insertionPoint)
    }

    const correctAudioFileTags = async (archive: JSZip, xml: string, slideNumber: number): Promise<string> => {
      const relationshipsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`
      const relationshipsFile = archive.file(relationshipsPath)
      if (!relationshipsFile) return xml
      const relationshipsXml = await relationshipsFile.async('text')
      const audioRelationshipIds = (relationshipsXml.match(/<Relationship\b[^>]*\/>/g) ?? []).flatMap((relationship) => {
        if (!/\/relationships\/audio"/.test(relationship)) return []
        const id = /\bId="([^"]+)"/.exec(relationship)?.[1]
        return id ? [id] : []
      })

      return audioRelationshipIds.reduce((currentXml, relationshipId) => {
        const escapedId = relationshipId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const videoTag = new RegExp(`<a:videoFile\\b([^>]*\\br:link="${escapedId}"[^>]*)\\/>`, 'g')
        return currentXml.replace(videoTag, '<a:audioFile$1/>')
      }, xml)
    }

    const correctMediaContentTypes = async (archive: JSZip): Promise<void> => {
      const contentTypesPath = '[Content_Types].xml'
      const contentTypesFile = archive.file(contentTypesPath)
      if (!contentTypesFile) throw new Error('PPTX exporter did not create [Content_Types].xml')
      const canonicalContentTypes = new Map([
        ['mp3', 'audio/mpeg'],
        ['m4a', 'audio/mp4'],
        ['mov', 'video/quicktime'],
      ])
      const xml = await contentTypesFile.async('text')
      const correctedXml = xml.replace(/<Default\b[^>]*\/>/g, (defaultTag) => {
        const extension = /\bExtension=(['"])([^'"]+)\1/.exec(defaultTag)?.[2]?.toLowerCase()
        const contentType = extension ? canonicalContentTypes.get(extension) : undefined
        if (!contentType || !/\bContentType=(['"])[^'"]*\1/.test(defaultTag)) return defaultTag
        return defaultTag.replace(/\bContentType=(['"])[^'"]*\1/, `ContentType="${contentType}"`)
      })
      archive.file(contentTypesPath, correctedXml)
    }

    const correctChartAxisReferences = async (archive: JSZip): Promise<void> => {
      const chartPaths = Object.keys(archive.files).filter((path) => /^ppt\/charts\/chart\d+\.xml$/.test(path))
      await Promise.all(chartPaths.map(async (chartPath) => {
        const chartFile = archive.file(chartPath)
        if (!chartFile) return
        const xml = await chartFile.async('text')
        const declaredAxisIds = new Set(Array.from(xml.matchAll(
          /<c:(?:catAx|dateAx|valAx|serAx)\b[^>]*>\s*<c:axId\b[^>]*\bval="([^"]+)"[^>]*\/>/g,
        ), (match) => match[1]!))
        if (declaredAxisIds.size === 0) return
        let correctedXml = xml
        for (const chartTag of ['barChart', 'lineChart']) {
          const chartPattern = new RegExp(`<c:${chartTag}\\b[\\s\\S]*?<\\/c:${chartTag}>`, 'g')
          correctedXml = correctedXml.replace(chartPattern, (chartXml) => chartXml.replace(
            /<c:axId\b[^>]*\bval="([^"]+)"[^>]*\/>/g,
            (axisReference, axisId: string) => declaredAxisIds.has(axisId) ? axisReference : '',
          ))
        }
        if (correctedXml !== xml) archive.file(chartPath, correctedXml)
      }))
    }

    const correctChartRelationshipTargets = async (archive: JSZip): Promise<void> => {
      const relationshipPaths = Object.keys(archive.files).filter(
        (path) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(path),
      )
      await Promise.all(relationshipPaths.map(async (relationshipPath) => {
        const relationshipFile = archive.file(relationshipPath)
        if (!relationshipFile) return
        const xml = await relationshipFile.async('text')
        const correctedXml = xml.replace(/<Relationship\b[^>]*\/>/g, (relationship) => {
          if (!/\/relationships\/chart(['"])/.test(relationship)) return relationship
          return relationship.replace(
            /\bTarget=(['"])\/ppt\/charts\/([^'"]+)\1/,
            (_target, quote: string, chartName: string) => `Target=${quote}../charts/${chartName}${quote}`,
          )
        })
        if (correctedXml !== xml) archive.file(relationshipPath, correctedXml)
      }))
    }

    const archive = await JSZip.loadAsync(bytes)
    const themePath = Object.keys(archive.files).find((path) => /^ppt\/theme\/theme\d+\.xml$/i.test(path))
    const themeFile = themePath ? archive.file(themePath) : null
    if (themeFile) {
      let themeXml = await themeFile.async('text')
      document.master.accentColors.slice(0, 6).forEach((color, index) => {
        const name = `accent${index + 1}`
        const value = presentationColor(color, '')
        if (!value) return
        themeXml = themeXml.replace(
          new RegExp(`(<a:${name}>)[\\s\\S]*?(</a:${name}>)`),
          `$1<a:srgbClr val="${value}"/>$2`,
        )
      })
      archive.file(themePath!, themeXml)
    }
    await correctMediaContentTypes(archive)
    await correctChartAxisReferences(archive)
    await correctChartRelationshipTargets(archive)
    await Promise.all(transitions.map(async (transition, index) => {
      if (transition.effect === 'none' && !slidesWithAudio[index] && !slidesWithAnimations[index]) return
      const slidePath = `ppt/slides/slide${index + 1}.xml`
      const slideFile = archive.file(slidePath)
      if (!slideFile) throw new Error(`PPTX exporter did not create ${slidePath}`)
      let xml = await slideFile.async('text')
      if (slidesWithAudio[index]) xml = await correctAudioFileTags(archive, xml, index + 1)
      if (transition.effect !== 'none') {
        xml = insertTransitionXml(ensureTransitionNamespaces(xml), transitionXml(transition))
      }
      if (slidesWithAnimations[index]) {
        const timingMarkup = nativeAnimationTimingXml(xml, document.slides[index]?.elements ?? [])
        if (timingMarkup) xml = insertTimingXml(xml, timingMarkup)
      }
      archive.file(slidePath, xml)
    }))
    return archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  }

  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'BRIDGIC_DOCUMENT', width: slideWidthInches, height: SLIDE_HEIGHT_INCHES })
  pptx.layout = 'BRIDGIC_DOCUMENT'
  pptx.author = 'Bridgic'
  pptx.company = 'Bridgic'
  pptx.subject = document.title
  pptx.title = document.title
  pptx.theme = {
    headFontFace: document.master?.titleFontFamily ?? 'Aptos Display',
    bodyFontFace: document.master?.bodyFontFamily ?? 'Aptos',
  }

  const x = (pixels: number) => (pixels / pageSize.width) * slideWidthInches
  const y = (pixels: number) => (pixels / pageSize.height) * SLIDE_HEIGHT_INCHES
  const footerDate = new Intl.DateTimeFormat().format(new Date())

  for (const sourceSlide of document.slides) {
    const slide = pptx.addSlide()
    slide.background = { color: presentationColor(sourceSlide.background, 'FFFFFF') }
    const commentNotes = (sourceSlide.comments ?? []).map((comment) => (
      `[${comment.resolved ? 'Resolved comment' : 'Comment'} — ${comment.author}] ${comment.text}`
    ))
    const notes = [typeof sourceSlide.notes === 'string' ? sourceSlide.notes.trim() : '', ...commentNotes]
      .filter(Boolean)
      .join('\n\n')
    if (notes) slide.addNotes(notes)
    const sourceElements = Array.isArray(sourceSlide.elements) ? sourceSlide.elements : []
    for (const candidate of sourceElements as unknown[]) {
      if (!hasValidGeometry(candidate)) continue
      const element = candidate

      if (isPresentationTextElement(element)) {
        if (!element.text.trim()) continue
        const hasHyperlink = Boolean(element.hyperlink)
        let bullet: true | { type: 'number'; numberType: 'arabicPeriod' } | undefined
        if (element.listStyle === 'bullet') bullet = true
        else if (element.listStyle === 'number') bullet = { type: 'number', numberType: 'arabicPeriod' }
        let indentLevel: number | undefined
        if (element.listStyle === 'bullet' || element.listStyle === 'number') {
          indentLevel = typeof element.indentLevel === 'number' && Number.isFinite(element.indentLevel)
            ? Math.max(0, Math.round(element.indentLevel))
            : 0
        }
        slide.addText(typeof element.text === 'string' ? element.text : '', {
          x: x(element.x),
          y: y(element.y),
          w: x(element.width),
          h: y(element.height),
          rotate: element.rotation,
          flipH: element.flipHorizontal,
          flipV: element.flipVertical,
          margin: element.textInsets
            ? [element.textInsets.left * 0.75, element.textInsets.right * 0.75, element.textInsets.bottom * 0.75, element.textInsets.top * 0.75]
            : 0,
          breakLine: false,
          valign: presentationVerticalAlignment(element.verticalAlign),
          vert: presentationTextDirection(element.textDirection),
          align: ['left', 'center', 'right', 'justify'].includes(element.align) ? element.align : 'left',
          bold: typeof element.fontWeight === 'number' && element.fontWeight >= 600,
          italic: Boolean(element.italic),
          underline: element.underline || hasHyperlink ? { style: 'sng' } : undefined,
          strike: Boolean(element.strikethrough),
          superscript: element.baseline === 'superscript',
          subscript: element.baseline === 'subscript',
          highlight: typeof element.highlightColor === 'string'
            ? presentationColor(element.highlightColor, '') || undefined
            : undefined,
          charSpacing: typeof element.characterSpacing === 'number' && Number.isFinite(element.characterSpacing)
            ? presentationCharacterSpacingToPoints(element.characterSpacing, presentationFontSizeToPoints(element.fontSize))
            : undefined,
          lineSpacingMultiple: typeof element.lineHeight === 'number' && Number.isFinite(element.lineHeight) && element.lineHeight > 0
            ? element.lineHeight
            : undefined,
          bullet,
          indentLevel,
          color: hasHyperlink ? '2563EB' : presentationColor(element.color, '20202B'),
          transparency: typeof element.opacity === 'number' ? Math.round((1 - Math.max(0, Math.min(1, element.opacity))) * 100) : undefined,
          fontFace: typeof element.fontFamily === 'string' && element.fontFamily.trim() ? element.fontFamily : 'Aptos',
          fontSize: Number.isFinite(element.fontSize) && element.fontSize > 0 ? presentationFontSizeToPoints(element.fontSize) : 13.5,
          fit: element.wordWrap === false ? 'none' : 'shrink',
          wrap: element.wordWrap !== false,
          objectName: typeof element.id === 'string' ? element.id : undefined,
          hyperlink: toPptxHyperlink(element.hyperlink, document),
          shadow: element.shadow
            ? { type: 'outer', color: '20202B', opacity: 0.28, blur: 3, angle: 45, offset: 2 }
            : undefined,
        })
        continue
      }

      if (isPresentationImageElement(element)) {
        const source = normalizePresentationFileSourceForExport('image', element.source)
        if (!source) continue
        const width = x(element.width)
        const height = y(element.height)
        const aspectRatio = presentationImageAspectRatio(source.dataUrl, width / height)
        const crop = element.crop
        const visibleWidth = crop ? Math.max(0.001, 1 - crop.left - crop.right) : 1
        const visibleHeight = crop ? Math.max(0.001, 1 - crop.top - crop.bottom) : 1
        const naturalWidth = crop ? width / visibleWidth : width
        const naturalHeight = crop ? height / visibleHeight : width / aspectRatio
        slide.addImage({
          data: source.dataUrl,
          x: x(element.x),
          y: y(element.y),
          w: naturalWidth,
          h: naturalHeight,
          sizing: crop ? {
            type: 'crop',
            x: naturalWidth * crop.left,
            y: naturalHeight * crop.top,
            w: width,
            h: height,
          } : {
              type: element.fit === 'cover' ? 'cover' : 'contain',
              w: width,
              h: height,
            },
          rotate: element.rotation,
          flipH: element.flipHorizontal,
          flipV: element.flipVertical,
          rounding: element.clipShape === 'ellipse',
          transparency: typeof element.opacity === 'number' ? Math.round((1 - Math.max(0, Math.min(1, element.opacity))) * 100) : undefined,
          altText: typeof element.altText === 'string' ? element.altText : '',
          objectName: typeof element.id === 'string' ? element.id : undefined,
          hyperlink: toPptxHyperlink(element.hyperlink, document, true),
          shadow: element.shadow
            ? { type: 'outer', color: '20202B', opacity: 0.22, blur: 3, angle: 45, offset: 2 }
            : undefined,
        })
        continue
      }

      if (isPresentationMediaElement(element)) {
        const source = normalizePresentationFileSourceForExport(element.type, element.source)
        if (!source || !hasValidPresentationMediaSignature(element.type, source)) continue
        slide.addMedia({
          type: element.type,
          data: source.dataUrl,
          extn: presentationMediaExtension(source, element.type),
          x: x(element.x),
          y: y(element.y),
          w: x(element.width),
          h: y(element.height),
          objectName: typeof element.id === 'string' ? element.id : undefined,
        })
        continue
      }

      if (isPresentationTableElement(element)) {
        if (!Array.isArray(element.cells)) continue
        const cells = element.cells.filter(Array.isArray)
        const columnCount = Math.max(0, ...cells.map((row) => row.length))
        if (cells.length === 0 || columnCount === 0) continue

        const headerFill = presentationColor(element.headerFill, '6957D9')
        const bodyFill = presentationColor(element.bodyFill, 'FFFFFF')
        const textColor = presentationColor(element.textColor, '20202B')
        const borderColor = presentationColor(element.borderColor, 'D8D9E0')
        const fontSize = Number.isFinite(element.fontSize) && element.fontSize > 0 ? presentationFontSizeToPoints(element.fontSize) : 13.5
        const rows: PptxGenJS.TableRow[] = cells.map((row, rowIndex) => (
          Array.from({ length: columnCount }, (_, columnIndex) => ({
            text: typeof row[columnIndex] === 'string' ? row[columnIndex] : '',
            options: {
              fill: { color: element.headerRow && rowIndex === 0 ? headerFill : bodyFill },
              color: element.headerRow && rowIndex === 0 ? 'FFFFFF' : textColor,
              bold: element.headerRow && rowIndex === 0,
              border: { color: borderColor, pt: 1 },
              fontFace: 'Aptos',
              fontSize,
              margin: 0.05,
              valign: 'middle',
            },
          }))
        ))
        slide.addTable(rows, {
          x: x(element.x),
          y: y(element.y),
          w: x(element.width),
          h: y(element.height),
          colW: Array.from({ length: columnCount }, () => x(element.width) / columnCount),
          rowH: Array.from({ length: cells.length }, () => y(element.height) / cells.length),
          autoPage: false,
          margin: 0,
          objectName: typeof element.id === 'string' ? element.id : undefined,
        })
        continue
      }

      if (isPresentationChartElement(element)) {
        const chart = chartDefinition(element.chartType)
        if (!chart || !Array.isArray(element.categories) || !Array.isArray(element.series)) continue
        const categories = element.categories.filter((category): category is string => typeof category === 'string')
        if (categories.length === 0) continue
        const series = element.series.flatMap((candidateSeries) => {
          if (!isRecord(candidateSeries) || typeof candidateSeries.name !== 'string' || !Array.isArray(candidateSeries.values)) {
            return []
          }
          return [{
            name: candidateSeries.name,
            labels: categories,
            values: categories.map((_, index) => {
              const value = candidateSeries.values[index]
              if (typeof value !== 'number' || !Number.isFinite(value)) return 0
              return element.chartType === 'pie' || element.chartType === 'doughnut' ? Math.max(0, value) : value
            }),
          }]
        })
        if (series.length === 0) continue
        const exportedSeries = element.chartType === 'pie' || element.chartType === 'doughnut'
          ? series.slice(0, 1)
          : series
        const colors = Array.isArray(element.colors)
          ? element.colors.map((color) => presentationColor(color, '')).filter(Boolean)
          : []
        const baseColors = colors.length > 0 ? colors : ['6957D9']
        const colorCount = element.chartType === 'pie' || element.chartType === 'doughnut'
          ? categories.length
          : exportedSeries.length
        const chartColors = Array.from({ length: colorCount }, (_, index) => baseColors[index % baseColors.length]!)
        const title = typeof element.title === 'string' ? element.title.trim() : ''
        const chartFill = (fill: string | undefined, fallback: string) => (
          fill === 'transparent'
            ? { color: 'FFFFFF', transparency: 100 }
            : { color: presentationColor(fill, fallback) }
        )
        slide.addChart(chart.type, exportedSeries, {
          x: x(element.x),
          y: y(element.y),
          w: x(element.width),
          h: y(element.height),
          barDir: chart.barDir,
          chartColors,
          chartArea: { fill: chartFill(element.chartAreaFill, 'FFFFFF') },
          plotArea: { fill: chartFill(element.plotAreaFill, 'FFFFFF') },
          catAxisLabelColor: presentationColor(element.categoryAxisLabelColor, '666571'),
          valAxisLabelColor: presentationColor(element.valueAxisLabelColor, '666571'),
          valGridLine: { color: presentationColor(element.gridLineColor, 'E9EAF0'), size: 1 },
          showLegend: Boolean(element.showLegend),
          legendPos: 'b',
          showTitle: Boolean(title),
          title: title || undefined,
          showValue: Boolean(element.showValue),
          dataLabelColor: presentationColor(element.dataLabelColor, '20202B'),
          showPercent: false,
          objectName: typeof element.id === 'string' ? element.id : undefined,
        })
        continue
      }

      if (!isPresentationShapeElement(element)) continue
      let shapeType: PptxGenJS.ShapeType
      if (isPresentationLineShape(element.type)) shapeType = pptx.ShapeType.line
      else if (element.type === 'rect' && (element.radius ?? 0) > 0) shapeType = pptx.ShapeType.roundRect
      else shapeType = pptx.ShapeType[element.type as keyof typeof pptx.ShapeType]
      if (!shapeType) continue
      const lineShape = isPresentationLineShape(element.type)
      const borderWidth = Number.isFinite(element.borderWidth) ? element.borderWidth : 0
      slide.addShape(
        shapeType,
        {
          x: x(element.x),
          y: y(element.y),
          w: x(element.width),
          h: y(element.height),
          rotate: element.rotation,
          flipH: element.flipHorizontal,
          flipV: element.flipVertical,
          objectName: typeof element.id === 'string' ? element.id : undefined,
          fill: lineShape
            ? { color: 'FFFFFF', transparency: 100 }
            : {
                color: presentationColor(element.fill, 'FFFFFF'),
                transparency: typeof element.opacity === 'number' ? Math.round((1 - Math.max(0, Math.min(1, element.opacity))) * 100) : 0,
              },
          line: {
            color: presentationColor(element.borderColor, '20202B'),
            width: lineShape ? Math.max(1, borderWidth) : borderWidth,
            transparency: !lineShape && borderWidth === 0 ? 100 : 0,
            ...getPresentationLineEnds(element.type),
          },
          hyperlink: toPptxHyperlink(element.hyperlink, document),
          shadow: element.shadow
            ? { type: 'outer', color: '20202B', opacity: 0.22, blur: 3, angle: 45, offset: 2 }
            : undefined,
        },
      )
    }

    const footer = sourceSlide.footer
    if (isRecord(footer)) {
      const footerColor = '666571'
      const footerY = SLIDE_HEIGHT_INCHES - 0.34
      const footerText = typeof footer.text === 'string' ? footer.text.trim() : ''
      if (footerText) {
        slide.addText(footerText, {
          x: x(32),
          y: footerY,
          w: 4.5,
          h: 0.2,
          margin: 0,
          align: 'left',
          color: footerColor,
          fontFace: 'Aptos',
          fontSize: 9,
          valign: 'middle',
        })
      }
      if (footer.showDate === true) {
        slide.addText(footerDate, {
          x: (slideWidthInches / 2) - 1.2,
          y: footerY,
          w: 2.4,
          h: 0.2,
          margin: 0,
          align: 'center',
          color: footerColor,
          fontFace: 'Aptos',
          fontSize: 9,
          valign: 'middle',
        })
      }
      if (footer.showSlideNumber === true) {
        slide.slideNumber = {
          x: slideWidthInches - 1.35,
          y: footerY,
          w: 0.95,
          h: 0.2,
          margin: 0,
          align: 'right',
          color: footerColor,
          fontFace: 'Aptos',
          fontSize: 9,
          valign: 'middle',
        }
      }
    }
  }

  const output = await pptx.write({ outputType: 'uint8array', compression: true })
  if (!(output instanceof Uint8Array)) {
    throw new Error('PPTX exporter returned an unexpected output type')
  }
  return addNativePresentationFeatures(output)
}
