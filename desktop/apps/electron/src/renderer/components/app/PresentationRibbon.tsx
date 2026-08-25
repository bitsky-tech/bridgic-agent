import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  AudioLines,
  BarChart3,
  Blend,
  BookOpen,
  Box,
  BringToFront,
  CaseUpper,
  Clock3,
  Columns3,
  ChevronsUpDown,
  Eraser,
  Eye,
  EyeOff,
  FilePlus2,
  FlipHorizontal2,
  GalleryHorizontal,
  Grid3X3,
  Group,
  Image,
  IndentDecrease,
  IndentIncrease,
  LayoutGrid,
  Layers3,
  Link2,
  List,
  ListPlus,
  ListOrdered,
  Maximize,
  MousePointerClick,
  Paintbrush,
  PaintBucket,
  Palette,
  PanelTop,
  Play,
  PlusCircle,
  Printer,
  Ratio,
  Redo2,
  RotateCw,
  Rows3,
  Ruler,
  Search,
  SendToBack,
  Shapes,
  Sparkles,
  Square,
  StickyNote,
  Table2,
  Timer,
  Type,
  Undo2,
  Video,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'
import type {
  PresentationAnimationEffect,
  PresentationElement,
  PresentationShapeType,
  PresentationSlide,
  PresentationTextElement,
  PresentationTransition,
  PresentationTransitionDirection,
  PresentationTransitionEffect,
} from '@/atoms/presentation'
import { Tooltip } from '@/components/amphi/Tooltip'
import { cn } from '@/lib/cn'
import { getPresentationShapeName, isPresentationLineShape, presentationShapeCategories } from '@/lib/presentationShapes'
import {
  changePresentationTransitionEffect,
  getPresentationTransitionDefinition,
  normalizePresentationTransition,
  presentationTransitionDefinitions,
} from '@/lib/presentationTransitions'

export type PresentationRibbonTab =
  | 'home'
  | 'insert'
  | 'design'
  | 'transitions'
  | 'animations'
  | 'slideshow'
  | 'view'
  | 'shape'

interface PresentationRibbonProps {
  activeTab: PresentationRibbonTab
  compact: boolean
  currentSlide: PresentationSlide | undefined
  filmstripCollapsed: boolean
  historyStatus: { canUndo: boolean; canRedo: boolean }
  animationPaneOpen: boolean
  inspectorOpen: boolean
  selectedElement: PresentationElement | null
  selectedText: PresentationTextElement | null
  toolbarActions: ReactNode
  onActiveTabChange: (tab: PresentationRibbonTab) => void
  onAddShape: (type: PresentationShapeType) => void
  onAddSlide: () => void
  onAddText: (kind: 'title' | 'body') => void
  onApplyTransitionToAll: () => void
  onApplyFormat: (elementId: string, patch: Partial<PresentationElement>) => void
  onFindText: (query: string) => void
  onMoveElement: (direction: 'front' | 'back') => void
  onPreviewAnimation: () => void
  onPreviewTransition: (transitionOverride?: PresentationTransition) => void
  onRedo: () => void
  onSlideChange: (patch: Partial<PresentationSlide>) => void
  onStartSlideshow: () => void
  onStartSlideshowFromBeginning: () => void
  onToggleAnimationPane: () => void
  onToggleFilmstrip: () => void
  onToggleInspector: () => void
  onUndo: () => void
  onUpdateElement: (patch: Partial<PresentationElement>) => void
}

const tabs: Array<{ id: PresentationRibbonTab; label: string }> = [
  { id: 'home', label: 'session.presentation.tabHome' },
  { id: 'insert', label: 'session.presentation.tabInsert' },
  { id: 'design', label: 'session.presentation.tabDesign' },
  { id: 'transitions', label: 'session.presentation.tabTransitions' },
  { id: 'animations', label: 'session.presentation.tabAnimations' },
  { id: 'slideshow', label: 'session.presentation.tabSlideshow' },
  { id: 'view', label: 'session.presentation.tabView' },
  { id: 'shape', label: 'session.presentation.tabShape' },
]

const slideThemes = [
  { background: '#FFFFFF', colors: ['#41516A', '#3478F6', '#35A3E8', '#30B26F', '#DB2B32', '#FF922B', '#FFBE0B', '#7C2AE8'], label: 'session.presentation.themeLight' },
  { background: '#F7F3EA', colors: ['#44546A', '#E7E6E6', '#5B9BD5', '#ED7D31', '#A5A5A5', '#FFC000', '#4472C4', '#70AD47'], label: 'session.presentation.themePaper' },
  { background: '#17182B', colors: ['#203864', '#DDEBF7', '#5B9BD5', '#9DC3E6', '#2F75B5', '#A9D18E', '#70AD47', '#1F4E78'], label: 'session.presentation.themeMidnight' },
  { background: '#F7F1E4', colors: ['#6B451C', '#F2F0E9', '#F4B183', '#FFD18E', '#D69E58', '#A5A18B', '#737373', '#A9D18E'], label: 'session.presentation.themeLavender' },
]

const transitionIcons: Record<PresentationTransitionEffect, LucideIcon> = {
  none: Square,
  fade: Blend,
  push: ArrowUpToLine,
  wipe: Columns3,
  reveal: ArrowDownToLine,
  cover: Layers3,
  zoom: ZoomIn,
  flip: FlipHorizontal2,
  cube: Box,
}

const quickTransitionEffects: readonly PresentationTransitionEffect[] = ['none', 'fade', 'push', 'wipe']
const extendedTransitionEffects: readonly PresentationTransitionEffect[] = ['reveal', 'cover', 'zoom', 'flip', 'cube']
const quickTransitionDefinitions = presentationTransitionDefinitions.filter((definition) => (
  quickTransitionEffects.includes(definition.effect)
))
const extendedTransitionDefinitions = presentationTransitionDefinitions.filter((definition) => (
  extendedTransitionEffects.includes(definition.effect)
))

const transitionDirectionLabelKeys: Record<PresentationTransitionDirection, string> = {
  left: 'session.presentation.directionLeft',
  right: 'session.presentation.directionRight',
  up: 'session.presentation.directionUp',
  down: 'session.presentation.directionDown',
  in: 'session.presentation.directionIn',
  out: 'session.presentation.directionOut',
}

const entranceAnimations: Array<{ id?: PresentationAnimationEffect; label: string; icon: LucideIcon }> = [
  { id: 'appear', label: 'session.presentation.effectAppear', icon: Sparkles },
  { id: 'fade', label: 'session.presentation.effectBlinds', icon: Columns3 },
  { label: 'session.presentation.effectCheckerboard', icon: Grid3X3 },
  { label: 'session.presentation.effectDissolveIn', icon: Sparkles },
  { id: 'flyIn', label: 'session.presentation.effectFlyIn', icon: ArrowUpToLine },
]

