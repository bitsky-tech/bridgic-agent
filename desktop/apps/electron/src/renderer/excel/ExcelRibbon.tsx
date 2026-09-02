import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownAZ,
  ChartArea,
  ChartBar,
  ChartColumn,
  ChartLine,
  ChartPie,
  ChartScatter,
  Check,
  ChevronDown,
  Bold,
  Clock3,
  DollarSign,
  Eraser,
  Eye,
  Filter,
  FunctionSquare,
  Grid3X3,
  Image,
  Italic,
  Link2,
  ListChecks,
  Merge,
  Moon,
  PaintBucket,
  Palette,
  Percent,
  Plus,
  Redo2,
  RotateCw,
  Rows3,
  Sigma,
  Snowflake,
  Strikethrough,
  Table2,
  TableProperties,
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
import type { ExcelChartType, ExcelRibbonActionValue } from './excelInsert'

export type ExcelRibbonTab = 'home' | 'insert' | 'data' | 'formulas' | 'view'

export type ExcelHighlightMode = 'none' | 'row' | 'column' | 'both'

export interface ExcelViewState {
  darkMode: boolean
  gridlines: boolean
  highlightMode: ExcelHighlightMode
  showZeros: boolean
  zoom: number
}

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
  | 'align-top'
  | 'align-middle'
  | 'align-bottom'
  | 'rotate-text'
  | 'wrap'
  | 'merge-center'
  | 'merge-cells'
  | 'merge-across'
  | 'unmerge'
  | 'number-format'
  | 'percent'
  | 'currency'
  | 'thousands-separator'
  | 'increase-decimal'
  | 'decrease-decimal'
  | 'clear-format'
  | 'insert-row-above'
  | 'insert-row-below'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'insert-cells-right'
  | 'insert-cells-down'
  | 'insert-sheet'
  | 'insert-image'
  | 'insert-hyperlink'
  | 'insert-chart'
  | 'insert-pivot-table'
  | 'toggle-filter'
  | 'clear-filter'
  | 'remove-filter'
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
  | 'highlight-row-column'
  | 'highlight-row'
  | 'highlight-column'
  | 'highlight-none'
  | 'set-row-height'
  | 'set-column-width'
  | 'auto-fit-rows'
  | 'auto-fit-columns'
  | 'toggle-gridlines'
  | 'toggle-zero-values'
  | 'toggle-dark-mode'
  | 'set-zoom'
  | 'freeze-selection'
  | 'freeze-first-row'
  | 'freeze-first-column'
  | 'unfreeze'

interface ExcelRibbonProps {
  activeTab: ExcelRibbonTab
  disabled: boolean
  locale: ExcelHostConfig['locale']
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
  onActiveTabChange: (tab: ExcelRibbonTab) => void
  onAddressSubmit: (address: string) => void
  onFormulaSubmit: (value: string) => void
  recentFunctions?: readonly string[]
  selectionAddress: string
  selectionValue: string
  viewState?: ExcelViewState
}

type RibbonGroupId =
  | 'history'
  | 'font'
  | 'alignment'
  | 'number'
  | 'styles'
  | 'pivot'
  | 'cells'
  | 'rowsColumns'
  | 'charts'
  | 'linksMedia'
  | 'workbook'
  | 'media'
  | 'organize'
  | 'rules'
  | 'formulaQuick'
  | 'formulaCategories'

interface RibbonCopy {
  tabs: Record<ExcelRibbonTab, string>
  groups: Record<RibbonGroupId, string>
  actions: Record<ExcelRibbonAction, string>
  formulaCategories: Record<ExcelFormulaCategory, string>
  chartTypes: Record<ExcelChartType, string>
  dimensionsMenu: string
  freezeMenu: string
  mergeMenu: string
  filterMenu: string
  sortMenu: string
  recentFunctions: string
  quick: {
    chart: string
    image: string
    insert: string
    pivot: string
  }
}

