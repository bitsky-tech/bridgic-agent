/**
 * Bridge atom for create / edit a scheduled task → a real new session + a Doubao-style template prefill.
 *
 * User requirement: the session opened by create / edit must be exactly the same as clicking
 * New session in the top-left corner (not a separate kind of session), only with the
 * composer prefilled with an **interactive template** (fixed phrasing + a free-text description
 * area (can @-reference workflows) + a name slot + a frequency picker). Hence the orchestration
 * here: clear the detail → switch to the Home nav → open a new session → drop a one-shot prefill
 * seed (Segment[] + caret) + request focus. After sending, segmentsToText flattens the widget
 * into a complete instruction sentence — it is just an ordinary conversation and it **does not
 * touch the schedule list** (by design: pure chat leaves the list alone; the backend has no schedule API yet).
 *
 * Deliberately kept apart from atoms/schedules.ts (the pure data layer, unit-testable without
 * React): this file depends on amphi (nav), sessions, and LeftSidebar's NavKey —— the last of
 * which drags a heavy component graph + settings (window) into the module graph, and mixing that into the data layer would pollute its bun:test.
 */
import { atom } from 'jotai'
import { rlog } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import { NavKey } from '@/components/amphi/LeftSidebar'
import {
  buildScheduleTemplateSegments,
  ScheduleTemplateMode,
  type ScheduleTemplateArg,
} from '@/lib/scheduleTemplate'
import { buildAmphiClient } from './backend'
import { selectNavAtom } from './amphi'
import {
  hydrateSessionsFromDaemonAtom,
  newSessionAtom,
  requestComposerInsertAtom,
  selectSessionAtom,
  setPendingComposerFocusAtom,
  setPendingComposerSeedAtom,
} from './sessions'
import { showToastAtom } from './toast'
import { closeScheduleDetailAtom, closeScheduleOverlayAtom } from './schedules'

/**
 * Insert the schedule-create template into the current Session composer.
 *
 * The workbench's `+` is an in-context action: it must preserve both the current
 * Session and its draft instead of behaving like the global schedule-center entry
 * point, which intentionally starts a new Session.
 */
export const insertScheduleTemplateInCurrentSessionAtom = atom(null, (_get, set) => {
  const { segments } = buildScheduleTemplateSegments({ mode: ScheduleTemplateMode.Create })
  set(selectNavAtom, NavKey.Home)
  set(requestComposerInsertAtom, segments)
})

/** Write —— the single entry point for create / edit a scheduled task (
 *  the schedule-center button). Pass create (optionally with a workflow) or edit (with a
 *  schedule). It opens a real new session and prefills the template (equivalent to clicking
 *  New session in the top-left corner).
 *
 *  Note: the `/schedule` slash command takes a different path —— it inserts the template in place
 *  in the **current** input (preserving the preceding text) without creating a new session,
 *  see FreeFormInput::pickSlashRow + useSlashTrigger.insertSegments. */
export const openScheduleSessionAtom = atom(null, (_get, set, arg: ScheduleTemplateArg) => {
  const { segments, focusFieldId } = buildScheduleTemplateSegments(arg)
  set(closeScheduleDetailAtom)
  set(selectNavAtom, NavKey.Home)
  const sessionId = set(newSessionAtom)
  set(setPendingComposerSeedAtom, { sessionId, segments, focusFieldId })
  set(setPendingComposerFocusAtom, true)
})

/** Write —— Continue the conversation: copies a finished run session **wholesale**
 *  into a new ordinary session (carrying its context), which appears in the left-hand session
 *  list and is switched to. The entry point is shown only for finish/completed runs; a scheduled
 *  run is itself read-only, only the copy can be continued (#3).
 *
 *  Collapse the overlay/detail → POST /sessions/{id}/duplicate → refetch the session list (the
 *  new session enters the left column) → switch to Home + select the new session. Failures only toast. */
export const continueFromRunAtom = atom(null, async (get, set, runSessionId: string) => {
  set(closeScheduleOverlayAtom)
  set(closeScheduleDetailAtom)
  const client = buildAmphiClient(get)
  if (!client) return
  try {
    const dup = await client.duplicateSession(runSessionId)
    await set(hydrateSessionsFromDaemonAtom) // Let the duplicated session enter the left-column list
    set(selectNavAtom, NavKey.Home)
    set(selectSessionAtom, dup.id)
    set(showToastAtom, i18n.t('toast.sessionCopiedForContinue'))
  } catch (err: unknown) {
    rlog.error('[schedule] continue-conversation (session duplication) failed', err)
    set(showToastAtom, i18n.t('error.sessionCopyFailedRetry'))
  }
})