export function PresentationRibbon({
  activeTab,
  animationPaneOpen,
  compact,
  currentSlide,
  filmstripCollapsed,
  historyStatus,
  inspectorOpen,
  selectedElement,
  selectedText,
  toolbarActions,
  onActiveTabChange,
  onAddShape,
  onAddSlide,
  onAddText,
  onApplyTransitionToAll,
  onApplyFormat,
  onFindText,
  onMoveElement,
  onPreviewAnimation,
  onPreviewTransition,
  onRedo,
  onSlideChange,
  onStartSlideshow,
  onStartSlideshowFromBeginning,
  onToggleAnimationPane,
  onToggleFilmstrip,
  onToggleInspector,
  onUndo,
  onUpdateElement,
}: PresentationRibbonProps) {
  const { t } = useTranslation()
  const [mockNotice, setMockNotice] = useState<string | null>(null)
  const [viewOptions, setViewOptions] = useState({ gridlines: false, guides: false, notes: false, ruler: false, smartSnap: true })
  const [formatPainter, setFormatPainter] = useState<{
    sourceId: string
    sourceType: 'text' | 'shape'
    patch: Partial<PresentationElement>
  } | null>(null)
  const appliedFormatTargetRef = useRef<string | null>(null)

  useEffect(() => {
    if (!mockNotice) return
    const timer = window.setTimeout(() => setMockNotice(null), 1800)
    return () => window.clearTimeout(timer)
  }, [mockNotice])

  const runMock = (label: string) => setMockNotice(t('session.presentation.mockNotice', { feature: label }))
  const transition = normalizePresentationTransition(currentSlide?.transition)
  const transitionDefinition = getPresentationTransitionDefinition(transition.effect)
  const updateTransition = (patch: Partial<typeof transition>, preview = false) => {
    if (!currentSlide) return
    const nextTransition = normalizePresentationTransition({ ...transition, ...patch })
    onSlideChange({ transition: nextTransition })
    if (preview) onPreviewTransition(nextTransition)
  }
  const selectTransition = (effect: PresentationTransitionEffect) => {
    if (!currentSlide) return
    const nextTransition = changePresentationTransitionEffect(transition, effect)
    onSlideChange({ transition: nextTransition })
    onPreviewTransition(nextTransition)
  }

  useEffect(() => {
    if (!formatPainter || !selectedElement || selectedElement.id === formatPainter.sourceId) return
    if (appliedFormatTargetRef.current === selectedElement.id) return
    appliedFormatTargetRef.current = selectedElement.id
    const targetType = selectedElement.type === 'text' ? 'text' : 'shape'
    if (targetType === formatPainter.sourceType) onApplyFormat(selectedElement.id, formatPainter.patch)
    queueMicrotask(() => {
      appliedFormatTargetRef.current = null
      setFormatPainter((current) => current === formatPainter ? null : current)
    })
  }, [formatPainter, onApplyFormat, selectedElement])

  const copySelectedFormat = () => {
    if (!selectedElement) return
    appliedFormatTargetRef.current = null
    if (selectedElement.type === 'text') {
      const {
        fontSize,
        fontFamily,
        fontWeight,
        italic,
        underline,
        strikethrough,
        baseline,
        highlightColor,
        characterSpacing,
        lineHeight,
        indentLevel,
        listStyle,
        color,
        align,
        shadow,
      } = selectedElement
      setFormatPainter({
        sourceId: selectedElement.id,
        sourceType: 'text',
        patch: {
          fontSize,
          fontFamily,
          fontWeight,
          italic,
          underline,
          strikethrough,
          baseline,
          highlightColor,
          characterSpacing,
          lineHeight,
          indentLevel,
          listStyle,
          color,
          align,
          shadow,
        },
      })
      return
    }
    setFormatPainter({
      sourceId: selectedElement.id,
      sourceType: 'shape',
      patch: {
        fill: selectedElement.fill,
        borderColor: selectedElement.borderColor,
        borderWidth: selectedElement.borderWidth,
        radius: selectedElement.radius,
        shadow: selectedElement.shadow,
      },
    })
  }

  const clearSelectedFormat = () => {
    if (!selectedElement) return
    if (selectedElement.type === 'text') {
      onUpdateElement({
        fontFamily: 'Aptos',
        fontSize: 24,
        fontWeight: 400,
        italic: false,
        underline: false,
        strikethrough: false,
        baseline: 'normal',
        highlightColor: undefined,
        characterSpacing: 0,
        lineHeight: 1.08,
        indentLevel: 0,
        listStyle: 'none',
        color: '#20202B',
        align: 'left',
        shadow: false,
      })
      return
    }
    onUpdateElement({
      fill: '#8B7CFF',
      borderColor: '#6957D9',
      borderWidth: 0,
      shadow: false,
    })
  }

  return (
    <div className="shrink-0 bg-bg-surface/95">
      <div className="flex h-10 items-stretch border-b border-border-subtle/55">
        <nav
          className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2"
          aria-label={t('session.presentation.ribbonTabs')}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onActiveTabChange(tab.id)}
              className={cn(
                'relative h-9 shrink-0 px-2.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary',
                activeTab === tab.id && 'font-semibold text-text-primary',
              )}
              aria-selected={activeTab === tab.id}
              role="tab"
              data-testid={`presentation-tab-${tab.id}`}
            >
              {t(tab.label)}
              {activeTab === tab.id ? (
                <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-purple" />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-0.5 bg-bg-surface px-2" data-testid="presentation-toolbar-actions">
          {toolbarActions}
        </div>
      </div>
      <section
        className="relative flex h-[92px] items-stretch gap-1 overflow-x-auto border-b border-border-subtle/70 bg-bg-app/45 px-2 py-1.5 shadow-[0_5px_18px_rgba(29,26,48,0.045)]"
        data-testid="presentation-ribbon"
      >
        {activeTab === 'home' && (
          compact ? (
            <>
              <HistoryControls
                canRedo={historyStatus.canRedo}
                canUndo={historyStatus.canUndo}
                formatPainterActive={Boolean(formatPainter)}
                onClearFormat={clearSelectedFormat}
                onCopyFormat={copySelectedFormat}
                onRedo={onRedo}
                onUndo={onUndo}
                selected={Boolean(selectedElement)}
              />
              <CompactRibbonMenu icon={PlusCircle} label={t('session.presentation.insert')} testId="presentation-compact-insert">
                <InsertControls onAddShape={onAddShape} onAddSlide={onAddSlide} onAddText={onAddText} />
              </CompactRibbonMenu>
              <CompactRibbonMenu icon={CaseUpper} label={t('session.presentation.font')} testId="presentation-compact-font">
                <FontControls selectedText={selectedText} compact={false} onUpdateElement={onUpdateElement} />
              </CompactRibbonMenu>
              <CompactRibbonMenu icon={AlignLeft} label={t('session.presentation.paragraph')} testId="presentation-compact-paragraph">
                <ParagraphControls selectedText={selectedText} onUpdateElement={onUpdateElement} />
              </CompactRibbonMenu>
              <CompactRibbonMenu icon={Paintbrush} label={t('session.presentation.drawing')} testId="presentation-compact-drawing">
                <ObjectControls inspectorOpen={inspectorOpen} selectedElement={selectedElement} onMoveElement={onMoveElement} onToggleInspector={onToggleInspector} onUpdateElement={onUpdateElement} />
              </CompactRibbonMenu>
              <RibbonAction icon={Sparkles} label={t('session.presentation.animation')} onClick={() => onActiveTabChange('animations')} />
              <RibbonAction icon={PanelTop} label={t('session.presentation.pageSetup')} onClick={() => onActiveTabChange('design')} />
              <RibbonAction icon={Printer} label={t('session.presentation.print')} onClick={() => window.print()} />
            </>
          ) : (
            <>
              <HistoryControls
                canRedo={historyStatus.canRedo}
                canUndo={historyStatus.canUndo}
                formatPainterActive={Boolean(formatPainter)}
                onClearFormat={clearSelectedFormat}
                onCopyFormat={copySelectedFormat}
                onRedo={onRedo}
                onUndo={onUndo}
                selected={Boolean(selectedElement)}
              />
              <RibbonGroup label={t('session.presentation.insert')}>
                <InsertControls onAddShape={onAddShape} onAddSlide={onAddSlide} onAddText={onAddText} />
              </RibbonGroup>
              <RibbonGroup label={t('session.presentation.font')} wide>
                <FontControls selectedText={selectedText} compact={false} onUpdateElement={onUpdateElement} />
              </RibbonGroup>
              <RibbonGroup label={t('session.presentation.paragraph')} wide>
                <ParagraphControls selectedText={selectedText} onUpdateElement={onUpdateElement} />
              </RibbonGroup>
              <RibbonGroup label={t('session.presentation.arrange')}>
                <ObjectControls inspectorOpen={inspectorOpen} selectedElement={selectedElement} onMoveElement={onMoveElement} onToggleInspector={onToggleInspector} onUpdateElement={onUpdateElement} />
              </RibbonGroup>
              <RibbonAction icon={Sparkles} label={t('session.presentation.animation')} onClick={() => onActiveTabChange('animations')} />
              <RibbonAction icon={PanelTop} label={t('session.presentation.pageSetup')} onClick={() => onActiveTabChange('design')} />
              <RibbonAction icon={Printer} label={t('session.presentation.print')} onClick={() => window.print()} />
            </>
          )
        )}

        {activeTab === 'insert' ? (
          <>
            <RibbonGroup label={t('session.presentation.slides')}>
              <RibbonAction icon={FilePlus2} label={t('session.presentation.blankSlide')} onClick={onAddSlide} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.textAndShapes')}>
              <RibbonAction dropdown icon={Type} label={t('session.presentation.textBox')} onClick={() => onAddText('body')} testId="presentation-add-text" />
              <ShapePickerButton onAddShape={onAddShape} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.content')}>
              <RibbonAction icon={Image} label={t('session.presentation.image')} onClick={() => runMock(t('session.presentation.image'))} />
              <RibbonAction icon={AudioLines} label={t('session.presentation.audio')} onClick={() => runMock(t('session.presentation.audio'))} />
              <RibbonAction icon={Video} label={t('session.presentation.video')} onClick={() => runMock(t('session.presentation.video'))} />
              <RibbonAction dropdown icon={Table2} label={t('session.presentation.table')} onClick={() => runMock(t('session.presentation.table'))} />
              <RibbonAction icon={Link2} label={t('session.presentation.link')} onClick={() => runMock(t('session.presentation.link'))} />
              <RibbonAction dropdown icon={BarChart3} label={t('session.presentation.chart')} onClick={() => runMock(t('session.presentation.chart'))} />
              <RibbonAction icon={StickyNote} label={t('session.presentation.footer')} onClick={() => runMock(t('session.presentation.footer'))} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'design' ? (
          <>
            <RibbonGroup label={t('session.presentation.quickThemes')} wide>
              <div className="flex h-full items-center gap-1 px-1">
                {slideThemes.map((theme) => (
                  <PresentationTooltip key={theme.background} content={t(theme.label)}>
                    <button
                      type="button"
                      aria-label={t(theme.label)}
                      aria-pressed={currentSlide?.background === theme.background}
                      onClick={() => onSlideChange({ background: theme.background })}
                      className={cn(
                        'grid h-14 w-[88px] grid-cols-4 gap-0.5 rounded-md border border-border-subtle bg-bg-surface p-1 shadow-sm transition-transform hover:-translate-y-0.5',
                        currentSlide?.background === theme.background && 'ring-2 ring-brand-purple ring-offset-1 ring-offset-bg-app',
                      )}
                    >
                      {theme.colors.map((color) => <span key={color} className="rounded-[1px]" style={{ backgroundColor: color }} />)}
                    </button>
                  </PresentationTooltip>
                ))}
              </div>
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.customize')}>
              <RibbonAction icon={Palette} label={t('session.presentation.moreColors')} onClick={() => runMock(t('session.presentation.moreColors'))} />
              <RibbonAction dropdown icon={Ratio} label={t('session.presentation.slideRatio')} onClick={() => runMock(t('session.presentation.slideRatio'))} />
              <label className="flex h-[58px] min-w-[58px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-1.5 text-[10px] text-text-secondary hover:bg-bg-hover">
                <Palette className="size-5" strokeWidth={1.7} />
                {t('session.presentation.setBackground')}
                <input
                  type="color"
                  value={currentSlide?.background ?? '#FFFFFF'}
                  onChange={(event) => onSlideChange({ background: event.target.value })}
                  className="sr-only"
                />
              </label>
              <RibbonAction icon={BookOpen} label={t('session.presentation.masterEdit')} onClick={() => runMock(t('session.presentation.masterEdit'))} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'transitions' ? (
          <>
            <RibbonGroup label={t('session.presentation.preview')}>
              <RibbonAction icon={Eye} label={t('session.presentation.previewEffect')} onClick={() => onPreviewTransition(transition)} disabled={!currentSlide || transition.effect === 'none'} testId="presentation-preview-transition" />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.transitionEffects')} wide>
              {quickTransitionDefinitions.map((definition) => (
                <EffectButton
                  key={definition.effect}
                  active={transition.effect === definition.effect}
                  disabled={!currentSlide}
                  icon={transitionIcons[definition.effect]}
                  label={t(definition.labelKey)}
                  onClick={() => selectTransition(definition.effect)}
                  testId={`presentation-transition-${definition.effect}`}
                />
              ))}
              <CompactRibbonMenu
                active={extendedTransitionEffects.includes(transition.effect)}
                icon={GalleryHorizontal}
                label={t('session.presentation.transitionGallery')}
                testId="presentation-transition-gallery"
              >
                {(close) => (
                  <div className="grid w-[380px] grid-cols-5 gap-1.5" data-testid="presentation-transition-gallery-panel">
                    {extendedTransitionDefinitions.map((definition) => (
                      <EffectButton
                        key={definition.effect}
                        active={transition.effect === definition.effect}
                        disabled={!currentSlide}
                        icon={transitionIcons[definition.effect]}
                        label={t(definition.labelKey)}
                        onClick={() => {
                          selectTransition(definition.effect)
                          close()
                        }}
                        testId={`presentation-transition-gallery-${definition.effect}`}
                      />
                    ))}
                  </div>
                )}
              </CompactRibbonMenu>
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.transitionSettings')}>
              <CompactRibbonMenu
                disabled={!currentSlide || (transitionDefinition.directions.length === 0 && !transitionDefinition.supportsThroughBlack)}
                icon={PanelTop}
                label={t('session.presentation.effectOptions')}
                testId="presentation-transition-options"
              >
                {(close) => (
                  <TransitionOptions
                    transition={transition}
                    onChange={(patch) => {
                      updateTransition(patch, true)
                      close()
                    }}
                  />
                )}
              </CompactRibbonMenu>
              <RibbonNumberInput
                disabled={!currentSlide || transition.effect === 'none'}
                icon={Clock3}
                label={t('session.presentation.duration')}
                max={20}
                min={0.1}
                step={0.1}
                suffix="s"
                value={transition.durationMs / 1000}
                onChange={(value) => updateTransition({ durationMs: Math.round(value * 1000) })}
              />
              <RibbonAction
                disabled={!currentSlide}
                icon={Layers3}
                label={t('session.presentation.applyToAll')}
                onClick={() => {
                  onApplyTransitionToAll()
                  setMockNotice(t('session.presentation.transitionAppliedToAll'))
                }}
                testId="presentation-transition-apply-all"
              />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'animations' ? (
          <>
            <RibbonGroup label={t('session.presentation.preview')}>
              <RibbonAction dropdown icon={Eye} label={t('session.presentation.preview')} onClick={onPreviewAnimation} disabled={!selectedElement || selectedElement.animation === 'none'} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.entrance')} wide>
              {entranceAnimations.map((effect) => (
                <EffectButton
                  key={effect.label}
                  active={Boolean(effect.id && (selectedElement?.animation ?? 'none') === effect.id)}
                  disabled={!selectedElement}
                  icon={effect.icon}
                  label={t(effect.label)}
                  onClick={() => effect.id ? onUpdateElement({ animation: effect.id }) : runMock(t(effect.label))}
                  testId={effect.id ? `presentation-animation-${effect.id}` : undefined}
                />
              ))}
              <RibbonAction dropdown icon={GalleryHorizontal} label={t('session.presentation.moreAnimations')} onClick={() => runMock(t('session.presentation.moreAnimations'))} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.emphasis')}>
              <RibbonAction icon={PaintBucket} label={t('session.presentation.fillColor')} onClick={() => runMock(t('session.presentation.fillColor'))} disabled={!selectedElement} />
              <RibbonAction icon={Type} label={t('session.presentation.textColor')} onClick={() => runMock(t('session.presentation.textColor'))} disabled={!selectedElement} />
              <RibbonAction icon={ZoomIn} label={t('session.presentation.growShrink')} onClick={() => selectedElement ? onUpdateElement({ animation: 'zoom' }) : undefined} disabled={!selectedElement} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.exit')}>
              <RibbonAction icon={EyeOff} label={t('session.presentation.disappear')} onClick={() => runMock(t('session.presentation.disappear'))} disabled={!selectedElement} />
              <RibbonAction dropdown icon={Columns3} label={t('session.presentation.effectBlinds')} onClick={() => runMock(t('session.presentation.effectBlinds'))} disabled={!selectedElement} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.advancedAnimation')}>
              <RibbonAction active={animationPaneOpen} icon={List} label={t('session.presentation.animationPane')} onClick={onToggleAnimationPane} />
              <RibbonAction dropdown icon={ListPlus} label={t('session.presentation.multipleAnimations')} onClick={() => runMock(t('session.presentation.multipleAnimations'))} disabled={!selectedElement} />
              <RibbonAction icon={Paintbrush} label={t('session.presentation.animationPainter')} onClick={() => runMock(t('session.presentation.animationPainter'))} disabled={!selectedElement} />
            </RibbonGroup>
            <AnimationTimingControls selectedElement={selectedElement} onUpdateElement={onUpdateElement} onMock={runMock} />
          </>
        ) : null}

        {activeTab === 'slideshow' ? (
          <>
            <RibbonGroup label={t('session.presentation.slideshow')}>
              <RibbonAction icon={Timer} label={t('session.presentation.playFromBeginning')} onClick={onStartSlideshowFromBeginning} />
              <RibbonAction icon={Play} label={t('session.presentation.playFromCurrent')} onClick={onStartSlideshow} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'view' ? (
          <>
            <RibbonGroup label={t('session.presentation.workspace')}>
              <RibbonAction active={!filmstripCollapsed} icon={LayoutGrid} label={t('session.presentation.normalView')} onClick={onToggleFilmstrip} testId="presentation-toggle-filmstrip" />
              <RibbonAction icon={BookOpen} label={t('session.presentation.slideMaster')} onClick={() => runMock(t('session.presentation.slideMaster'))} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.show')}>
              <ViewToggle checked={viewOptions.ruler} label={t('session.presentation.ruler')} onChange={() => setViewOptions((value) => ({ ...value, ruler: !value.ruler }))} />
              <ViewToggle checked={viewOptions.guides} label={t('session.presentation.guides')} onChange={() => setViewOptions((value) => ({ ...value, guides: !value.guides }))} />
              <ViewToggle checked={viewOptions.gridlines} label={t('session.presentation.gridlines')} onChange={() => setViewOptions((value) => ({ ...value, gridlines: !value.gridlines }))} />
              <ViewToggle checked={viewOptions.smartSnap} label={t('session.presentation.smartSnap')} onChange={() => setViewOptions((value) => ({ ...value, smartSnap: !value.smartSnap }))} />
              <RibbonAction active={viewOptions.notes} icon={StickyNote} label={t('session.presentation.notes')} onClick={() => setViewOptions((value) => ({ ...value, notes: !value.notes }))} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.zoom')}>
              <RibbonAction dropdown icon={ZoomIn} label={t('session.presentation.zoom')} onClick={() => runMock(t('session.presentation.zoom'))} />
              <RibbonAction icon={Maximize} label={t('session.presentation.fitWindow')} onClick={() => runMock(t('session.presentation.fitWindow'))} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'shape' ? (
          <ShapeRibbon
            canRedo={historyStatus.canRedo}
            canUndo={historyStatus.canUndo}
            formatPainterActive={Boolean(formatPainter)}
            selectedElement={selectedElement}
            onAddShape={onAddShape}
            onAddText={onAddText}
            onCopyFormat={copySelectedFormat}
            onMock={runMock}
            onMoveElement={onMoveElement}
            onRedo={onRedo}
            onUndo={onUndo}
            onUpdateElement={onUpdateElement}
          />
        ) : null}

        <RibbonTail onFindText={onFindText} onMock={runMock} />
        {mockNotice ? <span className="pointer-events-none sticky right-16 top-1 z-20 self-start rounded-md bg-text-primary px-2 py-1 text-[10px] text-bg-surface shadow-lg">{mockNotice}</span> : null}
      </section>
    </div>
  )
}

function HistoryControls({ canRedo, canUndo, formatPainterActive, onClearFormat, onCopyFormat, onRedo, onUndo, selected }: {
  canRedo: boolean
  canUndo: boolean
  formatPainterActive: boolean
  onClearFormat: () => void
  onCopyFormat: () => void
  onRedo: () => void
  onUndo: () => void
  selected: boolean
}) {
  const { t } = useTranslation()
  return (
    <RibbonGroup label={t('session.presentation.history')}>
      <div className="grid grid-cols-2 gap-0.5 px-1">
        <FormatButton label={t('session.presentation.undo')} disabled={!canUndo} onClick={onUndo}><Undo2 className="size-4" /></FormatButton>
        <FormatButton label={t('session.presentation.redo')} disabled={!canRedo} onClick={onRedo}><Redo2 className="size-4" /></FormatButton>
        <FormatButton label={t('session.presentation.formatPainter')} disabled={!selected} pressed={formatPainterActive} onClick={onCopyFormat} testId="presentation-format-painter"><Paintbrush className="size-4" /></FormatButton>
        <FormatButton label={t('session.presentation.clearFormatting')} disabled={!selected} onClick={onClearFormat} testId="presentation-clear-format"><Eraser className="size-4" /></FormatButton>
      </div>
    </RibbonGroup>
  )
}

function InsertControls({ onAddShape, onAddSlide, onAddText }: {
  onAddShape: (type: PresentationShapeType) => void
  onAddSlide: () => void
  onAddText: (kind: 'title' | 'body') => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full items-center">
      <RibbonAction icon={FilePlus2} label={t('session.presentation.newSlide')} onClick={onAddSlide} />
      <RibbonAction icon={Type} label={t('session.presentation.textBox')} onClick={() => onAddText('body')} testId="presentation-add-text" />
      <ShapePickerButton onAddShape={onAddShape} />
    </div>
  )
}

function FontControls({ selectedText, compact, onUpdateElement }: {
  selectedText: PresentationTextElement | null
  compact: boolean
  onUpdateElement: (patch: Partial<PresentationElement>) => void
}) {
  const { t } = useTranslation()
  const disabled = !selectedText
  return (
    <div className="flex h-full flex-col justify-center gap-1 px-1">
      <div className="flex items-center gap-1">
        <select
          aria-label={t('session.presentation.fontFamily')}
          data-testid="presentation-font-family"
          disabled={disabled}
          value={selectedText?.fontFamily ?? 'Aptos'}
          onChange={(event) => onUpdateElement({ fontFamily: event.target.value })}
          className={cn(
            'h-7 rounded-md border border-border-subtle bg-bg-surface px-1.5 text-xs text-text-secondary outline-none focus:border-brand-purple disabled:opacity-45',
            compact ? 'w-[86px]' : 'w-[128px]',
          )}
        >
          <option value="Aptos">Aptos</option>
          <option value="Aptos Display">Aptos Display</option>
          <option value="Source Han Serif SC">Source Han Serif SC</option>
          <option value="Source Han Sans SC">Source Han Sans SC</option>
          <option value="Arial">Arial</option>
          <option value="Helvetica">Helvetica</option>
          <option value="Georgia">Georgia</option>
          <option value="Times New Roman">Times New Roman</option>
        </select>
        <input
          type="number"
          min={8}
          max={240}
          aria-label={t('session.presentation.fontSize')}
          data-testid="presentation-font-size"
          disabled={disabled}
          value={Math.round(selectedText?.fontSize ?? 24)}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value)) onUpdateElement({ fontSize: Math.min(240, Math.max(8, value)) })
          }}
          className="h-7 w-12 rounded-md border border-border-subtle bg-bg-surface px-1 text-center text-xs text-text-secondary outline-none focus:border-brand-purple disabled:opacity-45"
        />
        <FormatButton label={t('session.presentation.increaseFontSize')} disabled={disabled} onClick={() => onUpdateElement({ fontSize: Math.min(240, (selectedText?.fontSize ?? 24) + 2) })}><span className="text-sm">A<sup>+</sup></span></FormatButton>
        <FormatButton label={t('session.presentation.decreaseFontSize')} disabled={disabled} onClick={() => onUpdateElement({ fontSize: Math.max(8, (selectedText?.fontSize ?? 24) - 2) })}><span className="text-sm">A<sup>−</sup></span></FormatButton>
      </div>
      <div className="flex items-center gap-0.5">
        <FormatButton label={t('session.presentation.bold')} disabled={disabled} pressed={(selectedText?.fontWeight ?? 400) >= 600} onClick={() => onUpdateElement({ fontWeight: (selectedText?.fontWeight ?? 400) >= 600 ? 400 : 700 })} testId="presentation-bold"><b>B</b></FormatButton>
        <FormatButton label={t('session.presentation.italic')} disabled={disabled} pressed={Boolean(selectedText?.italic)} onClick={() => onUpdateElement({ italic: !selectedText?.italic })} testId="presentation-italic"><i>I</i></FormatButton>
        <FormatButton label={t('session.presentation.underline')} disabled={disabled} pressed={Boolean(selectedText?.underline)} onClick={() => onUpdateElement({ underline: !selectedText?.underline })} testId="presentation-underline"><u>U</u></FormatButton>
        <FormatButton label={t('session.presentation.strikethrough')} disabled={disabled} pressed={Boolean(selectedText?.strikethrough)} onClick={() => onUpdateElement({ strikethrough: !selectedText?.strikethrough })} testId="presentation-strikethrough"><s>S</s></FormatButton>
        <FormatButton label={t('session.presentation.superscript')} disabled={disabled} pressed={selectedText?.baseline === 'superscript'} onClick={() => onUpdateElement({ baseline: selectedText?.baseline === 'superscript' ? 'normal' : 'superscript' })}><span>x<sup>2</sup></span></FormatButton>
        <FormatButton label={t('session.presentation.subscript')} disabled={disabled} pressed={selectedText?.baseline === 'subscript'} onClick={() => onUpdateElement({ baseline: selectedText?.baseline === 'subscript' ? 'normal' : 'subscript' })}><span>x<sub>2</sub></span></FormatButton>
        <FormatButton
          label={t('session.presentation.characterSpacing')}
          disabled={disabled}
          pressed={(selectedText?.characterSpacing ?? 0) > 0}
          onClick={() => {
            const spacing = selectedText?.characterSpacing ?? 0
            onUpdateElement({ characterSpacing: spacing >= 200 ? 0 : spacing + 50 })
          }}
        ><span className="text-[10px]">A↔V</span></FormatButton>
        <ColorButton
          label={t('session.presentation.highlightColor')}
          color={selectedText?.highlightColor ?? '#FFF200'}
          disabled={disabled}
          icon={<PaintBucket className="size-4" />}
          onChange={(highlightColor) => onUpdateElement({ highlightColor })}
        />
        <ColorButton
          label={t('session.presentation.textColor')}
          color={selectedText?.color ?? '#20202B'}
          disabled={disabled}
          icon={<span className="text-sm font-semibold">A</span>}
          onChange={(color) => onUpdateElement({ color })}
        />
      </div>
    </div>
  )
}

function ParagraphControls({ selectedText, onUpdateElement }: {
  selectedText: PresentationTextElement | null
  onUpdateElement: (patch: Partial<PresentationElement>) => void
}) {
  const { t } = useTranslation()
  const disabled = !selectedText
  const lineHeight = selectedText?.lineHeight ?? 1.08
  return (
    <div className="grid grid-cols-5 content-center gap-0.5 px-1">
      <FormatButton label={t('session.presentation.bullets')} disabled={disabled} pressed={selectedText?.listStyle === 'bullet'} onClick={() => onUpdateElement({ listStyle: selectedText?.listStyle === 'bullet' ? 'none' : 'bullet' })} testId="presentation-bullets"><List className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.numbering')} disabled={disabled} pressed={selectedText?.listStyle === 'number'} onClick={() => onUpdateElement({ listStyle: selectedText?.listStyle === 'number' ? 'none' : 'number' })} testId="presentation-numbering"><ListOrdered className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.decreaseIndent')} disabled={disabled || (selectedText?.indentLevel ?? 0) === 0} onClick={() => onUpdateElement({ indentLevel: Math.max(0, (selectedText?.indentLevel ?? 0) - 1) })}><IndentDecrease className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.increaseIndent')} disabled={disabled || (selectedText?.indentLevel ?? 0) >= 8} onClick={() => onUpdateElement({ indentLevel: Math.min(8, (selectedText?.indentLevel ?? 0) + 1) })}><IndentIncrease className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.lineSpacing')} disabled={disabled} pressed={lineHeight > 1.08} onClick={() => onUpdateElement({ lineHeight: getNextLineHeight(lineHeight) })}><Rows3 className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.alignLeft')} disabled={disabled} pressed={selectedText?.align === 'left'} onClick={() => onUpdateElement({ align: 'left' })}><AlignLeft className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.alignCenter')} disabled={disabled} pressed={selectedText?.align === 'center'} onClick={() => onUpdateElement({ align: 'center' })} testId="presentation-align-center"><AlignCenter className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.alignRight')} disabled={disabled} pressed={selectedText?.align === 'right'} onClick={() => onUpdateElement({ align: 'right' })}><AlignRight className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.justify')} disabled={disabled} pressed={selectedText?.align === 'justify'} onClick={() => onUpdateElement({ align: 'justify' })} testId="presentation-align-justify"><AlignJustify className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.verticalAlignment')} disabled onClick={() => undefined}><ChevronsUpDown className="size-4" /></FormatButton>
    </div>
  )
}

