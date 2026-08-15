/**
 * Tier1 W2 — re-fetch the schedule snapshot whenever any session's turn completes.
 *
 * The daemon broadcasts `session.completed` for EVERY session (chat AND scheduled
 * runs) on the always-subscribed `system` topic; the reducer folds it into
 * `sessionCompletionSeqAtom` (a payload-free tick). A resumed scheduled run
 * finishing there means its `needs_action` dropped server-side — but the bell
 * badge (`pendingApprovalCountAtom`) and run-history rows read a REST snapshot
 * that nobody refetched. This hook closes that loop authoritatively.
 *
 * Invariants:
 *  - Only ever RE-FETCHES the authoritative snapshot (`hydrateSchedulesAtom`);
 *    never locally mutates `needs_action`. Missed/late ticks can't corrupt state.
 *  - Gated by `shouldRefreshSchedulesOnCompletion` — only when a schedule is
 *    pending/running could a completion have changed it, so ordinary chat-turn
 *    completions don't trigger a `listSchedules`.
 *  - Debounced to coalesce completion bursts. `schedules`/`detailId` are read
 *    from the latest closure (deps list only the `seq` trigger, per
 *    useDebouncedEffect's contract).
 *
 * Mount once, in the always-mounted SidebarContainer (where the bell lives).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useDebouncedEffect } from './useDebouncedEffect'
import { sessionCompletionSeqAtom } from '@/atoms/sessions'
import {
  hydrateSchedulesAtom,
  openScheduleDetailAtom,
  scheduleDetailIdAtom,
  schedulesAtom,
} from '@/atoms/schedules'
import { shouldRefreshSchedulesOnCompletion } from '@/lib/schedule'

/** Re-fetch schedules on session completion when a schedule might be affected. */
export function useScheduleRefreshOnCompletion(): void {
  const seq = useAtomValue(sessionCompletionSeqAtom)
  const schedules = useAtomValue(schedulesAtom)
  const detailId = useAtomValue(scheduleDetailIdAtom)
  const hydrate = useSetAtom(hydrateSchedulesAtom)
  const refetchDetail = useSetAtom(openScheduleDetailAtom)
  useDebouncedEffect(
    () => {
      if (!shouldRefreshSchedulesOnCompletion(schedules)) return
      void hydrate()
      if (detailId) void refetchDetail(detailId)
    },
    [seq],
    500,
  )
}
