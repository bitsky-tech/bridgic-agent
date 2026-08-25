import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { Canvas as FabricCanvas, FabricObject } from 'fabric'
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Grid2X2,
  Maximize2,
  MessageSquareText,
  Minimize2,
  MonitorPlay,
  Play,
  Rows3,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  PRESENTATION_HEIGHT,
  PRESENTATION_WIDTH,
  createBlankPresentationDocument,
  createBlankPresentationSlide,
  createPresentationId,
  currentPresentationDocumentAtom,
  currentPresentationWorkspaceAtom,
  formatPresentationText,
  presentationExpandedAtom,
  stripPresentationListMarkers,
  type PresentationDocument,
  type PresentationElement,
  type PresentationFileSource,
  type PresentationHyperlink,
  type PresentationImageElement,
  type PresentationMediaElement,
  type PresentationShapeElement,
  type PresentationShapeType,
  type PresentationSlide,
  type PresentationTableElement,
  type PresentationTextElement,
  type PresentationTransition,
} from '@/atoms/presentation'
import { setRightPanelCollapsedAtom } from '@/atoms/layout'
import { viewedSessionIdAtom } from '@/atoms/navigation'
import { requestExternalLinkAtom } from '@/atoms/external-link'
import { showToastAtom } from '@/atoms/toast'
import { Tooltip } from '@/components/amphi/Tooltip'
import { cn } from '@/lib/cn'
import {
  createPresentationChartElement,
  createPresentationFooter,
  createPresentationImageElement,
  createPresentationMediaElement,
  createPresentationTableElement,
  createPresentationUrlHyperlink,
  hasValidPresentationMediaSignature,
  isPresentationChartElement,
  isPresentationImageElement,
  isPresentationMediaElement,
  isPresentationShapeElement,
  isPresentationTableElement,
  isPresentationTextElement,
  normalizePresentationFileSource,
  supportsPresentationElementHyperlink,
  supportsPresentationElementRotation,
  supportsPresentationElementShadow,
} from '@/lib/presentationInsert'
import { normalizePresentationTransition } from '@/lib/presentationTransitions'
import {
  getPresentationShapeDefinition,
  getPresentationShapeSize,
  isPresentationLineShape,
} from '@/lib/presentationShapes'
import {
  PresentationInsertDialogs,
  type PresentationInsertDialogKind,
  type PresentationInsertDialogValue,
} from './PresentationInsertDialogs'
import {
  PresentationRibbon,
  type PresentationRibbonTab,
} from './PresentationRibbon'
import {
  getPresentationChartRange,
  getPresentationChartValueRatio,
  PresentationSlidePreview,
} from './PresentationSlidePreview'
import {
  PresentationTransitionPlayer,
  type PresentationTransitionPlaybackDirection,
} from './PresentationTransitionPlayer'

export interface PresentationWorkbenchPanelProps {
  active: boolean
}

type ExportState = 'idle' | 'exporting' | 'saved' | 'error'

interface SlideshowTransitionRun {
  direction: PresentationTransitionPlaybackDirection
  fromIndex: number
  runKey: number
  toIndex: number
}

interface TransitionPreviewRun {
  runKey: number
  slideId: string
  transition: PresentationTransition
}

interface SlideshowTransitionView extends SlideshowTransitionRun {
  currentSlide: PresentationSlide
  previousSlide: PresentationSlide
  transition: PresentationTransition
}

export const PRESENTATION_HISTORY_MAX_ENTRIES = 50
export const PRESENTATION_HISTORY_MAX_BYTES = 192 * 1024 * 1024

export interface PresentationHistoryEntry {
  document: PresentationDocument
  estimatedBytes: number
}

/** Estimate retained JS heap without serializing large embedded data URLs. */
export function estimatePresentationDocumentBytes(document: PresentationDocument): number {
  const seen = new Set<object>()
  let bytes = 0

  const visit = (value: unknown) => {
    if (value === null || value === undefined) {
      bytes += 4
      return
    }
    if (typeof value === 'string') {
      // UTF-16 is deliberately conservative; data URLs are ASCII but can still be
      // promoted internally, and the budget should remain safe across runtimes.
      bytes += value.length * 2
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      bytes += 8
      return
    }
    if (typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    bytes += Array.isArray(value) ? 24 : 32
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      bytes += key.length * 2
      visit(item)
    }
  }

  visit(document)
  return bytes
}

function cloneDocument(document: PresentationDocument): PresentationDocument {
  // structuredClone would duplicate every Base64 payload for every undo step.
  // Strip the immutable payloads while cloning the mutable model, then reattach
  // the original strings by index so snapshots cannot mutate one another.
  const payloadFreeSources = new WeakMap<PresentationFileSource, PresentationFileSource>()
  const sourceWithoutPayload = (source: PresentationFileSource) => {
    const existing = payloadFreeSources.get(source)
    if (existing) return existing
    const cloned = { ...source, dataUrl: '' }
    payloadFreeSources.set(source, cloned)
    return cloned
  }
  const payloads = document.slides.map((slide) => slide.elements.map((element) => (
    isPresentationImageElement(element) || isPresentationMediaElement(element)
      ? element.source.dataUrl
      : null
  )))
  const payloadFreeDocument: PresentationDocument = {
    ...document,
    slides: document.slides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => (
        isPresentationImageElement(element) || isPresentationMediaElement(element)
          ? { ...element, source: sourceWithoutPayload(element.source) }
          : element
      )),
    })),
  }
  const cloned = structuredClone(payloadFreeDocument)
  cloned.slides.forEach((slide, slideIndex) => {
    slide.elements.forEach((element, elementIndex) => {
      const dataUrl = payloads[slideIndex]?.[elementIndex]
      if (dataUrl !== null && dataUrl !== undefined && (
        isPresentationImageElement(element) || isPresentationMediaElement(element)
      )) {
        element.source.dataUrl = dataUrl
      }
    })
  })
  return cloned
}

export function createPresentationHistoryEntry(document: PresentationDocument, maxBytes = PRESENTATION_HISTORY_MAX_BYTES): PresentationHistoryEntry | null {
  const estimatedBytes = estimatePresentationDocumentBytes(document)
  if (estimatedBytes > maxBytes) return null
  return { document: cloneDocument(document), estimatedBytes }
}

export function canAppendPresentationFileElement(
  document: PresentationDocument,
  element: PresentationImageElement | PresentationMediaElement,
  maxBytes = PRESENTATION_HISTORY_MAX_BYTES,
): boolean {
  const slide = document.slides.find((item) => item.id === document.selectedSlideId)
  if (!slide) return false
  const nextDocument = {
    ...document,
    slides: document.slides.map((item) => item.id === slide.id
      ? { ...item, elements: [...item.elements, element] }
      : item),
  }
  return estimatePresentationDocumentBytes(nextDocument) <= maxBytes
}

export function resolvePresentationNumberFieldValue(draft: string, min: number | undefined, fallback: number): number {
  const parsed = draft.trim() ? Number(draft) : Number.NaN
  if (!Number.isFinite(parsed)) return Math.round(fallback)
  return Math.round(min === undefined ? parsed : Math.max(min, parsed))
}

/** Keep the newest contiguous history segment within both entry and byte limits. */
export function trimPresentationHistoryEntries(entries: readonly PresentationHistoryEntry[], maxEntries = PRESENTATION_HISTORY_MAX_ENTRIES, maxBytes = PRESENTATION_HISTORY_MAX_BYTES): PresentationHistoryEntry[] {
  const kept: PresentationHistoryEntry[] = []
  let retainedBytes = 0
  for (let index = entries.length - 1; index >= 0 && kept.length < Math.max(0, maxEntries); index -= 1) {
    const entry = entries[index]!
    if (entry.estimatedBytes > maxBytes - retainedBytes) break
    kept.unshift(entry)
    retainedBytes += entry.estimatedBytes
  }
  return kept
}

function trimPresentationHistoryPair(past: PresentationHistoryEntry[], future: PresentationHistoryEntry[]): void {
  let entryCount = past.length + future.length
  let retainedBytes = [...past, ...future].reduce((sum, entry) => sum + entry.estimatedBytes, 0)
  while (entryCount > PRESENTATION_HISTORY_MAX_ENTRIES || retainedBytes > PRESENTATION_HISTORY_MAX_BYTES) {
    // Prefer discarding the oldest undo state. Once none remain, discard the
    // farthest redo state (future[0]); the nearest redo lives at the end.
    const removed = past.length > 0 ? past.shift() : future.shift()
    if (!removed) break
    entryCount -= 1
    retainedBytes -= removed.estimatedBytes
  }
}

export function isPresentationRotationLocked(element: PresentationElement): boolean {
  return !supportsPresentationElementRotation(element)
}

export type PresentationSlideshowKeyAction = 'close' | 'next' | 'previous' | null

export function resolvePresentationSlideshowKeyAction(target: EventTarget | null, key: string): PresentationSlideshowKeyAction {
  if (key === 'Escape') return 'close'
  const element = target instanceof HTMLElement ? target : null
  const mediaHasFocus = Boolean(element?.closest('audio, video'))
  if (mediaHasFocus && (key === ' ' || key === 'ArrowLeft' || key === 'ArrowRight')) return null
  if (key === ' ' && element?.closest('button, a, input, textarea, select')) return null
  if (key === 'ArrowRight' || key === ' ') return 'next'
  if (key === 'ArrowLeft') return 'previous'
  return null
}

interface PresentationInsertDialogState {
  kind: PresentationInsertDialogKind
  elementId?: string
}

interface PresentationFileInsertionTarget {
  documentId: string
  generation: number
  sessionId: string | null
  slideId: string
}

const MAX_PRESENTATION_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_PRESENTATION_MEDIA_BYTES = 60 * 1024 * 1024

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('The selected file could not be encoded'))
    }, { once: true })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('The selected file could not be read')), { once: true })
    reader.addEventListener('abort', () => reject(new Error('The selected file read was cancelled')), { once: true })
    reader.readAsDataURL(file)
  })
}

async function presentationImageSize(file: File): Promise<{ width: number; height: number } | null | undefined> {
  // happy-dom and older runtimes do not expose createImageBitmap. In Chromium,
  // a decode failure means the selected file is not a usable image and should
  // not be committed to the document or exported as corrupt media.
  if (typeof createImageBitmap !== 'function') return undefined
  try {
    const bitmap = await createImageBitmap(file)
    const size = bitmap.width > 0 && bitmap.height > 0
      ? { width: bitmap.width, height: bitmap.height }
      : null
    bitmap.close()
    return size
  } catch {
    return null
  }
}

async function presentationMediaCanLoad(file: File, type: PresentationMediaElement['type'], mimeType: string): Promise<boolean> {
  const media = document.createElement(type)
  if (!media.canPlayType(mimeType) || typeof URL.createObjectURL !== 'function') return false
  const objectUrl = URL.createObjectURL(file)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      media.removeEventListener('loadedmetadata', onLoaded)
      media.removeEventListener('error', onError)
      media.removeAttribute('src')
      URL.revokeObjectURL(objectUrl)
      resolve(result)
    }
    const onLoaded = () => finish(true)
    const onError = () => finish(false)
    const timeout = window.setTimeout(() => finish(false), 5_000)
    media.addEventListener('loadedmetadata', onLoaded, { once: true })
    media.addEventListener('error', onError, { once: true })
    media.preload = 'metadata'
    media.src = objectUrl
    try {
      media.load()
    } catch {
      finish(false)
    }
  })
}

type FabricModule = typeof import('fabric')

function fitFabricGroupToElement(group: FabricObject, element: PresentationElement): FabricObject {
  group.set({
    left: element.x,
    top: element.y,
    angle: isPresentationRotationLocked(element) ? 0 : element.rotation,
    originX: 'left',
    originY: 'top',
    scaleX: element.width / Math.max(1, group.width ?? element.width),
    scaleY: element.height / Math.max(1, group.height ?? element.height),
  })
  return group
}

