/**
 * Approval center — a centered dialog opened by the bell in the bottom-left, collecting every scheduled task that needs your attention (needsAction>0).
 *
 * Reuses amphi's Modal. The data comes from pendingApprovalsAtom (schedules with needs_action>0).
 * "Handle it" goes straight to the detail drawer of the run that is suspended for that task (openApprovalRunAtom; it swaps the overlay from the approval
 * center to the run drawer), where it is answered inline without jumping to Home.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Btn, Icons, Modal } from '@/components/amphi'
import {
  closeScheduleOverlayAtom,
  openApprovalRunAtom,
  pendingApprovalsAtom,
} from '@/atoms/schedules'

/** Approval center dialog: collects the scheduled tasks that need attention; "handle it" goes straight to that run's drawer. */
export function ApprovalCenter() {
  const { t } = useTranslation()
  const items = useAtomValue(pendingApprovalsAtom)
  const close = useSetAtom(closeScheduleOverlayAtom)
  const openApprovalRun = useSetAtom(openApprovalRunAtom)

  // openApprovalRunAtom swaps _overlay from "approval center" to "run drawer" (falling back to opening that task's detail when
  // no suspended run is found), so there is no need to call close separately.
  const goProcess = (scheduleId: string) => void openApprovalRun(scheduleId)

  const header = (
    <div className="flex items-center gap-3 px-[22px] py-[18px] border-b border-border-subtle">
      <div className="w-10 h-10 rounded-md bg-status-warning-bg text-status-warning flex items-center justify-center flex-shrink-0">
        {Icons.bell(19)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-lg font-bold text-text-primary">{t('schedule.approval.title')}</div>
        <div className="text-xs text-text-secondary mt-0.5">
          {t('schedule.approval.subtitle')}
        </div>
      </div>
      <span className="text-xs font-semibold text-status-warning bg-status-warning-bg px-2 py-0.5 rounded-full flex-shrink-0">
        {t('schedule.approval.pendingCount', { n: items.length })}
      </span>
      <button
        type="button"
        onClick={() => close()}
        className="w-[30px] h-[30px] rounded-md flex items-center justify-center text-text-tertiary cursor-pointer hover:bg-bg-hover flex-shrink-0"
      >
        {Icons.x(16)}
      </button>
    </div>
  )

  return (
    <Modal width={560} onClose={() => close()} customHeader={header}>
      <div className="flex-1 overflow-auto px-[22px] py-4">
        {items.length === 0 ? (
          <div className="py-10 text-center text-sm text-text-tertiary">{t('schedule.approval.empty')}</div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {items.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 px-[15px] py-3 rounded-md bg-bg-elevated border border-border-subtle"
              >
                <span className="text-status-warning flex flex-shrink-0">{Icons.alert(15)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text-primary">{s.name}</div>
                  <div className="text-xs text-text-secondary mt-0.5 truncate">{s.desc}</div>
                </div>
                <span className="text-[10px] text-status-warning font-semibold flex-shrink-0">
                  {t('schedule.approval.itemCount', { n: s.needsAction ?? 0 })}
                </span>
                <Btn
                  variant="default"
                  size="sm"
                  className="text-status-warning border-status-warning flex-shrink-0"
                  onClick={() => goProcess(s.id)}
                >
                  {t('schedule.action.handle')}
                </Btn>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
