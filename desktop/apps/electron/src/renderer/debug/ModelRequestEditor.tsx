import type { Dispatch, SetStateAction } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useDebugDraft } from './DebugDrafts'
import { useDebugText } from './DebugSessionProvider'
import { createModelRequestDraft, inspectModelRequest, isRequestObject, replaceRequestOtherFields, requestOtherFields, requestValue, setRequestValue, startManualModelRequest, type ModelRequestDraft, type RequestPath } from './model-request-draft'
import type { TraceRound } from './types'
import './model-request-editor.css'

type DraftSetter = Dispatch<SetStateAction<ModelRequestDraft>>
interface EditorState { draft: ModelRequestDraft; setDraft: DraftSetter }
const fieldName = (path: RequestPath) => path.join('.') || 'request'
const asJson = (value: unknown) => value === undefined ? '' : JSON.stringify(value, null, 2)

function updateField(setDraft: DraftSetter, path: RequestPath, value: unknown) {
  setDraft((current) => ({ ...current, edited: true, request: setRequestValue(current.request, path, value) }))
}

function JsonEditor({ draft, setDraft, path, label, value, apply, readValue, objectOnly = false, bufferPrefix = 'value' }: EditorState & {
  path: RequestPath; label: string; value: unknown; objectOnly?: boolean; bufferPrefix?: string
  apply?: (request: ModelRequestDraft['request'], value: unknown) => ModelRequestDraft['request']
  readValue?: (request: ModelRequestDraft['request']) => unknown
}) {
  const text = useDebugText()
  const bufferKey = `${bufferPrefix}:${JSON.stringify(path)}`
  const error = draft.errors[bufferKey]
  return <label className="debug-model-field">
    <span>{label}</span>
    <textarea className="debug-model-json-input" aria-label={label} aria-invalid={Boolean(error)} spellCheck={false} rows={5}
      value={draft.buffers[bufferKey] ?? asJson(value)} placeholder={text('未记录；可填写 JSON', 'Not recorded; enter JSON')}
      onChange={(event) => {
        const source = event.target.value
        setDraft((current) => {
          const next = { ...current, edited: true, buffers: { ...current.buffers, [bufferKey]: source }, errors: { ...current.errors } }
          try {
            const parsed: unknown = JSON.parse(source)
            if (objectOnly && !isRequestObject(parsed)) throw new Error('Expected an object')
            next.request = apply ? apply(current.request, parsed) : setRequestValue(current.request, path, parsed)
            if (readValue) {
              const appliedValue = readValue(next.request)
              // Newly recognized fields move to their own editors; keep only this editor's fields in its buffer.
              if (asJson(appliedValue) !== asJson(parsed)) next.buffers[bufferKey] = asJson(appliedValue)
            }
            delete next.errors[bufferKey]
          } catch { next.errors[bufferKey] = true }
          return next
        })
      }} />
    {error ? <span role="alert" className="debug-model-error">{text('请填写有效 JSON；对象字段请使用对象，且勿覆盖其他编辑区的字段。', 'Enter valid JSON. Object fields require an object and must not replace fields in another editor.')}</span> : null}
  </label>
}

function ContentEditor({ draft, setDraft, path, label }: EditorState & { path: RequestPath; label: string }) {
  const value = requestValue(draft.request, path)
  if (typeof value !== 'string') return <JsonEditor draft={draft} setDraft={setDraft} path={path} value={value} label={`${label} (JSON)`} />
  return <label className="debug-model-field"><span>{label}</span>
    <textarea aria-label={label} rows={Math.min(14, Math.max(4, value.split('\n').length + 1))} spellCheck={false} value={value}
      onChange={(event) => updateField(setDraft, path, event.target.value)} />
  </label>
}

