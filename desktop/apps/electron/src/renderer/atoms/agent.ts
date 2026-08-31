/**
 * Agent state: per-session messages + streaming state + reducer.
 *
 * Detached streaming: streaming partials are not attached to the message, they
 * accumulate into the per-session streamingFamily(sessionId); on message_stop they are
 * committed into messageFamily(sessionId) and the streaming state is cleared.
 * Concurrent streaming across multiple sessions is supported.
 *
 * Per-session state uses jotai atomFamily(sessionId) — one independent atom per
 * session, replacing the old whole-table clone of Record<id,…> / Map<id,…>. A family
 * can't enumerate its keys, hence the companion Set _hydratedIds (which sessions are
 * loaded / have data, used to dedupe lazy-load).
 * On removeSession it MUST go through purgeSessionAtom to do family.remove + delete from
 * the Set, to prevent memory buildup.
 *
 * The reducer covers every AgentEvent variant (translated from the daemon WS by turnTranslate).
 *
 * Upstream: window.api.events.onAgentEvent → applyAgentEventAtom (subscribed in App.tsx)
 * Downstream: currentMessagesAtom / currentStreamingAtom are rendered by Pipeline
 */
import type { AgentEvent, ContextUsageSnapshot, ThinkPosition, WorkflowRunState } from '@shared/types'
import { atom, type Getter, type Setter } from 'jotai'
import { atomFamily } from 'jotai-family'
import type {
  AgentEventPayload,
  AgentMessage,
  AgentMessageOptions,
  AgentMessageSubagent,
  AgentMessageToolCall,
  MessageBlock,
} from '@shared/types'
import { AgentRole } from '@shared/types'
import { rlog } from '@/lib/logger'
import {
  activeIsDraftAtom,
  activeSessionIdAtom,
  bumpSessionCompletionAtom,
  submitSessionDraftAtom,
  draftSessionIdsAtom,
  hydrateSessionsFromDaemonAtom,
  markSessionAnsweredAtom,
  replaceDraftWithDaemonIdAtom,
  markSessionUnreadAtom,
  registerDraftSlotReset,
  sessionsMetaAtom,
  updateSessionTitleAtom,
} from './sessions'
import { backendEndpointAtom, buildAmphiClient } from './backend'
import type { RunChild } from '@/lib/amphiClient'
// Static import is acyclic: human-request.ts imports agent.ts only dynamically.
import {
  acceptanceRuleQuestions,
  clearSessionHumanRequestAtom,
  pendingBySessionAtom,
  setHumanRequestAtom,
} from './human-request'
import type { ChatBlock } from '@shared/types'
import {
  applySubagentEventAtom,
  isParentWaitingForSubagents,
  subagentsAtom,
} from './subagents'
import { showToastAtom } from './toast'
import { i18n } from '@/lib/i18n'
import { syncBuildPresentationAtom } from './build-presentation'
import { syncSessionFocusPaneModeAtom } from './session-focus-pane'
import {
  purgeBrowserAttentionAtom,
} from './browser-attention'
import { purgeFilesAttentionAtom } from './files-attention'
import { purgePowerPointAttentionAtom } from './powerpoint-attention'
import { purgePresentationSessionAtom } from './presentation'
import {
  notifySessionWorkbenchActivityAtom,
  purgeSessionWorkbenchStateAtom,
  SessionWorkbenchSurface,
} from './workbench'

/** Re-export so existing `import type { AgentMessage } from '@/atoms/agent'`
 *  call sites keep working. Single source of truth in
 *  `packages/shared/src/types/sessions.ts` (shared with the main-process
 *  persistence layer). */
export type { AgentMessage, AgentMessageOptions, AgentMessageSubagent, AgentMessageToolCall, MessageBlock }

/** Max chars of the first user message used to auto-name a session — longer
 *  input is truncated; an empty trim falls back to the default session title. */
const SESSION_TITLE_MAX_LEN = 30
const TERMINAL_SUBAGENT_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export interface StreamingState {
  messageId: string
  content: string
  thinking?: string
  toolCalls: AgentMessageToolCall[]
  /** Ordered content blocks — accumulated in event arrival order, rendering interleaved text/thinking/tool. */
  blocks: MessageBlock[]
  startedAt: number
  retry?: {
    attempt: number
    maxRetries: number
    delaySeconds: number
  }
  /** True only while the daemon is replacing old raw history with compact summaries. */
  compacting?: boolean
}

/** Per-session committed messages. One independent primitive atom per sessionId,
 *  replacing the old whole-table spread of `_messages: Record`. On removeSession it
 *  must go through purgeSessionAtom's .remove(id), otherwise the atom cached by the
 *  family is never released. */
export const messageFamily = atomFamily((_sessionId: string) => atom<AgentMessage[]>([]))

/** Per-session streaming state (undefined = not streaming). Likewise a family replacing the old Map. */
export const streamingFamily = atomFamily((_sessionId: string) =>
  atom<StreamingState | undefined>(undefined),
)

/** Latest context-window occupancy emitted for each Session. */
export const contextUsageFamily = atomFamily((_sessionId: string) =>
  atom<ContextUsageSnapshot | null>(null),
)

export const activeContextUsageAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  return sessionId ? get(contextUsageFamily(sessionId)) : null
})

/** Session ids with an in-flight Agent turn. Sidebar consumers read this once
 * instead of calling hooks over a dynamic session list. */
export const runningSessionIdsAtom = atom((get) => {
  const running = new Set<string>()
  const liveSubagents = get(subagentsAtom)
  for (const session of get(sessionsMetaAtom)) {
    if (session.isRunning) {
      running.add(session.id)
      continue
    }
    if (get(streamingFamily(session.id))) {
      running.add(session.id)
      continue
    }
    const tail = get(messageFamily(session.id)).findLast(
      (message) => message.role === AgentRole.Assistant,
    )
    if (
      tail &&
      isParentWaitingForSubagents(tail.blocks ?? [], liveSubagents, tail.turnStatus)
    ) {
      running.add(session.id)
    }
  }
  return running
})

interface InteractionContinuation {
  sourceMessageId?: string
  content: string
  thinking?: string
  toolCalls: AgentMessageToolCall[]
  blocks: MessageBlock[]
  startedAt: number
}

/** Process blocks retained while a suspended Session Turn resumes. */
const continuationFamily = atomFamily((_sessionId: string) =>
  atom<InteractionContinuation | undefined>(undefined),
)

/** Monotonic live-attempt generation used to reject transcript fetches that
 *  raced with a new stream, including a stream that already settled by the
 *  time the HTTP response arrives. */
const liveRevisionFamily = atomFamily((_sessionId: string) => atom(0))

/** Per-session think position, driven by the live `stage` frames and the transcript's
 *  thinking_mode. Build uses stage names, Workflow uses execute/validate, normal uses main/null. */
export const thinkingModeFamily = atomFamily((_sessionId: string) =>
  atom<ThinkPosition | null>(null),
)

/** Per-session active Workflow projection, updated live and rehydrated from REST. */
export const workflowRunFamily = atomFamily((_sessionId: string) =>
  atom<WorkflowRunState | undefined>(undefined),
)

/** Per-session background Child Agent summaries, for the "session hierarchy" left column of the run-detail modal (hydrated over REST). */
export const childrenFamily = atomFamily((_sessionId: string) =>
  atom<RunChild[]>([]),
)

/** The set of sessions that are loaded / have data — a family can't enumerate its keys,
 *  so App.tsx's lazy-load dedupe (formerly `id in _messages`) checks this Set instead.
 *  Added to in sync whenever messageFamily is written. */
const _hydratedIds = atom(new Set<string>())
export const hydratedSessionIdsAtom = atom((get) => get(_hydratedIds))

/** Mark a sessionId as loaded (called on every messageFamily write; idempotent). */
function markHydrated(get: Getter, set: Setter, id: string): void {
  const cur = get(_hydratedIds)
  if (!cur.has(id)) set(_hydratedIds, new Set(cur).add(id))
}

/** Append one committed message to a session: write family + mark hydrated.
 *  A single entry point — appendUser / appendAssistant / committing streaming all go
 *  through it (removing duplication). Not persisted locally — the daemon is the source
 *  of truth: real chat lands in the daemon DB over WS, and is fetched back from
 *  GET /sessions/{id}/messages on refresh. */
function appendMessage(get: Getter, set: Setter, sessionId: string, msg: AgentMessage): void {
  set(messageFamily(sessionId), [...get(messageFamily(sessionId)), msg])
  markHydrated(get, set, sessionId)
}

/** Commit the streaming state into a single assistant message. A non-empty error =
 *  marked as failed; finalAnswer comes from the daemon `final` frame (the authoritative
 *  final answer, empty string = this turn has no visible answer). */
function finalizeStreaming(
  s: StreamingState,
  error?: string,
  finalAnswer?: string | null,
  completion?: {
    durationMs?: number
    completedAt?: number
  },
): AgentMessage {
  return {
    id: s.messageId,
    role: AgentRole.Assistant,
    text: s.content,
    thinking: s.thinking,
    toolCalls: s.toolCalls,
    blocks: s.blocks,
    done: true,
    createdAt: s.startedAt,
    ...completion,
    ...(error !== undefined ? { error } : {}),
    ...(finalAnswer !== undefined ? { finalAnswer } : {}),
  }
}

