import { type FormEvent, type ReactNode } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  ArrowUpZA,
  Bold,
  Calculator,
  Columns3,
  DollarSign,
  Eraser,
  Eye,
  Filter,
  FunctionSquare,
  Grid3X3,
  Hash,
  Image,
  Italic,
  ListChecks,
  LibraryBig,
  Merge,
  PaintBucket,
  Palette,
  Percent,
  Plus,
  Printer,
  Redo2,
  Rows3,
  Sigma,
  Snowflake,
  Strikethrough,
  Underline,
  Undo2,
  WrapText,
  type LucideIcon,
} from 'lucide-react'
import type { ExcelHostConfig } from '../../shared/types'
import {
  EXCEL_FORMULA_CATEGORIES,
  type ExcelFormulaCategory,
} from './excelFormulaCatalog'

export type ExcelRibbonTab = 'home' | 'insert' | 'data' | 'formulas' | 'view'

export type ExcelRibbonAction =
  | 'undo'
  | 'redo'
  | 'font-family'
  | 'font-size'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'font-color'
  | 'fill-color'
  | 'borders'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'wrap'
  | 'merge-center'
  | 'merge-cells'
  | 'merge-across'
  | 'unmerge'
  | 'number-format'
  | 'percent'
  | 'currency'
  | 'clear-format'
  | 'insert-row-above'
  | 'insert-row-below'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'insert-sheet'
  | 'insert-image'
  | 'toggle-filter'
  | 'clear-filter'
  | 'sort-ascending'
  | 'sort-descending'
  | 'data-validation'
  | 'conditional-formatting'
  | 'formula-sum'
  | 'formula-average'
  | 'formula-count'
  | 'formula-max'
  | 'formula-min'
  | 'formula-insert'
  | 'formula-more'
  | 'toggle-gridlines'
  | 'freeze-first-row'
  | 'freeze-first-column'
  | 'unfreeze'
  | 'print'

interface ExcelRibbonProps {
  activeTab: ExcelRibbonTab
  disabled: boolean
  locale: ExcelHostConfig['locale']
  onAction: (action: ExcelRibbonAction, value?: string | number) => void
  onActiveTabChange: (tab: ExcelRibbonTab) => void
  onAddressSubmit: (address: string) => void
  onFormulaSubmit: (value: string) => void
  selectionAddress: string
  selectionValue: string
}

type RibbonGroupId =
  | 'history'
  | 'font'
  | 'alignment'
  | 'number'
  | 'styles'
  | 'rowsColumns'
  | 'workbook'
  | 'media'
  | 'organize'
  | 'rules'
  | 'formulaQuick'
  | 'formulaCategories'
  | 'formulaLibrary'
  | 'sheetView'
  | 'freeze'
  | 'output'

interface RibbonCopy {
  tabs: Record<ExcelRibbonTab, string>
  groups: Record<RibbonGroupId, string>
  actions: Record<ExcelRibbonAction, string>
  formulaCategories: Record<ExcelFormulaCategory, string>
  mergeMenu: string
}

