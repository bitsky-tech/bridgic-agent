import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@/components/amphi/Modal'
import { cn } from '@/lib/cn'

export type PresentationInsertChartType = 'column' | 'bar' | 'line' | 'pie' | 'doughnut'
export type PresentationInsertLinkTargetType = 'url' | 'slide'

export interface PresentationInsertSlideOption {
  id: string
  name: string
}

export interface PresentationInsertTableValue {
  kind: 'table'
  rows: number
  columns: number
  cells: string[][]
}

export interface PresentationInsertChartSeries {
  name: string
  values: number[]
}

export interface PresentationInsertChartValue {
  kind: 'chart'
  chartType: PresentationInsertChartType
  title: string
  categories: string[]
  series: PresentationInsertChartSeries[]
}

export interface PresentationInsertLinkValue {
  kind: 'link'
  targetType: PresentationInsertLinkTargetType
  url: string
  slideId: string
  label: string
  tooltip: string
}

export interface PresentationInsertFooterValue {
  kind: 'footer'
  text: string
  showDate: boolean
  showSlideNumber: boolean
  applyAll: boolean
}

export type PresentationInsertDialogValue =
  | PresentationInsertTableValue
  | PresentationInsertChartValue
  | PresentationInsertLinkValue
  | PresentationInsertFooterValue

export type PresentationInsertDialogKind = PresentationInsertDialogValue['kind']

export interface PresentationInsertDialogsProps {
  open: PresentationInsertDialogKind | null
  initialValue?: PresentationInsertDialogValue | null
  linkLabelEditable?: boolean
  slides: readonly PresentationInsertSlideOption[]
  onClose: () => void
  onSubmit: (value: PresentationInsertDialogValue) => void
}

const fieldClassName = 'h-9 w-full rounded-md border border-border-default bg-bg-surface px-2.5 text-sm text-text-primary outline-none focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/15'
const labelClassName = 'flex flex-col gap-1.5 text-xs font-medium text-text-secondary'

function clampTableSize(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(10, Math.max(1, Math.round(value)))
}

export function resizePresentationTableCells(cells: readonly (readonly string[])[], rows: number, columns: number): string[][] {
  const nextRows = clampTableSize(rows)
  const nextColumns = clampTableSize(columns)
  return Array.from({ length: nextRows }, (_, rowIndex) => (
    Array.from({ length: nextColumns }, (_, columnIndex) => cells[rowIndex]?.[columnIndex] ?? '')
  ))
}

function splitCommaSeparated(value: string): string[] {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
}

export function parsePresentationChartSeries(text: string, categoryCount: number): PresentationInsertChartSeries[] | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || categoryCount === 0) return null
  const parsed: PresentationInsertChartSeries[] = []
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator <= 0) return null
    const name = line.slice(0, separator).trim()
    const rawValues = splitCommaSeparated(line.slice(separator + 1))
    const values = rawValues.map(Number)
    if (!name || values.length !== categoryCount || values.some((value) => !Number.isFinite(value))) return null
    parsed.push({ name, values })
  }
  return parsed
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function DialogActions({ disabled = false, onClose, submitLabel }: { disabled?: boolean; onClose: () => void; submitLabel: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
      <button type="button" onClick={onClose} className="h-9 rounded-md border border-border-default px-4 text-sm font-medium text-text-secondary hover:bg-bg-hover">
        {t('session.presentation.insertDialog.cancel')}
      </button>
      <button type="submit" disabled={disabled} className="h-9 rounded-md bg-brand-purple px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
        {submitLabel}
      </button>
    </div>
  )
}

function DialogFrame({ children, onClose, onSubmit, submitDisabled, submitLabel, title, width = 560 }: {
  children: ReactNode
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  submitDisabled?: boolean
  submitLabel: string
  title: string
  width?: number
}) {
  return (
    <Modal width={width} title={title} onClose={onClose}>
      <form onSubmit={onSubmit}>
        <div className="max-h-[58vh] overflow-auto p-5">{children}</div>
        <DialogActions disabled={submitDisabled} onClose={onClose} submitLabel={submitLabel} />
      </form>
    </Modal>
  )
}

