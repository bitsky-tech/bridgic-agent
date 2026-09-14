import type { TraceToolCall } from './types'

export interface ToolCallPreview {
  arguments: { name: string; value: string }[]
  remainingArgumentCount: number
  argumentState: 'recorded' | 'empty' | 'missing'
  outcomeKind: 'error' | 'result' | 'missing'
  outcome: string
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function namedArgument(value: unknown): value is { name: string; value: unknown } {
  return plainObject(value) && typeof value.name === 'string' && Object.hasOwn(value, 'value')
}

function preview(value: unknown, limit: number): string {
  let serialized: string
  if (typeof value === 'string') serialized = value
  else {
    try { serialized = JSON.stringify(value) ?? String(value) } catch { serialized = String(value) }
  }
  const text = serialized.replace(/\s+/g, ' ').trim() || '""'
  const characters = Array.from(text)
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : text
}

export function toolCallPreview(call: TraceToolCall): ToolCallPreview {
  let entries: { name: string; value: unknown }[] = []
  let argumentState: ToolCallPreview['argumentState'] = 'recorded'
  if (call.arguments === undefined) argumentState = 'missing'
  else if (plainObject(call.arguments)) {
    entries = Object.entries(call.arguments).map(([name, value]) => ({ name, value }))
    if (!entries.length) argumentState = 'empty'
  } else if (Array.isArray(call.arguments) && call.arguments.length > 0 && call.arguments.every(namedArgument)) {
    entries = call.arguments
  } else entries = [{ name: '', value: call.arguments }]

  let outcomeKind: ToolCallPreview['outcomeKind'] = 'missing'
  let outcome = ''
  if (call.error !== undefined && call.error !== null) {
    outcomeKind = 'error'
    outcome = preview(call.error, 800)
  } else if (call.hasResult && call.result !== undefined) {
    outcomeKind = 'result'
    outcome = preview(call.result, 800)
  }
  return {
    arguments: entries.slice(0, 3).map(({ name, value }) => ({ name, value: preview(value, 240) })),
    remainingArgumentCount: Math.max(0, entries.length - 3),
    argumentState,
    outcomeKind,
    outcome,
  }
}
