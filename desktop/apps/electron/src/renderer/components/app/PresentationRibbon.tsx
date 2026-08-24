import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BarChart3,
  Circle,
  Copy,
  FilePlus2,
  Image,
  LayoutGrid,
  Link2,
  List,
  MousePointer2,
  Paintbrush,
  Palette,
  Play,
  Printer,
  Redo2,
  Search,
  Shapes,
  Square,
  Table2,
  Trash2,
  Type,
  Undo2,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react'
import type {
  PresentationAnimationEffect,
  PresentationElement,
  PresentationSlide,
  PresentationTextElement,
  PresentationTransition,
} from '@/atoms/presentation'
import { cn } from '@/lib/cn'

export type PresentationRibbonTab =
  | 'home'
  | 'insert'
  | 'design'
  | 'transitions'
  | 'animations'
  | 'slideshow'
  | 'review'
  | 'view'

interface PresentationRibbonProps {
  activeTab: PresentationRibbonTab
  compact: boolean
  currentSlide: PresentationSlide | undefined
  filmstripCollapsed: boolean
  historyStatus: { canUndo: boolean; canRedo: boolean }
  inspectorOpen: boolean
  selectedElement: PresentationElement | null
  selectedText: PresentationTextElement | null
  onActiveTabChange: (tab: PresentationRibbonTab) => void
  onAddShape: (type: 'rect' | 'ellipse') => void
  onAddSlide: () => void
  onAddText: (kind: 'title' | 'body') => void
  onDeleteElement: () => void
  onDuplicateSlide: () => void
  onPreviewAnimation: () => void
  onPreviewTransition: () => void
  onRedo: () => void
  onSlideChange: (patch: Partial<PresentationSlide>) => void
  onStartSlideshow: () => void
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
  { id: 'review', label: 'session.presentation.tabReview' },
  { id: 'view', label: 'session.presentation.tabView' },
]

const slideThemes = [
  { color: '#FFFFFF', label: 'session.presentation.themeLight' },
  { color: '#F7F3EA', label: 'session.presentation.themePaper' },
  { color: '#17182B', label: 'session.presentation.themeMidnight' },
  { color: '#EDE9FE', label: 'session.presentation.themeLavender' },
  { color: '#E9F5F1', label: 'session.presentation.themeMint' },
]

const transitions: Array<{ id: PresentationTransition; label: string }> = [
  { id: 'none', label: 'session.presentation.effectNone' },
  { id: 'fade', label: 'session.presentation.effectFade' },
  { id: 'push', label: 'session.presentation.effectPush' },
  { id: 'wipe', label: 'session.presentation.effectWipe' },
]

const animations: Array<{ id: PresentationAnimationEffect; label: string }> = [
  { id: 'none', label: 'session.presentation.effectNone' },
  { id: 'appear', label: 'session.presentation.effectAppear' },
  { id: 'fade', label: 'session.presentation.effectFade' },
  { id: 'flyIn', label: 'session.presentation.effectFlyIn' },
  { id: 'zoom', label: 'session.presentation.effectZoom' },
]

