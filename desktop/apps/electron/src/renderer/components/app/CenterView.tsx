/**
 * Center-column view router — activeNav + session state decide which view is rendered.
 *
 * Routing priority: the Workflows / Skills / Assets nav entries go straight to their center view; under the
 * Home nav we switch between the Pipeline session view and Landing based on `hasConversationAtom`
 * (atoms/agent.ts, which encodes the "switching sessions must not flash back to Landing" semantics);
 * while the boot placement decision is still pending (`bootPendingAtom`) a blank placeholder is rendered,
 * so restoring a session on refresh does not flash Landing.
 *
 * This component only routes and wires things up; the views themselves (CenterWorkflows / CenterSkills /
 * CenterAssets / Pipeline / Landing) all come from components/amphi, unmodified.
 */
import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { hasConversationAtom } from '@/atoms/agent'
import { pendingCommentsAtom } from '@/atoms/build'
import { bootPendingAtom } from '@/atoms/sessions'
import { ComposerTarget, activeNavAtom, ModalKind, openModalAtom } from '@/atoms/amphi'
import { scheduleDetailIdAtom, schedulesAtom } from '@/atoms/schedules'
import { openScheduleSessionAtom } from '@/atoms/schedule-session'
import { runWorkflowAtom } from '@/atoms/workflow-session'
import { ScheduleTemplateMode } from '@/lib/scheduleTemplate'
import {
  deleteWorkflowAtom,
  exportWorkflowAtom,
  hydrateWorkflowsAtom,
  importWorkflowAtom,
  renameWorkflowAtom,
  workflowsAtom,
} from '@/atoms/workflows'
import { requestConfirmAtom } from '@/atoms/confirm'
import { localeAtom } from '@/atoms/locale'
import { refreshWorkflowMarketAtom, workflowMarketAtom } from '@/atoms/workflow-market'
import { NavKey } from '@/components/amphi/LeftSidebar'
import { SettingsTabId } from '@/components/amphi/Modals'
import {
  CenterAssets,
  CenterSkills,
  CenterWorkflows,
  Landing,
  Pipeline,
  type Workflow,
} from '@/components/amphi'
import { CenterSchedules, ScheduleDetail } from '@/components/schedules'
import { FrameworkInteractionOverlay } from '@/components/human-request'
import { ChatInputZone } from '@/components/composer'
import { CommentFeedbackPanel } from './CommentFeedbackPanel'
import { FocusModeHeader } from './FocusModeHeader'
import type { WorkflowSummary } from '@/lib/amphiClient'

