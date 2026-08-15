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
 *   3. respondHumanRequestAtom: sends `choice_answer` (or `accept_rule`) with
 *      the request_id; chat is only the fallback for id-less legacy cards
 *
 * Single-slot per session (not a queue): the daemon asks one thing at a time
 * within a turn, so a new request overwrites any stale one for that session.
 */
import type { AskUserQuestion, ChoiceAnswerItem } from '@shared/types'
import { atom } from 'jotai'
import { i18n } from '@/lib/i18n'
import { rlog } from '@/lib/logger'
import { activeSessionIdAtom, markSessionAnsweredAtom } from './sessions'

/** A pending Agent question awaiting the user's response. */
export interface HumanRequest {
  sessionId: string
  /** Required for request_human_choice; optional only for legacy/system-owned cards. */
  prompt?: string
  questions: AskUserQuestion[]
  kind?: 'choose' | 'accept_rule'
  requestId?: string
  rules?: string[]
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

/** Build one fixed review tab per proposed acceptance rule. */
export function acceptanceRuleQuestions(rules: string[]): AskUserQuestion[] {
  return rules.map((rule, index) => ({
    question: rule.replace(/^\s*AC[-_ ]?\d+\s*[:：.)、-]\s*/i, '').trim(),
    header: rules.length === 1
      ? i18n.t('humanRequest.acceptance.finalOutcome')
      : i18n.t('humanRequest.acceptance.standardN', { n: index + 1 }),
    layout: 'review-list' as const,
    options: [
      {
        id: 'accept',
        label: i18n.t('humanRequest.acceptance.accept'),
        description: i18n.t('humanRequest.acceptance.acceptDesc'),
      },
      {
        id: 'reject',
        label: i18n.t('humanRequest.acceptance.reject'),
        description: i18n.t('humanRequest.acceptance.rejectDesc'),
      },
    ],
    allowOther: true,
  }))
}

/** Build the backend-assigned reviewed-rule shape for optimistic display. */
export function confirmedAcceptanceRules(
  rules: string[],
  decisions: Array<'accept' | 'reject'>,
  feedback: string[] = [],
): Array<{ id: string; text: string }> {
  const acceptedTexts = rules.flatMap((rule, index) => {
    if (decisions[index] === 'accept') return [rule]
    const replacement = feedback[index]?.trim()
    return replacement ? [replacement] : []
  })
  return acceptedTexts.map((text, index) => ({
    id: `AC-${String(index + 1).padStart(3, '0')}`,
    text,
  }))
}

/** Free-typed synonyms users write by habit instead of the rendered labels.
 *
 *  These are RECOGNITION KEYS over user-authored text, not display copy — the
 *  deliberate exception to the "no Chinese literals" rule (check-chinese.ts
 *  allowlists this file for exactly these data values). A user typing a historical
 *  acceptance synonym into the card's Other field means "adopt"; translating or deleting
 *  these strings would break that recognition, dropping the answer into the
 *  reject-with-feedback branch and persisting the typed text as a replacement
 *  rule. Chinese-only on purpose: they predate i18n and no English synonym set
 *  was ever established (inventing one would be guesswork). The rendered option
 *  labels are NEVER hardcoded here — they derive from both locale catalogs in
 *  acceptanceDecisionLabels(). */
const ACCEPT_SYNONYMS = ['符合预期', '接受']
const REJECT_SYNONYMS = ['需要修改', '需要调整', '拒绝']

/** Answer texts recognized as accept / reject decisions for a free-typed reply.
 *  Derived from BOTH locale catalogs (the same single source that renders the
 *  card's options, so relabeling can't silently break recognition) plus the
 *  historical synonyms above. */