function getNextLineHeight(lineHeight: number): number {
  if (lineHeight >= 2) return 1.08
  if (lineHeight < 1.15) return 1.15
  if (lineHeight < 1.5) return 1.5
  return 2
}

function ObjectControls({ inspectorOpen, selectedElement, onMoveElement, onToggleInspector, onUpdateElement }: {
  inspectorOpen: boolean
  selectedElement: PresentationElement | null
  onMoveElement: (direction: 'front' | 'back') => void
  onToggleInspector: () => void
  onUpdateElement: (patch: Partial<PresentationElement>) => void
}) {
  const { t } = useTranslation()
  const shape = selectedElement && selectedElement.type !== 'text' ? selectedElement : null
  return (
    <div className="grid grid-cols-4 content-center gap-0.5 px-1">
      <FormatButton label={t('session.presentation.bringToFront')} disabled={!selectedElement} onClick={() => onMoveElement('front')}><BringToFront className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.sendToBack')} disabled={!selectedElement} onClick={() => onMoveElement('back')}><SendToBack className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.effects')} disabled={!selectedElement} pressed={Boolean(selectedElement?.shadow)} onClick={() => onUpdateElement({ shadow: !selectedElement?.shadow })}><Sparkles className="size-4" /></FormatButton>
      <ColorButton label={t('session.presentation.fillColor')} color={shape?.fill ?? '#8B7CFF'} disabled={!shape} icon={<PaintBucket className="size-4" />} onChange={(fill) => onUpdateElement({ fill })} />
      <ColorButton label={t('session.presentation.borderColor')} color={shape?.borderColor ?? '#6957D9'} disabled={!shape} icon={<Square className="size-4" />} onChange={(borderColor) => onUpdateElement({ borderColor, borderWidth: Math.max(1, shape?.borderWidth ?? 0) })} />
      <FormatButton label={t('session.presentation.borderWidth')} disabled={!shape} pressed={(shape?.borderWidth ?? 0) > 0} onClick={() => onUpdateElement({ borderWidth: (shape?.borderWidth ?? 0) >= 4 ? 0 : Math.max(1, (shape?.borderWidth ?? 0) + 1) })}><span className="text-sm">▱</span></FormatButton>
      <FormatButton label={t('session.presentation.arrange')} disabled={!selectedElement} onClick={() => onMoveElement('front')}><Layers3 className="size-4" /></FormatButton>
      <FormatButton label={t('session.presentation.properties')} pressed={inspectorOpen} onClick={onToggleInspector}><Paintbrush className="size-4" /></FormatButton>
    </div>
  )
}

