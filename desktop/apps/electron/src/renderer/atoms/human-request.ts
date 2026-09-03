/**
 * Daemon HITL state: the pending `human_request` per session (WS path).
 *
 * Both option and free-text questions use the interaction card. Banner picks
 * resume the suspended Session Turn over the structured `choice_answer` frame
 * (stable option ids — display copy never travels back); the completed card is
 * retained as a compact confirmation row in that Turn's single Agent reply.
 * Typing into the composer instead still answers via a plain chat message,
 * which the daemon folds back to the model as a free-form reply.
 *
 * Lifecycle:
 *   1. daemon emits `human_request` → translateTurnEvent → `applyAgentEventAtom`
 *      (live), or GET /sessions/{id}/messages returns `pending_request`
 *      (rehydration on reload) — both land in `setHumanRequestAtom`
 *   2. `HumanRequestBanner` reads `currentHumanRequestAtom`, collects the
 *      selection, calls `respondHumanRequestAtom`
 *   3. respondHumanRequestAtom sends `choice_answer` with the request_id;
 *      chat is only the fallback for id-less legacy cards
 *
 * Single-slot per session (not a queue): the daemon asks one thing at a time
 * within a turn, so a new request overwrites any stale one for that session.
 */
import type { AskUserQuestion, ChoiceAnswerItem } from '@shared/types'
import { atom } from 'jotai'
import { rlog } from '@/lib/logger'
import { activeSessionIdAtom, markSessionAnsweredAtom } from './sessions'

/** A pending Agent question awaiting the user's response. */
export interface HumanRequest {
  sessionId: string
  /** Required for request_human_choice; optional only for legacy/system-owned cards. */
  prompt?: string
  questions: AskUserQuestion[]
  kind?: 'choose'
  requestId?: string
}

const _bySession = atom<Map<string, HumanRequest>>(new Map())

/** All pending requests by session — read by the chat path to detect that a
 *  user message (banner pick OR direct compose) is answering a suspended ask. */
export const pendingBySessionAtom = atom((get) => get(_bySession))

/** The pending request for the currently active session, or null when idle. */
export const currentHumanRequestAtom = atom<HumanRequest | null>((get) => {
  const sid = get(activeSessionIdAtom)
  if (!sid) return null
  return get(_bySession).get(sid) ?? null
})

/** Record a pending request — from the live `human_request` event or the
 *  transcript's `pending_request` on rehydration. */
export const setHumanRequestAtom = atom(null, (get, set, request: HumanRequest) => {
  const next = new Map(get(_bySession))
  next.set(request.sessionId, request)
  set(_bySession, next)
  rlog.debug('[human-request] pending', { sessionId: request.sessionId })
})

/** One question's resolved answer, positionally aligned with the ask. Carried
 *  as an ordered list — NOT a `Record<question, answer>` — because two questions
 *  in one ask may share identical text, which a map keyed by question text would
 *  silently collapse (losing an answer). */
export interface ComposedAnswer {
  question: string
  answer: string
  /** Stable id for a selected option; omitted for free-form and legacy answers. */
  optionId?: string
}

/** Map the banner's positional answers to `choice_answer` wire items: a clean
 *  pick travels as its stable `option_id`, anything typed travels as `text`
 *  (the daemon folds text back to the model instead of guessing an action).
 *  Unanswered entries are dropped; `index` keeps question alignment. */
export function composeChoiceAnswerItems(answers: ComposedAnswer[]): ChoiceAnswerItem[] {
  return answers
    .map((answer, index) => ({ ...answer, index }))
    .filter((entry) => Boolean(entry.answer))
    .map((entry) =>
      entry.optionId
        ? { index: entry.index, option_id: entry.optionId }
        : { index: entry.index, text: entry.answer },
    )
}

/** Compose the banner's selections into display text: `question: answer` per
 *  line (unanswered entries dropped). Used for the legacy chat fallback only —
 *  structured answers travel as `choice_answer` items and the daemon composes
 *  the question → answer mapping for the tool_result itself. */
export function composeHumanAnswer(answers: ComposedAnswer[]): string {
  return answers
    .filter((a) => Boolean(a.answer))
    .map((a) => `${a.question}: ${a.answer}`)
    .join('\n')
}

/**
 * The question the banner should jump to after a single-select pick: the next
 * UNANSWERED question, scanning forward from `from` and wrapping past the end.
 * Returns `from` unchanged when every question is answered — auto-advance only
 * moves focus, it never submits (the user confirmed "jump only, never
 * finalize"). `answered[i]` is whether question `i` already has a resolved
 * answer.
 */
export function nextUnansweredIndex(answered: boolean[], from: number): number {
  const n = answered.length
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n
    if (!answered[i]) return i
  }
  return from
}

/**
 * Send the response through the normal chat channel; AgentInvocation resumes
 * the pending Session Turn and the renderer continues its existing reply.
 */
export const respondHumanRequestAtom = atom(
  null,
  async (
    _get,
    set,
    payload: {
      sessionId: string
      answers: ComposedAnswer[]
    },
  ) => {
    const request = _get(_bySession).get(payload.sessionId)
    const answered = payload.answers
      .map((answer, index) => ({ ...answer, index }))
      .filter((entry) => Boolean(entry.answer))
    if (answered.length === 0) return
    if (request?.requestId) {
      // Structured resume: stable option ids travel the wire; display copy stays
      // local, so relabeling/relocalizing an option can never change what
      // executes. The answered card is retained as the turn's confirmation row —
      // no user message is produced.
      const single = answered.length === 1 ? answered[0] : undefined
      // Dynamic import keeps the atoms/agent ↔ atoms/human-request graph acyclic
      // (mirrors the reducer's human_request case in the other direction).
      const m = await import('./agent')
      set(m.prepareInteractionContinuationAtom, {
        sessionId: payload.sessionId,
        confirmation: {
          kind: 'answer',
          question: single?.question ?? request.prompt ?? '',
          response: single
            ? single.answer
            : answered.map((entry) => `${entry.question}: ${entry.answer}`).join('\n'),
        },
      })
      const { getAmphiWsConnection } = await import('@/lib/amphiWsConnection')
      getAmphiWsConnection().choiceAnswer(payload.sessionId, {
        request_id: request.requestId,
        answers: composeChoiceAnswerItems(payload.answers),
      })
      const next = new Map(_get(_bySession))
      next.delete(payload.sessionId)
      set(_bySession, next)
      set(markSessionAnsweredAtom, payload.sessionId)
      rlog.debug('[human-request] choice responded', { sessionId: payload.sessionId })
      return
    }
    // Card without a request_id: fall back to a plain chat reply, which the
    // daemon folds back to the model as a free-form (not_answered) answer.
    const text = composeHumanAnswer(payload.answers)
    if (!text) return
    const m = await import('./agent')
    set(m.appendUserMessageAtom, { sessionId: payload.sessionId, text })
    rlog.debug('[human-request] responded via chat', { sessionId: payload.sessionId })
  },
)

/** Drop the pending request for a session (deletion / any user send). */
export const clearSessionHumanRequestAtom = atom(null, (get, set, sessionId: string) => {
  const cur = get(_bySession)
  if (!cur.has(sessionId)) return
  const next = new Map(cur)
  next.delete(sessionId)
  set(_bySession, next)
})
