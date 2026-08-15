/**
 * Build focus-mode state — per-session task brief + focus derivation, plus the
 * requirements-spec preview / selection-comment batch-send state (staged build v2).
 *
 * "Spec appears ⇒ focus mode": a session is in focus mode when its thinking
 * position (thinkingModeFamily, written by daemon `stage` frames + transcript
 * hydration) is the build loop (`mode === 'build'`); the active rail node is
 * placed off its `stage`. The brief is `.work/.build/task.md` RAW markdown — the
 * daemon is the source of truth (clarify maintains the file); the GUI refetches
 * on stage movement / stream end, no file watch.
 *
 * Comment-merge invariant: comments accumulate into one feedback; a pending task
 * confirm resumes Clarify through the structured revise response, while other
 * stages emit it as a plain human turn. Both the preview toggle and pending are
 * stored **per session** (map keyed by sessionId) — the preview open/closed state
 * is retained per session and never crosses over; pending is additionally
 * persisted to spec-comments.json (useSpecCommentPersistence) so, like a draft,
 * it is never lost. The **unsent** counterpart — a half-typed comment, the
 * feedback instruction, the source-edit textarea — is `SpecSessionDraft`, also
 * keyed per session so switching away and back restores it (see that type for the
 * per-field lifecycle).
 *
 * Dep note: statically imports agent.ts (thinkingModeFamily +
 * appendUserMessageAtom); agent.ts only reaches back via dynamic import
 * (purge) — acyclic, same pattern as human-request.ts.
 */
import { atom, type Getter, type Setter } from 'jotai'
import type { MessageBlock, ThinkPosition } from '@shared/types'
import { SESSION_TASK_FILE_REL } from '@shared/app-meta'
import { rlog } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import { BackendState } from '../../main/python-client/types'
import { activeSessionIdAtom, activeWorkspaceRootAtom, markSessionAnsweredAtom } from './sessions'
import {
  currentSessionFocusPaneAtom,
  SessionFocusPaneKind,
  setSessionFocusPaneAtom,
} from './session-focus-pane'
import {
  appendUserMessageAtom,
  currentMessagesAtom,
  currentPendingFrameworkInteractionAtom,
  currentStreamingAtom,
  prepareInteractionContinuationAtom,
  thinkingModeFamily,
  updateBuildConfirmBlockAtom,
  updateTaskConfirmBlockAtom,
} from './agent'
import { backendStateAtom, buildAmphiClient } from './backend'
import {
  EMPTY_SPEC_DRAFT,
  briefFamily,
  buildPresentationLifecycleFamily,
  originalBriefFamily,
  pendingCommentsBySessionAtom,
  purgeBuildPresentationState,
  specDraftsAtom,
  type PendingComment,
  type SpecSessionDraft,
} from './build-presentation'

export { briefFamily, originalBriefFamily } from './build-presentation'
export type { PendingComment, SpecSessionDraft } from './build-presentation'

/** Build pipeline stages in chain order (mirrors the daemon's BUILD_STAGES). */
export const BUILD_STAGES = ['clarify', 'explore', 'generate', 'verify'] as const

/** One recognized unit in the four-stage Build pipeline. */
export type BuildStage = (typeof BUILD_STAGES)[number]

/** True when `stage` is one of the four pipeline units (a unit is/was running
 *  there). Used to place the rail's active node off `position.stage`. */
export function isBuildStage(stage: string | null): stage is BuildStage {
  return stage !== null && (BUILD_STAGES as readonly string[]).includes(stage)
}

/** Focus-mode trigger: the think loop is the build pipeline (`mode === 'build'`).
 *  Normal chat, including its `{mode:'normal', stage:null}` wire frame, and an
 *  absent turn position both collapse the rail. */
export function isFocusMode(position: ThinkPosition | null): boolean {
  return position?.mode === 'build'
}

/** Refetch a session's brief from the daemon. 404 → null (no brief yet);
 *  network noise keeps the last known content (warn only). */
