import { useTranslation } from 'react-i18next'
import { i18n } from '../lib/i18n'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { ExcelHostConfig } from '../../shared/types'
import {
  defaultPivotValueField,
  excelInsertValidationMessage,
  normalizeHyperlinkUrl,
  selectionFields,
  type ExcelHyperlinkOptions,
  type ExcelInsertContext,
  type ExcelPivotAggregate,
  type ExcelPivotOptions,
} from './excelInsert'

interface DialogProps {
  context: ExcelInsertContext
  locale: ExcelHostConfig['locale']
  onCancel: () => void
}

export function ExcelHyperlinkDialog({ context, locale, onCancel, onConfirm }: DialogProps & {
  onConfirm: (options: ExcelHyperlinkOptions) => void
}) {
  const { t } = useTranslation(undefined, { i18n, lng: locale })
  const [url, setUrl] = useState('https://')
  const [label, setLabel] = useState(() => String(context.values[0]?.[0] ?? ''))
  const [error, setError] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    try {
      const data = new FormData(event.currentTarget as HTMLFormElement)
      const normalized = normalizeHyperlinkUrl(String(data.get('url') ?? ''))
      const display = String(data.get('label') ?? '').trim()
      onConfirm({ url: normalized, label: display || normalized })
    } catch (cause) {
      setError(excelInsertValidationMessage(cause, locale)
        ?? (t('excel.hyperlink.failed')))
    }
  }

  return (
    <DialogFrame
      description={t('excel.hyperlink.description', { address: context.address })}
      locale={locale}
      onCancel={onCancel}
      title={t('excel.hyperlink.title')}
    >
      <form className="space-y-4" onSubmit={submit}>
        <DialogField label={t('excel.hyperlink.displayText')}>
          <input autoFocus className={inputClass} name="label" onChange={(event) => setLabel(event.target.value)} value={label} />
        </DialogField>
        <DialogField label={t('excel.hyperlink.webAddress')}>
          <input className={inputClass} name="url" onChange={(event) => { setUrl(event.target.value); setError('') }} placeholder="https://example.com" value={url} />
        </DialogField>
        {error ? <p className="text-[11px] text-status-error">{error}</p> : null}
        <DialogActions locale={locale} onCancel={onCancel} submitLabel={t('excel.hyperlink.submit')} />
      </form>
    </DialogFrame>
  )
}

export function ExcelPivotTableDialog({ context, locale, onCancel, onConfirm }: DialogProps & {
  onConfirm: (options: ExcelPivotOptions) => void
}) {
  const { t } = useTranslation(undefined, { i18n, lng: locale })
  const fields = useMemo(() => selectionFields(context.values), [context.values])
  const [rowField, setRowField] = useState(0)
  const [columnField, setColumnField] = useState(-1)
  const [valueField, setValueField] = useState(() => defaultPivotValueField(context.values))
  const [aggregate, setAggregate] = useState<ExcelPivotAggregate>('sum')
  const canSubmit = fields.length > 0 && context.values.length > 1
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    onConfirm({
      sourceAddress: context.address,
      rowField,
      columnField: columnField < 0 ? null : columnField,
      valueField,
      aggregate,
    })
  }

  return (
    <DialogFrame
      description={t('excel.pivot.description')}
      locale={locale}
      onCancel={onCancel}
      title={t('excel.pivot.title')}
    >
      <form className="space-y-3.5" onSubmit={submit}>
        <DialogField label={t('excel.pivot.source')}>
          <input className={`${inputClass} font-mono`} readOnly value={context.address} />
        </DialogField>
        <div className="grid grid-cols-2 gap-3">
          <DialogField label={t('excel.pivot.rows')}>
            <FieldSelect fields={fields} onChange={setRowField} value={rowField} />
          </DialogField>
          <DialogField label={t('excel.pivot.columns')}>
            <select className={inputClass} onChange={(event) => setColumnField(Number(event.target.value))} value={columnField}>
              <option value={-1}>{t('excel.pivot.none')}</option>
              {fields.map((field, index) => <option key={`${field}:${index}`} value={index}>{field}</option>)}
            </select>
          </DialogField>
          <DialogField label={t('excel.pivot.values')}>
            <FieldSelect fields={fields} onChange={setValueField} value={valueField} />
          </DialogField>
          <DialogField label={t('excel.pivot.aggregate')}>
            <select className={inputClass} onChange={(event) => setAggregate(event.target.value as ExcelPivotAggregate)} value={aggregate}>
              <option value="sum">{t('excel.pivot.sum')}</option>
              <option value="count">{t('excel.pivot.count')}</option>
              <option value="average">{t('excel.pivot.average')}</option>
              <option value="min">{t('excel.pivot.min')}</option>
              <option value="max">{t('excel.pivot.max')}</option>
            </select>
          </DialogField>
        </div>
        {!canSubmit ? (
          <p className="rounded-md bg-status-warning/10 px-3 py-2 text-[11px] text-status-warning">
            {t('excel.pivot.rangeRequired')}
          </p>
        ) : null}
        <DialogActions disabled={!canSubmit} locale={locale} onCancel={onCancel} submitLabel={t('excel.pivot.submit')} />
      </form>
    </DialogFrame>
  )
}

function DialogFrame({ children, description, locale, onCancel, title }: {
  children: ReactNode
  description: string
  locale: ExcelHostConfig['locale']
  onCancel: () => void
  title: string
}) {
  const { t } = useTranslation(undefined, { i18n, lng: locale })
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 p-6" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onCancel()
    }}>
      <section aria-describedby="excel-insert-dialog-description" aria-label={title} aria-modal="true" className="w-full max-w-lg rounded-xl border border-border-subtle bg-bg-surface p-5 shadow-2xl" role="dialog">
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <p className="mt-1 text-[11px] leading-5 text-text-tertiary" id="excel-insert-dialog-description">{description}</p>
          </div>
          <button aria-label={t('excel.dialog.close')} className="flex h-7 w-7 items-center justify-center rounded-md text-lg text-text-tertiary hover:bg-bg-hover hover:text-text-primary" onClick={onCancel} type="button">×</button>
        </div>
        {children}
      </section>
    </div>
  )
}

function DialogField({ children, label }: { children: ReactNode; label: string }) {
  return <label className="block text-[11px] font-medium text-text-secondary"><span className="mb-1.5 block">{label}</span>{children}</label>
}

function DialogActions({ disabled = false, locale, onCancel, submitLabel }: {
  disabled?: boolean
  locale: ExcelHostConfig['locale']
  onCancel: () => void
  submitLabel: string
}) {
  const { t } = useTranslation(undefined, { i18n, lng: locale })
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button className="h-8 rounded-md border border-border-subtle bg-bg-surface px-3 text-[11px] font-medium text-text-secondary hover:bg-bg-hover" onClick={onCancel} type="button">{t('excel.dialog.cancel')}</button>
      <button className="h-8 rounded-md bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:pointer-events-none disabled:opacity-40" disabled={disabled} type="submit">{submitLabel}</button>
    </div>
  )
}

function FieldSelect({ fields, onChange, value }: { fields: string[]; onChange: (value: number) => void; value: number }) {
  return (
    <select className={inputClass} onChange={(event) => onChange(Number(event.target.value))} value={value}>
      {fields.map((field, index) => <option key={`${field}:${index}`} value={index}>{field}</option>)}
    </select>
  )
}

const inputClass = 'h-8 w-full rounded-md border border-border-subtle bg-bg-app px-2.5 text-[11px] text-text-primary outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15'