const zhCN: RibbonCopy = {
  tabs: { home: '开始', insert: '插入', data: '数据', formulas: '公式', view: '视图' },
  groups: {
    history: '编辑', font: '字体', alignment: '对齐', number: '数字', styles: '样式',
    pivot: '数据分析', cells: '单元格', rowsColumns: '行和列', charts: '图表', linksMedia: '链接与媒体',
    workbook: '工作簿', media: '媒体', organize: '排序和筛选',
    rules: '数据工具', formulaQuick: '函数库', formulaCategories: '函数分类',
  },
  actions: {
    undo: '撤销', redo: '重做', 'font-family': '字体', 'font-size': '字号', bold: '加粗', italic: '斜体',
    underline: '下划线', strikethrough: '删除线', 'font-color': '字体颜色', 'fill-color': '填充颜色',
    borders: '所有边框', 'align-left': '左对齐', 'align-center': '居中', 'align-right': '右对齐',
    'align-top': '顶端对齐', 'align-middle': '垂直居中', 'align-bottom': '底端对齐', 'rotate-text': '文字旋转 45°',
    wrap: '自动换行', 'merge-center': '合并后居中', 'merge-cells': '合并单元格',
    'merge-across': '跨列合并', unmerge: '取消合并', 'number-format': '数字格式', percent: '百分比',
    currency: '货币', 'thousands-separator': '千位分隔样式', 'increase-decimal': '增加小数位',
    'decrease-decimal': '减少小数位', 'clear-format': '清除格式', 'insert-row-above': '在上方插入行',
    'insert-row-below': '在下方插入行', 'insert-column-left': '在左侧插入列',
    'insert-column-right': '在右侧插入列', 'insert-cells-right': '插入单元格，现有单元格右移',
    'insert-cells-down': '插入单元格，现有单元格下移', 'insert-sheet': '新建工作表',
    'insert-image': '插入图片', 'insert-hyperlink': '网络链接', 'insert-chart': '统计图表',
    'insert-pivot-table': '数据透视表',
    'toggle-filter': '启用筛选', 'clear-filter': '清除筛选条件', 'remove-filter': '关闭筛选', 'sort-ascending': '升序',
    'sort-descending': '降序', 'data-validation': '数据验证', 'conditional-formatting': '条件格式',
    'formula-sum': '自动求和', 'formula-average': '平均值', 'formula-count': '计数',
    'formula-max': '最大值', 'formula-min': '最小值', 'formula-insert': '插入函数', 'formula-more': '全部函数',
    'highlight-row-column': '高亮所在行列', 'highlight-row': '仅高亮所在行',
    'highlight-column': '仅高亮所在列', 'highlight-none': '关闭行列高亮',
    'set-row-height': '设置选中行高', 'set-column-width': '设置选中列宽',
    'auto-fit-rows': '自动调整选中行高', 'auto-fit-columns': '自动调整选中列宽',
    'toggle-gridlines': '显示网格线', 'toggle-zero-values': '显示零值', 'toggle-dark-mode': '深色显示',
    'set-zoom': '显示比例', 'freeze-selection': '冻结至当前单元格',
    'freeze-first-row': '冻结首行', 'freeze-first-column': '冻结首列', unfreeze: '取消冻结',
  },
  formulaCategories: {
    common: '常用', financial: '财务', logical: '逻辑', text: '文本', date: '日期与时间',
    lookup: '查找与引用', math: '数学', statistical: '统计',
  },
  chartTypes: {
    column: '柱状图', bar: '条形图', line: '折线图', area: '面积图', pie: '饼图',
    doughnut: '环形图', scatter: '散点图',
  },
  dimensionsMenu: '行高列宽',
  freezeMenu: '冻结窗格',
  mergeMenu: '更多合并选项',
  filterMenu: '筛选',
  sortMenu: '排序',
  recentFunctions: '最近使用',
  quick: { chart: '图表', image: '图片', insert: '插入', pivot: '透视表' },
}

const enUS: RibbonCopy = {
  tabs: { home: 'Home', insert: 'Insert', data: 'Data', formulas: 'Formulas', view: 'View' },
  groups: {
    history: 'Edit', font: 'Font', alignment: 'Alignment', number: 'Number', styles: 'Styles',
    pivot: 'Data analysis', cells: 'Cells', rowsColumns: 'Rows & columns', charts: 'Charts',
    linksMedia: 'Links & media', workbook: 'Workbook', media: 'Media', organize: 'Sort & filter',
    rules: 'Data tools', formulaQuick: 'Function library', formulaCategories: 'Categories',
  },
  actions: {
    undo: 'Undo', redo: 'Redo', 'font-family': 'Font', 'font-size': 'Font size', bold: 'Bold', italic: 'Italic',
    underline: 'Underline', strikethrough: 'Strikethrough', 'font-color': 'Font color', 'fill-color': 'Fill color',
    borders: 'All borders', 'align-left': 'Align left', 'align-center': 'Center', 'align-right': 'Align right',
    'align-top': 'Align top', 'align-middle': 'Align middle', 'align-bottom': 'Align bottom',
    'rotate-text': 'Rotate text 45°', wrap: 'Wrap text', 'merge-center': 'Merge & center', 'merge-cells': 'Merge cells',
    'merge-across': 'Merge across', unmerge: 'Unmerge cells', 'number-format': 'Number format', percent: 'Percent',
    currency: 'Currency', 'thousands-separator': 'Thousands separator', 'increase-decimal': 'Increase decimal',
    'decrease-decimal': 'Decrease decimal', 'clear-format': 'Clear formatting', 'insert-row-above': 'Insert row above',
    'insert-row-below': 'Insert row below', 'insert-column-left': 'Insert column left',
    'insert-column-right': 'Insert column right', 'insert-cells-right': 'Insert cells and shift right',
    'insert-cells-down': 'Insert cells and shift down', 'insert-sheet': 'New sheet', 'insert-image': 'Insert image',
    'insert-hyperlink': 'Hyperlink', 'insert-chart': 'Statistical chart', 'insert-pivot-table': 'Pivot table',
    'toggle-filter': 'Enable filter', 'clear-filter': 'Clear filter criteria', 'remove-filter': 'Turn off filter',
    'sort-ascending': 'Sort ascending',
    'sort-descending': 'Sort descending', 'data-validation': 'Data validation',
    'conditional-formatting': 'Conditional formatting', 'formula-sum': 'AutoSum', 'formula-average': 'Average',
    'formula-count': 'Count', 'formula-max': 'Maximum', 'formula-min': 'Minimum',
    'formula-insert': 'Insert function', 'formula-more': 'All functions',
    'highlight-row-column': 'Highlight current row and column', 'highlight-row': 'Highlight current row only',
    'highlight-column': 'Highlight current column only', 'highlight-none': 'Turn off row and column highlight',
    'set-row-height': 'Set selected row height', 'set-column-width': 'Set selected column width',
    'auto-fit-rows': 'Auto-fit selected row height', 'auto-fit-columns': 'Auto-fit selected column width',
    'toggle-gridlines': 'Show gridlines', 'toggle-zero-values': 'Show zero values',
    'toggle-dark-mode': 'Dark display', 'set-zoom': 'Zoom', 'freeze-selection': 'Freeze at current cell',
    'freeze-first-row': 'Freeze first row',
    'freeze-first-column': 'Freeze first column', unfreeze: 'Unfreeze',
  },
  formulaCategories: {
    common: 'Common', financial: 'Financial', logical: 'Logical', text: 'Text', date: 'Date & time',
    lookup: 'Lookup & reference', math: 'Math', statistical: 'Statistical',
  },
  chartTypes: {
    column: 'Column', bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie',
    doughnut: 'Doughnut', scatter: 'Scatter',
  },
  dimensionsMenu: 'Row height & column width',
  freezeMenu: 'Freeze panes',
  mergeMenu: 'More merge options',
  filterMenu: 'Filter',
  sortMenu: 'Sort',
  recentFunctions: 'Recently used',
  quick: { chart: 'Chart', image: 'Image', insert: 'Insert', pivot: 'Pivot' },
}