export function PresentationRibbon({
  activeTab,
  compact,
  currentSlide,
  filmstripCollapsed,
  historyStatus,
  inspectorOpen,
  selectedElement,
  selectedText,
  onActiveTabChange,
  onAddShape,
  onAddSlide,
  onAddText,
  onDeleteElement,
  onDuplicateSlide,
  onPreviewAnimation,
  onPreviewTransition,
  onRedo,
  onSlideChange,
  onStartSlideshow,
  onToggleFilmstrip,
  onToggleInspector,
  onUndo,
  onUpdateElement,
}: PresentationRibbonProps) {
  const { t } = useTranslation()

  return (
    <div className="shrink-0 bg-bg-surface/95">
      <nav
        className="flex h-9 items-end gap-0.5 overflow-x-auto border-b border-border-subtle/55 px-2"
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
      <section
        className="flex h-[92px] items-stretch gap-1 overflow-x-auto border-b border-border-subtle/70 bg-bg-app/45 px-2 py-1.5 shadow-[0_5px_18px_rgba(29,26,48,0.045)]"
        data-testid="presentation-ribbon"
      >
        {activeTab === 'home' ? (
          <>
            <RibbonGroup label={t('session.presentation.history')}>
              <RibbonAction icon={Undo2} label={t('session.presentation.undo')} onClick={onUndo} disabled={!historyStatus.canUndo} />
              <RibbonAction icon={Redo2} label={t('session.presentation.redo')} onClick={onRedo} disabled={!historyStatus.canRedo} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.slides')}>
              <RibbonAction icon={FilePlus2} label={t('session.presentation.newSlide')} onClick={onAddSlide} />
              <RibbonAction icon={Copy} label={t('session.presentation.duplicateSlide')} onClick={onDuplicateSlide} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.insert')}>
              <RibbonAction icon={Type} label={t('session.presentation.addText')} onClick={() => onAddText('body')} testId="presentation-add-text" />
              <RibbonAction icon={Shapes} label={t('session.presentation.addRectangle')} onClick={() => onAddShape('rect')} />
            </RibbonGroup>
            <TextControls selectedText={selectedText} compact={compact} onUpdateElement={onUpdateElement} />
            <RibbonGroup label={t('session.presentation.arrange')}>
              <RibbonAction icon={MousePointer2} label={t('session.presentation.select')} onClick={() => undefined} active={Boolean(selectedElement)} />
              <RibbonAction icon={Paintbrush} label={t('session.presentation.properties')} onClick={onToggleInspector} active={inspectorOpen} />
              <RibbonAction icon={Trash2} label={t('session.presentation.deleteElement')} onClick={onDeleteElement} disabled={!selectedElement} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'insert' ? (
          <>
            <RibbonGroup label={t('session.presentation.slides')}>
              <RibbonAction icon={FilePlus2} label={t('session.presentation.newSlide')} onClick={onAddSlide} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.textAndShapes')}>
              <RibbonAction icon={Type} label={t('session.presentation.addTitle')} onClick={() => onAddText('title')} />
              <RibbonAction icon={Type} label={t('session.presentation.addText')} onClick={() => onAddText('body')} testId="presentation-add-text" />
              <RibbonAction icon={Square} label={t('session.presentation.addRectangle')} onClick={() => onAddShape('rect')} />
              <RibbonAction icon={Circle} label={t('session.presentation.addEllipse')} onClick={() => onAddShape('ellipse')} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.content')}>
              <RibbonAction icon={Image} label={t('session.presentation.image')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
              <RibbonAction icon={Table2} label={t('session.presentation.table')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
              <RibbonAction icon={BarChart3} label={t('session.presentation.chart')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
              <RibbonAction icon={Link2} label={t('session.presentation.link')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'design' ? (
          <>
            <RibbonGroup label={t('session.presentation.quickThemes')} wide>
              <div className="flex h-full items-center gap-2 px-1">
                {slideThemes.map((theme) => (
                  <button
                    key={theme.color}
                    type="button"
                    title={t(theme.label)}
                    aria-label={t(theme.label)}
                    aria-pressed={currentSlide?.background === theme.color}
                    onClick={() => onSlideChange({ background: theme.color })}
                    className={cn(
                      'h-12 w-[62px] rounded-lg border border-black/10 shadow-sm transition-transform hover:-translate-y-0.5',
                      currentSlide?.background === theme.color && 'ring-2 ring-brand-purple ring-offset-1 ring-offset-bg-app',
                    )}
                    style={{ backgroundColor: theme.color }}
                  >
                    <span className="mx-auto block h-1 w-7 rounded-full bg-brand-purple/75" />
                  </button>
                ))}
              </div>
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.customize')}>
              <label className="flex h-full w-[72px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg text-[10px] text-text-secondary hover:bg-bg-hover">
                <Palette className="size-5" strokeWidth={1.7} />
                {t('session.presentation.background')}
                <input
                  type="color"
                  value={currentSlide?.background ?? '#FFFFFF'}
                  onChange={(event) => onSlideChange({ background: event.target.value })}
                  className="sr-only"
                />
              </label>
              <RibbonAction icon={WandSparkles} label={t('session.presentation.beautify')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'transitions' ? (
          <>
            <RibbonGroup label={t('session.presentation.transitionEffects')} wide>
              {transitions.map((effect) => (
                <EffectButton
                  key={effect.id}
                  active={(currentSlide?.transition ?? 'none') === effect.id}
                  label={t(effect.label)}
                  onClick={() => onSlideChange({ transition: effect.id })}
                  testId={`presentation-transition-${effect.id}`}
                />
              ))}
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.preview')}>
              <RibbonAction icon={Play} label={t('session.presentation.preview')} onClick={onPreviewTransition} disabled={!currentSlide || currentSlide.transition === 'none'} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'animations' ? (
          <>
            <RibbonGroup label={t('session.presentation.animationEffects')} wide>
              {animations.map((effect) => (
                <EffectButton
                  key={effect.id}
                  active={(selectedElement?.animation ?? 'none') === effect.id}
                  disabled={!selectedElement}
                  label={t(effect.label)}
                  onClick={() => onUpdateElement({ animation: effect.id })}
                  testId={`presentation-animation-${effect.id}`}
                />
              ))}
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.preview')}>
              <RibbonAction icon={Play} label={t('session.presentation.preview')} onClick={onPreviewAnimation} disabled={!selectedElement || selectedElement.animation === 'none'} />
            </RibbonGroup>
            <p className="flex max-w-[180px] items-center px-2 text-[10px] leading-relaxed text-text-tertiary">
              {t('session.presentation.animationPreviewOnly')}
            </p>
          </>
        ) : null}

        {activeTab === 'slideshow' ? (
          <>
            <RibbonGroup label={t('session.presentation.slideshow')}>
              <RibbonAction icon={Play} label={t('session.presentation.playFromCurrent')} onClick={onStartSlideshow} />
              <RibbonAction icon={LayoutGrid} label={t('session.presentation.presenterView')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
            </RibbonGroup>
            <RibbonGroup label={t('session.presentation.output')}>
              <RibbonAction icon={Printer} label={t('session.presentation.print')} onClick={() => window.print()} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'review' ? (
          <>
            <RibbonGroup label={t('session.presentation.review')}>
              <RibbonAction icon={Search} label={t('session.presentation.spellcheck')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
              <RibbonAction icon={List} label={t('session.presentation.comments')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'view' ? (
          <>
            <RibbonGroup label={t('session.presentation.workspace')}>
              <RibbonAction icon={LayoutGrid} label={t('session.presentation.slideThumbnails')} onClick={onToggleFilmstrip} active={!filmstripCollapsed} testId="presentation-toggle-filmstrip" />
              <RibbonAction icon={Paintbrush} label={t('session.presentation.guides')} onClick={() => undefined} disabled badge={t('session.presentation.soon')} />
            </RibbonGroup>
          </>
        ) : null}
      </section>
    </div>
  )
}

function TextControls({ selectedText, compact, onUpdateElement }: {
  selectedText: PresentationTextElement | null
  compact: boolean
  onUpdateElement: (patch: Partial<PresentationElement>) => void
}) {
  const { t } = useTranslation()
  const disabled = !selectedText
  return (
    <>
      <RibbonGroup label={t('session.presentation.font')} wide>
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
                compact ? 'w-[86px]' : 'w-[112px]',
              )}
            >
              <option value="Aptos">Aptos</option>
              <option value="Aptos Display">Aptos Display</option>
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
                if (Number.isFinite(value)) onUpdateElement({ fontSize: value })
              }}
              className="h-7 w-12 rounded-md border border-border-subtle bg-bg-surface px-1 text-center text-xs text-text-secondary outline-none focus:border-brand-purple disabled:opacity-45"
            />
          </div>
          <div className="flex items-center gap-0.5">
            <FormatButton label={t('session.presentation.bold')} disabled={disabled} pressed={(selectedText?.fontWeight ?? 400) >= 600} onClick={() => onUpdateElement({ fontWeight: (selectedText?.fontWeight ?? 400) >= 600 ? 400 : 700 })} testId="presentation-bold"><b>B</b></FormatButton>
            <FormatButton label={t('session.presentation.italic')} disabled={disabled} pressed={Boolean(selectedText?.italic)} onClick={() => onUpdateElement({ italic: !selectedText?.italic })} testId="presentation-italic"><i>I</i></FormatButton>
            <FormatButton label={t('session.presentation.underline')} disabled={disabled} pressed={Boolean(selectedText?.underline)} onClick={() => onUpdateElement({ underline: !selectedText?.underline })} testId="presentation-underline"><u>U</u></FormatButton>
            <label className={cn('ml-1 flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-bg-hover', disabled && 'pointer-events-none opacity-35')} title={t('session.presentation.textColor')}>
              <span className="h-3.5 w-3.5 rounded-full border border-black/15" style={{ backgroundColor: selectedText?.color ?? '#20202B' }} />
              <input type="color" className="sr-only" disabled={disabled} value={selectedText?.color ?? '#20202B'} onChange={(event) => onUpdateElement({ color: event.target.value })} />
            </label>
          </div>
        </div>
      </RibbonGroup>
      <RibbonGroup label={t('session.presentation.paragraph')}>
        <FormatButton label={t('session.presentation.alignLeft')} disabled={disabled} pressed={selectedText?.align === 'left'} onClick={() => onUpdateElement({ align: 'left' })}><AlignLeft className="size-4" /></FormatButton>
        <FormatButton label={t('session.presentation.alignCenter')} disabled={disabled} pressed={selectedText?.align === 'center'} onClick={() => onUpdateElement({ align: 'center' })} testId="presentation-align-center"><AlignCenter className="size-4" /></FormatButton>
        <FormatButton label={t('session.presentation.alignRight')} disabled={disabled} pressed={selectedText?.align === 'right'} onClick={() => onUpdateElement({ align: 'right' })}><AlignRight className="size-4" /></FormatButton>
      </RibbonGroup>
    </>
  )
}

function RibbonGroup({ children, label, wide = false }: { children: ReactNode; label: string; wide?: boolean }) {
  return (
    <div className={cn('relative flex shrink-0 items-center gap-0.5 border-r border-border-subtle/70 px-1.5 pb-3.5 last:border-r-0', wide && 'px-2')}>
      {children}
      <span className="pointer-events-none absolute inset-x-1 bottom-0 truncate text-center text-[9px] font-medium text-text-tertiary">{label}</span>
    </div>
  )
}

function RibbonAction({ active, badge, disabled, icon: Icon, label, onClick, testId }: {
  active?: boolean
  badge?: string
  disabled?: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      title={label}
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
      <Icon className="size-[19px]" strokeWidth={1.65} />
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
    <button
      type="button"
      title={label}
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
  )
}

function EffectButton({ active, disabled, label, onClick, testId }: { active: boolean; disabled?: boolean; label: string; onClick: () => void; testId?: string }) {
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
      <span className="relative block h-6 w-9 overflow-hidden rounded border border-border-default bg-white">
        <span className="absolute inset-y-1 left-1 w-0.5 rounded bg-brand-purple" />
        <span className="absolute left-2.5 right-1 top-1.5 h-1 rounded bg-slate-300" />
        <span className="absolute left-2.5 right-2 top-3.5 h-1 rounded bg-slate-200" />
      </span>
      {label}
    </button>
  )
}
