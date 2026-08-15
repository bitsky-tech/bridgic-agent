/**
 * State layer of the Scheduling feature —— **wired for real**: the data comes from the
 * daemon REST API, no longer an in-memory mock. The domain types +
 * backend mapping live in lib/schedule.ts.
 *
 * Reads: hydrateSchedulesAtom (on page mount + re-fetch after writes); the detail view
 * fills in runs via openScheduleDetailAtom.
 * Writes: pause / run-now / delete call the API and then re-fetch the list. Write
 * feedback goes through showToastAtom; delete confirmation goes through requestConfirmAtom.
 *
 * Run details = a drawer sliding out from the right (openRunDrawerAtom → RunLogDrawer):
 * it reuses the session message rendering, but its interaction is independent of chat
 * (it doesn't jump to Home); while AWAITING, the drawer answers inline; "continue the conversation / help me fix it"
 * ("continue the conversation / help me fix it") starts a new ordinary session carrying
 * the context (schedule-session.ts). The backend has no dashboard stats aggregation yet
 * (Phase 6).
 */
import { atom } from 'jotai'
import {
  detailToSchedule,
  getPendingRun,
  summaryToSchedule,
  type Schedule,
  type ScheduleRun,
} from '@/lib/schedule'
import { rlog } from '@/lib/logger'
import { fetchAllOffsetPages } from '@/lib/amphiClient'
import { i18n } from '@/lib/i18n'
import { buildAmphiClient } from './backend'
import { showToastAtom } from './toast'
import { requestConfirmAtom } from './confirm'

/* ─── List state ─── */

/** Primitive —— not exported directly; only a read atom + named write atoms are exposed. */
const _schedules = atom<Schedule[]>([])

/** Read —— the list of schedule tasks. */
export const schedulesAtom = atom((get) => get(_schedules))

/** Write —— fetch the schedule list (called on page mount + after every write operation). On failure it degrades to an empty list + a log.
 *  List summaries carry no runs; when re-fetching after a write (toggle/run-now/delete) we **keep the runs already loaded by the detail view**,
 *  otherwise the run history of the detail currently on screen would be overwritten by empty runs into "no run records yet"
 *  (it would vanish the moment you click pause/resume). */
export const hydrateSchedulesAtom = atom(null, async (get, set) => {
  const client = buildAmphiClient(get)
  if (!client) return
  try {
    const rows = await fetchAllOffsetPages((page) => client.listSchedules(page), (row) => row.id)
    const prevRuns = new Map(get(_schedules).map((s) => [s.id, s.runs]))
    set(
      _schedules,
      rows.map((r) => {
        const mapped = summaryToSchedule(r)
        const runs = prevRuns.get(r.id)
        return runs && runs.length ? { ...mapped, runs } : mapped
      }),
    )
  } catch (err: unknown) {
    rlog.warn('[schedules] hydrate failed', { err })
  }
})

const _detailId = atom<string | null>(null)

/** Read —— id of the task whose detail is currently open (null = show the list). */
export const scheduleDetailIdAtom = atom((get) => get(_detailId))

/** Write —— open a task's detail: switch the id + fetch the detail (filling in the runs history). */
export const openScheduleDetailAtom = atom(null, async (get, set, id: string) => {
  set(_detailId, id)
  const client = buildAmphiClient(get)
  if (!client) return
  try {
    const detail = detailToSchedule(await client.getSchedule(id))
    set(
      _schedules,
      get(_schedules).map((s) => (s.id === id ? detail : s)),
    )
  } catch (err: unknown) {
    rlog.warn('[schedules] detail hydrate failed', { id, err })
  }
})

/** Write —— close the detail and fall back to the list. */
export const closeScheduleDetailAtom = atom(null, (_get, set) => {
  set(_detailId, null)
})

/* ─── Pending-approval derivations ─── */

/** Read —— tasks that need action (needsAction>0). The approval center lists them from this;
 *  clicking "handle it" goes into the detail to see that pending run, then opens
 *  that session to answer in the conversation view (D10 + Phase 4). */
export const pendingApprovalsAtom = atom<Schedule[]>((get) =>
  get(_schedules).filter((s) => (s.needsAction ?? 0) > 0),
)

/** Read —— the pending count (the bell badge). Aggregated from needsAction in the list summaries, with no need to fetch each detail. */
export const pendingApprovalCountAtom = atom((get) =>
  get(_schedules).reduce((n, s) => n + (s.needsAction ?? 0), 0),
)

/* ─── Overlays: approval center / run-log drawer ─── */

/** Overlay kind: the pending-approval center (bell) / the run detail drawer (slides out from the right). */
export const ScheduleOverlayKind = {
  ApprovalCenter: 'approvalCenter',
  RunLog: 'runLog',
} as const
export type ScheduleOverlayKind = (typeof ScheduleOverlayKind)[keyof typeof ScheduleOverlayKind]

/** The current overlay: the pending-approval center (no args), or the detail drawer of a specific run (carrying scheduleId + run). */
export type ScheduleOverlay =
  | { kind: typeof ScheduleOverlayKind.ApprovalCenter }
  | { kind: typeof ScheduleOverlayKind.RunLog; scheduleId: string; run: ScheduleRun }