function MessageEditor({ draft, setDraft, path, index, onRemove }: EditorState & { path: RequestPath; index: number; onRemove: () => void }) {
  const text = useDebugText()
  const message = requestValue(draft.request, path)
  const title = `${text('消息', 'Message')} ${index + 1}`
  const roles = ['system', 'developer', 'user', 'assistant', 'tool']
  const canEditRole = isRequestObject(message) && (typeof message.role === 'string' || !Object.hasOwn(message, 'role'))
  let body
  if (isRequestObject(message) && canEditRole) {
    const role = typeof message.role === 'string' ? message.role : ''
    const metadata = Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'role' && key !== 'content'))
    body = <>
      <label className="debug-model-role"><span>role</span><select aria-label={`${title} role`} value={role}
        onChange={(event) => updateField(setDraft, [...path, 'role'], event.target.value)}>
        {!role ? <option value="" disabled>{text('未记录', 'Not recorded')}</option> : null}
        {role && !roles.includes(role) ? <option value={role}>{role}</option> : null}
        {roles.map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <ContentEditor draft={draft} setDraft={setDraft} path={[...path, 'content']} label={`${title} content`} />
      <details className="debug-model-extra"><summary>{text('消息元数据', 'Message metadata')} · {Object.keys(metadata).length}</summary>
        <JsonEditor draft={draft} setDraft={setDraft} path={path} value={metadata} label={`${title} ${text('元数据', 'metadata')}`} objectOnly bufferPrefix="metadata"
          apply={(request, value) => {
            if (!isRequestObject(value) || Object.hasOwn(value, 'role') || Object.hasOwn(value, 'content')) throw new Error('Reserved message fields')
            const current = requestValue(request, path)
            if (!isRequestObject(current)) throw new Error('Expected a message')
            const preserved = Object.fromEntries(Object.entries(current).filter(([key]) => key === 'role' || key === 'content'))
            return setRequestValue(request, path, { ...value, ...preserved })
          }} />
      </details>
    </>
  } else body = <JsonEditor draft={draft} setDraft={setDraft} path={path} value={message} label={`${title} (JSON)`} />
  return <div className="debug-model-message">
    <div className="debug-model-message-heading"><strong>{title}</strong><button type="button" aria-label={`${text('删除', 'Remove')} ${title}`}
      disabled={Object.values(draft.errors).some(Boolean)} onClick={onRemove}><Trash2 size={13} /></button></div>
    {body}
  </div>
}

