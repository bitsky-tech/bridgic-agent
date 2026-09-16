import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useDebugDraft } from './DebugDrafts'
import { useDebugText } from './DebugSessionProvider'
import { createModelRequestDraft, inspectModelRequest, isRequestObject, replaceRequestOtherFields, requestOtherFields, requestValue, setRequestValue, startManualModelRequest, type ModelRequestDraft, type RequestPath } from './model-request-draft'
import type { TraceRound } from './types'
import './model-request-editor.css'

type DraftSetter = Dispatch<SetStateAction<ModelRequestDraft>>
interface EditorState { draft: ModelRequestDraft; setDraft: DraftSetter }
const fieldName = (path: RequestPath) => path.join('.') || '$'
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
      value={draft.buffers[bufferKey] ?? asJson(value)} placeholder={text('jsonPlaceholder')}
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
    {error ? <span role="alert" className="debug-model-error">{text('invalidJsonFields')}</span> : null}
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
  const title = `${text('message')} ${index + 1}`
  const roles = ['system', 'user', 'assistant', 'tool']
  const canEditRole = isRequestObject(message) && (typeof message.role === 'string' || !Object.hasOwn(message, 'role'))
  let body
  if (isRequestObject(message) && canEditRole) {
    const role = typeof message.role === 'string' ? message.role : ''
    const contentKey = Array.isArray(message.blocks) ? 'blocks' : 'content'
    const metadata = Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'role' && key !== contentKey))
    body = <>
      <label className="debug-model-role"><span>role</span><select aria-label={`${title} role`} value={role}
        onChange={(event) => updateField(setDraft, [...path, 'role'], event.target.value)}>
        {!role ? <option value="" disabled>{text('notRecorded')}</option> : null}
        {role && !roles.includes(role) ? <option value={role}>{role}</option> : null}
        {roles.map((value) => <option key={value}>{value}</option>)}
      </select></label>
      {contentKey === 'blocks' ? (message.blocks as unknown[]).map((block, blockIndex) =>
        isRequestObject(block) && block.block_type === 'text' && typeof block.text === 'string'
          ? <ContentEditor key={blockIndex} draft={draft} setDraft={setDraft} path={[...path, 'blocks', blockIndex, 'text']} label={`${title} · ${blockIndex + 1} content`} />
          : <JsonEditor key={blockIndex} draft={draft} setDraft={setDraft} path={[...path, 'blocks', blockIndex]} value={block} label={`${title} · ${blockIndex + 1} (JSON)`} />)
        : <ContentEditor draft={draft} setDraft={setDraft} path={[...path, 'content']} label={`${title} content`} />}
      <details className="debug-model-extra"><summary>{text('messageMetadata')} · {Object.keys(metadata).length}</summary>
        <JsonEditor draft={draft} setDraft={setDraft} path={path} value={metadata} label={`${title} ${text('metadata')}`} objectOnly bufferPrefix="metadata"
          apply={(request, value) => {
            if (!isRequestObject(value) || Object.hasOwn(value, 'role') || Object.hasOwn(value, contentKey)) throw new Error('Reserved message fields')
            const current = requestValue(request, path)
            if (!isRequestObject(current)) throw new Error('Expected a message')
            const preserved = Object.fromEntries(Object.entries(current).filter(([key]) => key === 'role' || key === contentKey))
            return setRequestValue(request, path, { ...value, ...preserved })
          }} />
      </details>
    </>
  } else body = <JsonEditor draft={draft} setDraft={setDraft} path={path} value={message} label={`${title} (JSON)`} />
  return <div className="debug-model-message">
    <div className="debug-model-message-heading"><strong>{title}</strong><button type="button" aria-label={`${text('remove')} ${title}`}
      disabled={Object.values(draft.errors).some(Boolean)} onClick={onRemove}><Trash2 size={13} /></button></div>
    {body}
  </div>
}

