import type { DebugRecordStatus, DebugRound, DebugToolCall } from './debug-record-types'

export interface DebugFilters { query: string; name: string; status: DebugRecordStatus | ''; turnId: string }
export const emptyDebugFilters: DebugFilters = { query: '', name: '', status: '', turnId: '' }
export const debugRoundTabs = ['request', 'response', 'state'] as const
export type DebugRoundTab = typeof debugRoundTabs[number]

export function nextDebugRoundTab(current: DebugRoundTab, key: string): DebugRoundTab | null {
  if (key === 'Home') return debugRoundTabs[0]
  if (key === 'End') return debugRoundTabs[debugRoundTabs.length - 1]!
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  return debugRoundTabs[(debugRoundTabs.indexOf(current) + (key === 'ArrowRight' ? 1 : -1) + debugRoundTabs.length) % debugRoundTabs.length]!
}

export function filterDebugCalls(calls: DebugToolCall[], filters: DebugFilters): DebugToolCall[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return calls.filter(call => (!filters.name || call.name === filters.name)
    && (!filters.status || call.status === filters.status)
    && (!filters.turnId || call.turnId === filters.turnId)
    && (!query || `${call.name} ${call.summary}`.toLocaleLowerCase().includes(query)))
}

export function filterDebugRounds(rounds: DebugRound[], filters: DebugFilters): DebugRound[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return rounds.filter(round => (!filters.status || round.status === filters.status)
    && (!filters.turnId || round.turnId === filters.turnId)
    && (!query || `${round.label} ${round.title} ${round.stageLabel}`.toLocaleLowerCase().includes(query)))
}

export type JsonObjectParse = { ok: true; value: Record<string, unknown> } | { ok: false; error: 'invalid-json' | 'object-required' }
export function parseDebugArguments(text: string): JsonObjectParse {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'object-required' }
    return { ok: true, value: value as Record<string, unknown> }
  } catch { return { ok: false, error: 'invalid-json' } }
}

export function roundRequest(round: DebugRound): Record<string, unknown> {
  return {
    model: round.model,
    model_options: round.modelOptions,
    messages: round.promptMessages.map(message => ({ role: message.role, content: message.content })),
    tools: round.toolDefinitions.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.schema })),
  }
}

export function isValidRoundRequest(request: Record<string, unknown>): boolean {
  return Array.isArray(request.messages) && request.messages.length > 0 && request.messages.every(message =>
    message && typeof message === 'object' && ['system', 'user', 'assistant', 'tool'].includes(message.role) && typeof message.content === 'string')
    && Array.isArray(request.tools)
    && request.tools.every(tool => tool && typeof tool === 'object' && typeof tool.name === 'string')
}

export interface DebugSimulationReceipt {
  id: string
  sourceId: string
  kind: 'tool' | 'round'
  createdAt: number
  request: Record<string, unknown>
  executed: false
}

/** A local request receipt is intentionally not a tool result or a model response. */
export function createDebugSimulationReceipt(kind: 'tool' | 'round', sourceId: string, request: Record<string, unknown>, id: string, createdAt: number): DebugSimulationReceipt {
  return { id, sourceId, kind, createdAt, request: structuredClone(request), executed: false }
}