function createMediaFabricObject(fabric: FabricModule, element: PresentationMediaElement): FabricObject {
  const background = new fabric.Rect({
    left: 0,
    top: 0,
    width: element.width,
    height: element.height,
    rx: Math.min(18, element.height * 0.18),
    ry: Math.min(18, element.height * 0.18),
    fill: element.type === 'video' ? '#171923' : '#252737',
    stroke: '#44475A',
    strokeWidth: 1,
  })
  const buttonSize = Math.min(68, element.height * 0.58)
  const button = new fabric.Circle({
    left: Math.max(16, element.height * 0.18),
    top: (element.height - buttonSize) / 2,
    radius: buttonSize / 2,
    fill: 'rgba(255,255,255,0.14)',
  })
  const symbol = new fabric.Text(element.type === 'video' ? '▶' : '♫', {
    left: button.left + (buttonSize / 2),
    top: button.top + (buttonSize / 2),
    originX: 'center',
    originY: 'center',
    fill: '#FFFFFF',
    fontSize: Math.max(20, buttonSize * 0.44),
    fontFamily: 'Arial',
  })
  const fileName = new fabric.Textbox(element.source.fileName, {
    left: button.left + buttonSize + 20,
    top: Math.max(10, (element.height - 32) / 2),
    width: Math.max(60, element.width - button.left - buttonSize - 40),
    height: 40,
    fill: '#FFFFFF',
    fontSize: Math.min(24, Math.max(14, element.height * 0.25)),
    fontFamily: 'Aptos',
    fontWeight: 500,
  })
  return fitFabricGroupToElement(new fabric.Group([background, button, symbol, fileName]), element)
}

function createTableFabricObject(fabric: FabricModule, element: PresentationTableElement): FabricObject {
  const rows = Math.max(1, element.cells.length)
  const columns = Math.max(1, ...element.cells.map((row) => row.length))
  const cellWidth = element.width / columns
  const cellHeight = element.height / rows
  const objects: FabricObject[] = []
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
      const header = element.headerRow && rowIndex === 0
      objects.push(new fabric.Rect({
        left: columnIndex * cellWidth,
        top: rowIndex * cellHeight,
        width: cellWidth,
        height: cellHeight,
        fill: header ? element.headerFill : element.bodyFill,
        stroke: element.borderColor,
        strokeWidth: 1,
      }))
      objects.push(new fabric.Textbox(element.cells[rowIndex]?.[columnIndex] ?? '', {
        left: (columnIndex * cellWidth) + 10,
        top: (rowIndex * cellHeight) + Math.max(4, (cellHeight - element.fontSize * 1.25) / 2),
        width: Math.max(12, cellWidth - 20),
        height: Math.max(12, cellHeight - 8),
        fill: header ? '#FFFFFF' : element.textColor,
        fontFamily: 'Aptos',
        fontSize: element.fontSize,
        fontWeight: header ? 600 : 400,
        textAlign: 'left',
      }))
    }
  }
  return fitFabricGroupToElement(new fabric.Group(objects), element)
}

function chartPolarPoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  const radians = (angle - 90) * (Math.PI / 180)
  return { x: cx + (radius * Math.cos(radians)), y: cy + (radius * Math.sin(radians)) }
}

function chartPieSlicePath(cx: number, cy: number, radius: number, start: number, end: number, innerRadius: number): string {
  const startPoint = chartPolarPoint(cx, cy, radius, end)
  const endPoint = chartPolarPoint(cx, cy, radius, start)
  const largeArc = end - start > 180 ? 1 : 0
  if (innerRadius <= 0) {
    return `M ${cx} ${cy} L ${startPoint.x} ${startPoint.y} A ${radius} ${radius} 0 ${largeArc} 0 ${endPoint.x} ${endPoint.y} Z`
  }
  const innerStart = chartPolarPoint(cx, cy, innerRadius, end)
  const innerEnd = chartPolarPoint(cx, cy, innerRadius, start)
  return `M ${startPoint.x} ${startPoint.y} A ${radius} ${radius} 0 ${largeArc} 0 ${endPoint.x} ${endPoint.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 1 ${innerStart.x} ${innerStart.y} Z`
}

function createChartFabricObject(fabric: FabricModule, element: Extract<PresentationElement, { type: 'chart' }>): FabricObject {
  const objects: FabricObject[] = [new fabric.Rect({
    left: 0,
    top: 0,
    width: element.width,
    height: element.height,
    fill: '#FFFFFF',
    stroke: '#E3E4EA',
    strokeWidth: 1,
  })]
  const titleHeight = element.title ? 46 : 14
  const legendHeight = element.showLegend ? 42 : 10
  if (element.title) {
    objects.push(new fabric.Textbox(element.title, {
      left: 36,
      top: 10,
      width: element.width - 72,
      height: 30,
      fill: '#20202B',
      fontFamily: 'Aptos Display',
      fontSize: 20,
      fontWeight: 600,
      textAlign: 'center',
    }))
  }
  const plotX = element.chartType === 'bar' ? 110 : 54
  const plotY = titleHeight
  const plotWidth = Math.max(80, element.width - plotX - 28)
  const plotHeight = Math.max(60, element.height - titleHeight - legendHeight - 34)
  if (element.chartType === 'pie' || element.chartType === 'doughnut') {
    const values = element.series[0]?.values.map((value) => Math.max(0, value)) ?? []
    const total = Math.max(1, values.reduce((sum, value) => sum + value, 0))
    const radius = Math.min(plotWidth, plotHeight) * 0.42
    const cx = plotX + (plotWidth / 2)
    const cy = plotY + (plotHeight / 2)
    const positiveValues = values.filter((value) => value > 0)
    if (positiveValues.length === 1) {
      const positiveIndex = values.findIndex((value) => value > 0)
      objects.push(new fabric.Circle({
        left: cx - radius,
        top: cy - radius,
        radius,
        fill: element.colors[positiveIndex % Math.max(1, element.colors.length)] ?? '#6957D9',
      }))
      if (element.chartType === 'doughnut') {
        objects.push(new fabric.Circle({ left: cx - (radius * 0.56), top: cy - (radius * 0.56), radius: radius * 0.56, fill: '#FFFFFF' }))
      }
    } else if (positiveValues.length > 1) {
      let angle = 0
      values.forEach((value, index) => {
        const start = angle
        angle += (value / total) * 360
        if (angle <= start) return
        objects.push(new fabric.Path(chartPieSlicePath(cx, cy, radius, start, angle, element.chartType === 'doughnut' ? radius * 0.56 : 0), {
          fill: element.colors[index % Math.max(1, element.colors.length)] ?? '#6957D9',
          stroke: '#FFFFFF',
          strokeWidth: 2,
        }))
      })
    }
  } else if (element.chartType === 'bar') {
    const categoryCount = Math.max(1, element.categories.length)
    const seriesCount = Math.max(1, element.series.length)
    const range = getPresentationChartRange(element.series)
    const valueX = (value: number) => plotX + (getPresentationChartValueRatio(value, range) * plotWidth)
    const zeroX = valueX(0)
    const groupHeight = plotHeight / categoryCount
    const barHeight = Math.max(3, (groupHeight - 8) / seriesCount)
    objects.push(new fabric.Line([zeroX, plotY, zeroX, plotY + plotHeight], { stroke: '#AEB0BA', strokeWidth: 1.5 }))
    element.categories.forEach((category, categoryIndex) => {
      objects.push(new fabric.Textbox(category, {
        left: 6,
        top: plotY + (categoryIndex * groupHeight) + (groupHeight / 2) - 9,
        width: plotX - 18,
        height: 20,
        fill: '#666571',
        fontFamily: 'Aptos',
        fontSize: 12,
        textAlign: 'right',
      }))
      element.series.forEach((series, seriesIndex) => {
        const value = series.values[categoryIndex] ?? 0
        const valuePosition = valueX(value)
        objects.push(new fabric.Rect({
          left: Math.min(valuePosition, zeroX),
          top: plotY + (categoryIndex * groupHeight) + 4 + (seriesIndex * barHeight),
          width: Math.abs(valuePosition - zeroX),
          height: Math.max(2, barHeight - 2),
          rx: 2,
          ry: 2,
          fill: element.colors[seriesIndex % Math.max(1, element.colors.length)] ?? '#6957D9',
        }))
      })
    })
  } else {
    const categoryCount = Math.max(1, element.categories.length)
    const range = getPresentationChartRange(element.series)
    const valueY = (value: number) => plotY + ((1 - getPresentationChartValueRatio(value, range)) * plotHeight)
    const zeroY = valueY(0)
    for (let gridIndex = 0; gridIndex <= 4; gridIndex += 1) {
      const y = plotY + ((plotHeight / 4) * gridIndex)
      objects.push(new fabric.Line([plotX, y, plotX + plotWidth, y], { stroke: '#E9EAF0', strokeWidth: 1 }))
    }
    objects.push(new fabric.Line([plotX, zeroY, plotX + plotWidth, zeroY], { stroke: '#AEB0BA', strokeWidth: 1.5 }))
    if (element.chartType === 'line') {
      element.series.forEach((series, seriesIndex) => {
        const points = element.categories.map((_, categoryIndex) => ({
          x: plotX + ((categoryIndex + 0.5) / categoryCount) * plotWidth,
          y: valueY(series.values[categoryIndex] ?? 0),
        }))
        objects.push(new fabric.Polyline(points, {
          fill: 'transparent',
          stroke: element.colors[seriesIndex % Math.max(1, element.colors.length)] ?? '#6957D9',
          strokeWidth: 4,
          strokeLineCap: 'round',
          strokeLineJoin: 'round',
        }))
      })
    } else {
      const groupWidth = plotWidth / categoryCount
      const seriesCount = Math.max(1, element.series.length)
      const gap = Math.min(8, groupWidth * 0.08)
      const barWidth = Math.max(2, (groupWidth - (gap * 2)) / seriesCount)
      element.categories.forEach((_, categoryIndex) => {
        element.series.forEach((series, seriesIndex) => {
          const value = series.values[categoryIndex] ?? 0
          const valuePosition = valueY(value)
          const height = Math.abs(valuePosition - zeroY)
          objects.push(new fabric.Rect({
            left: plotX + (categoryIndex * groupWidth) + gap + (seriesIndex * barWidth),
            top: Math.min(valuePosition, zeroY),
            width: Math.max(1, barWidth - 2),
            height,
            rx: 2,
            ry: 2,
            fill: element.colors[seriesIndex % Math.max(1, element.colors.length)] ?? '#6957D9',
          }))
        })
      })
    }
    element.categories.forEach((category, categoryIndex) => {
      objects.push(new fabric.Textbox(category, {
        left: plotX + (categoryIndex * (plotWidth / categoryCount)),
        top: plotY + plotHeight + 7,
        width: plotWidth / categoryCount,
        height: 20,
        fill: '#666571',
        fontFamily: 'Aptos',
        fontSize: 12,
        textAlign: 'center',
      }))
    })
  }
  if (element.showLegend) {
    const labels = element.chartType === 'pie' || element.chartType === 'doughnut'
      ? element.categories
      : element.series.map((series) => series.name)
    const itemWidth = Math.min(150, element.width / Math.max(1, labels.length))
    const startX = (element.width - (labels.length * itemWidth)) / 2
    labels.forEach((label, index) => {
      objects.push(new fabric.Rect({
        left: startX + (index * itemWidth),
        top: element.height - 25,
        width: 10,
        height: 10,
        rx: 2,
        ry: 2,
        fill: element.colors[index % Math.max(1, element.colors.length)] ?? '#6957D9',
      }))
      objects.push(new fabric.Textbox(label, {
        left: startX + (index * itemWidth) + 15,
        top: element.height - 29,
        width: itemWidth - 18,
        height: 18,
        fill: '#666571',
        fontFamily: 'Aptos',
        fontSize: 11,
      }))
    })
  }
  return fitFabricGroupToElement(new fabric.Group(objects), element)
}

