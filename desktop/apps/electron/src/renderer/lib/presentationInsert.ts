import {
  PRESENTATION_HEIGHT,
  PRESENTATION_WIDTH,
  createPresentationId,
  type PresentationAudioElement,
  type PresentationChartElement,
  type PresentationChartType,
  type PresentationFileSource,
  type PresentationFooter,
  type PresentationHyperlink,
  type PresentationImageElement,
  type PresentationMediaElement,
  type PresentationShapeElement,
  type PresentationShapeType,
  type PresentationTableElement,
  type PresentationTextElement,
  type PresentationVideoElement,
} from '@/atoms/presentation'
import { presentationShapeCategories } from '@/lib/presentationShapes'

const DEFAULT_CHART_COLORS = ['#6957D9', '#2F8B78', '#DF6C47', '#4D7CFE', '#F2B91F'] as const
export const PRESENTATION_AUDIO_ICON_SIZE = 64
const LEGACY_PRESENTATION_AUDIO_WIDTH = 520
const LEGACY_PRESENTATION_AUDIO_HEIGHT = 72
const presentationShapeTypes = new Set<PresentationShapeType>(
  presentationShapeCategories.flatMap((category) => category.shapes.map((shape) => shape.type)),
)

export type PresentationFileKind = 'image' | PresentationMediaElement['type']