export const loadSessionBriefAtom = atom(null, async (get, set, sessionId: string) => {
  const client = buildAmphiClient(get)
  if (!client) return
  const requestedLifecycle = get(buildPresentationLifecycleFamily(sessionId))
  const requestedCycle = requestedLifecycle.active ? requestedLifecycle.cycle : null
  try {
    const content = await client.getSessionFile(sessionId, SESSION_TASK_FILE_REL)
    const currentLifecycle = get(buildPresentationLifecycleFamily(sessionId))
    const position = get(thinkingModeFamily(sessionId))
    if (
      position?.mode !== 'build' ||
      (requestedCycle !== null &&
        (!currentLifecycle.active || currentLifecycle.cycle !== requestedCycle))
    ) {
      return
    }
    set(briefFamily(sessionId), content)
  } catch (err: unknown) {
    rlog.warn('[build] brief load failed', { sessionId, err })
  }
})

/** Capture the restored edit baseline before Clarify rewrites `.build/task.md`. */
export const loadEditBaselineAtom = atom(
  null,
  async (
    get,
    set,
    payload: { sessionId: string; workflowId: string },
  ): Promise<string | null> => {
    const client = buildAmphiClient(get)
    if (!client) return null
    const requestedLifecycle = get(buildPresentationLifecycleFamily(payload.sessionId))
    const requestedCycle = requestedLifecycle.active ? requestedLifecycle.cycle : null
    try {
      const workflow = await client.getWorkflow(payload.workflowId)
      const content = workflow.fields.task?.value?.trim() || null
      const position = get(thinkingModeFamily(payload.sessionId))
      const currentLifecycle = get(buildPresentationLifecycleFamily(payload.sessionId))
      if (
        position?.mode !== 'build' ||
        position.stage !== 'clarify' ||
        position.workflowId !== payload.workflowId ||
        (requestedCycle !== null &&
          (!currentLifecycle.active || currentLifecycle.cycle !== requestedCycle))
      ) {
        return null
      }
      set(originalBriefFamily(payload.sessionId), content)
      set(briefFamily(payload.sessionId), content)
      return content
    } catch (err: unknown) {
      rlog.warn('[build] edit baseline load failed', { ...payload, err })
      return null
    }
  },
)

/** Resume a parked Clarify Turn after the user reviews the task contract. */
export const respondTaskConfirmAtom = atom(
  null,
  async (
    _get,
    set,
    payload: {
      sessionId: string
      requestId: string
      action: 'confirm' | 'revise'
      feedback?: string
    },
  ) => {
    set(updateTaskConfirmBlockAtom, {
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      patch: {
        status: payload.action === 'confirm' ? 'confirmed' : 'revision_requested',
        feedback: payload.feedback?.trim() || null,
      },
    })
    set(prepareInteractionContinuationAtom, { sessionId: payload.sessionId })
    set(markSessionAnsweredAtom, payload.sessionId)
    const connection = await import('@/lib/amphiWsConnection')
    connection.getAmphiWsConnection().taskConfirm(payload.sessionId, {
      request_id: payload.requestId,
      action: payload.action,
      feedback: payload.feedback?.trim() || null,
    })
  },
)

/** Resume Main after the user accepts or declines a Workflow Build proposal. */
export const respondBuildConfirmAtom = atom(
  null,
  async (
    _get,
    set,
    payload: {
      sessionId: string
      requestId: string
      action: 'confirm' | 'cancel'
    },
  ) => {
    set(updateBuildConfirmBlockAtom, {
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      patch: { status: payload.action === 'confirm' ? 'confirmed' : 'cancelled' },
    })
    set(prepareInteractionContinuationAtom, { sessionId: payload.sessionId })
    set(markSessionAnsweredAtom, payload.sessionId)
    const connection = await import('@/lib/amphiWsConnection')
    connection.getAmphiWsConnection().buildConfirm(payload.sessionId, {
      request_id: payload.requestId,
      action: payload.action,
    })
  },
)

/** Derived: whether the current session is in Build focus mode; a normal/null
 *  display frame collapses the pipeline rail. */
export const focusModeAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  return id != null && isFocusMode(get(thinkingModeFamily(id)))
})

