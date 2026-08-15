/**
 * Schedule overlay host — reads scheduleOverlayAtom and renders the approval center / run detail drawer. Mounted at the App root
 * (alongside ActiveModalHost), so it can also show outside the schedule center view (e.g. clicking the bottom-left bell on any page, or
 * going straight from the approval center's "handle it" to a particular run's drawer).
 */
import { useAtomValue } from 'jotai'
import { scheduleOverlayAtom, ScheduleOverlayKind } from '@/atoms/schedules'
import { ApprovalCenter } from './ApprovalCenter'
import { RunLogDrawer } from './RunLogDrawer'

/** Read scheduleOverlayAtom and render the corresponding overlay; mounted at the App root. */
export function ScheduleOverlays() {
  const overlay = useAtomValue(scheduleOverlayAtom)
  if (!overlay) return null
  if (overlay.kind === ScheduleOverlayKind.RunLog) {
    return <RunLogDrawer scheduleId={overlay.scheduleId} run={overlay.run} />
  }
  return <ApprovalCenter />
}