function TableDialog({ initialValue, onClose, onSubmit }: {
  initialValue?: PresentationInsertTableValue
  onClose: () => void
  onSubmit: (value: PresentationInsertTableValue) => void
}) {
  const { t } = useTranslation()
  const initialCells = resizePresentationTableCells(
    initialValue?.cells ?? [['', ''], ['', '']],
    initialValue?.rows ?? 2,
    initialValue?.columns ?? 2,
  )
  const [cells, setCells] = useState(initialCells)
  const rows = cells.length
  const columns = cells[0]?.length ?? 1

  const resize = (nextRows: number, nextColumns: number) => {
    setCells((current) => resizePresentationTableCells(current, nextRows, nextColumns))
  }

  return (
    <DialogFrame
      title={t('session.presentation.insertDialog.tableTitle')}
      submitLabel={t('session.presentation.insertDialog.insert')}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({ kind: 'table', rows, columns, cells })
      }}
      width={680}
    >
      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className={labelClassName}>
          {t('session.presentation.insertDialog.rows')}
          <input data-testid="presentation-insert-table-rows" className={fieldClassName} type="number" min={1} max={10} value={rows} onChange={(event) => resize(Number(event.target.value), columns)} />
        </label>
        <label className={labelClassName}>
          {t('session.presentation.insertDialog.columns')}
          <input data-testid="presentation-insert-table-columns" className={fieldClassName} type="number" min={1} max={10} value={columns} onChange={(event) => resize(rows, Number(event.target.value))} />
        </label>
      </div>
      <div className="overflow-auto rounded-lg border border-border-default bg-bg-app/45 p-2">
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(92px, 1fr))` }}>
          {cells.flatMap((row, rowIndex) => row.map((cell, columnIndex) => (
            <input
              key={`${rowIndex}-${columnIndex}`}
              aria-label={t('session.presentation.insertDialog.tableCell', { row: rowIndex + 1, column: columnIndex + 1 })}
              data-testid={`presentation-insert-table-cell-${rowIndex}-${columnIndex}`}
              value={cell}
              onChange={(event) => {
                const value = event.target.value
                setCells((current) => current.map((currentRow, currentRowIndex) => (
                  currentRowIndex === rowIndex
                    ? currentRow.map((currentCell, currentColumnIndex) => currentColumnIndex === columnIndex ? value : currentCell)
                    : currentRow
                )))
              }}
              className="h-8 min-w-0 rounded border border-border-subtle bg-bg-surface px-2 text-xs text-text-primary outline-none focus:border-brand-purple"
            />
          ))) }
        </div>
      </div>
    </DialogFrame>
  )
}

const chartTypes: readonly PresentationInsertChartType[] = ['column', 'bar', 'line', 'pie', 'doughnut']

function ChartDialog({ initialValue, onClose, onSubmit }: {
  initialValue?: PresentationInsertChartValue
  onClose: () => void
  onSubmit: (value: PresentationInsertChartValue) => void
}) {
  const { t } = useTranslation()
  const [chartType, setChartType] = useState<PresentationInsertChartType>(initialValue?.chartType ?? 'column')
  const [title, setTitle] = useState(initialValue?.title ?? '')
  const [categoriesText, setCategoriesText] = useState((initialValue?.categories ?? ['A', 'B', 'C']).join(', '))
  const [seriesText, setSeriesText] = useState(
    (initialValue?.series ?? [{ name: t('session.presentation.insertDialog.defaultSeries'), values: [10, 20, 30] }])
      .map((series) => `${series.name}:${series.values.join(', ')}`).join('\n'),
  )
  const categories = useMemo(() => splitCommaSeparated(categoriesText), [categoriesText])
  const series = useMemo(() => parsePresentationChartSeries(seriesText, categories.length), [categories.length, seriesText])
  const pieSeriesInvalid = (chartType === 'pie' || chartType === 'doughnut') && series?.length !== 1
  const pieValuesInvalid = (chartType === 'pie' || chartType === 'doughnut')
    && Boolean(series?.length === 1)
    && !series![0]!.values.some((value) => value > 0)
  const invalid = !series || pieSeriesInvalid || pieValuesInvalid
  let validationMessage = t('session.presentation.insertDialog.seriesError')
  if (pieSeriesInvalid) validationMessage = t('session.presentation.insertDialog.pieSeriesError')
  else if (pieValuesInvalid) validationMessage = t('session.presentation.insertDialog.pieValuesError')

  return (
    <DialogFrame
      title={t('session.presentation.insertDialog.chartTitle')}
      submitLabel={t('session.presentation.insertDialog.insert')}
      submitDisabled={invalid}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        if (!series || pieSeriesInvalid || pieValuesInvalid) return
        onSubmit({ kind: 'chart', chartType, title: title.trim(), categories, series })
      }}
      width={680}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className={labelClassName}>
            {t('session.presentation.insertDialog.chartType')}
            <select data-testid="presentation-insert-chart-type" className={fieldClassName} value={chartType} onChange={(event) => setChartType(event.target.value as PresentationInsertChartType)}>
              {chartTypes.map((type) => <option key={type} value={type}>{t(`session.presentation.insertDialog.chartTypes.${type}`)}</option>)}
            </select>
          </label>
          <label className={labelClassName}>
            {t('session.presentation.insertDialog.chartTitleLabel')}
            <input data-testid="presentation-insert-chart-title" className={fieldClassName} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
        </div>
        <label className={labelClassName}>
          {t('session.presentation.insertDialog.categories')}
          <input data-testid="presentation-insert-chart-categories" className={fieldClassName} value={categoriesText} onChange={(event) => setCategoriesText(event.target.value)} placeholder={t('session.presentation.insertDialog.categoriesPlaceholder')} />
        </label>
        <label className={labelClassName}>
          {t('session.presentation.insertDialog.series')}
          <textarea data-testid="presentation-insert-chart-series" className={cn(fieldClassName, 'h-28 resize-y py-2 font-mono text-xs')} value={seriesText} onChange={(event) => setSeriesText(event.target.value)} placeholder={t('session.presentation.insertDialog.seriesPlaceholder')} />
        </label>
        {invalid ? (
          <p className="text-xs text-status-error" role="alert">
            {validationMessage}
          </p>
        ) : null}
      </div>
    </DialogFrame>
  )
}

function LinkDialog({ initialValue, linkLabelEditable, onClose, onSubmit, slides }: {
  initialValue?: PresentationInsertLinkValue
  linkLabelEditable: boolean
  onClose: () => void
  onSubmit: (value: PresentationInsertLinkValue) => void
  slides: readonly PresentationInsertSlideOption[]
}) {
  const { t } = useTranslation()
  const [targetType, setTargetType] = useState<PresentationInsertLinkTargetType>(initialValue?.targetType ?? 'url')
  const [url, setUrl] = useState(initialValue?.url ?? 'https://')
  const [slideId, setSlideId] = useState(initialValue?.slideId ?? slides[0]?.id ?? '')
  const [label, setLabel] = useState(initialValue?.label ?? '')
  const [tooltip, setTooltip] = useState(initialValue?.tooltip ?? '')
  const targetInvalid = targetType === 'url'
    ? !isAllowedExternalUrl(url.trim())
    : !slides.some((slide) => slide.id === slideId)
  const invalid = (linkLabelEditable && !label.trim()) || targetInvalid

  return (
    <DialogFrame
      title={t('session.presentation.insertDialog.linkTitle')}
      submitLabel={t('session.presentation.insertDialog.insert')}
      submitDisabled={invalid}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        if (invalid) return
        onSubmit({ kind: 'link', targetType, url: targetType === 'url' ? url.trim() : '', slideId: targetType === 'slide' ? slideId : '', label: label.trim(), tooltip: tooltip.trim() })
      }}
      width={520}
    >
      <div className="space-y-4">
        <label className={labelClassName}>
          {t('session.presentation.insertDialog.linkType')}
          <select data-testid="presentation-insert-link-type" className={fieldClassName} value={targetType} onChange={(event) => setTargetType(event.target.value as PresentationInsertLinkTargetType)}>
            <option value="url">{t('session.presentation.insertDialog.url')}</option>
            <option value="slide">{t('session.presentation.insertDialog.slide')}</option>
          </select>
        </label>
        {targetType === 'url' ? (
          <label className={labelClassName}>
            {t('session.presentation.insertDialog.url')}
            <input autoFocus data-testid="presentation-insert-link-url" className={fieldClassName} value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
        ) : (
          <label className={labelClassName}>
            {t('session.presentation.insertDialog.slide')}
            <select autoFocus data-testid="presentation-insert-link-slide" className={fieldClassName} value={slideId} onChange={(event) => setSlideId(event.target.value)}>
              {slides.map((slide, index) => <option key={slide.id} value={slide.id}>{index + 1}. {slide.name}</option>)}
            </select>
          </label>
        )}
        {linkLabelEditable ? (
          <label className={labelClassName}>
            {t('session.presentation.insertDialog.label')}
            <input data-testid="presentation-insert-link-label" className={fieldClassName} value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
        ) : null}
        <label className={labelClassName}>
          {t('session.presentation.insertDialog.tooltip')}
          <input data-testid="presentation-insert-link-tooltip" className={fieldClassName} value={tooltip} onChange={(event) => setTooltip(event.target.value)} />
        </label>
        {targetInvalid ? <p className="text-xs text-status-error" role="alert">{t('session.presentation.insertDialog.linkError')}</p> : null}
      </div>
    </DialogFrame>
  )
}

function FooterDialog({ initialValue, onClose, onSubmit }: {
  initialValue?: PresentationInsertFooterValue
  onClose: () => void
  onSubmit: (value: PresentationInsertFooterValue) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(initialValue?.text ?? '')
  const [showDate, setShowDate] = useState(initialValue?.showDate ?? false)
  const [showSlideNumber, setShowSlideNumber] = useState(initialValue?.showSlideNumber ?? true)
  const [applyAll, setApplyAll] = useState(initialValue?.applyAll ?? true)

  return (
    <DialogFrame
      title={t('session.presentation.insertDialog.footerTitle')}
      submitLabel={t('session.presentation.insertDialog.apply')}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({ kind: 'footer', text: text.trim(), showDate, showSlideNumber, applyAll })
      }}
      width={520}
    >
      <div className="space-y-4">
        <label className={labelClassName}>
          {t('session.presentation.insertDialog.footerText')}
          <input autoFocus data-testid="presentation-insert-footer-text" className={fieldClassName} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <div className="space-y-2 rounded-lg border border-border-subtle bg-bg-app/45 p-3">
          <CheckboxField checked={showDate} label={t('session.presentation.insertDialog.showDate')} onChange={setShowDate} testId="presentation-insert-footer-date" />
          <CheckboxField checked={showSlideNumber} label={t('session.presentation.insertDialog.showSlideNumber')} onChange={setShowSlideNumber} testId="presentation-insert-footer-number" />
          <CheckboxField checked={applyAll} label={t('session.presentation.insertDialog.applyAll')} onChange={setApplyAll} testId="presentation-insert-footer-all" />
        </div>
      </div>
    </DialogFrame>
  )
}

function CheckboxField({ checked, label, onChange, testId }: { checked: boolean; label: string; onChange: (checked: boolean) => void; testId: string }) {
  return (
    <label className="flex items-center gap-2.5 text-sm text-text-secondary">
      <input data-testid={testId} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-brand-purple" />
      {label}
    </label>
  )
}

/** Controlled host for the richer Insert-tab flows. File pickers remain owned by the workbench. */
export function PresentationInsertDialogs({ initialValue, linkLabelEditable = true, onClose, onSubmit, open, slides }: PresentationInsertDialogsProps) {
  if (!open) return null
  const matchingInitialValue = initialValue?.kind === open ? initialValue : undefined
  const resetKey = `${open}:${JSON.stringify(matchingInitialValue ?? null)}`
  if (open === 'table') {
    return <TableDialog key={resetKey} initialValue={matchingInitialValue as PresentationInsertTableValue | undefined} onClose={onClose} onSubmit={onSubmit} />
  }
  if (open === 'chart') {
    return <ChartDialog key={resetKey} initialValue={matchingInitialValue as PresentationInsertChartValue | undefined} onClose={onClose} onSubmit={onSubmit} />
  }
  if (open === 'link') {
    return <LinkDialog key={resetKey} initialValue={matchingInitialValue as PresentationInsertLinkValue | undefined} linkLabelEditable={linkLabelEditable} onClose={onClose} onSubmit={onSubmit} slides={slides} />
  }
  return <FooterDialog key={resetKey} initialValue={matchingInitialValue as PresentationInsertFooterValue | undefined} onClose={onClose} onSubmit={onSubmit} />
}