/** Commit streaming → message and clear the streaming state (shared by message_stop / error). */
function commitFinalMessage(
  get: Getter,
  set: Setter,
  sessionId: string,
  msg: AgentMessage,
): void {
  appendMessage(get, set, sessionId, msg)
  set(streamingFamily(sessionId), undefined)
}

/** Whether the streaming state has "nothing at all" (no text/thinking/tools/blocks) — an empty turn is not committed (see the message_stop comment). */
function isEmptyStreaming(s: StreamingState): boolean {
  return s.content === '' && !s.thinking && s.toolCalls.length === 0 && s.blocks.length === 0
}

/** Session ids whose transcript is currently loading (a module-level guard, not
 *  reactive state — purely for deduping, it doesn't drive rendering). Avoids concurrent
 *  duplicate GETs for the same session on a fast A→B→A switch. */
const transcriptLoadsInFlight = new Set<string>()

/** Load a session's transcript from the daemon into messageFamily. The daemon
 *  is the source of truth; the GUI hydrates on session switch (replaces the old
 *  local-JSONL load). No-op when the daemon isn't reachable.
 *
 *  Concurrency guards: don't load while a live reply/continuation owns the current
 *  tail; a new stream starting during the fetch also uses the revision to reject the
 *  stale snapshot. The remaining paths both compare references and confirm the daemon
 *  already contains the local optimistic user message before replacing messageFamily
 *  wholesale. */
/** Initial transcript page size (in turns). 100 turns ≈ 200 messages, so the payload is
 *  bounded; older history is paged on demand via fetchOlderTranscriptAtom. */
const INITIAL_TRANSCRIPT_TURNS = 100

/** Per-session cursor state: whether the server still has an older page + the next-page cursor. */
export const transcriptPagingFamily = atomFamily((_sessionId: string) =>
  atom<{ hasMore: boolean; nextBefore: number | null }>({ hasMore: false, nextBefore: null }),
)

/**
 * Let the daemon rows inherit the id of the optimistic local rows they replace.
 *
 * The optimistic user message is minted locally (`u-<uuid>`) while the daemon assigns
 * ordinal ids (`<sessionId>:u0`). Adopting the daemon id changes the row's React key, so
 * the transcript refresh that follows every turn remounts a bubble whose content did not
 * change at all — which replays its enter animation and throws away whatever local state
 * the subtree held. Keeping the local id makes the refresh invisible.
 *
 * Pairing is positional over the user messages, the same walk `daemonHasOptimisticUsers`
 * uses to decide the snapshot is safe to apply at all — and only rows still carrying an
 * optimistic id are rewritten, so ids the daemon already owns keep flowing through (the
 * paging branch below matches its page head by daemon id).
 */
function inheritOptimisticIds(local: AgentMessage[], remote: AgentMessage[]): AgentMessage[] {
  const optimisticUserIds: (string | null)[] = []
  for (const message of local) {
    if (message.role !== AgentRole.User) continue
    optimisticUserIds.push(message.id.startsWith('u-') ? message.id : null)
  }
  if (!optimisticUserIds.some(Boolean)) return remote
  let userIndex = 0
  return remote.map((message) => {
    if (message.role !== AgentRole.User) return message
    const inherited = optimisticUserIds[userIndex]
    userIndex += 1
    return inherited ? { ...message, id: inherited } : message
  })
}

export const loadSessionMessagesAtom = atom(null, async (get, set, sessionId: string) => {
  const daemonHasOptimisticUsers = (local: AgentMessage[], remote: AgentMessage[]): boolean => {
    const remoteUsers = remote.filter((message) => message.role === AgentRole.User)
    let userIndex = 0
    for (const message of local) {
      if (message.role !== AgentRole.User) continue
      if (message.id.startsWith('u-') && remoteUsers[userIndex]?.text !== message.text) return false
      userIndex += 1
    }
    return true
  }

  const client = buildAmphiClient(get)
  if (!client) return
  if (transcriptLoadsInFlight.has(sessionId)) return
  if (get(streamingFamily(sessionId)) || get(continuationFamily(sessionId))) {
    rlog.debug('[agent] transcript load skipped: live reply owns the Session tail', {
      sessionId,
    })
    return
  }
  transcriptLoadsInFlight.add(sessionId)
  const before = get(messageFamily(sessionId))
  const beforeLiveRevision = get(liveRevisionFamily(sessionId))
  try {
    const transcript = await client.getSessionMessages(sessionId, {
      limit: INITIAL_TRANSCRIPT_TURNS,
    })
    const { messages, pendingRequest, thinkingMode, workflowRun, children, contextUsage } = transcript
    if (
      get(liveRevisionFamily(sessionId)) !== beforeLiveRevision ||
      get(streamingFamily(sessionId)) ||
      get(continuationFamily(sessionId))
    ) {
      rlog.debug('[agent] transcript load discarded: live reply started during fetch', {
        sessionId,
      })
      return
    }
    if (get(messageFamily(sessionId)) !== before) {
      rlog.warn('[agent] transcript load discarded: session mutated during fetch', {
        sessionId,
      })
      return
    }
    if (messages.length === 0 && before.length > 0) {
      rlog.debug('[agent] transcript load discarded: empty daemon transcript over local state', {
        sessionId,
      })
      return
    }
    if (!daemonHasOptimisticUsers(before, messages)) {
      rlog.debug('[agent] transcript load discarded: optimistic user message not persisted yet', {
        sessionId,
      })
      return
    }
    set(syncBuildPresentationAtom, {
      sessionId,
      position: thinkingMode,
      entryTaskConfirmRequestId: hydratedBuildEntryBoundary(messages),
    })
    const runGeneration = get(workflowRunFamily(sessionId))?.generation
    set(syncSessionFocusPaneModeAtom, {
      sessionId,
      previousMode: get(thinkingModeFamily(sessionId))?.mode ?? null,
      nextMode: thinkingMode?.mode ?? 'normal',
      ...(runGeneration ? { runGeneration } : {}),
    })
    // A refresh fetches the "latest page"; if the user has already paged up into older
    // history (the array head is earlier than this page's first row), replacing the whole
    // table would drop the loaded history and misalign the scroll — so keep the prefix
    // before this page's first row, and leave the cursor untouched.
    const currentRows = get(messageFamily(sessionId))
    const rows = inheritOptimisticIds(currentRows, messages)
    const fetchedHeadId = messages[0]?.id
    const headIdx = fetchedHeadId
      ? currentRows.findIndex((m) => m.id === fetchedHeadId)
      : -1
    if (headIdx > 0) {
      set(messageFamily(sessionId), [...currentRows.slice(0, headIdx), ...rows])
    } else {
      set(messageFamily(sessionId), rows)
      set(transcriptPagingFamily(sessionId), {
        hasMore: transcript.hasMore,
        nextBefore: transcript.nextBefore,
      })
    }
    set(contextUsageFamily(sessionId), contextUsage)
    set(thinkingModeFamily(sessionId), thinkingMode)
    set(workflowRunFamily(sessionId), workflowRun ?? undefined)
    set(childrenFamily(sessionId), children)
    markHydrated(get, set, sessionId)
    set(clearSessionHumanRequestAtom, sessionId)
    // A suspended session's unanswered ask comes back with the transcript.
    if (pendingRequest) {
      if (pendingRequest.kind === 'permission') {
        const current = get(messageFamily(sessionId))
        const hasPendingBlock = current.some((message) =>
          (message.blocks ?? []).some(
            (block) =>
              block.type === 'permission' &&
              !block.decided &&
              block.requestId === pendingRequest.requestId,
          ),
        )
        if (!hasPendingBlock) {
          const block: MessageBlock = {
            type: 'permission',
            requestId: pendingRequest.requestId ?? null,
            items: pendingRequest.items ?? [],
            questions: pendingRequest.questions,
          }
          let assistantIndex = -1
          for (let index = current.length - 1; index >= 0; index -= 1) {
            const message = current[index]
            if (message?.role === AgentRole.User) break
            if (message?.role === AgentRole.Assistant) {
              assistantIndex = index
              break
            }
          }
          if (assistantIndex >= 0) {
            const assistant = current[assistantIndex]!
            set(messageFamily(sessionId), [
              ...current.slice(0, assistantIndex),
              { ...assistant, blocks: [...(assistant.blocks ?? []), block] },
              ...current.slice(assistantIndex + 1),
            ])
          } else {
            appendMessage(get, set, sessionId, {
              id: `${sessionId}:pending-permission`,
              role: AgentRole.Assistant,
              text: '',
              toolCalls: [],
              blocks: [block],
              done: true,
              createdAt: Date.now(),
            })
          }
        }
      } else if (pendingRequest.kind === 'accept_rule' && pendingRequest.requestId) {
        const rules = pendingRequest.rules ?? []
        set(setHumanRequestAtom, {
          sessionId,
          kind: 'accept_rule',
          requestId: pendingRequest.requestId,
          rules,
          questions: acceptanceRuleQuestions(rules),
        })
      } else {
        set(setHumanRequestAtom, {
          sessionId,
          ...(pendingRequest.prompt ? { prompt: pendingRequest.prompt } : {}),
          questions: pendingRequest.questions,
          requestId: pendingRequest.requestId ?? undefined,
        })
      }
    }
  } catch (err: unknown) {
    rlog.warn('[agent] loadSessionMessages failed', { sessionId, err })
  } finally {
    transcriptLoadsInFlight.delete(sessionId)
  }
})