function acceptanceDecisionLabels(): { acceptedLabels: Set<string>; decisionLabels: Set<string> } {
  const acceptedLabels = new Set(ACCEPT_SYNONYMS)
  const decisionLabels = new Set(REJECT_SYNONYMS)
  for (const lng of ['zh', 'en']) {
    acceptedLabels.add(i18n.t('humanRequest.acceptance.accept', { lng }))
    decisionLabels.add(i18n.t('humanRequest.acceptance.reject', { lng }))
  }
  for (const label of acceptedLabels) decisionLabels.add(label)
  return { acceptedLabels, decisionLabels }
}

export interface AcceptanceReviewSubmission {
  mode: 'criteria' | 'execution_only'
  decisions: Array<'accept' | 'reject'>
  feedback: string[]
  rules: Array<{ id: string; text: string }>
}

/** Map review-card answers to the wire contract and optimistic confirmed rules. */
export function resolveAcceptanceReviewSubmission(
  rules: string[],
  answers: ComposedAnswer[],
  requestedMode: 'criteria' | 'execution_only' = 'criteria',
): AcceptanceReviewSubmission {
  if (requestedMode === 'execution_only') {
    return { mode: 'execution_only', decisions: [], feedback: [], rules: [] }
  }
  const { acceptedLabels, decisionLabels } = acceptanceDecisionLabels()
  const decisions = rules.map((_, index) =>
    answers[index]?.optionId === 'accept' || acceptedLabels.has(answers[index]?.answer ?? '')
      ? 'accept' as const
      : 'reject' as const,
  )
  const feedback = rules.map((_, index) => {
    const response = answers[index]
    if (response?.optionId === 'accept' || response?.optionId === 'reject') return ''
    const answer = response?.answer.trim() ?? ''
    return decisionLabels.has(answer) ? '' : answer
  })
  const confirmedRules = confirmedAcceptanceRules(rules, decisions, feedback)
  if (confirmedRules.length === 0) {
    return { mode: 'execution_only', decisions: [], feedback: [], rules: [] }
  }
  return { mode: 'criteria', decisions, feedback, rules: confirmedRules }
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
      acceptanceMode?: 'criteria' | 'execution_only'
    },
  ) => {
    const request = _get(_bySession).get(payload.sessionId)
    if (request?.kind === 'accept_rule') {
      if (!request.requestId || !request.rules?.length) return
      const submission = resolveAcceptanceReviewSubmission(
        request.rules,
        payload.answers,
        payload.acceptanceMode,
      )
      const { mode, decisions, feedback, rules: acceptedRules } = submission
      const m = await import('./agent')
      set(m.prepareInteractionContinuationAtom, {
        sessionId: payload.sessionId,
        confirmation: {
          kind: 'accept_rule',
          question: mode === 'execution_only'
            ? i18n.t('humanRequest.acceptance.executionOnlyConfirmed')
            : i18n.t('humanRequest.acceptance.criteriaConfirmed'),
          response: mode === 'execution_only'
            ? i18n.t('humanRequest.acceptance.executionOnlySummary')
            : acceptedRules.map((rule) => `${rule.id}: ${rule.text}`).join('\n'),
          rules: acceptedRules,
          acceptanceMode: mode,
        },
      })
      const { getAmphiWsConnection } = await import('@/lib/amphiWsConnection')
      getAmphiWsConnection().acceptRule(payload.sessionId, {
        request_id: request.requestId,
        mode,
        decisions,
        feedback,
        supplement: '',
      })
      const next = new Map(_get(_bySession))
      next.delete(payload.sessionId)
      set(_bySession, next)
      set(markSessionAnsweredAtom, payload.sessionId)
      rlog.debug('[human-request] acceptance rules responded', {
        sessionId: payload.sessionId,
      })
      return
    }
    const answered = payload.answers
      .map((answer, index) => ({ ...answer, index }))
      .filter((entry) => Boolean(entry.answer))
    if (answered.length === 0) return
    if (request?.requestId) {
      // Structured resume: stable option ids travel the wire; display copy stays
      // local, so relabeling/relocalizing an option can never change what
      // executes. The answered card is retained as the turn's confirmation row —
      // no user message is produced (mirrors the accept_rule branch).
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
