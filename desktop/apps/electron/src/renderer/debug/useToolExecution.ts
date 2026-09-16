import { useRef } from 'react'
import { atom, useAtomValue } from 'jotai'
import { buildAmphiClient } from '@/atoms/backend'
import { activeSessionIdAtom } from '@/atoms/sessions'
import type { DesktopDebugToolResponse, ToolExecutionInput } from '@shared/debug-tool-types'
import { useDebugDraft } from './DebugDrafts'

const toolClientAtom = atom(get => buildAmphiClient(get))
type Execution = { status: 'running' | 'complete' | 'error'; input: ToolExecutionInput; response?: DesktopDebugToolResponse; error?: string }

export function useToolExecution(callId: string) {
  const sessionId = useAtomValue(activeSessionIdAtom)
  const client = useAtomValue(toolClientAtom)
  const [execution, setExecution] = useDebugDraft<Execution | null>(`tool-execution:${callId}`, () => null)
  const pending = useRef<{ sessionId: string; callId: string } | null>(null)

  const execute = async (input: ToolExecutionInput) => {
    if (!sessionId || !client || execution?.status === 'running'
      || (pending.current?.sessionId === sessionId && pending.current.callId === callId)) return
    const request = { sessionId, callId }
    pending.current = request
    setExecution({ status: 'running', input })
    try {
      const response = await client.executeDebugTool(sessionId, input)
      if (response.sessionId !== sessionId || response.result?.tool_name !== input.toolName
        || typeof response.result.success !== 'boolean') throw new Error('Invalid tool execution response')
      setExecution({ status: 'complete', input, response })
    } catch (error) {
      setExecution({ status: 'error', input, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (pending.current === request) pending.current = null
    }
  }
  // Executions survive inspector navigation; the draft scope rejects late Session updates.
  return { execution, execute, available: Boolean(sessionId && client) }
}
