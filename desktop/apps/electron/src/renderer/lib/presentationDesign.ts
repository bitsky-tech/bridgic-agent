import {
  PRESENTATION_PAGE_SIZES,
  getPresentationPageSize,
  type PresentationChartElement,
  type PresentationDocument,
  type PresentationElement,
  type PresentationFooter,
  type PresentationPageSizePreset,
  type PresentationShapeElement,
  type PresentationTableElement,
  type PresentationTextElement,
  type PresentationTransition,
} from '@/atoms/presentation'

export type PresentationThemePresetId = 'lavender' | 'light' | 'midnight' | 'paper'

export interface PresentationThemePreset {
  accentColors: readonly string[]
  background: string
  bodyFontFamily: string
  id: PresentationThemePresetId
  label: string
  titleFontFamily: string
}

export interface PresentationDesignPatch {
  accentColors?: readonly string[]
  background?: string
  bodyFontFamily?: string
  footer?: Partial<PresentationFooter>
  pageSize?: PresentationPageSizePreset
  theme?: PresentationThemePresetId
  title?: string
  titleFontFamily?: string
  transition?: PresentationTransition
}

export const PRESENTATION_THEME_PRESETS: readonly PresentationThemePreset[] = [
  {
    accentColors: ['#41516A', '#3478F6', '#35A3E8', '#30B26F', '#DB2B32', '#FF922B', '#FFBE0B', '#7C2AE8'],
    background: '#FFFFFF',
    bodyFontFamily: 'Aptos',
    id: 'light',
    label: 'session.presentation.themeLight',
    titleFontFamily: 'Aptos Display',
  },
  {
    accentColors: ['#44546A', '#E7E6E6', '#5B9BD5', '#ED7D31', '#A5A5A5', '#FFC000', '#4472C4', '#70AD47'],
    background: '#F7F3EA',
    bodyFontFamily: 'Arial',
    id: 'paper',
    label: 'session.presentation.themePaper',
    titleFontFamily: 'Georgia',
  },
  {
    accentColors: ['#203864', '#DDEBF7', '#5B9BD5', '#9DC3E6', '#2F75B5', '#A9D18E', '#70AD47', '#1F4E78'],
    background: '#17182B',
    bodyFontFamily: 'Aptos',
    id: 'midnight',
    label: 'session.presentation.themeMidnight',
    titleFontFamily: 'Aptos Display',
  },
  {
    accentColors: ['#6B451C', '#F2F0E9', '#F4B183', '#FFD18E', '#D69E58', '#A5A18B', '#737373', '#A9D18E'],
    background: '#F7F1E4',
    bodyFontFamily: 'Aptos',
    id: 'lavender',
    label: 'session.presentation.themeLavender',
    titleFontFamily: 'Georgia',
  },
]

