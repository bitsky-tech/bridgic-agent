import { atom, useAtomValue, useStore } from 'jotai'
import { atomFamily } from 'jotai-family'
import { buildAmphiClient } from '@/atoms/backend'
import { activeSessionIdAtom } from '@/atoms/sessions'
import type { DesktopDebugToolResponse, ToolExecutionInput } from '@shared/debug-tool-types'
import { toolIdentitiesFamily, toolIdentity } from './tool-records'

export interface ToolExecution {
  id: string
  callId: string
  ordinal: number
  startedAt: number
  finishedAt?: number
  status: 'running' | 'complete' | 'error'
  input: ToolExecutionInput
  response?: DesktopDebugToolResponse
  error?: string
}

const toolClientAtom = atom(get => buildAmphiClient(get))
export const toolExecutionsFamily = atomFamily((_sessionId: string) => atom<ToolExecution[]>([]))
export const TOOL_HISTORY_LIMIT = 20

/** The request belongs to the store and Session, not to a mounted inspector. */
export const executeDebugToolAtom = atom(null, async (get, set, request: { sessionId: string; callId: string; input: ToolExecutionInput }) => {
  const client = get(toolClientAtom)
  const { sessionId, callId } = request
  const target = toolExecutionsFamily(sessionId)
  const runs = get(target)
  const identities = get(toolIdentitiesFamily(sessionId))
  const belongs = (run: ToolExecution) => toolIdentity(identities, run.callId) === toolIdentity(identities, callId)
  if (!client || runs.some(run => belongs(run) && run.status === 'running')) return
  const input = structuredClone(request.input)
  const previous = runs.filter(belongs)
  const run: ToolExecution = { id: crypto.randomUUID(), callId, ordinal: (previous.at(-1)?.ordinal ?? 0) + 1,
    startedAt: Date.now(), status: 'running', input }
  const retained = new Set(previous.slice(-(TOOL_HISTORY_LIMIT - 1)).map(item => item.id))
  set(target, [...runs.filter(item => !belongs(item) || retained.has(item.id)), run])
  const finish = (result: Partial<ToolExecution>) => set(target, get(target).map(item => item.id === run.id
    ? { ...item, ...result, finishedAt: Date.now() } : item))
  try {
    const response = await client.executeDebugTool(sessionId, input)
    if (response.sessionId !== sessionId || response.result?.tool_name !== input.toolName
      || typeof response.result.success !== 'boolean') throw new Error('Invalid tool execution response')
    finish({ status: 'complete', response })
  } catch (error) {
    finish({ status: 'error', error: error instanceof Error ? error.message : String(error) })
  }
})

export function useToolExecution(callId: string) {
  const store = useStore()
  const sessionId = useAtomValue(activeSessionIdAtom)
  const client = useAtomValue(toolClientAtom)
  const all = useAtomValue(toolExecutionsFamily(sessionId ?? ''))
  const identities = useAtomValue(toolIdentitiesFamily(sessionId ?? ''))
  const runs = all.filter(run => toolIdentity(identities, run.callId) === toolIdentity(identities, callId))
  const execute = (input: ToolExecutionInput) => sessionId
    ? store.set(executeDebugToolAtom, { sessionId, callId, input }) : Promise.resolve()
  return { runs, execution: runs.at(-1), execute, available: Boolean(sessionId && client) }
}