function createShapeFabricObject(fabric: FabricModule, element: PresentationShapeElement): FabricObject {
  const shadow = element.shadow
    ? new fabric.Shadow({ color: 'rgba(20, 20, 32, 0.22)', blur: 12, offsetX: 6, offsetY: 6 })
    : undefined
  if (element.type === 'ellipse') {
    return new fabric.Ellipse({
      left: element.x,
      top: element.y,
      rx: element.width / 2,
      ry: element.height / 2,
      angle: element.rotation,
      originX: 'left',
      originY: 'top',
      fill: element.fill,
      stroke: element.borderColor,
      strokeWidth: element.borderWidth,
      shadow,
    })
  }
  if (element.type === 'rect' || element.type === 'roundRect') {
    return new fabric.Rect({
      left: element.x,
      top: element.y,
      width: element.width,
      height: element.height,
      rx: element.type === 'roundRect' ? Math.min(element.width, element.height) * 0.12 : element.radius ?? 0,
      ry: element.type === 'roundRect' ? Math.min(element.width, element.height) * 0.12 : element.radius ?? 0,
      angle: element.rotation,
      originX: 'left',
      originY: 'top',
      fill: element.fill,
      stroke: element.borderColor,
      strokeWidth: element.borderWidth,
      shadow,
    })
  }
  const definition = getPresentationShapeDefinition(element.type)
  const strokeOnly = definition.strokeOnly || isPresentationLineShape(element.type)
  const path = new fabric.Path(definition.path, {
    left: element.x,
    top: element.y,
    angle: element.rotation,
    originX: 'left',
    originY: 'top',
    fill: strokeOnly ? 'transparent' : element.fill,
    fillRule: 'evenodd',
    stroke: element.borderColor,
    strokeWidth: strokeOnly ? Math.max(3, element.borderWidth) : element.borderWidth,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    strokeUniform: true,
    shadow,
  })
  path.set({
    scaleX: element.width / Math.max(1, path.width ?? 1),
    scaleY: element.height / Math.max(1, path.height ?? 1),
  })
  return path
}

async function createPresentationFabricObject(
  fabric: FabricModule,
  element: PresentationElement,
  onTextEdit: (object: FabricObject) => void,
): Promise<FabricObject> {
  if (isPresentationTextElement(element)) {
    const textbox = new fabric.Textbox(formatPresentationText(element), {
      left: element.x,
      top: element.y,
      width: element.width,
      angle: element.rotation,
      originX: 'left',
      originY: 'top',
      fill: element.hyperlink ? '#2563EB' : element.color,
      fontFamily: element.fontFamily,
      fontSize: element.fontSize,
      fontWeight: element.fontWeight,
      fontStyle: element.italic ? 'italic' : 'normal',
      lineHeight: element.lineHeight ?? 1.08,
      textAlign: element.align,
      underline: Boolean(element.underline || element.hyperlink),
      linethrough: Boolean(element.strikethrough),
      textBackgroundColor: element.highlightColor ?? '',
      charSpacing: element.characterSpacing ?? 0,
      padding: (element.indentLevel ?? 0) * 16,
      shadow: element.shadow ? new fabric.Shadow({ color: 'rgba(20, 20, 32, 0.28)', blur: 12, offsetX: 6, offsetY: 6 }) : undefined,
      splitByGrapheme: false,
    })
    if (element.baseline === 'superscript') textbox.setSuperscript(0, textbox.text.length)
    if (element.baseline === 'subscript') textbox.setSubscript(0, textbox.text.length)
    textbox.on('editing:exited', () => onTextEdit(textbox))
    return textbox
  }
  if (isPresentationShapeElement(element)) return createShapeFabricObject(fabric, element)
  if (isPresentationImageElement(element)) {
    try {
      const image = await fabric.FabricImage.fromURL(element.source.dataUrl)
      const naturalWidth = Math.max(1, image.width ?? element.width)
      const naturalHeight = Math.max(1, image.height ?? element.height)
      const frame = new fabric.Rect({
        left: 0,
        top: 0,
        width: element.width,
        height: element.height,
        fill: 'rgba(0,0,0,0)',
        strokeWidth: 0,
      })
      if (element.fit === 'cover') {
        const scale = Math.max(element.width / naturalWidth, element.height / naturalHeight)
        const cropWidth = element.width / scale
        const cropHeight = element.height / scale
        image.set({
          left: 0,
          top: 0,
          width: cropWidth,
          height: cropHeight,
          cropX: Math.max(0, (naturalWidth - cropWidth) / 2),
          cropY: Math.max(0, (naturalHeight - cropHeight) / 2),
          scaleX: scale,
          scaleY: scale,
        })
      } else {
        const scale = Math.min(element.width / naturalWidth, element.height / naturalHeight)
        image.set({
          left: (element.width - (naturalWidth * scale)) / 2,
          top: (element.height - (naturalHeight * scale)) / 2,
          scaleX: scale,
          scaleY: scale,
        })
      }
      const group = fitFabricGroupToElement(new fabric.Group([frame, image]), element)
      group.set({
        shadow: element.shadow ? new fabric.Shadow({ color: 'rgba(20, 20, 32, 0.22)', blur: 12, offsetX: 6, offsetY: 6 }) : undefined,
      })
      return group
    } catch {
      const fallback: PresentationMediaElement = {
        ...element,
        type: 'video',
        autoplay: false,
        loop: false,
        muted: true,
      }
      return createMediaFabricObject(fabric, fallback)
    }
  }
  if (isPresentationMediaElement(element)) return createMediaFabricObject(fabric, element)
  if (isPresentationTableElement(element)) return createTableFabricObject(fabric, element)
  if (isPresentationChartElement(element)) return createChartFabricObject(fabric, element)
  throw new Error(`Unsupported presentation element: ${(element as { type?: string }).type ?? 'unknown'}`)
}

function createFooterFabricObjects(fabric: FabricModule, slide: PresentationSlide, slideNumber: number): FabricObject[] {
  if (!slide.footer) return []
  const objects: FabricObject[] = []
  const style = {
    fill: '#666571',
    fontFamily: 'Aptos',
    fontSize: 12,
    selectable: false,
    evented: false,
    originX: 'left' as const,
    originY: 'top' as const,
  }
  if (slide.footer.text) objects.push(new fabric.Text(slide.footer.text, { ...style, left: 32, top: 686 }))
  if (slide.footer.showDate) {
    objects.push(new fabric.Text(new Intl.DateTimeFormat().format(new Date()), {
      ...style,
      left: PRESENTATION_WIDTH / 2,
      top: 686,
      originX: 'center',
    }))
  }
  if (slide.footer.showSlideNumber) {
    objects.push(new fabric.Text(String(slideNumber), {
      ...style,
      left: PRESENTATION_WIDTH - 32,
      top: 686,
      originX: 'right',
    }))
  }
  return objects
}

