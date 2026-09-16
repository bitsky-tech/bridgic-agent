import type { CognitiveRequest, DesktopDebugPrompt, PromptJson } from '@shared/debug-prompt-types'

export const promptJsonText = (value: PromptJson | CognitiveRequest) => JSON.stringify(value, null, 2)
export const promptTraceId = (prompt: Pick<DesktopDebugPrompt, 'turnId' | 'roundIndex'>) => `${encodeURIComponent(prompt.turnId)}:round:${prompt.roundIndex + 1}`
export const promptRoundLabel = (prompt: Pick<DesktopDebugPrompt, 'roundIndex'>) => `R${String(prompt.roundIndex + 1).padStart(2, '0')}`

export interface PromptDifference {
  id: string
  kind: 'message' | 'tools' | 'metadata' | 'extraBody'
  index?: number
  before: string
  after: string
  status: 'same' | 'changed' | 'added' | 'removed'
  prefix: number
  suffix: number
}

/** Compare every assembled field. Order, native blocks and provider extras remain intact. */
export function compareCognitiveRequests(before: CognitiveRequest, after: CognitiveRequest): PromptDifference[] {
  const difference = (id: string, kind: PromptDifference['kind'], left: PromptJson | undefined, right: PromptJson | undefined, index?: number): PromptDifference => {
    const a = left === undefined ? '' : promptJsonText(left)
    const b = right === undefined ? '' : promptJsonText(right)
    let prefix = 0
    while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix += 1
    let suffix = 0
    while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix += 1
    let status: PromptDifference['status'] = 'changed'
    if (a === b) status = 'same'
    else if (left === undefined) status = 'added'
    else if (right === undefined) status = 'removed'
    return { id, kind, index, before: a, after: b, prefix, suffix, status }
  }
  const metadata = ({ schemaVersion, kind, providerId, modelId, protocol }: CognitiveRequest): PromptJson => ({ schemaVersion, kind, providerId, modelId, protocol })
  return [
    difference('metadata', 'metadata', metadata(before), metadata(after)),
    ...Array.from({ length: Math.max(before.messages.length, after.messages.length) }, (_, index) => difference(`message:${index}`, 'message', before.messages[index], after.messages[index], index)),
    difference('tools', 'tools', before.tools, after.tools),
    difference('extraBody', 'extraBody', before.extraBody, after.extraBody),
  ]
}

export function messageRole(message: PromptJson): string | null {
  return message !== null && typeof message === 'object' && !Array.isArray(message) && typeof message.role === 'string' ? message.role : null
}