const tabs: ExcelRibbonTab[] = ['home', 'insert', 'data', 'formulas', 'view']
const HIGHLIGHT_ACTIONS: Record<ExcelHighlightMode, ExcelRibbonAction> = {
  both: 'highlight-row-column',
  column: 'highlight-column',
  none: 'highlight-none',
  row: 'highlight-row',
}

export function ExcelRibbon({
  activeTab,
  disabled,
  locale,
  onAction,
  onActiveTabChange,
  onAddressSubmit,
  onFormulaSubmit,
  recentFunctions = [],
  selectionAddress,
  selectionValue,
  viewState = { darkMode: false, gridlines: true, highlightMode: 'none', showZeros: true, zoom: 1 },
}: ExcelRibbonProps) {
  const copy = locale === 'zh-CN' ? zhCN : enUS
  const action = (id: ExcelRibbonAction, value?: ExcelRibbonActionValue) => onAction(id, value)
  const highlightAction = HIGHLIGHT_ACTIONS[viewState.highlightMode]

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
                <Action icon={AlignVerticalJustifyStart} id="align-top" label={copy.actions['align-top']} disabled={disabled} onAction={action} />
                <Action icon={AlignVerticalJustifyCenter} id="align-middle" label={copy.actions['align-middle']} disabled={disabled} onAction={action} />
                <Action icon={AlignVerticalJustifyEnd} id="align-bottom" label={copy.actions['align-bottom']} disabled={disabled} onAction={action} />
                <Action icon={AlignLeft} id="align-left" label={copy.actions['align-left']} disabled={disabled} onAction={action} />
                <Action icon={AlignCenter} id="align-center" label={copy.actions['align-center']} disabled={disabled} onAction={action} />
                <Action icon={AlignRight} id="align-right" label={copy.actions['align-right']} disabled={disabled} onAction={action} />
                <Action icon={RotateCw} id="rotate-text" label={copy.actions['rotate-text']} disabled={disabled} onAction={action} />
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
                <Action icon={Sigma} id="thousands-separator" label={copy.actions['thousands-separator']} disabled={disabled} onAction={action} />
                <Action icon={Plus} id="increase-decimal" label={copy.actions['increase-decimal']} disabled={disabled} onAction={action} />
                <Action icon={Eraser} id="decrease-decimal" label={copy.actions['decrease-decimal']} disabled={disabled} onAction={action} />
                <Action icon={Grid3X3} id="borders" label={copy.actions.borders} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <QuickRibbonGroup>
                <CompactAction icon={Palette} id="conditional-formatting" label={copy.actions['conditional-formatting']} disabled={disabled} onAction={action} variant="tall" />
                <div className="grid h-14 grid-flow-col grid-rows-2 gap-x-0.5" data-quick-layout="data">
                  <CompactMenu
                    disabled={disabled}
                    icon={Filter}
                    items={[
                      { id: 'toggle-filter', label: copy.actions['toggle-filter'] },
                      { id: 'clear-filter', label: copy.actions['clear-filter'] },
                      { id: 'remove-filter', label: copy.actions['remove-filter'] },
                    ]}
                    label={copy.filterMenu}
                    onAction={action}
                    variant="inline"
                  />
                  <CompactMenu
                    disabled={disabled}
                    icon={ArrowDownAZ}
                    items={[
                      { id: 'sort-ascending', label: copy.actions['sort-ascending'] },
                      { id: 'sort-descending', label: copy.actions['sort-descending'] },
                    ]}
                    label={copy.sortMenu}
                    onAction={action}
                    variant="inline"
                  />
                  <CompactAction displayLabel={copy.actions['data-validation']} icon={ListChecks} id="data-validation" label={copy.actions['data-validation']} disabled={disabled} onAction={action} variant="inline" />
                </div>
              </QuickRibbonGroup>
              <QuickRibbonGroup>
                <CompactMenu
                  disabled={disabled}
                  icon={Plus}
                  items={[
                    { id: 'insert-cells-right', label: copy.actions['insert-cells-right'] },
                    { id: 'insert-cells-down', label: copy.actions['insert-cells-down'] },
                    { id: 'insert-row-above', label: copy.actions['insert-row-above'] },
                    { id: 'insert-column-left', label: copy.actions['insert-column-left'] },
                  ]}
                  label={copy.quick.insert}
                  onAction={action}
                  variant="tall"
                />
                <div className="grid h-14 grid-flow-col grid-rows-2 gap-x-0.5" data-quick-layout="insert">
                  <CompactAction displayLabel={copy.quick.image} icon={Image} id="insert-image" label={copy.actions['insert-image']} disabled={disabled} onAction={action} variant="inline" />
                  <CompactAction displayLabel={copy.quick.pivot} icon={TableProperties} id="insert-pivot-table" label={copy.actions['insert-pivot-table']} disabled={disabled} onAction={action} variant="inline" />
                  <CompactMenu
                    disabled={disabled}
                    icon={ChartColumn}
                    items={(Object.keys(copy.chartTypes) as ExcelChartType[]).map((type) => ({
                      id: 'insert-chart',
                      label: copy.chartTypes[type],
                      value: type,
                    }))}
                    label={copy.quick.chart}
                    onAction={action}
                    variant="inline"
                  />
                </div>
              </QuickRibbonGroup>
            </>
          ) : null}
          {activeTab === 'insert' ? (
            <>
              <RibbonGroup label={copy.groups.pivot}>
                <LargeAction icon={TableProperties} id="insert-pivot-table" label={copy.actions['insert-pivot-table']} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.cells}>
                <LargeMenu
                  disabled={disabled}
                  icon={Table2}
                  items={[
                    { id: 'insert-cells-right', label: copy.actions['insert-cells-right'] },
                    { id: 'insert-cells-down', label: copy.actions['insert-cells-down'] },
                  ]}
                  label={copy.groups.cells}
                  onAction={action}
                />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.rowsColumns}>
                <LargeMenu
                  disabled={disabled}
                  icon={Rows3}
                  items={[
                    { id: 'insert-row-above', label: copy.actions['insert-row-above'] },
                    { id: 'insert-row-below', label: copy.actions['insert-row-below'] },
                    { id: 'insert-column-left', label: copy.actions['insert-column-left'] },
                    { id: 'insert-column-right', label: copy.actions['insert-column-right'] },
                  ]}
                  label={copy.groups.rowsColumns}
                  onAction={action}
                />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.charts}>
                <ChartMenu copy={copy} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.linksMedia} wide>
                <LargeAction icon={Link2} id="insert-hyperlink" label={copy.actions['insert-hyperlink']} disabled={disabled} onAction={action} />
                <LargeAction icon={Image} id="insert-image" label={copy.actions['insert-image']} disabled={disabled} onAction={action} />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.workbook}>
                <LargeAction icon={Plus} id="insert-sheet" label={copy.actions['insert-sheet']} disabled={disabled} onAction={action} />
              </RibbonGroup>
            </>
          ) : null}
          {activeTab === 'data' ? (
            <>
              <RibbonGroup label={copy.groups.organize} wide>
                <FilterMenu copy={copy} disabled={disabled} onAction={action} />
                <SortMenu copy={copy} disabled={disabled} onAction={action} />
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
                <LargeAction icon={FunctionSquare} id="formula-more" label={copy.actions['formula-insert']} disabled={disabled} onAction={action} />
                <LargeMenu
                  disabled={disabled}
                  icon={Sigma}
                  items={[
                    { id: 'formula-sum', label: copy.actions['formula-sum'] },
                    { id: 'formula-average', label: copy.actions['formula-average'] },
                    { id: 'formula-count', label: copy.actions['formula-count'] },
                    { id: 'formula-max', label: copy.actions['formula-max'] },
                    { id: 'formula-min', label: copy.actions['formula-min'] },
                  ]}
                  label={copy.actions['formula-sum']}
                  onAction={action}
                />
                <LargeMenu
                  disabled={disabled || recentFunctions.length === 0}
                  icon={Clock3}
                  items={recentFunctions.map((formula) => ({
                    id: 'formula-insert' as const,
                    label: formula,
                    value: formula,
                  }))}
                  label={copy.recentFunctions}
                  onAction={action}
                />
              </RibbonGroup>
              <RibbonGroup label={copy.groups.formulaCategories} wide>
                {(Object.keys(EXCEL_FORMULA_CATEGORIES) as ExcelFormulaCategory[]).map((category) => (
                  <CompactMenu
                    disabled={disabled}
                    icon={FunctionSquare}
                    items={EXCEL_FORMULA_CATEGORIES[category].map((formula) => ({
                      id: 'formula-insert' as const,
                      label: formula,
                      value: formula,
                    }))}
                    key={category}
                    label={copy.formulaCategories[category]}
                    onAction={action}
                    variant="inline"
                  />
                ))}
              </RibbonGroup>
            </>
          ) : null}
          {activeTab === 'view' ? (
            <QuickRibbonGroup>
              <CompactMenu
                active={viewState.highlightMode !== 'none'}
                activeId={highlightAction}
                disabled={disabled}
                icon={Eye}
                items={[
                  { id: 'highlight-row-column', label: copy.actions['highlight-row-column'] },
                  { id: 'highlight-row', label: copy.actions['highlight-row'] },
                  { id: 'highlight-column', label: copy.actions['highlight-column'] },
                  { id: 'highlight-none', label: copy.actions['highlight-none'] },
                ]}
                label={copy.actions['highlight-row-column']}
                onAction={action}
                variant="tall"
              />
              <CompactMenu
                disabled={disabled}
                icon={Rows3}
                items={[
                  { id: 'auto-fit-rows', label: copy.actions['auto-fit-rows'] },
                  { id: 'set-row-height', label: `${copy.actions['set-row-height']}: 20 px`, value: 20 },
                  { id: 'set-row-height', label: `${copy.actions['set-row-height']}: 30 px`, value: 30 },
                  { id: 'set-row-height', label: `${copy.actions['set-row-height']}: 40 px`, value: 40 },
                  { id: 'auto-fit-columns', label: copy.actions['auto-fit-columns'] },
                  { id: 'set-column-width', label: `${copy.actions['set-column-width']}: 72 px`, value: 72 },
                  { id: 'set-column-width', label: `${copy.actions['set-column-width']}: 96 px`, value: 96 },
                  { id: 'set-column-width', label: `${copy.actions['set-column-width']}: 144 px`, value: 144 },
                ]}
                label={copy.dimensionsMenu}
                onAction={action}
                variant="tall"
              />
              <CompactMenu
                disabled={disabled}
                icon={Snowflake}
                items={[
                  { id: 'freeze-selection', label: copy.actions['freeze-selection'] },
                  { id: 'freeze-first-row', label: copy.actions['freeze-first-row'] },
                  { id: 'freeze-first-column', label: copy.actions['freeze-first-column'] },
                  { id: 'unfreeze', label: copy.actions.unfreeze },
                ]}
                label={copy.freezeMenu}
                onAction={action}
                variant="tall"
              />
              <CompactAction active={viewState.darkMode} icon={Moon} id="toggle-dark-mode" label={copy.actions['toggle-dark-mode']} disabled={disabled} onAction={action} variant="tall" />
              <CompactMenu
                disabled={disabled}
                icon={Percent}
                items={[50, 75, 100, 125, 150, 200].map((percentage) => ({
                  id: 'set-zoom' as const,
                  label: `${percentage}%`,
                  value: percentage / 100,
                }))}
                label={`${copy.actions['set-zoom']} ${Math.round(viewState.zoom * 100)}%`}
                onAction={action}
                variant="tall"
              />
              <div className="grid h-14 grid-flow-col grid-rows-2 gap-x-0.5" data-quick-layout="view-options">
                <CompactToggle
                  checked={viewState.gridlines}
                  disabled={disabled}
                  id="toggle-gridlines"
                  label={copy.actions['toggle-gridlines']}
                  onAction={action}
                />
                <CompactToggle
                  checked={viewState.showZeros}
                  disabled={disabled}
                  id="toggle-zero-values"
                  label={copy.actions['toggle-zero-values']}
                  onAction={action}
                />
              </div>
            </QuickRibbonGroup>
          ) : null}
        </div>
      </div>
      <FormulaBar
        address={selectionAddress}
        disabled={disabled}
        insertFunctionLabel={copy.actions['formula-insert']}
        onAddressSubmit={onAddressSubmit}
        onFormulaSubmit={onFormulaSubmit}
        onInsertFunction={() => action('formula-more')}
        value={selectionValue}
      />
    </section>
  )
}

