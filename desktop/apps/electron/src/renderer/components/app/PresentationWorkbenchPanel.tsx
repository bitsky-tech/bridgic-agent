import {
  useCallback,
  useEffect,
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
  type PresentationShapeElement,
  type PresentationShapeType,
  type PresentationSlide,
  type PresentationTextElement,
} from '@/atoms/presentation'
import { setRightPanelCollapsedAtom } from '@/atoms/layout'
import { viewedSessionIdAtom } from '@/atoms/navigation'
import { Tooltip } from '@/components/amphi/Tooltip'
import { cn } from '@/lib/cn'
import {
  getPresentationShapeDefinition,
  getPresentationShapeSize,
  isPresentationLineShape,
} from '@/lib/presentationShapes'
import {
  PresentationRibbon,
  type PresentationRibbonTab,
} from './PresentationRibbon'

export interface PresentationWorkbenchPanelProps {
  active: boolean
}

type ExportState = 'idle' | 'exporting' | 'saved' | 'error'

function cloneDocument(document: PresentationDocument): PresentationDocument {
  return structuredClone(document)
}

function isTextElement(element: PresentationElement): element is PresentationTextElement {
  return element.type === 'text'
}

/** A focused PowerPoint-style editor embedded in the Session workbench. */
export function PresentationWorkbenchPanel({ active }: PresentationWorkbenchPanelProps) {
  const { t } = useTranslation()
  const sessionId = useAtomValue(viewedSessionIdAtom)
  const [workspace, setWorkspace] = useAtom(currentPresentationWorkspaceAtom)
  const [document, setDocument] = useAtom(currentPresentationDocumentAtom)
  const [expanded, setExpanded] = useAtom(presentationExpandedAtom)
  const setRightCollapsed = useSetAtom(setRightPanelCollapsedAtom)
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
  const [historyStatus, setHistoryStatus] = useState({ canUndo: false, canRedo: false })
  const [exportState, setExportState] = useState<ExportState>('idle')
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasFrameRef = useRef<HTMLDivElement>(null)
  const canvasElementRef = useRef<HTMLCanvasElement>(null)
  const canvasRef = useRef<FabricCanvas | null>(null)
  const fabricModuleRef = useRef<typeof import('fabric') | null>(null)
  const objectIdsRef = useRef(new WeakMap<FabricObject, string>())
  const documentRef = useRef(document)
  const selectedElementIdRef = useRef<string | null>(null)
  const pastRef = useRef<PresentationDocument[]>([])
  const futureRef = useRef<PresentationDocument[]>([])

  const currentSlide = document.slides.find((slide) => slide.id === document.selectedSlideId)
    ?? document.slides[0]
  const selectedElement = currentSlide?.elements.find((element) => (
    element.id === selectedElementId
  )) ?? null
  const selectedText = selectedElement && isTextElement(selectedElement) ? selectedElement : null

  const commitDocument = useCallback((next: PresentationDocument, recordHistory = true) => {
    const current = documentRef.current
    if (recordHistory) {
      pastRef.current = [...pastRef.current, cloneDocument(current)].slice(-50)
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
    const scaleX = object.scaleX ?? 1
    const scaleY = object.scaleY ?? 1
    const patch: Partial<PresentationElement> = {
      x: Math.round(object.left),
      y: Math.round(object.top),
      width: Math.max(8, Math.round((object.width ?? 0) * scaleX)),
      height: Math.max(8, Math.round((object.height ?? 0) * scaleY)),
      rotation: Math.round(object.angle ?? 0),
    }
    if ('text' in object && typeof object.text === 'string') {
      const current = documentRef.current
      const slide = current.slides.find((item) => item.id === current.selectedSlideId)
      const element = slide?.elements.find((item) => item.id === elementId)
      const text = element?.type === 'text'
        ? stripPresentationListMarkers(object.text, element.listStyle)
        : object.text
      Object.assign(patch, { text })
    }
    patchElement(elementId, patch)
  }, [patchElement])

  useEffect(() => {
    documentRef.current = document
  }, [document])

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
      setSelectedElementId(null)
      setHistoryStatus({ canUndo: false, canRedo: false })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [document.id, sessionId])

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
    const activeElementId = selectedElementIdRef.current
    canvas.clear()
    canvas.backgroundColor = currentSlide.background
    objectIdsRef.current = new WeakMap()
    let activeObject: FabricObject | null = null
    for (const element of currentSlide.elements) {
      let object: FabricObject
      if (element.type === 'text') {
        const textbox = new fabric.Textbox(formatPresentationText(element), {
          left: element.x,
          top: element.y,
          width: element.width,
          angle: element.rotation,
          originX: 'left',
          originY: 'top',
          fill: element.color,
          fontFamily: element.fontFamily,
          fontSize: element.fontSize,
          fontWeight: element.fontWeight,
          fontStyle: element.italic ? 'italic' : 'normal',
          lineHeight: element.lineHeight ?? 1.08,
          textAlign: element.align,
          underline: Boolean(element.underline),
          linethrough: Boolean(element.strikethrough),
          textBackgroundColor: element.highlightColor ?? '',
          charSpacing: element.characterSpacing ?? 0,
          padding: (element.indentLevel ?? 0) * 16,
          shadow: element.shadow ? new fabric.Shadow({ color: 'rgba(20, 20, 32, 0.28)', blur: 12, offsetX: 6, offsetY: 6 }) : undefined,
          splitByGrapheme: false,
        })
        if (element.baseline === 'superscript') textbox.setSuperscript(0, textbox.text.length)
        if (element.baseline === 'subscript') textbox.setSubscript(0, textbox.text.length)
        textbox.on('editing:exited', () => syncFabricObjectRef.current(textbox))
        object = textbox
      } else if (element.type === 'ellipse') {
        object = new fabric.Ellipse({
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
          shadow: element.shadow ? new fabric.Shadow({ color: 'rgba(20, 20, 32, 0.22)', blur: 12, offsetX: 6, offsetY: 6 }) : undefined,
        })
      } else if (element.type === 'rect' || element.type === 'roundRect') {
        object = new fabric.Rect({
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
          shadow: element.shadow ? new fabric.Shadow({ color: 'rgba(20, 20, 32, 0.22)', blur: 12, offsetX: 6, offsetY: 6 }) : undefined,
        })
      } else {
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
          shadow: element.shadow ? new fabric.Shadow({ color: 'rgba(20, 20, 32, 0.22)', blur: 12, offsetX: 6, offsetY: 6 }) : undefined,
        })
        path.set({
          scaleX: element.width / Math.max(1, path.width ?? 1),
          scaleY: element.height / Math.max(1, path.height ?? 1),
        })
        object = path
      }
      object.set({
        borderColor: '#6957D9',
        cornerColor: '#FFFFFF',
        cornerStrokeColor: '#6957D9',
        cornerStyle: 'circle',
        cornerSize: 11,
        transparentCorners: false,
        objectCaching: false,
      })
      objectIdsRef.current.set(object, element.id)
      canvas.add(object)
      if (element.id === activeElementId) activeObject = object
    }
    if (activeObject) canvas.setActiveObject(activeObject)
    canvas.requestRenderAll()
  }, [active, canvasGeneration, currentSlide])

  const undo = useCallback(() => {
    const previous = pastRef.current.pop()
    if (!previous) return
    futureRef.current.push(cloneDocument(documentRef.current))
    commitDocument(previous, false)
  }, [commitDocument])

  const redo = useCallback(() => {
    const next = futureRef.current.pop()
    if (!next) return
    pastRef.current.push(cloneDocument(documentRef.current))
    commitDocument(next, false)
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
    if (!active) return
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
  }, [active, deleteSelectedElement, redo, undo])

  useEffect(() => {
    if (!slideshowOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSlideshowOpen(false)
      else if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault()
        setSlideshowIndex((index) => Math.min(document.slides.length - 1, index + 1))
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setSlideshowIndex((index) => Math.max(0, index - 1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [document.slides.length, slideshowOpen])

  const selectSlide = (slideId: string) => {
    setSelectedElementId(null)
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
        id: createPresentationId(element.type === 'text' ? 'text' : 'shape'),
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

  const updateSelectedElement = (patch: Partial<PresentationElement>) => {
    if (selectedElement) patchElement(selectedElement.id, patch)
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

  const previewTransition = () => {
    const frame = canvasFrameRef.current
    const transition = currentSlide?.transition ?? 'none'
    if (!frame || transition === 'none') return
    frame.style.animation = 'none'
    void frame.offsetWidth
    frame.style.animation = `presentation-${transition} 520ms cubic-bezier(0.22, 1, 0.36, 1)`
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
    setSlideshowIndex(Math.max(0, index))
    setSlideshowOpen(true)
  }

  const startSlideshowFromBeginning = () => {
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
  let exportLabel = t('session.presentation.export')
  if (exportState === 'exporting') exportLabel = t('session.presentation.exporting')
  else if (exportState === 'saved') exportLabel = t('session.presentation.exported')
  else if (exportState === 'error') exportLabel = t('session.presentation.exportFailed')

  const slideshowSlide = document.slides[slideshowIndex] ?? currentSlide

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
        onApplyFormat={patchElement}
        onFindText={findText}
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
                      <SlidePreview slide={slide} width={previewWidth} selected={slide.id === currentSlide?.id} />
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
                ref={canvasFrameRef}
                className="relative shrink-0 overflow-hidden ring-1 ring-black/5 shadow-[0_24px_62px_rgba(30,27,48,0.18),0_3px_12px_rgba(30,27,48,0.1)] dark:ring-white/10"
                style={{ width: PRESENTATION_WIDTH * canvasScale, height: PRESENTATION_HEIGHT * canvasScale }}
              >
                <div className="absolute left-0 top-0 origin-top-left" style={{ width: PRESENTATION_WIDTH, height: PRESENTATION_HEIGHT, transform: `scale(${canvasScale})` }}>
                  <canvas ref={canvasElementRef} aria-label={t('session.presentation.canvasAria')} />
                </div>
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

      {slideshowOpen && slideshowSlide ? (
        <SlideshowOverlay
          current={slideshowIndex + 1}
          slide={slideshowSlide}
          total={document.slides.length}
          onClose={() => setSlideshowOpen(false)}
          onNext={() => setSlideshowIndex((index) => Math.min(document.slides.length - 1, index + 1))}
          onPrevious={() => setSlideshowIndex((index) => Math.max(0, index - 1))}
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

function SlideshowOverlay({ current, onClose, onNext, onPrevious, slide, total }: {
  current: number
  onClose: () => void
  onNext: () => void
  onPrevious: () => void
  slide: PresentationSlide
  total: number
}) {
  const { t } = useTranslation()
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[#101116]/96 p-4 text-white backdrop-blur-sm" data-testid="presentation-slideshow">
      <div className="flex h-9 shrink-0 items-center justify-between text-xs text-white/65">
        <span>{t('session.presentation.pageCount', { current, total })}</span>
        <button type="button" onClick={onClose} aria-label={t('session.presentation.closeSlideshow')} className="flex size-8 items-center justify-center rounded-full bg-white/10 text-white/75 hover:bg-white/15 hover:text-white"><X className="size-4" /></button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto py-4">
        <SlidePreview slide={slide} width={960} selected={false} presentation />
      </div>
      <div className="flex h-10 shrink-0 items-center justify-center gap-4">
        <button type="button" disabled={current <= 1} onClick={onPrevious} aria-label={t('session.presentation.previousSlide')} className="flex size-8 items-center justify-center rounded-full bg-white/10 hover:bg-white/15 disabled:opacity-25"><ChevronLeft className="size-4" /></button>
        <span className="min-w-16 text-center text-xs text-white/70">{current} / {total}</span>
        <button type="button" disabled={current >= total} onClick={onNext} aria-label={t('session.presentation.nextSlide')} className="flex size-8 items-center justify-center rounded-full bg-white/10 hover:bg-white/15 disabled:opacity-25"><ChevronRight className="size-4" /></button>
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
  onElementChange,
  onSlideBackgroundChange,
}: {
  currentSlide: PresentationSlide | undefined
  selectedElement: PresentationElement | null
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
          <ColorField
            label={t(isTextElement(selectedElement) ? 'session.presentation.textColor' : 'session.presentation.fill')}
            value={isTextElement(selectedElement) ? selectedElement.color : selectedElement.fill}
            onChange={(value) => onElementChange(isTextElement(selectedElement)
              ? { color: value }
              : { fill: value })}
          />
          {isTextElement(selectedElement) ? (
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
              <NumberField
                label={t('session.presentation.fontSize')}
                value={selectedElement.fontSize}
                min={8}
                onChange={(value) => onElementChange({ fontSize: value })}
              />
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="X" value={selectedElement.x} onChange={(value) => onElementChange({ x: value })} />
            <NumberField label="Y" value={selectedElement.y} onChange={(value) => onElementChange({ y: value })} />
            <NumberField label={t('session.presentation.width')} value={selectedElement.width} min={8} onChange={(value) => onElementChange({ width: value })} />
            <NumberField label={t('session.presentation.height')} value={selectedElement.height} min={8} onChange={(value) => onElementChange({ height: value })} />
          </div>
          <NumberField
            label={t('session.presentation.rotation')}
            value={selectedElement.rotation}
            onChange={(value) => onElementChange({ rotation: value })}
          />
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

function SlidePreview({ slide, width, selected, presentation = false }: { slide: PresentationSlide; width: number; selected: boolean; presentation?: boolean }) {
  const scale = width / PRESENTATION_WIDTH
  return (
    <span
      className={cn(
        'relative block shrink-0 overflow-hidden bg-white',
        presentation ? 'rounded-sm shadow-[0_24px_72px_rgba(0,0,0,0.5)]' : 'rounded border shadow-sm',
        !presentation && (selected ? 'border-brand-purple ring-1 ring-brand-purple/25' : 'border-border-default'),
      )}
      style={{ width, height: width * (PRESENTATION_HEIGHT / PRESENTATION_WIDTH) }}
      aria-hidden="true"
    >
      <span
        className="absolute left-0 top-0 block origin-top-left overflow-hidden"
        style={{
          width: PRESENTATION_WIDTH,
          height: PRESENTATION_HEIGHT,
          transform: `scale(${scale})`,
          backgroundColor: slide.background,
        }}
      >
        {slide.elements.map((element) => (
          element.type === 'text' ? (
            <span
              key={element.id}
              className="absolute block whitespace-pre-wrap overflow-hidden"
              style={{
                left: element.x,
                top: element.y,
                width: element.width,
                height: element.height,
                transform: `rotate(${element.rotation}deg)`,
                transformOrigin: 'top left',
                color: element.color,
                fontFamily: element.fontFamily,
                fontSize: element.fontSize,
                fontWeight: element.fontWeight,
                fontStyle: element.italic ? 'italic' : 'normal',
                lineHeight: element.lineHeight ?? 1.08,
                textAlign: element.align,
                textDecoration: [
                  element.underline ? 'underline' : '',
                  element.strikethrough ? 'line-through' : '',
                ].filter(Boolean).join(' ') || undefined,
                textShadow: element.shadow ? '5px 6px 12px rgba(20, 20, 32, 0.28)' : undefined,
                backgroundColor: element.highlightColor,
                letterSpacing: `${(element.characterSpacing ?? 0) / 1000}em`,
                paddingLeft: (element.indentLevel ?? 0) * 16,
              }}
            >
              {formatPresentationText(element)}
            </span>
          ) : <SlideShapePreview key={element.id} element={element} />
        ))}
      </span>
    </span>
  )
}

function SlideShapePreview({ element }: { element: PresentationShapeElement }) {
  const definition = getPresentationShapeDefinition(element.type)
  const strokeOnly = definition.strokeOnly || isPresentationLineShape(element.type)
  const shape = element.type === 'rect' || element.type === 'roundRect' ? (
    <rect
      x="0"
      y="0"
      width="100"
      height="100"
      rx={element.type === 'roundRect' ? 12 : Math.min(50, ((element.radius ?? 0) / element.width) * 100)}
      ry={element.type === 'roundRect' ? 12 : Math.min(50, ((element.radius ?? 0) / element.height) * 100)}
      fill={element.fill}
      stroke={element.borderColor}
      strokeWidth={element.borderWidth}
      vectorEffect="non-scaling-stroke"
    />
  ) : (
    <path
      d={definition.path}
      fill={strokeOnly ? 'none' : element.fill}
      fillRule="evenodd"
      stroke={element.borderColor}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeOnly ? Math.max(3, element.borderWidth) : element.borderWidth}
      vectorEffect="non-scaling-stroke"
    />
  )
  return (
    <svg
      className="absolute block overflow-visible"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
        transform: `rotate(${element.rotation}deg)`,
        transformOrigin: 'top left',
        filter: element.shadow ? 'drop-shadow(5px 6px 6px rgba(20, 20, 32, 0.22))' : undefined,
      }}
    >
      {shape}
    </svg>
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

function NumberField({ label, min, value, onChange }: {
  label: string
  min?: number
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="block text-2xs font-medium text-text-tertiary">
      {label}
      <input
        type="number"
        min={min}
        value={Math.round(value)}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
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
