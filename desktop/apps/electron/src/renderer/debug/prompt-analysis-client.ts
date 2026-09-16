import type { DesktopDebugPromptResponse, PromptAssemblyInput } from '@shared/debug-prompt-types'
import type { AmphiClient } from '@/lib/amphiClient'
import { atom } from 'jotai'
import { buildAmphiClient } from '@/atoms/backend'

export const debugPromptClientAtom = atom(get => buildAmphiClient(get))

export function validatePromptAnalysis(data: DesktopDebugPromptResponse, sessionId: string, input: PromptAssemblyInput): DesktopDebugPromptResponse {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  const nullableString = (value: unknown) => value === null || typeof value === 'string'
  if (!object(data) || data.sessionId !== sessionId || !object(data.item)) throw new Error('Invalid session Prompt response')
  const item = data.item
  if (typeof item.id !== 'string' || !item.id || item.turnId !== input.turnId || item.roundIndex !== input.roundIndex
    || !Number.isSafeInteger(item.turnOrdinal) || item.turnOrdinal < 0 || item.stage !== input.stage || item.mode !== input.mode
    || item.availability !== 'assembled') throw new Error('Invalid assembled Prompt identity')
  const request = item.request
  if (!object(request) || request.schemaVersion !== 1 || request.kind !== 'cognitive'
    || !nullableString(request.providerId) || !nullableString(request.modelId) || !nullableString(request.protocol)
    || !Array.isArray(request.messages) || !Array.isArray(request.tools) || !('extraBody' in request)) throw new Error('Invalid assembled Cognitive request')
  return data
}

export async function fetchPromptAnalysis(client: AmphiClient, sessionId: string, input: PromptAssemblyInput, signal: AbortSignal): Promise<DesktopDebugPromptResponse> {
  return validatePromptAnalysis(await client.assembleDebugPrompt(sessionId, input, signal), sessionId, input)
}