const zhCN: RibbonCopy = {
  tabs: { home: '开始', insert: '插入', data: '数据', formulas: '公式', view: '视图' },
  groups: {
    history: '编辑', font: '字体', alignment: '对齐', number: '数字', styles: '样式',
    rowsColumns: '行和列', workbook: '工作簿', media: '媒体', organize: '排序和筛选',
    rules: '数据工具', formulaQuick: '常用函数', formulaCategories: '函数分类', formulaLibrary: '函数库',
    sheetView: '工作表视图', freeze: '冻结窗格', output: '输出',
  },
  actions: {
    undo: '撤销', redo: '重做', 'font-family': '字体', 'font-size': '字号', bold: '加粗', italic: '斜体',
    underline: '下划线', strikethrough: '删除线', 'font-color': '字体颜色', 'fill-color': '填充颜色',
    borders: '所有边框', 'align-left': '左对齐', 'align-center': '居中', 'align-right': '右对齐',
    wrap: '自动换行', 'merge-center': '合并后居中', 'merge-cells': '合并单元格',
    'merge-across': '跨列合并', unmerge: '取消合并', 'number-format': '数字格式', percent: '百分比',
    currency: '货币', 'clear-format': '清除格式', 'insert-row-above': '在上方插入行',
    'insert-row-below': '在下方插入行', 'insert-column-left': '在左侧插入列',
    'insert-column-right': '在右侧插入列', 'insert-sheet': '新建工作表', 'insert-image': '插入图片',
    'toggle-filter': '筛选', 'clear-filter': '清除筛选', 'sort-ascending': '升序',
    'sort-descending': '降序', 'data-validation': '数据验证', 'conditional-formatting': '条件格式',
    'formula-sum': '自动求和', 'formula-average': '平均值', 'formula-count': '计数',
    'formula-max': '最大值', 'formula-min': '最小值', 'formula-insert': '插入函数', 'formula-more': '全部函数',
    'toggle-gridlines': '显示/隐藏网格线',
    'freeze-first-row': '冻结首行', 'freeze-first-column': '冻结首列', unfreeze: '取消冻结', print: '打印',
  },
  formulaCategories: {
    common: '常用', financial: '财务', logical: '逻辑', text: '文本', date: '日期与时间',
    lookup: '查找与引用', math: '数学', statistical: '统计',
  },
  mergeMenu: '更多合并选项',
}

const enUS: RibbonCopy = {
  tabs: { home: 'Home', insert: 'Insert', data: 'Data', formulas: 'Formulas', view: 'View' },
  groups: {
    history: 'Edit', font: 'Font', alignment: 'Alignment', number: 'Number', styles: 'Styles',
    rowsColumns: 'Rows & columns', workbook: 'Workbook', media: 'Media', organize: 'Sort & filter',
    rules: 'Data tools', formulaQuick: 'Quick functions', formulaCategories: 'Categories', formulaLibrary: 'Library',
    sheetView: 'Sheet view', freeze: 'Freeze panes', output: 'Output',
  },
  actions: {
    undo: 'Undo', redo: 'Redo', 'font-family': 'Font', 'font-size': 'Font size', bold: 'Bold', italic: 'Italic',
    underline: 'Underline', strikethrough: 'Strikethrough', 'font-color': 'Font color', 'fill-color': 'Fill color',
    borders: 'All borders', 'align-left': 'Align left', 'align-center': 'Center', 'align-right': 'Align right',
    wrap: 'Wrap text', 'merge-center': 'Merge & center', 'merge-cells': 'Merge cells',
    'merge-across': 'Merge across', unmerge: 'Unmerge cells', 'number-format': 'Number format', percent: 'Percent',
    currency: 'Currency', 'clear-format': 'Clear formatting', 'insert-row-above': 'Insert row above',
    'insert-row-below': 'Insert row below', 'insert-column-left': 'Insert column left',
    'insert-column-right': 'Insert column right', 'insert-sheet': 'New sheet', 'insert-image': 'Insert image',
    'toggle-filter': 'Filter', 'clear-filter': 'Clear filter', 'sort-ascending': 'Sort ascending',
    'sort-descending': 'Sort descending', 'data-validation': 'Data validation',
    'conditional-formatting': 'Conditional formatting', 'formula-sum': 'AutoSum', 'formula-average': 'Average',
    'formula-count': 'Count', 'formula-max': 'Maximum', 'formula-min': 'Minimum',
    'formula-insert': 'Insert function', 'formula-more': 'All functions',
    'toggle-gridlines': 'Show/hide gridlines', 'freeze-first-row': 'Freeze first row',
    'freeze-first-column': 'Freeze first column', unfreeze: 'Unfreeze', print: 'Print',
  },
  formulaCategories: {
    common: 'Common', financial: 'Financial', logical: 'Logical', text: 'Text', date: 'Date & time',
    lookup: 'Lookup & reference', math: 'Math', statistical: 'Statistical',
  },
  mergeMenu: 'More merge options',
}