/** Draft slots with a send still on its way to the daemon. Read by
 *  {@link resetDraftSlot}: the optimistic user message on such a slot is about to
 *  migrate onto the daemon id, so wiping it mid-flight would drop it from the real
 *  session too. */
const draftSendsInFlight = new Set<string>()

/**
 * Empty the reusable draft slot so "+ New session" always opens a blank session. Registered
 * with sessions.ts (which owns newSessionAtom but not these families).
 *
 * The slot's id is a singleton (`DRAFT_SESSION_ID`), so anything left on it is
 * inherited by the next new session. A send that never reached the daemon leaves
 * exactly that: the optimistic user bubble plus the error card, on an id the sidebar
 * filters out — the user clicks "+ New session" and is greeted by the message they sent a
 * moment ago, in what should be an empty session.
 *
 * Sent content never belongs to the *next* new session, whatever became of it. The
 * unsent composer draft does, and is deliberately left alone (see newSessionAtom).
 */
function resetDraftSlot(get: Getter, set: Setter, id: string): void {
  if (draftSendsInFlight.has(id)) return
  if (get(messageFamily(id)).length === 0) return
  // Empty the two families the centre view reads BEFORE purging: the active id does not
  // change across this reset (the slot is being reused), so `family.remove()` on its own
  // would drop the cache entry without notifying anyone, and every derived atom built on
  // the old instance would keep serving the messages it had (§1.29).
  set(messageFamily(id), [])
  set(streamingFamily(id), undefined)
  set(purgeSessionAtom, id)
}
registerDraftSlotReset(resetDraftSlot)

/** Materialize a draft to a real daemon session: POST /sessions, then migrate
 *  all id-keyed state from the draft id to the daemon id — messageFamily (the
 *  optimistic user message carries over), sidebar meta, draftIds, active id
 *  (the last three via `replaceDraftWithDaemonIdAtom`, one atomic write).
 *  Returns the daemon session id. Throws when the daemon isn't reachable. */
async function materializeToDaemon(get: Getter, set: Setter, draftId: string): Promise<string> {
  const client = buildAmphiClient(get)
  if (!client) throw new Error(i18n.t('error.backendNotReady'))
  const detail = await client.createSession({})
  const daemonId = detail.id
  set(messageFamily(daemonId), get(messageFamily(draftId)))
  messageFamily.remove(draftId)
  markHydrated(get, set, daemonId)
  const { remapSessionWorkflowResourcesAtom } = await import('./workflows')
  set(remapSessionWorkflowResourcesAtom, {
    sourceSessionId: draftId,
    targetSessionId: daemonId,
  })
  const { remapRightPanelLayoutStateAtom } = await import('./layout')
  set(remapRightPanelLayoutStateAtom, {
    sourceSessionId: draftId,
    targetSessionId: daemonId,
  })
  set(replaceDraftWithDaemonIdAtom, { draftId, daemonId })
  return daemonId
}

const olderPagesInFlight = new Set<string>()

/** Page up one older transcript page and merge it in at the front.

 *  Invariant: an older page is strictly earlier than the existing array → prepending is
 *  always valid; the WS streaming tail renders independently and is unaffected by the
 *  prepend. The result is discarded only when the session was reset wholesale (the head
 *  message changed). */
export const fetchOlderTranscriptAtom = atom(null, async (get, set, sessionId: string): Promise<boolean> => {
  const client = buildAmphiClient(get)
  if (!client) return false
  if (olderPagesInFlight.has(sessionId)) return false
  const paging = get(transcriptPagingFamily(sessionId))
  if (!paging.hasMore || paging.nextBefore == null) return false
  olderPagesInFlight.add(sessionId)
  const headBefore = get(messageFamily(sessionId))[0]?.id
  try {
    const older = await client.getSessionMessages(sessionId, {
      limit: INITIAL_TRANSCRIPT_TURNS,
      beforeOrdinal: paging.nextBefore,
    })
    const current = get(messageFamily(sessionId))
    if (current[0]?.id !== headBefore) {
      rlog.debug('[agent] older page discarded: session head changed during fetch', { sessionId })
      return false
    }
    set(messageFamily(sessionId), [...older.messages, ...current])
    set(transcriptPagingFamily(sessionId), {
      hasMore: older.hasMore,
      nextBefore: older.nextBefore,
    })
    return true
  } catch (err: unknown) {
    rlog.warn('[agent] older transcript page failed', { sessionId, err })
    return false
  } finally {
    olderPagesInFlight.delete(sessionId)
  }
})

/** Drop a session's per-session agent state (family atoms + companion Set).
 *  Called by sessions.ts removeSessionAtom via dynamic import — atomFamily
 *  caches an atom per id forever otherwise (memory leak across deletions). */
export const purgeSessionAtom = atom(null, (get, set, id: string) => {
  messageFamily.remove(id)
  streamingFamily.remove(id)
  contextUsageFamily.remove(id)
  continuationFamily.remove(id)
  liveRevisionFamily.remove(id)
  thinkingModeFamily.remove(id)
  workflowRunFamily.remove(id)
  childrenFamily.remove(id)
  transcriptPagingFamily.remove(id)
  set(clearSessionHumanRequestAtom, id)
  set(purgeBrowserAttentionAtom, id)
  set(purgeFilesAttentionAtom, id)
  set(purgePowerPointAttentionAtom, id)
  set(purgePresentationSessionAtom, id)
  set(purgeSessionWorkbenchStateAtom, id)
  // build.ts owns the brief family; dynamic import keeps the dep acyclic.
  void import('./build').then((m) => m.purgeBuildState(id))
  void import('./session-focus-pane').then((m) => m.purgeSessionFocusPaneState(id))
  const h = get(_hydratedIds)
  if (h.has(id)) {
    const next = new Set(h)
    next.delete(id)
    set(_hydratedIds, next)
  }
})

/** Append the delta text to the last block of the same type in blocks; create a new
 *  block when the last one isn't that type. This way the per-token increments of
 *  text/thinking land in the right contiguous block, and after a tool call interrupts,
 *  the next stretch of text naturally opens a new block, preserving the interleaved order. */
function appendDelta(
  blocks: MessageBlock[],
  type: 'text' | 'thinking',
  text: string,
): MessageBlock[] {
  const last = blocks[blocks.length - 1]
  if (last && last.type === type) {
    return [...blocks.slice(0, -1), { type, text: last.text + text }]
  }
  return [...blocks, { type, text }]
}

/** Append an ordered Build boundary, deduping same-stage interaction resumes. */
function appendBuildStageMarker(blocks: MessageBlock[], position: ThinkPosition): MessageBlock[] {
  const stage = position.mode === 'build' ? position.stage : null
  let latest: Extract<MessageBlock, { type: 'build_stage' }> | undefined
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type === 'workflow_step') break
    if (block?.type === 'build_stage') {
      latest = block
      break
    }
  }
  if (latest?.stage === stage) return blocks
  if (stage === null && latest === undefined) return blocks
  return [...blocks, { type: 'build_stage', stage }]
}

function latestTaskConfirmRequestIdFromMessages(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index]?.blocks ?? []
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]
      if (block?.type === 'task_confirm') return block.requestId
    }
  }
  return null
}

/** Infer pre-Build history from a hydrated transcript without hiding its live parked review. */
function hydratedBuildEntryBoundary(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index]?.blocks ?? []
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]
      if (block?.type !== 'task_confirm') continue
      return block.status === 'pending' ? null : block.requestId
    }
  }
  return null
}

/** Latest task review visible before a live Build entry; used as its history boundary. */
function latestTaskConfirmRequestId(get: Getter, sessionId: string): string | null {
  const streaming = get(streamingFamily(sessionId))
  if (streaming) {
    for (let index = streaming.blocks.length - 1; index >= 0; index -= 1) {
      const block = streaming.blocks[index]
      if (block?.type === 'task_confirm') return block.requestId
    }
  }
  return latestTaskConfirmRequestIdFromMessages(get(messageFamily(sessionId)))
}

function discardCodePoints(text: string, count: number): string {
  if (count <= 0) return text
  const points = Array.from(text)
  return points.slice(0, Math.max(0, points.length - count)).join('')
}

function discardModelAttemptDeltas(
  blocks: MessageBlock[],
  textChars: number,
  reasoningChars: number,
): MessageBlock[] {
  let remainingText = textChars
  let remainingReasoning = reasoningChars
  const next = [...blocks]
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const block = next[index]
    if (!block || (block.type !== 'text' && block.type !== 'thinking')) continue
    const remaining = block.type === 'text' ? remainingText : remainingReasoning
    if (remaining <= 0) continue
    const blockLength = Array.from(block.text).length
    if (remaining >= blockLength) {
      next.splice(index, 1)
      if (block.type === 'text') remainingText -= blockLength
      else remainingReasoning -= blockLength
    } else {
      next[index] = { ...block, text: discardCodePoints(block.text, remaining) }
      if (block.type === 'text') remainingText = 0
      else remainingReasoning = 0
    }
    if (remainingText === 0 && remainingReasoning === 0) break
  }
  return next
}