function ColorButton({ color, disabled, icon, label, onChange }: {
  color: string
  disabled?: boolean
  icon: ReactNode
  label: string
  onChange: (color: string) => void
}) {
  return (
    <PresentationTooltip content={label}>
      <label className={cn('relative flex size-6 cursor-pointer items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover', disabled && 'pointer-events-none opacity-35')} aria-label={label}>
        {icon}
        <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full" style={{ backgroundColor: color }} />
        <input type="color" className="sr-only" disabled={disabled} value={color} onChange={(event) => onChange(event.target.value)} />
      </label>
    </PresentationTooltip>
  )
}

function RibbonColorAction({ color, disabled, icon: Icon, label, onChange }: {
  color: string
  disabled?: boolean
  icon: LucideIcon
  label: string
  onChange: (color: string) => void
}) {
  return (
    <label className={cn('relative flex h-[58px] min-w-[52px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-1.5 text-[10px] font-medium text-text-secondary hover:bg-bg-hover', disabled && 'pointer-events-none opacity-35')} aria-label={label}>
      <span className="relative"><Icon className="size-[19px]" strokeWidth={1.65} /><span className="absolute -bottom-1 inset-x-0 h-0.5 rounded-full" style={{ backgroundColor: color }} /></span>
      <span>{label}</span>
      <input type="color" className="sr-only" disabled={disabled} value={color} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function formatRibbonNumberInputValue(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(2))) : ''
}

