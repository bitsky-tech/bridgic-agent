/**
 * Wiring container for LeftSidebar — the SessionMeta → SessionItem transform + all callbacks.
 *
 * LeftSidebar (components/amphi) stays purely presentational; all atom reads/writes and the
 * "clicking a session / creating a new session must switch back to the Home nav" business sequences are collected here.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  activeNavAtom,
  ModalKind,
  openModalAtom,
  selectNavAtom,
  viewedSessionIdAtom,
} from '@/atoms/amphi'
import {
  activeSessionIdAtom,
  newSessionAtom,
  renameSessionAtom,
  selectSessionAtom,
  setPendingComposerFocusAtom,
  sidebarSessionsAtom,
} from '@/atoms/sessions'
import {
  openScheduleOverlayAtom,
  pendingApprovalCountAtom,
  closeScheduleDetailAtom,
  ScheduleOverlayKind,
} from '@/atoms/schedules'
import { LeftSidebar, NavKey } from '@/components/amphi/LeftSidebar'
import type { SessionItem } from '@/components/amphi/LeftSidebar'
import type { AgentStatusIndicatorSpec } from '@/components/amphi/AgentStatusIndicator'
import { SettingsTabId } from '@/components/amphi/Modals'
import {
  SubagentLifecycle,
  subagentsAtom,
  type SubagentState,
} from '@/atoms/subagents'
import { useScheduleRefreshOnCompletion } from '@/hooks/useScheduleRefreshOnCompletion'
import { runningSessionIdsAtom } from '@/atoms/agent'
import { openIssueReportAtom } from '@/atoms/issue-report'

/** Left column session list + navigation. Mounted in AppLayout's left slot. */
export function SidebarContainer() {
  const { t } = useTranslation()
  // Tier1 W2: always mounted — when a resumed scheduled run finishes (session.completed), re-fetch the schedule snapshot so the
  // bell badge / run-record status drop back from the backend's needs_action to zero. The bell lives in this container's LeftSidebar.
  useScheduleRefreshOnCompletion()
  const activeNav = useAtomValue(activeNavAtom)
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  // For unread semantics only — null when not on the Home nav, see viewedSessionIdAtom. Selection highlighting still uses
  // activeSessionId; the two are not interchangeable.
  const viewedSessionId = useAtomValue(viewedSessionIdAtom)
  const sidebarSessions = useAtomValue(sidebarSessionsAtom)
  const subagents = useAtomValue(subagentsAtom)
  const runningSessionIds = useAtomValue(runningSessionIdsAtom)
  const selectNav = useSetAtom(selectNavAtom)
  const selectSession = useSetAtom(selectSessionAtom)
  const renameSession = useSetAtom(renameSessionAtom)
  const newSession = useSetAtom(newSessionAtom)
  const openModal = useSetAtom(openModalAtom)
  const requestComposerFocus = useSetAtom(setPendingComposerFocusAtom)
  const pendingCount = useAtomValue(pendingApprovalCountAtom)
  const openScheduleOverlay = useSetAtom(openScheduleOverlayAtom)
  const closeScheduleDetail = useSetAtom(closeScheduleDetailAtom)
  const openIssueReport = useSetAtom(openIssueReportAtom)

  // SessionMeta → SessionItem shape adapter for the LeftSidebar.
  // `stage` here is the human-readable stageLabel from agent events.
  const backgroundChildrenByParent = new Map<string, (typeof sidebarSessions)[number][]>()
  for (const session of sidebarSessions) {
    if (!session.parentSessionId || session.subagentMode !== 'background') continue
    const backgroundChildren = backgroundChildrenByParent.get(session.parentSessionId) ?? []
    backgroundChildren.push(session)
    backgroundChildrenByParent.set(session.parentSessionId, backgroundChildren)
  }

  const liveChildrenByParent = new Map<string, SubagentState[]>()
  for (const child of subagents.values()) {
    if (!child.parentSessionId) continue
    const children = liveChildrenByParent.get(child.parentSessionId) ?? []
    children.push(child)
    liveChildrenByParent.set(child.parentSessionId, children)
  }

  const lifecycleForSession = (
    session: (typeof sidebarSessions)[number],
  ): SubagentLifecycle => SubagentLifecycle.fromSources({
    liveStatus: subagents.get(session.id)?.status,
    isExecuting: !!session.isRunning || runningSessionIds.has(session.id),
    turnStatus: session.turnStatus,
  })

  const ownStatusIndicator = (
    lifecycle: SubagentLifecycle,
  ): AgentStatusIndicatorSpec | undefined => {
    if (lifecycle.kind === 'queued') {
      return { indicator: 'queued', label: t('run.agentStatus.queued') }
    }
    if (lifecycle.kind === 'failed') {
      return { indicator: 'failed', label: t('run.agentStatus.failed') }
    }
    if (lifecycle.kind === 'stopped') {
      return { indicator: 'stopped', label: t('run.agentStatus.stopped') }
    }
    return undefined
  }

  const childStatusIndicator = (
    lifecycle: SubagentLifecycle,
  ): AgentStatusIndicatorSpec | undefined => {
    if (lifecycle.indicator === 'none') return undefined
    const labels: Record<SubagentLifecycle['kind'], string> = {
      queued: t('run.childStatus.queued'),
      running: t('run.childStatus.running'),
      awaiting_subagents: t('run.childStatus.awaitingSubagents'),
      awaiting_human: t('run.childStatus.awaitingHuman'),
      awaiting_permission: t('run.childStatus.awaitingPermission'),
      completed: t('run.childStatus.completed'),
      stopped: t('run.childStatus.stopped'),
      failed: t('run.childStatus.failed'),
      unknown: t('run.childStatus.unknown'),
    }
    return {
      indicator: lifecycle.indicator,
      label: labels[lifecycle.kind],
    }
  }

  const highestPriorityStatus = (
    candidates: AgentStatusIndicatorSpec[],
  ): AgentStatusIndicatorSpec | undefined => {
    const priority: Record<AgentStatusIndicatorSpec['indicator'], number> = {
      attention: 60,
      failed: 50,
      spinner: 40,
      queued: 30,
      completed: 20,
      stopped: 10,
    }
    return candidates.reduce<AgentStatusIndicatorSpec | undefined>(
      (current, candidate) =>
        !current || priority[candidate.indicator] > priority[current.indicator]
          ? candidate
          : current,
      undefined,
    )
  }

  const pickBackgroundChildStatus = (
    session: (typeof sidebarSessions)[number],
  ): AgentStatusIndicatorSpec | undefined => {
    const candidates: AgentStatusIndicatorSpec[] = []
    const durableChildren = backgroundChildrenByParent.get(session.id) ?? []
    const durableIds = new Set(durableChildren.map((child) => child.id))
    for (const child of durableChildren) {
      const lifecycle = lifecycleForSession(child)
      if (
        lifecycle.kind === 'completed' ||
        (lifecycle.kind === 'unknown' && child.hasRedDot)
      ) {
        if (child.hasRedDot && child.id !== viewedSessionId) {
          candidates.push({
            indicator: 'completed',
            label: t('run.childStatus.completed'),
          })
        }
        continue
      }
      const indicator = childStatusIndicator(lifecycle)
      if (indicator) candidates.push(indicator)
    }
    for (const child of liveChildrenByParent.get(session.id) ?? []) {
      if (child.mode !== 'background' || durableIds.has(child.invocationId)) continue
      const lifecycle = SubagentLifecycle.from(child.status)
      const indicator = childStatusIndicator(lifecycle)
      if (indicator) candidates.push(indicator)
    }
    return highestPriorityStatus(candidates)
  }

  const pickForegroundChildStatus = (
    session: (typeof sidebarSessions)[number],
  ): AgentStatusIndicatorSpec | undefined => {
    const candidates: AgentStatusIndicatorSpec[] = []
    for (const child of liveChildrenByParent.get(session.id) ?? []) {
      if (child.mode === 'background') continue
      const lifecycle = SubagentLifecycle.from(child.status)
      if (!lifecycle.isActive) continue
      const indicator = childStatusIndicator(lifecycle)
      if (indicator) candidates.push(indicator)
    }
    return highestPriorityStatus(candidates)
  }

  const toItem = (session: (typeof sidebarSessions)[number]): SessionItem => {
    const children = (backgroundChildrenByParent.get(session.id) ?? []).map(toItem)
    const isBackgroundChild = session.subagentMode === 'background'
    const childLifecycle = isBackgroundChild
      ? lifecycleForSession(session)
      : SubagentLifecycle.from()
    const isRunning = isBackgroundChild
      ? childLifecycle.isRunning && childLifecycle.kind !== 'queued'
      : !!session.isRunning || runningSessionIds.has(session.id)
    const hasPendingInteraction = isBackgroundChild
      ? childLifecycle.needsUserAction
      : !!session.hasPendingInteraction
    const interactionLifecycle = isBackgroundChild
      ? childLifecycle
      : SubagentLifecycle.from(session.turnStatus)
    const showUnread =
      !isBackgroundChild ||
      childLifecycle.kind === 'completed' ||
      childLifecycle.kind === 'unknown'
    return {
      id: session.id,
      title: session.title,
      stage: session.stageLabel,
      hasRedDot: showUnread && session.hasRedDot && session.id !== viewedSessionId,
      hasPendingInteraction:
        hasPendingInteraction &&
        !isRunning,
      pendingInteractionLabel: interactionLifecycle.needsUserAction
        ? interactionLifecycle.label
        : undefined,
      isRunning,
      statusIndicator: isBackgroundChild ? ownStatusIndicator(childLifecycle) : undefined,
      foregroundChildStatusIndicator: pickForegroundChildStatus(session),
      backgroundChildStatusIndicator: pickBackgroundChildStatus(session),
      children: children.length > 0 ? children : undefined,
    }
  }
  const sidebarItems = sidebarSessions
    .filter((session) => !session.parentSessionId)
    .map(toItem)

  return (
    <LeftSidebar
      sessions={sidebarItems}
      activeSessionId={activeSessionId}
      activeNav={activeNav}
      pendingCount={pendingCount}
      onBell={() => openScheduleOverlay({ kind: ScheduleOverlayKind.ApprovalCenter })}
      onFeedback={() => openIssueReport({ source: 'renderer' })}
      onNewSession={() => {
        // Switch back to the home view — otherwise, while on the workflows / assets nav, clicking new session would only create a draft
        // while the center content stayed on the workflow list / assets view, giving no visual feedback.
        selectNav(NavKey.Home)
        closeScheduleDetail() // leave any schedule detail we may have been sitting on
        newSession()
        requestComposerFocus(true) // the user deliberately created one → focus the input box after switching
      }}
      onSelectNav={(nav) => {
        // Clear the schedule detail when switching nav: going back to "schedules" shows the list rather than the detail last visited (matching the design mock's goNav).
        closeScheduleDetail()
        selectNav(nav)
      }}
      onSelectSession={(id) => {
        // Same as onNewSession: clicking a session item switches back to the home nav, otherwise a user selecting
        // a session from the workflows/assets view would not see the conversation area and it would feel like the click did nothing.
        selectNav(NavKey.Home)
        closeScheduleDetail()
        selectSession(id)
        requestComposerFocus(true) // the user deliberately switched sessions → focus the input box after switching
      }}
      onRenameSession={(id, title) => renameSession({ id, title })}
      onDeleteSession={(id) =>
        openModal({
          type: ModalKind.SessionDelete,
          id,
          name: sidebarItems.find((s) => s.id === id)?.title,
        })
      }
      onOpenSettings={(initialTab) =>
        openModal({ type: ModalKind.Settings, initialTab: initialTab ?? SettingsTabId.Model })
      }
    />
  )
}