/** Frontend identity of the active Session's current Build entry. */
export const currentBuildPresentationCycleAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  return id ? get(buildPresentationLifecycleFamily(id)).cycle : 0
})

type TaskConfirmBlock = Extract<MessageBlock, { type: 'task_confirm' }>

/** The latest task review card belonging to the active Session. */
export const currentTaskConfirmAtom = atom((get): TaskConfirmBlock | null => {
  const findLatest = (blocks: MessageBlock[]): TaskConfirmBlock | null => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block?.type === 'task_confirm') return block
    }
    return null
  }

  const id = get(activeSessionIdAtom)
  if (!id) return null
  const position = get(thinkingModeFamily(id))
  const lifecycle = get(buildPresentationLifecycleFamily(id))
  const belongsToPreviousBuild = (block: TaskConfirmBlock): boolean => (
    position?.mode === 'build' &&
    lifecycle.active &&
    lifecycle.entryTaskConfirmRequestId !== null &&
    block.requestId === lifecycle.entryTaskConfirmRequestId
  )

  const streaming = get(currentStreamingAtom)
  const live = streaming ? findLatest(streaming.blocks) : null
  if (live) return belongsToPreviousBuild(live) ? null : live
  const messages = get(currentMessagesAtom)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const block = findLatest(messages[index]?.blocks ?? [])
    if (block) return belongsToPreviousBuild(block) ? null : block
  }
  return null
})

/** The task review that currently owns the parked tail Turn, if any. */
export const currentPendingTaskConfirmAtom = atom((get): TaskConfirmBlock | null => {
  const interaction = get(currentPendingFrameworkInteractionAtom)
  if (interaction?.type !== 'task_confirm') return null
  const id = get(activeSessionIdAtom)
  if (!id) return null
  const lifecycle = get(buildPresentationLifecycleFamily(id))
  const position = get(thinkingModeFamily(id))
  if (
    position?.mode === 'build' &&
    lifecycle.active &&
    lifecycle.entryTaskConfirmRequestId === interaction.requestId
  ) {
    return null
  }
  return interaction
})

/** Derived: current task markdown, preferring the exact pending review payload. */
export const currentBriefAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  if (!id) return null
  const pendingTaskConfirm = get(currentPendingTaskConfirmAtom)
  if (pendingTaskConfirm) return pendingTaskConfirm.taskMarkdown
  const taskConfirm = get(currentTaskConfirmAtom)
  return get(briefFamily(id)) ?? taskConfirm?.taskMarkdown ?? null
})

/** Original saved task definition for the active edit review. */
export const currentOriginalBriefAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  if (!id) return null
  return get(currentTaskConfirmAtom)?.originalTaskMarkdown ?? get(originalBriefFamily(id))
})

/** Whether the pending task review belongs to an existing Workflow edit. */
export const currentTaskReviewIsEditAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  if (!id) return false
  const taskConfirm = get(currentPendingTaskConfirmAtom)
  if (!taskConfirm) return false
  if (taskConfirm.operation === 'edit') return true
  const position = get(thinkingModeFamily(id))
  return (
    !taskConfirm.operation &&
    position?.mode === 'build' &&
    position.stage === 'clarify' &&
    !!position.workflowId &&
    (!taskConfirm.workflowId || taskConfirm.workflowId === position.workflowId)
  )
})

/** Baseline for the pending task review diff, scoped to the current Build. */
export const currentTaskDiffBaselineAtom = atom((get): string | null => {
  const taskConfirm = get(currentPendingTaskConfirmAtom)
  if (!taskConfirm) return null
  if (taskConfirm.previousTaskMarkdown != null) return taskConfirm.previousTaskMarkdown

  // Compatibility with an older daemon during a live same-Turn continuation.
  const streaming = get(currentStreamingAtom)
  const messages = get(currentMessagesAtom)
  const blocks = streaming?.blocks ?? messages[messages.length - 1]?.blocks ?? []
  let foundCurrent = false
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type !== 'task_confirm') continue
    if (!foundCurrent) {
      foundCurrent = block.requestId === taskConfirm.requestId
      continue
    }
    if (block.requestId !== taskConfirm.requestId) return block.taskMarkdown
  }

  if (!get(currentTaskReviewIsEditAtom)) return ''
  const id = get(activeSessionIdAtom)
  return taskConfirm.originalTaskMarkdown ?? (id ? get(originalBriefFamily(id)) : null) ?? ''
})

