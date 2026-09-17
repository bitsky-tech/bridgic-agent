export type ToolArgumentKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'missing' | 'unsupported'
export type ToolArgumentError = 'invalid_number' | 'invalid_boolean' | 'invalid_json' | 'expected_object' | 'expected_array' | 'expected_null' | 'missing' | 'unsupported'

export interface ToolArgumentField {
  id: string
  label: string
  kind: ToolArgumentKind
  input: string
}

export interface ToolArgumentDraft {
  shape: 'object' | 'named-list' | 'value'
  original: unknown
  fields: ToolArgumentField[]
  mode?: 'form' | 'json'
  jsonInput?: string
}

function object(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function kindOf(value: unknown): ToolArgumentKind {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (object(value)) return 'object'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return typeof value as ToolArgumentKind
  return 'unsupported'
}

export function formatToolArguments(value: unknown): string | undefined {
  try {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
    return JSON.stringify(value, null, 2)
  } catch { return undefined }
}

/** Normalize recorded name/value lists without silently dropping duplicate names. */
export function toolExecutionArguments(value: unknown): Record<string, unknown> | null {
  const properties = object(value)
  if (properties) return properties
  if (!Array.isArray(value)) return null
  const entries: [string, unknown][] = []
  const names = new Set<string>()
  for (const item of value) {
    const entry = object(item)
    if (!entry || typeof entry.name !== 'string' || !entry.name || !Object.hasOwn(entry, 'value') || names.has(entry.name)) return null
    names.add(entry.name)
    entries.push([entry.name, entry.value])
  }
  return Object.fromEntries(entries)
}

/** The snapshot belongs to the draft, so later trace polls cannot overwrite edits. */
export function createToolArgumentDraft(argumentsValue: unknown): ToolArgumentDraft {
  let original: unknown
  try { original = structuredClone(argumentsValue) } catch { original = argumentsValue }
  const makeField = (id: string, label: string, value: unknown): ToolArgumentField => ({
    id, label, kind: kindOf(value), input: typeof value === 'string' ? value : formatToolArguments(value) ?? '',
  })
  if (Array.isArray(original) && original.length > 0 && original.every(value => {
    const entry = object(value)
    return entry !== null && typeof entry.name === 'string' && Object.hasOwn(entry, 'value')
  })) {
    return { original, shape: 'named-list', fields: original.map((value, index) => makeField(String(index), value.name, value.value)) }
  }
  const properties = object(original)
  if (properties) return { original, shape: 'object', fields: Object.entries(properties).map(([key, value], index) => makeField(String(index), key, value)) }
  return { original, shape: 'value', fields: [makeField('0', '', original)] }
}

export function updateToolArgumentDraft(draft: ToolArgumentDraft, fieldId: string, input: string): ToolArgumentDraft {
  return { ...draft, fields: draft.fields.map(field => field.id === fieldId ? { ...field, input } : field) }
}

export function validateToolArgumentDraft(draft: ToolArgumentDraft): { valid: boolean; value: unknown; errors: Record<string, ToolArgumentError> } {
  if (draft.mode === 'json') {
    let value: unknown
    try { value = JSON.parse(draft.jsonInput ?? '') } catch {
      return { valid: false, value: undefined, errors: { $json: 'invalid_json' } }
    }
    return object(value) ? { valid: true, value, errors: {} }
      : { valid: false, value: undefined, errors: { $json: 'expected_object' } }
  }
  const errors: Record<string, ToolArgumentError> = {}
  const values: unknown[] = []
  for (const field of draft.fields) {
    const fail = (error: ToolArgumentError) => { errors[field.id] = error }
    if (field.kind === 'string') values.push(field.input)
    else if (field.kind === 'number') {
      const value = Number(field.input)
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(field.input.trim()) || !Number.isFinite(value)) fail('invalid_number')
      values.push(value)
    } else if (field.kind === 'boolean') {
      if (field.input !== 'true' && field.input !== 'false') fail('invalid_boolean')
      values.push(field.input === 'true')
    } else if (field.kind === 'missing' || field.kind === 'unsupported') {
      fail(field.kind)
      values.push(undefined)
    } else {
      let value: unknown
      try { value = JSON.parse(field.input) } catch { fail('invalid_json'); values.push(undefined); continue }
      if (field.kind === 'object' && !object(value)) fail('expected_object')
      if (field.kind === 'array' && !Array.isArray(value)) fail('expected_array')
      if (field.kind === 'null' && value !== null) fail('expected_null')
      values.push(value)
    }
  }
  if (Object.keys(errors).length) return { valid: false, value: undefined, errors }
  let value: unknown = values[0]
  if (draft.shape === 'object') value = Object.fromEntries(draft.fields.map((field, index) => [field.label, values[index]]))
  if (draft.shape === 'named-list') value = (draft.original as Record<string, unknown>[]).map((entry, index) => ({ ...entry, value: values[index] }))
  return { valid: true, value, errors }
}

export function toolArgumentMode(draft: ToolArgumentDraft, mode: 'form' | 'json'): ToolArgumentDraft {
  if ((draft.mode ?? 'form') === mode) return draft
  const validation = validateToolArgumentDraft(draft)
  if (mode === 'json') return { ...draft, mode,
    jsonInput: formatToolArguments(validation.valid ? toolExecutionArguments(validation.value) ?? validation.value : draft.original) ?? '{}' }
  if (!validation.valid) return draft
  return { ...createToolArgumentDraft(validation.value), original: draft.original, mode }
}

export function replaceToolArgumentValues(draft: ToolArgumentDraft, value: Record<string, unknown>): ToolArgumentDraft {
  return { ...createToolArgumentDraft(value), original: draft.original, mode: draft.mode, jsonInput: formatToolArguments(value) }
}