const PRESENTATION_FILE_MIME_TYPES: Record<PresentationFileKind, ReadonlySet<string>> = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml']),
  audio: new Set(['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
}

const PRESENTATION_FILE_EXTENSION_MIME_TYPES: Record<PresentationFileKind, Readonly<Record<string, string>>> = {
  image: {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  },
  audio: {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
  },
  video: {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
  },
}

const GENERIC_PRESENTATION_FILE_MIME_TYPES = new Set(['', 'application/octet-stream'])

function isValidPresentationBase64Payload(payload: string): boolean {
  if (!payload || payload.length % 4 !== 0) return false
  let paddingLength = 0
  if (payload.endsWith('==')) paddingLength = 2
  else if (payload.endsWith('=')) paddingLength = 1
  const contentLength = payload.length - paddingLength
  for (let index = 0; index < contentLength; index += 1) {
    const code = payload.charCodeAt(index)
    const isBase64Character = (code >= 0x41 && code <= 0x5A)
      || (code >= 0x61 && code <= 0x7A)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2B
      || code === 0x2F
    if (!isBase64Character) return false
  }
  return true
}

function centeredPosition(width: number, height: number): { x: number; y: number } {
  return {
    x: Math.round((PRESENTATION_WIDTH - width) / 2),
    y: Math.round((PRESENTATION_HEIGHT - height) / 2),
  }
}

export function isPresentationTextElement(element: { type: string }): element is PresentationTextElement {
  return element.type === 'text'
}

export function isPresentationShapeElement(element: { type: string }): element is PresentationShapeElement {
  return presentationShapeTypes.has(element.type as PresentationShapeType)
}

export function isPresentationImageElement(element: { type: string }): element is PresentationImageElement {
  return element.type === 'image'
}

export function isPresentationMediaElement(element: { type: string }): element is PresentationMediaElement {
  return element.type === 'audio' || element.type === 'video'
}

export function isPresentationVideoElement(element: { type: string }): element is PresentationVideoElement {
  return element.type === 'video'
}

export function isPresentationTableElement(element: { type: string }): element is PresentationTableElement {
  return element.type === 'table'
}

export function isPresentationChartElement(element: { type: string }): element is PresentationChartElement {
  return element.type === 'chart'
}

export function supportsPresentationElementShadow(element: { type: string }): boolean {
  return isPresentationTextElement(element)
    || isPresentationShapeElement(element)
    || isPresentationImageElement(element)
}

export function supportsPresentationElementRotation(element: { type: string }): boolean {
  return !isPresentationMediaElement(element)
    && !isPresentationTableElement(element)
    && !isPresentationChartElement(element)
}

export function supportsPresentationElementHyperlink(element: { type: string }): boolean {
  return isPresentationTextElement(element)
    || isPresentationShapeElement(element)
    || isPresentationImageElement(element)
}

function presentationFileHeader(source: PresentationFileSource, byteCount = 16): Uint8Array | null {
  const payload = source.dataUrl.slice(source.dataUrl.indexOf(',') + 1).replace(/\s/g, '')
  const encodedLength = Math.min(payload.length, Math.ceil(byteCount / 3) * 4)
  const encoded = payload.slice(0, encodedLength - (encodedLength % 4))
  if (!encoded) return null
  try {
    const binary = atob(encoded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

/** Reject obvious container/extension disguises before Chromium or Office sees them. */
export function hasValidPresentationMediaSignature(type: PresentationMediaElement['type'], source: PresentationFileSource): boolean {
  if (!source.mimeType.startsWith(`${type}/`)) return false
  const bytes = presentationFileHeader(source)
  if (!bytes) return false
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length))
  switch (source.mimeType) {
    case 'audio/mpeg':
      return ascii(0, 3) === 'ID3' || (bytes[0] === 0xFF && ((bytes[1] ?? 0) & 0xE0) === 0xE0)
    case 'audio/wav':
      return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE'
    case 'audio/mp4':
      return ascii(4, 4) === 'ftyp'
    case 'audio/ogg':
      return ascii(0, 4) === 'OggS'
    case 'video/mp4':
    case 'video/quicktime':
      return ascii(4, 4) === 'ftyp'
    case 'video/webm':
      return bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3
    default:
      return false
  }
}

export function normalizePresentationFileSource(kind: PresentationFileKind, source: PresentationFileSource): PresentationFileSource | null {
  const sourceMimeType = source.mimeType.trim().toLowerCase()
  const extension = /\.([^.]+)$/.exec(source.fileName.trim())?.[1]?.toLowerCase()
  const inferredMimeType = extension
    ? PRESENTATION_FILE_EXTENSION_MIME_TYPES[kind][extension]
    : undefined
  if (inferredMimeType
    && !GENERIC_PRESENTATION_FILE_MIME_TYPES.has(sourceMimeType)
    && inferredMimeType !== sourceMimeType) return null
  const mimeType = GENERIC_PRESENTATION_FILE_MIME_TYPES.has(sourceMimeType)
    ? inferredMimeType
    : sourceMimeType
  if (!mimeType || !PRESENTATION_FILE_MIME_TYPES[kind].has(mimeType)) return null

  const dataUrlMatch = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(source.dataUrl)
  if (!dataUrlMatch) return null
  const dataUrlMimeType = dataUrlMatch[1]!.trim().toLowerCase()
  if (!GENERIC_PRESENTATION_FILE_MIME_TYPES.has(dataUrlMimeType) && dataUrlMimeType !== mimeType) return null
  const payload = dataUrlMatch[2]!.replace(/\s/g, '')
  if (!isValidPresentationBase64Payload(payload)) return null

  return {
    dataUrl: `data:${mimeType};base64,${payload}`,
    fileName: source.fileName,
    mimeType,
  }
}

export function normalizePresentationHyperlinkUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
    return url.toString()
  } catch {
    return null
  }
}

export function createPresentationUrlHyperlink(value: string, tooltip?: string): PresentationHyperlink | null {
  const url = normalizePresentationHyperlinkUrl(value)
  if (!url) return null
  const normalizedTooltip = tooltip?.trim()
  return {
    type: 'url',
    url,
    ...(normalizedTooltip ? { tooltip: normalizedTooltip } : {}),
  }
}