function parseRibbonNumberInputValue(raw: string): number | null {
  if (!raw.trim()) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function clampRibbonNumberInputValue(value: number, min?: number, max?: number): number {
  const aboveMinimum = min === undefined ? value : Math.max(min, value)
  return max === undefined ? aboveMinimum : Math.min(max, aboveMinimum)
}

function RibbonNumberInput({ disabled, icon: Icon, label, max, min, onChange, step = 1, suffix, value }: {
  disabled?: boolean
  icon: LucideIcon
  label: string
  max?: number
  min?: number
  onChange: (value: number) => void
  step?: number
  suffix?: string
  value: number
}) {
  const [draft, setDraft] = useState(() => formatRibbonNumberInputValue(value))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current === document.activeElement) return
    setDraft(formatRibbonNumberInputValue(value))
  }, [value])

  return (
    <label className={cn('flex h-[58px] min-w-[72px] flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10px] text-text-secondary', disabled && 'opacity-35')}>
      <span className="flex items-center gap-1"><Icon className="size-4" />{label}</span>
      <span className="relative">
        <input
          ref={inputRef}
          aria-label={label}
          className="h-6 w-16 rounded border border-border-subtle bg-bg-surface px-1 pr-4 text-center text-[10px] outline-none focus:border-brand-purple"
          disabled={disabled}
          max={max}
          min={min}
          step={step}
          type="number"
          value={draft}
          onBlur={() => {
            setDraft(formatRibbonNumberInputValue(value))
          }}
          onChange={(event) => {
            const raw = event.target.value
            setDraft(raw)
            const next = parseRibbonNumberInputValue(raw)
            if (next === null) return
            onChange(clampRibbonNumberInputValue(next, min, max))
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            event.currentTarget.blur()
          }}
        />
        {suffix ? <span className="pointer-events-none absolute right-1 top-1 text-[9px] text-text-tertiary">{suffix}</span> : null}
      </span>
    </label>
  )
}