const _overlay = atom<ScheduleOverlay | null>(null)

/** Read —— the current schedule overlay (null = none). */
export const scheduleOverlayAtom = atom((get) => get(_overlay))

/** Write —— open an overlay (replacing the current one). */
export const openScheduleOverlayAtom = atom(null, (_get, set, overlay: ScheduleOverlay) => {
  set(_overlay, overlay)
})

/** Write —— close the overlay. */
export const closeScheduleOverlayAtom = atom(null, (_get, set) => {
  set(_overlay, null)
})

/** Write —— open the detail drawer of a specific run (slides out from the right). Run details reuse the
 *  session message rendering, but their interaction is independent of chat —— it doesn't jump to Home.
 *  The drawer component does its own loadSessionMessages + WS subscription (see RunLogDrawer). */
export const openRunDrawerAtom = atom(
  null,
  (_get, set, payload: { scheduleId: string; run: ScheduleRun }) => {
    set(_overlay, { kind: ScheduleOverlayKind.RunLog, ...payload })
  },
)

/** Write —— notification-click navigation (deep link `amphi://schedule-run/<sched>/<sess>`):
 *  open the run drawer of the run whose session is `sessionId`. Fetch the schedule detail to
 *  locate the run (the toast only carries ids); if that exact run is gone (pruned/raced away),
 *  fall back to the schedule's detail view; if the schedule itself is gone, warn and stay put. */
export const openRunFromNotificationAtom = atom(
  null,
  async (get, set, payload: { scheduleId: string; sessionId: string }) => {
    const client = buildAmphiClient(get)
    if (!client) return
    try {
      const detail = detailToSchedule(await client.getSchedule(payload.scheduleId))
      const run = detail.runs.find((r) => r.sessionId === payload.sessionId)
      if (run) {
        set(_overlay, { kind: ScheduleOverlayKind.RunLog, scheduleId: payload.scheduleId, run })
      } else {
        // Same stale-summary guard as openApprovalRunAtom: write the fresh detail
        // so the fallback view doesn't render "no run records yet".
        set(
          _schedules,
          get(_schedules).map((s) => (s.id === payload.scheduleId ? detail : s)),
        )
        set(_overlay, null)
        set(_detailId, payload.scheduleId)
      }
    } catch (err: unknown) {
      rlog.warn('[schedules] open run from notification failed', { payload, err })
    }
  },
)

/** Write —— the "handle it" shortcut: open the drawer of this task's currently pending
 *  (needsAction) run. List summaries carry no runs, so we fetch the detail once to locate the awaiting
 *  run and then open the drawer; if none is found, fall back to opening that task's detail. */
export const openApprovalRunAtom = atom(null, async (get, set, scheduleId: string) => {
  const client = buildAmphiClient(get)
  if (!client) return
  try {
    const detail = detailToSchedule(await client.getSchedule(scheduleId))
    const pending = getPendingRun(detail)
    if (pending) {
      set(_overlay, { kind: ScheduleOverlayKind.RunLog, scheduleId, run: pending })
    } else {
      // Race: the summary says needs_action>0 but by the time we fetch the detail that run has already been handled.
      // Fall back to opening the detail —— write the already-fetched detail (including runs) into _schedules, otherwise
      // the detail would read the stale summary and show "no run records yet".
      set(
        _schedules,
        get(_schedules).map((s) => (s.id === scheduleId ? detail : s)),
      )
      set(_overlay, null)
      set(_detailId, scheduleId)
    }
  } catch (err: unknown) {
    rlog.warn('[schedules] open approval run failed', { scheduleId, err })
  }
})

/* ─── Actions (wired for real: call the API + re-fetch the list) ─── */

/** Write —— pause / resume (PATCH enabled). On success, re-fetch + toast.
 *  **Does not block while running**: the semantics of pausing is "stop triggering future runs from cron"
 *  ("stop triggering future runs by cron"), which has nothing to do with the one currently in flight
 *  (use killScheduleAtom to stop an in-flight run). It used to `return` silently on `target.running`,
 *  while the list page collapses Running into Active for display —— so the user saw a normal "pause"
 *  ("pause") button, clicked it, and got no reaction at all. */
export const toggleScheduleAtom = atom(null, async (get, set, id: string) => {
  const client = buildAmphiClient(get)
  const target = get(_schedules).find((s) => s.id === id)
  if (!client || !target) return
  const wasPaused = target.paused
  try {
    const updated = await client.patchSchedule(id, { enabled: wasPaused })
    // #16 partial update after a write: PATCH already returned the authoritative summary, so replace that
    // row in place (keeping the runs already loaded) instead of re-fetching the whole table —— a full hydrate
    // is O(whole table) and makes the detail's run history flicker.
    set(_schedules, get(_schedules).map((row) =>
      row.id === id ? { ...summaryToSchedule(updated), runs: row.runs } : row,
    ))
    set(showToastAtom, wasPaused
      ? i18n.t('toast.scheduleResumed', { name: target.name })
      : i18n.t('toast.schedulePaused', { name: target.name }))
  } catch (err: unknown) {
    rlog.error('[schedules] toggle failed', err)
    set(showToastAtom, i18n.t('error.actionFailedRetry'))
  }
})