function FormulaBar({ address, disabled, insertFunctionLabel, onAddressSubmit, onFormulaSubmit, onInsertFunction, value }: {
  address: string
  disabled: boolean
  insertFunctionLabel: string
  onAddressSubmit: (address: string) => void
  onFormulaSubmit: (value: string) => void
  onInsertFunction: () => void
  value: string
}) {
  const tooltip = useRibbonTooltip<HTMLButtonElement>(insertFunctionLabel)
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
      <button {...tooltip.anchorProps} aria-label={insertFunctionLabel} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-emerald-600 disabled:pointer-events-none disabled:opacity-35" disabled={disabled} onClick={onInsertFunction} type="button">
        <FunctionSquare size={14} strokeWidth={1.7} />
      </button>
      {tooltip.element}
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

function QuickRibbonGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full shrink-0 items-center gap-0.5 border-r border-border-subtle px-1.5 last:border-r-0">
      {children}
    </div>
  )
}

function CompactAction({ active = false, disabled, displayLabel, icon: Icon, id, label, onAction, variant }: {
  active?: boolean
  disabled: boolean
  displayLabel?: string
  icon: LucideIcon
  id: ExcelRibbonAction
  label: string
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
  variant: 'inline' | 'tall'
}) {
  const tooltip = useRibbonTooltip<HTMLButtonElement>(label)
  const layout = variant === 'inline'
    ? 'flex h-7 w-[76px] items-center gap-1 rounded px-1 text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35'
    : 'flex h-14 w-12 flex-col items-center justify-center gap-1 rounded px-0.5 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35'
  const className = `${layout} ${active ? 'bg-blue-500/10 text-blue-500' : ''}`
  return (
    <>
      <button
        {...tooltip.anchorProps}
        aria-label={label}
        aria-pressed={active}
        className={className}
        data-compact-ribbon-action="true"
        data-compact-variant={variant}
        disabled={disabled}
        onClick={() => onAction(id)}
        type="button"
      >
        <Icon className="shrink-0" size={18} strokeWidth={1.7} />
        <span className={variant === 'inline' ? 'min-w-0 truncate' : 'max-w-11 truncate'}>{displayLabel ?? label}</span>
      </button>
      {tooltip.element}
    </>
  )
}