type WorkflowConfirmBlock = Extract<MessageBlock, { type: 'workflow_confirm' }>
type TaskConfirmBlock = Extract<MessageBlock, { type: 'task_confirm' }>
type BuildConfirmBlock = Extract<MessageBlock, { type: 'build_confirm' }>
type ConfirmationBlock = Extract<MessageBlock, { type: 'confirmation' }>

/** Retain the current reply so the resumed Agent run continues the same bubble. */
export const prepareInteractionContinuationAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string
      confirmation?: Omit<ConfirmationBlock, 'type'>
    },
  ) => {
    const { sessionId, confirmation } = payload
    const streaming = get(streamingFamily(sessionId))
    const messages = get(messageFamily(sessionId))
    const lastMessage = messages[messages.length - 1]
    const sourceMessage = lastMessage?.role === AgentRole.Assistant ? lastMessage : undefined
    if (!streaming && !sourceMessage && !confirmation) return

    let blocks = [...(streaming?.blocks ?? sourceMessage?.blocks ?? [])]
    if (confirmation) {
      const question = confirmation.question.trim()
      if (question) {
        for (let index = blocks.length - 1; index >= 0; index -= 1) {
          const block = blocks[index]
          if (block?.type !== 'text') continue
          const text = block.text.trimEnd()
          if (text.endsWith(question)) {
            const remaining = text.slice(0, -question.length).trimEnd()
            blocks = remaining
              ? [...blocks.slice(0, index), { type: 'text', text: remaining }, ...blocks.slice(index + 1)]
              : [...blocks.slice(0, index), ...blocks.slice(index + 1)]
          }
          break
        }
      }
      blocks.push({ type: 'confirmation', ...confirmation })
    }

    const textBlocks = blocks.filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
    const thinkingBlocks = blocks.filter((block): block is Extract<MessageBlock, { type: 'thinking' }> => block.type === 'thinking')
    const toolBlocks = blocks.filter((block): block is Extract<MessageBlock, { type: 'tool' }> => block.type === 'tool')
    set(continuationFamily(sessionId), {
      sourceMessageId: streaming?.messageId ?? sourceMessage?.id,
      content: textBlocks.map((block) => block.text).join('\n\n'),
      thinking: thinkingBlocks.map((block) => block.text).join('\n\n') || undefined,
      toolCalls: toolBlocks.map(({ type: _type, ...call }) => call),
      blocks,
      // REST transcript `createdAt` is a stable ordering sequence, not an epoch
      // timestamp. A resumed interaction starts a new live execution segment,
      // so only preserve an actually live stream's clock.
      startedAt: streaming?.startedAt ?? Date.now(),
    })
  },
)

export const updateTaskConfirmBlockAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string
      requestId: string
      patch: Partial<TaskConfirmBlock>
    },
  ) => {
    const { sessionId, requestId, patch } = payload
    const update = (blocks: MessageBlock[]): MessageBlock[] =>
      blocks.map((block) =>
        block.type === 'task_confirm' && block.requestId === requestId
          ? { ...block, ...patch }
          : block,
      )
    const streaming = get(streamingFamily(sessionId))
    if (streaming) {
      set(streamingFamily(sessionId), { ...streaming, blocks: update(streaming.blocks) })
    }
    set(
      messageFamily(sessionId),
      get(messageFamily(sessionId)).map((message) => ({
        ...message,
        blocks: message.blocks ? update(message.blocks) : message.blocks,
      })),
    )
  },
)

export const updateBuildConfirmBlockAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string
      requestId: string
      patch: Partial<BuildConfirmBlock>
    },
  ) => {
    const { sessionId, requestId, patch } = payload
    const update = (blocks: MessageBlock[]): MessageBlock[] =>
      blocks.map((block) =>
        block.type === 'build_confirm' && block.requestId === requestId
          ? { ...block, ...patch }
          : block,
      )
    const streaming = get(streamingFamily(sessionId))
    if (streaming) {
      set(streamingFamily(sessionId), { ...streaming, blocks: update(streaming.blocks) })
    }
    set(
      messageFamily(sessionId),
      get(messageFamily(sessionId)).map((message) => ({
        ...message,
        blocks: message.blocks ? update(message.blocks) : message.blocks,
      })),
    )
  },
)

function updateWorkflowConfirmBlocks(
  blocks: MessageBlock[],
  requestId: string,
  patch: Partial<WorkflowConfirmBlock>,
): MessageBlock[] {
  return blocks.map((b) =>
    b.type === 'workflow_confirm' && b.requestId === requestId ? { ...b, ...patch } : b,
  )
}

export const updateWorkflowConfirmBlockAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string
      requestId: string
      patch: Partial<WorkflowConfirmBlock>
    },
  ) => {
    const { sessionId, requestId, patch } = payload
    const streaming = get(streamingFamily(sessionId))
    if (streaming) {
      set(streamingFamily(sessionId), {
        ...streaming,
        blocks: updateWorkflowConfirmBlocks(streaming.blocks, requestId, patch),
      })
    }
    set(
      messageFamily(sessionId),
      get(messageFamily(sessionId)).map((msg) => ({
        ...msg,
        blocks: msg.blocks ? updateWorkflowConfirmBlocks(msg.blocks, requestId, patch) : msg.blocks,
      })),
    )
  },
)

/** Derived: the committed messages of the currently selected session */
export const currentMessagesAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  return id ? get(messageFamily(id)) : []
})

/** Derived: the currently selected session's streaming state (undefined = not streaming) */
export const currentStreamingAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  return id ? get(streamingFamily(id)) : undefined
})

/** Browser tools that visibly change the page, tab, or interaction state.
 * Keep this exhaustive subset aligned with `src/amphi_agent/tools/_browser.py`;
 * observation, export, recording, and invisible context-control tools do not
 * bring the Browser surface forward. */
const BROWSER_ACTION_TOOL_NAMES = new Set([
  'browser_open',
  'browser_close',
  'browser_click',
  'browser_input',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_scroll',
  'browser_key',
  'browser_search',
  'browser_new_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_scroll_to_text',
  'browser_hover',
  'browser_focus',
  'browser_select',
  'browser_check',
  'browser_uncheck',
  'browser_fill_form',
  'browser_scroll_to_ref',
  'browser_double_click',
  'browser_upload_file',
  'browser_drag',
  'browser_evaluate_javascript',
  'browser_evaluate_javascript_on_ref',
  'browser_type_text',
  'browser_key_down',
  'browser_key_up',
  'browser_mouse_click',
  'browser_mouse_move',
  'browser_mouse_drag',
  'browser_mouse_down',
  'browser_mouse_up',
  'browser_resize',
])

/** Whether a tool is an Agent-controlled Browser operation visible to the user. */
export function isBrowserAgentActionToolName(name: string): boolean {
  return BROWSER_ACTION_TOOL_NAMES.has(name)
}

/** True only while the Agent has an unresolved call into the internal Browser tool family. */
export const currentBrowserAgentActiveAtom = atom((get) => (
  get(currentStreamingAtom)?.toolCalls.some(
    (call) => isBrowserAgentActionToolName(call.name) && call.result === undefined,
  ) ?? false
))

/** PowerPoint tools that visibly change the live presentation surface. */
const POWERPOINT_ACTION_TOOL_NAMES = new Set([
  'view_ppt',
  'update_ppt_page',
  'insert_ppt_page',
  'remove_ppt_page',
  'move_ppt_page',
  'goto_ppt_page',
])

/** Whether a tool is an Agent-controlled PowerPoint operation visible to the user. */
export function isPowerPointAgentActionToolName(name: string): boolean {
  return POWERPOINT_ACTION_TOOL_NAMES.has(name)
}

/** True only while the Agent has an unresolved visible PowerPoint operation. */
export const currentPowerPointAgentActiveAtom = atom((get) => (
  get(currentStreamingAtom)?.toolCalls.some(
    (call) => isPowerPointAgentActionToolName(call.name) && call.result === undefined,
  ) ?? false
))

/** The selected logical Turn is durably parked while blocking Child Agents run. */
export const currentWaitingForSubagentsAtom = atom((get) => {
  const liveSubagents = get(subagentsAtom)
  const tail = get(currentMessagesAtom).findLast(
    (message) => message.role === AgentRole.Assistant,
  )
  return tail
    ? isParentWaitingForSubagents(tail.blocks ?? [], liveSubagents, tail.turnStatus)
    : false
})

/** UI-level activity spans both live model streaming and blocking Child waits. */
export const currentAgentRunningAtom = atom(
  (get) => get(currentStreamingAtom) !== undefined || get(currentWaitingForSubagentsAtom),
)

/** Derived: whether the current tail Turn is parked on a permission approval. */
export const hasPendingPermissionAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  return sessionId
    ? pendingFrameworkInteractionForSession(get, sessionId)?.type === 'permission'
    : false
})

/** A task review parks Clarify until the card is confirmed or returned for revision. */
export const hasPendingTaskConfirmAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  return sessionId
    ? pendingFrameworkInteractionForSession(get, sessionId)?.type === 'task_confirm'
    : false
})