export function normalizePresentationDesignColor(value: string): string {
  const normalized = value.trim().replace(/^#/, '')
  if (/^[\dA-F]{3}$/i.test(normalized)) {
    return `#${normalized.split('').map((character) => character + character).join('').toUpperCase()}`
  }
  if (/^[\dA-F]{6}$/i.test(normalized)) return `#${normalized.toUpperCase()}`
  throw new Error(`Invalid PowerPoint color: ${value}`)
}

export function presentationThemeTextColors(background: string): { primary: string; secondary: string } {
  const normalized = normalizePresentationDesignColor(background).slice(1)
  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  const dark = ((red * 299) + (green * 587) + (blue * 114)) / 1_000 < 140
  return dark
    ? { primary: '#FFFFFF', secondary: '#C7C8D8' }
    : { primary: '#1D1D28', secondary: '#666571' }
}

export function presentationThemePreset(id: PresentationThemePresetId): PresentationThemePreset {
  const preset = PRESENTATION_THEME_PRESETS.find((item) => item.id === id)
  if (!preset) throw new Error(`Unsupported PowerPoint theme: ${id}`)
  return preset
}

export function matchingPresentationTheme(document: PresentationDocument): PresentationThemePresetId | 'custom' {
  const master = document.master
  return PRESENTATION_THEME_PRESETS.find((preset) => (
    preset.background === master.background
    && preset.titleFontFamily === master.titleFontFamily
    && preset.bodyFontFamily === master.bodyFontFamily
    && preset.accentColors.length === master.accentColors.length
    && preset.accentColors.every((color, index) => color === master.accentColors[index])
  ))?.id ?? 'custom'
}

export function applyPresentationDesign(document: PresentationDocument, patch: PresentationDesignPatch): PresentationDocument {
  const preset = patch.theme ? presentationThemePreset(patch.theme) : null
  const background = normalizePresentationDesignColor(patch.background ?? preset?.background ?? document.master.background)
  const accentColors = (patch.accentColors ?? preset?.accentColors ?? document.master.accentColors)
    .map(normalizePresentationDesignColor)
  if (accentColors.length === 0) throw new Error('PowerPoint accentColors must contain at least one color')
  const titleFontFamily = patch.titleFontFamily ?? preset?.titleFontFamily ?? document.master.titleFontFamily
  const bodyFontFamily = patch.bodyFontFamily ?? preset?.bodyFontFamily ?? document.master.bodyFontFamily
  const footer = patch.footer
    ? { ...document.master.footer, ...patch.footer }
    : { ...document.master.footer }
  const colorsChanged = Boolean(patch.theme || patch.background || patch.accentColors)
  const fontsChanged = Boolean(patch.theme || patch.titleFontFamily || patch.bodyFontFamily)
  const textColors = presentationThemeTextColors(background)
  const gridLineColor = textColors.primary === '#FFFFFF' ? '#4A4B60' : '#E0E1E8'

  const applyElementDesign = (element: PresentationElement, index: number): PresentationElement => {
    const accent = accentColors[index % accentColors.length]!
    if (element.type === 'text') {
      const text = element as PresentationTextElement
      const title = text.fontWeight >= 600 || text.fontSize >= 30
      return {
        ...text,
        ...(fontsChanged ? { fontFamily: title ? titleFontFamily : bodyFontFamily } : {}),
        ...(colorsChanged ? { color: title ? textColors.primary : textColors.secondary } : {}),
      }
    }
    if (element.type === 'chart') {
      const chart = element as PresentationChartElement
      return colorsChanged ? {
        ...chart,
        colors: accentColors.slice(0, Math.max(1, chart.series.length)),
        categoryAxisLabelColor: textColors.secondary,
        dataLabelColor: textColors.primary,
        gridLineColor,
        valueAxisLabelColor: textColors.secondary,
      } : chart
    }
    if (element.type === 'table') {
      const table = element as PresentationTableElement
      return colorsChanged ? {
        ...table,
        bodyFill: background,
        borderColor: gridLineColor,
        headerFill: accentColors[0]!,
        textColor: textColors.primary,
      } : table
    }
    if ('fill' in element && 'borderColor' in element) {
      const shape = element as PresentationShapeElement
      return colorsChanged && shape.fill !== 'transparent'
        ? { ...shape, borderColor: accent, fill: accent }
        : shape
    }
    return element
  }

  let next: PresentationDocument = {
    ...document,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    master: { accentColors, background, bodyFontFamily, footer, titleFontFamily },
    slides: document.slides.map((slide) => ({
      ...slide,
      ...(colorsChanged ? { background } : {}),
      ...(patch.footer ? { footer: { ...footer } } : {}),
      ...(patch.transition ? { transition: { ...patch.transition } } : {}),
      elements: slide.elements.map(applyElementDesign),
    })),
  }
  if (patch.pageSize) next = resizePresentationDocument(next, patch.pageSize)
  return next
}

export function resizePresentationDocument(document: PresentationDocument, preset: PresentationPageSizePreset): PresentationDocument {
  const previousSize = getPresentationPageSize(document)
  const nextSize = PRESENTATION_PAGE_SIZES[preset]
  if (previousSize.preset === preset && previousSize.width === nextSize.width && previousSize.height === nextSize.height) {
    return document
  }
  const scale = Math.min(nextSize.width / previousSize.width, nextSize.height / previousSize.height)
  const offsetX = (nextSize.width - (previousSize.width * scale)) / 2
  const offsetY = (nextSize.height - (previousSize.height * scale)) / 2

  const scaleElement = (element: PresentationElement): PresentationElement => {
    const scaled = {
      ...element,
      height: Math.max(8, Math.round(element.height * scale)),
      width: Math.max(8, Math.round(element.width * scale)),
      x: Math.round((element.x * scale) + offsetX),
      y: Math.round((element.y * scale) + offsetY),
    } as PresentationElement
    if (scaled.type === 'text') {
      return { ...scaled, fontSize: Math.max(8, Number((scaled.fontSize * scale).toFixed(1))) }
    }
    if (scaled.type === 'table') {
      return { ...scaled, fontSize: Math.max(8, Number((scaled.fontSize * scale).toFixed(1))) }
    }
    if ('borderWidth' in scaled && 'fill' in scaled) {
      return {
        ...scaled,
        borderWidth: Number((scaled.borderWidth * scale).toFixed(2)),
        radius: scaled.radius === undefined ? undefined : Number((scaled.radius * scale).toFixed(1)),
      }
    }
    return scaled
  }

  return {
    ...document,
    pageSize: { ...nextSize },
    slides: document.slides.map((slide) => ({ ...slide, elements: slide.elements.map(scaleElement) })),
  }
}
