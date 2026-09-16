import { atom } from 'jotai'
import { projectOfficeSurfaceStatuses, type OfficeAppKind } from '@/lib/office/officeSurfaceStatus'
import { currentPowerPointAgentActiveAtom } from './agent'
import { activeExcelHostSessionAtom, excelExpandedAtom } from './excel'
import { viewedSessionIdAtom } from './navigation'
import { activeEmbeddedPowerPointSessionAtom } from './powerpoint'
import { powerPointNeedsAttentionFamily } from './powerpoint-attention'
import { activeWordHostSessionAtom } from './word'
import { presentationExpandedAtom } from './presentation'
import { closeSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface } from './workbench'

/** Close events update their owner's layout even while a different Session or page is shown. */
export const closeOfficeSurfaceAtom = atom(null, (_get, set, request: { sessionId: string; surface: OfficeAppKind }) => {
  if (request.surface === SessionWorkbenchSurface.Excel) set(excelExpandedAtom, false, request.sessionId)
  if (request.surface === SessionWorkbenchSurface.Presentation) set(presentationExpandedAtom, false, request.sessionId)
  set(closeSessionWorkbenchSurfaceAtom, request)
})

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