/** A Build proposal parks Main until the dedicated card is answered. */
export const hasPendingBuildConfirmAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  return sessionId
    ? pendingFrameworkInteractionForSession(get, sessionId)?.type === 'build_confirm'
    : false
})

export type PendingFrameworkInteraction = Extract<
  MessageBlock,
  { type: 'permission' | 'build_confirm' | 'task_confirm' | 'workflow_confirm' }
>

type DirectReplyConfirmation = Exclude<PendingFrameworkInteraction, { type: 'permission' }>

function pendingFrameworkInteractionForSession(
  get: Getter,
  sessionId: string,
): PendingFrameworkInteraction | null {
  const streaming = get(streamingFamily(sessionId))
  const messages = get(messageFamily(sessionId))
  let blocks: MessageBlock[]
  if (streaming) {
    blocks = streaming.blocks
  } else {
    const tail = messages[messages.length - 1]
    if (!tail || tail.role !== AgentRole.Assistant) return null
    blocks = tail.blocks ?? []
  }
  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = blocks[blockIndex]
    if (block?.type === 'permission') return block.decided ? null : block
    if (
      block?.type === 'build_confirm' ||
      block?.type === 'task_confirm' ||
      block?.type === 'workflow_confirm'
    ) {
      return (block.status ?? 'pending') === 'pending' ? block : null
    }
    if (block?.type === 'confirmation') return null
  }
  return null
}

/** Pending framework-owned interaction on the active Session's durable tail.
 *
 * A Session can park only its current logical Turn. Never search older
 * transcript messages: after a reply replaces the current card, doing so would
 * resurrect a stale pending card from history. Completed blocks remain in the
 * process timeline as compact read-only records.
 */
export const currentPendingFrameworkInteractionAtom = atom(
  (get): PendingFrameworkInteraction | null => {
    const sessionId = get(activeSessionIdAtom)
    return sessionId ? pendingFrameworkInteractionForSession(get, sessionId) : null
  },
)

/** Optimistically mark the approval card as decided (the moment allow/deny is clicked) —
 *  set `decided=true` on the permission block matching requestId and write
 *  decision/instruction per item. This both makes the card show its terminal state
 *  immediately, and keeps it terminal rather than falling back to the button state after
 *  the resumed openTurn commits (streaming→message, component remount). Patches both the
 *  streaming and the committed copies. */
export const markPermissionDecidedAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string
      requestId: string
      decisions: { callIndex: number; allow: boolean; instruction?: string }[]
    },
  ) => {
    const { sessionId, requestId, decisions } = payload
    const byIndex = new Map(decisions.map((d) => [d.callIndex, d]))
    const patch = (blocks: MessageBlock[]): MessageBlock[] =>
      blocks.map((b) => {
        if (
          b.type !== 'permission' ||
          b.requestId !== requestId
        ) return b
        return {
          ...b,
          decided: true,
          items: b.items.map((it) => {
            const d = byIndex.get(it.callIndex)
            if (!d) return it
            return { ...it, decision: d.allow ? 'allow' : 'deny', instruction: d.instruction ?? null }
          }),
        }
      })
    const streaming = get(streamingFamily(sessionId))
    if (streaming) set(streamingFamily(sessionId), { ...streaming, blocks: patch(streaming.blocks) })
    set(
      messageFamily(sessionId),
      get(messageFamily(sessionId)).map((m) => (m.blocks ? { ...m, blocks: patch(m.blocks) } : m)),
    )
  },
)

/** Derived: the currently selected session's two-level think position `{mode, stage}` (null = unknown / no history). */
export const currentThinkingModeAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  return id ? get(thinkingModeFamily(id)) : null
})

/** Derived: current Session's active saved Workflow projection. */
export const currentWorkflowRunAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  return id ? get(workflowRunFamily(id)) : undefined
})

/** Derived: whether the center view is in the "conversation state" (Pipeline) rather than Landing.
 *
 *  The criterion is "is the current session a draft", not "are there any messages":
 *    - draft (in _draftIds) = the user hasn't sent any message yet → Landing
 *    - non-draft = already materialized, the daemon definitely has history → Pipeline
 *  The key point: when switching to a non-draft session, currentMessages is briefly []
 *  (5~50ms) because loadMessages is async, but that must never be taken as a reason to
 *  fall back to Landing — otherwise the workflow marketplace cards flash on every session
 *  switch. So as long as active is a non-draft session it counts as the conversation view,
 *  regardless of whether the messages have loaded. */
export const hasConversationAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  return (
    get(currentMessagesAtom).length > 0 ||
    get(currentStreamingAtom) !== undefined ||
    (id != null && !get(activeIsDraftAtom))
  )
})


/** Map a wire `ChatBlock` to the renderer's `MessageBlock` (text uses `text`,
 *  not `value`; mention / slash pass through) — for optimistic user bubbles. */
function chatBlockToMessageBlock(block: ChatBlock): MessageBlock {
  if (block.type === 'text') return { type: 'text', text: block.value }
  if (block.type === 'mention') return { type: 'mention', id: block.id, label: block.label, group: block.group }
  return { type: 'slash', id: block.id, label: block.label, ...(block.resource ? { resource: block.resource } : {}) }
}

/**
 * Optimistic: append user message, materialize draft session, then IPC send.
 *
 * Caller: the composer's FreeFormInput submitMessage().
 */
export const appendUserMessageAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string
      text: string
      blocks?: ChatBlock[]
    },
  ) => {
    const { sessionId, text } = payload
    const now = Date.now()
    // A reply to request_human resumes the same Session Turn. Keep the prior
    // assistant process and fold this completed interaction into it; the next
    // message_start will continue that one logical reply.
    const pending = get(pendingBySessionAtom).get(sessionId)
    const frameworkInteraction = pending
      ? null
      : pendingFrameworkInteractionForSession(get, sessionId)
    const confirmation = frameworkInteraction?.type === 'permission'
      ? null
      : frameworkInteraction
    if (pending) {
      const acceptanceMessage = pending.kind === 'accept_rule'
      const question = acceptanceMessage
        ? i18n.t('session.interaction.card.acceptRuleDeferredTitle')
        : pending.questions
            .map((q) => q.question)
            .filter(Boolean)
            .join('\n\n')
      set(prepareInteractionContinuationAtom, {
        sessionId,
        confirmation: {
          ...(pending.prompt ? { prompt: pending.prompt } : {}),
          question,
          response: text,
          ...(acceptanceMessage ? { kind: 'accept_rule_message' as const } : {}),
        },
      })
      // The daemon resumes the parked tail Turn. For acceptance review this
      // records an explicit "not answered; new message received" tool result.
      set(clearSessionHumanRequestAtom, sessionId)
      set(markSessionAnsweredAtom, sessionId)
    } else if (confirmation) {
      const questionByType: Record<DirectReplyConfirmation['type'], string> = {
        build_confirm: i18n.t('session.interaction.card.buildTitle'),
        task_confirm: i18n.t('session.interaction.card.taskTitle'),
        workflow_confirm: i18n.t('session.interaction.card.workflowTitle'),
      }
      const replacement: ConfirmationBlock = {
        type: 'confirmation',
        kind: 'confirmation_message',
        question: questionByType[confirmation.type],
        response: text,
      }
      const replace = (blocks: MessageBlock[]): MessageBlock[] =>
        blocks.map((block) =>
          block.type === confirmation.type &&
          'requestId' in block &&
          block.requestId === confirmation.requestId
            ? replacement
            : block,
        )
      const streaming = get(streamingFamily(sessionId))
      if (streaming) {
        set(streamingFamily(sessionId), { ...streaming, blocks: replace(streaming.blocks) })
      }
      set(
        messageFamily(sessionId),
        get(messageFamily(sessionId)).map((message) => (
          message.blocks ? { ...message, blocks: replace(message.blocks) } : message
        )),
      )
      set(prepareInteractionContinuationAtom, { sessionId })
      set(markSessionAnsweredAtom, sessionId)
    }
    if (!pending && !confirmation) {
      const userMsg: AgentMessage = {
        id: `u-${crypto.randomUUID()}`,
        role: AgentRole.User,
        text,
        toolCalls: [],
        // Optimistically show the @ badges immediately (ChatBlock → MessageBlock, see chatBlockToMessageBlock).
        blocks: (payload.blocks ?? []).map(chatBlockToMessageBlock),
        done: true,
        createdAt: now,
      }
      appendMessage(get, set, sessionId, userMsg)
    }
    // Normal input is shown optimistically; input typed while an interaction is pending
    // goes into the original Agent Turn's continuation confirmation and generates no
    // extra user bubble.
    // Sending invalidates this session's draft (so a remount doesn't re-seed the input
    // box with the old text that was just sent).
    // Use submit rather than clear: the composer's write-back is asynchronous
    // (useDraftSync's 300ms debounce + the session-switch flush, and FreeFormInput only
    // calls setSegments(EMPTY) after onSubmit), so a plain one-off delete would be
    // resurrected by the write-back that follows — and a new session would then also go
    // through replaceDraftWithDaemonId to migrate it onto the daemon id, so the text just
    // sent shows up in the input box again.
    set(submitSessionDraftAtom, { id: sessionId, text })
    // `/build` now runs on the daemon (the backend's real build pipeline), so it
    // is NOT intercepted here — it falls through to the real-chat path below.
    // Real chat: ensure a daemon session (the source of truth), then stream the
    // turn against its id. Dynamic import keeps WS out of this file's static
    // graph (bun:test friendly).
    const endpoint = get(backendEndpointAtom)
    if (!endpoint || !endpoint.token) {
      set(applyAgentEventAtom, {
        sessionId,
        event: { type: 'error', message: i18n.t('error.gatewayUnavailableForChat') },
      })
      return
    }
    void (async () => {
      let sid = sessionId
      // Draft → materialize to a daemon session (migrates the optimistic user
      // message + sidebar id over). Already-materialized sessions stream directly.
      if (get(draftSessionIdsAtom).has(sessionId)) {
        // Mark the slot busy: until the id swap lands, its optimistic message is the
        // only copy of what the user sent (see resetDraftSlot).
        draftSendsInFlight.add(sessionId)
        try {
          sid = await materializeToDaemon(get, set, sessionId)
        } catch (err: unknown) {
          set(applyAgentEventAtom, {
            sessionId,
            event: {
              type: 'error',
              message: err instanceof Error ? err.message : i18n.t('error.sessionCreateFailed'),
            },
          })
          return
        } finally {
          draftSendsInFlight.delete(sessionId)
        }
      }
      // Single persistent WS (configured by use-ws-connection.ts); it dispatches
      // demuxed events into applyAgentEventAtom itself, so no `set` is threaded.
      const m = await import('@/lib/amphiWsConnection')
      // Structured blocks are the input truth — the daemon walks them to
      // inline-resolve @mention paths in order; `text` is the clean display form.
      m.getAmphiWsConnection().chat(sid, text, payload.blocks ?? [])
    })()
  },
)