function AnimationTimingControls({ onMock, onUpdateElement, selectedElement }: {
  onMock: (label: string) => void
  onUpdateElement: (patch: Partial<PresentationElement>) => void
  selectedElement: PresentationElement | null
}) {
  const { t } = useTranslation()
  const disabled = !selectedElement
  return (
    <RibbonGroup label={t('session.presentation.timing')}>
      <RibbonAction dropdown disabled={disabled} icon={Play} label={t('session.presentation.startMode')} onClick={() => onMock(t('session.presentation.startMode'))} />
      <RibbonAction dropdown disabled={disabled} icon={Timer} label={t('session.presentation.delay')} onClick={() => onMock(t('session.presentation.delay'))} />
      <RibbonNumberInput
        disabled={disabled}
        icon={Clock3}
        label={t('session.presentation.duration')}
        max={30}
        min={0.18}
        step={0.1}
        suffix="s"
        value={(selectedElement?.animationDuration ?? 520) / 1000}
        onChange={(value) => onUpdateElement({ animationDuration: Math.round(Math.max(0.18, value) * 1000) })}
      />
      <RibbonAction dropdown disabled={disabled} icon={MousePointerClick} label={t('session.presentation.trigger')} onClick={() => onMock(t('session.presentation.trigger'))} />
      <RibbonAction icon={EyeOff} label={t('session.presentation.hideAllCorners')} onClick={() => onMock(t('session.presentation.hideAllCorners'))} />
    </RibbonGroup>
  )
}

function ViewToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <label className="flex h-[58px] min-w-[62px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10px] text-text-secondary hover:bg-bg-hover">
      <input type="checkbox" checked={checked} onChange={onChange} className="size-4 accent-brand-purple" />
      <span>{label}</span>
    </label>
  )
}

