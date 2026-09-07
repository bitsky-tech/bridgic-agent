import { useEffect, useMemo, useRef, useState } from 'react'
import { MousePointer2 } from 'lucide-react'
import type { ExcelHostConfig } from '../../shared/types'
import {
  excelFormulaLibrary,
  filterFormulaLibrary,
  type ExcelFormulaCategory,
  type ExcelFormulaDescriptor,
  type ExcelFormulaParameter,
} from './excelFormulaCatalog'
import {
  buildFormula,
  formulaPreviewErrorMessage,
  missingFormulaArgument,
  parseFormulaCall,
  rangeReference,
  type ExcelFormulaPreviewResult,
} from './excelFormulaWizard'

type FormulaCategoryFilter = ExcelFormulaCategory | 'all'
type FormulaPreviewState =
  | { status: 'idle' }
  | { status: 'calculating' }
  | { status: 'success'; value: string }
  | { status: 'error'; message: string }

interface RangePickerState {
  index: number
  originalValue: string
}

function parametersFor(formula: ExcelFormulaDescriptor, count: number, locale: ExcelHostConfig['locale']): ExcelFormulaParameter[] {
  const parameters = [...formula.parameters]
  while (parameters.length < count) {
    const index = parameters.length
    const template = parameters.at(-1)
    parameters.push({
      detail: template?.detail ?? '',
      key: `argument${index + 1}`,
      name: locale === 'zh-CN' ? `参数 ${index + 1}` : `Argument ${index + 1}`,
      required: index < formula.minParameters,
    })
  }
  return parameters
}