/** A focused PowerPoint-style editor embedded in the Session workbench. */
export function PresentationWorkbenchPanel({ active }: PresentationWorkbenchPanelProps) {
  const { t } = useTranslation()
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const [workspace, setWorkspace] = useAtom(currentPresentationWorkspaceAtom)
  const [document, setDocument] = useAtom(currentPresentationDocumentAtom)
  const [expanded, setExpanded] = useAtom(presentationExpandedAtom)
  const setRightCollapsed = useSetAtom(setRightPanelCollapsedAtom)
  const requestExternalLink = useSetAtom(requestExternalLinkAtom)
  const showToast = useSetAtom(showToastAtom)
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [canvasGeneration, setCanvasGeneration] = useState(0)
  const [canvasScale, setCanvasScale] = useState(0.4)
  const [compact, setCompact] = useState(true)
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [exportedPaths, setExportedPaths] = useState<Record<string, string>>({})
  const [inspectorMode, setInspectorMode] = useState<'animation' | 'properties'>('properties')
  const [ribbonTab, setRibbonTab] = useState<PresentationRibbonTab>('home')
  const [slideshowOpen, setSlideshowOpen] = useState(false)
  const [slideshowIndex, setSlideshowIndex] = useState(0)
  const [slideshowTransition, setSlideshowTransition] = useState<SlideshowTransitionRun | null>(null)
  const [transitionPreviewRun, setTransitionPreviewRun] = useState<TransitionPreviewRun | null>(null)
  const [historyStatus, setHistoryStatus] = useState({ canUndo: false, canRedo: false })
  const [exportState, setExportState] = useState<ExportState>('idle')
  const [insertDialog, setInsertDialog] = useState<PresentationInsertDialogState | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasElementRef = useRef<HTMLCanvasElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<FabricCanvas | null>(null)
  const fabricModuleRef = useRef<typeof import('fabric') | null>(null)
  const objectIdsRef = useRef(new WeakMap<FabricObject, string>())
  const documentRef = useRef(document)
  const selectedElementIdRef = useRef<string | null>(null)
  const pastRef = useRef<PresentationHistoryEntry[]>([])
  const futureRef = useRef<PresentationHistoryEntry[]>([])
  const transitionRunIdRef = useRef(0)
  const fileInsertionTargetRef = useRef<PresentationFileInsertionTarget>({
    documentId: document.id,
    generation: 0,
    sessionId,
    slideId: document.selectedSlideId,
  })

  const currentSlide = document.slides.find((slide) => slide.id === document.selectedSlideId)
    ?? document.slides[0]
  const selectedElement = currentSlide?.elements.find((element) => (
    element.id === selectedElementId
  )) ?? null
  const selectedText = selectedElement && isPresentationTextElement(selectedElement) ? selectedElement : null

  const commitDocument = useCallback((next: PresentationDocument, recordHistory = true) => {
    const current = documentRef.current
    if (recordHistory) {
      const entry = createPresentationHistoryEntry(current)
      // An oversized state is an undo barrier. Keeping older entries would make
      // Undo skip the latest change and restore an unrelated document state.
      pastRef.current = entry
        ? trimPresentationHistoryEntries([...pastRef.current, entry])
        : []
      futureRef.current = []
    }
    documentRef.current = next
    setDocument(next)
    setHistoryStatus({
      canUndo: pastRef.current.length > 0,
      canRedo: futureRef.current.length > 0,
    })
  }, [setDocument])

  const replaceCurrentSlide = useCallback((nextSlide: PresentationSlide) => {
    const current = documentRef.current
    commitDocument({
      ...current,
      slides: current.slides.map((slide) => slide.id === nextSlide.id ? nextSlide : slide),
    })
  }, [commitDocument])

  const patchElement = useCallback((elementId: string, patch: Partial<PresentationElement>) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    const nextElements = slide.elements.map((element): PresentationElement => (
      element.id === elementId ? { ...element, ...patch } as PresentationElement : element
    ))
    replaceCurrentSlide({ ...slide, elements: nextElements })
  }, [replaceCurrentSlide])

  const syncFabricObjectRef = useRef<(object: FabricObject) => void>(() => undefined)
  const syncFabricObject = useCallback((object: FabricObject) => {
    const elementId = objectIdsRef.current.get(object)
    if (!elementId) return
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    const element = slide?.elements.find((item) => item.id === elementId)
    if (!element) return
    const scaleX = object.scaleX ?? 1
    const scaleY = object.scaleY ?? 1
    const patch: Partial<PresentationElement> = {
      x: Math.round(object.left),
      y: Math.round(object.top),
      width: Math.max(8, Math.round((object.width ?? 0) * scaleX)),
      height: Math.max(8, Math.round((object.height ?? 0) * scaleY)),
      ...(isPresentationRotationLocked(element) ? {} : { rotation: Math.round(object.angle ?? 0) }),
    }
    if ('text' in object && typeof object.text === 'string') {
      const text = element.type === 'text'
        ? stripPresentationListMarkers(object.text, element.listStyle)
        : object.text
      Object.assign(patch, { text })
    }
    patchElement(elementId, patch)
  }, [patchElement])

  useLayoutEffect(() => {
    documentRef.current = document
    const previous = fileInsertionTargetRef.current
    const targetChanged = previous.sessionId !== sessionId
      || previous.documentId !== document.id
      || previous.slideId !== document.selectedSlideId
    fileInsertionTargetRef.current = {
      documentId: document.id,
      generation: targetChanged ? previous.generation + 1 : previous.generation,
      sessionId,
      slideId: document.selectedSlideId,
    }
  }, [document, sessionId])

  useEffect(() => () => {
    fileInsertionTargetRef.current = {
      ...fileInsertionTargetRef.current,
      generation: fileInsertionTargetRef.current.generation + 1,
    }
  }, [])

  useEffect(() => {
    selectedElementIdRef.current = selectedElementId
  }, [selectedElementId])

  useEffect(() => {
    syncFabricObjectRef.current = syncFabricObject
  }, [syncFabricObject])

  useEffect(() => {
    pastRef.current = []
    futureRef.current = []
    const timer = window.setTimeout(() => {
      setSlideshowOpen(false)
      setSlideshowTransition(null)
      setTransitionPreviewRun(null)
      setInsertDialog(null)
      setSelectedElementId(null)
      setHistoryStatus({ canUndo: false, canRedo: false })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [document.id, sessionId])

  useEffect(() => {
    if (active) return
    const timer = window.setTimeout(() => {
      setSlideshowOpen(false)
      setSlideshowTransition(null)
      setTransitionPreviewRun(null)
      setInsertDialog(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [active])

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setCompact(entry.contentRect.width < 1120)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!active) return
    const stage = stageRef.current
    if (!stage || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const widthScale = Math.max(0.1, (entry.contentRect.width - 32) / PRESENTATION_WIDTH)
      const heightScale = Math.max(0.1, (entry.contentRect.height - 32) / PRESENTATION_HEIGHT)
      setCanvasScale(Math.min(widthScale, heightScale, 1))
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [active, compact, expanded])

  useEffect(() => {
    if (!active || !canvasElementRef.current) return
    let cancelled = false
    void import('fabric').then((fabric) => {
      if (cancelled || !canvasElementRef.current) return
      const canvas = new fabric.Canvas(canvasElementRef.current, {
        width: PRESENTATION_WIDTH,
        height: PRESENTATION_HEIGHT,
        preserveObjectStacking: true,
        selection: false,
        selectionColor: 'rgba(105, 87, 217, 0.12)',
        selectionBorderColor: '#6957D9',
      })
      fabricModuleRef.current = fabric
      canvasRef.current = canvas
      canvas.on('selection:created', (event) => {
        const selected = event.selected?.[0]
        setSelectedElementId(selected ? objectIdsRef.current.get(selected) ?? null : null)
      })
      canvas.on('selection:updated', (event) => {
        const selected = event.selected?.[0]
        setSelectedElementId(selected ? objectIdsRef.current.get(selected) ?? null : null)
      })
      canvas.on('selection:cleared', () => setSelectedElementId(null))
      canvas.on('object:modified', (event) => {
        if (event.target) syncFabricObjectRef.current(event.target)
      })
      canvas.on('mouse:dblclick', (event) => {
        const elementId = event.target ? objectIdsRef.current.get(event.target) : undefined
        if (!elementId) return
        const current = documentRef.current
        const slide = current.slides.find((item) => item.id === current.selectedSlideId)
        const element = slide?.elements.find((item) => item.id === elementId)
        if (!element || (!isPresentationTableElement(element) && !isPresentationChartElement(element))) return
        setSelectedElementId(element.id)
        setInsertDialog({ kind: element.type, elementId: element.id })
      })
      setCanvasGeneration((value) => value + 1)
    })
    return () => {
      cancelled = true
      const canvas = canvasRef.current
      canvasRef.current = null
      fabricModuleRef.current = null
      objectIdsRef.current = new WeakMap()
      if (canvas) void canvas.dispose()
    }
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    const fabric = fabricModuleRef.current
    if (!active || !canvas || !fabric || !currentSlide) return
    let cancelled = false
    const activeElementId = selectedElementIdRef.current
    canvas.clear()
    canvas.backgroundColor = currentSlide.background
    objectIdsRef.current = new WeakMap()
    void Promise.all(currentSlide.elements.map(async (element) => ({
      element,
      object: await createPresentationFabricObject(fabric, element, (object) => syncFabricObjectRef.current(object)),
    }))).then((entries) => {
      if (cancelled || canvasRef.current !== canvas) return
      let activeObject: FabricObject | null = null
      for (const { element, object } of entries) {
        object.set({
          borderColor: '#6957D9',
          cornerColor: '#FFFFFF',
          cornerStrokeColor: '#6957D9',
          cornerStyle: 'circle',
          cornerSize: 11,
          transparentCorners: false,
          objectCaching: false,
          lockRotation: isPresentationRotationLocked(element),
          hoverCursor: element.hyperlink && supportsPresentationElementHyperlink(element) ? 'pointer' : 'move',
        })
        objectIdsRef.current.set(object, element.id)
        canvas.add(object)
        if (element.id === activeElementId) activeObject = object
      }
      const slideNumber = documentRef.current.slides.findIndex((slide) => slide.id === currentSlide.id) + 1
      createFooterFabricObjects(fabric, currentSlide, Math.max(1, slideNumber)).forEach((object) => canvas.add(object))
      if (activeObject) canvas.setActiveObject(activeObject)
      canvas.requestRenderAll()
    }).catch(() => {
      if (!cancelled) canvas.requestRenderAll()
    })
    return () => {
      cancelled = true
    }
  }, [active, canvasGeneration, currentSlide])

  const undo = useCallback(() => {
    const previous = pastRef.current.pop()
    if (!previous) return
    const current = createPresentationHistoryEntry(documentRef.current)
    if (current) futureRef.current.push(current)
    else futureRef.current = []
    trimPresentationHistoryPair(pastRef.current, futureRef.current)
    commitDocument(previous.document, false)
  }, [commitDocument])

  const redo = useCallback(() => {
    const next = futureRef.current.pop()
    if (!next) return
    const current = createPresentationHistoryEntry(documentRef.current)
    if (current) pastRef.current.push(current)
    else pastRef.current = []
    trimPresentationHistoryPair(pastRef.current, futureRef.current)
    commitDocument(next.document, false)
  }, [commitDocument])

  const deleteSelectedElement = useCallback(() => {
    const elementId = selectedElementIdRef.current
    if (!elementId) return
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    setSelectedElementId(null)
    replaceCurrentSlide({
      ...slide,
      elements: slide.elements.filter((element) => element.id !== elementId),
    })
  }, [replaceCurrentSlide])

  useEffect(() => {
    if (!active || slideshowOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
      )) return
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelectedElement()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, deleteSelectedElement, redo, slideshowOpen, undo])

  const goToSlideshowIndex = useCallback((requestedIndex: number) => {
    if (slideshowTransition) return
    const slides = documentRef.current.slides
    const toIndex = Math.max(0, Math.min(slides.length - 1, requestedIndex))
    if (toIndex === slideshowIndex) return
    const transition = normalizePresentationTransition(slides[toIndex]?.transition)
    if (transition.effect === 'none') {
      setSlideshowIndex(toIndex)
      return
    }
    transitionRunIdRef.current += 1
    setSlideshowTransition({
      direction: toIndex > slideshowIndex ? 'forward' : 'backward',
      fromIndex: slideshowIndex,
      runKey: transitionRunIdRef.current,
      toIndex,
    })
  }, [slideshowIndex, slideshowTransition])

  const activateSlideshowHyperlink = useCallback((hyperlink: PresentationHyperlink) => {
    if (hyperlink.type === 'slide') {
      const index = documentRef.current.slides.findIndex((slide) => slide.id === hyperlink.slideId)
      if (index >= 0) goToSlideshowIndex(index)
      return
    }
    void requestExternalLink(hyperlink.url).then((open) => {
      if (open) return window.api.shell.openExternal(hyperlink.url)
    })
  }, [goToSlideshowIndex, requestExternalLink])

  useEffect(() => {
    if (!active || !slideshowOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolvePresentationSlideshowKeyAction(event.target, event.key)
      if (action === 'close') {
        setSlideshowOpen(false)
        setSlideshowTransition(null)
      } else if (action === 'next') {
        event.preventDefault()
        goToSlideshowIndex(slideshowIndex + 1)
      } else if (action === 'previous') {
        event.preventDefault()
        goToSlideshowIndex(slideshowIndex - 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, goToSlideshowIndex, slideshowIndex, slideshowOpen])

  const selectSlide = (slideId: string) => {
    setSelectedElementId(null)
    setTransitionPreviewRun(null)
    const current = documentRef.current
    commitDocument({ ...current, selectedSlideId: slideId }, false)
  }

  const addPresentation = () => {
    const nextIndex = workspace.documents.length + 1
    const nextDocument = createBlankPresentationDocument(
      t('session.presentation.untitledDocument', { index: nextIndex }),
      t('session.presentation.slideName', { index: 1 }),
    )
    setWorkspace({
      activeDocumentId: nextDocument.id,
      documents: [...workspace.documents, nextDocument],
    })
  }

  const selectPresentation = (documentId: string) => {
    if (documentId === workspace.activeDocumentId) return
    setWorkspace({ ...workspace, activeDocumentId: documentId })
  }

  const closePresentation = (documentId: string) => {
    if (workspace.documents.length <= 1) return
    const closedIndex = workspace.documents.findIndex((item) => item.id === documentId)
    const documents = workspace.documents.filter((item) => item.id !== documentId)
    const activeDocumentId = documentId === workspace.activeDocumentId
      ? documents[Math.min(Math.max(0, closedIndex), documents.length - 1)]!.id
      : workspace.activeDocumentId
    setWorkspace({ activeDocumentId, documents })
  }

  const addSlide = () => {
    const current = documentRef.current
    const slide = createBlankPresentationSlide(
      t('session.presentation.slideName', { index: current.slides.length + 1 }),
    )
    setSelectedElementId(null)
    commitDocument({
      ...current,
      selectedSlideId: slide.id,
      slides: [...current.slides, slide],
    })
  }

  const duplicateSlide = () => {
    if (!currentSlide) return
    const current = documentRef.current
    const duplicate: PresentationSlide = {
      ...currentSlide,
      id: createPresentationId('slide'),
      name: t('session.presentation.slideCopy', { name: currentSlide.name }),
      elements: currentSlide.elements.map((element) => ({
        ...element,
        id: createPresentationId(element.type),
      })),
    }
    const index = current.slides.findIndex((slide) => slide.id === currentSlide.id)
    const slides = [...current.slides]
    slides.splice(index + 1, 0, duplicate)
    setSelectedElementId(null)
    commitDocument({ ...current, selectedSlideId: duplicate.id, slides })
  }

  const deleteSlide = () => {
    const current = documentRef.current
    if (current.slides.length <= 1 || !currentSlide) return
    const index = current.slides.findIndex((slide) => slide.id === currentSlide.id)
    const slides = current.slides.filter((slide) => slide.id !== currentSlide.id)
    const nextSelectedSlide = slides[Math.min(index, slides.length - 1)]
    if (!nextSelectedSlide) return
    setSelectedElementId(null)
    commitDocument({
      ...current,
      slides,
      selectedSlideId: nextSelectedSlide.id,
    })
  }

  const addText = (kind: 'title' | 'body') => {
    if (!currentSlide) return
    const isTitle = kind === 'title'
    const element: PresentationTextElement = {
      id: createPresentationId('text'),
      type: 'text',
      x: isTitle ? 82 : 100,
      y: isTitle ? 76 : 210,
      width: isTitle ? 940 : 700,
      height: isTitle ? 82 : 120,
      rotation: 0,
      text: t(isTitle ? 'session.presentation.titlePlaceholder' : 'session.presentation.textPlaceholder'),
      fontSize: isTitle ? 42 : 24,
      fontFamily: isTitle ? 'Aptos Display' : 'Aptos',
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
      align: 'left',
    }
    setSelectedElementId(element.id)
    replaceCurrentSlide({ ...currentSlide, elements: [...currentSlide.elements, element] })
  }

  const addShape = (type: PresentationShapeType) => {
    if (!currentSlide) return
    const size = getPresentationShapeSize(type)
    const lineShape = isPresentationLineShape(type)
    const element: PresentationShapeElement = {
      id: createPresentationId('shape'),
      type,
      x: Math.round((PRESENTATION_WIDTH - size.width) / 2),
      y: Math.round((PRESENTATION_HEIGHT - size.height) / 2),
      width: size.width,
      height: size.height,
      rotation: 0,
      fill: lineShape ? 'transparent' : '#8B7CFF',
      borderColor: '#6957D9',
      borderWidth: lineShape ? 3 : 1,
      radius: type === 'rect' ? 18 : undefined,
    }
    setSelectedElementId(element.id)
    replaceCurrentSlide({ ...currentSlide, elements: [...currentSlide.elements, element] })
  }

  const appendElement = (element: PresentationElement) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    setSelectedElementId(element.id)
    replaceCurrentSlide({ ...slide, elements: [...slide.elements, element] })
  }

  const insertFile = async (kind: 'image' | 'audio' | 'video', event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const target = { ...fileInsertionTargetRef.current }
    const maxBytes = kind === 'image' ? MAX_PRESENTATION_IMAGE_BYTES : MAX_PRESENTATION_MEDIA_BYTES
    if (file.size > maxBytes) {
      showToast(t('session.presentation.insertDialog.fileTooLarge', { size: Math.round(maxBytes / 1024 / 1024) }))
      return
    }
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const targetStillCurrent = () => {
        const currentTarget = fileInsertionTargetRef.current
        return target.generation === currentTarget.generation
          && target.sessionId === currentTarget.sessionId
          && target.documentId === currentTarget.documentId
          && target.slideId === currentTarget.slideId
      }
      const source = normalizePresentationFileSource(kind, {
        dataUrl,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
      })
      if (!source) throw new Error('Unsupported presentation media format')
      if (!targetStillCurrent()) {
        showToast(t('session.common.cancelled'))
        return
      }
      let element: PresentationElement
      if (kind === 'image') {
        const image = createPresentationImageElement(source)
        const size = await presentationImageSize(file)
        if (size === null) throw new Error('The selected image could not be decoded')
        if (size) {
          const scale = Math.min(640 / size.width, 420 / size.height)
          const width = Math.max(32, Math.round(size.width * scale))
          const height = Math.max(32, Math.round(size.height * scale))
          element = {
            ...image,
            x: Math.round((PRESENTATION_WIDTH - width) / 2),
            y: Math.round((PRESENTATION_HEIGHT - height) / 2),
            width,
            height,
          }
        } else {
          element = image
        }
      } else {
        if (!hasValidPresentationMediaSignature(kind, source)) {
          throw new Error('The selected media container does not match its file type')
        }
        if (!await presentationMediaCanLoad(file, kind, source.mimeType)) {
          throw new Error('The selected media cannot be decoded by the slide show renderer')
        }
        element = createPresentationMediaElement(kind, source)
      }
      if (!targetStillCurrent()) {
        showToast(t('session.common.cancelled'))
        return
      }
      if ((isPresentationImageElement(element) || isPresentationMediaElement(element))
        && !canAppendPresentationFileElement(documentRef.current, element)) {
        showToast(t('session.presentation.insertDialog.totalFileSizeTooLarge'))
        return
      }
      appendElement(element)
    } catch {
      showToast(t('session.presentation.insertDialog.fileReadError'))
    }
  }

  const openLinkDialog = () => {
    const linkable = selectedElement && supportsPresentationElementHyperlink(selectedElement)
      ? selectedElement
      : null
    setInsertDialog({ kind: 'link', ...(linkable ? { elementId: linkable.id } : {}) })
  }

  const submitInsertDialog = (value: PresentationInsertDialogValue) => {
    const state = insertDialog
    if (!state) return
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    const existing = state.elementId
      ? slide.elements.find((element) => element.id === state.elementId)
      : undefined

    if (value.kind === 'table') {
      if (existing && isPresentationTableElement(existing)) {
        patchElement(existing.id, { cells: value.cells.map((row) => [...row]) } as Partial<PresentationTableElement>)
      } else {
        appendElement(createPresentationTableElement(value.cells))
      }
    } else if (value.kind === 'chart') {
      if (existing && isPresentationChartElement(existing)) {
        patchElement(existing.id, {
          chartType: value.chartType,
          title: value.title || undefined,
          categories: [...value.categories],
          series: value.series.map((series) => ({ name: series.name, values: [...series.values] })),
        } as Partial<typeof existing>)
      } else {
        const element = createPresentationChartElement(value.chartType)
        appendElement({
          ...element,
          title: value.title || undefined,
          categories: [...value.categories],
          series: value.series.map((series) => ({ name: series.name, values: [...series.values] })),
        })
      }
    } else if (value.kind === 'link') {
      let hyperlink: PresentationHyperlink | null = null
      if (value.targetType === 'url') {
        hyperlink = createPresentationUrlHyperlink(value.url, value.tooltip)
      } else if (current.slides.some((item) => item.id === value.slideId)) {
        hyperlink = { type: 'slide', slideId: value.slideId, ...(value.tooltip ? { tooltip: value.tooltip } : {}) }
      }
      if (!hyperlink) {
        showToast(t('session.presentation.insertDialog.linkError'))
        return
      }
      if (existing && (
        isPresentationTextElement(existing)
        || isPresentationShapeElement(existing)
        || isPresentationImageElement(existing)
      )) {
        patchElement(existing.id, {
          hyperlink,
          ...(isPresentationTextElement(existing) ? { text: value.label } : {}),
        } as Partial<PresentationElement>)
      } else {
        const width = 560
        const height = 54
        const element: PresentationTextElement = {
          id: createPresentationId('text'),
          type: 'text',
          x: Math.round((PRESENTATION_WIDTH - width) / 2),
          y: Math.round((PRESENTATION_HEIGHT - height) / 2),
          width,
          height,
          rotation: 0,
          text: value.label,
          fontSize: 26,
          fontFamily: 'Aptos',
          fontWeight: 400,
          underline: true,
          color: '#2563EB',
          align: 'center',
          hyperlink,
        }
        appendElement(element)
      }
    } else {
      const footer = {
        ...createPresentationFooter(value.text),
        showDate: value.showDate,
        showSlideNumber: value.showSlideNumber,
      }
      if (value.applyAll) {
        commitDocument({
          ...current,
          slides: current.slides.map((item) => ({ ...item, footer: { ...footer } })),
        })
      } else {
        replaceCurrentSlide({ ...slide, footer })
      }
    }
    setInsertDialog(null)
  }

  const updateSelectedElement = (patch: Partial<PresentationElement>) => {
    if (!selectedElement) return
    let supportedPatch = patch
    if (isPresentationRotationLocked(selectedElement) && 'rotation' in supportedPatch) {
      const { rotation: _ignoredRotation, ...remainingPatch } = supportedPatch
      supportedPatch = remainingPatch
    }
    if (!supportsPresentationElementShadow(selectedElement) && 'shadow' in supportedPatch) {
      const { shadow: _ignoredShadow, ...remainingPatch } = supportedPatch
      supportedPatch = remainingPatch
    }
    if (Object.keys(supportedPatch).length > 0) patchElement(selectedElement.id, supportedPatch)
  }

  const moveSelectedElement = (direction: 'front' | 'back') => {
    if (!currentSlide || !selectedElement) return
    const elements = currentSlide.elements.filter((element) => element.id !== selectedElement.id)
    if (direction === 'front') elements.push(selectedElement)
    else elements.unshift(selectedElement)
    replaceCurrentSlide({ ...currentSlide, elements })
  }

  const findText = (query: string) => {
    const needle = query.toLocaleLowerCase()
    const current = documentRef.current
    for (const slide of current.slides) {
      const element = slide.elements.find((item) => (
        item.type === 'text' && item.text.toLocaleLowerCase().includes(needle)
      ))
      if (!element) continue
      setSelectedElementId(element.id)
      commitDocument({ ...current, selectedSlideId: slide.id }, false)
      return
    }
  }

  const updateCurrentSlide = (patch: Partial<PresentationSlide>, recordHistory = true) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    const nextSlide = { ...slide, ...patch }
    if (recordHistory) {
      replaceCurrentSlide(nextSlide)
      return
    }
    commitDocument({
      ...current,
      slides: current.slides.map((item) => item.id === slide.id ? nextSlide : item),
    }, false)
  }

  const applyCurrentTransitionToAll = () => {
    const current = documentRef.current
    const selectedSlide = current.slides.find((slide) => slide.id === current.selectedSlideId)
    if (!selectedSlide) return
    const transition = normalizePresentationTransition(selectedSlide.transition)
    commitDocument({
      ...current,
      slides: current.slides.map((slide) => ({
        ...slide,
        transition: { ...transition },
      })),
    })
  }

  const updateSlideBackground = (event: ChangeEvent<HTMLInputElement>) => {
    updateCurrentSlide({ background: event.target.value })
  }

  const updateSlideNotes = (event: FormEvent<HTMLTextAreaElement>) => {
    updateCurrentSlide({ notes: event.currentTarget.value }, false)
  }

  const fitCanvas = () => {
    const stage = stageRef.current
    if (!stage) return
    const widthScale = Math.max(0.1, (stage.clientWidth - 40) / PRESENTATION_WIDTH)
    const heightScale = Math.max(0.1, (stage.clientHeight - 40) / PRESENTATION_HEIGHT)
    setCanvasScale(Math.min(widthScale, heightScale, 1))
  }

  const previewTransition = (override?: PresentationTransition) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    const transition = normalizePresentationTransition(override ?? slide?.transition)
    if (!slide) return
    if (transition.effect === 'none') {
      setTransitionPreviewRun(null)
      return
    }
    transitionRunIdRef.current += 1
    setTransitionPreviewRun({ runKey: transitionRunIdRef.current, slideId: slide.id, transition })
  }

  const previewSelectedAnimation = () => {
    const canvas = canvasRef.current
    const object = canvas?.getActiveObject()
    const effect = selectedElement?.animation ?? 'none'
    if (!canvas || !object || effect === 'none') return
    const initial = {
      left: object.left,
      opacity: object.opacity,
      scaleX: object.scaleX,
      scaleY: object.scaleY,
      top: object.top,
    }
    const duration = Math.max(180, selectedElement?.animationDuration ?? 520)
    const startedAt = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - ((1 - progress) ** 3)
      if (effect === 'appear') {
        object.set({ opacity: progress < 0.45 ? 0 : initial.opacity })
      } else if (effect === 'fade') {
        object.set({ opacity: initial.opacity * eased })
      } else if (effect === 'flyIn') {
        object.set({ left: initial.left - (90 * (1 - eased)), opacity: initial.opacity * eased })
      } else if (effect === 'zoom') {
        const scale = 0.72 + (0.28 * eased)
        object.set({
          opacity: initial.opacity * eased,
          scaleX: initial.scaleX * scale,
          scaleY: initial.scaleY * scale,
        })
      }
      canvas.requestRenderAll()
      if (progress < 1) {
        window.requestAnimationFrame(tick)
        return
      }
      object.set(initial)
      canvas.requestRenderAll()
    }
    window.requestAnimationFrame(tick)
  }

  const startSlideshow = () => {
    const index = documentRef.current.slides.findIndex((slide) => slide.id === documentRef.current.selectedSlideId)
    setTransitionPreviewRun(null)
    setSlideshowTransition(null)
    setSlideshowIndex(Math.max(0, index))
    setSlideshowOpen(true)
  }

  const startSlideshowFromBeginning = () => {
    setTransitionPreviewRun(null)
    setSlideshowTransition(null)
    setSlideshowIndex(0)
    setSlideshowOpen(true)
  }

  const togglePropertiesInspector = () => {
    if (inspectorMode !== 'properties') {
      setInspectorMode('properties')
      setInspectorOpen(true)
      return
    }
    setInspectorOpen((value) => !value)
  }

  const toggleAnimationPane = () => {
    if (inspectorMode !== 'animation') {
      setInspectorMode('animation')
      setInspectorOpen(true)
      return
    }
    setInspectorOpen((value) => !value)
  }

  const exportPresentation = async () => {
    if (exportState === 'exporting') return
    setExportState('exporting')
    try {
      const safeTitle = (documentRef.current.title || t('session.presentation.untitled'))
        .replace(/[\\/:*?"<>|]/g, '-')
      const result = await window.api.dialog.save({
        title: t('session.presentation.export'),
        defaultPath: `${safeTitle}.pptx`,
        filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
      })
      if (result.canceled || !result.filePath) {
        setExportState('idle')
        return
      }
      const { createPresentationPptx } = await import('@/lib/presentationPptx')
      const bytes = await createPresentationPptx(documentRef.current)
      await window.api.fs.writePresentation(result.filePath, bytes)
      const documentId = documentRef.current.id
      setExportedPaths((paths) => ({ ...paths, [documentId]: result.filePath! }))
      setExportState('saved')
    } catch {
      setExportState('error')
    }
  }

  const previewWidth = compact ? 78 : 126
  const exportedPath = exportedPaths[document.id]
  const insertDialogElement = insertDialog?.elementId
    ? currentSlide?.elements.find((element) => element.id === insertDialog.elementId)
    : undefined
  let insertDialogInitialValue: PresentationInsertDialogValue | null = null
  if (insertDialog?.kind === 'table' && insertDialogElement && isPresentationTableElement(insertDialogElement)) {
    insertDialogInitialValue = {
      kind: 'table',
      rows: insertDialogElement.cells.length,
      columns: Math.max(1, ...insertDialogElement.cells.map((row) => row.length)),
      cells: insertDialogElement.cells.map((row) => [...row]),
    }
  } else if (insertDialog?.kind === 'chart' && insertDialogElement && isPresentationChartElement(insertDialogElement)) {
    insertDialogInitialValue = {
      kind: 'chart',
      chartType: insertDialogElement.chartType,
      title: insertDialogElement.title ?? '',
      categories: [...insertDialogElement.categories],
      series: insertDialogElement.series.map((series) => ({ name: series.name, values: [...series.values] })),
    }
  } else if (insertDialog?.kind === 'link') {
    const hyperlink = insertDialogElement?.hyperlink
    let label = t('session.presentation.link')
    if (insertDialogElement && isPresentationTextElement(insertDialogElement)) label = insertDialogElement.text
    else if (insertDialogElement && isPresentationImageElement(insertDialogElement)) label = insertDialogElement.altText
    insertDialogInitialValue = {
      kind: 'link',
      targetType: hyperlink?.type ?? 'url',
      url: hyperlink?.type === 'url' ? hyperlink.url : 'https://',
      slideId: hyperlink?.type === 'slide' ? hyperlink.slideId : document.slides[0]?.id ?? '',
      label,
      tooltip: hyperlink?.tooltip ?? '',
    }
  } else if (insertDialog?.kind === 'footer') {
    insertDialogInitialValue = {
      kind: 'footer',
      text: currentSlide?.footer?.text ?? '',
      showDate: currentSlide?.footer?.showDate ?? false,
      showSlideNumber: currentSlide?.footer?.showSlideNumber ?? true,
      applyAll: true,
    }
  }
  let exportLabel = t('session.presentation.export')
  if (exportState === 'exporting') exportLabel = t('session.presentation.exporting')
  else if (exportState === 'saved') exportLabel = t('session.presentation.exported')
  else if (exportState === 'error') exportLabel = t('session.presentation.exportFailed')

  const currentSlideIndex = currentSlide
    ? document.slides.findIndex((slide) => slide.id === currentSlide.id)
    : -1
  const transitionPreviewPreviousSlide = currentSlideIndex > 0
    ? document.slides[currentSlideIndex - 1]
    : undefined
  const slideshowTargetIndex = slideshowTransition?.toIndex ?? slideshowIndex
  const slideshowSlide = document.slides[slideshowTargetIndex] ?? currentSlide
  const slideshowTransitionCurrentSlide = slideshowTransition
    ? document.slides[slideshowTransition.toIndex]
    : undefined
  const slideshowTransitionPreviousSlide = slideshowTransition
    ? document.slides[slideshowTransition.fromIndex]
    : undefined
  const slideshowTransitionView = slideshowTransition && slideshowTransitionCurrentSlide && slideshowTransitionPreviousSlide ? {
    ...slideshowTransition,
    currentSlide: slideshowTransitionCurrentSlide,
    previousSlide: slideshowTransitionPreviousSlide,
    transition: normalizePresentationTransition(slideshowTransitionCurrentSlide.transition),
  } : null

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-bg-app text-text-primary"
      data-testid="presentation-workbench-panel"
    >
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border-subtle/70 bg-bg-app px-2 pt-1">
        <div
          role="tablist"
          aria-label={t('session.presentation.documentTabs')}
          className="flex h-full min-w-0 flex-1 items-end gap-1 overflow-x-auto"
          data-testid="presentation-document-tabs"
        >
          {workspace.documents.map((item) => {
            const isActive = item.id === workspace.activeDocumentId
            const fileName = item.title.toLowerCase().endsWith('.pptx')
              ? item.title
              : `${item.title}.pptx`
            return (
              <div
                key={item.id}
                className={cn(
                  'group flex h-8 min-w-[132px] max-w-[220px] shrink-0 items-center rounded-t-lg border px-1 transition-colors',
                  isActive
                    ? 'border-border-subtle border-b-bg-surface bg-bg-surface text-text-primary shadow-[0_-1px_8px_rgba(24,24,35,0.035)]'
                    : 'border-transparent text-text-tertiary hover:bg-bg-hover/80 hover:text-text-secondary',
                )}
              >
                <PresentationControlTooltip content={fileName} placement="bottom">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => selectPresentation(item.id)}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-1 text-left text-xs font-medium"
                    data-testid="presentation-document-tab"
                  >
                    <span className={cn('shrink-0', isActive ? 'text-[#D97706]' : 'text-text-tertiary')}>
                      <PresentationMark />
                    </span>
                    <span className="truncate">{fileName}</span>
                  </button>
                </PresentationControlTooltip>
                <PresentationControlTooltip content={t('session.presentation.closeDocument', { name: fileName })} placement="bottom">
                  <button
                    type="button"
                    aria-label={t('session.presentation.closeDocument', { name: fileName })}
                    disabled={workspace.documents.length <= 1}
                    onClick={() => closePresentation(item.id)}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary opacity-65 hover:bg-bg-hover hover:text-text-primary hover:opacity-100 disabled:cursor-default disabled:opacity-20"
                    data-testid="presentation-close-document"
                  >
                    <X className="size-3" />
                  </button>
                </PresentationControlTooltip>
              </div>
            )
          })}
        </div>
        <HeaderButton label={t('session.presentation.newDocument')} onClick={addPresentation} testId="presentation-add-document">
          <PlusIcon />
        </HeaderButton>
        <HeaderButton
          label={t(expanded ? 'session.presentation.restore' : 'session.presentation.expand')}
          onClick={() => setExpanded(!expanded)}
          pressed={expanded}
          testId="presentation-toggle-expanded"
        >
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </HeaderButton>
        <HeaderButton
          label={t('session.presentation.closePanel')}
          onClick={() => {
            setExpanded(false)
            setRightCollapsed(true)
          }}
          testId="presentation-close-panel"
        >
          <X className="size-4" />
        </HeaderButton>
      </div>

      <PresentationRibbon
        activeTab={ribbonTab}
        animationPaneOpen={inspectorOpen && inspectorMode === 'animation'}
        compact={compact}
        currentSlide={currentSlide}
        filmstripCollapsed={filmstripCollapsed}
        historyStatus={historyStatus}
        inspectorOpen={inspectorOpen && inspectorMode === 'properties'}
        selectedElement={selectedElement}
        selectedText={selectedText}
        toolbarActions={(
          <>
            <HeaderButton
              label={t('asset.common.revealInFileManager')}
              onClick={() => exportedPath && void window.api.shell.showItemInFolder(exportedPath)}
              disabled={!exportedPath}
            >
              <FolderOpen className="size-4" />
            </HeaderButton>
            <button
              type="button"
              disabled={exportState === 'exporting'}
              onClick={() => void exportPresentation()}
              className={cn(
                'h-7 shrink-0 rounded-md bg-brand-purple px-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60',
                exportState === 'error' && 'bg-status-error',
              )}
            >
              {exportLabel}
            </button>
          </>
        )}
        onActiveTabChange={setRibbonTab}
        onAddShape={addShape}
        onAddSlide={addSlide}
        onAddText={addText}
        onApplyTransitionToAll={applyCurrentTransitionToAll}
        onApplyFormat={patchElement}
        onFindText={findText}
        onInsertAudio={() => audioInputRef.current?.click()}
        onInsertChart={() => setInsertDialog({ kind: 'chart' })}
        onInsertFooter={() => setInsertDialog({ kind: 'footer' })}
        onInsertImage={() => imageInputRef.current?.click()}
        onInsertLink={openLinkDialog}
        onInsertTable={() => setInsertDialog({ kind: 'table' })}
        onInsertVideo={() => videoInputRef.current?.click()}
        onMoveElement={moveSelectedElement}
        onPreviewAnimation={previewSelectedAnimation}
        onPreviewTransition={previewTransition}
        onRedo={redo}
        onSlideChange={updateCurrentSlide}
        onStartSlideshow={startSlideshow}
        onStartSlideshowFromBeginning={startSlideshowFromBeginning}
        onToggleAnimationPane={toggleAnimationPane}
        onToggleFilmstrip={() => setFilmstripCollapsed((value) => !value)}
        onToggleInspector={togglePropertiesInspector}
        onUndo={undo}
        onUpdateElement={updateSelectedElement}
      />

      <div className="flex min-h-0 flex-1 bg-[#ECEEF2] dark:bg-[#26272D]">
        <div className="h-full shrink-0">
          <aside
            className={cn(
              'h-full shrink-0 overflow-hidden bg-bg-surface transition-[width,border-color] duration-200 ease-out',
              filmstripCollapsed
                ? 'w-0 border-r border-transparent'
                : cn('border-r border-border-subtle/70', compact ? 'w-[118px]' : 'w-[166px]'),
            )}
            aria-hidden={filmstripCollapsed}
            aria-label={t('session.presentation.thumbnailsAria')}
          >
            {!filmstripCollapsed ? (
              <div className={cn('flex h-full flex-col', compact ? 'w-[118px]' : 'w-[166px]')}>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-3">
                  {document.slides.map((slide, index) => (
                    <button
                      type="button"
                      key={slide.id}
                      onClick={() => selectSlide(slide.id)}
                      className={cn(
                        'group flex items-start gap-1 rounded-lg p-1 text-left transition-colors hover:bg-bg-hover/80',
                        slide.id === currentSlide?.id && 'bg-brand-purple/8',
                      )}
                      aria-label={t('session.presentation.slideAria', { index: index + 1, name: slide.name })}
                    >
                      <span className={cn('w-4 shrink-0 pt-0.5 text-right text-2xs text-text-tertiary', slide.id === currentSlide?.id && 'font-semibold text-brand-purple')}>{index + 1}</span>
                      <PresentationSlidePreview slide={slide} slideNumber={index + 1} width={previewWidth} selected={slide.id === currentSlide?.id} />
                    </button>
                  ))}
                </div>
                <div
                  className="mt-auto grid h-11 shrink-0 grid-cols-3 gap-1 border-t border-border-subtle/60 bg-bg-surface px-2 py-1.5"
                  data-testid="presentation-filmstrip-footer"
                >
                  <MiniButton label={t('session.presentation.newSlide')} onClick={addSlide}><PlusIcon /></MiniButton>
                  <MiniButton label={t('session.presentation.duplicateSlide')} onClick={duplicateSlide}><DuplicateIcon /></MiniButton>
                  <MiniButton label={t('session.presentation.deleteSlide')} onClick={deleteSlide} disabled={document.slides.length <= 1}><TrashIcon /></MiniButton>
                </div>
              </div>
            ) : null}
          </aside>
        </div>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <main ref={stageRef} className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_50%_36%,#F5F6F8_0%,#E4E6EB_78%)] dark:bg-[radial-gradient(circle_at_50%_36%,#35363D_0%,#25262C_82%)]">
              <div
                className="relative shrink-0 overflow-hidden ring-1 ring-black/5 shadow-[0_24px_62px_rgba(30,27,48,0.18),0_3px_12px_rgba(30,27,48,0.1)] dark:ring-white/10"
                style={{ width: PRESENTATION_WIDTH * canvasScale, height: PRESENTATION_HEIGHT * canvasScale }}
              >
                <div className="absolute left-0 top-0 origin-top-left" style={{ width: PRESENTATION_WIDTH, height: PRESENTATION_HEIGHT, transform: `scale(${canvasScale})` }}>
                  <canvas ref={canvasElementRef} aria-label={t('session.presentation.canvasAria')} />
                </div>
                {transitionPreviewRun && currentSlide && transitionPreviewRun.slideId === currentSlide.id ? (
                  <div className="absolute inset-0 z-20">
                    <PresentationTransitionPlayer
                      previous={transitionPreviewPreviousSlide
                        ? <PresentationSlidePreview slide={transitionPreviewPreviousSlide} slideNumber={currentSlideIndex} width={PRESENTATION_WIDTH * canvasScale} selected={false} presentation />
                        : <span className="block size-full bg-black" />}
                      current={<PresentationSlidePreview slide={currentSlide} slideNumber={currentSlideIndex + 1} width={PRESENTATION_WIDTH * canvasScale} selected={false} presentation />}
                      transition={transitionPreviewRun.transition}
                      runKey={transitionPreviewRun.runKey}
                      onComplete={() => setTransitionPreviewRun((run) => run?.runKey === transitionPreviewRun.runKey ? null : run)}
                      className="size-full"
                    />
                  </div>
                ) : null}
              </div>
              {active && canvasGeneration === 0 ? (
                <span className="absolute rounded-full bg-bg-elevated px-3 py-1.5 text-xs text-text-secondary shadow-sm">{t('session.presentation.loadingCanvas')}</span>
              ) : null}
            </main>

            {!compact && inspectorOpen && inspectorMode === 'animation' ? (
              <AnimationInspector selectedElement={selectedElement} onClose={() => setInspectorOpen(false)} onElementChange={updateSelectedElement} />
            ) : null}
            {!compact && inspectorOpen && inspectorMode === 'properties' ? (
              <PresentationInspector
                currentSlide={currentSlide}
                selectedElement={selectedElement}
                onEditElement={(element) => {
                  if (isPresentationTableElement(element) || isPresentationChartElement(element)) {
                    setInsertDialog({ kind: element.type, elementId: element.id })
                  }
                }}
                onElementChange={updateSelectedElement}
                onSlideBackgroundChange={updateSlideBackground}
              />
            ) : null}
          </div>

          <label className={cn('flex shrink-0 items-start gap-2 border-t border-border-subtle/65 bg-bg-surface px-3 py-2', compact ? 'h-11' : 'h-14')}>
            <MessageSquareText className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
            <textarea
              aria-label={t('session.presentation.notes')}
              data-testid="presentation-notes"
              value={currentSlide?.notes ?? ''}
              onInput={updateSlideNotes}
              placeholder={t('session.presentation.notesPlaceholder')}
              className="h-full min-w-0 flex-1 resize-none bg-transparent text-xs leading-relaxed text-text-secondary outline-none placeholder:text-text-tertiary/75"
            />
          </label>

          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border-subtle/65 bg-bg-surface px-2.5 text-[10px] text-text-tertiary">
            <span>{t('session.presentation.pageCount', { current: Math.max(1, document.slides.findIndex((slide) => slide.id === currentSlide?.id) + 1), total: document.slides.length })}</span>
            <div className="flex items-center gap-0.5">
              <StatusButton label={t('session.presentation.normalView')} active><Rows3 className="size-3.5" /></StatusButton>
              <StatusButton label={t('session.presentation.sorterView')} onClick={() => setFilmstripCollapsed(false)}><Grid2X2 className="size-3.5" /></StatusButton>
              <span className="mx-1 h-4 w-px bg-border-subtle" />
              <StatusButton label={t('session.presentation.playFromCurrent')} onClick={startSlideshow}><Play className="size-3.5" /></StatusButton>
              <StatusButton label={t('session.presentation.fitSlide')} onClick={fitCanvas}><MonitorPlay className="size-3.5" /></StatusButton>
              <span className="mx-1 h-4 w-px bg-border-subtle" />
              <StatusButton label={t('session.presentation.zoomOut')} onClick={() => setCanvasScale((value) => Math.max(0.12, value - 0.05))}><ZoomOut className="size-3.5" /></StatusButton>
              <span className="w-9 text-center tabular-nums">{Math.round(canvasScale * 100)}%</span>
              <StatusButton label={t('session.presentation.zoomIn')} onClick={() => setCanvasScale((value) => Math.min(1.25, value + 0.05))}><ZoomIn className="size-3.5" /></StatusButton>
            </div>
          </footer>
        </section>
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/svg+xml"
        className="hidden"
        data-testid="presentation-image-input"
        onChange={(event) => void insertFile('image', event)}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/mp4,audio/ogg"
        className="hidden"
        data-testid="presentation-audio-input"
        onChange={(event) => void insertFile('audio', event)}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime"
        className="hidden"
        data-testid="presentation-video-input"
        onChange={(event) => void insertFile('video', event)}
      />
      <PresentationInsertDialogs
        open={insertDialog?.kind ?? null}
        initialValue={insertDialogInitialValue}
        linkLabelEditable={!insertDialogElement || isPresentationTextElement(insertDialogElement)}
        slides={document.slides.map((slide) => ({ id: slide.id, name: slide.name }))}
        onClose={() => setInsertDialog(null)}
        onSubmit={submitInsertDialog}
      />

      {slideshowOpen && slideshowSlide ? (
        <SlideshowOverlay
          current={slideshowTargetIndex + 1}
          slide={slideshowSlide}
          transitionRun={slideshowTransitionView}
          total={document.slides.length}
          onActivateHyperlink={activateSlideshowHyperlink}
          onClose={() => {
            setSlideshowOpen(false)
            setSlideshowTransition(null)
          }}
          onNext={() => goToSlideshowIndex(slideshowIndex + 1)}
          onPrevious={() => goToSlideshowIndex(slideshowIndex - 1)}
          onTransitionComplete={() => {
            if (!slideshowTransition) return
            setSlideshowIndex(slideshowTransition.toIndex)
            setSlideshowTransition(null)
          }}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">{exportState === 'saved' ? t('session.presentation.exported') : ''}</span>
    </div>
  )
}

function HeaderButton({ children, disabled, label, onClick, pressed, testId }: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
  pressed?: boolean
  testId?: string
}) {
  return (
    <PresentationControlTooltip content={label} placement="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30',
          pressed && 'bg-brand-purple/10 text-brand-purple',
        )}
      >
        {children}
      </button>
    </PresentationControlTooltip>
  )
}

function StatusButton({ children, active, label, onClick = () => undefined }: {
  children: ReactNode
  active?: boolean
  label: string
  onClick?: () => void
}) {
  return (
    <PresentationControlTooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          'flex size-6 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary',
          active && 'bg-bg-selected text-text-secondary',
        )}
      >
        {children}
      </button>
    </PresentationControlTooltip>
  )
}

