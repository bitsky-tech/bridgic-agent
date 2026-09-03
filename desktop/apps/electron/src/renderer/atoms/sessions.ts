/**
 * Session metadata + drafts + lifecycle action atoms.
 *
 * Data layering:
 *   - sessionsMetaAtom: lightweight metadata, used by the sidebar list
 *   - draftSessionIdsAtom: Set, a new conversation enters as a draft and is
 *     materialized after its first message
 *   - sessionDraftsAtom: per-session draft text (in-memory only, drafts are not persisted)
 *
 * Persistence: the daemon is the single source of truth for a session (the local
 * sessions.json/JSONL is deprecated):
 *   - Every time the daemon enters Ready (on startup + after a gateway restart)
 *     `hydrateSessionsFromDaemonAtom` fills the sidebar meta (id + title) from
 *     `GET /sessions`, merging so local draft rows are kept; the title comes from
 *     the backend session_summary (the first user message).
 *   - A draft is pure frontend transient state (the user hasn't sent a message, the
 *     daemon has no counterpart); when the first real chat message is sent,
 *     agent.ts's `materializeToDaemon` does `POST /sessions` to get a daemon id and
 *     `replaceDraftWithDaemonIdAtom` swaps the sidebar id over (from then on id = daemon id).
 *   - Deletion goes through the daemon `DELETE /sessions/{id}` (`buildAmphiClient`).
 *   - stage/stageLabel are pure frontend UI state (/build pipeline, no backend
 *     counterpart) — in memory only, not persisted (lost on refresh; to be designed
 *     when the real workflow is wired up).
 *
 * activeSessionIdAtom was moved over from atoms/amphi.ts (amphi.ts only keeps nav + modal state).
 */
import { atom, type Getter, type Setter } from 'jotai'
import type { SessionMeta, SessionTitleSource } from '@shared/types'
import { backendStateAtom, buildAmphiClient } from './backend'
import { BackendState } from '../../main/python-client/types'
import { rlog } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import { isSegmentsEmpty, segmentsToText, type Segment } from '@/components/composer/segments'

/** Re-export so existing `import type { SessionMeta } from '@/atoms/sessions'`
 *  call sites stay working. The single source of truth lives in
 *  `packages/shared/src/types/sessions.ts` (shared with the main-process
 *  persistence layer). */
export type { SessionMeta }

/** Primitive: not exported directly — only read + write atoms are exposed */
const _sessionsMeta = atom<SessionMeta[]>([])
export const sessionsMetaAtom = atom((get) => get(_sessionsMeta))

/** Per-session composer drafts as `Segment[]` (NOT plain text) so @ mention
 *  chips — including their id/label/group/path — survive both a session switch
 *  and an app restart. Persisted to `drafts.json` by useDraftPersistence. */
const _drafts = atom<Record<string, Segment[]>>({})
export const sessionDraftsAtom = atom((get) => get(_drafts))

/**
 * Content just submitted per session, keyed by session id — a tombstone that
 * makes "sent" stick against late writes.
 *
 * Clearing a draft on submit is synchronous, but the composer writes drafts
 * back ASYNCHRONOUSLY: `useDraftSync` has a 300ms debounce plus a
 * session-switch flush, and `FreeFormInput` only calls `setSegments(EMPTY)`
 * AFTER `onSubmit`. So the just-sent text lands back in the map right after it
 * was cleared. On a brand-new session that is visible damage:
 * `replaceDraftWithDaemonIdAtom` then migrates that resurrected draft onto the
 * daemon id, and the composer re-seeds from it — the message the user just
 * sent reappears in the input box.
 *
 * Only writes IDENTICAL to what was submitted are dropped, and only for as long
 * as an echo can still be in flight (see SUBMIT_ECHO_WINDOW_MS), so anything the
 * user types after hitting send still persists normally.
 */
const _submittedDrafts = atom<Record<string, { text: string; at: number }>>({})

/**
 * How long after a send an identical write still counts as that send's echo.
 *
 * Every echo path is bounded and short: useDraftSync's 300ms debounce, its
 * session-switch flush, and its unmount flush all fire within a few hundred ms
 * of the submit. Past that, an identical write can only be the user typing the
 * same thing again, which is a draft like any other.
 *
 * The bound is what makes the tombstone temporary. Without it a tombstone is
 * only retired by a DIFFERENT non-empty write, and an identical write returns
 * early before reaching that branch — so re-typing exactly what was sent could
 * never be saved again for the rest of the run. Reported case: a session whose
 * first message was literally `@` (the mention trigger, the single most
 * re-typed character there is); every later `@` in it vanished on a session
 * switch, while other sessions kept theirs.
 */
