/**
 * Run detail drawer — slides out from the right, rendering one scheduled run as a session message timeline.
 *
 * The key point: **rendering** reuses the chat stack (`MessageBubble`, the same renderer as
 * Pipeline), but the **interaction** belongs to schedules — it never navigates to Home. While
 * AWAITING, answers are given inline inside the drawer: permission blocks render inline with the
 * messages (`MessageBubble` carries that run's sessionId → the permission card points at the right
 * session), and choose/feedback kinds go through `HumanRequestChoice` at the bottom. The scheduled
 * run itself is **read-only** (no composer); "continue the conversation / fix it for me" starts a
 * new ordinary session carrying the context (schedule-session.ts).
 *
 * Messages / streaming / pending for a non-active session come from families keyed by session (as in
 * SubagentModal); the view only makes sure the active Session has subscribed and loaded its messages,
 * and unmounting does not tear down the underlying stream.
 */
import { ModalBackdrop } from '@/components/amphi/ModalBackdrop'
import { useCallback, useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useDebouncedEffect } from '@/hooks/useDebouncedEffect'
import {
  childrenFamily,
  hydratedSessionIdsAtom,
  loadSessionMessagesAtom,
  messageFamily,
  streamingFamily,
} from '@/atoms/agent'
import { pendingBySessionAtom } from '@/atoms/human-request'
import { SubagentLifecycle } from '@/atoms/subagents'
import { RunStatus, type ScheduleRun } from '@/lib/schedule'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { Btn, Icons, Tooltip } from '@/components/amphi'
import { MessageBubble } from '@/components/amphi/Pipeline'
import { HumanRequestChoice } from '@/components/human-request/HumanRequestBanner'
import { PermissionApproval } from '@/components/permissions'
import {
  closeScheduleOverlayAtom,
  hydrateSchedulesAtom,
  stopScheduleRunAtom,
  openScheduleDetailAtom,
  scheduleDetailIdAtom,
  schedulesAtom,
} from '@/atoms/schedules'
import { continueFromRunAtom } from '@/atoms/schedule-session'
import { RunAgentLayerNav } from './RunAgentLayerNav'
import { runLogDrawerWidthAtom, setRunLogDrawerWidthAtom } from '@/atoms/layout'

function statusMeta(status: RunStatus, t: ReturnType<typeof useTranslation>['t']) {
  const labels: Record<RunStatus, string> = {
    [RunStatus.Success]: t('schedule.run.status.success'),
    [RunStatus.Failed]: t('schedule.run.status.failed'),
    [RunStatus.Finished]: t('schedule.run.status.finished'),
    [RunStatus.NeedsAction]: t('schedule.run.status.needsAction'),
    [RunStatus.Running]: t('schedule.run.status.running'),
  }
  const colors: Record<RunStatus, { text: string; bg: string }> = {
    [RunStatus.Success]: { text: 'text-status-success', bg: 'bg-status-success-bg' },
    [RunStatus.Failed]: { text: 'text-status-error', bg: 'bg-status-error-bg' },
    [RunStatus.Finished]: { text: 'text-text-secondary', bg: 'bg-bg-hover' },
    [RunStatus.NeedsAction]: { text: 'text-status-warning', bg: 'bg-status-warning-bg' },
    [RunStatus.Running]: { text: 'text-status-info', bg: 'bg-status-info-bg' },
  }
  return { label: labels[status], ...colors[status] }
}

/** Keep the header status live (§1.24 value mapping via a helper, avoiding a nested ternary): after
 *  answering HITL inline in the drawer, `run.status` is still the static snapshot from when it was
 *  opened, so recompute from whether anything is still pending (a pending choose/feedback or an
 *  undecided permission block) — still pending → needs action; previously needing action but now
 *  answered → finished; otherwise fall back to the snapshot. */
function deriveRunStatus(awaiting: boolean, snapshot: RunStatus): RunStatus {
  if (awaiting) return RunStatus.NeedsAction
  if (snapshot === RunStatus.NeedsAction) return RunStatus.Finished
  return snapshot
}

/** Empty-state text for the right column (§1.24 value mapping via a helper, avoiding a nested
 *  ternary): not hydrated = loading; the main agent and a sub-agent word "no records" differently. */
function emptyRunText(t: ReturnType<typeof useTranslation>['t'], hydrated: boolean, isMainView: boolean): string {
  if (!hydrated) return t('schedule.run.loadingMessages')
  return isMainView ? t('schedule.run.emptyMain') : t('schedule.run.emptySubagent')
}