export function ModelRequestEditor({ round }: { round: TraceRound }) {
  const text = useDebugText()
  const [draft, setDraft] = useDebugDraft<ModelRequestDraft>(`model:${round.id}`, () => createModelRequestDraft(round.recordedRequest))
  const snapshot = inspectModelRequest(draft.request)
  const ready = inspectModelRequest(draft.original).hasPrompt || draft.manual || draft.edited
  const modelFields = snapshot.models.length ? snapshot.models : [{ path: [...snapshot.primary.path, 'model'], value: undefined }]
  const toolsFields = snapshot.tools.length ? snapshot.tools : [{ path: [...snapshot.primary.path, 'tools'], value: undefined }]
  const hasErrors = Object.values(draft.errors).some(Boolean)
  const changeMessages = (path: RequestPath, messages: unknown[]) => setDraft((current) => ({
    ...current, edited: true, request: setRequestValue(current.request, path, messages), buffers: {}, errors: {},
  }))
  return <section className="debug-model-editor" aria-label={text('模型请求编辑器', 'Model request editor')}>
    <div className="debug-model-heading"><strong>{ready ? text('调试草稿', 'Debug draft') : text('原始请求', 'Original request')}</strong>
      {ready ? <span>{draft.edited ? text('已修改', 'Edited') : text('基于已记录字段', 'From recorded fields')}</span> : null}
    </div>
    {ready ? <button className="debug-model-reset" type="button" disabled={!draft.edited}
      onClick={() => setDraft((current) => createModelRequestDraft(current.original))}>{text('恢复原始请求', 'Restore original request')}</button> : null}
    <p className="debug-model-note">{text('记录可能只是请求的部分快照，无法据此判断完整性。草稿编辑不会改写历史记录。', 'The record may be a partial request snapshot; its completeness cannot be inferred. Draft edits do not change history.')}</p>
    {!ready ? <div className="debug-model-empty">
      <p>{text('此轮未保存可读取的 Prompt。可手动新建调试请求，内容不代表原始 Prompt。', 'No readable prompt was saved for this round. You can create a manual debug request; it will not represent the original prompt.')}</p>
      <button type="button" onClick={() => setDraft(startManualModelRequest)}><Plus size={14} />{text('新建调试请求', 'Create debug request')}</button>
    </div> : <>
      {draft.manual ? <p className="debug-model-note">{text('手动创建的草稿 · 历史 Prompt 仍未记录', 'Manually created draft · Historical prompt remains unavailable')}</p> : null}
      <div className="debug-model-prompts">
        {snapshot.prompts.map((field) => <div key={fieldName(field.path)} className="debug-model-message">
          <ContentEditor draft={draft} setDraft={setDraft} path={field.path} label={fieldName(field.path)} />
        </div>)}
        {snapshot.messages.map((field) => <div key={fieldName(field.path)} className="debug-model-message-list">
          <div className="debug-model-section-heading"><strong>Prompt</strong><code>{fieldName(field.path)}</code></div>
          {(field.value as unknown[]).map((_, index) => <MessageEditor key={index} draft={draft} setDraft={setDraft} path={[...field.path, index]} index={index}
            onRemove={() => changeMessages(field.path, (field.value as unknown[]).filter((_, item) => item !== index))} />)}
          <button type="button" className="debug-model-add" disabled={hasErrors}
            onClick={() => changeMessages(field.path, [...field.value as unknown[], { role: 'user', content: '' }])}><Plus size={13} />{text('添加消息', 'Add message')}</button>
        </div>)}
        {!snapshot.messages.length ? <button type="button" className="debug-model-add" disabled={hasErrors}
          onClick={() => setDraft(startManualModelRequest)}><Plus size={13} />{text('添加消息列表', 'Add message list')}</button> : null}
      </div>
      <div className="debug-model-settings">
        <div className="debug-model-section-heading"><strong>{text('模型与参数', 'Model & parameters')}</strong></div>
        {modelFields.map((field) => typeof field.value === 'string' || field.value === undefined ? <label key={fieldName(field.path)} className="debug-model-field">
          <span>{text('模型', 'Model')} <code>{fieldName(field.path)}</code></span>
          <input aria-label={fieldName(field.path)} value={typeof field.value === 'string' ? field.value : ''} placeholder={text('未记录；填写调试模型', 'Not recorded; enter a debug model')}
            onChange={(event) => updateField(setDraft, field.path, event.target.value)} />
        </label> : <JsonEditor key={fieldName(field.path)} draft={draft} setDraft={setDraft} path={field.path} value={field.value} label={fieldName(field.path)} />)}
        <p className="debug-model-note">{text('参数保持原字段与层级，可编辑 temperature、max_tokens 及供应商特有选项；未记录的值不会自动补齐。', 'Parameters retain their original keys and nesting, including temperature, max_tokens and provider options. Unrecorded values are not filled in.')}</p>
        {snapshot.containers.filter((container) => container === snapshot.primary || Object.keys(requestOtherFields(container.value)).length).map((container) => <JsonEditor
          key={fieldName(container.path)} draft={draft} setDraft={setDraft} path={container.path} value={requestOtherFields(container.value)} objectOnly bufferPrefix="parameters"
          label={`${text('参数与其他字段', 'Parameters & other fields')} · ${fieldName(container.path)}`}
          apply={(request, value) => replaceRequestOtherFields(request, container.path, value)}
          readValue={(request) => {
            const value = requestValue(request, container.path)
            return isRequestObject(value) ? requestOtherFields(value) : value
          }} />)}
      </div>
      <details className="debug-model-extra"><summary>{text('工具定义', 'Tool definitions')}</summary>
        <p className="debug-model-note">{text('保留工具 schema 的原始格式；单次模型调用不会自动执行工具。', 'Tool schemas retain their original format. A single model call will not automatically execute tools.')}</p>
        {toolsFields.map((field) => <JsonEditor key={fieldName(field.path)} draft={draft} setDraft={setDraft} path={field.path} value={field.value} label={fieldName(field.path)} />)}
      </details>
      <details className="debug-model-raw"><summary>{text('调试草稿 JSON', 'Debug draft JSON')}</summary>
        {hasErrors ? <p className="debug-model-note" role="alert">{text('草稿包含无效 JSON，请先修正编辑区的错误后再查看完整请求。', 'The draft contains invalid JSON. Correct the editor errors before viewing the complete request.')}</p>
          : <pre>{asJson(draft.request)}</pre>}
      </details>
    </>}
    <details className="debug-model-raw"><summary>{text('原始请求 · 已记录字段', 'Original request · Recorded fields')}</summary>
      <pre>{Object.keys(draft.original).length ? asJson(draft.original) : text('未记录', 'Not recorded')}</pre>
    </details>
    <div className="debug-model-run"><button type="button" disabled>{text('单次调用 LLM', 'Call LLM once')}</button>
      <span>{text('执行接口待接入', 'Execution API pending')}</span>
    </div>
    <p className="debug-model-note">{text('当前仅编辑请求草稿；不会发送模型请求或自动执行工具。', 'This editor only prepares a request draft. It does not send model requests or automatically execute tools.')}</p>
  </section>
}