export const SUBMIT_ECHO_WINDOW_MS = 2_000

/**
 * Compared on flattened text, not on the segment structure.
 *
 * The submit path (`appendUserMessageAtom`) only carries `{sessionId, text,
 * blocks}` — threading raw segments down from FreeFormInput just for this would
 * mean touching the whole props chain. Text is what both sides do have.
 *
 * Accepted cost: if the user re-types the message just sent within
 * SUBMIT_ECHO_WINDOW_MS, that one write is treated as the echo and dropped. The
 * window is what bounds the cost — an earlier version had none, so re-typing the
 * sent text was blocked for the rest of the run (an identical write returns before
 * the retire branch, so it never cleared the tombstone either).
 */
function draftFingerprint(segments: Segment[]): string {
  return segmentsToText(segments).trim()
}

/** Action: replace the whole drafts map (used by the persistence bridge on
 *  boot-load and after pruning). */
export const setAllDraftsAtom = atom(null, (_get, set, next: Record<string, Segment[]>) => {
  set(_drafts, next)
})

/** Prune before persisting: drop empty drafts (the common "typed then
 *  sent/cleared" case leaves one) plus any retired random draft id. Deliberately
 *  does NOT prune by "unknown session id": at boot the daemon-hydrated session
 *  list isn't ready yet, so pruning by it would wrongly wipe just-loaded real
 *  drafts. Stale drafts from a UI deletion are already removed by
 *  removeSessionAtom; the rare cross-client orphan is tiny and harmless. Pure. */
export function pruneDrafts(
  drafts: Record<string, Segment[]>,
): Record<string, Segment[]> {
  const out: Record<string, Segment[]> = {}
  for (const [id, segs] of Object.entries(drafts)) {
    if (isSegmentsEmpty(segs) || RETIRED_DRAFT_ID.test(id)) continue
    out[id] = segs
  }
  return out
}

/**
 * The fixed id of an unmaterialized "new session".
 *
 * **It MUST be a constant, never a random uuid** — drafts are keyed by session id
 * when written into drafts.json, and after a restart bootstrap creates the draft
 * again. If the id changed every time, the draft on disk would never match the new
 * draft (what the user sees is "the text I typed is gone after a restart"), and the
 * old entries would pile up as orphans forever.
 *
 * A singleton is safe: there can only ever be one unmaterialized session at a time
 * (newSessionAtom always reuses it). Materialization MUST go through
 * `replaceDraftWithDaemonIdAtom` to swap in the daemon id — leaving it in meta and
 * only moving it out of draftIds (as materializeSessionAtom does) would collide with
 * the id of the next new session.
 */
export const DRAFT_SESSION_ID = 'draft:new'

/**
 * How to wipe the per-session state that lives outside this module — agent.ts owns the
 * message / streaming families, and importing it from here would close a cycle.
 *
 * Registered rather than dynamically imported (the `void import('./agent')` shape used
 * by removeSessionAtom) because this one MUST be synchronous: a wipe that lands a
 * microtask later also takes anything written in between with it. Unregistered (agent.ts
 * not loaded, e.g. a test that only imports this module) is a no-op.
 */
type DraftSlotReset = (get: Getter, set: Setter, id: string) => void
let draftSlotReset: DraftSlotReset | null = null

/** Called once by agent.ts at import time. */
export function registerDraftSlotReset(fn: DraftSlotReset): void {
  draftSlotReset = fn
}

/** Legacy random draft ids (`s-` + uuid v4). These keys on disk will never be
 *  matched again, so they are cleaned up while saving to keep drafts.json from
 *  accumulating historical orphans forever. The test is deliberately tight, so it
 *  never hits the daemon's `session_…` ids by mistake. */
const RETIRED_DRAFT_ID = /^s-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

const _draftIds = atom(new Set<string>())
export const draftSessionIdsAtom = atom((get) => get(_draftIds))