/** One metadata cell in the drawer header (label + value). Overly long values (a session ID, say) are truncated, with the full text on hover (§1.25 Tooltip). */
function RunMeta({ label, value, accent, mono }: { label: string; value: string; accent?: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs text-text-tertiary mb-0.5">{label}</div>
      <Tooltip content={value} onlyWhenTruncated>
        <div className={cn('text-sm font-semibold truncate', accent ?? 'text-text-primary', mono && 'font-mono')}>
          {value}
        </div>
      </Tooltip>
    </div>
  )
}

export interface RunLogDrawerProps {
  scheduleId: string
  /** The run to display (= one scheduled Session); its sessionId is the key for messages / HITL. */
  run: ScheduleRun
}

/** Detail drawer for a single run: slides out from the right, reusing the session message rendering + inline HITL answers. */
export function RunLogDrawer({ scheduleId, run }: RunLogDrawerProps) {
  const { t } = useTranslation()
  const close = useSetAtom(closeScheduleOverlayAtom)
  const loadMessages = useSetAtom(loadSessionMessagesAtom)
  const continueRun = useSetAtom(continueFromRunAtom)
  // The drawer only shows this one run, so "stop" is run-scoped (it does not touch other in-flight runs of the same schedule).
  const stopRun = useSetAtom(stopScheduleRunAtom)
  const hydrateSchedules = useSetAtom(hydrateSchedulesAtom)
  const refetchDetail = useSetAtom(openScheduleDetailAtom)
  const detailId = useAtomValue(scheduleDetailIdAtom)
  const schedule = useAtomValue(schedulesAtom).find((s) => s.id === scheduleId)
  const messages = useAtomValue(messageFamily(run.sessionId))
  const streaming = useAtomValue(streamingFamily(run.sessionId))
  const pending = useAtomValue(pendingBySessionAtom).get(run.sessionId)
  // The right column can switch to a sub-agent: viewSessionId defaults to the main run, and clicking a
  // sub-agent in the left column switches to its session id. The main run's messages/streaming/pending
  // stay reserved for the header status + schedule refetch (run level); the right column renders from
  // view* (viewSessionId level), and the two are equal while looking at the main agent. The sub-agent
  // list is always aggregated from the main run's messages (the transcript projects sub-agents onto the
  // main run).
  const [viewSessionId, setViewSessionId] = useState(run.sessionId)
  const isMainView = viewSessionId === run.sessionId
  const subagents = useAtomValue(childrenFamily(run.sessionId))
  const viewSubagent = subagents.find((child) => child.sessionId === viewSessionId)
  const viewSubagentActive = viewSubagent
    ? SubagentLifecycle.from(viewSubagent.status).isActive
    : false
  const viewMessages = useAtomValue(messageFamily(viewSessionId))
  const viewStreaming = useAtomValue(streamingFamily(viewSessionId))
  // Width is draggable (handle on the left edge), matching the prototype's 560–1240 range. Dynamic value → inline style per §1.22.
  const persistedWidth = useAtomValue(runLogDrawerWidthAtom)
  const persistWidth = useSetAtom(setRunLogDrawerWidthAtom)
  const [width, setWidth] = useState(persistedWidth)
  useEscapeToClose(close)

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 600
    let latest = startW
    const move = (ev: MouseEvent) => {
      latest = Math.min(1240, Math.max(480, startW + (startX - ev.clientX)))
      setWidth(latest)
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      persistWidth(latest)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }, [persistWidth])

  // Load that run session's messages and make sure the Session controller holds its WS topic.
  // Unmounting the drawer only closes the view; only an explicit Session cleanup releases the underlying subscription.
  useEffect(() => {
    let cancelled = false
    void import('@/lib/amphiWsConnection').then((m) => {
      if (cancelled) return
      m.getAmphiWsConnection().subscribe(run.sessionId)
    })
    void loadMessages(run.sessionId)
    return () => {
      cancelled = true
    }
  }, [run.sessionId, loadMessages])

  // When switching to a sub-agent, make sure the controller holds its topic; switching away does not tear the stream down.
  useEffect(() => {
    if (viewSessionId === run.sessionId) return
    let cancelled = false
    if (viewSubagentActive) {
      void import('@/lib/amphiWsConnection').then((m) => {
        if (!cancelled) m.getAmphiWsConnection().subscribe(viewSessionId)
      })
    }
    void loadMessages(viewSessionId)
    return () => {
      cancelled = true
    }
  }, [viewSessionId, viewSubagentActive, run.sessionId, loadMessages])

  const name = schedule?.name ?? t('schedule.run.defaultName')
  const hydrated = useAtomValue(hydratedSessionIdsAtom).has(viewSessionId)
  // Undecided permission blocks do not go into pendingBySessionAtom, so they are counted as live
  // alongside choose/feedback pendings. We take the block itself rather than just a boolean: this
  // drawer must **render the approval card itself** — ProcessTimeline `return null`s on undecided
  // permission blocks (after the redesign they are all handed to the overlay), and the overlay only
  // mounts on CenterView and reads activeSessionId; a scheduled task's viewSessionId is a different
  // thing entirely, so the overlay would never light up for it. Without rendering it, the drawer header
  // would say "needs action" while the user opens it and finds no buttons at all, and the run would sit
  // in AWAITING forever.
  const pendingPermissionBlock = [...messages, ...(streaming ? [streaming] : [])]
    .flatMap((m) => m.blocks ?? [])
    .findLast((b) => b.type === 'permission' && !b.decided)
  const awaiting = pending !== undefined || pendingPermissionBlock !== undefined
  const status = deriveRunStatus(awaiting, run.status)

  // Tier1 W1: refetch the schedule snapshot after an inline answer so the bell badge + run history rows
  // pick up needs_action from the backend — deriveRunStatus in the drawer header self-heals locally,
  // but the list / detail read the REST snapshot and would otherwise stay stuck on "needs action".
  // Trigger: fire whenever the debounced `awaiting` settles to false (after an answer, true→false always
  // hits; opening the drawer on an already-finished run just costs one extra idempotent listSchedules,
  // which is harmless). The ~800ms debounce waits for the daemon to finish processing the answer and
  // leave AWAITING before fetching, dodging the race (the optimistic flip is instant, the backend is a
  // little slower). It only refetches and never rewrites needsAction locally.
  // No "previous value" guard: useDebouncedEffect cancels the pending fire whenever deps change, so a
  // fast answer would fail to record the previous value → missed refresh; checking the settled value
  // directly is the most robust.
  useDebouncedEffect(
    () => {
      if (awaiting) return
      void hydrateSchedules()
      if (detailId === scheduleId) void refetchDetail(scheduleId)
    },
    [awaiting],
    800,
  )
  // Running: the backend marks it running, or a stream is actively pushing → the header offers "stop".
  // While running, if no user message has been persisted yet, synthesize one from that run's goal
  // (= schedule.desc) and prepend it (#2/#3).
  const isRunning = run.status === RunStatus.Running || streaming !== undefined
  const canContinue = run.status === RunStatus.Finished && run.canContinue && !awaiting && !isRunning
  const hasUserMessage = messages.some((m) => m.role === 'user')
  const meta = statusMeta(status, t)

  return (
    // app-no-drag: the drawer is flush with the top, and its top overlaps AppLayout's `app-drag` window
    // drag strip; -webkit-app-region: drag is not automatically punched through by elements above it, so
    // without an explicit no-drag the top buttons (fix it for me / continue the conversation / ×) and
    // backdrop clicks get swallowed into window dragging → they become unclickable.
    // justify-end pins the panel to the right; the backdrop is one shade darker than a modal's, which is
    // the drawer's own design.
    // onClose: dismissing by clicking the dim area was never wired when this drawer moved onto
    // ModalBackdrop (it had no such behaviour before either), so Escape was the only way out.
    // ModalBackdrop only fires it when the press *and* the release both land on the dim area, so
    // dragging the left-edge width handle out over the backdrop does not close the drawer.
    <ModalBackdrop
      className="app-no-drag justify-end"
      backdropClassName="bg-[rgba(6,8,14,0.62)]"
      onClose={close}
    >
      <div
        className="relative h-full flex flex-col bg-bg-app border-l border-border-default shadow-modal"
        style={{ width }}
      >
        {/* Left-edge width drag handle (§1.25 bans native title, so there is no hint here) */}
        <div onMouseDown={startResize} className="absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize z-10" />
        {/* header */}
        {/* It no longer absorbs --titlebar-win-inset itself to dodge the caption buttons horizontally:
            ModalBackdrop already pushes the whole overlay container below the caption's lower edge (see
            invariant 2 in that file), so the drawer no longer shares a row with the system's three buttons.
            That earlier horizontal yielding treated the symptom, not the cause — the buttons were clickable,
            but visually they still crowded into one line with the system − □ ×, and two adjacent × marks make
            it very easy to close the window by mistake. */}
        <div className="px-[22px] py-[18px] border-b border-border-subtle flex-shrink-0 bg-bg-surface">
          <div className="flex items-center gap-2.5">
            <div className="text-lg font-bold text-text-primary">{t('schedule.run.title')}</div>
            <span className={cn('px-2.5 py-0.5 rounded-full text-xs font-semibold', meta.text, meta.bg)}>
              {meta.label}
            </span>
            <span className="flex-1" />
            {isRunning && (
              <Btn
                variant="default"
                size="sm"
                className="text-status-error border-status-error"
                onClick={() => stopRun(run.sessionId)}
              >
                {Icons.stop(12)} {t('common.stop')}
              </Btn>
            )}
            {canContinue && (
              <Btn variant="default" size="sm" onClick={() => continueRun(run.sessionId)}>
                {Icons.chat(12)} {t('schedule.run.continueConversation')}
              </Btn>
            )}
            <button
              type="button"
              onClick={() => close()}
              className="w-[30px] h-[30px] rounded-md flex items-center justify-center text-text-tertiary cursor-pointer hover:bg-bg-hover"
            >
              {Icons.x(16)}
            </button>
          </div>
          <div className="text-sm text-text-secondary mt-1">{name}</div>
          <div className="grid grid-cols-3 gap-3 mt-3.5">
            <RunMeta label={t('schedule.run.time')} value={run.time} mono />
            <RunMeta label={t('schedule.run.trigger')} value={t('schedule.run.scheduledTrigger')} accent="text-text-accent" />
            <RunMeta label={t('schedule.run.sessionId')} value={viewSessionId} mono />
          </div>
        </div>

        {/* Body: with sub-agents, a "session hierarchy" left column + timeline right column; without sub-agents, a single column (unchanged) */}
        <div className="flex flex-1 min-h-0">
          {subagents.length > 0 && (
            <RunAgentLayerNav
              subagents={subagents}
              mainSessionId={run.sessionId}
              selectedSessionId={viewSessionId}
              onSelect={setViewSessionId}
            />
          )}
          <div className="flex flex-1 flex-col min-w-0">
            {/* Session message timeline (reusing the chat rendering), for the session currently being viewed (main or sub-agent) */}
            <div className="flex-1 overflow-auto px-[22px] py-5 flex flex-col gap-4">
              {/* Only when looking at the main agent and the user message has not been persisted yet, synthesize
                  one from that run's goal and prepend it; a sub-agent has its own user input (= goal), so nothing
                  is prepended (#3). */}
              {isMainView && !hasUserMessage && schedule?.desc && (
                <MessageBubble role="user" content={schedule.desc} type="text" />
              )}
              {viewMessages.map((m) => (
                <MessageBubble
                  key={m.id}
                  role={m.role === 'user' ? 'user' : 'ai'}
                  content={m.text}
                  messageId={m.id}
                  thinking={m.thinking}
                  toolCalls={m.toolCalls}
                  blocks={m.blocks}
                  error={m.error}
                  finalAnswer={m.finalAnswer}
                  sessionId={viewSessionId}
                />
              ))}
              {viewStreaming && (
                <MessageBubble role="ai" content={viewStreaming.content} blocks={viewStreaming.blocks} streaming sessionId={viewSessionId} />
              )}
              {!viewMessages.length && !viewStreaming && (
                <div className="flex-1 flex items-center justify-center text-sm text-text-tertiary">
                  {emptyRunText(t, hydrated, isMainView)}
                </div>
              )}
            </div>

            {/* Inline HITL at the bottom (choose / feedback kinds). pending belongs to the main run, so it is
                only shown while looking at the main agent and does not interrupt a sub-agent view. */}
            {isMainView && pending && (
              <div className="border-t border-border-subtle px-[22px] pt-3 pb-4 flex-shrink-0">
                <HumanRequestChoice request={pending} />
              </div>
            )}
            {/* Permission approval card: it must be rendered here and cannot rely on the overlay (which only
                lights up for activeSessionId). sessionId is passed explicitly as viewSessionId — the component
                would otherwise default to activeSessionIdAtom and send the answer to the wrong session from inside the drawer. */}
            {pendingPermissionBlock?.type === 'permission' && (
              <div className="border-t border-border-subtle px-[22px] pt-3 pb-4 flex-shrink-0">
                <PermissionApproval
                  items={pendingPermissionBlock.items}
                  questions={pendingPermissionBlock.questions}
                  requestId={pendingPermissionBlock.requestId}
                  sessionId={viewSessionId}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