/** Ensure `sessionId` exists on the daemon: a draft is materialized (POST
 *  /sessions, sidebar id + optimistic messages migrate) and the daemon id is
 *  returned; an already-real session returns its id unchanged. `null` when
 *  creation failed (daemon unreachable). Used by flows that need a daemon
 *  session BEFORE the first chat — e.g. mounting local paths. */
export const ensureDaemonSessionAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<string | null> => {
    if (!get(draftSessionIdsAtom).has(sessionId)) return sessionId
    try {
      return await materializeToDaemon(get, set, sessionId)
    } catch (err: unknown) {
      rlog.warn('[agent] ensureDaemonSession failed', { sessionId, err })
      return null
    }
  },
)

/**
 * Reducer: covers every AgentEvent variant.
 *
 * Immutable update pattern (new Set / new Array) — follows coding-style's "no mutation"
 * so Jotai dispatches rerenders correctly. Each case writes only the family atom of its
 * own session, no longer cloning the whole table/Map.
 *
 * task_spawn / task_complete are accepted but leave the atom unchanged for now (phase one
 * doesn't render sub-tasks).
 */
export const applyAgentEventAtom = atom(
  null,
  (get, set, payload: AgentEventPayload) => {
    const { sessionId, event } = payload
    switch (event.type) {
      case 'message_start': {
        set(liveRevisionFamily(sessionId), get(liveRevisionFamily(sessionId)) + 1)
        const prev = get(streamingFamily(sessionId))
        let continuation = get(continuationFamily(sessionId))
        if (!continuation && !prev) {
          const messages = get(messageFamily(sessionId))
          const last = messages[messages.length - 1]
          const resumesSubagent =
            last?.role === AgentRole.Assistant &&
            (last.blocks ?? []).some((block) => block.type === 'subagent')
          if (resumesSubagent) {
            set(prepareInteractionContinuationAtom, { sessionId })
            continuation = get(continuationFamily(sessionId))
          }
        }
        if (continuation) {
          if (continuation.sourceMessageId) {
            set(
              messageFamily(sessionId),
              get(messageFamily(sessionId)).filter(
                (message) => message.id !== continuation.sourceMessageId,
              ),
            )
          }
          set(continuationFamily(sessionId), undefined)
          set(streamingFamily(sessionId), {
            messageId: event.messageId,
            content: continuation.content,
            thinking: continuation.thinking,
            toolCalls: continuation.toolCalls,
            blocks: continuation.blocks,
            startedAt: continuation.startedAt,
          })
          return
        }
        if (prev && !isEmptyStreaming(prev)) {
          commitFinalMessage(get, set, sessionId, finalizeStreaming(prev, undefined, undefined))
        }
        set(streamingFamily(sessionId), {
          messageId: event.messageId,
          content: '',
          toolCalls: [],
          blocks: [],
          startedAt: Date.now(),
        })
        return
      }
      case 'text_delta': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        set(streamingFamily(sessionId), {
          ...cur,
          content: cur.content + event.text,
          blocks: appendDelta(cur.blocks, 'text', event.text),
          retry: undefined,
        })
        return
      }
      case 'thinking_delta': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        set(streamingFamily(sessionId), {
          ...cur,
          thinking: (cur.thinking ?? '') + event.text,
          blocks: appendDelta(cur.blocks, 'thinking', event.text),
          retry: undefined,
        })
        return
      }
      case 'model_retry': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        const discardText = event.active ? event.discardTextChars : 0
        const discardReasoning = event.active ? event.discardReasoningChars : 0
        const thinking = discardReasoning > 0
          ? discardCodePoints(cur.thinking ?? '', discardReasoning)
          : cur.thinking
        set(streamingFamily(sessionId), {
          ...cur,
          content: discardText > 0
            ? discardCodePoints(cur.content, discardText)
            : cur.content,
          thinking: thinking || undefined,
          blocks: discardText > 0 || discardReasoning > 0
            ? discardModelAttemptDeltas(cur.blocks, discardText, discardReasoning)
            : cur.blocks,
          retry: event.active
            ? {
                attempt: event.attempt,
                maxRetries: event.maxRetries,
                delaySeconds: event.delaySeconds,
              }
            : undefined,
        })
        return
      }
      case 'context_compaction': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        set(streamingFamily(sessionId), {
          ...cur,
          compacting: event.active || undefined,
        })
        return
      }
      case 'context_usage': {
        set(contextUsageFamily(sessionId), event.usage)
        return
      }
      case 'tool_call': {
        if (isBrowserAgentActionToolName(event.toolName)) {
          const position = get(thinkingModeFamily(sessionId))
          set(notifySessionWorkbenchActivityAtom, {
            agentModeHasPriority: position?.mode === 'build'
              || position?.mode === 'run_workflow',
            sessionId,
            surface: SessionWorkbenchSurface.Browser,
          })
        } else if (isPowerPointAgentActionToolName(event.toolName)) {
          const position = get(thinkingModeFamily(sessionId))
          set(notifySessionWorkbenchActivityAtom, {
            agentModeHasPriority: position?.mode === 'build'
              || position?.mode === 'run_workflow',
            sessionId,
            surface: SessionWorkbenchSurface.Presentation,
          })
        }
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        const launchedChildren: AgentMessageSubagent[] = [...get(subagentsAtom).values()]
          .filter((child) => child.parentToolCallId === event.toolUseId)
          .map((child) => ({
            invocationId: child.invocationId,
            goal: child.goal,
            status: child.status,
            answer: child.answer,
            error: child.error,
          }))
        const launchedIds = new Set(launchedChildren.map((child) => child.invocationId))
        if (launchedIds.size) {
          set(messageFamily(sessionId), get(messageFamily(sessionId)).flatMap((message) => {
            const blocks = (message.blocks ?? []).filter(
              (block) => block.type !== 'subagent' || !launchedIds.has(block.invocationId),
            )
            if (!blocks.length && !message.text && message.id.startsWith('subagent:')) return []
            return blocks.length === (message.blocks ?? []).length ? [message] : [{ ...message, blocks }]
          }))
        }
        set(streamingFamily(sessionId), {
          ...cur,
          toolCalls: [
            ...cur.toolCalls,
            {
              toolUseId: event.toolUseId,
              name: event.toolName,
              input: event.input,
              ...(launchedChildren.length ? { subagents: launchedChildren } : {}),
            },
          ],
          blocks: [
            ...cur.blocks.filter(
              (block) => block.type !== 'subagent' || !launchedIds.has(block.invocationId),
            ),
            {
              type: 'tool',
              toolUseId: event.toolUseId,
              name: event.toolName,
              input: event.input,
              ...(launchedChildren.length ? { subagents: launchedChildren } : {}),
            },
          ],
        })
        return
      }
      case 'tool_result': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        set(streamingFamily(sessionId), {
          ...cur,
          toolCalls: cur.toolCalls.map((tc) =>
            tc.toolUseId === event.toolUseId
              ? {
                  ...tc,
                  result: {
                    output: event.output,
                    isError: event.isError,
                    durationMs: event.durationMs,
                  },
                }
              : tc,
          ),
          blocks: cur.blocks.map((b) =>
            b.type === 'tool' && b.toolUseId === event.toolUseId
              ? {
                  ...b,
                  result: {
                    output: event.output,
                    isError: event.isError,
                    durationMs: event.durationMs,
                  },
                }
              : b,
          ),
        })
        return
      }
      case 'workflow_progress': {
        const previousRun = get(workflowRunFamily(sessionId))
        const continuingWorkflow = previousRun?.generation === event.generation
        set(workflowRunFamily(sessionId), {
          workflowId: event.workflowId,
          generation: event.generation,
          workflowName: event.workflowName,
          sourceSessionId: sessionId,
          phase: event.phase,
          stepIndex: event.stepIndex,
          executionSteps: event.executionSteps
            ?? (continuingWorkflow ? previousRun.executionSteps : []),
          validationSteps: event.validationSteps
            ?? (continuingWorkflow ? previousRun.validationSteps : []),
        })
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        let found = false
        const blocks = cur.blocks.map((block) => {
          if (
            block.type !== 'workflow_step' ||
            block.workflowId !== event.workflowId ||
            block.generation !== event.generation ||
            block.phase !== event.phase ||
            block.stepIndex !== event.stepIndex
          ) return block
          found = true
          return {
            ...block,
            workflowName: event.workflowName,
            stepCount: event.stepCount,
            title: event.title,
            status: event.status,
            summary: event.summary ?? null,
            executionSteps: event.executionSteps ?? block.executionSteps,
            validationSteps: event.validationSteps ?? block.validationSteps,
          }
        })
        set(streamingFamily(sessionId), {
          ...cur,
          blocks: found ? blocks : [...blocks, {
            type: 'workflow_step',
            workflowId: event.workflowId,
            generation: event.generation,
            workflowName: event.workflowName,
            phase: event.phase,
            stepIndex: event.stepIndex,
            stepCount: event.stepCount,
            title: event.title,
            status: event.status,
            summary: event.summary ?? null,
            ...(event.executionSteps ? { executionSteps: event.executionSteps } : {}),
            ...(event.validationSteps ? { validationSteps: event.validationSteps } : {}),
          }],
        })
        return
      }
      case 'workflow_result': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        const block: MessageBlock = {
          type: 'workflow_result',
          runId: event.runId,
          workflowId: event.workflowId,
          workflowName: event.workflowName,
          status: event.status,
          validationStatus: event.validationStatus,
          createdAt: event.createdAt,
          ...(event.resultFileCount === undefined
            ? {}
            : { resultFileCount: event.resultFileCount }),
          summary: event.summary ?? null,
        }
        const existing = cur.blocks.findIndex(
          (candidate) => candidate.type === 'workflow_result' && candidate.runId === event.runId,
        )
        set(streamingFamily(sessionId), {
          ...cur,
          blocks: existing >= 0
            ? cur.blocks.map((candidate, index) => index === existing ? block : candidate)
            : [...cur.blocks, block],
        })
        return
      }
      case 'subagent_event': {
        if (TERMINAL_SUBAGENT_STATUSES.has(event.status)) {
          set(bumpSessionCompletionAtom, event.invocationId)
        }
        set(applySubagentEventAtom, {
          invocationId: event.invocationId,
          parentSessionId: sessionId,
          parentToolCallId: event.parentToolCallId,
          mode: event.mode,
          goal: event.goal,
          status: event.status,
          phase: event.phase,
          answer: event.answer,
          error: event.error,
        })
        if (event.mode === 'background') {
          void set(hydrateSessionsFromDaemonAtom).catch((err: unknown) => {
            rlog.warn('[agent] failed to refresh background Child Session', {
              invocationId: event.invocationId,
              err,
            })
          })
          return
        }
        const mergeNested = (children: AgentMessageSubagent[] | undefined): AgentMessageSubagent[] => {
          const child = children?.find((item) => item.invocationId === event.invocationId)
          const next = {
            invocationId: event.invocationId,
            goal: event.goal || child?.goal || '',
            status: event.status,
            answer: event.answer ?? child?.answer,
            error: event.error ?? child?.error,
          }
          return child
            ? (children ?? []).map((item) => item.invocationId === event.invocationId ? next : item)
            : [...(children ?? []), next]
        }

        const parentToolCallId = event.parentToolCallId
        const streaming = get(streamingFamily(sessionId))
        if (parentToolCallId && streaming?.toolCalls.some((call) => call.toolUseId === parentToolCallId)) {
          set(streamingFamily(sessionId), {
            ...streaming,
            toolCalls: streaming.toolCalls.map((call) => call.toolUseId === parentToolCallId
              ? { ...call, subagents: mergeNested(call.subagents) }
              : call),
            blocks: streaming.blocks.map((block) => block.type === 'tool' && block.toolUseId === parentToolCallId
              ? { ...block, subagents: mergeNested(block.subagents) }
              : block),
          })
          return
        }

        if (parentToolCallId) {
          let nested = false
          const messages = get(messageFamily(sessionId)).map((message) => {
            const contains = message.toolCalls.some((call) => call.toolUseId === parentToolCallId)
            if (!contains) return message
            nested = true
            return {
              ...message,
              toolCalls: message.toolCalls.map((call) => call.toolUseId === parentToolCallId
                ? { ...call, subagents: mergeNested(call.subagents) }
                : call),
              blocks: (message.blocks ?? []).map((block) => block.type === 'tool' && block.toolUseId === parentToolCallId
                ? { ...block, subagents: mergeNested(block.subagents) }
                : block),
            }
          })
          if (nested) {
            set(messageFamily(sessionId), messages)
            return
          }
        }

        const update = (blocks: MessageBlock[]): { blocks: MessageBlock[]; found: boolean } => {
          let found = false
          const next = blocks.map((block) => {
            if (block.type !== 'subagent' || block.invocationId !== event.invocationId) return block
            found = true
            return {
              ...block,
              goal: event.goal || block.goal,
              status: event.status,
              answer: event.answer ?? block.answer,
              error: event.error ?? block.error,
            }
          })
          return { blocks: next, found }
        }

        if (streaming) {
          const updated = update(streaming.blocks)
          set(streamingFamily(sessionId), {
            ...streaming,
            blocks: updated.found || event.phase !== 'started'
              ? updated.blocks
              : [...updated.blocks, {
                  type: 'subagent',
                  invocationId: event.invocationId,
                  goal: event.goal,
                  status: event.status,
                  answer: event.answer,
                  error: event.error,
                }],
          })
          return
        }

        const messages = get(messageFamily(sessionId))
        let found = false
        const updatedMessages = messages.map((message) => {
          const updated = update(message.blocks ?? [])
          found ||= updated.found
          return updated.found ? { ...message, blocks: updated.blocks } : message
        })
        if (found) {
          set(messageFamily(sessionId), updatedMessages)
        } else if (event.phase === 'started') {
          appendMessage(get, set, sessionId, {
            id: `subagent:${event.invocationId}`,
            role: AgentRole.Assistant,
            text: '',
            toolCalls: [],
            blocks: [{
              type: 'subagent',
              invocationId: event.invocationId,
              goal: event.goal,
              status: event.status,
              error: event.error,
            }],
            done: true,
            createdAt: Date.now(),
          })
        }
        return
      }
      case 'stream_discard': {
        set(streamingFamily(sessionId), undefined)
        set(continuationFamily(sessionId), undefined)
        return
      }
      case 'message_stop': {
        // The key commit: streamingState → messageFamily[sessionId], then clear streaming.
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        // An empty turn is not committed: while request_human is pending (the tool frame
        // was intercepted and the model said nothing) the streaming state holds nothing at
        // all, and committing would only leave an empty assistant bubble — the daemon's
        // transcript hydration skips empty bubbles too, and live and reload must look identical.
        if (isEmptyStreaming(cur)) {
          set(streamingFamily(sessionId), undefined)
          return
        }
        commitFinalMessage(
          get,
          set,
          sessionId,
          finalizeStreaming(cur, undefined, event.finalAnswer, {
            durationMs: event.durationMs,
            completedAt: event.completedAt,
          }),
        )
        return
      }
      case 'done': {
        if (event.reason === 'cancelled') {
          const msgs = get(messageFamily(sessionId))
          const index = msgs.findIndex(
            (message) => message.id === event.messageId && message.role === AgentRole.Assistant,
          )
          if (index >= 0) {
            set(messageFamily(sessionId), [
              ...msgs.slice(0, index),
              { ...msgs[index]!, stopped: true },
              ...msgs.slice(index + 1),
            ])
          } else {
            appendMessage(get, set, sessionId, {
              id: event.messageId,
              role: AgentRole.Assistant,
              text: '',
              toolCalls: [],
              blocks: [],
              done: true,
              stopped: true,
              finalAnswer: '',
              createdAt: Date.now(),
            })
          }
          return
        }
        // done(error) (or any reason added in the future) must never trigger an auto
        // rename — giving a failed conversation a "proper name" is wrong; the error itself
        // is rendered by the 'error' case below. Only a normal end_turn enters the
        // first-message naming logic.
        if (event.reason !== 'end_turn') return
        // end_turn: name the session from the first user message while its title is still
        // the default. The old implementation used msgs.length === 2 to detect the
        // "first round", but in the /build scenario one round emits 5 assistant messages →
        // length 6 → it never fired. Basing it on title-still-default is more general: the
        // first done(end_turn) in any scenario can rename. Once the rename is done the
        // title is no longer the default, so later dones don't rename again.
        const msgs = get(messageFamily(sessionId))
        const firstUser = msgs.find((m) => m.role === AgentRole.User)
        const session = get(sessionsMetaAtom).find((s) => s.id === sessionId)
        const defaultTitle = i18n.t('session.defaultTitle')
        // A session created under the other UI language keeps that locale's default
        // title, so recognition derives from BOTH catalogs (single source; relabeling
        // the default title can never silently break auto-rename).
        const isDefaultTitle = (title: string): boolean =>
          title === defaultTitle
          || title === i18n.t('session.defaultTitle', { lng: 'zh' })
          || title === i18n.t('session.defaultTitle', { lng: 'en' })
        if (firstUser && session && isDefaultTitle(session.title)) {
          const title = firstUser.text.trim().slice(0, SESSION_TITLE_MAX_LEN) || defaultTitle
          if (!isDefaultTitle(title)) {
            set(updateSessionTitleAtom, { id: sessionId, title })
          }
        }
        return
      }
      case 'error': {
        // Streaming in flight → commit the partial and mark it as an error. No streaming
        // state (failed outright with no token / session creation failed / a late error
        // after the turn already ended) → still land a pure error bubble, otherwise the
        // error only reaches the log and the UI stays blank (observed by the user: nothing
        // showed in the frontend on a WS 401 error).
        const cur = get(streamingFamily(sessionId))
        if (cur) {
          commitFinalMessage(get, set, sessionId, finalizeStreaming(cur, event.message))
        } else if (get(continuationFamily(sessionId))) {
          const continuation = get(continuationFamily(sessionId))!
          if (continuation.sourceMessageId) {
            set(
              messageFamily(sessionId),
              get(messageFamily(sessionId)).filter(
                (message) => message.id !== continuation.sourceMessageId,
              ),
            )
          }
          set(continuationFamily(sessionId), undefined)
          commitFinalMessage(
            get,
            set,
            sessionId,
            finalizeStreaming({
              messageId: continuation.sourceMessageId ?? `e-${crypto.randomUUID()}`,
              content: continuation.content,
              thinking: continuation.thinking,
              toolCalls: continuation.toolCalls,
              blocks: continuation.blocks,
              startedAt: continuation.startedAt,
            }, event.message),
          )
        } else {
          appendMessage(get, set, sessionId, {
            id: `e-${crypto.randomUUID()}`,
            role: AgentRole.Assistant,
            text: '',
            toolCalls: [],
            blocks: [],
            done: true,
            error: event.message,
            createdAt: Date.now(),
          })
        }
        rlog.error('[agent] error event', { sessionId, message: event.message })
        return
      }
      case 'command_error': {
        set(showToastAtom, event.message)
        rlog.warn('[agent] command rejected', { sessionId, message: event.message })
        return
      }
      case 'human_request': {
        // Daemon HITL (WS path): the turn paused for the user to pick from
        // options. Route to the human-request atom; HumanRequestBanner renders
        // it and replies through the normal chat path.
        set(setHumanRequestAtom, {
          sessionId,
          ...(event.prompt ? { prompt: event.prompt } : {}),
          questions: event.questions,
          requestId: event.requestId,
        })
        return
      }
      case 'accept_rule_request': {
        set(setHumanRequestAtom, {
          sessionId,
          kind: 'accept_rule',
          requestId: event.requestId,
          rules: event.rules,
          questions: acceptanceRuleQuestions(event.rules),
        })
        return
      }
      case 'build_confirm_request': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        set(streamingFamily(sessionId), {
          ...cur,
          blocks: [
            ...cur.blocks,
            {
              type: 'build_confirm',
              requestId: event.requestId,
              goal: event.goal,
              reason: event.reason ?? null,
              status: 'pending',
            },
          ],
        })
        return
      }
      case 'workflow_confirm_request': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        set(streamingFamily(sessionId), {
          ...cur,
          blocks: [
            ...cur.blocks,
            {
              type: 'workflow_confirm',
              requestId: event.requestId,
              defaultName: event.defaultName,
              summary: event.summary ?? null,
              operation: event.operation ?? 'create',
              workflowId: event.workflowId ?? null,
              status: 'pending',
            },
          ],
        })
        return
      }
      case 'task_confirm_request': {
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        set(streamingFamily(sessionId), {
          ...cur,
          blocks: [
            ...cur.blocks,
            {
              type: 'task_confirm',
              requestId: event.requestId,
              taskMarkdown: event.taskMarkdown,
              previousTaskMarkdown: event.previousTaskMarkdown ?? null,
              operation: event.operation ?? 'create',
              workflowId: event.workflowId ?? null,
              originalTaskMarkdown: event.originalTaskMarkdown ?? null,
              status: 'pending',
            },
          ],
        })
        return
      }
      case 'permission_request': {
        // Tool permission gate (WS path): attached to the current assistant message's
        // blocks, rendering the approval card inline (unlike human_request, which goes
        // through the banner). items carry each item's criteria + callIndex for card
        // rendering / the reply; requestId ties it to the parked turn and is used when
        // replying with permission_answer.
        const cur = get(streamingFamily(sessionId))
        if (!cur) return
        set(streamingFamily(sessionId), {
          ...cur,
          blocks: [
            ...cur.blocks,
            {
              type: 'permission',
              requestId: event.requestId,
              items: event.items,
              questions: event.questions,
            },
          ],
        })
        rlog.debug('[agent] permission_request received', {
          sessionId,
          requestId: event.requestId,
          items: event.items.length,
          tools: event.items.map((it) => it.tool),
        })
        return
      }
      case 'stage': {
        const previousPosition = get(thinkingModeFamily(sessionId))
        const runGeneration = get(workflowRunFamily(sessionId))?.generation
        set(syncSessionFocusPaneModeAtom, {
          sessionId,
          previousMode: previousPosition?.mode ?? null,
          nextMode: event.position.mode,
          ...(runGeneration ? { runGeneration } : {}),
        })
        set(syncBuildPresentationAtom, {
          sessionId,
          position: event.position,
          entryTaskConfirmRequestId: latestTaskConfirmRequestId(get, sessionId),
        })
        set(thinkingModeFamily(sessionId), event.position)
        if (event.position.mode !== 'run_workflow') {
          set(workflowRunFamily(sessionId), undefined)
        }
        const cur = get(streamingFamily(sessionId))
        if (cur) {
          const nextBlocks = appendBuildStageMarker(cur.blocks, event.position)
          if (nextBlocks !== cur.blocks) {
            set(streamingFamily(sessionId), { ...cur, blocks: nextBlocks })
          }
        }
        return
      }
      case 'title': {
        // Model-generated title from the daemon (first turn). Update the sidebar
        // meta live; it supersedes the done() truncated-opener fallback below,
        // which only fires while the title is still the default. bump:false
        // — a title change isn't activity, so it must not re-sort the session list.
        set(updateSessionTitleAtom, { id: sessionId, title: event.title, bump: false })
        return
      }
      case 'session_completed': {
        // Cross-session: this session's turn finished. Mark it unread (the
        // sidebar dot) unless it's the active session — see markSessionUnreadAtom.
        set(markSessionUnreadAtom, sessionId)
        // Neutral cross-cutting signal: bump so session-derived snapshots in
        // OTHER domains can invalidate (schedules re-fetch needs_action when a
        // resumed scheduled run finishes). No schedule import here — the reducer
        // stays domain-agnostic; the schedule hook subscribes. See Tier1 W2.
        set(bumpSessionCompletionAtom, sessionId)
        // Re-hydrate from the daemon so cross-session cards pick up the settled
        // scalar status. Best-effort: a transient GET /sessions failure is
        // logged, not fatal — the unread dot already updated synchronously above.
        void set(hydrateSessionsFromDaemonAtom).catch((err: unknown) => {
          rlog.warn('[agent] re-hydrate after session_completed failed', { sessionId, err })
        })
        void set(loadSessionMessagesAtom, sessionId).catch((err: unknown) => {
          rlog.warn('[agent] transcript refresh after session_completed failed', { sessionId, err })
        })
        return
      }
      case 'task_spawn':
      case 'task_complete':
        // Phase 1 YAGNI: subprocess won't emit these; reducer accepts but no-op
        rlog.debug('[agent] sub-agent event (phase 1 no-op)', { type: event.type })
        return
      default: {
        const _exhaustive: never = event
        void _exhaustive
      }
    }
  },
)

/**
 * Abort the in-flight daemon chat turn for a session (composer Stop button).
 *
 * Two halves, both required:
 * 1. local — `cancel(sessionId)` finalizes the partial bubble immediately
 *    and absorbs any residual frames (instant UI feedback);
 * 2. daemon — `POST /sessions/{id}/stop` cancels the agent task for real:
 *    the LLM stream is closed (token burn stops), running tools are killed,
 *    and the half-finished turn is discarded.
 *
 * No-op if nothing is streaming. Dynamic import matches the send path.
 */
export const cancelTurnAtom = atom(null, (get, _set, sessionId: string) => {
  void import('@/lib/amphiWsConnection').then((m) =>
    m.getAmphiWsConnection().cancel(sessionId),
  )
  const client = buildAmphiClient(get)
  void client?.stopSession(sessionId).catch((err: unknown) => {
    rlog.warn('[agent] daemon stopSession failed', { sessionId, err })
  })
})

/** Type helper re-export */
export type { AgentEvent }
