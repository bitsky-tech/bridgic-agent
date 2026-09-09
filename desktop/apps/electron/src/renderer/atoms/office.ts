import { atom } from 'jotai'
import { projectOfficeSurfaceStatuses } from '@/lib/office/officeSurfaceStatus'
import { currentPowerPointAgentActiveAtom } from './agent'
import { activeExcelHostSessionAtom } from './excel'
import { viewedSessionIdAtom } from './navigation'
import { activeEmbeddedPowerPointSessionAtom } from './powerpoint'
import { powerPointNeedsAttentionFamily } from './powerpoint-attention'
import { activeWordHostSessionAtom } from './word'

/** The shell consumes one read-only Office contract; document owners remain in their editors. */
export const currentOfficeSurfaceStatusesAtom = atom((get) => {
  const sessionId = get(viewedSessionIdAtom)
  return projectOfficeSurfaceStatuses({
    sessionId,
    powerPointSession: get(activeEmbeddedPowerPointSessionAtom),
    excelSession: get(activeExcelHostSessionAtom),
    wordSession: get(activeWordHostSessionAtom),
    powerPointAgentActive: get(currentPowerPointAgentActiveAtom),
    powerPointNeedsAttention: sessionId !== null && get(powerPointNeedsAttentionFamily(sessionId)),
  })
})