/** True between entering edit/clarify and receiving the revised task review. */
export const editBaselinePreviewAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  if (!id) return false
  const position = get(thinkingModeFamily(id))
  if (position?.mode !== 'build' || position.stage !== 'clarify' || !position.workflowId) {
    return false
  }
  return !get(currentTaskReviewIsEditAtom)
})

/** The preview is a retained review snapshot after the final Workflow save. */
export const specPreviewArchivedAtom = atom((get) => {
  if (get(focusModeAtom) || !get(currentTaskConfirmAtom)) return false
  const messages = get(currentMessagesAtom)
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const blocks = messages[messageIndex]?.blocks ?? []
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]
      if (block?.type === 'workflow_confirm') return block.status === 'confirmed'
    }
  }
  return false
})

/** Drop a session's build state — called from agent.ts purgeSessionAtom
 *  (dynamic import) so deleted sessions don't leak family atoms. */
export function purgeBuildState(id: string): void {
  purgeBuildPresentationState(id)
}

/* ────────────────────────────────────────────────────────────────────────
   Requirements-spec preview + selection-comment batch send (staged build v2)
   ──────────────────────────────────────────────────────────────────────── */

/** One staged spec comment: targets a selected snippet, carries the user's note. */
/** The task specification uses the exclusive per-Session focus-pane selection.
 *  Switching Sessions retains each Session's selection, while opening active Run
 *  details replaces this preview instead of allowing two takeover panes at once. */
/** Derived: whether the active session's preview panel is **effectively open**. No
 *  active session → closed; **when there is no spec content
 *  (currentBrief === null) it also always counts as closed** — the preview is a
 *  product of "the currently running session"; the user opens it by hand but never
 *  closes it by hand (design ⑤: the preview stays resident), so once the spec no
 *  longer exists the panel should disappear along with it (the right column falls
 *  back to the session output) rather than show an empty "not generated yet"
 *  placeholder. All consumers (BuildProgressPanel rendering / TopBar collapse
 *  button / AppLayout width clamp / showRightPanel) read the same derived value and
 *  stay consistent automatically (single source of truth, no drift between the
 *  checks scattered around). */
export const specPreviewOpenAtom = atom((get) => {
  const sid = get(activeSessionIdAtom)
  if (!sid) return false
  return get(currentSessionFocusPaneAtom)?.kind === SessionFocusPaneKind.TaskSpec
    && get(currentBriefAtom) !== null
})

/** Open the active session's spec preview (header click / completion-card eye). */
export const openSpecPreviewAtom = atom(null, (get, set) => {
  const sid = get(activeSessionIdAtom)
  if (!sid) return
  set(setSessionFocusPaneAtom, { kind: SessionFocusPaneKind.TaskSpec })
})

/** Close the active session's spec preview → right column falls back to the session output. */
export const closeSpecPreviewAtom = atom(null, (get, set) => {
  const sid = get(activeSessionIdAtom)
  if (!sid) return
  if (get(currentSessionFocusPaneAtom)?.kind !== SessionFocusPaneKind.TaskSpec) return
  set(setSessionFocusPaneAtom, null)
})

