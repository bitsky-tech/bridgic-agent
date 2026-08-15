/** Start each explicit new-conversation entry with rail-only workbench navigation. */
import { useLayoutEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { setRightPanelCollapsedAtom } from '@/atoms/layout'
import {
  activeIsDraftAtom,
  newSessionActivationSeqAtom,
} from '@/atoms/sessions'

export function useCollapseNewSessionWorkbench(): void {
  const activeIsDraft = useAtomValue(activeIsDraftAtom)
  const activationSeq = useAtomValue(newSessionActivationSeqAtom)
  const setRightCollapsed = useSetAtom(setRightPanelCollapsedAtom)

  useLayoutEffect(() => {
    if (!activeIsDraft || activationSeq === 0) return
    setRightCollapsed(true)
  }, [activationSeq, activeIsDraft, setRightCollapsed])
}