/** Increments whenever the user/bootstrap explicitly enters the singleton new Session. */
const _newSessionActivationSeq = atom(0)
export const newSessionActivationSeqAtom = atom((get) => get(_newSessionActivationSeq))

/** Derived: whether the active session is still a draft (no message sent, no daemon counterpart). */
export const activeIsDraftAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  return id != null && get(_draftIds).has(id)
})

export const activeSessionIdAtom = atom<string | null>(null)

/** Whether the selected conversation owns its Workspace and associated resources.
 * Unknown non-draft ids default to root so transient hydration never flashes the
 * right column closed; a known Child always delegates that surface to its parent. */
export const activeSessionIsRootAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  if (id == null) return false
  const session = get(_sessionsMeta).find((item) => item.id === id)
  return session?.parentSessionId == null
})

/** Absolute path of the active session's working directory (used to write
 *  .work/.build/task.md). Null for a draft, or when workspace_root hasn't been
 *  hydrated yet — callers use that to decide whether they can write to disk. */
export const activeWorkspaceRootAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  if (!id) return null
  return get(_sessionsMeta).find((m) => m.id === id)?.workspaceRoot ?? null
})

/** Whether boot landing has completed (set to true once useSessionBootstrap has picked the initial view; one-way). */
const _bootLanded = atom(false)
export const bootLandedAtom = atom((get) => get(_bootLanded))

/** Action: called once bootstrap landing is done (after selectSession / newSession). */
export const markBootLandedAtom = atom(null, (_get, set) => {
  set(_bootLanded, true)
})

/**
 * Derived: the boot landing decision is still in flight — the center area should
 * render a blank placeholder rather than Landing, avoiding "flash Landing → jump to
 * a session" (the restore target isn't known until the daemon is Ready and the
 * on-disk truth has been read).
 *
 * Unavailable fallback: when the daemon can't start, bootstrap never lands, so
 * Landing must be let through or the center area stays blank forever. If the daemon
 * recovers to Ready later, bootstrap lands as usual and restores the session.
 */
export const bootPendingAtom = atom((get) => {
  if (get(_bootLanded)) return false
  return get(backendStateAtom) !== BackendState.Unavailable
})

/**
 * Boot-time restore target: the remembered last session id, but only when it
 * still exists in the daemon-hydrated list. Returns null (→ land on a fresh
 * Landing draft) when nothing was remembered or the session was since deleted.
 *
 * Pure — fed `settings.ui.lastSessionId` + the hydrated metas by
 * `useSessionBootstrap`.
 */
export function pickInitialSession(
  metas: SessionMeta[],
  lastSessionId: string | null,
): string | null {
  if (!lastSessionId) return null
  return metas.some((m) => m.id === lastSessionId) ? lastSessionId : null
}

/**
 * The session id to PERSIST for the current view (write side, mirror of
 * `pickInitialSession`'s read side). Drives "reopen = exact last view":
 *   - draft active (new session / Landing, no daemon counterpart) → null, so reopening
 *     faithfully returns to Landing rather than the last real session.
 *   - real session active → its id.
 *   - null active (boot transient before restore runs) → keep the remembered
 *     value untouched, so we never clobber the id `useSessionBootstrap` is
 *     about to read.
 *
 * Pure — fed the live atoms by `useActiveSessionPersistence`.
 */
export function nextPersistedSessionId(
  activeId: string | null,
  draftIds: ReadonlySet<string>,
  remembered: string | null,
): string | null {
  if (activeId === null) return remembered
  return draftIds.has(activeId) ? null : activeId
}

/** Derived: the active session's title (no active session or not found → null).
 *  Used by the top-bar breadcrumb; a single source avoids drifting away from the
 *  sidebar list. */
export const activeSessionTitleAtom = atom((get) => {
  const id = get(activeSessionIdAtom)
  if (id == null) return null
  return get(_sessionsMeta).find((s) => s.id === id)?.title ?? null
})