/**
 * One session's **unsent** spec-panel input — the three in-flight forms that are
 * not committed anywhere yet. Committed content lives elsewhere: a staged comment
 * moves to `_pendingComments`, a saved edit goes to disk + `briefFamily`.
 *
 * Why one per-session record instead of three `useState`s in the components:
 * `SpecPreviewPane` / `CommentFeedbackPanel` unmount whenever the active session
 * changes (BuildProgressPanel branches on the per-session `specPreviewOpenAtom`),
 * so local state was destroyed on every switch — the user's half-typed comment
 * vanished. Worse, when the session switched *to* also had the preview open the
 * component stayed mounted and the local state leaked across: the quote still came
 * from the previous document while `addPendingCommentAtom` filed it under the new
 * session. Keying by sessionId fixes both at once.
 *
 * Per-field lifecycle (the three are independent — editing the source does not
 * discard a queued comment draft, and vice versa):
 *   - `comment`     born when "comment this selection" is clicked (text `''`),
 *                   mutated while typing, cleared by `addPendingCommentAtom`
 *                   (staged) or by the composer's cancel / Esc (discarded).
 *   - `instruction` mutated while typing in the feedback panel, cleared by
 *                   `sendCommentBatchAtom` once the turn is actually sent.
 *   - `edit`        born when "edit source" is clicked (seeded from the current
 *                   brief), mutated while typing, cleared by the pane on cancel
 *                   or a successful save.
 *
 * Shape invariant: plain JSON — no class instances, no `undefined`-only fields —
 * so this map can be handed to `useBlobPersistence` verbatim the day we decide
 * drafts should also survive an app restart. Today it is memory-only, matching
 * how the user described the problem (leaving and re-entering a session).
 *
 * Like `_pendingComments` there is no per-session purge: session ids are never
 * reused, so entries left behind by a deleted session are inert.
 */
/** The draft of a session that has never typed anything. Frozen — it is handed out
 *  as the fallback for every session without an entry, so a mutation would corrupt
 *  all of them at once. */
/** The active session's unsent spec-panel input (never null — an untouched session reads as empty). */
export const currentSpecDraftAtom = atom((get) => {
  const sid = get(activeSessionIdAtom)
  return (sid ? get(specDraftsAtom)[sid] : undefined) ?? EMPTY_SPEC_DRAFT
})

/** Patch one field of a session's draft, creating the entry on first touch. Defaults
 *  to the active session; callers that already resolved a session id (or that may have
 *  awaited across a session switch) pass it explicitly so the patch cannot land on the
 *  wrong session. No-op when there is no session — there would be no key to file it under. */
function patchSpecDraft(
  get: Getter,
  set: Setter,
  patch: Partial<SpecSessionDraft>,
  sessionId?: string,
): void {
  const sid = sessionId ?? get(activeSessionIdAtom)
  if (!sid) return
  const map = get(specDraftsAtom)
  set(specDraftsAtom, { ...map, [sid]: { ...(map[sid] ?? EMPTY_SPEC_DRAFT), ...patch } })
}

/** Open / update / close (`null`) the selection-comment composer for the active session. */
export const setSpecCommentDraftAtom = atom(
  null,
  (get, set, comment: { quote: string; text: string } | null) => {
    patchSpecDraft(get, set, { comment })
  },
)

/** Update the active session's feedback instruction. */
export const setSpecInstructionDraftAtom = atom(null, (get, set, instruction: string) => {
  patchSpecDraft(get, set, { instruction })
})

/** Enter (string) / update / leave (`null`) source-edit mode for the active session. */
export const setSpecEditDraftAtom = atom(null, (get, set, edit: string | null) => {
  patchSpecDraft(get, set, { edit })
})

/** Map of every session's pending comments (sessionId → PendingComment[]).
 *  Persisted per session to spec-comments.json (see useSpecCommentPersistence),
 *  so, like a draft, it is never lost. */
/** Read the whole map (read by the persistence bridge when saving). */
export const allPendingCommentsAtom = atom((get) => get(pendingCommentsBySessionAtom))

/** Bulk-load the on-disk map when the persistence bridge loads. */
export const setAllPendingCommentsAtom = atom(
  null,
  (_get, set, next: Record<string, PendingComment[]>) => {
    set(pendingCommentsBySessionAtom, next)
  },
)

/** The active session's pending comments (derived). */
export const pendingCommentsAtom = atom((get) => {
  const sid = get(activeSessionIdAtom)
  return sid ? (get(pendingCommentsBySessionAtom)[sid] ?? []) : []
})

/** Select → write a comment → "Add": stage one on the current session (not sent
 *  immediately). Blank input is ignored.
 *  Closing the composer draft happens here rather than in the pane so that
 *  "staged ⇒ the draft is gone" is one indivisible transition — the content can
 *  never end up both queued and still sitting in the composer. */