function ShapeRibbon({ canRedo, canUndo, formatPainterActive, onAddShape, onAddText, onCopyFormat, onMock, onMoveElement, onRedo, onUndo, onUpdateElement, selectedElement }: {
  canRedo: boolean
  canUndo: boolean
  formatPainterActive: boolean
  onAddShape: (type: PresentationShapeType) => void
  onAddText: (kind: 'title' | 'body') => void
  onCopyFormat: () => void
  onMock: (label: string) => void
  onMoveElement: (direction: 'front' | 'back') => void
  onRedo: () => void
  onUndo: () => void
  onUpdateElement: (patch: Partial<PresentationElement>) => void
  selectedElement: PresentationElement | null
}) {
  const { t } = useTranslation()
  const shape = selectedElement?.type !== 'text' ? selectedElement : null
  const text = selectedElement?.type === 'text' ? selectedElement : null
  const presets = ['#20202B', '#4D7CFE', '#E17B47', '#74777F', '#F2B91F', '#54A8DC', '#64A45B']
  const applyPreset = (color: string) => {
    if (!selectedElement) return
    if (selectedElement.type === 'text') onUpdateElement({ color })
    else onUpdateElement({ borderColor: color, borderWidth: Math.max(1, selectedElement.borderWidth) })
  }
  return (
    <>
      <RibbonGroup label={t('session.presentation.history')}>
        <div className="grid grid-cols-2 gap-0.5 px-1">
          <FormatButton disabled={!canUndo} label={t('session.presentation.undo')} onClick={onUndo}><Undo2 className="size-4" /></FormatButton>
          <FormatButton disabled={!selectedElement} label={t('session.presentation.formatPainter')} onClick={onCopyFormat} pressed={formatPainterActive}><Paintbrush className="size-4" /></FormatButton>
          <FormatButton disabled={!canRedo} label={t('session.presentation.redo')} onClick={onRedo}><Redo2 className="size-4" /></FormatButton>
        </div>
      </RibbonGroup>
      <RibbonGroup label={t('session.presentation.insert')}>
        <RibbonAction dropdown icon={Type} label={t('session.presentation.textBox')} onClick={() => onAddText('body')} />
        <ShapePickerButton onAddShape={onAddShape} />
      </RibbonGroup>
      <RibbonGroup label={t('session.presentation.shapeStyles')} wide>
        <div className="flex items-center gap-1 px-1">
          {presets.map((color) => (
            <button key={color} type="button" disabled={!selectedElement} onClick={() => applyPreset(color)} aria-label={t('session.presentation.applyStyle')} className="flex h-12 w-10 items-center justify-center rounded-md border border-border-subtle bg-bg-surface disabled:opacity-35">
              <span className="flex size-7 items-center justify-center rounded border-2 text-sm" style={{ borderColor: color }}>A</span>
            </button>
          ))}
        </div>
      </RibbonGroup>
      <RibbonGroup label={t('session.presentation.shapeAppearance')}>
        <RibbonColorAction color={shape?.fill ?? '#4D7CFE'} disabled={!shape} icon={PaintBucket} label={t('session.presentation.fillColor')} onChange={(fill) => onUpdateElement({ fill })} />
        <RibbonColorAction color={shape?.borderColor ?? '#20202B'} disabled={!shape} icon={Square} label={t('session.presentation.borderColor')} onChange={(borderColor) => onUpdateElement({ borderColor, borderWidth: Math.max(1, shape?.borderWidth ?? 0) })} />
        <RibbonAction dropdown disabled={!selectedElement} icon={Sparkles} label={t('session.presentation.effects')} onClick={() => selectedElement && onUpdateElement({ shadow: !selectedElement.shadow })} />
      </RibbonGroup>
      <RibbonGroup label={t('session.presentation.wordArt')}>
        {['#111111', '#3F6EC9', '#E7783D'].map((color) => (
          <button key={color} type="button" disabled={!text} onClick={() => onUpdateElement({ color, fontWeight: 700 })} className="flex size-12 items-center justify-center rounded-md text-3xl font-serif disabled:opacity-35" style={{ color }} aria-label={t('session.presentation.wordArt')}>A</button>
        ))}
      </RibbonGroup>
      <RibbonGroup label={t('session.presentation.textAppearance')}>
        <RibbonColorAction color={text?.color ?? '#20202B'} disabled={!text} icon={Type} label={t('session.presentation.textColor')} onChange={(color) => onUpdateElement({ color })} />
        <RibbonAction dropdown disabled={!text} icon={Sparkles} label={t('session.presentation.textEffects')} onClick={() => text && onUpdateElement({ shadow: !text.shadow })} />
        <RibbonAction dropdown disabled={!text} icon={CaseUpper} label={t('session.presentation.font')} onClick={() => onMock(t('session.presentation.font'))} />
      </RibbonGroup>
      <RibbonGroup label={t('session.presentation.arrange')}>
        <RibbonAction dropdown disabled={!selectedElement} icon={RotateCw} label={t('session.presentation.rotation')} onClick={() => selectedElement && onUpdateElement({ rotation: (selectedElement.rotation + 15) % 360 })} />
        <RibbonAction dropdown disabled={!selectedElement} icon={AlignCenter} label={t('session.presentation.align')} onClick={() => onMock(t('session.presentation.align'))} />
        <RibbonAction disabled={!selectedElement} icon={ArrowUpToLine} label={t('session.presentation.moveUp')} onClick={() => onMoveElement('front')} />
        <RibbonAction disabled={!selectedElement} icon={ArrowDownToLine} label={t('session.presentation.moveDown')} onClick={() => onMoveElement('back')} />
        <RibbonAction dropdown disabled icon={Group} label={t('session.presentation.group')} onClick={() => undefined} />
        <RibbonAction icon={Layers3} label={t('session.presentation.allLayers')} onClick={() => onMock(t('session.presentation.allLayers'))} />
      </RibbonGroup>
      <RibbonGroup label={t('session.presentation.size')}>
        <RibbonNumberInput disabled={!selectedElement} icon={Ruler} label={t('session.presentation.width')} min={8} value={selectedElement?.width ?? 0} onChange={(width) => onUpdateElement({ width })} />
        <RibbonNumberInput disabled={!selectedElement} icon={Ruler} label={t('session.presentation.height')} min={8} value={selectedElement?.height ?? 0} onChange={(height) => onUpdateElement({ height })} />
      </RibbonGroup>
    </>
  )
}