/** Session view stacking Pipeline + composer vertically (Home nav with an existing conversation). */
function ConversationView() {
  const { t } = useTranslation()
  const hasPendingComments = useAtomValue(pendingCommentsAtom).length > 0
  return (
    // grid-cols-[minmax(0,1fr)]: a single-column grid defaults to `auto`, and an auto track's minimum is
    // **min-content** — a min-w-0 on the container cannot reach it. The stage rail in the header is shrink-0
    // (if it does not fit, the whole rail must degrade rather than deform), so the header's min-content widens
    // the entire column and pushes Pipeline's messages out of the visible area too. Only an explicit minimum of
    // 0 makes overflow-hidden actually take effect.
    <div className="grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] h-full min-w-0 overflow-hidden">
      <FocusModeHeader />
      <div className="row-start-2 min-w-0 min-h-0 overflow-hidden">
        <Pipeline />
      </div>
      {/* Composer area: 12px top + 24px horizontal + 16px bottom + top divider + one shade lighter background.
          Matches the padding/border/bg of center.jsx::InputBar in the design mock. pt-3 gives the composer
          breathing room from the messages above, and border-t provides visual layering.
          When comments are queued for sending, the bottom is swapped for the comment feedback panel (replacing
          the input box); otherwise it is the normal input area. */}
      <div className="relative z-30 row-start-3 min-w-0 pt-3 px-6 pb-4 border-t border-border-subtle bg-bg-surface">
        {hasPendingComments ? (
          <CommentFeedbackPanel />
        ) : (
          <>
            {/* The HITL floating panel is anchored above the composer; it does not participate in the Grid row height and does not push the message area. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-[calc(100%+12px)] z-50 flex justify-center px-6">
              <div className="pointer-events-auto w-[min(760px,100%)]">
                <FrameworkInteractionOverlay />
              </div>
            </div>
            <ChatInputZone />
            {/* Compliance notice: model output is not guaranteed to be accurate and the user must verify it. Permanently below the input box. */}
            <p className="mt-2 text-center text-xs text-text-tertiary">
              {t('centerView.aiNotice')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/** Center-column content: the nav → view router. Mounted in AppLayout's center slot. */
export function CenterView() {
  const { t } = useTranslation()
  const activeNav = useAtomValue(activeNavAtom)
  const hasConversation = useAtomValue(hasConversationAtom)
  const bootPending = useAtomValue(bootPendingAtom)
  const workflows = useAtomValue(workflowsAtom)
  const scheduleDetailId = useAtomValue(scheduleDetailIdAtom)
  const schedules = useAtomValue(schedulesAtom)
  const hydrateWorkflows = useSetAtom(hydrateWorkflowsAtom)
  const importWorkflow = useSetAtom(importWorkflowAtom)
  const exportWorkflow = useSetAtom(exportWorkflowAtom)
  const renameWorkflow = useSetAtom(renameWorkflowAtom)
  const deleteWorkflow = useSetAtom(deleteWorkflowAtom)
  const requestConfirm = useSetAtom(requestConfirmAtom)
  const openModal = useSetAtom(openModalAtom)
  const openScheduleSession = useSetAtom(openScheduleSessionAtom)
  const runWorkflow = useSetAtom(runWorkflowAtom)
  const marketCards = useAtomValue(workflowMarketAtom)
  const refreshMarket = useSetAtom(refreshWorkflowMarketAtom)
  const locale = useAtomValue(localeAtom)

  useEffect(() => {
    if (activeNav === NavKey.Workflows) void hydrateWorkflows()
  }, [activeNav, hydrateWorkflows])

  // Landing is a conditional return below, not a child that mounts and unmounts,
  // so this cannot key off a mount. `showingLanding` going false → true is what
  // "the user came back to the home page" looks like from here, and the refresh
  // atom decides on its own whether anything actually needs fetching.
  //
  // `locale.resolved` is in the deps so switching language re-fetches: the atom
  // treats a cache from another language as unusable.
  const showingLanding = activeNav === NavKey.Home && !hasConversation && !bootPending
  useEffect(() => {
    if (showingLanding) void refreshMarket(locale.resolved)
  }, [showingLanding, locale.resolved, refreshMarket])

  if (activeNav === NavKey.Workflows) {
    return (
      <CenterWorkflows
        workflows={workflows.map(toWorkflow)}
        onPickWorkflow={(workflow) => openModal({
          type: ModalKind.WorkflowDetail,
          workflowId: workflow.id,
          workflowName: workflow.name,
          composerTarget: ComposerTarget.NewSession,
        })}
        onRunWorkflow={(workflow) => runWorkflow({
          workflow,
          composerTarget: ComposerTarget.NewSession,
        })}
        onImportWorkflow={(file) => void importWorkflow(file)}
        onRenameWorkflow={({ id }, name) => renameWorkflow({ workflowId: id, name })}
        onExportWorkflow={({ id, name }) => void exportWorkflow({ workflowId: id, name })}
        onDeleteWorkflow={async ({ id, name }) => {
          const confirmed = await requestConfirm({
            title: t('centerView.deleteWorkflow.title'),
            message: t('centerView.deleteWorkflow.message', { name }),
            confirmLabel: t('centerView.deleteWorkflow.confirm'),
            danger: true,
          })
          if (confirmed) await deleteWorkflow({ workflowId: id, name })
        }}
        onScheduleWorkflow={(workflow) => openScheduleSession({ mode: ScheduleTemplateMode.Create, workflow })}
      />
    )
  }
  if (activeNav === NavKey.Skills) {
    return <CenterSkills />
  }
  if (activeNav === NavKey.Schedules) {
    // Detail or list, one of the two: a hit that still exists → detail; otherwise the list (deleting clears detailId, falling back to the list).
    const detail = scheduleDetailId ? schedules.find((s) => s.id === scheduleDetailId) : null
    return detail ? <ScheduleDetail s={detail} /> : <CenterSchedules />
  }
  if (activeNav === NavKey.Assets) {
    return <CenterAssets />
  }
  if (hasConversation) {
    return <ConversationView />
  }
  // The boot placement decision is not in yet (waiting for daemon Ready + on-disk truth) → render a blank placeholder.
  // Rendering Landing directly would make a refresh that restores a session "flash Landing → jump to the session".
  // When the daemon is Unavailable, bootPending releases automatically (see bootPendingAtom), so this never stays blank forever.
  if (bootPending) {
    return null
  }
  // Landing: hero + (the real ChatInputZone embedded in the center) + workflow market grid.
  // Landing's own visual fake input box (amphi/landing.tsx) is replaced by the real
  // ChatInputZone through the `inputSlot` prop, so the page never shows two input boxes
  // at once (the confusing combination of a fake visual input plus the real sticky input
  // at the bottom). Once the first message is sent, currentMessages becomes non-empty →
  // it switches to the Pipeline view naturally.
  return (
    <Landing
      onConfigureModel={() =>
        openModal({ type: ModalKind.Settings, initialTab: SettingsTabId.Model })
      }
      marketCards={marketCards}
      onPickMarket={(c) => openModal({ type: ModalKind.MarketPreview, workflow: c })}
      inputSlot={<ChatInputZone />}
    />
  )
}

function toWorkflow(w: WorkflowSummary): Workflow {
  return {
    id: w.id,
    name: w.name,
    desc: w.desc ?? undefined,
  }
}