function SlideshowOverlay({ current, onActivateHyperlink, onClose, onNext, onPrevious, onTransitionComplete, slide, total, transitionRun }: {
  current: number
  onActivateHyperlink: (hyperlink: PresentationHyperlink) => void
  onClose: () => void
  onNext: () => void
  onPrevious: () => void
  onTransitionComplete: () => void
  slide: PresentationSlide
  total: number
  transitionRun: SlideshowTransitionView | null
}) {
  const { t } = useTranslation()
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[#101116]/96 p-4 text-white backdrop-blur-sm" data-testid="presentation-slideshow">
      <div className="flex h-9 shrink-0 items-center justify-between text-xs text-white/65">
        <span>{t('session.presentation.pageCount', { current, total })}</span>
        <button type="button" onClick={onClose} aria-label={t('session.presentation.closeSlideshow')} className="flex size-8 items-center justify-center rounded-full bg-white/10 text-white/75 hover:bg-white/15 hover:text-white"><X className="size-4" /></button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto py-4">
        <div className="relative h-[540px] w-[960px] shrink-0">
          {transitionRun ? (
            <PresentationTransitionPlayer
              previous={<PresentationSlidePreview slide={transitionRun.previousSlide} slideNumber={transitionRun.fromIndex + 1} width={960} selected={false} presentation suppressMediaPlayback onActivateHyperlink={onActivateHyperlink} />}
              current={<PresentationSlidePreview slide={transitionRun.currentSlide} slideNumber={transitionRun.toIndex + 1} width={960} selected={false} presentation suppressMediaPlayback onActivateHyperlink={onActivateHyperlink} />}
              transition={transitionRun.transition}
              runKey={transitionRun.runKey}
              direction={transitionRun.direction}
              onComplete={onTransitionComplete}
              className="size-full"
            />
          ) : <PresentationSlidePreview slide={slide} slideNumber={current} width={960} selected={false} presentation onActivateHyperlink={onActivateHyperlink} />}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center justify-center gap-4">
        <button type="button" disabled={current <= 1 || Boolean(transitionRun)} onClick={onPrevious} aria-label={t('session.presentation.previousSlide')} className="flex size-8 items-center justify-center rounded-full bg-white/10 hover:bg-white/15 disabled:opacity-25"><ChevronLeft className="size-4" /></button>
        <span className="min-w-16 text-center text-xs text-white/70">{current} / {total}</span>
        <button type="button" disabled={current >= total || Boolean(transitionRun)} onClick={onNext} aria-label={t('session.presentation.nextSlide')} className="flex size-8 items-center justify-center rounded-full bg-white/10 hover:bg-white/15 disabled:opacity-25"><ChevronRight className="size-4" /></button>
      </div>
    </div>
  )
}