export function parsePresentationDelimitedText(value: string): string[][] {
  if (!value.trim()) return []
  const delimiter = value.includes('\t') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  const pushCell = () => {
    row.push(cell.trim())
    cell = ''
  }
  const pushRow = () => {
    pushCell()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
      continue
    }
    if (character === '"' && !cell) {
      quoted = true
    } else if (character === delimiter) {
      pushCell()
    } else if (character === '\n') {
      pushRow()
    } else if (character !== '\r') {
      cell += character
    }
  }
  if (cell || row.length > 0) pushRow()
  return rows.filter((cells) => cells.some(Boolean))
}

export function createPresentationImageElement(source: PresentationFileSource): PresentationImageElement {
  const width = 640
  const height = 360
  return {
    id: createPresentationId('image'),
    type: 'image',
    ...centeredPosition(width, height),
    width,
    height,
    rotation: 0,
    source,
    altText: source.fileName,
    fit: 'contain',
  }
}

export function createPresentationMediaElement(type: 'audio', source: PresentationFileSource): PresentationAudioElement
export function createPresentationMediaElement(type: 'video', source: PresentationFileSource): PresentationVideoElement
export function createPresentationMediaElement(type: PresentationMediaElement['type'], source: PresentationFileSource): PresentationMediaElement
export function createPresentationMediaElement(type: PresentationMediaElement['type'], source: PresentationFileSource): PresentationMediaElement {
  const width = type === 'video' ? 640 : PRESENTATION_AUDIO_ICON_SIZE
  const height = type === 'video' ? 360 : PRESENTATION_AUDIO_ICON_SIZE
  return {
    id: createPresentationId(type),
    type,
    ...centeredPosition(width, height),
    width,
    height,
    rotation: 0,
    source,
    ...(type === 'audio' ? { displayStyle: 'compact' as const } : {}),
    autoplay: false,
    loop: false,
    muted: false,
  }
}

/** Shrinks only the former default audio card while preserving its visual center. */
export function compactLegacyPresentationAudioElement(element: PresentationAudioElement): PresentationAudioElement {
  if (element.displayStyle === 'compact'
    || element.width !== LEGACY_PRESENTATION_AUDIO_WIDTH
    || element.height !== LEGACY_PRESENTATION_AUDIO_HEIGHT) {
    return element
  }
  return {
    ...element,
    x: element.x + ((element.width - PRESENTATION_AUDIO_ICON_SIZE) / 2),
    y: element.y + ((element.height - PRESENTATION_AUDIO_ICON_SIZE) / 2),
    width: PRESENTATION_AUDIO_ICON_SIZE,
    height: PRESENTATION_AUDIO_ICON_SIZE,
    displayStyle: 'compact',
  }
}

export function createPresentationTableElement(cells: string[][] = [
  ['Header 1', 'Header 2', 'Header 3'],
  ['', '', ''],
  ['', '', ''],
]): PresentationTableElement {
  const width = 720
  const height = 300
  return {
    id: createPresentationId('table'),
    type: 'table',
    ...centeredPosition(width, height),
    width,
    height,
    rotation: 0,
    cells: cells.map((row) => [...row]),
    headerRow: true,
    headerFill: '#6957D9',
    bodyFill: '#FFFFFF',
    textColor: '#20202B',
    borderColor: '#D8D9E0',
    fontSize: 18,
  }
}

export function createPresentationChartElement(chartType: PresentationChartType = 'column'): PresentationChartElement {
  const width = 760
  const height = 380
  return {
    id: createPresentationId('chart'),
    type: 'chart',
    ...centeredPosition(width, height),
    width,
    height,
    rotation: 0,
    chartType,
    categories: ['Category 1', 'Category 2', 'Category 3', 'Category 4'],
    series: [
      { name: 'Series 1', values: [4, 7, 5, 8] },
      { name: 'Series 2', values: [3, 5, 6, 4] },
    ],
    showLegend: true,
    title: 'Chart title',
    colors: [...DEFAULT_CHART_COLORS],
  }
}

export function createPresentationFooter(text = ''): PresentationFooter {
  return {
    text,
    showDate: false,
    showSlideNumber: false,
  }
}
