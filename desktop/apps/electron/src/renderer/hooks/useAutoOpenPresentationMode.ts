/** Auto-open the Agent-owned pane once whenever a Session enters presentation mode. */
import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { currentThinkingModeAtom } from '@/atoms/agent'
import { openSessionModeSurfaceAtom } from '@/atoms/session-focus-pane-view'
import { activeSessionIdAtom } from '@/atoms/sessions'

export function useAutoOpenPresentationMode(): void {
  const sessionId = useAtomValue(activeSessionIdAtom)
  const position = useAtomValue(currentThinkingModeAtom)
  const openModeSurface = useSetAtom(openSessionModeSurfaceAtom)
  const previousModes = useRef(new Map<string, string | null>())

  useEffect(() => {
    if (!sessionId) return
    const previousMode = previousModes.current.get(sessionId) ?? null
    const nextMode = position?.mode ?? null
    previousModes.current.set(sessionId, nextMode)
    if (nextMode === 'presentation' && previousMode !== 'presentation') {
      openModeSurface()
    }
  }, [openModeSurface, position?.mode, sessionId])
}