function AnimationInspector({ onClose, onElementChange, selectedElement }: {
  onClose: () => void
  onElementChange: (patch: Partial<PresentationElement>) => void
  selectedElement: PresentationElement | null
}) {
  const { t } = useTranslation()
  return (
    <aside className="w-[238px] shrink-0 overflow-y-auto border-l border-border-subtle/60 bg-bg-surface/90">
      <div className="flex h-12 items-center justify-between border-b border-border-subtle/60 px-4">
        <h3 className="text-sm font-semibold text-text-primary">{t('session.presentation.animation')}</h3>
        <button type="button" onClick={onClose} aria-label={t('session.presentation.closePane')} className="flex size-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"><X className="size-4" /></button>
      </div>
      <div className="space-y-3 p-4">
        <button
          type="button"
          disabled={!selectedElement}
          onClick={() => onElementChange({ animation: selectedElement?.animation && selectedElement.animation !== 'none' ? selectedElement.animation : 'appear' })}
          className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-[#2678E8] text-sm font-semibold text-white">+</span>
          {t('session.presentation.addAnimation')}
        </button>
        {selectedElement?.animation && selectedElement.animation !== 'none' ? (
          <div className="rounded-lg border border-border-subtle bg-bg-app/60 p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-text-secondary">
              <span>{t('session.presentation.animationEffect')}</span>
              <span className="font-medium text-brand-purple">{selectedElement.animation}</span>
            </div>
            <label className="mt-3 flex items-center justify-between gap-2 text-xs text-text-secondary">
              {t('session.presentation.duration')}
              <input
                type="number"
                min={0.18}
                step={0.1}
                value={Number(((selectedElement.animationDuration ?? 520) / 1000).toFixed(2))}
                onChange={(event) => onElementChange({ animationDuration: Math.round(Math.max(0.18, Number(event.target.value) || 0.18) * 1000) })}
                className="h-7 w-20 rounded-md border border-border-default bg-bg-surface px-2 text-right text-xs outline-none focus:border-brand-purple"
              />
            </label>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-text-tertiary">{t('session.presentation.selectElementForAnimation')}</p>
        )}
      </div>
    </aside>
  )
}

function PresentationInspector({
  currentSlide,
  selectedElement,
  onEditElement,
  onElementChange,
  onSlideBackgroundChange,
}: {
  currentSlide: PresentationSlide | undefined
  selectedElement: PresentationElement | null
  onEditElement: (element: PresentationElement) => void
  onElementChange: (patch: Partial<PresentationElement>) => void
  onSlideBackgroundChange: (event: ChangeEvent<HTMLInputElement>) => void
}) {
  const { t } = useTranslation()
  return (
    <aside className="w-[214px] shrink-0 overflow-y-auto border-l border-border-subtle/60 bg-bg-surface/85 p-3">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('session.presentation.properties')}
      </h3>
      {selectedElement ? (
        <div className="space-y-3">
          {isPresentationTextElement(selectedElement) ? (
            <ColorField
              label={t('session.presentation.textColor')}
              value={selectedElement.color}
              onChange={(value) => onElementChange({ color: value })}
            />
          ) : null}
          {isPresentationShapeElement(selectedElement) ? (
            <ColorField
              label={t('session.presentation.fill')}
              value={selectedElement.fill}
              onChange={(value) => onElementChange({ fill: value })}
            />
          ) : null}
          {isPresentationTextElement(selectedElement) ? (
            <div className="grid grid-cols-[1fr_72px] gap-2">
              <label className="block min-w-0 text-2xs font-medium text-text-tertiary">
                {t('session.presentation.fontFamily')}
                <select
                  value={selectedElement.fontFamily}
                  onChange={(event) => onElementChange({ fontFamily: event.target.value })}
                  className="mt-1 h-7 w-full rounded-md border border-border-default bg-bg-app px-1.5 text-xs text-text-primary outline-none focus:border-brand-purple"
                >
                  <option value="Aptos">Aptos</option>
                  <option value="Aptos Display">Aptos Display</option>
                  <option value="Arial">Arial</option>
                  <option value="Helvetica">Helvetica</option>
                  <option value="Georgia">Georgia</option>
                  <option value="Times New Roman">Times New Roman</option>
                  <option value="Courier New">Courier New</option>
                </select>
              </label>
              <PresentationNumberField
                label={t('session.presentation.fontSize')}
                value={selectedElement.fontSize}
                min={8}
                onChange={(value) => onElementChange({ fontSize: value })}
              />
            </div>
          ) : null}
          {isPresentationImageElement(selectedElement) ? (
            <div className="space-y-2">
              <label className="block text-2xs font-medium text-text-tertiary">
                {t('session.presentation.insertDialog.imageFit')}
                <select
                  value={selectedElement.fit}
                  onChange={(event) => onElementChange({ fit: event.target.value as PresentationImageElement['fit'] } as Partial<PresentationImageElement>)}
                  className="mt-1 h-7 w-full rounded-md border border-border-default bg-bg-app px-1.5 text-xs text-text-primary outline-none focus:border-brand-purple"
                >
                  <option value="contain">{t('session.presentation.insertDialog.contain')}</option>
                  <option value="cover">{t('session.presentation.insertDialog.cover')}</option>
                </select>
              </label>
              <label className="block text-2xs font-medium text-text-tertiary">
                {t('session.presentation.insertDialog.imageAltText')}
                <input
                  value={selectedElement.altText}
                  onChange={(event) => onElementChange({ altText: event.target.value } as Partial<PresentationImageElement>)}
                  className="mt-1 h-7 w-full rounded-md border border-border-default bg-bg-app px-2 text-xs text-text-primary outline-none focus:border-brand-purple"
                />
              </label>
            </div>
          ) : null}
          {isPresentationMediaElement(selectedElement) ? (
            <div className="space-y-2 rounded-md border border-border-subtle bg-bg-app/55 p-2">
              <InspectorCheckbox
                checked={selectedElement.autoplay}
                label={t('session.presentation.insertDialog.autoplay')}
                onChange={(checked) => onElementChange({ autoplay: checked } as Partial<PresentationMediaElement>)}
              />
              <InspectorCheckbox
                checked={selectedElement.loop}
                label={t('session.presentation.insertDialog.loop')}
                onChange={(checked) => onElementChange({ loop: checked } as Partial<PresentationMediaElement>)}
              />
              <InspectorCheckbox
                checked={selectedElement.muted}
                label={t('session.presentation.insertDialog.muted')}
                onChange={(checked) => onElementChange({ muted: checked } as Partial<PresentationMediaElement>)}
              />
              <p className="text-[10px] leading-4 text-text-tertiary">
                {t('session.presentation.insertDialog.playbackSettingsAppOnly')}
              </p>
            </div>
          ) : null}
          {isPresentationTableElement(selectedElement) ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <ColorField label={t('session.presentation.insertDialog.headerFill')} value={selectedElement.headerFill} onChange={(value) => onElementChange({ headerFill: value } as Partial<PresentationTableElement>)} />
                <ColorField label={t('session.presentation.insertDialog.bodyFill')} value={selectedElement.bodyFill} onChange={(value) => onElementChange({ bodyFill: value } as Partial<PresentationTableElement>)} />
              </div>
              <button type="button" onClick={() => onEditElement(selectedElement)} className="h-8 w-full rounded-md border border-border-default text-xs font-medium text-text-secondary hover:bg-bg-hover">
                {t('session.presentation.insertDialog.editData')}
              </button>
            </div>
          ) : null}
          {isPresentationChartElement(selectedElement) ? (
            <div className="space-y-2">
              <InspectorCheckbox
                checked={selectedElement.showLegend}
                label={t('session.presentation.insertDialog.showLegend')}
                onChange={(checked) => onElementChange({ showLegend: checked } as Partial<typeof selectedElement>)}
              />
              <button type="button" onClick={() => onEditElement(selectedElement)} className="h-8 w-full rounded-md border border-border-default text-xs font-medium text-text-secondary hover:bg-bg-hover">
                {t('session.presentation.insertDialog.editData')}
              </button>
            </div>
          ) : null}
          {selectedElement.hyperlink ? (
            <button
              type="button"
              onClick={() => onElementChange({ hyperlink: undefined })}
              className="h-8 w-full rounded-md border border-border-default text-xs font-medium text-text-secondary hover:bg-bg-hover"
            >
              {t('session.presentation.insertDialog.removeLink')}
            </button>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <PresentationNumberField label="X" value={selectedElement.x} onChange={(value) => onElementChange({ x: value })} />
            <PresentationNumberField label="Y" value={selectedElement.y} onChange={(value) => onElementChange({ y: value })} />
            <PresentationNumberField label={t('session.presentation.width')} value={selectedElement.width} min={8} onChange={(value) => onElementChange({ width: value })} />
            <PresentationNumberField label={t('session.presentation.height')} value={selectedElement.height} min={8} onChange={(value) => onElementChange({ height: value })} />
          </div>
          {!isPresentationRotationLocked(selectedElement) ? (
            <PresentationNumberField
              label={t('session.presentation.rotation')}
              value={selectedElement.rotation}
              onChange={(value) => onElementChange({ rotation: value })}
            />
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-text-tertiary">
            {t('session.presentation.noSelection')}
          </p>
          {currentSlide ? (
            <label className="flex items-center justify-between gap-3 text-xs text-text-secondary">
              {t('session.presentation.slideBackground')}
              <input
                type="color"
                className="h-7 w-10 cursor-pointer rounded border border-border-default bg-transparent p-0.5"
                value={currentSlide.background}
                onChange={onSlideBackgroundChange}
              />
            </label>
          ) : null}
        </div>
      )}
    </aside>
  )
}

function MiniButton({ children, disabled, label, onClick }: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <PresentationControlTooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex h-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30"
      >
        {children}
      </button>
    </PresentationControlTooltip>
  )
}

function PresentationControlTooltip({ children, content, placement = 'auto' }: { children: ReactElement; content: ReactNode; placement?: 'auto' | 'bottom' }) {
  return <Tooltip appearance="presentation" content={content} delayMs={0} placement={placement}>{children}</Tooltip>
}

function InspectorCheckbox({ checked, label, onChange }: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-secondary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-brand-purple"
      />
      {label}
    </label>
  )
}

export function PresentationNumberField({ label, min, value, onChange }: {
  label: string
  min?: number
  value: number
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(Math.round(value)))
  const focusedRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(Math.round(value)))
  }, [value])

  const commitDraft = () => {
    focusedRef.current = false
    const next = resolvePresentationNumberFieldValue(draft, min, value)
    setDraft(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <label className="block text-2xs font-medium text-text-tertiary">
      {label}
      <input
        type="number"
        min={min}
        value={draft}
        onFocus={() => {
          focusedRef.current = true
        }}
        onChange={(event) => {
          const raw = event.target.value
          setDraft(raw)
          if (!raw.trim()) return
          const next = Number(raw)
          if (Number.isFinite(next) && (min === undefined || next >= min)) onChange(next)
        }}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        className="mt-1 h-7 w-full rounded-md border border-border-default bg-bg-app px-2 text-xs text-text-primary outline-none focus:border-brand-purple"
      />
    </label>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-text-secondary">
      {label}
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-10 cursor-pointer rounded border border-border-default bg-transparent p-0.5"
      />
    </label>
  )
}

function PresentationMark() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" /><path d="M5 14h6M8 11.5V14M4.5 5.2h5M4.5 7.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
}

function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
}

function DuplicateIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="3" width="8" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.3" /><path d="M3 5v7a2 2 0 002 2h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
}

function TrashIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3.5 5h9M6 3h4M5 5l.5 8h5l.5-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
