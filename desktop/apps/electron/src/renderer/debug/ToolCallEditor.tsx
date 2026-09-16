import { useCallback, useId, useMemo, useState } from 'react'
import { ChevronDown, Play, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useDebugDraft } from './DebugDrafts'
import { useDebugText } from './DebugSessionProvider'
import { createToolArgumentDraft, formatToolArguments, replaceToolArgumentValues, toolArgumentMode, toolExecutionArguments, updateToolArgumentDraft, validateToolArgumentDraft, type ToolArgumentError } from './tool-argument-draft'
import { useToolExecution } from './useToolExecution'
import { ToolExecutionHistory } from './ToolExecutionHistory'
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
  const argumentsValue = validation.valid ? toolExecutionArguments(validation.value) : null
  const { runs, execution, execute, available } = useToolExecution(call.id)
  const running = execution?.status === 'running'
  let executionNotice = text('toolExecutionNotice')
  if (!available) executionNotice = text('toolBackendUnavailable')
  else if (!call.name || argumentsValue === null) executionNotice = text('toolArgumentsUnavailable')
  const mode = draft.mode ?? 'form'
  const changed = !validation.valid || formatToolArguments(toolExecutionArguments(validation.value) ?? validation.value)
    !== formatToolArguments(toolExecutionArguments(draft.original) ?? draft.original)
  const errors: Record<ToolArgumentError, string> = {
    invalid_number: text('invalidNumber'),
    invalid_boolean: text('invalidBoolean'),
    invalid_json: text('invalidJson'),
    expected_object: text('expectedObject'),
    expected_array: text('expectedArray'),
    expected_null: text('expectedNull'),
    missing: text('missingArgumentsNotice'),
    unsupported: text('unsupportedArgumentNotice'),
  }

  return <><details className="debug-inspector-card debug-tool-editor" open aria-label={text('toolArgumentEditor')}>
    <summary className="debug-inspector-heading">
      <SlidersHorizontal size={15} aria-hidden="true" />
      <h4>{text('toolArguments')}</h4>
      <span className={`debug-inspector-caption ${changed ? 'is-edited' : ''}`}>{changed ? text('edited') : `${draft.fields.length} ${text('fields')}`}</span>
      <ChevronDown className="debug-inspector-chevron" size={14} aria-hidden="true" />
    </summary>
    <div className="debug-inspector-body">
    <div className="debug-tool-editor-toolbar">
      <p className="debug-tool-editor-note">{text('sessionDraftNotice')}</p>
      <button type="button" onClick={() => setDraft(toolArgumentMode(createToolArgumentDraft(draft.original), mode))} disabled={!changed}>
        <RotateCcw size={12} />{text('resetToOriginal')}
      </button>
    </div>
    <div className="debug-tool-tabs" role="tablist" aria-label={text('toolWorkbench.editorMode')}>
      <button type="button" role="tab" aria-selected={mode === 'form'} disabled={!validation.valid && mode === 'json'} onClick={() => setDraft(current => toolArgumentMode(current, 'form'))}>{text('toolWorkbench.form')}</button>
      <button type="button" role="tab" aria-selected={mode === 'json'} disabled={!validation.valid && mode === 'form' && !draft.fields.some(field => field.kind === 'missing' || field.kind === 'unsupported')} onClick={() => setDraft(current => toolArgumentMode(current, 'json'))}>JSON</button>
    </div>
    {mode === 'json' ? <div className="debug-tool-editor-field debug-tool-json-editor">
      <label htmlFor={`${formId}-json`}>{text('toolWorkbench.fullArguments')}</label>
      <textarea id={`${formId}-json`} rows={10} spellCheck={false} aria-invalid={!validation.valid} aria-describedby={`${formId}-json-help`}
        value={draft.jsonInput ?? ''} onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, jsonInput: value })) }} />
      {validation.errors.$json ? <p role="alert" className="debug-tool-editor-error">{errors[validation.errors.$json]}</p> : null}
      <p id={`${formId}-json-help`} className="debug-tool-editor-note">{text('toolWorkbench.jsonHelp')}</p>
    </div> : <div className="debug-tool-editor-fields">
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
        else if (field.kind === 'missing' || field.kind === 'unsupported') control = <input {...common} type="text" readOnly placeholder={text('noEditableValueRecorded')} />
        else control = <textarea {...common} rows={field.kind === 'string' ? 2 : 4} spellCheck={false} onChange={event => update(event.target.value)} />
        let label = field.label || text('argumentValue')
        if (draft.shape === 'named-list') label = `${label} · ${index + 1}`
        return <div className="debug-tool-editor-field" key={field.id}>
          <label htmlFor={inputId}><span>{label}</span><code>{field.kind}</code></label>
          {control}
          {error ? <p id={`${inputId}-error`} role="alert" className="debug-tool-editor-error">{errors[error]}</p> : null}
        </div>
      })}
      {!draft.fields.length ? <p className="debug-tool-editor-note">{text('emptyArgumentsNotice')}</p> : null}
    </div>}
    <div className="debug-tool-editor-actions">
      <button type="button" className="debug-tool-execute" disabled={running || !available || !call.name || argumentsValue === null}
        onClick={() => { if (call.name && argumentsValue !== null) void execute({ toolName: call.name, arguments: argumentsValue }) }}
        aria-describedby={`${formId}-execution-status`}><Play size={13} />{text(running ? 'toolExecuting' : 'executeTool')}</button>
      <span id={`${formId}-execution-status`}>{executionNotice}</span>
    </div>
    <details className="debug-tool-editor-record">
      <summary>{text('originalArgumentsReadOnly')}</summary>
      <pre>{formatToolArguments(draft.original) ?? text('noDisplayableArgumentsRecorded')}</pre>
    </details>
    </div>
  </details><ToolExecutionHistory call={call} runs={runs} onReuse={value => setDraft(current => replaceToolArgumentValues(current, value))} /></>
}