export const addPendingCommentAtom = atom(
  null,
  (get, set, draft: { quote: string; text: string }) => {
    const sid = get(activeSessionIdAtom)
    const text = draft.text.trim()
    if (!sid || !text) return
    const entry: PendingComment = { id: `cmt-${crypto.randomUUID()}`, quote: draft.quote, text }
    const map = get(pendingCommentsBySessionAtom)
    set(pendingCommentsBySessionAtom, { ...map, [sid]: [...(map[sid] ?? []), entry] })
    patchSpecDraft(get, set, { comment: null }, sid)
  },
)

/** Remove one entry from the current session's staging area — a lone entry can be
 *  removed too (fixes the prototype's "only deletable when n>1" restriction). */
export const removePendingCommentAtom = atom(null, (get, set, commentId: string) => {
  const sid = get(activeSessionIdAtom)
  if (!sid) return
  const map = get(pendingCommentsBySessionAtom)
  set(pendingCommentsBySessionAtom, { ...map, [sid]: (map[sid] ?? []).filter((c) => c.id !== commentId) })
})

/** Feedback panel "Cancel" / Esc: only clear the current session's staging area,
 *  the preview stays open (design ⑤).
 *  The instruction draft goes with it: cancelling means abandoning **this batch of
 *  feedback**, and the instruction was written for that batch. Leaving it behind would
 *  resurrect it in the next batch — the panel only mounts while comments are staged, so
 *  the user would see their old text reappear weeks later and quietly ship it. */
export const clearPendingCommentsAtom = atom(null, (get, set) => {
  const sid = get(activeSessionIdAtom)
  if (!sid) return
  const map = get(pendingCommentsBySessionAtom)
  set(pendingCommentsBySessionAtom, { ...map, [sid]: [] })
  patchSpecDraft(get, set, { instruction: '' }, sid)
})

/**
 * Join multiple comments (+ an optional extra instruction) into one natural-language
 * feedback message, used as the body of a single human turn.
 * The clarify persona reads it to rewrite task.md, so keep the structure clear and
 * quote the original text.
 */
export function composeCommentBatchText(comments: PendingComment[], instruction?: string): string {
  const head = i18n.t('build.commentBatch.head', { count: comments.length })
  const body = comments
    .map((c, i) => i18n.t('build.commentBatch.item', { index: i + 1, quote: c.quote.trim(), text: c.text.trim() }))
    .join('\n\n')
  const extra = instruction?.trim()
  return `${head}\n\n${body}${extra ? `\n\n${extra}` : ''}`
}

/**
 * "Send feedback and continue building": merge the staged comments into one piece of
 * feedback, send it to the daemon, then clear the staging area. When a task confirm
 * is pending it uses that confirm's dedicated revise response, otherwise it sends a
 * plain human message.
 * The preview stays open (storyboard f6) so the user can keep watching while clarify
 * rewrites the spec.
 * No-op when the staging area is empty / there is no active session. `instruction` =
 * the content of the feedback panel's "just tell it what to do" input (may be empty)
 * — carried along as well, fixing the prototype bug where clicking the button
 * swallowed the already-typed instruction.
 */
export const sendCommentBatchAtom = atom(null, async (get, set, instruction?: string) => {
  const sessionId = get(activeSessionIdAtom)
  const map = get(pendingCommentsBySessionAtom)
  const comments = sessionId ? (map[sessionId] ?? []) : []
  if (!sessionId || comments.length === 0) return
  const feedback = composeCommentBatchText(comments, instruction)
  const taskConfirm = get(currentPendingTaskConfirmAtom)
  if (taskConfirm) {
    await set(respondTaskConfirmAtom, {
      sessionId,
      requestId: taskConfirm.requestId,
      action: 'revise',
      feedback,
    })
  } else {
    set(appendUserMessageAtom, { sessionId, text: feedback, blocks: [] })
  }
  set(pendingCommentsBySessionAtom, { ...map, [sessionId]: [] })
  // The instruction travelled with the turn, so its draft is spent — clearing it only
  // after the send succeeded means a throw leaves the user's text in the box to retry.
  // Keyed by the captured sessionId, not the active one: the await above can span a
  // session switch, and clearing "whatever is active now" would wipe a bystander's box.
  patchSpecDraft(get, set, { instruction: '' }, sessionId)
})

