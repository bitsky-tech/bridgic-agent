import { type ChangeEvent, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  BookOpenText,
  CalendarDays,
  CaseUpper,
  ChevronsUpDown,
  ClipboardPaste,
  Clock3,
  Columns3,
  Copy,
  FilePlus2,
  Hash,
  IndentDecrease,
  IndentIncrease,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  PanelTop,
  PanelBottom,
  Quote,
  Redo2,
  RemoveFormatting,
  Ruler,
  Scissors,
  SeparatorHorizontal,
  ImagePlus,
  Sigma,
  Strikethrough,
  Subscript,
  Superscript,
  Table2,
  Rows3,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'
import { Tooltip } from '@/components/amphi/Tooltip'
import { cn } from '@/lib/cn'
import type { WordFormattingCommand, WordPageSettings, WordTableAction } from '@/lib/wordDomain'

export type WordRibbonTab = 'home' | 'insert' | 'layout' | 'references' | 'view'

export interface WordRibbonProps {
  activeTab: WordRibbonTab
  page: WordPageSettings
  ribbonCollapsed: boolean
  rulerVisible: boolean
  tableActive?: boolean
  zoom: number
  onActiveTabChange: (tab: WordRibbonTab) => void
  onCommand: (command: WordFormattingCommand, value?: string) => void
  onInlineStyle: (property: string, value: string) => void
  onInsertCaption: () => void
  onInsertCitation: () => void
  onInsertFootnote: () => void
  onInsertHtml: (html: string) => void
  onInsertImage?: () => void
  onInsertLink: () => void
  onInsertPageBreak?: () => void
  onInsertTable?: () => void
  onInsertTableOfContents: () => void
  onEditFooter?: () => void
  onEditHeader?: () => void
  onPageChange: (page: Partial<WordPageSettings>) => void
  onTableAction?: (action: WordTableAction) => void
  onToggleRibbon: () => void
  onToggleRuler: () => void
  onZoomChange: (zoom: number) => void
}

const tabs: Array<{ id: WordRibbonTab; label: string }> = [
  { id: 'home', label: 'word.tab.home' },
  { id: 'insert', label: 'word.tab.insert' },
  { id: 'layout', label: 'word.tab.layout' },
  { id: 'references', label: 'word.tab.references' },
  { id: 'view', label: 'word.tab.view' },
]

const fontSizes: Array<{ label: string; value: string }> = [
  { label: '8', value: '1' },
  { label: '10', value: '2' },
  { label: '12', value: '3' },
  { label: '14', value: '4' },
  { label: '18', value: '5' },
  { label: '24', value: '6' },
  { label: '36', value: '7' },
]

const documentStyles = [
  { block: 'p', label: 'word.style.normal', sample: 'Aa' },
  { block: 'h1', label: 'word.style.heading1', sample: 'H1' },
  { block: 'h2', label: 'word.style.heading2', sample: 'H2' },
  { block: 'h3', label: 'word.style.heading3', sample: 'H3' },
  { block: 'h4', label: 'word.style.heading4', sample: 'H4' },
  { block: 'h5', label: 'word.style.heading5', sample: 'H5' },
  { block: 'blockquote', label: 'word.style.quote', sample: '“”' },
]

/** Excel-aligned Word ribbon whose commands remain owned by the Session renderer domain. */
export function WordRibbon({
  activeTab,
  page,
  ribbonCollapsed,
  rulerVisible,
  tableActive = false,
  zoom,
  onActiveTabChange,
  onCommand,
  onInlineStyle,
  onInsertCaption,
  onInsertCitation,
  onInsertFootnote,
  onInsertHtml,
  onInsertImage = () => undefined,
  onInsertLink,
  onInsertPageBreak = () => undefined,
  onInsertTable = () => undefined,
  onInsertTableOfContents,
  onEditFooter = () => undefined,
  onEditHeader = () => undefined,
  onPageChange,
  onTableAction = () => undefined,
  onToggleRibbon,
  onToggleRuler,
  onZoomChange,
}: WordRibbonProps) {
  const { t } = useTranslation()
  const preserveSelection = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault()

  return (
    <section className="shrink-0 border-b border-border-subtle bg-bg-app/70" data-ribbon-layout="excel-aligned" data-testid="word-ribbon-shell">
      <div className="flex h-9 items-stretch border-b border-border-subtle/55">
        <nav
          aria-label={t('word.ribbonTabs')}
          className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
        >
          {tabs.map((tab) => (
            <Tooltip content={t(tab.label)} delayMs={0} key={tab.id}>
              <button
                aria-selected={activeTab === tab.id}
                className={cn(
                  'relative h-8 shrink-0 px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary',
                  activeTab === tab.id && 'font-semibold text-text-primary',
                )}
                data-testid={`word-tab-${tab.id}`}
                onClick={() => onActiveTabChange(tab.id)}
                role="tab"
                type="button"
              >
                {t(tab.label)}
                {activeTab === tab.id ? (
                  <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500" />
                ) : null}
              </button>
            </Tooltip>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-0.5 px-2">
          <HeaderAction
            active={ribbonCollapsed}
            icon={ChevronsUpDown}
            label={ribbonCollapsed ? t('word.expandRibbon') : t('word.collapseRibbon')}
            onClick={onToggleRibbon}
          />
        </div>
      </div>

      <div
        className={cn(
          'overflow-x-auto bg-bg-app/45 shadow-[0_5px_18px_rgba(29,26,48,0.045)] transition-[height] duration-150 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          ribbonCollapsed ? 'h-0 overflow-hidden' : 'h-[82px]',
        )}
        data-testid="word-ribbon"
      >
        <section
          aria-hidden={ribbonCollapsed}
          aria-label={t('word.toolbar')}
          className="relative flex h-full min-w-max items-stretch px-2 py-1.5"
          data-testid="word-ribbon-toolbar"
          role="toolbar"
        >
        {activeTab === 'home' ? (
          <>
            <RibbonGroup label={t('word.group.history')}>
              <div className="grid grid-cols-3 gap-0.5">
                <FormatButton icon={ClipboardPaste} label={t('word.paste')} onClick={() => onCommand('paste')} onMouseDown={preserveSelection} />
                <FormatButton icon={Scissors} label={t('word.cut')} onClick={() => onCommand('cut')} onMouseDown={preserveSelection} />
                <FormatButton icon={Copy} label={t('word.copy')} onClick={() => onCommand('copy')} onMouseDown={preserveSelection} />
                <FormatButton icon={Undo2} label={t('word.undo')} onClick={() => onCommand('undo')} onMouseDown={preserveSelection} />
                <FormatButton icon={Redo2} label={t('word.redo')} onClick={() => onCommand('redo')} onMouseDown={preserveSelection} />
              </div>
            </RibbonGroup>

            <RibbonGroup label={t('word.group.font')} wide>
              <div className="flex min-w-[330px] flex-col justify-center gap-1">
                <div className="flex items-center gap-1">
                  <RibbonSelect
                    ariaLabel={t('word.fontFamily')}
                    className="w-[142px]"
                    defaultValue="Arial"
                    onChange={(event) => onCommand('fontName', event.target.value)}
                  >
                    <option value="Arial">Arial</option>
                    <option value="Arial Unicode MS">Arial Unicode</option>
                    <option value="Georgia">Georgia</option>
                    <option value="Helvetica Neue">Helvetica Neue</option>
                    <option value="Times New Roman">Times New Roman</option>
                    <option value="PingFang SC">苹方-简</option>
                    <option value="Songti SC">宋体-简</option>
                  </RibbonSelect>
                  <RibbonSelect
                    ariaLabel={t('word.fontSize')}
                    className="w-[58px]"
                    defaultValue="3"
                    onChange={(event) => onCommand('fontSize', event.target.value)}
                  >
                    {fontSizes.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}
                  </RibbonSelect>
                  <FormatButton label={t('word.growFont')} onClick={() => onCommand('increaseFontSize')} onMouseDown={preserveSelection}>
                    <span className="text-sm font-semibold">A<sup>+</sup></span>
                  </FormatButton>
                  <FormatButton label={t('word.shrinkFont')} onClick={() => onCommand('decreaseFontSize')} onMouseDown={preserveSelection}>
                    <span className="text-sm font-semibold">A<sup>−</sup></span>
                  </FormatButton>
                  <FormatButton icon={CaseUpper} label={t('word.changeCase')} onClick={() => onCommand('toggleCase')} onMouseDown={preserveSelection} />
                </div>
                <div className="flex items-center gap-0.5">
                  <FormatButton label={t('word.bold')} onClick={() => onCommand('bold')} onMouseDown={preserveSelection}><strong>B</strong></FormatButton>
                  <FormatButton label={t('word.italic')} onClick={() => onCommand('italic')} onMouseDown={preserveSelection}><em className="font-serif">I</em></FormatButton>
                  <FormatButton label={t('word.underline')} onClick={() => onCommand('underline')} onMouseDown={preserveSelection}><span className="underline">U</span></FormatButton>
                  <FormatButton icon={Strikethrough} label={t('word.strikethrough')} onClick={() => onCommand('strikeThrough')} onMouseDown={preserveSelection} />
                  <FormatButton icon={Subscript} label={t('word.subscript')} onClick={() => onCommand('subscript')} onMouseDown={preserveSelection} />
                  <FormatButton icon={Superscript} label={t('word.superscript')} onClick={() => onCommand('superscript')} onMouseDown={preserveSelection} />
                  <FormatButton icon={RemoveFormatting} label={t('word.clearFormatting')} onClick={() => onCommand('removeFormat')} onMouseDown={preserveSelection} />
                  <ColorControl label={t('word.highlightColor')} onChange={(value) => onCommand('hiliteColor', value)} type="highlight" value="#fff176" />
                  <ColorControl label={t('word.fontColor')} onChange={(value) => onCommand('foreColor', value)} type="font" value="#d32f2f" />
                </div>
              </div>
            </RibbonGroup>

            <RibbonGroup label={t('word.group.paragraph')} wide>
              <div className="flex min-w-[240px] flex-col justify-center gap-1">
                <div className="flex items-center gap-0.5">
                  <FormatButton icon={List} label={t('word.bulletedList')} onClick={() => onCommand('insertUnorderedList')} onMouseDown={preserveSelection} />
                  <FormatButton icon={ListOrdered} label={t('word.numberedList')} onClick={() => onCommand('insertOrderedList')} onMouseDown={preserveSelection} />
                  <FormatButton icon={ListChecks} label={t('word.checklist')} onClick={() => onCommand('toggleTaskList')} onMouseDown={preserveSelection} />
                  <FormatButton icon={IndentDecrease} label={t('word.decreaseIndent')} onClick={() => onCommand('outdent')} onMouseDown={preserveSelection} />
                  <FormatButton icon={IndentIncrease} label={t('word.increaseIndent')} onClick={() => onCommand('indent')} onMouseDown={preserveSelection} />
                  <RibbonSelect
                    ariaLabel={t('word.lineSpacing')}
                    className="w-[70px]"
                    defaultValue="1.5"
                    onChange={(event) => onInlineStyle('line-height', event.target.value)}
                  >
                    <option value="1">1.0</option>
                    <option value="1.15">1.15</option>
                    <option value="1.5">1.5</option>
                    <option value="2">2.0</option>
                  </RibbonSelect>
                </div>
                <div className="flex items-center gap-0.5">
                  <FormatButton icon={AlignLeft} label={t('word.alignLeft')} onClick={() => onCommand('justifyLeft')} onMouseDown={preserveSelection} />
                  <FormatButton icon={AlignCenter} label={t('word.alignCenter')} onClick={() => onCommand('justifyCenter')} onMouseDown={preserveSelection} />
                  <FormatButton icon={AlignRight} label={t('word.alignRight')} onClick={() => onCommand('justifyRight')} onMouseDown={preserveSelection} />
                  <FormatButton icon={AlignJustify} label={t('word.justify')} onClick={() => onCommand('justifyFull')} onMouseDown={preserveSelection} />
                </div>
              </div>
            </RibbonGroup>

            <RibbonGroup label={t('word.group.styles')} wide>
              <div className="flex h-full items-center gap-1">
                {documentStyles.map((style) => (
                  <Tooltip content={t(style.label)} delayMs={0} key={style.block}>
                    <button
                      aria-label={t(style.label)}
                      className="flex h-[54px] min-w-[72px] flex-col items-start justify-center rounded-md border border-border-subtle bg-bg-surface px-2 text-left shadow-sm hover:border-blue-500/35 hover:bg-bg-hover"
                      onClick={() => onCommand('formatBlock', style.block)}
                      onMouseDown={preserveSelection}
                      type="button"
                    >
                      <span className={cn('text-text-primary', style.block === 'h1' && 'text-base font-bold text-[#315d91]', style.block === 'h2' && 'text-sm font-bold', style.block === 'h3' && 'text-xs font-semibold', (style.block === 'h4' || style.block === 'h5') && 'text-xs font-medium text-[#315d91]')}>{style.sample}</span>
                      <span className="max-w-[74px] truncate text-[9px] text-text-tertiary">{t(style.label)}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'insert' ? (
          <>
            <RibbonGroup label={t('word.group.pages')}>
              <RibbonAction icon={FilePlus2} label={t('word.pageBreak')} onClick={onInsertPageBreak} />
              <RibbonAction icon={SeparatorHorizontal} label={t('word.horizontalRule')} onClick={() => onCommand('insertHorizontalRule')} />
            </RibbonGroup>
            <RibbonGroup label={t('word.group.tables')}>
              <RibbonAction icon={Table2} label={t('word.table')} onClick={onInsertTable} />
              <RibbonAction icon={Rows3} label={t('word.addTableRowBefore')} onClick={() => onTableAction('addRowBefore')} disabled={!tableActive} />
              <RibbonAction icon={Rows3} label={t('word.addTableRow')} onClick={() => onTableAction('addRowAfter')} disabled={!tableActive} />
              <RibbonAction icon={Trash2} label={t('word.deleteTableRow')} onClick={() => onTableAction('deleteRow')} disabled={!tableActive} />
              <RibbonAction icon={Columns3} label={t('word.addTableColumnBefore')} onClick={() => onTableAction('addColumnBefore')} disabled={!tableActive} />
              <RibbonAction icon={Columns3} label={t('word.addTableColumn')} onClick={() => onTableAction('addColumnAfter')} disabled={!tableActive} />
              <RibbonAction icon={Trash2} label={t('word.deleteTableColumn')} onClick={() => onTableAction('deleteColumn')} disabled={!tableActive} />
              <RibbonAction icon={Trash2} label={t('word.deleteTable')} onClick={() => onTableAction('deleteTable')} disabled={!tableActive} />
            </RibbonGroup>
            <RibbonGroup label={t('word.group.illustrations')}>
              <RibbonAction icon={ImagePlus} label={t('word.image')} onClick={onInsertImage} />
            </RibbonGroup>
            <RibbonGroup label={t('word.group.links')}>
              <RibbonAction icon={Link2} label={t('word.link')} onClick={onInsertLink} />
            </RibbonGroup>
            <RibbonGroup label={t('word.group.text')}>
              <RibbonAction icon={CalendarDays} label={t('word.date')} onClick={() => onInsertHtml(`<span>${new Date().toLocaleDateString()}</span>`)} />
              <RibbonAction icon={Clock3} label={t('word.time')} onClick={() => onInsertHtml(`<span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`)} />
              <RibbonAction icon={Quote} label={t('word.quote')} onClick={() => onCommand('formatBlock', 'blockquote')} />
              <RibbonAction icon={Sigma} label={t('word.symbol')} onClick={() => onInsertHtml('<span>Ω</span>')} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'layout' ? (
          <>
            <RibbonGroup label={t('word.group.pageSetup')}>
              <ChoiceAction
                icon={PanelTop}
                label={t('word.pageSize')}
                options={[
                  { active: page.size === 'a4', label: 'A4', onClick: () => onPageChange({ size: 'a4' }) },
                  { active: page.size === 'letter', label: t('word.letter'), onClick: () => onPageChange({ size: 'letter' }) },
                ]}
              />
              <ChoiceAction
                icon={BookOpenText}
                label={t('word.orientation')}
                options={[
                  { active: page.orientation === 'portrait', label: t('word.portrait'), onClick: () => onPageChange({ orientation: 'portrait' }) },
                  { active: page.orientation === 'landscape', label: t('word.landscape'), onClick: () => onPageChange({ orientation: 'landscape' }) },
                ]}
              />
              <ChoiceAction
                icon={Ruler}
                label={t('word.margins')}
                options={[
                  { active: page.margins === 'normal', label: t('word.margin.normal'), onClick: () => onPageChange({ margins: 'normal' }) },
                  { active: page.margins === 'narrow', label: t('word.margin.narrow'), onClick: () => onPageChange({ margins: 'narrow' }) },
                  { active: page.margins === 'wide', label: t('word.margin.wide'), onClick: () => onPageChange({ margins: 'wide' }) },
                ]}
              />
            </RibbonGroup>
            <RibbonGroup label={t('word.group.headerFooter')}>
              <RibbonAction icon={PanelTop} label={t('word.header')} onClick={onEditHeader} />
              <RibbonAction icon={PanelBottom} label={t('word.footer')} onClick={onEditFooter} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'references' ? (
          <>
            <RibbonGroup label={t('word.group.contents')}>
              <RibbonAction icon={BookOpenText} label={t('word.tableOfContents')} onClick={onInsertTableOfContents} />
            </RibbonGroup>
            <RibbonGroup label={t('word.group.footnotes')}>
              <RibbonAction icon={Hash} label={t('word.footnote')} onClick={onInsertFootnote} />
            </RibbonGroup>
            <RibbonGroup label={t('word.group.citations')}>
              <RibbonAction icon={Quote} label={t('word.citation')} onClick={onInsertCitation} />
              <RibbonAction icon={Baseline} label={t('word.caption')} onClick={onInsertCaption} />
            </RibbonGroup>
          </>
        ) : null}

        {activeTab === 'view' ? (
          <>
            <RibbonGroup label={t('word.group.show')}>
              <RibbonAction active={rulerVisible} icon={Ruler} label={t('word.ruler')} onClick={onToggleRuler} testId="word-toggle-ruler" />
            </RibbonGroup>
            <RibbonGroup label={t('word.group.zoom')}>
              <RibbonAction icon={ZoomOut} label={t('word.zoomOut')} onClick={() => onZoomChange(Math.max(50, zoom - 10))} />
              <Tooltip content={t('word.resetZoom')} delayMs={0}>
                <button aria-label={t('word.resetZoom')} className="h-10 min-w-[62px] self-center rounded-md border border-border-subtle bg-bg-surface px-2 text-xs font-semibold text-text-secondary hover:bg-bg-hover" onClick={() => onZoomChange(100)} type="button">{zoom}%</button>
              </Tooltip>
              <RibbonAction icon={ZoomIn} label={t('word.zoomIn')} onClick={() => onZoomChange(Math.min(200, zoom + 10))} />
            </RibbonGroup>
          </>
        ) : null}
        </section>
      </div>
    </section>
  )
}

function RibbonGroup({ children, label, wide = false }: { children: ReactNode; label: string; wide?: boolean }) {
  return (
    <div aria-label={label} className={cn('relative flex h-full shrink-0 items-center gap-0.5 border-r border-border-subtle px-1.5 pb-3 last:border-r-0', wide && 'px-2')} data-word-ribbon-group="true">
      {children}
      <span className="pointer-events-none absolute inset-x-1 bottom-0 truncate text-center text-[9px] text-text-tertiary">{label}</span>
    </div>
  )
}

function HeaderAction({ active = false, icon: Icon, label, onClick }: { active?: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <Tooltip content={label} delayMs={0}>
      <button
        aria-label={label}
        aria-pressed={active}
        className={cn('flex size-7 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary', active && 'bg-blue-500/10 text-blue-600')}
        onClick={onClick}
        type="button"
      >
        <Icon className="size-4" />
      </button>
    </Tooltip>
  )
}

function RibbonAction({ active = false, disabled = false, icon: Icon, label, onClick, testId }: { active?: boolean; disabled?: boolean; icon: LucideIcon; label: string; onClick: () => void; testId?: string }) {
  return (
    <Tooltip content={label} delayMs={0}>
      <span className="inline-flex">
        <button
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'relative flex h-14 w-12 flex-col items-center justify-center gap-1 rounded px-0.5 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            active && 'bg-blue-500/10 text-blue-600 hover:bg-blue-500/15 hover:text-blue-600',
            disabled && 'cursor-not-allowed opacity-35 hover:bg-transparent hover:text-text-secondary',
          )}
          data-compact-ribbon-action="true"
          data-compact-variant="tall"
          data-testid={testId}
          disabled={disabled}
          onClick={onClick}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          <Icon className="size-[18px]" strokeWidth={1.7} />
          <span className="max-w-11 truncate">{label}</span>
        </button>
      </span>
    </Tooltip>
  )
}

function FormatButton({ children, icon: Icon, label, onClick, onMouseDown }: {
  children?: ReactNode
  icon?: LucideIcon
  label: string
  onClick: () => void
  onMouseDown: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <Tooltip content={label} delayMs={0}>
      <button
        aria-label={label}
        className="flex size-6 items-center justify-center rounded-md text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        onClick={onClick}
        onMouseDown={onMouseDown}
        type="button"
      >
        {Icon ? <Icon className="size-3.5" /> : children}
      </button>
    </Tooltip>
  )
}

function RibbonSelect({ ariaLabel, children, className, defaultValue, onChange }: {
  ariaLabel: string
  children: ReactNode
  className: string
  defaultValue: string
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void
}) {
  return (
    <Tooltip content={ariaLabel} delayMs={0}>
      <select
        aria-label={ariaLabel}
        className={cn('h-6 rounded-md border border-border-default bg-bg-surface px-1.5 text-[10px] text-text-secondary outline-none focus:border-blue-500', className)}
        defaultValue={defaultValue}
        onChange={onChange}
      >
        {children}
      </select>
    </Tooltip>
  )
}

function ColorControl({ label, onChange, type, value }: { label: string; onChange: (value: string) => void; type: 'font' | 'highlight'; value: string }) {
  return (
    <Tooltip content={label} delayMs={0}>
      <label className="relative flex size-6 cursor-pointer items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary">
        {type === 'font' ? <Baseline className="size-3.5" /> : <Type className="size-3.5" />}
        <span className="absolute inset-x-1 bottom-0.5 h-0.5 rounded-full" style={{ backgroundColor: value }} />
        <input aria-label={label} className="sr-only" defaultValue={value} onChange={(event) => onChange(event.target.value)} type="color" />
      </label>
    </Tooltip>
  )
}

function ChoiceAction({ icon: Icon, label, options }: {
  icon: LucideIcon
  label: string
  options: Array<{ active: boolean; label: string; onClick: () => void }>
}) {
  return (
    <div className="flex h-14 min-w-[126px] flex-col justify-center gap-1 rounded px-1.5">
      <Tooltip content={label} delayMs={0}>
        <span className="flex items-center gap-1 text-[10px] font-medium text-text-tertiary"><Icon className="size-3.5" />{label}</span>
      </Tooltip>
      <div className="flex gap-1">
        {options.map((option) => (
          <Tooltip content={`${label}：${option.label}`} delayMs={0} key={option.label}>
            <button
              aria-label={`${label}：${option.label}`}
              aria-pressed={option.active}
              className={cn(
                'h-7 rounded-md border border-border-subtle bg-bg-surface px-2 text-[10px] text-text-secondary hover:bg-bg-hover',
                option.active && 'border-blue-500/40 bg-blue-500/10 font-semibold text-blue-600',
              )}
              onClick={option.onClick}
              type="button"
            >
              {option.label}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
