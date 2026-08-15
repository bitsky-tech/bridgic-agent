/**
 * Pull `/schedules` once the daemon reports Ready, and re-fire on
 * `unavailable → ready` transitions (a daemon restart re-syncs the list).
 *
 * Why here, not only in CenterSchedules: the approval bell + its badge
 * (`pendingApprovalCountAtom`) live in the always-mounted SidebarContainer and
 * read the schedule list. Without a boot-time hydrate the badge stays 0 until
 * the user first opens the Schedules center — so an unattended run parked
 * AWAITING would go unnoticed while the user is on the chat page.
 *
 * Gated on `state === Ready` because the AmphiClient depends on
 * `backendSnapshot.endpoint`, only set in that state (see atoms/backend.ts).
 * Real-time push (a run parking AWAITING mid-session) still needs a schedule WS
 * subscription — out of scope here; this covers boot + post-write refresh.
 */
import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { backendStateAtom } from '@/atoms/backend'
import { BackendState } from '../../main/python-client/types'
import { hydrateSchedulesAtom } from '@/atoms/schedules'

export function useScheduleHydration(): void {
  const backendState = useAtomValue(backendStateAtom)
  const hydrateSchedules = useSetAtom(hydrateSchedulesAtom)
  useEffect(() => {
    if (backendState !== BackendState.Ready) return
    void hydrateSchedules()
  }, [backendState, hydrateSchedules])
}
