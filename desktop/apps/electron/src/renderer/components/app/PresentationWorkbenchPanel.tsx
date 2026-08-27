import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type {
  Canvas as FabricCanvas,
  FabricImage,
  FabricObject,
  Group as FabricGroup,
  Point as FabricPoint,
} from 'fabric'
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
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  PRESENTATION_PAGE_SIZES,
  createBlankPresentationDocument,
  createBlankPresentationSlide,
  createPresentationId,
  currentPresentationDocumentAtom,
  currentPresentationWorkspaceAtom,
  formatPresentationText,
  getPresentationPageSize,
  presentationExpandedAtom,
  stripPresentationListMarkers,
  type PresentationAnimationEffect,
  type PresentationComment,
  type PresentationDocument,
  type PresentationElement,
  type PresentationFileSource,
  type PresentationHyperlink,
  type PresentationImageElement,
  type PresentationMediaElement,
  type PresentationMaster,
  type PresentationPageSize,
  type PresentationPageSizePreset,
  type PresentationShapeElement,
  type PresentationShapeType,
  type PresentationSlide,
  type PresentationSlideLayout,
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
  buildPresentationAnimationPlaybackSteps,
  getPresentationAnimationHiddenElementIds,
} from '@/lib/presentationAnimationPreview'
import {
  clearPresentationAnimation,
  copyPresentationAnimationPatch,
  hasPresentationAnimation,
  normalizePresentationAnimation,
  presentationAnimationLabelKeys,
} from '@/lib/presentationAnimations'
import {
  clearPresentationCanvasPreservingSelection,
  restorePresentationSelectionState,
} from '@/lib/presentationCanvasSelection'
import {
  presentationRenderingFontFamily,
  shouldSplitPresentationTextByGrapheme,
} from '@/lib/presentationText'
import {
  detachPresentationElementsOutsideGroups,
  getPresentationAnimationOwner,
  getPresentationAnimationTargets,
  getPresentationElementBounds,
  getPresentationElementGroup,
  getPresentationSelectionElements,
  getPresentationElementTargets,
  isPresentationAnimationPatch,
  removePresentationElements,
  resolvePresentationCanvasSelectionScope,
} from '@/lib/presentationGroups'
import {
  compactLegacyPresentationAudioElement,
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
import { importPresentationPptx } from '@/lib/presentationPptxImport'
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
import { PresentationAnimationPlayer } from './PresentationAnimationPlayer'
import {
  PresentationRibbon,
  type PresentationElementAlignment,
  type PresentationRibbonTab,
  type PresentationViewOptions,
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

interface AnimationPreviewRun {
  elementIds?: string[]
  runKey: number
  slide: PresentationSlide
  slideNumber: number
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

interface PresentationMediaFabricView {
  buttonCenter: FabricPoint
  buttonHitRadius: number
  pauseGlyphs: [FabricObject, FabricObject]
  playGlyph: FabricObject
  root: FabricGroup
  videoFrame: FabricImage | null
}

const presentationMediaFabricViews = new WeakMap<FabricObject, PresentationMediaFabricView>()

function createFixedMediaGroup(fabric: FabricModule, element: PresentationMediaElement, objects: FabricObject[]): FabricGroup {
  const radius = element.type === 'audio'
    ? Math.min(element.width, element.height) / 2
    : Math.min(12, element.height * 0.08)
  const [background, ...decorations] = objects
  const group = new fabric.Group(background ? [background] : [], {
    left: 0,
    top: 0,
    width: element.width,
    height: element.height,
    originX: 'left',
    originY: 'top',
    strokeWidth: 0,
    lockSkewingX: true,
    lockSkewingY: true,
    layoutManager: new fabric.LayoutManager(new fabric.FixedLayout()),
    clipPath: new fabric.Rect({
      width: element.width,
      height: element.height,
      rx: radius,
      ry: radius,
      originX: 'center',
      originY: 'center',
    }),
  })
  if (decorations.length > 0) group.add(...decorations)
  group.set({
    left: element.x,
    top: element.y,
    angle: isPresentationRotationLocked(element) ? 0 : element.rotation,
  })
  group.setCoords()
  return group
}

function createMediaPlaybackButton(
  fabric: FabricModule,
  centerX: number,
  centerY: number,
  size: number,
  background: string,
  foreground: string,
): { objects: FabricObject[]; pauseGlyphs: [FabricObject, FabricObject]; playGlyph: FabricObject } {
  const circle = new fabric.Circle({
    left: centerX,
    top: centerY,
    radius: size / 2,
    originX: 'center',
    originY: 'center',
    fill: background,
    stroke: 'rgba(255,255,255,0.38)',
    strokeWidth: 1,
    selectable: false,
    evented: false,
  })
  const playGlyph = new fabric.Triangle({
    left: centerX + (size * 0.035),
    top: centerY,
    width: size * 0.32,
    height: size * 0.36,
    originX: 'center',
    originY: 'center',
    angle: 90,
    fill: foreground,
    strokeWidth: 0,
    selectable: false,
    evented: false,
  })
  const pauseWidth = Math.max(1.5, size * 0.105)
  const pauseHeight = size * 0.34
  const pauseOffset = size * 0.105
  const createPauseGlyph = (offset: number) => new fabric.Rect({
    left: centerX + offset,
    top: centerY,
    width: pauseWidth,
    height: pauseHeight,
    rx: pauseWidth / 2,
    ry: pauseWidth / 2,
    originX: 'center',
    originY: 'center',
    fill: foreground,
    strokeWidth: 0,
    visible: false,
    selectable: false,
    evented: false,
  })
  const pauseGlyphs: [FabricObject, FabricObject] = [
    createPauseGlyph(-pauseOffset),
    createPauseGlyph(pauseOffset),
  ]
  return { objects: [circle, playGlyph, ...pauseGlyphs], pauseGlyphs, playGlyph }
}

function createAudioFabricObject(fabric: FabricModule, element: PresentationMediaElement): FabricObject {
  const width = element.width
  const height = element.height
  const buttonSize = Math.max(4, Math.min(48, Math.min(width, height) - 12))
  const buttonCenterX = width / 2
  const buttonCenterY = height / 2
  const playbackButton = createMediaPlaybackButton(
    fabric,
    buttonCenterX,
    buttonCenterY,
    buttonSize,
    '#705BE5',
    '#FFFFFF',
  )
  const objects: FabricObject[] = [
    new fabric.Rect({
      left: 0.5,
      top: 0.5,
      width: Math.max(1, width - 1),
      height: Math.max(1, height - 1),
      originX: 'left',
      originY: 'top',
      rx: Math.min(width, height) / 2,
      ry: Math.min(width, height) / 2,
      fill: '#F4F1FF',
      stroke: '#BEB4F1',
      strokeWidth: 1,
    }),
    ...playbackButton.objects,
  ]
  const root = createFixedMediaGroup(fabric, element, objects)
  presentationMediaFabricViews.set(root, {
    buttonCenter: new fabric.Point(buttonCenterX - (width / 2), buttonCenterY - (height / 2)),
    buttonHitRadius: Math.max(buttonSize / 2, 4),
    pauseGlyphs: playbackButton.pauseGlyphs,
    playGlyph: playbackButton.playGlyph,
    root,
    videoFrame: null,
  })
  return root
}

function createVideoFabricObject(fabric: FabricModule, element: PresentationMediaElement): FabricObject {
  const width = element.width
  const height = element.height
  const radius = Math.min(12, height * 0.08)
  const buttonSize = Math.max(4, Math.min(64, Math.min(width, height) * 0.2))
  const playbackButton = createMediaPlaybackButton(
    fabric,
    width / 2,
    height / 2,
    buttonSize,
    'rgba(16,17,25,0.68)',
    '#FFFFFF',
  )
  const objects: FabricObject[] = [
    new fabric.Rect({
      left: 0,
      top: 0,
      width,
      height,
      originX: 'left',
      originY: 'top',
      rx: radius,
      ry: radius,
      fill: '#171923',
      strokeWidth: 0,
    }),
    new fabric.Rect({
      left: 0.5,
      top: 0.5,
      width: Math.max(1, width - 1),
      height: Math.max(1, height - 1),
      originX: 'left',
      originY: 'top',
      rx: radius,
      ry: radius,
      fill: 'rgba(0,0,0,0)',
      stroke: 'rgba(132,112,237,0.72)',
      strokeWidth: 1,
    }),
    ...playbackButton.objects,
  ]
  const root = createFixedMediaGroup(fabric, element, objects)
  presentationMediaFabricViews.set(root, {
    buttonCenter: new fabric.Point(0, 0),
    buttonHitRadius: Math.max((buttonSize / 2) * 1.3, 4),
    pauseGlyphs: playbackButton.pauseGlyphs,
    playGlyph: playbackButton.playGlyph,
    root,
    videoFrame: null,
  })
  return root
}

export function createPresentationMediaFabricObject(fabric: FabricModule, element: PresentationMediaElement): FabricObject {
  return element.type === 'audio'
    ? createAudioFabricObject(fabric, element)
    : createVideoFabricObject(fabric, element)
}

interface PresentationMediaRegistration {
  element: PresentationMediaElement
  object: FabricObject
  view: PresentationMediaFabricView
}

interface PresentationMediaSession {
  dispose: () => void
  pause: () => void
  start: () => void
  toggle: () => Promise<void>
}

export interface PresentationMediaRuntime {
  cursorFromCanvas: (object: FabricObject, scenePoint: FabricPoint) => 'pointer' | null
  dispose: () => void
  pause: (elementId: string) => void
  pauseAll: () => void
  prepare: (elementId: string) => void
  register: (element: PresentationMediaElement, object: FabricObject) => void
  releaseAll: () => void
  reset: () => void
  toggle: (elementId: string) => Promise<void>
  toggleFromCanvas: (object: FabricObject, scenePoint: FabricPoint) => boolean
}

/** Runtime-only playback state for media drawn inside the Fabric canvas. */
export function createPresentationMediaRuntime(fabric: FabricModule, canvas: FabricCanvas): PresentationMediaRuntime {
  const registrations = new Map<string, PresentationMediaRegistration>()
  const registrationIds = new WeakMap<FabricObject, string>()
  const sessions = new Map<string, PresentationMediaSession>()
  let runtimeDisposed = false

  const setViewPlaying = (view: PresentationMediaFabricView, playing: boolean) => {
    view.playGlyph.set({ visible: !playing })
    for (const glyph of view.pauseGlyphs) glyph.set({ visible: playing })
    view.root.dirty = true
    if (view.root.canvas === canvas) canvas.requestRenderAll()
  }

  const pauseAllExcept = (elementId?: string) => {
    for (const [id, session] of [...sessions]) {
      if (id === elementId) continue
      if (registrations.get(id)?.element.type === 'audio') {
        sessions.delete(id)
        session.dispose()
      } else {
        session.pause()
      }
    }
  }

  const disposeAll = () => {
    for (const [id, session] of [...sessions]) {
      sessions.delete(id)
      session.dispose()
    }
  }

  const createSession = (registration: PresentationMediaRegistration): PresentationMediaSession => {
    const { element, view } = registration
    const media = document.createElement(element.type)
    let disposed = false
    let playing = false
    let starting = false
    let playAttempt = 0
    let videoFrameCallback: number | null = null
    let animationFrame: number | null = null

    const markVideoFrameDirty = () => {
      if (disposed || view.root.canvas !== canvas) return
      view.root.dirty = true
      if (view.videoFrame) view.videoFrame.dirty = true
      canvas.renderAll()
    }

    const cancelFrameRefresh = () => {
      if (videoFrameCallback !== null && media instanceof HTMLVideoElement) {
        media.cancelVideoFrameCallback(videoFrameCallback)
        videoFrameCallback = null
      }
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
        animationFrame = null
      }
    }

    const scheduleFrameRefresh = () => {
      if (
        disposed
        || !(media instanceof HTMLVideoElement)
        || media.paused
        || media.ended
        || videoFrameCallback !== null
        || animationFrame !== null
      ) return
      if (typeof media.requestVideoFrameCallback === 'function') {
        videoFrameCallback = media.requestVideoFrameCallback(() => {
          videoFrameCallback = null
          markVideoFrameDirty()
          scheduleFrameRefresh()
        })
        return
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null
        markVideoFrameDirty()
        scheduleFrameRefresh()
      })
    }

    const updatePlaying = (next: boolean) => {
      playing = next
      if (!next) starting = false
      setViewPlaying(view, next)
      if (next) scheduleFrameRefresh()
      else cancelFrameRefresh()
    }

    const removeVideoFrame = () => {
      const frame = view.videoFrame
      if (!frame) return
      view.videoFrame = null
      if (frame.group === view.root) view.root.remove(frame)
      frame.dispose()
      view.root.dirty = true
      if (view.root.canvas === canvas) canvas.requestRenderAll()
    }

    const attachVideoFrame = () => {
      if (disposed || !(media instanceof HTMLVideoElement) || view.videoFrame) return
      const sourceWidth = Math.max(0, media.videoWidth)
      const sourceHeight = Math.max(0, media.videoHeight)
      if (!sourceWidth || !sourceHeight) return
      media.width = sourceWidth
      media.height = sourceHeight
      const frameWidth = registration.element.width
      const frameHeight = registration.element.height
      const scale = Math.max(frameWidth / sourceWidth, frameHeight / sourceHeight)
      const cropWidth = frameWidth / scale
      const cropHeight = frameHeight / scale
      const frame = new fabric.FabricImage(media, {
        left: 0,
        top: 0,
        width: cropWidth,
        height: cropHeight,
        cropX: Math.max(0, (sourceWidth - cropWidth) / 2),
        cropY: Math.max(0, (sourceHeight - cropHeight) / 2),
        scaleX: scale,
        scaleY: scale,
        originX: 'left',
        originY: 'top',
        selectable: false,
        evented: false,
        objectCaching: false,
      })
      view.videoFrame = frame
      view.root.insertAt(1, frame)
      frame.set({
        left: -(frameWidth / 2),
        top: -(frameHeight / 2),
      })
      frame.setCoords()
      view.root.dirty = true
      if (view.root.canvas === canvas) canvas.requestRenderAll()
    }

    const onPlay = () => {
      if (!media.paused) updatePlaying(true)
    }
    const onPause = () => {
      if (media.paused) updatePlaying(false)
    }
    const onEnded = () => updatePlaying(false)
    const onLoadedData = () => attachVideoFrame()
    const onSeeked = () => {
      view.root.dirty = true
      if (view.videoFrame) view.videoFrame.dirty = true
      if (view.root.canvas === canvas) canvas.requestRenderAll()
    }
    let session: PresentationMediaSession
    const onError = () => {
      if (disposed) return
      session.dispose()
      if (sessions.get(element.id) === session) sessions.delete(element.id)
    }

    const dispose = () => {
      if (disposed) return
      disposed = true
      playAttempt += 1
      starting = false
      playing = false
      cancelFrameRefresh()
      media.removeEventListener('play', onPlay)
      media.removeEventListener('pause', onPause)
      media.removeEventListener('ended', onEnded)
      media.removeEventListener('error', onError)
      media.removeEventListener('loadeddata', onLoadedData)
      media.removeEventListener('seeked', onSeeked)
      try {
        media.pause()
      } catch {
        // The source may already have been detached by the browser.
      }
      media.removeAttribute('src')
      try {
        media.load()
      } catch {
        // A disposed media element does not need to be reloaded.
      }
      removeVideoFrame()
      setViewPlaying(view, false)
    }

    const pause = () => {
      if (disposed) return
      playAttempt += 1
      starting = false
      try {
        media.pause()
      } finally {
        updatePlaying(false)
      }
    }

    const toggle = async () => {
      if (disposed) return
      if (playing || starting || !media.paused) {
        pause()
        return
      }
      const attempt = ++playAttempt
      starting = true
      setViewPlaying(view, true)
      try {
        await media.play()
        if (disposed || attempt !== playAttempt) return
        if (!media.paused) {
          starting = false
          updatePlaying(true)
        } else {
          updatePlaying(false)
        }
      } catch {
        if (!disposed && attempt === playAttempt) updatePlaying(false)
      }
    }

    const start = () => {
      if (disposed) return
      media.autoplay = false
      media.controls = false
      media.loop = element.loop
      media.muted = element.muted
      media.preload = element.type === 'video' ? 'auto' : 'metadata'
      if (media instanceof HTMLVideoElement) media.playsInline = true
      media.addEventListener('play', onPlay)
      media.addEventListener('pause', onPause)
      media.addEventListener('ended', onEnded)
      media.addEventListener('error', onError)
      media.addEventListener('loadeddata', onLoadedData)
      media.addEventListener('seeked', onSeeked)
      media.src = element.source.dataUrl
      try {
        media.load()
      } catch {
        onError()
        return
      }
      if (media instanceof HTMLVideoElement && media.readyState >= 2) attachVideoFrame()
    }

    session = { dispose, pause, start, toggle }
    return session
  }

  const ensureSession = (elementId: string): PresentationMediaSession | null => {
    const existing = sessions.get(elementId)
    if (existing) return existing
    const registration = registrations.get(elementId)
    if (!registration || runtimeDisposed) return null
    const session = createSession(registration)
    sessions.set(elementId, session)
    session.start()
    return sessions.get(elementId) === session ? session : null
  }

  const isPlaybackTarget = (object: FabricObject, scenePoint: FabricPoint) => {
    const elementId = registrationIds.get(object)
    const view = presentationMediaFabricViews.get(object)
    if (!elementId || !view || !registrations.has(elementId)) return null
    const localPoint = scenePoint.transform(fabric.util.invertTransform(object.calcTransformMatrix()))
    const distance = Math.hypot(
      localPoint.x - view.buttonCenter.x,
      localPoint.y - view.buttonCenter.y,
    )
    return distance <= view.buttonHitRadius
  }

  const runtime: PresentationMediaRuntime = {
    cursorFromCanvas(object, scenePoint) {
      const playbackTarget = isPlaybackTarget(object, scenePoint)
      return playbackTarget ? 'pointer' : null
    },
    dispose() {
      if (runtimeDisposed) return
      runtime.reset()
      runtimeDisposed = true
    },
    pause(elementId) {
      sessions.get(elementId)?.pause()
    },
    pauseAll() {
      pauseAllExcept()
    },
    prepare(elementId) {
      if (registrations.get(elementId)?.element.type === 'video') ensureSession(elementId)
    },
    register(element, object) {
      if (runtimeDisposed) return
      const view = presentationMediaFabricViews.get(object)
      if (!view) return
      sessions.get(element.id)?.dispose()
      sessions.delete(element.id)
      registrations.set(element.id, { element, object, view })
      registrationIds.set(object, element.id)
      setViewPlaying(view, false)
    },
    releaseAll() {
      disposeAll()
    },
    reset() {
      disposeAll()
      registrations.clear()
    },
    async toggle(elementId) {
      const session = ensureSession(elementId)
      if (!session) return
      pauseAllExcept(elementId)
      await session.toggle()
    },
    toggleFromCanvas(object, scenePoint) {
      const elementId = registrationIds.get(object)
      if (!elementId || !isPlaybackTarget(object, scenePoint)) return false
      void runtime.toggle(elementId)
      return true
    },
  }

  return runtime
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
      opacity: element.opacity ?? 1,
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
      opacity: element.opacity ?? 1,
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
    opacity: element.opacity ?? 1,
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
  placeholderText?: string,
): Promise<FabricObject> {
  if (isPresentationTextElement(element)) {
    const insets = element.textInsets ?? { left: 0, top: 0, right: 0, bottom: 0 }
    const text = formatPresentationText(element)
    const editorText = text || placeholderText || ''
    let textFill = element.color
    if (element.hyperlink) textFill = '#2563EB'
    if (placeholderText) textFill = '#777483'
    const textOptions = {
      left: element.x + insets.left,
      top: element.y + insets.top,
      angle: element.rotation,
      originX: 'left',
      originY: 'top',
      fill: textFill,
      fontFamily: presentationRenderingFontFamily(element.fontFamily, editorText),
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
      opacity: element.opacity ?? 1,
      shadow: element.shadow ? new fabric.Shadow({ color: 'rgba(20, 20, 32, 0.28)', blur: 12, offsetX: 6, offsetY: 6 }) : undefined,
      splitByGrapheme: shouldSplitPresentationTextByGrapheme(editorText, element.wordWrap !== false),
    } as const
    const textbox = element.wordWrap === false
      ? new fabric.IText(editorText, textOptions)
      : new fabric.Textbox(editorText, {
          ...textOptions,
          width: Math.max(1, element.width - insets.left - insets.right),
        })
    if (element.baseline === 'superscript') textbox.setSuperscript(0, textbox.text.length)
    if (element.baseline === 'subscript') textbox.setSubscript(0, textbox.text.length)
    if (element.verticalAlign && element.verticalAlign !== 'top') {
      const freeHeight = Math.max(0, element.height - (textbox.height ?? 0))
      textbox.set({ top: element.y + (element.verticalAlign === 'middle' ? freeHeight / 2 : freeHeight) })
    }
    const placeholderTextbox = textbox as FabricObject & {
      presentationPlaceholderText?: string
      presentationPlaceholderVisible?: boolean
      text: string
    }
    if (placeholderText) {
      placeholderTextbox.presentationPlaceholderText = placeholderText
      placeholderTextbox.presentationPlaceholderVisible = true
      textbox.on('editing:entered', () => {
        if (!placeholderTextbox.presentationPlaceholderVisible) return
        placeholderTextbox.presentationPlaceholderVisible = false
        textbox.set({ fill: element.hyperlink ? '#2563EB' : element.color, text: '' })
        textbox.canvas?.requestRenderAll()
      })
    }
    textbox.on('editing:exited', () => {
      onTextEdit(textbox)
      if (!placeholderText || textbox.text.trim()) return
      placeholderTextbox.presentationPlaceholderVisible = true
      textbox.set({ fill: '#777483', text: placeholderText })
      textbox.canvas?.requestRenderAll()
    })
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
      const crop = element.crop
      const visibleWidth = crop ? Math.max(0.001, 1 - crop.left - crop.right) : 1
      const visibleHeight = crop ? Math.max(0.001, 1 - crop.top - crop.bottom) : 1
      if (crop) {
        const cropWidth = naturalWidth * visibleWidth
        const cropHeight = naturalHeight * visibleHeight
        image.set({
          left: 0,
          top: 0,
          width: cropWidth,
          height: cropHeight,
          cropX: naturalWidth * crop.left,
          cropY: naturalHeight * crop.top,
          scaleX: element.width / cropWidth,
          scaleY: element.height / cropHeight,
        })
      } else if (element.fit === 'cover') {
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
        opacity: element.opacity ?? 1,
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
      return createPresentationMediaFabricObject(fabric, fallback)
    }
  }
  if (isPresentationMediaElement(element)) return createPresentationMediaFabricObject(fabric, element)
  if (isPresentationTableElement(element)) return createTableFabricObject(fabric, element)
  if (isPresentationChartElement(element)) return createChartFabricObject(fabric, element)
  throw new Error(`Unsupported presentation element: ${(element as { type?: string }).type ?? 'unknown'}`)
}

function createFooterFabricObjects(fabric: FabricModule, slide: PresentationSlide, slideNumber: number, pageSize: PresentationPageSize): FabricObject[] {
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
  const footerTop = pageSize.height - 34
  if (slide.footer.text) objects.push(new fabric.Text(slide.footer.text, { ...style, left: 32, top: footerTop }))
  if (slide.footer.showDate) {
    objects.push(new fabric.Text(new Intl.DateTimeFormat().format(new Date()), {
      ...style,
      left: pageSize.width / 2,
      top: footerTop,
      originX: 'center',
    }))
  }
  if (slide.footer.showSlideNumber) {
    objects.push(new fabric.Text(String(slideNumber), {
      ...style,
      left: pageSize.width - 32,
      top: footerTop,
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
  const pageSize = getPresentationPageSize(document)
  const [expanded, setExpanded] = useAtom(presentationExpandedAtom)
  const setRightCollapsed = useSetAtom(setRightPanelCollapsedAtom)
  const requestExternalLink = useSetAtom(requestExternalLinkAtom)
  const showToast = useSetAtom(showToastAtom)
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [canvasGeneration, setCanvasGeneration] = useState(0)
  const [canvasScale, setCanvasScale] = useState(0.4)
  const [compact, setCompact] = useState(true)
  const [ribbonCollapsed, setRibbonCollapsed] = useState(false)
  const [viewOptions, setViewOptions] = useState<PresentationViewOptions>({
    gridlines: false,
    guides: false,
    notes: true,
    ruler: false,
    smartSnap: true,
  })
  const [animationMarkersHidden, setAnimationMarkersHidden] = useState(false)
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [exportedPaths, setExportedPaths] = useState<Record<string, string>>({})
  const [inspectorMode, setInspectorMode] = useState<'animation' | 'comments' | 'layers' | 'properties'>('properties')
  const [ribbonTab, setRibbonTab] = useState<PresentationRibbonTab>('home')
  const [slideshowOpen, setSlideshowOpen] = useState(false)
  const [slideshowIndex, setSlideshowIndex] = useState(0)
  const [slideshowTransition, setSlideshowTransition] = useState<SlideshowTransitionRun | null>(null)
  const [animationPreviewRun, setAnimationPreviewRun] = useState<AnimationPreviewRun | null>(null)
  const [transitionPreviewRun, setTransitionPreviewRun] = useState<TransitionPreviewRun | null>(null)
  const [historyStatus, setHistoryStatus] = useState({ canUndo: false, canRedo: false })
  const [exportState, setExportState] = useState<ExportState>('idle')
  const [insertDialog, setInsertDialog] = useState<PresentationInsertDialogState | null>(null)
  const [masterDialogOpen, setMasterDialogOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasElementRef = useRef<HTMLCanvasElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const presentationInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<FabricCanvas | null>(null)
  const fabricModuleRef = useRef<typeof import('fabric') | null>(null)
  const mediaRuntimeRef = useRef<PresentationMediaRuntime | null>(null)
  const objectIdsRef = useRef(new WeakMap<FabricObject, string>())
  const documentRef = useRef(document)
  const pageSizeRef = useRef(pageSize)
  const viewOptionsRef = useRef(viewOptions)
  const selectedElementIdRef = useRef<string | null>(null)
  const isolatedElementIdRef = useRef<string | null>(null)
  const activeGroupIdRef = useRef<string | null>(null)
  const drillIntoElementOnClickRef = useRef(false)
  const pointerDownSelectionContextRef = useRef<{ groupId: string | null, isolatedId: string | null }>({
    groupId: null,
    isolatedId: null,
  })
  const suppressCanvasSelectionRef = useRef(false)
  const canvasSelectionFrameRef = useRef<number | null>(null)
  const pastRef = useRef<PresentationHistoryEntry[]>([])
  const futureRef = useRef<PresentationHistoryEntry[]>([])
  const animationRunIdRef = useRef(0)
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
  const selectedAnimationElement = currentSlide && selectedElement
    ? getPresentationAnimationOwner(currentSlide.elements, selectedElement)
    : null
  const selectedAnimationTargetElements = currentSlide && selectedElement
    ? getPresentationElementGroup(currentSlide.elements, selectedElement)
    : []
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
    const versionedNext = next.id === current.id ? { ...next, version: current.version + 1 } : next
    documentRef.current = versionedNext
    setDocument(versionedNext)
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

  const addPresentationComment = useCallback((text: string) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide || !text.trim()) return
    const comment: PresentationComment = {
      author: t('session.presentation.commentAuthorYou'),
      createdAt: new Date().toISOString(),
      ...(selectedElementIdRef.current ? { elementId: selectedElementIdRef.current } : {}),
      id: createPresentationId('comment'),
      resolved: false,
      text: text.trim(),
    }
    replaceCurrentSlide({ ...slide, comments: [...(slide.comments ?? []), comment] })
  }, [replaceCurrentSlide, t])

  const updatePresentationComment = useCallback((commentId: string, patch: Partial<PresentationComment>) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    replaceCurrentSlide({
      ...slide,
      comments: (slide.comments ?? []).flatMap((comment) => (
        comment.id === commentId && patch.text === '' ? [] : [{ ...comment, ...patch }]
      )),
    })
  }, [replaceCurrentSlide])

  const applyPresentationMaster = useCallback((master: PresentationMaster) => {
    const current = documentRef.current
    commitDocument({
      ...current,
      master,
      slides: current.slides.map((slide) => ({
        ...slide,
        background: master.background,
        footer: { ...master.footer },
        elements: slide.elements.map((element): PresentationElement => (
          isPresentationTextElement(element)
            ? {
                ...element,
                fontFamily: element.fontWeight >= 600 || element.fontSize >= 30
                  ? master.titleFontFamily
                  : master.bodyFontFamily,
              }
            : element
        )),
      })),
    })
    setMasterDialogOpen(false)
  }, [commitDocument, setMasterDialogOpen])

  const applyPresentationTheme = useCallback((background: string, colors: readonly string[]) => {
    const current = documentRef.current
    const normalized = background.replace('#', '')
    const red = Number.parseInt(normalized.slice(0, 2), 16)
    const green = Number.parseInt(normalized.slice(2, 4), 16)
    const blue = Number.parseInt(normalized.slice(4, 6), 16)
    const dark = Number.isFinite(red + green + blue) && ((red * 299) + (green * 587) + (blue * 114)) / 1_000 < 140
    const primaryText = dark ? '#FFFFFF' : '#1D1D28'
    const secondaryText = dark ? '#C7C8D8' : '#666571'
    commitDocument({
      ...current,
      master: { ...current.master, background },
      slides: current.slides.map((slide) => ({
        ...slide,
        background,
        elements: slide.elements.map((element, index): PresentationElement => {
          if (isPresentationTextElement(element)) {
            return { ...element, color: element.fontWeight >= 600 || element.fontSize >= 30 ? primaryText : secondaryText }
          }
          if (isPresentationShapeElement(element) && element.fill !== 'transparent') {
            const accent = colors[index % colors.length] ?? element.fill
            return { ...element, fill: accent, borderColor: accent }
          }
          return element
        }),
      })),
    })
  }, [commitDocument])

  const patchElement = useCallback((elementId: string, patch: Partial<PresentationElement>) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    const selected = slide.elements.find((element) => element.id === elementId)
    const animationPatch = isPresentationAnimationPatch(patch)
    const target = selected && animationPatch
      ? getPresentationAnimationOwner(slide.elements, selected)
      : selected
    if (!target) return
    const groupedIds = animationPatch
      ? new Set(getPresentationElementGroup(slide.elements, target).map((element) => element.id))
      : null
    const nextElements = slide.elements.map((element): PresentationElement => {
      if (element.id === target.id) return { ...element, ...patch } as PresentationElement
      if (groupedIds?.has(element.id)) return clearPresentationAnimation(element)
      return element
    })
    replaceCurrentSlide({ ...slide, elements: nextElements })
  }, [replaceCurrentSlide])

  const syncFabricObjectsRef = useRef<(objects: readonly FabricObject[], detachMovedMembers?: boolean) => void>(() => undefined)
  const syncFabricObjects = useCallback((objects: readonly FabricObject[], detachMovedMembers = false) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    const patches = new Map<string, Partial<PresentationElement>>()
    for (const object of objects) {
      const elementId = objectIdsRef.current.get(object)
      if (!elementId) continue
      const element = slide.elements.find((item) => item.id === elementId)
      if (!element) continue
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
        if (isPresentationTextElement(element)) {
          const frameHeight = Math.max(8, element.height * scaleY)
          const renderedHeight = Math.max(0, (object.height ?? 0) * scaleY)
          let alignmentFactor = 0
          if (element.verticalAlign === 'bottom') alignmentFactor = 1
          else if (element.verticalAlign === 'middle') alignmentFactor = 0.5
          patch.y = Math.round(object.top - (Math.max(0, frameHeight - renderedHeight) * alignmentFactor))
          patch.height = Math.round(frameHeight)
        }
        const placeholderObject = object as FabricObject & {
          presentationPlaceholderVisible?: boolean
          text: string
        }
        const editableText = placeholderObject.presentationPlaceholderVisible ? '' : object.text
        const text = element.type === 'text'
          ? stripPresentationListMarkers(editableText, element.listStyle)
          : editableText
        Object.assign(patch, { text })
      }
      patches.set(elementId, patch)
    }
    if (patches.size === 0) return
    const nextElements = slide.elements.map((element) => {
        const patch = patches.get(element.id)
        return patch ? { ...element, ...patch } as PresentationElement : element
      })
    replaceCurrentSlide({
      ...slide,
      elements: detachMovedMembers
        ? detachPresentationElementsOutsideGroups(slide.elements, nextElements, new Set(patches.keys()))
        : nextElements,
    })
  }, [replaceCurrentSlide])

  const syncFabricObjectRef = useRef<(object: FabricObject) => void>(() => undefined)
  const syncFabricObject = useCallback((object: FabricObject) => syncFabricObjects([object]), [syncFabricObjects])

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

  useEffect(() => {
    const current = documentRef.current
    let documentChanged = false
    const slides = current.slides.map((slide) => {
      let slideChanged = false
      const elements = slide.elements.map((element) => {
        if (element.type !== 'audio') return element
        const compact = compactLegacyPresentationAudioElement(element)
        if (compact === element) return element
        slideChanged = true
        documentChanged = true
        return compact
      })
      return slideChanged ? { ...slide, elements } : slide
    })
    if (documentChanged) commitDocument({ ...current, slides }, false)
  }, [commitDocument, document])

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
    viewOptionsRef.current = viewOptions
  }, [viewOptions])

  useEffect(() => {
    pageSizeRef.current = pageSize
  }, [pageSize])

  useEffect(() => {
    syncFabricObjectsRef.current = syncFabricObjects
    syncFabricObjectRef.current = syncFabricObject
  }, [syncFabricObject, syncFabricObjects])

  useEffect(() => {
    pastRef.current = []
    futureRef.current = []
    isolatedElementIdRef.current = null
    selectedElementIdRef.current = null
    const timer = window.setTimeout(() => {
      setSlideshowOpen(false)
      setSlideshowTransition(null)
      setAnimationPreviewRun(null)
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
      setAnimationPreviewRun(null)
      setTransitionPreviewRun(null)
      setInsertDialog(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [active])

  useEffect(() => {
    const mediaRuntime = mediaRuntimeRef.current
    if (!mediaRuntime) return
    if (!active || slideshowOpen || transitionPreviewRun || animationPreviewRun) {
      mediaRuntime.releaseAll()
      return
    }
    const elementId = selectedElementIdRef.current
    if (elementId) mediaRuntime.prepare(elementId)
  }, [active, animationPreviewRun, slideshowOpen, transitionPreviewRun])

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
      const widthScale = Math.max(0.1, (entry.contentRect.width - 32) / pageSize.width)
      const heightScale = Math.max(0.1, (entry.contentRect.height - 32) / pageSize.height)
      setCanvasScale(Math.min(widthScale, heightScale, 1))
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [active, compact, expanded, pageSize.height, pageSize.width])

  const activateFabricElement = useCallback((elementId: string, scope: 'group' | 'element' = 'group') => {
    const canvas = canvasRef.current
    const fabric = fabricModuleRef.current
    if (!canvas || !fabric) return
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    const element = slide?.elements.find((item) => item.id === elementId)
    if (!slide || !element) return
    // Programmatic selection restoration must also restore React state. Fabric's
    // canvas.clear() emits selection:cleared while a changed slide is rebuilt;
    // without this assignment the visual selection returns but the Ribbon stays
    // disabled because selectedElementId was left as null.
    restorePresentationSelectionState(elementId, selectedElementIdRef, setSelectedElementId)
    const group = getPresentationElementGroup(slide.elements, element)
    const groupedIds = new Set((scope === 'element' ? [element] : group).map((member) => member.id))
    const activeGroupId = scope === 'group' && group.length > 1 ? element.groupId ?? null : null
    const objects = canvas.getObjects().filter((object) => {
      const objectId = objectIdsRef.current.get(object)
      return Boolean(objectId && groupedIds.has(objectId))
    })
    if (objects.length === 0) return

    const activeObject = canvas.getActiveObject()
    if (objects.length === 1 && activeObject === objects[0]) {
      isolatedElementIdRef.current = scope === 'element' ? elementId : null
      activeGroupIdRef.current = activeGroupId
      return
    }
    if (objects.length > 1 && activeObject instanceof fabric.ActiveSelection) {
      const activeIds = new Set(activeObject.getObjects().map((object) => objectIdsRef.current.get(object)))
      if (activeIds.size === groupedIds.size && [...groupedIds].every((id) => activeIds.has(id))) {
        isolatedElementIdRef.current = null
        activeGroupIdRef.current = activeGroupId
        return
      }
    }

    suppressCanvasSelectionRef.current = true
    try {
      canvas.discardActiveObject()
      if (objects.length === 1) {
        canvas.setActiveObject(objects[0]!)
      } else {
        const selection = new fabric.ActiveSelection(objects, {
          canvas,
          multiSelectionStacking: 'canvas-stacking',
          subTargetCheck: true,
        })
        selection.set({
          borderColor: '#6957D9',
          cornerColor: '#FFFFFF',
          cornerStrokeColor: '#6957D9',
          cornerStyle: 'circle',
          cornerSize: 11,
          transparentCorners: false,
        })
        objectIdsRef.current.set(selection, elementId)
        canvas.setActiveObject(selection)
      }
    } finally {
      suppressCanvasSelectionRef.current = false
    }
    isolatedElementIdRef.current = scope === 'element' ? elementId : null
    activeGroupIdRef.current = activeGroupId
    canvas.requestRenderAll()
  }, [])

  useEffect(() => {
    if (!active || !canvasElementRef.current) return
    let cancelled = false
    void import('fabric').then((fabric) => {
      if (cancelled || !canvasElementRef.current) return
      const canvas = new fabric.Canvas(canvasElementRef.current, {
        width: pageSizeRef.current.width,
        height: pageSizeRef.current.height,
        preserveObjectStacking: true,
        selection: false,
        selectionColor: 'rgba(105, 87, 217, 0.12)',
        selectionBorderColor: '#6957D9',
      })
      fabricModuleRef.current = fabric
      canvasRef.current = canvas
      const mediaRuntime = createPresentationMediaRuntime(fabric, canvas)
      mediaRuntimeRef.current = mediaRuntime
      const selectCanvasObject = (selected?: FabricObject) => {
        if (suppressCanvasSelectionRef.current) return
        const elementId = selected ? objectIdsRef.current.get(selected) ?? null : null
        mediaRuntime.pauseAll()
        if (elementId) mediaRuntime.prepare(elementId)
        selectedElementIdRef.current = elementId
        setSelectedElementId(elementId)
        if (!elementId) {
          isolatedElementIdRef.current = null
          activeGroupIdRef.current = null
        }
      }
      canvas.on('selection:created', (event) => selectCanvasObject(event.selected?.[0]))
      canvas.on('selection:updated', (event) => selectCanvasObject(event.selected?.[0]))
      canvas.on('selection:cleared', () => selectCanvasObject())
      canvas.on('object:moving', (event) => {
        mediaRuntime.pauseAll()
        const object = event.target
        if (!object || !viewOptionsRef.current.smartSnap) return
        const objectWidth = (object.width ?? 0) * (object.scaleX ?? 1)
        const objectHeight = (object.height ?? 0) * (object.scaleY ?? 1)
        const threshold = 8
        const gridSize = 10
        let left = Math.round(object.left / gridSize) * gridSize
        let top = Math.round(object.top / gridSize) * gridSize
        const centerX = object.left + (objectWidth / 2)
        const centerY = object.top + (objectHeight / 2)
        const currentPageSize = pageSizeRef.current
        if (Math.abs(centerX - (currentPageSize.width / 2)) <= threshold) {
          left = (currentPageSize.width - objectWidth) / 2
        }
        if (Math.abs(centerY - (currentPageSize.height / 2)) <= threshold) {
          top = (currentPageSize.height - objectHeight) / 2
        }
        object.set({ left, top })
      })
      canvas.on('object:scaling', () => mediaRuntime.pauseAll())
      canvas.on('mouse:down:before', () => {
        if (suppressCanvasSelectionRef.current) return
        pointerDownSelectionContextRef.current = {
          groupId: activeGroupIdRef.current,
          isolatedId: isolatedElementIdRef.current,
        }
        drillIntoElementOnClickRef.current = false
      })
      canvas.on('mouse:down', (event) => {
        if (suppressCanvasSelectionRef.current) return
        const selected = [...(event.subTargets ?? [])].reverse().find((object) => objectIdsRef.current.has(object))
          ?? event.target
        const elementId = selected ? objectIdsRef.current.get(selected) : undefined
        if (!elementId) return
        const current = documentRef.current
        const slide = current.slides.find((item) => item.id === current.selectedSlideId)
        const element = slide?.elements.find((item) => item.id === elementId)
        const selectionContext = pointerDownSelectionContextRef.current
        drillIntoElementOnClickRef.current = Boolean(
          element && resolvePresentationCanvasSelectionScope(element, selectionContext) === 'element',
        )
        selectedElementIdRef.current = elementId
        setSelectedElementId(elementId)
      })
      canvas.on('mouse:move', (event) => {
        if (!event.target) return
        const cursor = mediaRuntime.cursorFromCanvas(event.target, event.scenePoint)
        if (cursor) canvas.setCursor(cursor)
      })
      canvas.on('mouse:up', (event) => {
        if (!event.isClick || !event.target) {
          drillIntoElementOnClickRef.current = false
          return
        }
        mediaRuntime.toggleFromCanvas(event.target, event.scenePoint)
        const selected = [...(event.subTargets ?? [])].reverse().find((object) => objectIdsRef.current.has(object))
          ?? event.target
        const elementId = selected ? objectIdsRef.current.get(selected) : undefined
        if (!elementId) {
          drillIntoElementOnClickRef.current = false
          return
        }
        const scope = drillIntoElementOnClickRef.current ? 'element' : 'group'
        drillIntoElementOnClickRef.current = false
        if (canvasSelectionFrameRef.current !== null) window.cancelAnimationFrame(canvasSelectionFrameRef.current)
        canvasSelectionFrameRef.current = window.requestAnimationFrame(() => {
          canvasSelectionFrameRef.current = null
          if (canvasRef.current !== canvas) return
          selectedElementIdRef.current = elementId
          setSelectedElementId(elementId)
          activateFabricElement(elementId, scope)
        })
      })
      canvas.on('object:modified', (event) => {
        if (!event.target) return
        if (event.target instanceof fabric.ActiveSelection) {
          const selection = event.target
          const objects = [...selection.getObjects()]
          if (canvasSelectionFrameRef.current !== null) window.cancelAnimationFrame(canvasSelectionFrameRef.current)
          canvasSelectionFrameRef.current = window.requestAnimationFrame(() => {
            canvasSelectionFrameRef.current = null
            if (canvasRef.current !== canvas) return
            suppressCanvasSelectionRef.current = true
            try {
              if (canvas.getActiveObject() === selection) canvas.discardActiveObject()
            } finally {
              suppressCanvasSelectionRef.current = false
            }
            isolatedElementIdRef.current = null
            activeGroupIdRef.current = null
            syncFabricObjectsRef.current(objects)
          })
          return
        }
        syncFabricObjectsRef.current([event.target], true)
      })
      canvas.on('mouse:dblclick', (event) => {
        const selected = [...(event.subTargets ?? [])].reverse().find((object) => objectIdsRef.current.has(object))
          ?? event.target
        const elementId = selected ? objectIdsRef.current.get(selected) : undefined
        if (!elementId) return
        const current = documentRef.current
        const slide = current.slides.find((item) => item.id === current.selectedSlideId)
        const element = slide?.elements.find((item) => item.id === elementId)
        if (!element) return
        setSelectedElementId(element.id)
        selectedElementIdRef.current = element.id
        if (isPresentationTextElement(element) && selected) {
          if (canvasSelectionFrameRef.current !== null) window.cancelAnimationFrame(canvasSelectionFrameRef.current)
          canvasSelectionFrameRef.current = window.requestAnimationFrame(() => {
            canvasSelectionFrameRef.current = null
            if (canvasRef.current !== canvas) return
            activateFabricElement(element.id, 'element')
            const editable = canvas.getActiveObject() as FabricObject & { enterEditing?: () => void }
            editable.enterEditing?.()
            canvas.requestRenderAll()
          })
          return
        }
        if (!isPresentationTableElement(element) && !isPresentationChartElement(element)) return
        setInsertDialog({ kind: element.type, elementId: element.id })
      })
      setCanvasGeneration((value) => value + 1)
    })
    return () => {
      cancelled = true
      const canvas = canvasRef.current
      canvasRef.current = null
      fabricModuleRef.current = null
      if (canvasSelectionFrameRef.current !== null) {
        window.cancelAnimationFrame(canvasSelectionFrameRef.current)
        canvasSelectionFrameRef.current = null
      }
      const mediaRuntime = mediaRuntimeRef.current
      mediaRuntimeRef.current = null
      objectIdsRef.current = new WeakMap()
      activeGroupIdRef.current = null
      drillIntoElementOnClickRef.current = false
      pointerDownSelectionContextRef.current = { groupId: null, isolatedId: null }
      mediaRuntime?.dispose()
      if (canvas) void canvas.dispose()
    }
  }, [activateFabricElement, active])

  useEffect(() => {
    const canvas = canvasRef.current
    const fabric = fabricModuleRef.current
    const mediaRuntime = mediaRuntimeRef.current
    if (!active || !canvas || !fabric || !mediaRuntime || !currentSlide) return
    let cancelled = false
    mediaRuntime.reset()
    // Rebuilding Fabric objects is an implementation detail, not a user
    // deselection. Ignore the synchronous selection:cleared event so Ribbon
    // controls never flash disabled while effects and formatting are applied.
    const activeElementId = clearPresentationCanvasPreservingSelection(
      selectedElementIdRef,
      suppressCanvasSelectionRef,
      () => canvas.clear(),
    )
    canvas.setDimensions({ width: pageSize.width, height: pageSize.height })
    canvas.backgroundColor = currentSlide.background
    objectIdsRef.current = new WeakMap()
    void Promise.all(currentSlide.elements.map(async (element) => {
      let placeholderText: string | undefined
      if (isPresentationTextElement(element) && !element.text.trim() && element.placeholder) {
        if (element.placeholder === 'title') placeholderText = t('session.presentation.clickToAddTitle')
        else if (element.placeholder === 'subtitle') placeholderText = t('session.presentation.clickToAddSubtitle')
        else placeholderText = t('session.presentation.clickToAddBody')
      }
      return {
        element,
        object: await createPresentationFabricObject(
          fabric,
          element,
          (object) => syncFabricObjectRef.current(object),
          placeholderText,
        ),
      }
    })).then((entries) => {
      if (cancelled || canvasRef.current !== canvas) return
      for (const { element, object } of entries) {
        let hoverCursor = 'move'
        if (isPresentationMediaElement(element)) hoverCursor = 'default'
        else if (element.hyperlink && supportsPresentationElementHyperlink(element)) hoverCursor = 'pointer'
        object.set({
          borderColor: '#6957D9',
          cornerColor: '#FFFFFF',
          cornerStrokeColor: '#6957D9',
          cornerStyle: 'circle',
          cornerSize: 11,
          transparentCorners: false,
          objectCaching: false,
          lockRotation: isPresentationRotationLocked(element),
          hoverCursor,
        })
        objectIdsRef.current.set(object, element.id)
        canvas.add(object)
        if (isPresentationMediaElement(element)) mediaRuntime.register(element, object)
      }
      const slideNumber = documentRef.current.slides.findIndex((slide) => slide.id === currentSlide.id) + 1
      createFooterFabricObjects(fabric, currentSlide, Math.max(1, slideNumber), pageSize).forEach((object) => canvas.add(object))
      if (activeElementId) {
        activateFabricElement(
          activeElementId,
          isolatedElementIdRef.current === activeElementId ? 'element' : 'group',
        )
        mediaRuntime.prepare(activeElementId)
      }
      canvas.requestRenderAll()
    }).catch(() => {
      if (!cancelled) canvas.requestRenderAll()
    })
    return () => {
      cancelled = true
      if (mediaRuntimeRef.current === mediaRuntime) mediaRuntime.reset()
    }
  }, [activateFabricElement, active, canvasGeneration, currentSlide, pageSize, t])

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
    const selected = slide.elements.find((element) => element.id === elementId)
    if (!selected) return
    const removedIds = new Set(getPresentationSelectionElements(
      slide.elements,
      selected,
      isolatedElementIdRef.current,
    ).map((element) => element.id))
    isolatedElementIdRef.current = null
    selectedElementIdRef.current = null
    setSelectedElementId(null)
    replaceCurrentSlide({
      ...slide,
      elements: removePresentationElements(slide.elements, removedIds),
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
        || Boolean(target.closest('button, a, [role="button"]'))
      )) return
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier && !event.repeat && (event.key === ' ' || event.key === 'Enter')) {
        const elementId = selectedElementIdRef.current
        const current = documentRef.current
        const slide = current.slides.find((item) => item.id === current.selectedSlideId)
        const element = slide?.elements.find((item) => item.id === elementId)
        if (element && isPresentationMediaElement(element) && !transitionPreviewRun) {
          event.preventDefault()
          void mediaRuntimeRef.current?.toggle(element.id)
          return
        }
      }
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelectedElement()
        return
      }
      if (event.key === 'Escape' && isolatedElementIdRef.current) {
        event.preventDefault()
        const elementId = isolatedElementIdRef.current
        isolatedElementIdRef.current = null
        activateFabricElement(elementId, 'group')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activateFabricElement, active, deleteSelectedElement, redo, slideshowOpen, transitionPreviewRun, undo])

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
  }, [setSlideshowIndex, setSlideshowTransition, slideshowIndex, slideshowTransition])

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

  const selectSlide = (slideId: string) => {
    isolatedElementIdRef.current = null
    selectedElementIdRef.current = null
    setSelectedElementId(null)
    setAnimationPreviewRun(null)
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

  const applySlideLayout = (layout: PresentationSlideLayout) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    if (layout === 'blank') {
      replaceCurrentSlide({ ...slide, layout })
      return
    }
    const textElements = slide.elements.filter(isPresentationTextElement)
    const nonTextElements = slide.elements.filter((element) => !isPresentationTextElement(element))
    const createLayoutText = (title: boolean): PresentationTextElement => ({
      id: createPresentationId('text'),
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      rotation: 0,
      text: t(title ? 'session.presentation.titlePlaceholder' : 'session.presentation.textPlaceholder'),
      fontSize: title ? 42 : 24,
      fontFamily: title ? current.master.titleFontFamily : current.master.bodyFontFamily,
      fontWeight: title ? 700 : 400,
      color: '#20202B',
      align: 'left',
    })
    const title = textElements[0] ?? createLayoutText(true)
    const body = textElements[1] ?? createLayoutText(false)
    const positioned: PresentationTextElement[] = []
    if (layout === 'title') {
      positioned.push(
        { ...title, placeholder: 'title', x: 120, y: 245, width: pageSize.width - 240, height: 100, align: 'center' },
        { ...body, placeholder: 'subtitle', x: 180, y: 365, width: pageSize.width - 360, height: 70, align: 'center' },
      )
    } else {
      positioned.push({ ...title, x: 80, y: 58, width: pageSize.width - 160, height: 82 })
      if (layout === 'titleContent') {
        positioned.push({ ...body, x: 90, y: 165, width: pageSize.width - 180, height: pageSize.height - 235 })
      } else {
        const secondBody = textElements[2] ?? createLayoutText(false)
        const contentWidth = (pageSize.width - 210) / 2
        positioned.push(
          { ...body, x: 80, y: 165, width: contentWidth, height: pageSize.height - 235 },
          { ...secondBody, x: 130 + contentWidth, y: 165, width: contentWidth, height: pageSize.height - 235 },
        )
      }
    }
    const usedIds = new Set(positioned.map((element) => element.id))
    replaceCurrentSlide({
      ...slide,
      layout,
      elements: [...nonTextElements, ...textElements.filter((element) => !usedIds.has(element.id)), ...positioned],
    })
  }

  const addShape = (type: PresentationShapeType) => {
    if (!currentSlide) return
    const size = getPresentationShapeSize(type)
    const lineShape = isPresentationLineShape(type)
    const element: PresentationShapeElement = {
      id: createPresentationId('shape'),
      type,
      x: Math.round((pageSize.width - size.width) / 2),
      y: Math.round((pageSize.height - size.height) / 2),
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
            x: Math.round((pageSize.width - width) / 2),
            y: Math.round((pageSize.height - height) / 2),
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

  const importPresentation = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const imported = await importPresentationPptx(await file.arrayBuffer(), file.name)
      setWorkspace((current) => ({
        activeDocumentId: imported.id,
        documents: [...current.documents, imported],
      }))
      setSelectedElementId(null)
      setRibbonTab('home')
      showToast(t('session.presentation.imported', { name: file.name }))
    } catch {
      showToast(t('session.presentation.importFailed'))
    }
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
          x: Math.round((pageSize.width - width) / 2),
          y: Math.round((pageSize.height - height) / 2),
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
    const target = isPresentationAnimationPatch(patch) ? selectedAnimationElement : selectedElement
    if (!target) return
    let supportedPatch = patch
    if (isPresentationRotationLocked(target) && 'rotation' in supportedPatch) {
      const { rotation: _ignoredRotation, ...remainingPatch } = supportedPatch
      supportedPatch = remainingPatch
    }
    if (!supportsPresentationElementShadow(target) && 'shadow' in supportedPatch) {
      const { shadow: _ignoredShadow, ...remainingPatch } = supportedPatch
      supportedPatch = remainingPatch
    }
    if (Object.keys(supportedPatch).length > 0) patchElement(target.id, supportedPatch)
  }

  const moveSelectedElement = (direction: 'front' | 'back') => {
    if (!currentSlide || !selectedElement) return
    const groupedElements = getPresentationSelectionElements(
      currentSlide.elements,
      selectedElement,
      isolatedElementIdRef.current,
    )
    const groupedIds = new Set(groupedElements.map((element) => element.id))
    const elements = currentSlide.elements.filter((element) => !groupedIds.has(element.id))
    if (direction === 'front') elements.push(...groupedElements)
    else elements.unshift(...groupedElements)
    replaceCurrentSlide({ ...currentSlide, elements })
  }

  const alignSelectedElement = (alignment: PresentationElementAlignment) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    const selected = slide?.elements.find((element) => element.id === selectedElementIdRef.current)
    if (!slide || !selected) return
    const targets = getPresentationSelectionElements(slide.elements, selected, isolatedElementIdRef.current)
    const targetIds = new Set(targets.map((element) => element.id))
    const bounds = getPresentationElementBounds(targets)
    let deltaX = 0
    let deltaY = 0
    if (alignment === 'left') deltaX = -bounds.x
    else if (alignment === 'center') deltaX = ((pageSize.width - bounds.width) / 2) - bounds.x
    else if (alignment === 'right') deltaX = pageSize.width - bounds.width - bounds.x
    else if (alignment === 'top') deltaY = -bounds.y
    else if (alignment === 'middle') deltaY = ((pageSize.height - bounds.height) / 2) - bounds.y
    else deltaY = pageSize.height - bounds.height - bounds.y
    replaceCurrentSlide({
      ...slide,
      elements: slide.elements.map((element): PresentationElement => targetIds.has(element.id)
        ? { ...element, x: Math.round(element.x + deltaX), y: Math.round(element.y + deltaY) } as PresentationElement
        : element),
    })
  }

  const toggleSelectedElementGroup = () => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    const selected = slide?.elements.find((element) => element.id === selectedElementIdRef.current)
    if (!slide || !selected) return
    if (selected.groupId) {
      const groupId = selected.groupId
      isolatedElementIdRef.current = selected.id
      replaceCurrentSlide({
        ...slide,
        elements: slide.elements.map((element): PresentationElement => element.groupId === groupId
          ? { ...element, groupId: undefined } as PresentationElement
          : element),
      })
      return
    }

    const selectedBounds = getPresentationElementBounds([selected])
    const overlapsSelected = (element: PresentationElement): boolean => {
      const right = Math.min(selectedBounds.x + selectedBounds.width, element.x + element.width)
      const bottom = Math.min(selectedBounds.y + selectedBounds.height, element.y + element.height)
      return right > Math.max(selectedBounds.x, element.x) && bottom > Math.max(selectedBounds.y, element.y)
    }
    const members = slide.elements.filter((element) => element.id === selected.id || overlapsSelected(element))
    if (members.length < 2) {
      showToast(t('session.presentation.groupNeedsOverlap'))
      return
    }
    const memberIds = new Set(members.map((element) => element.id))
    const groupId = createPresentationId('group')
    const animationOwner = members.find(hasPresentationAnimation)
    replaceCurrentSlide({
      ...slide,
      elements: slide.elements.map((element): PresentationElement => {
        if (!memberIds.has(element.id)) return element
        const grouped = { ...element, groupId } as PresentationElement
        return animationOwner && element.id !== animationOwner.id
          ? clearPresentationAnimation(grouped)
          : grouped
      }),
    })
    isolatedElementIdRef.current = null
    activeGroupIdRef.current = groupId
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

  const changePageSize = (preset: PresentationPageSizePreset) => {
    const current = documentRef.current
    const previousSize = getPresentationPageSize(current)
    const nextSize = PRESENTATION_PAGE_SIZES[preset]
    if (previousSize.preset === preset && previousSize.width === nextSize.width && previousSize.height === nextSize.height) return
    const scale = Math.min(nextSize.width / previousSize.width, nextSize.height / previousSize.height)
    const offsetX = (nextSize.width - (previousSize.width * scale)) / 2
    const offsetY = (nextSize.height - (previousSize.height * scale)) / 2
    const scaleElement = (element: PresentationElement): PresentationElement => {
      const scaled = {
        ...element,
        x: Math.round((element.x * scale) + offsetX),
        y: Math.round((element.y * scale) + offsetY),
        width: Math.max(8, Math.round(element.width * scale)),
        height: Math.max(8, Math.round(element.height * scale)),
      } as PresentationElement
      if (isPresentationTextElement(scaled)) {
        return { ...scaled, fontSize: Math.max(8, Number((scaled.fontSize * scale).toFixed(1))) }
      }
      if (isPresentationShapeElement(scaled)) {
        return {
          ...scaled,
          borderWidth: Number((scaled.borderWidth * scale).toFixed(2)),
          radius: scaled.radius === undefined ? undefined : Number((scaled.radius * scale).toFixed(1)),
        }
      }
      if (isPresentationTableElement(scaled)) {
        return { ...scaled, fontSize: Math.max(8, Number((scaled.fontSize * scale).toFixed(1))) }
      }
      return scaled
    }
    commitDocument({
      ...current,
      pageSize: { ...nextSize },
      slides: current.slides.map((slide) => ({ ...slide, elements: slide.elements.map(scaleElement) })),
    })
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

  const applyCurrentAnimationToAll = () => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    const selected = slide?.elements.find((element) => element.id === selectedElementIdRef.current)
    if (!slide || !selected) return
    const source = getPresentationAnimationOwner(slide.elements, selected)
    if (!hasPresentationAnimation(source)) return
    const animationPatch = copyPresentationAnimationPatch(source)
    const ownerIds = new Set(getPresentationElementTargets(slide.elements).map((target) => target.elements[0]!.id))
    replaceCurrentSlide({
      ...slide,
      elements: slide.elements.map((element) => {
        const cleared = clearPresentationAnimation(element)
        return ownerIds.has(element.id)
          ? { ...cleared, ...animationPatch } as PresentationElement
          : cleared
      }),
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
    const widthScale = Math.max(0.1, (stage.clientWidth - 40) / pageSize.width)
    const heightScale = Math.max(0.1, (stage.clientHeight - 40) / pageSize.height)
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
    mediaRuntimeRef.current?.releaseAll()
    setAnimationPreviewRun(null)
    transitionRunIdRef.current += 1
    setTransitionPreviewRun({ runKey: transitionRunIdRef.current, slideId: slide.id, transition })
  }

  const previewSelectedAnimation = useCallback((animationOverride?: Partial<PresentationElement>) => {
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    if (!slide) return
    const selected = slide.elements.find((element) => element.id === selectedElementIdRef.current)
    const target = selected ? getPresentationAnimationOwner(slide.elements, selected) : null
    const targetElementId = animationOverride ? target?.id ?? null : null
    const previewSlide = targetElementId && animationOverride
      ? {
          ...slide,
          elements: slide.elements.map((element): PresentationElement => (
            element.id === targetElementId ? { ...element, ...animationOverride } as PresentationElement : element
          )),
        }
      : slide
    const previewElements = targetElementId
      ? previewSlide.elements.filter((element) => element.id === targetElementId && hasPresentationAnimation(element))
      : previewSlide.elements.filter(hasPresentationAnimation)
    if (previewElements.length === 0) {
      setAnimationPreviewRun(null)
      return
    }
    mediaRuntimeRef.current?.releaseAll()
    setTransitionPreviewRun(null)
    animationRunIdRef.current += 1
    setAnimationPreviewRun({
      elementIds: targetElementId ? [targetElementId] : undefined,
      runKey: animationRunIdRef.current,
      slide: previewSlide,
      slideNumber: current.slides.findIndex((item) => item.id === slide.id) + 1,
    })
  }, [])

  const startSlideshow = () => {
    const index = documentRef.current.slides.findIndex((slide) => slide.id === documentRef.current.selectedSlideId)
    mediaRuntimeRef.current?.releaseAll()
    setAnimationPreviewRun(null)
    setTransitionPreviewRun(null)
    setSlideshowTransition(null)
    setSlideshowIndex(Math.max(0, index))
    setSlideshowOpen(true)
  }

  const startSlideshowFromBeginning = () => {
    mediaRuntimeRef.current?.releaseAll()
    setAnimationPreviewRun(null)
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

  const toggleLayersPane = () => {
    if (inspectorMode !== 'layers') {
      setInspectorMode('layers')
      setInspectorOpen(true)
      return
    }
    setInspectorOpen((value) => !value)
  }

  const toggleCommentsPane = () => {
    if (inspectorOpen && inspectorMode === 'comments') {
      setInspectorOpen(false)
      return
    }
    setInspectorMode('comments')
    setInspectorOpen(true)
  }

  const selectPresentationElement = (elementId: string) => {
    isolatedElementIdRef.current = null
    selectedElementIdRef.current = elementId
    setSelectedElementId(elementId)
    activateFabricElement(elementId, 'group')
  }

  const changeRibbonTab = (tab: PresentationRibbonTab) => {
    setRibbonTab(tab)
    if (tab !== 'animations' || selectedElementIdRef.current) return
    const current = documentRef.current
    const slide = current.slides.find((item) => item.id === current.selectedSlideId)
    const firstElement = slide?.elements[0]
    if (firstElement) selectPresentationElement(firstElement.id)
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
            const displayTitle = item.title.trim() || t('session.presentation.untitled')
            const fileName = displayTitle.toLowerCase().endsWith('.pptx')
              ? displayTitle
              : `${displayTitle}.pptx`
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
        animationTargetElements={selectedAnimationTargetElements}
        animationMarkersHidden={animationMarkersHidden}
        animationPaneOpen={inspectorOpen && inspectorMode === 'animation'}
        canvasScale={canvasScale}
        compact={compact}
        currentSlide={currentSlide}
        filmstripCollapsed={filmstripCollapsed}
        historyStatus={historyStatus}
        inspectorOpen={inspectorOpen && inspectorMode === 'properties'}
        commentsOpen={inspectorOpen && inspectorMode === 'comments'}
        layersOpen={inspectorOpen && inspectorMode === 'layers'}
        pageSizePreset={pageSize.preset}
        ribbonCollapsed={ribbonCollapsed}
        selectedElement={ribbonTab === 'animations' ? selectedAnimationElement : selectedElement}
        selectedText={selectedText}
        viewOptions={viewOptions}
        toolbarActions={(
          <>
            <HeaderButton label={t('session.presentation.importPptx')} onClick={() => presentationInputRef.current?.click()} testId="presentation-import-pptx">
              <Upload className="size-4" />
            </HeaderButton>
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
        onActiveTabChange={changeRibbonTab}
        onAddShape={addShape}
        onAddSlide={addSlide}
        onAddText={addText}
        onAlignElement={alignSelectedElement}
        onApplyAnimationToAll={applyCurrentAnimationToAll}
        onApplyLayout={applySlideLayout}
        onApplyTheme={applyPresentationTheme}
        onApplyTransitionToAll={applyCurrentTransitionToAll}
        onApplyFormat={patchElement}
        onCanvasScaleChange={setCanvasScale}
        onToggleComments={toggleCommentsPane}
        onFindText={findText}
        onFitCanvas={fitCanvas}
        onEditMaster={() => setMasterDialogOpen(true)}
        onInsertAudio={() => audioInputRef.current?.click()}
        onInsertChart={() => setInsertDialog({ kind: 'chart' })}
        onInsertFooter={() => setInsertDialog({ kind: 'footer' })}
        onInsertImage={() => imageInputRef.current?.click()}
        onInsertLink={openLinkDialog}
        onInsertTable={() => setInsertDialog({ kind: 'table' })}
        onInsertVideo={() => videoInputRef.current?.click()}
        onMoveElement={moveSelectedElement}
        onPageSizeChange={changePageSize}
        onPreviewAnimation={previewSelectedAnimation}
        onPreviewTransition={previewTransition}
        onRedo={redo}
        onSlideChange={updateCurrentSlide}
        onStartSlideshow={startSlideshow}
        onStartSlideshowFromBeginning={startSlideshowFromBeginning}
        onToggleAnimationMarkers={() => setAnimationMarkersHidden((value) => !value)}
        onToggleAnimationPane={toggleAnimationPane}
        onToggleFilmstrip={() => setFilmstripCollapsed((value) => !value)}
        onToggleGroup={toggleSelectedElementGroup}
        onToggleInspector={togglePropertiesInspector}
        onToggleLayers={toggleLayersPane}
        onToggleRibbon={() => setRibbonCollapsed((value) => !value)}
        onUndo={undo}
        onUpdateElement={updateSelectedElement}
        onViewOptionsChange={setViewOptions}
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
                      <PresentationSlidePreview pageSize={pageSize} slide={slide} slideNumber={index + 1} width={previewWidth} selected={slide.id === currentSlide?.id} />
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
                style={{ width: pageSize.width * canvasScale, height: pageSize.height * canvasScale }}
              >
                <div className="absolute left-0 top-0 origin-top-left" style={{ width: pageSize.width, height: pageSize.height, transform: `scale(${canvasScale})` }}>
                  <canvas ref={canvasElementRef} aria-label={t('session.presentation.canvasAria')} />
                </div>
                {viewOptions.gridlines ? (
                  <div
                    className="pointer-events-none absolute inset-0 z-[5]"
                    data-testid="presentation-gridlines"
                    style={{
                      backgroundImage: 'linear-gradient(to right, rgba(79,70,120,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(79,70,120,0.16) 1px, transparent 1px)',
                      backgroundSize: `${40 * canvasScale}px ${40 * canvasScale}px`,
                    }}
                  />
                ) : null}
                {viewOptions.guides ? (
                  <div className="pointer-events-none absolute inset-0 z-[6]" data-testid="presentation-guides">
                    <span className="absolute inset-y-0 left-1/2 border-l border-dashed border-[#E0529C]/80" />
                    <span className="absolute inset-x-0 top-1/2 border-t border-dashed border-[#E0529C]/80" />
                  </div>
                ) : null}
                {viewOptions.ruler ? (
                  <div className="pointer-events-none absolute inset-0 z-[7] text-[8px] text-[#4A4860]" data-testid="presentation-ruler">
                    <span
                      className="absolute inset-x-0 top-0 h-4 border-b border-black/15 bg-white/80"
                      style={{ backgroundImage: 'repeating-linear-gradient(to right, transparent 0, transparent 9px, rgba(45,43,61,0.45) 9px, rgba(45,43,61,0.45) 10px)' }}
                    />
                    <span
                      className="absolute inset-y-0 left-0 w-4 border-r border-black/15 bg-white/80"
                      style={{ backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0, transparent 9px, rgba(45,43,61,0.45) 9px, rgba(45,43,61,0.45) 10px)' }}
                    />
                  </div>
                ) : null}
                {ribbonTab === 'animations' && !animationMarkersHidden && currentSlide ? (
                  <div className="pointer-events-none absolute inset-0 z-10" data-testid="presentation-animation-markers">
                    {getPresentationAnimationTargets(currentSlide.elements).map((target, index) => (
                      <span
                        key={target.id}
                        className="absolute flex size-[18px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-[#2678E8] text-[9px] font-bold text-white shadow-sm"
                        style={{ left: target.bounds.x * canvasScale, top: target.bounds.y * canvasScale }}
                      >
                        {index + 1}
                      </span>
                    ))}
                  </div>
                ) : null}
                {animationPreviewRun && currentSlide && animationPreviewRun.slide.id === currentSlide.id ? (
                  <div className="absolute inset-0 z-20">
                    <PresentationAnimationPlayer
                      className="size-full"
                      elementIds={animationPreviewRun.elementIds}
                      onComplete={() => setAnimationPreviewRun((run) => run?.runKey === animationPreviewRun.runKey ? null : run)}
                      pageSize={pageSize}
                      runKey={animationPreviewRun.runKey}
                      slide={animationPreviewRun.slide}
                      slideNumber={animationPreviewRun.slideNumber}
                      width={pageSize.width * canvasScale}
                    />
                  </div>
                ) : null}
                {transitionPreviewRun && currentSlide && transitionPreviewRun.slideId === currentSlide.id ? (
                  <div className="absolute inset-0 z-20">
                    <PresentationTransitionPlayer
                      previous={transitionPreviewPreviousSlide
                        ? <PresentationSlidePreview pageSize={pageSize} slide={transitionPreviewPreviousSlide} slideNumber={currentSlideIndex} width={pageSize.width * canvasScale} selected={false} presentation />
                        : <span className="block size-full bg-black" />}
                      current={<PresentationSlidePreview pageSize={pageSize} slide={currentSlide} slideNumber={currentSlideIndex + 1} width={pageSize.width * canvasScale} selected={false} presentation />}
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

            {inspectorOpen && inspectorMode === 'animation' ? (
              <AnimationInspector currentSlide={currentSlide} selectedElement={selectedAnimationElement} onClose={() => setInspectorOpen(false)} onElementChange={updateSelectedElement} onPreviewAnimation={previewSelectedAnimation} onSelectElement={selectPresentationElement} />
            ) : null}
            {inspectorOpen && inspectorMode === 'layers' ? (
              <PresentationLayersInspector
                currentSlide={currentSlide}
                selectedElement={selectedElement}
                onClose={() => setInspectorOpen(false)}
                onMoveElement={moveSelectedElement}
                onSelectElement={selectPresentationElement}
              />
            ) : null}
            {inspectorOpen && inspectorMode === 'comments' ? (
              <PresentationCommentsInspector
                comments={currentSlide?.comments ?? []}
                onAdd={addPresentationComment}
                onClose={() => setInspectorOpen(false)}
                onSelectElement={selectPresentationElement}
                onUpdate={updatePresentationComment}
              />
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

          {viewOptions.notes ? (
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
          ) : null}

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
        ref={presentationInputRef}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        className="hidden"
        data-testid="presentation-pptx-input"
        onChange={(event) => void importPresentation(event)}
      />
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
      {masterDialogOpen ? (
        <PresentationMasterDialog
          master={document.master}
          onApply={applyPresentationMaster}
          onClose={() => setMasterDialogOpen(false)}
        />
      ) : null}

      {slideshowOpen && slideshowSlide ? (
        <SlideshowOverlay
          key={slideshowSlide.id}
          current={slideshowTargetIndex + 1}
          pageSize={pageSize}
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

function PresentationMasterDialog({ master, onApply, onClose }: {
  master: PresentationMaster
  onApply: (master: PresentationMaster) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<PresentationMaster>(() => ({ ...master, footer: { ...master.footer } }))
  const fontFamilies = ['Aptos', 'Aptos Display', 'Arial', 'Georgia', 'Helvetica', 'Times New Roman']
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 p-6 backdrop-blur-[2px]" role="presentation" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t('session.presentation.slideMaster')}
        data-testid="presentation-master-dialog"
        className="w-full max-w-[520px] overflow-hidden rounded-xl border border-border-subtle bg-bg-surface shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          onApply(draft)
        }}
      >
        <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
          <h2 className="text-sm font-semibold text-text-primary">{t('session.presentation.slideMaster')}</h2>
          <button type="button" onClick={onClose} aria-label={t('session.presentation.closePane')} className="flex size-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover"><X className="size-4" /></button>
        </div>
        <div className="grid grid-cols-2 gap-4 p-5 text-xs text-text-secondary">
          <label className="col-span-2 flex items-center justify-between gap-4">
            <span>{t('session.presentation.slideBackground')}</span>
            <input type="color" value={draft.background} onChange={(event) => setDraft((value) => ({ ...value, background: event.target.value }))} className="h-9 w-20 rounded border border-border-subtle bg-transparent" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span>{t('session.presentation.masterTitleFont')}</span>
            <select value={draft.titleFontFamily} onChange={(event) => setDraft((value) => ({ ...value, titleFontFamily: event.target.value }))} className="h-9 rounded-md border border-border-subtle bg-bg-app px-2 text-text-primary">
              {fontFamilies.map((font) => <option key={font} value={font}>{font}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span>{t('session.presentation.masterBodyFont')}</span>
            <select value={draft.bodyFontFamily} onChange={(event) => setDraft((value) => ({ ...value, bodyFontFamily: event.target.value }))} className="h-9 rounded-md border border-border-subtle bg-bg-app px-2 text-text-primary">
              {fontFamilies.map((font) => <option key={font} value={font}>{font}</option>)}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1.5">
            <span>{t('session.presentation.footer')}</span>
            <input value={draft.footer.text} onChange={(event) => setDraft((value) => ({ ...value, footer: { ...value.footer, text: event.target.value } }))} className="h-9 rounded-md border border-border-subtle bg-bg-app px-3 text-text-primary" />
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={draft.footer.showDate} onChange={(event) => setDraft((value) => ({ ...value, footer: { ...value.footer, showDate: event.target.checked } }))} />{t('session.presentation.insertDialog.showDate')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={draft.footer.showSlideNumber} onChange={(event) => setDraft((value) => ({ ...value, footer: { ...value.footer, showSlideNumber: event.target.checked } }))} />{t('session.presentation.insertDialog.showSlideNumber')}</label>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
          <button type="button" onClick={onClose} className="h-8 rounded-md border border-border-subtle px-4 text-xs text-text-secondary hover:bg-bg-hover">{t('common.cancel')}</button>
          <button type="submit" className="h-8 rounded-md bg-brand-purple px-4 text-xs font-semibold text-white hover:opacity-90">{t('session.presentation.applyToAll')}</button>
        </div>
      </form>
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

function SlideshowOverlay({ current, onActivateHyperlink, onClose, onNext, onPrevious, onTransitionComplete, pageSize, slide, total, transitionRun }: {
  current: number
  onActivateHyperlink: (hyperlink: PresentationHyperlink) => void
  onClose: () => void
  onNext: () => void
  onPrevious: () => void
  onTransitionComplete: () => void
  pageSize: PresentationPageSize
  slide: PresentationSlide
  total: number
  transitionRun: SlideshowTransitionView | null
}) {
  const { t } = useTranslation()
  const steps = useMemo(() => buildPresentationAnimationPlaybackSteps(slide.elements), [slide.elements])
  const [completedTargetIds, setCompletedTargetIds] = useState<Set<string>>(() => new Set())
  const [runningStepId, setRunningStepId] = useState<string | null>(null)
  const [animationRunKey, setAnimationRunKey] = useState(0)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 1_280 : window.innerWidth,
    height: typeof window === 'undefined' ? 720 : window.innerHeight,
  }))
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningStep = steps.find((step) => step.id === runningStepId) ?? null
  const slideshowRatio = pageSize.width / pageSize.height
  const slideshowWidth = Math.max(320, Math.floor(Math.min(
    Math.max(320, viewport.width - 56),
    Math.max(180, viewport.height - 132) * slideshowRatio,
  )))
  const slideshowHeight = slideshowWidth * (pageSize.height / pageSize.width)
  const slideshowScale = slideshowWidth / pageSize.width
  const slideshowProgress = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0
  const hiddenElementIds = useMemo(() => (
    getPresentationAnimationHiddenElementIds(slide.elements, completedTargetIds)
  ), [completedTargetIds, slide.elements])
  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 2_400)
  }, [])
  const startStep = useCallback((step: (typeof steps)[number]) => {
    if (transitionRun || runningStepId) return
    setRunningStepId(step.id)
    setAnimationRunKey((value) => value + 1)
  }, [runningStepId, transitionRun])
  const advance = useCallback(() => {
    if (transitionRun || runningStepId) return
    const nextStep = steps.find((step) => (
      step.trigger === 'slideClick' && step.targetIds.some((targetId) => !completedTargetIds.has(targetId))
    ))
    if (nextStep) {
      startStep(nextStep)
      return
    }
    onNext()
  }, [completedTargetIds, onNext, runningStepId, startStep, steps, transitionRun])

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 2_400)
    return () => {
      window.removeEventListener('resize', onResize)
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolvePresentationSlideshowKeyAction(event.target, event.key)
      if (action === 'close') {
        onClose()
      } else if (action === 'next') {
        event.preventDefault()
        revealControls()
        advance()
      } else if (action === 'previous') {
        event.preventDefault()
        revealControls()
        onPrevious()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [advance, onClose, onPrevious, revealControls])

  const completeRunningStep = () => {
    if (!runningStep) return
    setCompletedTargetIds((completed) => new Set([...completed, ...runningStep.targetIds]))
    setRunningStepId(null)
  }

  let slideshowContent: ReactNode
  if (transitionRun) {
    slideshowContent = (
      <PresentationTransitionPlayer
        previous={<PresentationSlidePreview pageSize={pageSize} slide={transitionRun.previousSlide} slideNumber={transitionRun.fromIndex + 1} width={slideshowWidth} selected={false} presentation suppressMediaPlayback onActivateHyperlink={onActivateHyperlink} />}
        current={<PresentationSlidePreview pageSize={pageSize} hiddenElementIds={hiddenElementIds} slide={transitionRun.currentSlide} slideNumber={transitionRun.toIndex + 1} width={slideshowWidth} selected={false} presentation suppressMediaPlayback onActivateHyperlink={onActivateHyperlink} />}
        transition={transitionRun.transition}
        runKey={transitionRun.runKey}
        direction={transitionRun.direction}
        onComplete={onTransitionComplete}
        className="size-full"
      />
    )
  } else if (runningStep) {
    slideshowContent = (
      <PresentationAnimationPlayer
        baseHiddenElementIds={hiddenElementIds}
        className="size-full"
        elementIds={runningStep.elementIds}
        onComplete={completeRunningStep}
        pageSize={pageSize}
        runKey={animationRunKey}
        slide={slide}
        slideNumber={current}
        width={slideshowWidth}
      />
    )
  } else {
    slideshowContent = <PresentationSlidePreview pageSize={pageSize} hiddenElementIds={hiddenElementIds} slide={slide} slideNumber={current} width={slideshowWidth} selected={false} presentation onActivateHyperlink={onActivateHyperlink} />
  }

  return (
    <div
      role="dialog"
      aria-label={t('session.presentation.slideshow')}
      aria-modal="true"
      className={cn(
        'app-no-drag fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-[#08090D] text-white',
        !controlsVisible && 'cursor-none',
      )}
      data-testid="presentation-slideshow"
      data-controls-visible={controlsVisible}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_44%,rgba(88,91,112,0.34)_0%,rgba(26,27,36,0.26)_46%,rgba(8,9,13,0)_72%),linear-gradient(180deg,#111219_0%,#08090D_100%)]" />
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-between px-5 py-4 transition-all duration-300',
          controlsVisible ? 'translate-y-0 opacity-100' : '-translate-y-3 opacity-0',
        )}
        data-testid="presentation-slideshow-header"
      >
        <span className="rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[11px] font-medium tracking-wide text-white/65 shadow-sm backdrop-blur-xl">
          {t('session.presentation.slideshow')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('session.presentation.closeSlideshow')}
          className="pointer-events-auto flex h-9 items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 text-xs text-white/75 shadow-lg backdrop-blur-xl transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <X className="size-4" />
          <span>{t('session.presentation.closeSlideshow')}</span>
          <kbd className="rounded border border-white/10 bg-white/10 px-1.5 py-0.5 font-sans text-[9px] text-white/55">Esc</kbd>
        </button>
      </div>
      <div className="relative z-10 flex size-full items-center justify-center" data-testid="presentation-slideshow-stage">
        <div
          className="relative shrink-0 overflow-hidden rounded-[3px] ring-1 ring-white/10 shadow-[0_32px_90px_rgba(0,0,0,0.58),0_6px_24px_rgba(0,0,0,0.44)]"
          style={{ width: slideshowWidth, height: slideshowHeight }}
          data-testid="presentation-slideshow-frame"
          onClick={(event) => {
            const target = event.target instanceof HTMLElement ? event.target : null
            if (target?.closest('button, a, audio, video')) return
            advance()
          }}
        >
          {slideshowContent}
          {!transitionRun && !runningStep ? steps.filter((step) => (
            step.trigger === 'elementClick' && step.targetIds.some((targetId) => !completedTargetIds.has(targetId))
          )).map((step) => (
            <button
              key={step.id}
              type="button"
              aria-label={t('session.presentation.triggerElementClick')}
              className="absolute z-20 bg-transparent"
              style={{
                left: step.bounds.x * slideshowScale,
                top: step.bounds.y * slideshowScale,
                width: step.bounds.width * slideshowScale,
                height: step.bounds.height * slideshowScale,
              }}
              onClick={(event) => {
                event.stopPropagation()
                startStep(step)
              }}
            />
          )) : null}
        </div>
      </div>
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4 transition-all duration-300',
          controlsVisible ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0',
        )}
      >
        <div
          className="pointer-events-auto flex h-12 items-center gap-1.5 rounded-full border border-white/10 bg-[#15161C]/78 p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.46)] backdrop-blur-2xl"
          data-testid="presentation-slideshow-controls"
          onPointerMove={revealControls}
        >
          <button
            type="button"
            disabled={current <= 1 || Boolean(transitionRun)}
            onClick={onPrevious}
            aria-label={t('session.presentation.previousSlide')}
            className="flex size-9 items-center justify-center rounded-full text-white/75 transition-colors hover:bg-white/12 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default disabled:text-white/20"
          >
            <ChevronLeft className="size-[18px]" />
          </button>
          <div className="flex w-36 flex-col gap-1 px-2 sm:w-44">
            <div className="flex items-center justify-between text-[10px] font-medium tabular-nums text-white/60">
              <span>{current} / {total}</span>
              <span>{Math.round(slideshowProgress)}%</span>
            </div>
            <span
              role="progressbar"
              aria-label={t('session.presentation.pageCount', { current, total })}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={current}
              className="h-1 overflow-hidden rounded-full bg-white/12"
              data-testid="presentation-slideshow-progress"
            >
              <span className="block h-full rounded-full bg-white/80 transition-[width] duration-300" style={{ width: `${slideshowProgress}%` }} />
            </span>
          </div>
          <button
            type="button"
            disabled={(current >= total && !steps.some((step) => step.trigger === 'slideClick' && step.targetIds.some((targetId) => !completedTargetIds.has(targetId)))) || Boolean(transitionRun) || Boolean(runningStep)}
            onClick={advance}
            aria-label={t('session.presentation.nextSlide')}
            className="flex size-9 items-center justify-center rounded-full bg-white text-[#171820] shadow-sm transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default disabled:bg-white/10 disabled:text-white/25"
          >
            <ChevronRight className="size-[18px]" />
          </button>
        </div>
      </div>
    </div>
  )
}

function PresentationLayersInspector({ currentSlide, onClose, onMoveElement, onSelectElement, selectedElement }: {
  currentSlide: PresentationSlide | undefined
  onClose: () => void
  onMoveElement: (direction: 'front' | 'back') => void
  onSelectElement: (elementId: string) => void
  selectedElement: PresentationElement | null
}) {
  const { t } = useTranslation()
  const elements = [...(currentSlide?.elements ?? [])].reverse()
  return (
    <aside className="w-[238px] shrink-0 overflow-y-auto border-l border-border-subtle/60 bg-bg-surface/90" data-testid="presentation-layers-pane">
      <div className="flex h-12 items-center justify-between border-b border-border-subtle/60 px-4">
        <h3 className="text-sm font-semibold text-text-primary">{t('session.presentation.allLayers')}</h3>
        <button type="button" onClick={onClose} aria-label={t('session.presentation.closePane')} className="flex size-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"><X className="size-4" /></button>
      </div>
      <div className="flex gap-1 border-b border-border-subtle/60 p-2">
        <button type="button" disabled={!selectedElement} onClick={() => onMoveElement('front')} className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-35"><ChevronRight className="size-3.5 -rotate-90" />{t('session.presentation.moveUp')}</button>
        <button type="button" disabled={!selectedElement} onClick={() => onMoveElement('back')} className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-35"><ChevronRight className="size-3.5 rotate-90" />{t('session.presentation.moveDown')}</button>
      </div>
      <div className="space-y-1 p-2">
        {elements.map((element, index) => {
          const label = isPresentationTextElement(element) && element.text.trim()
            ? element.text.trim().replace(/\s+/g, ' ').slice(0, 32)
            : element.type
          return (
            <button
              key={element.id}
              type="button"
              aria-pressed={selectedElement?.id === element.id}
              data-presentation-layer-id={element.id}
              onClick={() => onSelectElement(element.id)}
              className={cn(
                'flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-text-secondary hover:bg-bg-hover',
                selectedElement?.id === element.id && 'bg-brand-purple/10 text-brand-purple',
              )}
            >
              <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-text-tertiary">{elements.length - index}</span>
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function PresentationCommentsInspector({ comments, onAdd, onClose, onSelectElement, onUpdate }: {
  comments: readonly PresentationComment[]
  onAdd: (text: string) => void
  onClose: () => void
  onSelectElement: (elementId: string) => void
  onUpdate: (commentId: string, patch: Partial<PresentationComment>) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const submit = () => {
    if (!draft.trim()) return
    onAdd(draft)
    setDraft('')
  }
  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-l border-border-subtle/60 bg-bg-surface/95" data-testid="presentation-comments-pane">
      <div className="flex h-12 items-center justify-between border-b border-border-subtle/60 px-4">
        <h3 className="text-sm font-semibold text-text-primary">{t('session.presentation.comments')}</h3>
        <button type="button" onClick={onClose} aria-label={t('session.presentation.closePane')} className="flex size-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover"><X className="size-4" /></button>
      </div>
      <div className="border-b border-border-subtle/60 p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('session.presentation.commentPlaceholder')}
          className="h-20 w-full resize-none rounded-md border border-border-subtle bg-bg-app p-2 text-xs text-text-primary outline-none focus:border-brand-purple"
          data-testid="presentation-comment-input"
        />
        <button type="button" disabled={!draft.trim()} onClick={submit} className="mt-2 h-8 w-full rounded-md bg-brand-purple text-xs font-semibold text-white disabled:opacity-35" data-testid="presentation-add-comment">{t('session.presentation.addComment')}</button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {comments.length === 0 ? <p className="py-8 text-center text-xs text-text-tertiary">{t('session.presentation.noComments')}</p> : null}
        {[...comments].reverse().map((comment) => (
          <article key={comment.id} className={cn('rounded-lg border border-border-subtle bg-bg-app p-3', comment.resolved && 'opacity-55')} data-presentation-comment-id={comment.id}>
            <div className="flex items-center justify-between gap-2">
              <strong className="truncate text-xs text-text-primary">{comment.author}</strong>
              <time className="shrink-0 text-[9px] text-text-tertiary">{new Date(comment.createdAt).toLocaleDateString()}</time>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">{comment.text}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {comment.elementId ? <button type="button" onClick={() => onSelectElement(comment.elementId!)} className="rounded px-1.5 py-1 text-[10px] text-brand-purple hover:bg-brand-purple/10">{t('session.presentation.showCommentTarget')}</button> : null}
              <button type="button" onClick={() => onUpdate(comment.id, { resolved: !comment.resolved })} className="rounded px-1.5 py-1 text-[10px] text-text-secondary hover:bg-bg-hover">{t(comment.resolved ? 'session.presentation.reopenComment' : 'session.presentation.resolveComment')}</button>
              <button type="button" onClick={() => onUpdate(comment.id, { text: '' })} className="rounded px-1.5 py-1 text-[10px] text-status-error hover:bg-status-error/10">{t('session.presentation.deleteComment')}</button>
            </div>
          </article>
        ))}
      </div>
    </aside>
  )
}

function AnimationInspector({ currentSlide, onClose, onElementChange, onPreviewAnimation, onSelectElement, selectedElement }: {
  currentSlide: PresentationSlide | undefined
  onClose: () => void
  onElementChange: (patch: Partial<PresentationElement>) => void
  onPreviewAnimation: (animationOverride?: Partial<PresentationElement>) => void
  onSelectElement: (elementId: string) => void
  selectedElement: PresentationElement | null
}) {
  const { t } = useTranslation()
  const animationTargets = getPresentationAnimationTargets(currentSlide?.elements ?? [])
  const animation = selectedElement ? normalizePresentationAnimation(selectedElement) : null
  const effectOptions: PresentationAnimationEffect[] = [
    'appear',
    'fade',
    'blinds',
    'checkerboard',
    'dissolve',
    'flyIn',
    'floatIn',
    'split',
    'wipeIn',
    'zoomIn',
    'zoom',
    'fillColor',
    'textColor',
    'disappear',
    'blindsOut',
  ]
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
          onClick={() => {
            const patch: Partial<PresentationElement> = { animation: hasPresentationAnimation(selectedElement) ? selectedElement!.animation : 'appear' }
            onElementChange(patch)
            onPreviewAnimation(patch)
          }}
          className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-40"
          data-testid="presentation-animation-pane-add"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-[#2678E8] text-sm font-semibold text-white">+</span>
          {t('session.presentation.addAnimation')}
        </button>
        {animationTargets.length > 0 ? (
          <div className="space-y-1" data-testid="presentation-animation-pane-list">
            {animationTargets.map((target, index) => {
              const element = target.animationElement
              return (
                <button
                  key={target.id}
                  type="button"
                  aria-pressed={element.id === selectedElement?.id}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-hover',
                    element.id === selectedElement?.id && 'bg-brand-purple/10 text-brand-purple',
                  )}
                  onClick={() => onSelectElement(element.id)}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#2678E8] text-[10px] font-semibold text-white">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{isPresentationTextElement(element) ? element.text || element.type : element.type}</span>
                  <span className="shrink-0 text-[10px]">{t(presentationAnimationLabelKeys[element.animation ?? 'none'])}</span>
                </button>
              )
            })}
          </div>
        ) : null}
        {selectedElement && hasPresentationAnimation(selectedElement) && animation ? (
          <div className="rounded-lg border border-border-subtle bg-bg-app/60 p-3">
            <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
              {t('session.presentation.animationEffect')}
              <select
                aria-label={t('session.presentation.animationEffect')}
                value={animation.effect}
                onChange={(event) => {
                  const patch: Partial<PresentationElement> = { animation: event.target.value as PresentationAnimationEffect }
                  onElementChange(patch)
                  onPreviewAnimation(patch)
                }}
                className="h-7 w-28 rounded-md border border-border-default bg-bg-surface px-1 text-xs outline-none focus:border-brand-purple"
              >
                {effectOptions.map((effect) => <option key={effect} value={effect}>{t(presentationAnimationLabelKeys[effect])}</option>)}
              </select>
            </label>
            <label className="mt-3 flex items-center justify-between gap-2 text-xs text-text-secondary">
              {t('session.presentation.startMode')}
              <select
                aria-label={t('session.presentation.startMode')}
                value={animation.start}
                onChange={(event) => onElementChange({ animationStart: event.target.value as 'onClick' | 'withPrevious' | 'afterPrevious' })}
                className="h-7 w-28 rounded-md border border-border-default bg-bg-surface px-1 text-xs outline-none focus:border-brand-purple"
              >
                <option value="onClick">{t('session.presentation.startOnClick')}</option>
                <option value="withPrevious">{t('session.presentation.startWithPrevious')}</option>
                <option value="afterPrevious">{t('session.presentation.startAfterPrevious')}</option>
              </select>
            </label>
            <label className="mt-3 flex items-center justify-between gap-2 text-xs text-text-secondary">
              {t('session.presentation.delay')}
              <input
                type="number"
                min={0}
                step={0.1}
                value={Number((animation.delayMs / 1000).toFixed(2))}
                onChange={(event) => onElementChange({ animationDelay: Math.round(Math.max(0, Number(event.target.value) || 0) * 1000) })}
                className="h-7 w-20 rounded-md border border-border-default bg-bg-surface px-2 text-right text-xs outline-none focus:border-brand-purple"
              />
            </label>
            <label className="mt-3 flex items-center justify-between gap-2 text-xs text-text-secondary">
              {t('session.presentation.duration')}
              <input
                type="number"
                min={0.18}
                step={0.1}
                value={Number((animation.durationMs / 1000).toFixed(2))}
                onChange={(event) => onElementChange({ animationDuration: Math.round(Math.max(0.18, Number(event.target.value) || 0.18) * 1000) })}
                className="h-7 w-20 rounded-md border border-border-default bg-bg-surface px-2 text-right text-xs outline-none focus:border-brand-purple"
              />
            </label>
            <button
              type="button"
              className="mt-3 h-8 w-full rounded-md border border-border-default text-xs text-status-error hover:bg-bg-hover"
              onClick={() => onElementChange({ animation: 'none', animationColor: undefined, animationDelay: undefined, animationDuration: undefined, animationStart: undefined, animationTrigger: undefined })}
            >
              {t('session.presentation.removeAnimation')}
            </button>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-text-tertiary">{selectedElement ? t('session.presentation.addAnimationHint') : t('session.presentation.selectElementForAnimation')}</p>
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