export function ExcelFormulaWizardDialog({
  initialFormula = '',
  locale,
  onCancel,
  onConfirm,
  onEvaluate,
  recentFunctions,
  selectionAddress,
  selectionSheetName,
  targetAddress,
  targetSheetName,
}: {
  initialFormula?: string
  locale: ExcelHostConfig['locale']
  onCancel: () => void
  onConfirm: (formula: string, name: string) => void
  onEvaluate: (formula: string) => Promise<ExcelFormulaPreviewResult>
  recentFunctions: readonly string[]
  selectionAddress: string
  selectionSheetName: string
  targetAddress: string
  targetSheetName: string
}) {
  const zh = locale === 'zh-CN'
  const library = useMemo(() => excelFormulaLibrary(locale), [locale])
  const parsedInitial = useMemo(() => parseFormulaCall(initialFormula), [initialFormula])
  const initialDescriptor = parsedInitial ? library.find((formula) => formula.name === parsedInitial.name) : null
  const [category, setCategory] = useState<FormulaCategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedName, setSelectedName] = useState(() => initialDescriptor?.name ?? recentFunctions[0] ?? 'SUM')
  const [wizardOpen, setWizardOpen] = useState(Boolean(initialDescriptor))
  const [argumentValues, setArgumentValues] = useState<string[]>(() => parsedInitial?.arguments ?? [])
  const [parameterCount, setParameterCount] = useState(() => Math.max(
    initialDescriptor?.parameters.length ?? 0,
    parsedInitial?.arguments.length ?? 0,
  ))
  const [picker, setPicker] = useState<RangePickerState | null>(null)
  const [preview, setPreview] = useState<FormulaPreviewState>({ status: 'idle' })
  const evaluationId = useRef(0)
  const matches = useMemo(() => {
    const recentRank = new Map(recentFunctions.map((name, index) => [name, index]))
    return filterFormulaLibrary(library, query, category).sort((left, right) => {
      const leftRank = recentRank.get(left.name) ?? Number.MAX_SAFE_INTEGER
      const rightRank = recentRank.get(right.name) ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank || left.name.localeCompare(right.name)
    })
  }, [category, library, query, recentFunctions])
  const selected = wizardOpen
    ? library.find((formula) => formula.name === selectedName) ?? null
    : matches.find((formula) => formula.name === selectedName) ?? matches[0] ?? null
  const parameters = selected ? parametersFor(selected, Math.max(parameterCount, selected.parameters.length), locale) : []
  const formula = selected ? buildFormula(selected.name, argumentValues) : ''
  const missingIndex = selected ? missingFormulaArgument(selected, argumentValues) : null
  const selectedReference = rangeReference(selectionAddress, selectionSheetName, targetSheetName)

  const copy = zh ? {
    addArgument: '添加参数', all: '全部函数', back: '返回函数库', cancel: '取消',
    calculating: '正在计算预览…', categories: {
      common: '常用', financial: '财务', logical: '逻辑', text: '文本', date: '日期与时间',
      lookup: '查找与引用', math: '数学', statistical: '统计',
    },
    chooseRange: '在表格中选择单元格或区域', description: '搜索函数，查看语法和参数说明，然后配置函数参数。',
    donePicking: '完成选择', empty: '没有找到匹配的函数。', functions: '个函数',
    insert: '插入公式', next: '设置参数', optional: '可选', parameters: '参数说明',
    pickDetail: '请直接在下方表格中点击或拖选区域，选区会自动填入。',
    preview: '实时结果', required: '必填', search: '搜索函数名称、用途或参数',
    target: '公式将写入', title: '插入函数',
  } : {
    addArgument: 'Add argument', all: 'All functions', back: 'Back to function library', cancel: 'Cancel',
    calculating: 'Calculating preview…', categories: {
      common: 'Common', financial: 'Financial', logical: 'Logical', text: 'Text', date: 'Date & time',
      lookup: 'Lookup & reference', math: 'Math', statistical: 'Statistical',
    },
    chooseRange: 'Select a cell or range in the sheet', description: 'Search functions, review their syntax and arguments, then configure the function arguments.',
    donePicking: 'Done selecting', empty: 'No matching functions found.', functions: 'functions', insert: 'Insert formula',
    next: 'Set arguments', optional: 'Optional', parameters: 'Arguments',
    pickDetail: 'Click or drag in the sheet below. The selected range is filled in automatically.',
    preview: 'Live result', required: 'Required', search: 'Search by function, purpose, or argument',
    target: 'Formula will be written to', title: 'Insert function',
  }

  const setArgument = (index: number, value: string) => {
    setPreview({ status: 'idle' })
    setArgumentValues((current) => {
      const next = [...current]
      while (next.length <= index) next.push('')
      next[index] = value
      return next
    })
  }
  const cancelPicker = () => {
    if (!picker) return
    setArgument(picker.index, picker.originalValue)
    setPicker(null)
  }
  const startWizard = (descriptor: ExcelFormulaDescriptor) => {
    const initialArguments = parsedInitial?.name === descriptor.name ? parsedInitial.arguments : []
    setSelectedName(descriptor.name)
    setArgumentValues(initialArguments)
    setParameterCount(Math.max(descriptor.parameters.length, initialArguments.length))
    setPreview({ status: 'idle' })
    setWizardOpen(true)
  }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (picker) cancelPicker()
      else onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  })

  useEffect(() => {
    evaluationId.current += 1
    const id = evaluationId.current
    if (!wizardOpen || !selected || missingIndex !== null) return
    const timeout = window.setTimeout(() => {
      setPreview({ status: 'calculating' })
      void onEvaluate(formula).then((result) => {
        if (evaluationId.current !== id) return
        if (result.errorCode) setPreview({ status: 'error', message: formulaPreviewErrorMessage(result.errorCode, locale) })
        else setPreview({ status: 'success', value: result.value ?? '' })
      }).catch(() => {
        if (evaluationId.current === id) setPreview({
          status: 'error',
          message: zh ? '暂时无法生成计算预览，请检查参数。' : 'A calculation preview is not available. Check the arguments.',
        })
      })
    }, 220)
    return () => window.clearTimeout(timeout)
  }, [formula, locale, missingIndex, onEvaluate, selected, wizardOpen, zh])

  if (picker && selected) {
    const parameter = parameters[picker.index]
    const pickedReference = selectedReference
    const finishPicking = () => {
      setArgument(picker.index, pickedReference)
      setPicker(null)
    }
    return (
      <div className="pointer-events-none fixed inset-0 z-[10000]">
        <section aria-label={copy.chooseRange} className="pointer-events-auto absolute left-1/2 top-3 w-[min(680px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-emerald-500/40 bg-bg-surface p-3 shadow-2xl" role="dialog">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><MousePointer2 size={16} /></span>
            <div className="min-w-0 flex-1"><p className="text-[11px] font-semibold text-text-primary">{selected.name} · {parameter?.name}</p><p className="mt-0.5 text-[10px] text-text-tertiary">{copy.pickDetail}</p></div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input aria-label={parameter?.name} className="h-8 min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-app px-2.5 font-mono text-[11px] text-text-primary outline-none focus:border-emerald-500" onChange={(event) => setArgument(picker.index, event.target.value)} value={pickedReference} />
            <button className="h-8 rounded-md bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-700" onClick={finishPicking} type="button">{copy.donePicking}</button>
            <button className="h-8 rounded-md px-2 text-[11px] text-text-tertiary hover:bg-bg-hover" onClick={cancelPicker} type="button">{copy.cancel}</button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 p-6" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onCancel()
    }}>
      <section aria-describedby="excel-formula-dialog-description" aria-label={copy.title} aria-modal="true" className="flex h-[min(620px,calc(100vh-48px))] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-surface shadow-2xl" role="dialog">
        <header className="flex shrink-0 items-start gap-3 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold text-text-primary">{wizardOpen && selected ? `${copy.title} · ${selected.name}` : copy.title}</h2><p className="mt-1 text-[11px] leading-5 text-text-tertiary" id="excel-formula-dialog-description">{wizardOpen ? `${copy.target} ${targetSheetName}!${targetAddress}` : copy.description}</p></div>
          <button aria-label={zh ? '关闭' : 'Close'} className="flex h-7 w-7 items-center justify-center rounded-md text-lg text-text-tertiary hover:bg-bg-hover hover:text-text-primary" onClick={onCancel} type="button">×</button>
        </header>

        {wizardOpen && selected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="rounded-lg border border-border-subtle bg-bg-app px-3 py-2"><p className="font-mono text-[11px] font-medium text-emerald-600">{formula}</p><p className="mt-1 text-[10px] leading-5 text-text-tertiary">{selected.description}</p></div>
              <div className="mt-4 space-y-3">
                {parameters.map((parameter, index) => (
                  <div className="rounded-lg border border-border-subtle p-3" key={`${parameter.key}:${index}`}>
                    <div className="flex items-center gap-2"><label className="min-w-0 flex-1 text-[11px] font-medium text-text-primary" htmlFor={`formula-argument-${index}`}>{parameter.name}<span className={`ml-1.5 text-[9px] ${parameter.required ? 'text-emerald-600' : 'text-text-tertiary'}`}>{parameter.required ? copy.required : copy.optional}</span></label><span className="font-mono text-[9px] text-text-tertiary">{parameter.key}</span></div>
                    <div className="mt-2 flex items-center gap-1.5">
                      <input aria-invalid={missingIndex === index} className={`h-8 min-w-0 flex-1 rounded-md border bg-bg-app px-2.5 font-mono text-[11px] text-text-primary outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 ${missingIndex === index ? 'border-status-warning/60' : 'border-border-subtle'}`} id={`formula-argument-${index}`} onChange={(event) => setArgument(index, event.target.value)} placeholder={parameter.key} value={argumentValues[index] ?? ''} />
                      <button aria-label={`${copy.chooseRange}: ${parameter.name}`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-emerald-600" onClick={() => setPicker({ index, originalValue: argumentValues[index] ?? '' })} title={copy.chooseRange} type="button"><MousePointer2 size={14} /></button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-5 text-text-tertiary">{parameter.detail}</p>
                  </div>
                ))}
              </div>
              {selected.maxParameters === null || parameterCount < selected.maxParameters ? <button className="mt-3 h-8 rounded-md border border-dashed border-border-subtle px-3 text-[10px] text-text-secondary hover:border-emerald-500/50 hover:text-emerald-600" onClick={() => {
                setPreview({ status: 'idle' })
                setParameterCount((current) => current + 1)
              }} type="button">+ {copy.addArgument}</button> : null}
              <div aria-live="polite" className={`mt-4 rounded-lg border px-3 py-2 ${preview.status === 'error' ? 'border-status-warning/30 bg-status-warning/8' : 'border-border-subtle bg-bg-app'}`}>
                <p className="text-[10px] font-medium text-text-tertiary">{copy.preview}</p>
                {missingIndex !== null ? <p className="mt-1 text-[11px] text-status-warning">{zh ? `请先填写必填参数“${parameters[missingIndex]?.name}”。` : `Complete the required argument “${parameters[missingIndex]?.name}”.`}</p> : null}
                {missingIndex === null && preview.status === 'calculating' ? <p className="mt-1 text-[11px] text-text-secondary">{copy.calculating}</p> : null}
                {preview.status === 'success' ? <p className="mt-1 break-words font-mono text-[12px] font-semibold text-emerald-600">{preview.value || (zh ? '空值' : 'Blank')}</p> : null}
                {preview.status === 'error' ? <p className="mt-1 text-[11px] leading-5 text-status-warning">{preview.message}</p> : null}
              </div>
            </div>
            <footer className="flex shrink-0 items-center justify-between border-t border-border-subtle px-5 py-3">
              <button className="h-8 rounded-md px-3 text-[11px] text-text-secondary hover:bg-bg-hover" onClick={() => setWizardOpen(false)} type="button">{copy.back}</button>
              <div className="flex gap-2"><button className="h-8 rounded-md border border-border-subtle bg-bg-surface px-3 text-[11px] font-medium text-text-secondary hover:bg-bg-hover" onClick={onCancel} type="button">{copy.cancel}</button><button className="h-8 rounded-md bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:pointer-events-none disabled:opacity-40" disabled={missingIndex !== null} onClick={() => onConfirm(formula, selected.name)} type="button">{copy.insert}</button></div>
            </footer>
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              <div className="flex w-72 shrink-0 flex-col border-r border-border-subtle p-4">
                <input aria-label={copy.search} autoFocus className="h-8 rounded-md border border-border-subtle bg-bg-app px-2.5 text-[11px] text-text-primary outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15" onInput={(event) => setQuery(event.currentTarget.value)} placeholder={copy.search} type="search" value={query} />
                <select aria-label={zh ? '函数分类' : 'Function category'} className="mt-2 h-8 rounded-md border border-border-subtle bg-bg-app px-2 text-[11px] text-text-secondary outline-none focus:border-emerald-500" onChange={(event) => setCategory(event.target.value as FormulaCategoryFilter)} value={category}><option value="all">{copy.all}</option>{(Object.entries(copy.categories) as Array<[ExcelFormulaCategory, string]>).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
                <div className="mt-3 flex items-center justify-between text-[10px] text-text-tertiary"><span>{matches.length} {copy.functions}</span>{recentFunctions.length > 0 ? <span>{zh ? '最近使用优先' : 'Recent first'}</span> : null}</div>
                <div className="mt-1 min-h-0 flex-1 overflow-y-auto rounded-md border border-border-subtle bg-bg-app p-1" role="listbox">
                  {matches.length > 0 ? matches.map((descriptor) => <button aria-selected={selected?.name === descriptor.name} className={`flex h-8 w-full items-center rounded px-2 text-left font-mono text-[11px] ${selected?.name === descriptor.name ? 'bg-emerald-500/12 text-emerald-600' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`} key={descriptor.name} onClick={() => setSelectedName(descriptor.name)} onDoubleClick={() => startWizard(descriptor)} role="option" type="button">{descriptor.name}</button>) : <p className="px-3 py-8 text-center text-[11px] text-text-tertiary">{copy.empty}</p>}
                </div>
              </div>
              <div className="min-w-0 flex-1 overflow-y-auto p-5">
                {selected ? <><div className="flex items-center gap-2"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 font-serif text-lg italic text-emerald-600">fx</span><div className="min-w-0"><h3 className="font-mono text-base font-semibold text-text-primary">{selected.name}</h3><p className="mt-0.5 break-words font-mono text-[11px] text-emerald-600">={selected.syntax}</p></div></div><p className="mt-4 text-[12px] leading-6 text-text-secondary">{selected.description}</p><h4 className="mt-5 text-[11px] font-semibold text-text-primary">{copy.parameters}</h4>{selected.parameters.length > 0 ? <div className="mt-2 space-y-2">{selected.parameters.map((parameter, index) => <div className="rounded-lg border border-border-subtle bg-bg-app px-3 py-2" key={`${parameter.key}:${index}`}><p className="font-mono text-[11px] font-medium text-emerald-600">{parameter.name}<span className="ml-1.5 font-sans text-[9px] text-text-tertiary">{parameter.required ? copy.required : copy.optional}</span></p><p className="mt-1 text-[10px] leading-5 text-text-tertiary">{parameter.detail}</p></div>)}</div> : <p className="mt-2 text-[11px] text-text-tertiary">{zh ? '此函数不需要参数。' : 'This function takes no arguments.'}</p>}</> : <p className="text-[11px] text-text-tertiary">{copy.empty}</p>}
              </div>
            </div>
            <footer className="flex shrink-0 justify-end gap-2 border-t border-border-subtle px-5 py-3"><button className="h-8 rounded-md border border-border-subtle bg-bg-surface px-3 text-[11px] font-medium text-text-secondary hover:bg-bg-hover" onClick={onCancel} type="button">{copy.cancel}</button><button className="h-8 rounded-md bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:pointer-events-none disabled:opacity-40" disabled={!selected} onClick={() => selected && startWizard(selected)} type="button">{copy.next}</button></footer>
          </>
        )}
      </section>
    </div>
  )
}
