import { useCallback, useId, useMemo, useState } from 'react'
import { ChevronDown, Play, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useDebugDraft } from './DebugDrafts'
import { useDebugText } from './DebugSessionProvider'
import { createToolArgumentDraft, formatToolArguments, updateToolArgumentDraft, validateToolArgumentDraft, type ToolArgumentError } from './tool-argument-draft'
import type { TraceToolCall } from './types'
import './tool-editor.css'
import './debug-inspector.css'

export function ToolCallEditor({ call }: { call: TraceToolCall }) {
  return <ToolCallDraft key={call.id} call={call} />
}

function ToolCallDraft({ call }: { call: TraceToolCall }) {
  const text = useDebugText()
  const formId = useId()
  const [initial] = useState(() => createToolArgumentDraft(call.arguments))
  const initialize = useCallback(() => initial, [initial])
  const [draft, setDraft] = useDebugDraft(`tool:${call.id}`, initialize)
  const validation = useMemo(() => validateToolArgumentDraft(draft), [draft])
  const original = useMemo(() => createToolArgumentDraft(draft.original), [draft.original])
  const changed = draft.fields.some((field, index) => field.input !== original.fields[index]?.input)
  const errors: Record<ToolArgumentError, string> = {
    invalid_number: text('请输入有效数字。', 'Enter a valid number.'),
    invalid_boolean: text('请选择 true 或 false。', 'Choose true or false.'),
    invalid_json: text('JSON 格式无效，请检查括号、引号和逗号。', 'Invalid JSON. Check brackets, quotes and commas.'),
    expected_object: text('此参数原为对象，请输入 JSON 对象。', 'This recorded argument is an object. Enter a JSON object.'),
    expected_array: text('此参数原为数组，请输入 JSON 数组。', 'This recorded argument is an array. Enter a JSON array.'),
    expected_null: text('此参数原值为 null。', 'This recorded argument is null.'),
    missing: text('这条历史记录没有保存参数。', 'Arguments were not saved in this historical record.'),
    unsupported: text('此参数类型暂不支持表单编辑。', 'This argument type cannot be edited in the form yet.'),
  }

  return <details className="debug-inspector-card debug-tool-editor" open aria-label={text('工具参数编辑器', 'Tool argument editor')}>
    <summary className="debug-inspector-heading">
      <SlidersHorizontal size={15} aria-hidden="true" />
      <h4>{text('工具参数', 'Tool arguments')}</h4>
      <span className={`debug-inspector-caption ${changed ? 'is-edited' : ''}`}>{changed ? text('已修改', 'Edited') : `${draft.fields.length} ${text('项', 'fields')}`}</span>
      <ChevronDown className="debug-inspector-chevron" size={14} aria-hidden="true" />
    </summary>
    <div className="debug-inspector-body">
    <div className="debug-tool-editor-toolbar">
      <p className="debug-tool-editor-note">{text('修改保存在当前会话草稿中。', 'Edits stay in this session’s draft.')}</p>
      <button type="button" onClick={() => setDraft(createToolArgumentDraft(draft.original))} disabled={!changed}>
        <RotateCcw size={12} />{text('恢复原始参数', 'Reset to original')}
      </button>
    </div>
    <div className="debug-tool-editor-fields">
      {draft.fields.map((field, index) => {
        const inputId = `${formId}-${field.id}`
        const error = validation.errors[field.id]
        const common = {
          id: inputId, value: field.input, 'aria-invalid': Boolean(error), 'aria-describedby': error ? `${inputId}-error` : undefined,
        }
        const update = (value: string) => setDraft(current => updateToolArgumentDraft(current, field.id, value))
        let control
        if (field.kind === 'boolean') control = <select {...common} onChange={event => update(event.target.value)}><option value="true">true</option><option value="false">false</option></select>
        else if (field.kind === 'number') control = <input {...common} type="text" inputMode="decimal" onChange={event => update(event.target.value)} />
        else if (field.kind === 'null') control = <input {...common} type="text" readOnly />
        else if (field.kind === 'missing' || field.kind === 'unsupported') control = <input {...common} type="text" readOnly placeholder={text('未记录可编辑值', 'No editable value recorded')} />
        else control = <textarea {...common} rows={field.kind === 'string' ? 2 : 4} spellCheck={false} onChange={event => update(event.target.value)} />
        let label = field.label || text('参数值', 'Argument value')
        if (draft.shape === 'named-list') label = `${label} · ${index + 1}`
        return <div className="debug-tool-editor-field" key={field.id}>
          <label htmlFor={inputId}><span>{label}</span><code>{field.kind}</code></label>
          {control}
          {error ? <p id={`${inputId}-error`} role="alert" className="debug-tool-editor-error">{errors[error]}</p> : null}
        </div>
      })}
      {!draft.fields.length ? <p className="debug-tool-editor-note">{text('已记录空参数对象。', 'An empty argument object was recorded.')}</p> : null}
    </div>
    <div className="debug-tool-editor-actions">
      <button type="button" className="debug-tool-execute" disabled aria-describedby={`${formId}-execution-status`}><Play size={13} />{text('执行工具', 'Execute tool')}</button>
      <span id={`${formId}-execution-status`}>{text('执行接口待接入', 'Execution API not connected')}</span>
    </div>
    <details className="debug-tool-editor-record">
      <summary>{text('草稿参数预览', 'Draft argument preview')}</summary>
      <pre>{validation.valid ? formatToolArguments(validation.value) : text('修正表单中的错误后可预览参数。', 'Fix the form errors to preview arguments.')}</pre>
    </details>
    <details className="debug-tool-editor-record">
      <summary>{text('原始参数 · 只读', 'Original arguments · Read only')}</summary>
      <pre>{formatToolArguments(draft.original) ?? text('未记录可展示的参数', 'No displayable arguments recorded')}</pre>
    </details>
    </div>
  </details>
}
