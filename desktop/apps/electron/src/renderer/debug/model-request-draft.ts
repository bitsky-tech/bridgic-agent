export type RequestPath = (string | number)[]
export type RequestObject = Record<string, unknown>

export interface ModelRequestDraft {
  original: RequestObject
  request: RequestObject
  manual: boolean
  edited: boolean
  buffers: Record<string, string>
  errors: Record<string, boolean>
}

const wrappers = new Set(['request', 'llm_request', 'payload', 'body', 'model_options', 'debug_request'])
const messageKeys = new Set(['messages', 'prompt_messages', 'request_messages'])
const promptKeys = new Set(['system_prompt', 'prompt', 'system'])
const toolKeys = new Set(['tools', 'tool_definitions'])

export function isRequestObject(value: unknown): value is RequestObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function requestValue(request: unknown, path: RequestPath): unknown {
  let value = request
  for (const key of path) {
    if (Array.isArray(value) && typeof key === 'number') value = value[key]
    else if (isRequestObject(value) && Object.hasOwn(value, key)) value = value[key]
    else return undefined
  }
  return value
}

/** Clone only the edited ancestors, retaining every unrecognized request field. */
export function setRequestValue(request: RequestObject, path: RequestPath, value: unknown): RequestObject {
  function replace(current: unknown, index: number): unknown {
    if (index === path.length) return value
    const key = path[index]!
    if (typeof key === 'number' && Array.isArray(current)) {
      const copy = [...current]
      copy[key] = replace(copy[key], index + 1)
      return copy
    }
    const copy = isRequestObject(current) ? { ...current } : {}
    // An own data property also preserves JSON keys such as "__proto__" safely.
    Object.defineProperty(copy, key, { value: replace(copy[key], index + 1), enumerable: true, configurable: true, writable: true })
    return copy
  }
  return replace(request, 0) as RequestObject
}

export interface RequestField { path: RequestPath; value: unknown }
export interface RequestContainer { path: RequestPath; value: RequestObject }

export function inspectModelRequest(request: RequestObject) {
  const containers: RequestContainer[] = []
  function visit(value: RequestObject, path: RequestPath) {
    containers.push({ path, value })
    for (const [key, nested] of Object.entries(value)) {
      if (wrappers.has(key) && isRequestObject(nested)) visit(nested, [...path, key])
    }
  }
  visit(request, [])
  const messages: RequestField[] = []
  const prompts: RequestField[] = []
  const models: RequestField[] = []
  const tools: RequestField[] = []
  for (const container of containers) {
    for (const [key, value] of Object.entries(container.value)) {
      const field = { path: [...container.path, key], value }
      if (messageKeys.has(key) && Array.isArray(value)) messages.push(field)
      else if (promptKeys.has(key)) prompts.push(field)
      else if (key === 'model') models.push(field)
      else if (toolKeys.has(key)) tools.push(field)
    }
  }
  // Prefer the container that actually holds messages, then a prompt. Do not
  // combine competing snapshots or flatten provider-specific request wrappers.
  const prompt = prompts.find((field) => typeof field.value === 'string' || Array.isArray(field.value))
  const promptPath = messages[0]?.path ?? prompt?.path
  const primary = containers.find((container) => JSON.stringify(container.path) === JSON.stringify(promptPath?.slice(0, -1)))
    ?? containers.findLast((container) => container.path.at(-1) !== 'model_options')!
  return { containers, messages, prompts, models, tools, primary, hasPrompt: messages.length > 0 || prompt !== undefined }
}

export function createModelRequestDraft(recorded: RequestObject): ModelRequestDraft {
  return { original: structuredClone(recorded), request: structuredClone(recorded), manual: false, edited: false, buffers: {}, errors: {} }
}

export function startManualModelRequest(draft: ModelRequestDraft): ModelRequestDraft {
  const { primary, hasPrompt } = inspectModelRequest(draft.request)
  const manual = draft.manual || !hasPrompt
  // Leave malformed or provider-specific historical fields intact as well.
  const key = ['messages', 'request_messages', 'prompt_messages'].find((name) => !Object.hasOwn(primary.value, name))
  if (key) return { ...draft, manual, edited: true,
    request: setRequestValue(draft.request, [...primary.path, key], [{ role: 'user', content: '' }]) }
  return { ...draft, manual, edited: true,
    request: setRequestValue(draft.request, ['debug_request'], { messages: [{ role: 'user', content: '' }] }) }
}

export function requestOtherFields(value: RequestObject): RequestObject {
  return Object.fromEntries(Object.entries(value).filter(([key, nested]) => {
    if (wrappers.has(key) && isRequestObject(nested)) return false
    return !(messageKeys.has(key) && Array.isArray(nested)) && !promptKeys.has(key) && key !== 'model' && !toolKeys.has(key)
  }))
}

export function replaceRequestOtherFields(request: RequestObject, path: RequestPath, fields: unknown): RequestObject {
  if (!isRequestObject(fields)) throw new Error('Expected an object')
  const container = requestValue(request, path)
  if (!isRequestObject(container)) throw new Error('Expected a request container')
  const existingKeys = new Set(Object.keys(requestOtherFields(container)))
  const retained = Object.fromEntries(Object.entries(container).filter(([key]) => !existingKeys.has(key)))
  if (Object.keys(fields).some((key) => Object.hasOwn(retained, key))) throw new Error('Field belongs to another editor')
  return setRequestValue(request, path, { ...retained, ...fields })
}