export function ModelRequestEditor({ round, assembled, onRun, running = false, draftVersion = '', experiment = false }: {
  round: TraceRound; assembled?: Record<string, unknown>; onRun?: (request: Record<string, unknown>) => void; running?: boolean; draftVersion?: string; experiment?: boolean
}) {
  const text = useDebugText()
  const [draft, setDraft] = useDebugDraft<ModelRequestDraft>(`model:${round.id}:${assembled ? `assembled:${draftVersion}` : 'recorded'}`, () => createModelRequestDraft(assembled ?? round.recordedRequest))
  const assemblyChanged = useMemo(() => Boolean(assembled && JSON.stringify(assembled) !== JSON.stringify(draft.original)), [assembled, draft.original])
  useEffect(() => {
    if (!assembled || !assemblyChanged) return
    // Preserve edits, including invalid JSON buffers, when the assembly changes.
    setDraft(current => current.edited ? current : createModelRequestDraft(assembled))
  }, [assembled, assemblyChanged, setDraft])
  const snapshot = inspectModelRequest(draft.request)
  const ready = inspectModelRequest(draft.original).hasPrompt || draft.manual || draft.edited
  const modelFields = snapshot.models.length ? snapshot.models : [{ path: [...snapshot.primary.path, 'model'], value: undefined }]
  const toolsFields = snapshot.tools.length ? snapshot.tools : [{ path: [...snapshot.primary.path, 'tools'], value: undefined }]
  const hasErrors = Object.values(draft.errors).some(Boolean)
  const changeMessages = (path: RequestPath, messages: unknown[]) => setDraft((current) => ({
    ...current, edited: true, request: setRequestValue(current.request, path, messages), buffers: {}, errors: {},
  }))
  const runHint = experiment ? 'modelCall.experimentDraftHint' : 'modelCall.runNotice'
  const runControl = <div className="debug-model-run"><button type="button" disabled={!onRun || running || !ready || hasErrors || (assemblyChanged && !draft.edited)} onClick={() => onRun?.(draft.request)}>{text(experiment ? 'modelCall.runExperiment' : 'callLlmOnce')}</button>
    <span>{text(onRun ? runHint : 'executionApiPending')}</span>
  </div>
  return <section className="debug-model-editor" aria-label={text('modelRequestEditor')}>
    {experiment ? runControl : null}
    <div className="debug-model-heading"><strong>{ready ? text('debugDraft') : text('originalRequest')}</strong>
      {ready ? <span>{draft.edited ? text('edited') : text(assembled ? 'modelCall.assembledRequest' : 'fromRecordedFields')}</span> : null}
    </div>
    {assemblyChanged && draft.edited ? <p role="status" className="debug-model-note">{text('modelCall.assemblyChanged')}</p> : null}
    {ready ? <button className="debug-model-reset" type="button" disabled={!draft.edited && !assemblyChanged}
      onClick={() => setDraft((current) => createModelRequestDraft(assembled ?? current.original))}>{text(assembled ? 'modelCall.restoreAssembly' : 'restoreOriginalRequest')}</button> : null}
    {!assembled ? <p className="debug-model-note">{text('partialRequestNotice')}</p> : null}
    {!ready ? <div className="debug-model-empty">
      <p>{text('noPromptNotice')}</p>
      <button type="button" onClick={() => setDraft(startManualModelRequest)}><Plus size={14} />{text('createDebugRequest')}</button>
    </div> : <>
      {draft.manual ? <p className="debug-model-note">{text('manualDraftNotice')}</p> : null}
      <div className="debug-model-prompts">
        {snapshot.prompts.map((field) => <div key={fieldName(field.path)} className="debug-model-message">
          <ContentEditor draft={draft} setDraft={setDraft} path={field.path} label={fieldName(field.path)} />
        </div>)}
        {snapshot.messages.map((field) => <div key={fieldName(field.path)} className="debug-model-message-list">
          <div className="debug-model-section-heading"><strong>Prompt</strong><code>{fieldName(field.path)}</code></div>
          {(field.value as unknown[]).map((_, index) => <MessageEditor key={index} draft={draft} setDraft={setDraft} path={[...field.path, index]} index={index}
            onRemove={() => changeMessages(field.path, (field.value as unknown[]).filter((_, item) => item !== index))} />)}
          <button type="button" className="debug-model-add" disabled={hasErrors}
            onClick={() => changeMessages(field.path, [...field.value as unknown[], { role: 'user', content: '' }])}><Plus size={13} />{text('addMessage')}</button>
        </div>)}
        {!snapshot.messages.length ? <button type="button" className="debug-model-add" disabled={hasErrors}
          onClick={() => setDraft(startManualModelRequest)}><Plus size={13} />{text('addMessageList')}</button> : null}
      </div>
      <div className="debug-model-settings">
        <div className="debug-model-section-heading"><strong>{text('modelParameters')}</strong></div>
        {modelFields.map((field) => typeof field.value === 'string' || field.value === undefined ? <label key={fieldName(field.path)} className="debug-model-field">
          <span>{text('model')} <code>{fieldName(field.path)}</code></span>
          <input aria-label={fieldName(field.path)} value={typeof field.value === 'string' ? field.value : ''} placeholder={text('modelPlaceholder')}
            onChange={(event) => updateField(setDraft, field.path, event.target.value)} />
        </label> : <JsonEditor key={fieldName(field.path)} draft={draft} setDraft={setDraft} path={field.path} value={field.value} label={fieldName(field.path)} />)}
        <p className="debug-model-note">{text('parametersNotice')}</p>
        {snapshot.containers.map((container) => <JsonEditor
          key={JSON.stringify(container.path)} draft={draft} setDraft={setDraft} path={container.path} value={requestOtherFields(container.value)} objectOnly bufferPrefix="parameters"
          label={`${text('parametersOtherFields')} · ${fieldName(container.path)}`}
          apply={(request, value) => replaceRequestOtherFields(request, container.path, value)}
          readValue={(request) => {
            const value = requestValue(request, container.path)
            return isRequestObject(value) ? requestOtherFields(value) : value
          }} />)}
      </div>
      <details className="debug-model-extra"><summary>{text('toolDefinitions')}</summary>
        <p className="debug-model-note">{text('toolSchemasNotice')}</p>
        {toolsFields.map((field) => <JsonEditor key={fieldName(field.path)} draft={draft} setDraft={setDraft} path={field.path} value={field.value} label={fieldName(field.path)} />)}
      </details>
      <details className="debug-model-raw"><summary>{text('debugDraftJson')}</summary>
        {hasErrors ? <p className="debug-model-note" role="alert">{text('invalidDraftNotice')}</p>
          : <pre>{asJson(draft.request)}</pre>}
      </details>
    </>}
    <details className="debug-model-raw"><summary>{text(assembled ? 'modelCall.assemblyBaseline' : 'originalRequestRecordedFields')}</summary>
      <pre>{Object.keys(draft.original).length ? asJson(draft.original) : text('notRecorded')}</pre>
    </details>
    {!experiment ? runControl : null}
    {!onRun ? <p className="debug-model-note">{text('draftOnlyNotice')}</p> : null}
  </section>
}