const tabs: ExcelRibbonTab[] = ['home', 'insert', 'data', 'formulas', 'view']

export function ExcelRibbon({
  activeTab,
  disabled,
  locale,
  onAction,
  onActiveTabChange,
  onAddressSubmit,
  onFormulaSubmit,
  selectionAddress,
  selectionValue,
}: ExcelRibbonProps) {
  const copy = locale === 'zh-CN' ? zhCN : enUS
  const action = (id: ExcelRibbonAction, value?: string | number) => onAction(id, value)

  return (
    <section className="shrink-0 border-b border-border-subtle bg-bg-app/70" data-testid="excel-ribbon">
      <nav className="flex h-9 items-end gap-1 px-3" role="tablist" aria-label="Excel ribbon">
        {tabs.map((tab) => (
          <button
            aria-selected={activeTab === tab}
            className={`relative h-9 px-3 text-[11px] font-medium transition-colors ${activeTab === tab ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
            key={tab}
            onClick={() => onActiveTabChange(tab)}
            role="tab"
            type="button"
          >
            {copy.tabs[tab]}
            {activeTab === tab ? <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-gradient-to-r from-orange-400 to-rose-500" /> : null}
          </button>
        ))}
      </nav>
      <div className="h-[82px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex h-full min-w-max items-stretch px-2 py-1.5" role="toolbar" aria-label={copy.tabs[activeTab]}>
          {activeTab === 'home' ? (
            <>
              <RibbonGroup label={copy.groups.history}>
                <Action icon={Undo2} id="undo" label={copy.actions.undo} disabled={disabled} onAction={action} />
                <Action icon={Redo2} id="redo" label={copy.actions.redo} disabled={disabled} onAction={action} />
                <Action icon={Eraser} id="clear-format" label={copy.actions['clear-format']} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.font} wide>
                <RibbonSelect ariaLabel={copy.actions['font-family']} disabled={disabled} onChange={(value) => action('font-family', value)} value="Arial">
                  <option>Arial</option><option>Calibri</option><option>Microsoft YaHei</option><option>Times New Roman</option>
                </RibbonSelect>
                <RibbonSelect ariaLabel={copy.actions['font-size']} disabled={disabled} onChange={(value) => action('font-size', Number(value))} value="11" narrow>
                  {[9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36].map((size) => <option key={size}>{size}</option>)}
                </RibbonSelect>
                <Action icon={Bold} id="bold" label={copy.actions.bold} disabled={disabled} onAction={action} />
                <Action icon={Italic} id="italic" label={copy.actions.italic} disabled={disabled} onAction={action} />
                <Action icon={Underline} id="underline" label={copy.actions.underline} disabled={disabled} onAction={action} />
                <Action icon={Strikethrough} id="strikethrough" label={copy.actions.strikethrough} disabled={disabled} onAction={action} />
                <ColorAction icon={Underline} id="font-color" label={copy.actions['font-color']} disabled={disabled} color="#1f2937" onAction={action} />
                <ColorAction icon={PaintBucket} id="fill-color" label={copy.actions['fill-color']} disabled={disabled} color="#fff2cc" onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.alignment}>
                <Action icon={AlignLeft} id="align-left" label={copy.actions['align-left']} disabled={disabled} onAction={action} />
                <Action icon={AlignCenter} id="align-center" label={copy.actions['align-center']} disabled={disabled} onAction={action} />
                <Action icon={AlignRight} id="align-right" label={copy.actions['align-right']} disabled={disabled} onAction={action} />
                <Action icon={WrapText} id="wrap" label={copy.actions.wrap} disabled={disabled} onAction={action} />
                <MergeMenu copy={copy} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.number} wide>
                <RibbonSelect ariaLabel={copy.actions['number-format']} disabled={disabled} onChange={(value) => action('number-format', value)} value="General">
                  <option value="General">General</option><option value="0">0</option><option value="0.00">0.00</option>
                  <option value="#,##0">#,##0</option><option value="yyyy-mm-dd">yyyy-mm-dd</option>
                </RibbonSelect>
                <Action icon={Percent} id="percent" label={copy.actions.percent} disabled={disabled} onAction={action} />
                <Action icon={DollarSign} id="currency" label={copy.actions.currency} disabled={disabled} onAction={action} />
                <Action icon={Grid3X3} id="borders" label={copy.actions.borders} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.styles}>
                <LargeAction icon={Palette} id="conditional-formatting" label={copy.actions['conditional-formatting']} disabled={disabled} onAction={action} />
              </RibbonGroup>
            </>
          ) : null}
          {activeTab === 'insert' ? (
            <>
              <RibbonGroup label={copy.groups.rowsColumns} wide>
                <Action icon={Rows3} id="insert-row-above" label={copy.actions['insert-row-above']} disabled={disabled} onAction={action} />
                <Action icon={Rows3} id="insert-row-below" label={copy.actions['insert-row-below']} disabled={disabled} onAction={action} />
                <Action icon={Columns3} id="insert-column-left" label={copy.actions['insert-column-left']} disabled={disabled} onAction={action} />
                <Action icon={Columns3} id="insert-column-right" label={copy.actions['insert-column-right']} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.workbook}>
                <LargeAction icon={Plus} id="insert-sheet" label={copy.actions['insert-sheet']} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.media}>
                <LargeAction icon={Image} id="insert-image" label={copy.actions['insert-image']} disabled={disabled} onAction={action} />
              </RibbonGroup>
            </>
          ) : null}
          {activeTab === 'data' ? (
            <>
              <RibbonGroup label={copy.groups.organize} wide>
                <LargeAction icon={Filter} id="toggle-filter" label={copy.actions['toggle-filter']} disabled={disabled} onAction={action} />
                <Action icon={Eraser} id="clear-filter" label={copy.actions['clear-filter']} disabled={disabled} onAction={action} />
                <Action icon={ArrowDownAZ} id="sort-ascending" label={copy.actions['sort-ascending']} disabled={disabled} onAction={action} />
                <Action icon={ArrowUpZA} id="sort-descending" label={copy.actions['sort-descending']} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.rules}>
                <LargeAction icon={ListChecks} id="data-validation" label={copy.actions['data-validation']} disabled={disabled} onAction={action} />
                <LargeAction icon={Palette} id="conditional-formatting" label={copy.actions['conditional-formatting']} disabled={disabled} onAction={action} />
              </RibbonGroup>
            </>
          ) : null}
          {activeTab === 'formulas' ? (
            <>
              <RibbonGroup label={copy.groups.formulaQuick} wide>
                <LargeAction icon={Sigma} id="formula-sum" label={copy.actions['formula-sum']} disabled={disabled} onAction={action} />
                <Action icon={Calculator} id="formula-average" label={copy.actions['formula-average']} disabled={disabled} onAction={action} />
                <Action icon={Hash} id="formula-count" label={copy.actions['formula-count']} disabled={disabled} onAction={action} />
                <Action icon={FunctionSquare} id="formula-max" label={copy.actions['formula-max']} disabled={disabled} onAction={action} />
                <Action icon={FunctionSquare} id="formula-min" label={copy.actions['formula-min']} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.formulaCategories} wide>
                {(Object.keys(EXCEL_FORMULA_CATEGORIES) as ExcelFormulaCategory[]).map((category) => (
                  <FormulaSelect
                    disabled={disabled}
                    functions={EXCEL_FORMULA_CATEGORIES[category]}
                    key={category}
                    label={copy.formulaCategories[category]}
                    onSelect={(formula) => action('formula-insert', formula)}
                  />
                ))}
              </RibbonGroup>
              <RibbonGroup label={copy.groups.formulaLibrary}>
                <LargeAction icon={LibraryBig} id="formula-more" label={copy.actions['formula-more']} disabled={disabled} onAction={action} />
              </RibbonGroup>
            </>
          ) : null}
          {activeTab === 'view' ? (
            <>
              <RibbonGroup label={copy.groups.sheetView}>
                <LargeAction icon={Eye} id="toggle-gridlines" label={copy.actions['toggle-gridlines']} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.freeze} wide>
                <Action icon={Rows3} id="freeze-first-row" label={copy.actions['freeze-first-row']} disabled={disabled} onAction={action} />
                <Action icon={Columns3} id="freeze-first-column" label={copy.actions['freeze-first-column']} disabled={disabled} onAction={action} />
                <Action icon={Snowflake} id="unfreeze" label={copy.actions.unfreeze} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.output}>
                <LargeAction icon={Printer} id="print" label={copy.actions.print} disabled={disabled} onAction={action} />
              </RibbonGroup>
            </>
          ) : null}
        </div>
      </div>
      <FormulaBar
        address={selectionAddress}
        disabled={disabled}
        onAddressSubmit={onAddressSubmit}
        onFormulaSubmit={onFormulaSubmit}
        value={selectionValue}
      />
    </section>
  )
}

function FormulaBar({ address, disabled, onAddressSubmit, onFormulaSubmit, value }: {
  address: string
  disabled: boolean
  onAddressSubmit: (address: string) => void
  onFormulaSubmit: (value: string) => void
  value: string
}) {
  const submitAddress = (event: FormEvent) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget as HTMLFormElement)
    onAddressSubmit(String(data.get('address') ?? '').trim())
  }
  const submitValue = (event: FormEvent) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget as HTMLFormElement)
    onFormulaSubmit(String(data.get('value') ?? ''))
  }

  return (
    <div className="flex h-8 items-center gap-1 border-t border-border-subtle bg-bg-surface px-2">
      <form className="h-6 w-24 shrink-0" key={`address:${address}`} onSubmit={submitAddress}>
        <input
          aria-label="Name box"
          className="h-full w-full rounded border border-border-subtle bg-bg-app px-2 text-[10px] text-text-secondary outline-none focus:border-orange-400"
          defaultValue={address}
          disabled={disabled}
          name="address"
          spellCheck={false}
        />
      </form>
      <FunctionSquare className="shrink-0 text-text-tertiary" size={14} strokeWidth={1.7} />
      <form className="h-6 min-w-0 flex-1" key={`value:${address}:${value}`} onSubmit={submitValue}>
        <input
          aria-label="Formula bar"
          className="h-full w-full rounded border border-border-subtle bg-bg-app px-2 text-[10px] text-text-primary outline-none focus:border-orange-400"
          defaultValue={value}
          disabled={disabled}
          name="value"
          spellCheck={false}
        />
      </form>
    </div>
  )
}

function RibbonGroup({ children, label, wide = false }: { children: ReactNode; label: string; wide?: boolean }) {
  return (
    <div className={`relative grid h-full shrink-0 grid-flow-col grid-rows-2 items-center gap-1 border-r border-border-subtle px-2 pb-3 last:border-r-0 ${wide ? 'min-w-48' : 'min-w-24'}`}>
      {children}
      <span className="pointer-events-none absolute inset-x-1 bottom-0 truncate text-center text-[9px] text-text-tertiary">{label}</span>
    </div>
  )
}

function MergeMenu({ copy, disabled, onAction }: {
  copy: RibbonCopy
  disabled: boolean
  onAction: (action: ExcelRibbonAction, value?: string | number) => void
}) {
  return (
    <div className="row-span-2 flex h-14 w-28 flex-col justify-center gap-1">
      <button
        aria-label={copy.actions['merge-center']}
        className="flex h-7 items-center justify-center gap-1 rounded px-1.5 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        disabled={disabled}
        onClick={() => onAction('merge-center')}
        type="button"
      >
        <Merge size={15} strokeWidth={1.8} />
        <span>{copy.actions['merge-center']}</span>
      </button>
      <select
        aria-label={copy.mergeMenu}
        className="h-6 w-full rounded border border-border-subtle bg-bg-surface px-1 text-[9px] text-text-secondary outline-none hover:bg-bg-hover disabled:opacity-35"
        disabled={disabled}
        onChange={(event) => {
          const action = event.target.value as ExcelRibbonAction
          if (action) onAction(action)
          event.target.value = ''
        }}
        value=""
      >
        <option disabled value="">{copy.mergeMenu}</option>
        <option value="merge-cells">{copy.actions['merge-cells']}</option>
        <option value="merge-across">{copy.actions['merge-across']}</option>
        <option value="unmerge">{copy.actions.unmerge}</option>
      </select>
    </div>
  )
}

function FormulaSelect({ disabled, functions, label, onSelect }: {
  disabled: boolean
  functions: readonly string[]
  label: string
  onSelect: (formula: string) => void
}) {
  return (
    <select
      aria-label={label}
      className="h-7 w-28 rounded border border-border-subtle bg-bg-surface px-1 text-[10px] text-text-secondary outline-none hover:bg-bg-hover disabled:opacity-35"
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value) onSelect(event.target.value)
        event.target.value = ''
      }}
      value=""
    >
      <option disabled value="">{label}</option>
      {functions.map((formula) => <option key={formula} value={formula}>{formula}</option>)}
    </select>
  )
}

function Action({ disabled, icon: Icon, id, label, onAction }: {
  disabled: boolean; icon: LucideIcon; id: ExcelRibbonAction; label: string
  onAction: (action: ExcelRibbonAction, value?: string | number) => void
}) {
  return (
    <button aria-label={label} className="flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35" disabled={disabled} onClick={() => onAction(id)} type="button">
      <Icon size={15} strokeWidth={1.8} />
    </button>
  )
}

function LargeAction({ disabled, icon: Icon, id, label, onAction }: {
  disabled: boolean; icon: LucideIcon; id: ExcelRibbonAction; label: string
  onAction: (action: ExcelRibbonAction, value?: string | number) => void
}) {
  return (
    <button aria-label={label} className="row-span-2 flex h-14 w-16 flex-col items-center justify-center gap-1 rounded px-1 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35" disabled={disabled} onClick={() => onAction(id)} type="button">
      <Icon size={20} strokeWidth={1.7} /><span className="max-w-14 truncate">{label}</span>
    </button>
  )
}

function ColorAction({ color, disabled, icon: Icon, id, label, onAction }: {
  color: string; disabled: boolean; icon: LucideIcon; id: ExcelRibbonAction; label: string
  onAction: (action: ExcelRibbonAction, value?: string | number) => void
}) {
  return (
    <label aria-label={label} className={`relative flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-text-secondary hover:bg-bg-hover ${disabled ? 'pointer-events-none opacity-35' : 'cursor-pointer'}`}>
      <Icon size={15} strokeWidth={1.8} />
      <span className="absolute inset-x-1 bottom-0 h-0.5 rounded" style={{ backgroundColor: color }} />
      <input className="absolute inset-0 h-full w-full cursor-pointer opacity-0" defaultValue={color} disabled={disabled} onChange={(event) => onAction(id, event.target.value)} type="color" />
    </label>
  )
}

function RibbonSelect({ ariaLabel, children, disabled, narrow = false, onChange, value }: {
  ariaLabel: string; children: ReactNode; disabled: boolean; narrow?: boolean
  onChange: (value: string) => void; value: string
}) {
  return (
    <select aria-label={ariaLabel} className={`h-7 rounded border border-border-subtle bg-bg-surface px-1 text-[10px] text-text-secondary outline-none hover:bg-bg-hover disabled:opacity-35 ${narrow ? 'w-12' : 'w-24'}`} defaultValue={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  )
}