function RibbonTail({ onFindText, onMock }: { onFindText: (query: string) => void; onMock: (label: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="sticky right-0 z-10 ml-auto flex shrink-0 items-center gap-0.5 border-l border-border-subtle/70 bg-bg-app/95 px-1 shadow-[-8px_0_12px_rgba(29,26,48,0.03)]">
      <SearchControl iconOnly onFindText={onFindText} />
      <PresentationTooltip content={t('session.presentation.collapseRibbon')}>
        <button type="button" aria-label={t('session.presentation.collapseRibbon')} onClick={() => onMock(t('session.presentation.collapseRibbon'))} className="flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover"><ChevronsUpDown className="size-4" /></button>
      </PresentationTooltip>
    </div>
  )
}

function TransitionOptions({ onChange, transition }: {
  onChange: (patch: Partial<PresentationTransition>) => void
  transition: PresentationTransition
}) {
  const { t } = useTranslation()
  const definition = getPresentationTransitionDefinition(transition.effect)
  return (
    <div className="flex min-w-[220px] flex-col gap-2 p-1" data-testid="presentation-transition-options-panel">
      {definition.directions.length > 0 ? (
        <div className="grid grid-cols-2 gap-1">
          {definition.directions.map((direction) => (
            <button
              key={direction}
              type="button"
              aria-pressed={transition.direction === direction}
              data-testid={`presentation-transition-direction-${direction}`}
              onClick={() => onChange({ direction })}
              className={cn(
                'h-8 rounded-md px-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                transition.direction === direction && 'bg-brand-purple/10 font-medium text-brand-purple',
              )}
            >
              {t(transitionDirectionLabelKeys[direction])}
            </button>
          ))}
        </div>
      ) : null}
      {definition.supportsThroughBlack ? (
        <div className="grid grid-cols-2 gap-1 border-t border-border-subtle pt-2">
          <button
            type="button"
            aria-pressed={!transition.throughBlack}
            data-testid="presentation-transition-direct"
            onClick={() => onChange({ throughBlack: false })}
            className={cn(
              'h-8 rounded-md px-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              !transition.throughBlack && 'bg-brand-purple/10 font-medium text-brand-purple',
            )}
          >
            {t('session.presentation.transitionDirect')}
          </button>
          <button
            type="button"
            aria-pressed={Boolean(transition.throughBlack)}
            data-testid="presentation-transition-through-black"
            onClick={() => onChange({ throughBlack: true })}
            className={cn(
              'h-8 rounded-md px-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              transition.throughBlack && 'bg-brand-purple/10 font-medium text-brand-purple',
            )}
          >
            {t('session.presentation.transitionThroughBlack')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ShapePickerButton({ onAddShape }: { onAddShape: (type: PresentationShapeType) => void }) {
  const { i18n, t } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  return (
    <CompactRibbonMenu
      icon={Shapes}
      label={t('session.presentation.shapes')}
      panelClassName="items-start rounded-lg p-2.5"
      testId="presentation-shape-picker"
    >
      {(close) => (
        <div className="max-h-[min(620px,70vh)] w-[398px] overflow-y-auto pr-1.5" data-testid="presentation-shape-gallery">
          {presentationShapeCategories.map((category) => (
            <section key={category.id} className="mb-3.5 last:mb-0" aria-label={language.startsWith('zh') ? category.name.zh : category.name.en}>
              <h3 className="mb-1.5 px-1 text-[11px] font-normal leading-4 text-text-tertiary">
                {language.startsWith('zh') ? category.name.zh : category.name.en}
              </h3>
              <div className="grid grid-cols-10 gap-x-1 gap-y-1.5">
                {category.shapes.map((definition) => {
                  const name = getPresentationShapeName(definition.type, language)
                  const lineShape = definition.strokeOnly || isPresentationLineShape(definition.type)
                  return (
                    <Tooltip key={definition.type} content={name} delayMs={0} appearance="presentation">
                      <button
                        type="button"
                        aria-label={name}
                        data-testid={`presentation-shape-${definition.type}`}
                        onClick={() => {
                          onAddShape(definition.type)
                          close()
                        }}
                        className="flex size-[34px] items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple/35"
                      >
                        <svg viewBox="0 0 100 100" className="size-6 overflow-visible" aria-hidden="true">
                          <path
                            d={definition.path}
                            fill="none"
                            fillRule="evenodd"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={lineShape ? 5.5 : 4.5}
                          />
                        </svg>
                      </button>
                    </Tooltip>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </CompactRibbonMenu>
  )
}

type CompactRibbonMenuChildren = ReactNode | ((close: () => void) => ReactNode)

function CompactRibbonMenu({ active = false, children, disabled = false, icon: Icon, iconOnly = false, label, panelClassName, testId }: { active?: boolean; children: CompactRibbonMenuChildren; disabled?: boolean; icon: LucideIcon; iconOnly?: boolean; label: string; panelClassName?: string; testId?: string }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target
      const insideOpenMenu = target instanceof Node && Array.from(document.querySelectorAll('[data-presentation-ribbon-menu]')).some((menu) => menu.contains(target))
      if (target instanceof Node && (buttonRef.current?.contains(target) || insideOpenMenu)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const menu = open ? createPortal(
    <div
      data-presentation-ribbon-menu
      className={cn('fixed z-[1000] flex min-h-[76px] min-w-[220px] items-stretch rounded-xl border border-border-default bg-bg-elevated p-2 shadow-xl', panelClassName)}
      style={{
        left: position.left,
        top: position.top,
      }}
      role="dialog"
      aria-label={label}
    >
      {typeof children === 'function' ? children(() => setOpen(false)) : children}
    </div>,
    document.body,
  ) : null

  const trigger = (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={open}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        if (open) {
          setOpen(false)
          return
        }
        const rect = buttonRef.current?.getBoundingClientRect()
        if (rect) {
          setPosition({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 420)),
            top: rect.bottom + 6,
          })
        }
        setOpen(true)
      }}
      className={cn(
        iconOnly ? 'flex size-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary' : 'flex h-[58px] min-w-[58px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-1.5 text-[10px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        (open || active) && 'bg-brand-purple/10 text-brand-purple',
        disabled && 'cursor-not-allowed opacity-35',
      )}
    >
      <span className="flex items-center gap-0.5"><Icon className={iconOnly ? 'size-4' : 'size-[19px]'} strokeWidth={1.65} />{iconOnly ? null : <span className="text-[8px]">▾</span>}</span>
      {iconOnly ? null : <span>{label}</span>}
    </button>
  )

  return (
    <>
      {iconOnly ? <PresentationTooltip content={open ? null : label}>{trigger}</PresentationTooltip> : trigger}
      {menu}
    </>
  )
}

function SearchControl({ iconOnly = false, onFindText }: { iconOnly?: boolean; onFindText: (query: string) => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  return (
    <CompactRibbonMenu icon={Search} iconOnly={iconOnly} label={t('session.presentation.search')}>
      <form
        className="flex items-center gap-2 p-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (query.trim()) onFindText(query.trim())
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('session.presentation.searchPlaceholder')}
          className="h-8 w-52 rounded-md border border-border-default bg-bg-surface px-2 text-xs text-text-primary outline-none focus:border-brand-purple"
        />
        <button type="submit" className="h-8 rounded-md bg-brand-purple px-3 text-xs font-semibold text-white">{t('session.presentation.search')}</button>
      </form>
    </CompactRibbonMenu>
  )
}

function RibbonGroup({ children, label, wide = false }: { children: ReactNode; label: string; wide?: boolean }) {
  return (
    <div className={cn('relative flex shrink-0 items-center gap-0.5 border-r border-border-subtle/70 px-1.5 last:border-r-0', wide && 'px-2')} aria-label={label}>
      {children}
    </div>
  )
}

function RibbonAction({ active, badge, disabled, dropdown, icon: Icon, label, onClick, testId }: {
  active?: boolean
  badge?: string
  disabled?: boolean
  dropdown?: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative flex h-[58px] min-w-[48px] flex-col items-center justify-center gap-1 rounded-lg px-1.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35',
        active && 'bg-brand-purple/10 text-brand-purple hover:bg-brand-purple/15 hover:text-brand-purple',
      )}
    >
      <span className="flex items-center gap-0.5"><Icon className="size-[19px]" strokeWidth={1.65} />{dropdown ? <span className="text-[8px]">▾</span> : null}</span>
      <span className="max-w-[68px] truncate">{label}</span>
      {badge ? <span className="absolute right-0.5 top-0.5 rounded bg-bg-elevated px-1 text-[8px] text-text-tertiary shadow-sm">{badge}</span> : null}
    </button>
  )
}

function FormatButton({ children, disabled, label, onClick, pressed, testId }: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
  pressed?: boolean
  testId?: string
}) {
  return (
    <PresentationTooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex size-6 items-center justify-center rounded-md text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-35',
          pressed && 'bg-brand-purple/12 text-brand-purple',
        )}
      >
        {children}
      </button>
    </PresentationTooltip>
  )
}

function PresentationTooltip({ children, content }: { children: ReactElement; content: ReactNode }) {
  return <Tooltip appearance="presentation" content={content} delayMs={0} placement="bottom">{children}</Tooltip>
}

function EffectButton({ active, disabled, icon: Icon, label, onClick, testId }: { active: boolean; disabled?: boolean; icon: LucideIcon; label: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex h-[54px] min-w-[68px] flex-col items-center justify-center gap-1 rounded-lg border border-border-subtle bg-bg-surface px-2 text-[10px] text-text-secondary shadow-sm transition-colors hover:border-brand-purple/35 hover:bg-bg-hover disabled:opacity-35',
        active && 'border-brand-purple bg-brand-purple/8 text-brand-purple ring-1 ring-brand-purple/20',
      )}
    >
      <Icon className="size-5 text-[#2678E8]" strokeWidth={1.7} />
      {label}
    </button>
  )
}