/* ─── Editing the requirements spec: write to disk directly via Electron IPC + notify by message ─── */

/** Absolute path of the session's spec file (used for writing to disk). */
export function specTaskFilePath(workspaceRoot: string): string {
  return `${workspaceRoot}/${SESSION_TASK_FILE_REL}`
}

/**
 * Result of `saveSpecEditAtom`. Compared / assigned in two places (build.ts and
 * SpecPreviewPane), so per § "cross-file state literals must be extracted into a
 * typed const" it uses a const object + same-name type as the single source of truth
 * (same pattern as RightPanelFilter / AgentRole); writing bare strings at call sites
 * is forbidden.
 *  - Saved       write succeeded + optimistic refresh + daemon notified
 *  - NoSession   no active session / no workspaceRoot (usually a draft session not yet materialized)
 *  - NotReady    backend not ready, or the current session is streaming (inserting into a session mid-stream is unsupported for now)
 *  - WriteFailed save failed (write IO error / path rejected by the main guard / optimistic refresh or notification threw)
 */
export const SaveSpecResult = {
  Saved: 'saved',
  NoSession: 'no-session',
  NotReady: 'not-ready',
  WriteFailed: 'write-failed',
} as const
export type SaveSpecResult = (typeof SaveSpecResult)[keyof typeof SaveSpecResult]

/**
 * Save a manually edited requirements spec: write the markdown straight to
 * `<workspace_root>/.work/.build/task.md` via Electron IPC (fs:writeFile),
 * optimistically refresh the local brief, and simulate a human message to notify the
 * daemon (clarify continues from it next time).
 *
 * Returns `SaveSpecResult` rather than a boolean: it lets callers tell "session not
 * ready" apart from "write failed". writeFile may be rejected by the main guard
 * because of an IO error or an out-of-bounds path — that must be caught explicitly,
 * otherwise the rejection bubbles up as an unhandled rejection and the user gets no
 * failure feedback at all after clicking save.
 */
export const saveSpecEditAtom = atom(
  null,
  async (get, set, content: string): Promise<SaveSpecResult> => {
    const sessionId = get(activeSessionIdAtom)
    const root = get(activeWorkspaceRootAtom)
    if (!sessionId || !root) return SaveSpecResult.NoSession
    // Don't save while the backend isn't up or the current session is streaming:
    // saving = write to disk + insert a human turn into the daemon, and inserting
    // into a session mid-stream isn't supported yet (relax this check once it is).
    if (get(backendStateAtom) !== BackendState.Ready || get(currentStreamingAtom) !== undefined) {
      return SaveSpecResult.NotReady
    }
    // The whole side-effecting block is wrapped in try/catch and any failure returns
    // WriteFailed, guaranteeing this atom never rejects — otherwise a caller's
    // `void saveEdit()` would silently swallow the rejection (violating "never
    // silently swallow errors").
    try {
      await window.api.fs.writeFile(specTaskFilePath(root), content)
      set(briefFamily(sessionId), content) // optimistically refresh the header summary + preview
      set(appendUserMessageAtom, {
        sessionId,
        text: i18n.t('build.specEditedMessage', { path: SESSION_TASK_FILE_REL }),
        blocks: [],
      })
      // Leaving edit mode belongs here, not at the call site: writeFile is async IPC, so by
      // the time it resolves the user may have switched sessions — a caller clearing "the
      // active session's" draft would exit the wrong session's editor and throw away its
      // unsaved text. Keyed by the sessionId captured before the await.
      patchSpecDraft(get, set, { edit: null }, sessionId)
    } catch (err: unknown) {
      rlog.warn('[build] spec edit save failed', err)
      return SaveSpecResult.WriteFailed
    }
    return SaveSpecResult.Saved
  },
)