/** Write —— run once immediately (run-now). Under overlap semantics it can be triggered at any time
 *  (including starting another run while one is already running), so running is not blocked; the button
 *  is also always clickable (#1). */
export const runScheduleNowAtom = atom(null, async (get, set, id: string) => {
  const client = buildAmphiClient(get)
  const target = get(_schedules).find((s) => s.id === id)
  if (!client || !target) return
  try {
    await client.runScheduleNow(id)
    // Re-fetch the list after the write so the row reflects "running"; if the detail is open,
    // fetch the detail once more to fill **the run just started** into the run history (by the time run-now
    // returns 202 the backend has already created the scheduled session, so the detail can read it),
    // otherwise clicking run-now adds no row to the run history and it feels like nothing was triggered (#4).
    await set(hydrateSchedulesAtom)
    if (get(_detailId) === id) await set(openScheduleDetailAtom, id)
    set(showToastAtom, i18n.t('toast.scheduleRunTriggered', { name: target.name }))
  } catch (err: unknown) {
    rlog.error('[schedules] run-now failed', err)
    set(showToastAtom, i18n.t('error.triggerFailedRetry'))
  }
})

/** Write —— stop **one specific** run (POST /sessions/{id}/stop). The backend's `invocations.cancel`
 *  cancels only that one Session tree (including the sub-Agents it spawned); other in-flight runs of the
 *  same schedule are unaffected.
 *  Under the overlap policy (a new run starts on schedule as usual) one schedule often has several runs
 *  in flight at once, so the row-level "stop" must go through here and must never use the
 *  schedule-level killScheduleAtom —— that would take down the other runs as well. */
export const stopScheduleRunAtom = atom(null, async (get, set, sessionId: string) => {
  const client = buildAmphiClient(get)
  if (!client) return
  try {
    await client.stopSession(sessionId)
    // Re-fetch the list + detail so that row flips out of "running" (cancellation is cooperative and doesn't necessarily take effect immediately; the re-fetch reflects whatever the state is).
    await set(hydrateSchedulesAtom)
    const detailId = get(_detailId)
    if (detailId) await set(openScheduleDetailAtom, detailId)
    set(showToastAtom, i18n.t('toast.scheduleRunStopRequested'))
  } catch (err: unknown) {
    rlog.error('[schedules] stop run failed', err)
    set(showToastAtom, i18n.t('error.stopFailedRetry'))
  }
})

/** Write —— stop **all** in-flight runs of this schedule (POST /kill; only available while running).
 *  On success, re-fetch + toast.
 *  kill is best-effort: the agent turn is cancelled cooperatively, so after the backend's 202 the runs
 *  don't necessarily disappear immediately; the re-fetch reflects whatever the state is.
 *  To stop only a single run, use stopScheduleRunAtom. */
export const killScheduleAtom = atom(null, async (get, set, id: string) => {
  const client = buildAmphiClient(get)
  const target = get(_schedules).find((s) => s.id === id)
  if (!client || !target || !target.running) return
  try {
    await client.killSchedule(id)
    await set(hydrateSchedulesAtom)
    set(showToastAtom, i18n.t('toast.scheduleAllRunsStopRequested', { name: target.name }))
  } catch (err: unknown) {
    rlog.error('[schedules] kill failed', err)
    set(showToastAtom, i18n.t('error.stopFailedRetry'))
  }
})

/** Write —— delete (show a confirmation first; once confirmed, DELETE + re-fetch + clear the detail + toast). */
export const deleteScheduleAtom = atom(null, async (get, set, id: string) => {
  const client = buildAmphiClient(get)
  const target = get(_schedules).find((s) => s.id === id)
  if (!client || !target) return
  const ok = await set(requestConfirmAtom, {
    title: i18n.t('common.deleteSchedule'),
    message: i18n.t('common.deleteScheduleMessage', { name: target.name }),
    confirmLabel: i18n.t('common.delete'),
    cancelLabel: i18n.t('common.cancel'),
    danger: true,
  })
  if (!ok) return
  try {
    await client.deleteSchedule(id)
    // #16 partial update after a write: a delete only affects one row, so removing it locally is enough.
    set(_schedules, get(_schedules).filter((row) => row.id !== id))
    if (get(_detailId) === id) set(_detailId, null)
    set(showToastAtom, i18n.t('toast.scheduleDeleted', { name: target.name }))
  } catch (err: unknown) {
    rlog.error('[schedules] delete failed', err)
    set(showToastAtom, i18n.t('error.deleteFailedRetry'))
  }
})

// Approval allow/reject is answered inline inside the run detail drawer (RunLogDrawer renders that run's
// messages + pending HITL, pointing at the run's session id, reusing the existing permission card);
// "Continue the conversation / help me fix it" starts a new ordinary session carrying
// the context (schedule-session.ts::continueFromRunAtom). The overlap policy of scheduled tasks is no longer
// configurable —— execution is always "start again as usual" (hardcoded in the backend), and there
// is no frontend atom / /me endpoint for it anymore.
