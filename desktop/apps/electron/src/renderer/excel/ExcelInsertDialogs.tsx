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
  const zh = locale === 'zh-CN'
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
        ?? (zh ? '链接暂时无法插入，请检查后再试。' : 'The link could not be inserted. Check it and try again.'))
    }
  }

  return (
    <DialogFrame
      description={zh ? `链接将插入到 ${context.address} 的左上角单元格。` : `The link will be inserted in the top-left cell of ${context.address}.`}
      locale={locale}
      onCancel={onCancel}
      title={zh ? '插入网络链接' : 'Insert hyperlink'}
    >
      <form className="space-y-4" onSubmit={submit}>
        <DialogField label={zh ? '显示文字' : 'Text to display'}>
          <input autoFocus className={inputClass} name="label" onChange={(event) => setLabel(event.target.value)} value={label} />
        </DialogField>
        <DialogField label={zh ? '网络地址' : 'Web address'}>
          <input className={inputClass} name="url" onChange={(event) => { setUrl(event.target.value); setError('') }} placeholder="https://example.com" value={url} />
        </DialogField>
        {error ? <p className="text-[11px] text-status-error">{error}</p> : null}
        <DialogActions locale={locale} onCancel={onCancel} submitLabel={zh ? '插入链接' : 'Insert link'} />
      </form>
    </DialogFrame>
  )
}

export function ExcelPivotTableDialog({ context, locale, onCancel, onConfirm }: DialogProps & {
  onConfirm: (options: ExcelPivotOptions) => void
}) {
  const zh = locale === 'zh-CN'
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
      description={zh ? '选择字段布局和汇总方式，结果会生成在新的工作表中。' : 'Choose the field layout and aggregation. The result will be generated on a new sheet.'}
      locale={locale}
      onCancel={onCancel}
      title={zh ? '创建数据透视表' : 'Create pivot table'}
    >
      <form className="space-y-3.5" onSubmit={submit}>
        <DialogField label={zh ? '数据源' : 'Source'}>
          <input className={`${inputClass} font-mono`} readOnly value={context.address} />
        </DialogField>
        <div className="grid grid-cols-2 gap-3">
          <DialogField label={zh ? '行字段' : 'Rows'}>
            <FieldSelect fields={fields} onChange={setRowField} value={rowField} />
          </DialogField>
          <DialogField label={zh ? '列字段（可选）' : 'Columns (optional)'}>
            <select className={inputClass} onChange={(event) => setColumnField(Number(event.target.value))} value={columnField}>
              <option value={-1}>{zh ? '无' : 'None'}</option>
              {fields.map((field, index) => <option key={`${field}:${index}`} value={index}>{field}</option>)}
            </select>
          </DialogField>
          <DialogField label={zh ? '值字段' : 'Values'}>
            <FieldSelect fields={fields} onChange={setValueField} value={valueField} />
          </DialogField>
          <DialogField label={zh ? '汇总方式' : 'Summarize by'}>
            <select className={inputClass} onChange={(event) => setAggregate(event.target.value as ExcelPivotAggregate)} value={aggregate}>
              <option value="sum">{zh ? '求和' : 'Sum'}</option>
              <option value="count">{zh ? '计数' : 'Count'}</option>
              <option value="average">{zh ? '平均值' : 'Average'}</option>
              <option value="min">{zh ? '最小值' : 'Minimum'}</option>
              <option value="max">{zh ? '最大值' : 'Maximum'}</option>
            </select>
          </DialogField>
        </div>
        {!canSubmit ? (
          <p className="rounded-md bg-status-warning/10 px-3 py-2 text-[11px] text-status-warning">
            {zh ? '请选择包含标题行和至少一行数据的区域。' : 'Select a range with a header row and at least one data row.'}
          </p>
        ) : null}
        <DialogActions disabled={!canSubmit} locale={locale} onCancel={onCancel} submitLabel={zh ? '创建透视表' : 'Create pivot table'} />
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
          <button aria-label={locale === 'zh-CN' ? '关闭' : 'Close'} className="flex h-7 w-7 items-center justify-center rounded-md text-lg text-text-tertiary hover:bg-bg-hover hover:text-text-primary" onClick={onCancel} type="button">×</button>
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
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button className="h-8 rounded-md border border-border-subtle bg-bg-surface px-3 text-[11px] font-medium text-text-secondary hover:bg-bg-hover" onClick={onCancel} type="button">{locale === 'zh-CN' ? '取消' : 'Cancel'}</button>
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
