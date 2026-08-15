/** Build-scoped presentation state shared by the Agent reducer and Build UI. */
import type { ThinkPosition } from '@shared/types'
import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import {
  clearSessionFocusPaneKindAtom,
  SessionFocusPaneKind,
} from './session-focus-pane'

/** Per-session task brief — `.work/.build/task.md` raw markdown; null = no file yet. */
export const briefFamily = atomFamily((_sessionId: string) => atom<string | null>(null))

/** Saved `task.md` captured once when an existing Workflow enters edit mode. */
export const originalBriefFamily = atomFamily((_sessionId: string) => atom<string | null>(null))

/** One staged comment on a selected task-spec snippet. */
export interface PendingComment {
  id: string
  quote: string
  text: string
}

/** Unsent inputs owned by one Session's current Build. */
export interface SpecSessionDraft {
  comment: { quote: string; text: string } | null
  instruction: string
  edit: string | null
}

export const EMPTY_SPEC_DRAFT: SpecSessionDraft = Object.freeze({
  comment: null,
  instruction: '',
  edit: null,
})

export const specDraftsAtom = atom<Record<string, SpecSessionDraft>>({})
export const pendingCommentsBySessionAtom = atom<Record<string, PendingComment[]>>({})

export interface BuildPresentationLifecycle {
  /** Monotonic frontend identity for Build entries in this Session. */
  cycle: number
  active: boolean
  /** Latest review that already existed when this Build began. */
  entryTaskConfirmRequestId: string | null
}

const INITIAL_BUILD_PRESENTATION: BuildPresentationLifecycle = Object.freeze({
  cycle: 0,
  active: false,
  entryTaskConfirmRequestId: null,
})

export const buildPresentationLifecycleFamily = atomFamily(
  (_sessionId: string) => atom<BuildPresentationLifecycle>(INITIAL_BUILD_PRESENTATION),
)

/**
 * Synchronize presentation ownership with a daemon thinking-mode update.
 *
 * A Session has no durable Build id, so the non-Build -> Build boundary is the
 * frontend identity. Entering invalidates the prior task cache and TaskSpec
 * selection; stage changes inside that Build preserve them. Unsent edits and
 * comments remain Session-owned because a non-Build -> Build transition may be
 * resuming the same unfinished `.build`, not starting a replacement.
 */
export const syncBuildPresentationAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string
      position: ThinkPosition | null
      entryTaskConfirmRequestId: string | null
    },
  ) => {
    const current = get(buildPresentationLifecycleFamily(payload.sessionId))
    const nextActive = payload.position?.mode === 'build'
    if (nextActive === current.active) return

    if (nextActive) {
      set(buildPresentationLifecycleFamily(payload.sessionId), {
        cycle: current.cycle + 1,
        active: true,
        entryTaskConfirmRequestId: payload.entryTaskConfirmRequestId,
      })
      set(briefFamily(payload.sessionId), null)
      set(originalBriefFamily(payload.sessionId), null)
      set(clearSessionFocusPaneKindAtom, {
        sessionId: payload.sessionId,
        kind: SessionFocusPaneKind.TaskSpec,
      })
    } else {
      set(buildPresentationLifecycleFamily(payload.sessionId), {
        ...current,
        active: false,
      })
    }
  },
)

/** Drop all cached presentation state for a deleted Session. */
export function purgeBuildPresentationState(sessionId: string): void {
  briefFamily.remove(sessionId)
  originalBriefFamily.remove(sessionId)
  buildPresentationLifecycleFamily.remove(sessionId)
}