/** Derived: the sidebar only looks at non-draft sessions, sort by updatedAt desc */
export const sidebarSessionsAtom = atom((get) => {
  const draftIds = get(_draftIds)
  return get(_sessionsMeta)
    .filter((s) => !draftIds.has(s.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
})

/** Action: switch to the "new session" state.
 *
 * From the user's point of view: the "new session" button should return to Landing.
 * The unmaterialized draft is always the same one ({@link DRAFT_SESSION_ID}), so
 * this atom is idempotent: switch back to it if it already exists, create it only if
 * it doesn't.
 *
 * Deliberately does **not** clear the draft text. Two things depend on that:
 *   - drafts don't enter the sidebar (see sidebarSessionsAtom) and Home has no
 *     separate nav entry, so "+ new session" is the only path back to Landing from
 *     the Workflows/Skills/Schedules/Assets views; clearing the draft here would
 *     mean "switch views, come back, and your input is gone";
 *   - after a restart bootstrap also goes through here, and only a fixed id plus not
 *     clearing the draft lets the on-disk draft get seeded back.
 */
export const newSessionAtom = atom(null, (get, set): string => {
  // Once the user has hit send in the new session, that content belongs to the session
  // it was sent to — never to the next new session. The slot's id is a singleton, so a
  // send that never reached the daemon leaves its optimistic bubble + error card right
  // here, and clicking "+ New session" would open onto them.
  draftSlotReset?.(get, set, DRAFT_SESSION_ID)
  const draftIds = get(_draftIds)
  if (!draftIds.has(DRAFT_SESSION_ID)) {
    const now = Date.now()
    const meta: SessionMeta = {
      id: DRAFT_SESSION_ID,
      title: i18n.t('session.defaultTitle'),
      titleSource: 'default',
      createdAt: now,
      updatedAt: now,
    }
    set(_sessionsMeta, [...get(_sessionsMeta), meta])
    set(_draftIds, new Set([...draftIds, DRAFT_SESSION_ID]))
  }
  set(_newSessionActivationSeq, get(_newSessionActivationSeq) + 1)
  set(activeSessionIdAtom, DRAFT_SESSION_ID)
  return DRAFT_SESSION_ID
})

/** Action: select a session (pure UI state) */
export const selectSessionAtom = atom(null, (_get, set, id: string) => {
  set(activeSessionIdAtom, id)
})

/** Action: delete a session's three pieces of state (meta / drafts / draftIds) + delete it from storage */
export const removeSessionAtom = atom(null, (get, set, id: string) => {
  const wasDraft = get(_draftIds).has(id)
  set(_sessionsMeta, get(_sessionsMeta).filter((s) => s.id !== id))
  const drafts = { ...get(_drafts) }
  delete drafts[id]
  set(_drafts, drafts)
  const draftIds = new Set(get(_draftIds))
  draftIds.delete(id)
  set(_draftIds, draftIds)
  const completionSeqById = { ...get(_sessionCompletionSeqById) }
  delete completionSeqById[id]
  set(_sessionCompletionSeqById, completionSeqById)
  if (get(activeSessionIdAtom) === id) set(activeSessionIdAtom, null)
  // Daemon is the source of truth — DELETE the daemon session. Drafts never
  // reached the daemon (no POST /sessions yet), so skip.
  if (!wasDraft) {
    const client = buildAmphiClient(get)
    void client?.deleteSession(id).catch((err: unknown) => {
      rlog.warn('[sessions] daemon deleteSession failed', { id, err })
    })
    // Explicit deletion releases this Session's topic tree and transient streams.
    // Dynamic import mirrors the agent edge below + keeps WebSocket out of the
    // static graph (bun:test).
    void import('@/lib/amphiWsConnection').then(
      (m) => m.getAmphiWsConnection().releaseSessionTree(id),
    )
  }
  // Clear this session's per-session agent state (messageFamily/streamingFamily +
  // companion Set). The dynamic import breaks the sessions.ts ↔ agent.ts cycle; if
  // not cleared, atomFamily caches the deleted session's atom forever (memory buildup).
  void import('./agent').then((m) => set(m.purgeSessionAtom, id))
  // Unlike purgeSessionAtom, this is intentionally tied to real deletion only:
  // purgeSessionAtom also resets the still-active reusable draft slot, where
  // atomFamily.remove() would strand current layout subscribers on the old atom.
  void import('./layout').then((m) => m.purgeRightPanelLayoutState(id))
})

/** Action: write the per-session draft (Segment[], preserving @ chip metadata) */
export const setSessionDraftAtom = atom(
  null,
  (get, set, payload: { id: string; segments: Segment[] }) => {
    const submitted = get(_submittedDrafts)[payload.id]
    if (submitted !== undefined) {
      const fingerprint = draftFingerprint(payload.segments)
      const echoable = Date.now() - submitted.at < SUBMIT_ECHO_WINDOW_MS
      // A late echo of the message we just sent — drop it (see _submittedDrafts).
      if (echoable && fingerprint === submitted.text) return
      // Retire the tombstone once no echo can still be in flight, or as soon as a
      // NON-EMPTY different write shows the user has moved on. An empty write inside
      // the window must NOT retire it: ~300ms after send, useDraftSync debounce-writes
      // the composer's own cleared content ('' ≠ sent text), and retiring there would
      // leave the sent text unblocked for any later flush (seen in the wild: the sent
      // instruction reappearing in every new session, amplified by drafts.json).
      if (!echoable || fingerprint !== '') {
        const next = { ...get(_submittedDrafts) }
        delete next[payload.id]
        set(_submittedDrafts, next)
      }
    }
    set(_drafts, { ...get(_drafts), [payload.id]: payload.segments })
  },
)

/** Action: this session's draft went out with the message — clear it, and block the
 *  asynchronous write-back that follows right after.
 *
 *  The submit path MUST use this rather than {@link clearSessionDraftAtom}: the
 *  latter only deletes the copy that exists right now, and can't stop useDraftSync
 *  from writing the same content back later (see `_submittedDrafts`). */
export const submitSessionDraftAtom = atom(
  null,
  (get, set, payload: { id: string; text: string }) => {
    const drafts = { ...get(_drafts) }
    delete drafts[payload.id]
    set(_drafts, drafts)
    set(_submittedDrafts, {
      ...get(_submittedDrafts),
      [payload.id]: { text: payload.text.trim(), at: Date.now() },
    })
  },
)

/** Action: invalidate a session's draft (delete the key). Called after a successful
 *  send, so a remount doesn't re-seed the old content that was just sent. */
export const clearSessionDraftAtom = atom(null, (get, set, id: string) => {
  const drafts = get(_drafts)
  if (!(id in drafts)) return
  const next = { ...drafts }
  delete next[id]
  set(_drafts, next)
})

/** Action: mark a draft as non-draft in place (move it out of draftIds → into the
 *  sidebar) without swapping the id. Real chat in production does not go through
 *  here — it materializes via agent.ts's materializeToDaemon +
 *  replaceDraftWithDaemonIdAtom and swaps in the daemon id. This atom is now only
 *  used in tests to construct a "non-draft" precondition. The daemon is the source
 *  of truth; meta is no longer persisted locally. */
export const materializeSessionAtom = atom(null, (get, set, id: string) => {
  const draftIds = new Set(get(_draftIds))
  if (!draftIds.has(id)) return
  draftIds.delete(id)
  set(_draftIds, draftIds)
})

/** Action: swap the id after a draft is materialized into a daemon session — the id
 *  in the sidebar meta, moving it out of draftIds, and pointing active at it.
 *  Migrating messageFamily is handled by agent.ts's materializeToDaemon (which calls
 *  this atom after POST /sessions succeeds). Writing it all at once guarantees atomicity. */
export const replaceDraftWithDaemonIdAtom = atom(
  null,
  (get, set, payload: { draftId: string; daemonId: string }) => {
    const { draftId, daemonId } = payload
    set(
      _sessionsMeta,
      get(_sessionsMeta).map((s) => (s.id === draftId ? { ...s, id: daemonId } : s)),
    )
    const draftIds = new Set(get(_draftIds))
    draftIds.delete(draftId)
    set(_draftIds, draftIds)
    // The draft key follows the id swap — otherwise this session's unsent draft is lost after the swap.
    const drafts = get(_drafts)
    if (draftId in drafts) {
      const next = { ...drafts }
      next[daemonId] = next[draftId] as Segment[]
      delete next[draftId]
      set(_drafts, next)
    }
    // The submitted tombstone must follow the id swap too: when useDraftSync's
    // debounced write-back happens after the swap it uses the **new** id, and a
    // tombstone left on the old id can't block it (see `_submittedDrafts`).
    // COPY, don't move: stragglers whose closures still carry the OLD id (the
    // switch-flush racing this swap, the unmount flush of the pre-send composer
    // instance) write under the draft id — and `draft:new` is reused by every
    // future "+ New session", so one unblocked write there resurfaces forever. The
    // draft-id copy retires like any tombstone once the user types something new.
    const submitted = get(_submittedDrafts)
    const carried = submitted[draftId]
    if (carried !== undefined) {
      set(_submittedDrafts, { ...submitted, [daemonId]: carried })
    }
    if (get(activeSessionIdAtom) === draftId) set(activeSessionIdAtom, daemonId)
  },
)

/** Action: update a session's title (used by auto-rename / the daemon title event).
 *  Only updates the in-memory meta for immediate reflection, no local persistence
 *  (the daemon is the source of truth). `bump` defaults to true (keeping done's
 *  auto-rename behavior); the daemon-pushed title event passes `bump:false` — a
 *  title change isn't "activity" and must not push the session to the top of the
 *  list (aligned with renameSessionAtom's deliberate no-bump). Generated events
 *  cannot replace a manual or daemon-hydrated title, which may be newer than a
 *  replayed event from the active turn. */
export const updateSessionTitleAtom = atom(
  null,
  (get, set, payload: { id: string; title: string; bump?: boolean; source?: SessionTitleSource }) => {
    const bump = payload.bump !== false
    set(
      _sessionsMeta,
      get(_sessionsMeta).map((s) =>
        s.id !== payload.id
          || (
            payload.source === 'generated'
            && (s.titleSource === 'manual' || s.titleSource === 'persisted')
          )
          ? s
          : {
              ...s,
              title: payload.title,
              titleSource: payload.source ?? s.titleSource,
              updatedAt: bump ? Date.now() : s.updatedAt,
            },
      ),
    )
  },
)

/** Action: mark a session UNREAD (the sidebar red dot) — the daemon broadcast
 *  `session.completed`, or `status==="completed"` on hydrate. The active session
 *  is excluded at render + auto-read (see `useActiveSessionReadReceipt`). No
 *  bump: a finished turn isn't new activity — the chat that started it already
 *  bumped the session. */
export const markSessionUnreadAtom = atom(null, (get, set, id: string) => {
  set(
    _sessionsMeta,
    get(_sessionsMeta).map((s) => (s.id === id ? { ...s, hasRedDot: true } : s)),
  )
})

/** Action: mark a session READ — clear its dot + POST the read receipt so the
 *  daemon flips `completed`→`finish` (no dot on the next reload). Idempotent;
 *  a no-op POST on an already-read session is harmless. */
export const markSessionReadAtom = atom(null, (get, set, id: string) => {
  const metas = get(_sessionsMeta)
  if (metas.find((s) => s.id === id)?.hasRedDot) {
    set(_sessionsMeta, metas.map((s) => (s.id === id ? { ...s, hasRedDot: false } : s)))
  }
  const client = buildAmphiClient(get)
  void client?.markSessionRead(id).catch((err: unknown) => {
    rlog.warn('[sessions] daemon markSessionRead failed', { id, err })
  })
})

/** Optimistically clear the local pending icon after sending an interaction answer.
 *  AgentInvocation owns the durable awaiting → finish transition; the renderer
 *  never writes that Session state through a second request. */
export const markSessionAnsweredAtom = atom(null, (get, set, id: string) => {
  const metas = get(_sessionsMeta)
  if (metas.find((s) => s.id === id)?.hasPendingInteraction) {
    set(_sessionsMeta, metas.map((s) => (s.id === id ? { ...s, hasPendingInteraction: false } : s)))
  }
})

/** Local projection for nested Invocation requests, whose pending state lives
 *  outside the parent session's root-turn status column. */
export const setSessionPendingInteractionAtom = atom(
  null,
  (get, set, payload: { id: string; pending: boolean }) => {
    set(
      _sessionsMeta,
      get(_sessionsMeta).map((session) =>
        session.id === payload.id
          ? { ...session, hasPendingInteraction: payload.pending }
          : session,
      ),
    )
  },
)

/* ─── Cross-cutting signal: session completed (lets other domains invalidate their own session-derived snapshots) ─── */

/** Completion ticks are invalidation signals, never cached terminal data.
 *  The global scalar refreshes cross-Session aggregates such as schedules;
 *  the keyed scalar lets Session-owned views refresh only their own source. */
const _sessionCompletionSeq = atom(0)
const _sessionCompletionSeqById = atom<Record<string, number>>({})
export const sessionCompletionSeqAtom = atom((get) => get(_sessionCompletionSeq))
export const sessionCompletionSeqByIdAtom = atom((get) => get(_sessionCompletionSeqById))
export const bumpSessionCompletionAtom = atom(null, (get, set, sessionId?: string) => {
  set(_sessionCompletionSeq, get(_sessionCompletionSeq) + 1)
  if (!sessionId) return
  const byId = get(_sessionCompletionSeqById)
  set(_sessionCompletionSeqById, {
    ...byId,
    [sessionId]: (byId[sessionId] ?? 0) + 1,
  })
})

/** Action: user-initiated rename — optimistically update meta and persist to the
 *  daemon (PATCH /sessions/{id}). Unlike updateSessionTitleAtom (agent auto-rename,
 *  in-memory only), this one hits the database; a daemon-persisted title is still
 *  there after a reset / reload. A draft hasn't reached the daemon yet (no POST
 *  /sessions), so the PATCH is skipped and only memory is updated (aligned with
 *  removeSessionAtom's draft handling). A failed PATCH rolls the title back, to
 *  avoid drift between the UI and the daemon. */
export const renameSessionAtom = atom(
  null,
  (get, set, payload: { id: string; title: string }) => {
    const { id } = payload
    const title = payload.title.trim()
    const previous = get(_sessionsMeta).find((s) => s.id === id)
    const prev = previous?.title
    if (!title || prev === title) return
    // Deliberately NOT bumping updatedAt: sidebar sorts by updatedAt desc, and
    // a manual rename must not jump the session to the top of the list (unlike
    // a new message, which legitimately does). Only the title changes.
    set(
      _sessionsMeta,
      get(_sessionsMeta).map((s) =>
        s.id === id ? { ...s, title, titleSource: 'manual' } : s,
      ),
    )
    if (get(_draftIds).has(id)) return
    const client = buildAmphiClient(get)
    void client?.renameSession(id, title).catch((err: unknown) => {
      rlog.warn('[sessions] daemon renameSession failed; reverting title', { id, err })
      set(
        _sessionsMeta,
        get(_sessionsMeta).map((s) =>
          s.id === id
            ? {
                ...s,
                title: prev ?? i18n.t('session.defaultTitle'),
                titleSource: previous?.titleSource,
              }
            : s,
        ),
      )
    })
  },
)

/** Hydration from daemon: GET /sessions → SessionMeta[]. The daemon is the
 *  source of truth (replaces the old local sessions.json). Maps SessionSummary
 *  (id + title) to SessionMeta; `stage`/`stageLabel` are frontend-only
 *  scaffolding fields reserved for a future daemon workflow-stage feature,
 *  left undefined. Returns the metas so the bootstrap can pick an initial
 *  session. Returns [] when the daemon isn't reachable. */
export const hydrateSessionsFromDaemonAtom = atom(
  null,
  async (get, set): Promise<SessionMeta[]> => {
    const client = buildAmphiClient(get)
    if (!client) return []
    // One full fetch, no consecutive offset paging: the sidebar sorts by updated_at
    // desc and updates live, so if any session receives a message between the two page
    // requests the order shifts — a session that jumps to the head may be covered by
    // neither page and silently disappear from the index (found in code-review). The
    // full payload for 1000 sessions is ≈234KB, which is acceptable; the server-side
    // ?limit= paging contract is reserved for low-frequency snapshot-style clients.
    const summaries = await client.listSessions()
    const now = Date.now()
    // Keep the existing local timestamps (on re-hydrate after a gateway restart): the
    // daemon's SessionSummary carries no timestamp, so stamping every row with a fresh
    // now would wipe out the real activity order (the updatedAt bumped by auto-rename /
    // new messages) and make the sidebar's updatedAt-desc sort meaningless. Only
    // sessions seen for the first time use now. The real fix needs the daemon to expose
    // updated_at on SessionSummary returned by the session list handler.
    const prevById = new Map(get(_sessionsMeta).map((m) => [m.id, m]))
    const metas: SessionMeta[] = summaries.map((s) => {
      const prev = prevById.get(s.id)
      const title = s.title || i18n.t('session.defaultTitle')
      let titleSource: SessionTitleSource = s.title ? 'persisted' : 'default'
      if (prev?.title === title && prev.titleSource) titleSource = prev.titleSource
      return {
        id: s.id,
        title,
        titleSource,
        // The session's working directory: used to write .work/.build/task.md directly (editing the requirements spec).
        workspaceRoot: s.workspace_root,
        parentSessionId: s.parent_session_id ?? undefined,
        subagentMode: s.subagent_mode ?? undefined,
        turnStatus: s.turn_status ?? undefined,
        hasRedDot: s.status === 'completed',
        hasPendingInteraction: s.status === 'awaiting',
        isRunning: s.status === 'running',
        createdAt: prev?.createdAt ?? now,
        updatedAt: prev?.updatedAt ?? now,
      }
    })
    // Merge rather than replace the whole table: a draft is pure frontend state (the
    // daemon doesn't know about it), and a full replace on re-hydrate (e.g. after a
    // gateway restart) would wipe out the draft meta row the user is sitting on.
    const draftIds = get(_draftIds)
    const draftRows = get(_sessionsMeta).filter((m) => draftIds.has(m.id))
    set(_sessionsMeta, [...metas, ...draftRows])
    rlog.debug('[sessions] hydrated meta from daemon', { count: metas.length })
    return metas
  },
)

/* ─── Composer focus request (only when the user switches sessions themselves) ─── */

/** Set to true after the user clicks a session / creates a new one; FreeFormInput
 *  consumes it while seeding: focus the input box when there is no saved caret.
 *  Programmatic switches (boot restore / the internal draft→daemon switch) don't set
 *  it, so they never steal focus. */
const _pendingComposerFocus = atom(false)
export const pendingComposerFocusAtom = atom((get) => get(_pendingComposerFocus))
export const setPendingComposerFocusAtom = atom(null, (_get, set, v: boolean) => {
  set(_pendingComposerFocus, v)
})

/* ─── Composer prefill seed ("open via a new session with content prefilled", e.g. schedule create / edit) ─── */

/** One-shot prefill signal: push `segments` (which may contain field description
 *  slots + widget name/frequency) into the target session's input box, and put the
 *  caret inside the field pointed at by `focusFieldId` (preferred) or at the `caret` offset.
 *
 *  Why a separate signal instead of just writing the draft: when `newSessionAtom`
 *  reuses the empty draft the sessionId doesn't change, so FreeFormInput's `[sessionId]`
 *  seed effect doesn't re-run, and the draft alone can't get the content into the editor.
 *  Hence the one-shot signal semantics modeled on `pendingComposerFocusAtom` —
 *  FreeFormInput consumes it once it matches that sessionId (setSegments +
 *  focusField/focusAtOffset), and useDraftSync persists it as a draft along the way. */
const _pendingComposerSeed = atom<{
  sessionId: string
  segments: Segment[]
  /** Preferred: put the caret inside this field (an empty slot works too). */
  focusFieldId?: string
  /** When there is no field: the character offset after flattening. */
  caret?: number
} | null>(null)
export const pendingComposerSeedAtom = atom((get) => get(_pendingComposerSeed))
export const setPendingComposerSeedAtom = atom(
  null,
  (
    _get,
    set,
    seed: { sessionId: string; segments: Segment[]; focusFieldId?: string; caret?: number },
  ) => {
    set(_pendingComposerSeed, seed)
  },
)
export const clearPendingComposerSeedAtom = atom(null, (_get, set) => {
  set(_pendingComposerSeed, null)
})

/* ─── Composer segment insert request (card action → the current input box) ─── */

/** A one-shot command queue for external cards to insert structured segments into
 * the current input box.
 *
 * Unlike `pendingComposerSeed`, this never overwrites a draft the user hasn't sent;
 * FreeFormInput inserts at the current caret instead. A workflow card's "run now"
 * uses it to drop in a real Workflow slash token, rather than splicing together
 * plain text that merely looks like a command. */
const _pendingComposerInserts = atom<Segment[][]>([])
export const pendingComposerInsertsAtom = atom((get) => get(_pendingComposerInserts))
export const requestComposerInsertAtom = atom(null, (get, set, segments: Segment[]) => {
  if (segments.length === 0) return
  set(_pendingComposerInserts, [...get(_pendingComposerInserts), segments])
})
export const consumeComposerInsertsAtom = atom(null, (_get, set) => {
  set(_pendingComposerInserts, [])
})
