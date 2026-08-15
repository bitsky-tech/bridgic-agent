/**
 * Subscribe to the main-process agent + window-close streams.
 * Callbacks are cheap; the heavy lifting lives in the atom reducers.
 *
 * NOTE: live chat does NOT flow through this onAgentEvent IPC bridge — it
 * streams from the Python daemon over WebSocket (the persistent connection in
 * lib/amphi-ws-connection.ts), writing applyAgentEventAtom directly.
 */
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { applyAgentEventAtom } from '@/atoms/agent'
import { handleWindowCloseAtom } from '@/atoms/window-close'

export function useMainProcessEvents(): void {
  const applyAgentEvent = useSetAtom(applyAgentEventAtom)
  const handleWindowClose = useSetAtom(handleWindowCloseAtom)
  useEffect(() => {
    const unsubAgent = window.api.events.onAgentEvent((payload) => {
      applyAgentEvent(payload)
    })
    const unsubClose = window.api.events.onWindowCloseRequested(() => {
      handleWindowClose()
    })
    return () => {
      unsubAgent()
      unsubClose()
    }
  }, [applyAgentEvent, handleWindowClose])
}