function CompactToggle({ checked, disabled, id, label, onAction }: {
  checked: boolean
  disabled: boolean
  id: ExcelRibbonAction
  label: string
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  const tooltip = useRibbonTooltip<HTMLButtonElement>(label)
  return (
    <>
      <button
        {...tooltip.anchorProps}
        aria-checked={checked}
        aria-label={label}
        className="flex h-7 w-[92px] items-center gap-1.5 rounded px-1 text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        disabled={disabled}
        onClick={() => onAction(id)}
        role="checkbox"
        type="button"
      >
        <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none ${checked ? 'border-blue-500 bg-blue-500 text-white' : 'border-border-strong bg-bg-surface'}`}>
          {checked ? '✓' : ''}
        </span>
        <span className="truncate">{label}</span>
      </button>
      {tooltip.element}
    </>
  )
}

function CompactMenu({ active = false, activeId, disabled, icon: Icon, items, label, onAction, variant }: {
  active?: boolean
  activeId?: ExcelRibbonAction
  disabled: boolean
  icon: LucideIcon
  items: Array<{ id: ExcelRibbonAction; label: string; value?: ExcelRibbonActionValue }>
  label: string
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
  variant: 'inline' | 'tall'
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menu = useRibbonPopup(anchorRef, 256, Math.max(76, items.length * 32 + 12))
  const tooltip = useRibbonTooltip<HTMLButtonElement>(label, anchorRef)
  const layout = variant === 'inline'
    ? 'flex h-7 w-full items-center gap-1 rounded px-1 text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35'
    : 'flex h-14 w-full flex-col items-center justify-center gap-1 rounded px-0.5 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35'
  const className = `${layout} ${active ? 'bg-blue-500/10 text-blue-500' : ''}`
  return (
    <div className={`relative ${variant === 'inline' ? 'h-7 w-[76px]' : 'h-14 w-12'}`}>
      <button
        {...tooltip.anchorProps}
        aria-expanded={menu.open}
        aria-haspopup="menu"
        aria-label={label}
        aria-pressed={activeId === undefined ? undefined : active}
        className={className}
        data-compact-ribbon-action="true"
        data-compact-variant={variant}
        disabled={disabled}
        onClick={() => {
          tooltip.hide()
          menu.toggle()
        }}
        ref={anchorRef}
        type="button"
      >
        <Icon className="shrink-0" size={18} strokeWidth={1.7} />
        <span className={`flex min-w-0 items-center gap-px truncate ${variant === 'inline' ? 'flex-1' : 'max-w-11'}`}>{label}<ChevronDown className="shrink-0" size={8} /></span>
      </button>
      {tooltip.element}
      {menu.open ? createPortal(
        <div className="fixed z-[20000] min-w-56 overflow-hidden rounded-lg border border-border-subtle bg-bg-surface p-1.5 shadow-xl" data-ribbon-popup="true" role="menu" style={menu.style}>
          {items.map((item) => (
            <button
              className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              key={`${item.id}:${String(item.value ?? '')}`}
              onClick={() => {
                onAction(item.id, item.value)
                menu.close()
              }}
              aria-checked={activeId === undefined ? undefined : item.id === activeId}
              role={activeId === undefined ? 'menuitem' : 'menuitemradio'}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {activeId === item.id ? <Check className="ml-2 shrink-0 text-blue-500" size={13} /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function MergeMenu({ copy, disabled, onAction }: {
  copy: RibbonCopy
  disabled: boolean
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  const tooltip = useRibbonTooltip<HTMLButtonElement>(copy.actions['merge-center'])
  return (
    <div className="row-span-2 flex h-14 w-28 flex-col justify-center gap-1">
      <button
        {...tooltip.anchorProps}
        aria-label={copy.actions['merge-center']}
        className="flex h-7 items-center justify-center gap-1 rounded px-1.5 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        disabled={disabled}
        onClick={() => onAction('merge-center')}
        type="button"
      >
        <Merge size={15} strokeWidth={1.8} />
        <span>{copy.actions['merge-center']}</span>
      </button>
      {tooltip.element}
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

function FilterMenu({ copy, disabled, onAction }: {
  copy: RibbonCopy
  disabled: boolean
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  return (
    <LargeMenu
      disabled={disabled}
      icon={Filter}
      items={[
        { id: 'toggle-filter', label: copy.actions['toggle-filter'] },
        { id: 'clear-filter', label: copy.actions['clear-filter'] },
        { id: 'remove-filter', label: copy.actions['remove-filter'] },
      ]}
      label={copy.filterMenu}
      onAction={onAction}
    />
  )
}

function SortMenu({ copy, disabled, onAction }: {
  copy: RibbonCopy
  disabled: boolean
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  return (
    <LargeMenu
      disabled={disabled}
      icon={ArrowDownAZ}
      items={[
        { id: 'sort-ascending', label: copy.actions['sort-ascending'] },
        { id: 'sort-descending', label: copy.actions['sort-descending'] },
      ]}
      label={copy.sortMenu}
      onAction={onAction}
    />
  )
}

function Action({ disabled, icon: Icon, id, label, onAction }: {
  disabled: boolean; icon: LucideIcon; id: ExcelRibbonAction; label: string
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  const tooltip = useRibbonTooltip<HTMLButtonElement>(label)
  return (
    <>
      <button {...tooltip.anchorProps} aria-label={label} className="flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35" disabled={disabled} onClick={() => onAction(id)} type="button">
        <Icon size={15} strokeWidth={1.8} />
      </button>
      {tooltip.element}
    </>
  )
}

function LargeAction({ disabled, icon: Icon, id, label, onAction }: {
  disabled: boolean; icon: LucideIcon; id: ExcelRibbonAction; label: string
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  const tooltip = useRibbonTooltip<HTMLButtonElement>(label)
  return (
    <>
      <button {...tooltip.anchorProps} aria-label={label} className="row-span-2 flex h-14 w-16 flex-col items-center justify-center gap-1 rounded px-1 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35" disabled={disabled} onClick={() => onAction(id)} type="button">
        <Icon size={20} strokeWidth={1.7} /><span className="max-w-14 truncate">{label}</span>
      </button>
      {tooltip.element}
    </>
  )
}

function LargeMenu({ disabled, icon: Icon, items, label, onAction }: {
  disabled: boolean
  icon: LucideIcon
  items: Array<{ id: ExcelRibbonAction; label: string; value?: ExcelRibbonActionValue }>
  label: string
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menu = useRibbonPopup(anchorRef, 256, Math.max(76, items.length * 32 + 12))
  const tooltip = useRibbonTooltip<HTMLButtonElement>(label, anchorRef)
  return (
    <div className="relative row-span-2 h-14 w-20">
      <button
        {...tooltip.anchorProps}
        aria-expanded={menu.open}
        aria-haspopup="menu"
        aria-label={label}
        className="flex h-14 w-full flex-col items-center justify-center gap-1 rounded px-1 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        disabled={disabled}
        onClick={() => {
          tooltip.hide()
          menu.toggle()
        }}
        ref={anchorRef}
        type="button"
      >
        <Icon size={20} strokeWidth={1.7} />
        <span className="flex max-w-[74px] items-center gap-0.5 truncate">{label}<ChevronDown size={10} /></span>
      </button>
      {tooltip.element}
      {menu.open ? createPortal(
        <div className="fixed z-[20000] min-w-56 overflow-hidden rounded-lg border border-border-subtle bg-bg-surface p-1.5 shadow-xl" data-ribbon-popup="true" role="menu" style={menu.style}>
          {items.map((item) => (
            <button
              className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              key={`${item.id}:${String(item.value ?? '')}`}
              onClick={() => {
                onAction(item.id, item.value)
                menu.close()
              }}
              role="menuitem"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function ChartMenu({ copy, disabled, onAction }: {
  copy: RibbonCopy
  disabled: boolean
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menu = useRibbonPopup(anchorRef, 264, 220)
  const tooltip = useRibbonTooltip<HTMLButtonElement>(copy.actions['insert-chart'], anchorRef)
  const chartTypes: Array<{ type: ExcelChartType; icon: LucideIcon }> = [
    { type: 'column', icon: ChartColumn },
    { type: 'bar', icon: ChartBar },
    { type: 'line', icon: ChartLine },
    { type: 'area', icon: ChartArea },
    { type: 'pie', icon: ChartPie },
    { type: 'doughnut', icon: ChartPie },
    { type: 'scatter', icon: ChartScatter },
  ]
  return (
    <div className="relative row-span-2 h-14 w-20">
      <button
        {...tooltip.anchorProps}
        aria-expanded={menu.open}
        aria-haspopup="menu"
        aria-label={copy.actions['insert-chart']}
        className="flex h-14 w-full flex-col items-center justify-center gap-1 rounded px-1 text-[9px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        disabled={disabled}
        onClick={() => {
          tooltip.hide()
          menu.toggle()
        }}
        ref={anchorRef}
        type="button"
      >
        <ChartColumn size={20} strokeWidth={1.7} />
        <span className="flex items-center gap-0.5">{copy.actions['insert-chart']}<ChevronDown size={10} /></span>
      </button>
      {tooltip.element}
      {menu.open ? createPortal(
        <div className="fixed z-[20000] w-64 rounded-lg border border-border-subtle bg-bg-surface p-2 shadow-xl" data-ribbon-popup="true" role="menu" style={menu.style}>
          <p className="px-1 pb-2 text-[10px] font-medium text-text-tertiary">{copy.groups.charts}</p>
          <div className="grid grid-cols-2 gap-1">
            {chartTypes.map(({ type, icon: Icon }) => (
              <button
                aria-label={copy.chartTypes[type]}
                className="flex h-10 items-center gap-2 rounded-md px-2 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                key={type}
                onClick={() => {
                  onAction('insert-chart', type)
                  menu.close()
                }}
                role="menuitem"
                type="button"
              >
                <span className="flex h-7 w-8 items-center justify-center rounded bg-bg-app text-emerald-600"><Icon size={17} strokeWidth={1.7} /></span>
                {copy.chartTypes[type]}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function useRibbonPopup(anchorRef: RefObject<HTMLButtonElement | null>, width: number, height: number) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState({ left: 8, top: 8 })
  const close = useCallback(() => setOpen(false), [])
  const toggle = useCallback(() => {
    if (open) {
      close()
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      setStyle({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
      })
    }
    setOpen(true)
  }, [anchorRef, close, height, open, width])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target)) return
      if ((target as Element).closest?.('[data-ribbon-popup="true"]')) return
      close()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const reposition = () => close()
    document.addEventListener('mousedown', dismiss, true)
    window.addEventListener('keydown', keydown)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [anchorRef, close, open])
  return { close, open, style, toggle }
}

function ColorAction({ color, disabled, icon: Icon, id, label, onAction }: {
  color: string; disabled: boolean; icon: LucideIcon; id: ExcelRibbonAction; label: string
  onAction: (action: ExcelRibbonAction, value?: ExcelRibbonActionValue) => void
}) {
  const tooltip = useRibbonTooltip<HTMLLabelElement>(label)
  return (
    <>
      <label {...tooltip.anchorProps} aria-label={label} className={`relative flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-text-secondary hover:bg-bg-hover ${disabled ? 'pointer-events-none opacity-35' : 'cursor-pointer'}`}>
        <Icon size={15} strokeWidth={1.8} />
        <span className="absolute inset-x-1 bottom-0 h-0.5 rounded" style={{ backgroundColor: color }} />
        <input className="absolute inset-0 h-full w-full cursor-pointer opacity-0" defaultValue={color} disabled={disabled} onChange={(event) => onAction(id, event.target.value)} type="color" />
      </label>
      {tooltip.element}
    </>
  )
}

function useRibbonTooltip<T extends HTMLElement>(label: string, externalRef?: RefObject<T | null>) {
  const internalRef = useRef<T>(null)
  const anchorRef = externalRef ?? internalRef
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const show = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      left: Math.max(72, Math.min(rect.left + rect.width / 2, window.innerWidth - 72)),
      top: Math.min(rect.bottom + 6, window.innerHeight - 34),
    })
  }, [anchorRef])
  const hide = useCallback(() => setPosition(null), [])
  const element = position ? createPortal(
    <div
      className="pointer-events-none fixed z-[30000] max-w-64 -translate-x-1/2 rounded-md border border-border-subtle bg-bg-surface px-2 py-1 text-[10px] leading-4 text-text-primary shadow-lg"
      data-ribbon-tooltip="true"
      role="tooltip"
      style={position}
    >
      {label}
    </div>,
    document.body,
  ) : null
  return {
    anchorProps: {
      onBlur: hide,
      onFocus: show,
      onMouseEnter: show,
      onMouseLeave: hide,
      ref: anchorRef as RefObject<T>,
    },
    element,
    hide,
  }
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
