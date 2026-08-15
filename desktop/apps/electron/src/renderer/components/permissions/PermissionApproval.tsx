/**
 * Tool permission approval card — rendered inline in the session stream (the daemon's `permission_request` gate).
 *
 * A batch of tool calls judged ASK has suspended the current turn, waiting for per-item approval:
 *   - single tool: one card + custom instructions + "deny / allow (allow with instructions)" at the bottom, where **clicking is the decision**;
 *   - multiple tools: per-row "deny / allow" + "deny all / allow all (N items)" at the bottom, with
 *     **high-risk items stripped out** so they must be clicked individually.
 * Once each item is decided it leaves an inline trace (DecidedChip); when every item has been
 * decided → a `permission_answer` frame is assembled by `callIndex` and sent back through the
 * **dedicated channel** `respondPermissionAtom` (producing no user message), and the daemon resumes
 * item by item.
 *
 * Two states: **pending** (`decided` false/absent, interactive) and **decided** (terminal, rehydrated
 * from the transcript, each item carrying its `decision`, read-only trace). The terminal state seeds
 * the local state from the items' `decision` and marks it as already submitted, reusing the same
 * rendering — so after a refresh the card still shows approved/denied instead of repainting an
 * undecided card.
 *
 * Risk colours / category icons are **purely presentational** (the kernel has no notion of risk), and the interaction state is component-local UI (§1.12).
 *
 * **What red means**: it is used only for "terminally denied" (DecidedChip's denied state) and for
 * "this really will destroy existing content" (RiskBadge's delete badge). The card border is always
 * brand blue and a high-risk header uses warning orange — "awaiting confirmation" is not "something
 * went wrong", and what reaches an approval card is basically "the system is unsure about the blast
 * radius". Flooding the whole card in red scares users off before they have read the content and
 * pushes them toward denying, which stops the task from getting done (this is real user feedback, not
 * an aesthetic preference).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { respondPermissionAtom, type PermissionDecision } from '@/atoms/permissions'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { categoryMeta, DecidedChip, deriveRisk, PIcon, RiskBadge } from './icons'

/** The verdict for one call inside a permission block (matching `MessageBlock`'s permission variant).
 *  `decision` only exists on a decided (terminal) card. */
export interface PermissionBlockItem {
  callIndex: number
  tool: string
  arguments: unknown
  capability: string
  boundary: string
  label: string
  summary?: string
  decision?: 'allow' | 'deny'
  instruction?: string | null
}

/** The allow/deny question for one item in a permission block. */
export interface PermissionBlockQuestion {
  question: string
  options: { label: string; description?: string }[]
}

export interface PermissionApprovalProps {
  items: PermissionBlockItem[]
  questions: PermissionBlockQuestion[]
  /** Ties the response to the suspended turn; required on a pending card (null on a decided card). */
  requestId?: string | null
  /** Terminal marker: this card has been decided (rehydrated from the transcript), render read-only. */
  decided?: boolean
  /** Owning Session; defaults to the active root conversation. */
  sessionId?: string
  /** Remove inline-card margins and chrome when hosted by the shared overlay. */
  floating?: boolean
}

/** Command/argument text shown for an approval item: bash and friends that carry `command` have their
 *  raw text extracted (newlines preserved, never truncated); other tools get pretty multi-line JSON.
 *  Showing it in full is backed by the renderer's max-height + scrolling. */
function commandText(args: unknown): string {
  if (args && typeof args === 'object' && 'command' in args) {
    const cmd = (args as { command?: unknown }).command
    if (typeof cmd === 'string') return cmd
  }
  try {
    const s = JSON.stringify(args, null, 2)
    return !s || s === '{}' ? '' : s
  } catch {
    return ''
  }
}

/** Command code block (monospace, scrollable, complete and untruncated). */
function CommandBlock({ cmd }: { cmd: string }) {
  return (
    <pre className="mt-1.5 m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-subtle bg-bg-input px-2.5 py-1.5 font-mono text-xs leading-[1.6] text-text-primary">
      {cmd}
    </pre>
  )
}

/** Body of an approval item: **the explanation leads**, the command supplements it — expanded on
 *  demand via "view command" (a disclosure, not a side-by-side toggle). When there is no explanation
 *  (the classifier produced no summary) the command is the body and is shown directly. */
function ItemBody({ summary, cmd }: { summary?: string; cmd: string }) {
  const { t } = useTranslation()
  const [showCmd, setShowCmd] = useState(false)
  if (!summary) {
    return cmd ? <CommandBlock cmd={cmd} /> : null
  }
  return (
    <div className="mt-2">
      <div className="rounded-md border border-border-subtle bg-bg-input px-2.5 py-1.5 text-sm leading-[1.6] text-text-primary">
        {summary}
      </div>
      {cmd && (
        <>
          <button
            type="button"
            onClick={() => setShowCmd((v) => !v)}
            className="mt-1 text-[11px] font-medium text-brand-blue"
          >
            {showCmd ? t('permission.command.collapse') : t('permission.command.expand')}
          </button>
          {showCmd && <CommandBlock cmd={cmd} />}
        </>
      )}
    </div>
  )
}

/** Explanation text: 3 lines at most by default, with "expand/collapse" when the content is truncated — so a long rationale is not cut off on a single line. */
function ClampText({ text }: { text: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Measure whether the content is truncated while clamped (depends on `text` only: no re-measure after expanding, so the button does not disappear when expanded).
  useEffect(() => {
    const el = ref.current
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1)
  }, [text])
  return (
    <div className="mt-0.5">
      <div
        ref={ref}
        className={cn('text-[11px] leading-[1.5] text-text-secondary', !expanded && 'line-clamp-3')}
      >
        {text}
      </div>
      {clamped && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[11px] font-medium text-brand-blue"
        >
          {expanded ? t('permission.clamp.collapse') : t('permission.clamp.expand')}
        </button>
      )}
    </div>
  )
}

// The dialog is mostly about "the system is unsure" rather than "definitely dangerous", so the default
// wording is a neutral "confirm" narrative; only high risk (really deleting existing content) spells
// out the consequence — say what it is and encourage a careful, informed approval rather than scaring the user off.
function headTitle(t: TFunction, isSingle: boolean, count: number, high: boolean, decided: boolean): string {
  if (decided) return isSingle ? t('permission.head.decidedSingle') : t('permission.head.decidedMulti', { n: count })
  if (!isSingle) return t('permission.head.pendingMulti', { n: count })
  return high ? t('permission.head.pendingHigh') : t('permission.head.pendingSingle')
}

function headSubtitle(t: TFunction, isSingle: boolean, high: boolean, decided: boolean): string {
  if (decided) return t('permission.sub.decided')
  if (!isSingle) return t('permission.sub.multi')
  return high ? t('permission.sub.high') : t('permission.sub.single')
}

/** Status footnote on a decided single-tool card. Allow with instructions → the backend replans under
 *  those constraints (it does not execute verbatim); deny with a note → the backend folds the note
 *  into the deny reason so the agent can reroute. All four combinations get their own wording so the
 *  transcript never contradicts the actual behaviour. */
function decidedNote(t: TFunction, allow: boolean, hasInstruction: boolean): string {
  if (!allow) return hasInstruction ? t('permission.note.denyWithInstruction') : t('permission.note.deny')
  return hasInstruction ? t('permission.note.allowWithInstruction') : t('permission.note.allow')
}

/** Inline decision buttons (deny/allow, small). */
function RowActions({ onDeny, onAllow }: { onDeny: () => void; onAllow: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        onClick={onDeny}
        className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border-default text-status-error"
        aria-label={t('permission.action.deny')}
      >
        {PIcon.ban(12)}
      </button>
      <button
        onClick={onAllow}
        className="inline-flex items-center gap-1 px-2.5 h-6 rounded-md bg-brand-blue text-white text-xs font-semibold"
      >
        {PIcon.check(11)} {t('permission.action.allow')}
      </button>
    </div>
  )
}

export function PermissionApproval({
  items,
  requestId,
  decided: decidedProp,
  sessionId: explicitSessionId,
  floating = false,
}: PermissionApprovalProps) {
  const { t } = useTranslation()
  const respond = useSetAtom(respondPermissionAtom)
  // The approval card always renders inside the currently open session (the daemon only produces this gate in the active session), so the response goes back through this session.
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const sessionId = explicitSessionId ?? activeSessionId
  // Terminal card: seed the local decision state from the items' decision (the useState initial value
  // below) and reuse the same rendering to show the trace (§1.17: derive the initial value with useMemo,
  // do not sync it with an effect).
  const seeded = useMemo<Record<number, boolean>>(() => {
    if (!decidedProp) return {}
    const m: Record<number, boolean> = {}
    items.forEach((it, i) => {
      if (it.decision) m[i] = it.decision === 'allow'
    })
    return m
  }, [decidedProp, items])
  const [decided, setDecided] = useState<Record<number, boolean>>(seeded)
  const [instruction, setInstruction] = useState('')
  const [submitted, setSubmitted] = useState(decidedProp === true)

  // Empty items: rendering it would produce a dead card saying "0 operations need authorisation" with
  // no buttons at all, while locking the composer. The trigger path is real — on rehydration
  // `items: pendingRequest.items ?? []` does not check for non-empty, and `RoundPermission.items` is
  // simply absent/empty in older persisted rows. Degrade in place to a single explanatory line.
  if (items.length === 0) {
    return (
      <div className="my-2.5 max-w-[640px] rounded-lg border border-status-warning bg-bg-elevated px-4 py-3">
        <div className="text-sm font-bold text-text-primary">{t('permission.empty.title')}</div>
        <div className="mt-1 text-[11px] text-text-secondary">
          {t('permission.empty.desc')}
        </div>
      </div>
    )
  }

  // The risk level is read only from the backend's objective verdict flag — under the auto path the
  // label is free text produced by the classifier, and substring-matching it yields conclusions that
  // contradict the verdict (see deriveRisk).
  const risks = items.map((it) => deriveRisk(it))
  const anyHigh = risks.includes('high')
  const isSingle = items.length === 1
  // Custom instructions on a single-tool card (taken from the input box while live, from the stored item on rehydration). Allow = execution constraint, deny = deny reason.
  const cardInstruction = (instruction.trim() || items[0]?.instruction || '').trim()
  // Echo on a decided card: shown for both allow and deny (both send instructions back); while pending it is still in the input box, so it is not shown twice.
  const shownInstruction = decided[0] !== undefined ? cardInstruction : ''
  const decidedCount = items.filter((_, i) => decided[i] !== undefined).length
  const allDecided = items.length > 0 && decidedCount === items.length
  const pendingNonHigh = items.filter((_, i) => risks[i] !== 'high' && decided[i] === undefined).length
  const highPending = items.filter((_, i) => risks[i] === 'high' && decided[i] === undefined).length

  // Without sessionId / requestId the response can never be sent. In that case we **must not** record a
  // local decision — otherwise the buttons turn into an "allowed" chip and it looks like it worked while
  // the respond was never issued: the backend is still waiting for an answer, the composer stays locked
  // forever by hasPendingPermission, and the hint still tells the user to handle the permission request
  // above. A complete deadlock.
  const canSubmit = Boolean(sessionId && requestId)

  // Clicking is the decision: if every item is decided after the action, assemble and send the response
  // immediately (submitted from the event handler, not via setState in an effect — that would violate
  // react-hooks/set-state-in-effect).
  function applyDecisions(next: Record<number, boolean>): void {
    if (!canSubmit && !decidedProp) {
      rlog.warn('[permissions] missing sessionId/requestId; decision was not recorded', { sessionId, requestId })
      return
    }
    setDecided(next)
    const allNow = items.length > 0 && items.every((_, i) => next[i] !== undefined)
    if (allNow && !submitted && sessionId && requestId) {
      const trimmed = instruction.trim() || undefined
      const decisions: PermissionDecision[] = items.map((it, i) => ({
        callIndex: it.callIndex,
        allow: next[i] === true,
        // Custom instructions on a single-tool card: when allowing = an execution constraint (the backend
        // replans under it), when denying = a deny reason / rerouting suggestion (the backend folds it into
        // the deny reason). A multi-tool card has no input box, so trimmed is always undefined.
        instruction: trimmed,
      }))
      void respond({ sessionId, requestId, decisions })
      setSubmitted(true)
    }
  }

  const decide = (i: number, allow: boolean): void => applyDecisions({ ...decided, [i]: allow })
  const allowNonHigh = (): void => {
    const next = { ...decided }
    items.forEach((_, i) => {
      if (risks[i] !== 'high') next[i] = true
    })
    applyDecisions(next)
  }
  const denyAllPending = (): void => {
    const next = { ...decided }
    items.forEach((_, i) => {
      if (next[i] === undefined) next[i] = false
    })
    applyDecisions(next)
  }

  return (
    <div
      className={cn(
        floating
          ? 'w-full rounded-lg overflow-hidden bg-bg-elevated border-l-[3px]'
          : 'my-2.5 max-w-[640px] rounded-lg overflow-hidden shadow-md bg-bg-elevated border-l-[3px]',
        // The border is always brand blue: awaiting confirmation is not "something went wrong". Red is
        // narrowed to "terminally denied / will really destroy existing content" and reserved for RiskBadge's
        // delete badge and DecidedChip's denied state.
        'border border-brand-blue',
      )}
    >
      {/* Header */}
      {/* High risk uses warning orange rather than danger red: a fully red card scares users off before they
          have read the content and pushes them toward denying, so the task never gets done (and what reaches
          an approval card is basically "the system is unsure about the blast radius", not "definitely
          dangerous"). Orange still separates it clearly from the regular blue, which is enough to say "give
          this one a second look". */}
      <div className={cn('flex items-center gap-2.5 px-4 py-2.5', anyHigh ? 'bg-status-warning-bg' : 'bg-accent-blue-subtle')}>
        <span className={anyHigh ? 'text-status-warning' : 'text-brand-blue'}>
          {anyHigh ? PIcon.alert(16) : PIcon.shield(16)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-text-primary">{headTitle(t, isSingle, items.length, anyHigh, decidedProp === true)}</div>
          <div className="text-[11px] text-text-secondary mt-px">{headSubtitle(t, isSingle, anyHigh, decidedProp === true)}</div>
        </div>
      </div>

      {/* Row list */}
      <div className={isSingle ? 'px-4 pt-3.5' : 'p-3'}>
        <div className={isSingle ? '' : 'rounded-md border border-border-subtle overflow-hidden'}>
          {items.map((item, i) => {
            const risk = risks[i] ?? 'med'
            const cat = categoryMeta(item.capability)
            const cmd = commandText(item.arguments)
            const state = decided[i]
            return (
              <div
                key={i}
                className={cn(
                  !isSingle && 'px-3 py-2.5',
                  !isSingle && i < items.length - 1 && 'border-b border-border-subtle',
                  !isSingle && risk === 'high' && state === undefined && 'bg-status-warning-bg',
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span className={cn('w-7 h-7 rounded-md flex items-center justify-center shrink-0', cat.bg, cat.tint)}>
                    {cat.icon(15)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-text-primary truncate">{item.tool}</span>
                      <RiskBadge risk={risk} />
                    </div>
                    {item.label && <ClampText text={item.label} />}
                  </div>
                  {!isSingle &&
                    (state === undefined ? (
                      <RowActions onDeny={() => decide(i, false)} onAllow={() => decide(i, true)} />
                    ) : (
                      <DecidedChip allow={state} />
                    ))}
                </div>
                <ItemBody summary={item.summary} cmd={cmd} />
              </div>
            )
          })}
        </div>

        {/* Single tool: custom instructions + bottom decision / decided trace */}
        {isSingle && decided[0] === undefined && (
          <>
            <div className="mt-3">
              <div className="text-[11px] font-semibold text-text-tertiary mb-1.5">{t('permission.instruction.label')}</div>
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={t('permission.instruction.placeholder')}
                className="w-full bg-bg-input border border-border-subtle rounded-md px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-brand-blue"
              />
            </div>
            <div className="flex items-center gap-2 mt-3 pb-3.5">
              <button
                onClick={() => decide(0, false)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border border-border-default text-xs font-semibold text-status-error"
              >
                {PIcon.ban(13)} {instruction.trim() ? t('permission.action.denyWithInstruction') : t('permission.action.deny')}
              </button>
              <span className="flex-1" />
              {instruction.trim() && <span className="text-[10px] text-text-tertiary">{t('permission.instruction.onceOnly')}</span>}
              <button
                onClick={() => decide(0, true)}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-brand-blue text-white text-xs font-semibold"
              >
                {PIcon.check(13)} {instruction.trim() ? t('permission.action.allowWithInstruction') : t('permission.action.allow')}
              </button>
            </div>
          </>
        )}
        {isSingle && decided[0] !== undefined && (
          <div className="mt-3 pb-3.5">
            <div className="flex items-center gap-2.5">
              <DecidedChip allow={decided[0]} />
              <span className="text-[11px] text-text-tertiary">{decidedNote(t, decided[0], shownInstruction !== '')}</span>
            </div>
            {shownInstruction && (
              <div className="mt-1.5 rounded-md border border-border-subtle bg-bg-input px-2.5 py-1.5 text-[11px] leading-[1.5] text-text-secondary break-words">
                <span className="text-text-tertiary">{t('permission.instruction.echoLabel')}</span>
                {shownInstruction}
              </div>
            )}
          </div>
        )}

        {/* Multiple tools: high-risk notice + bulk actions at the bottom */}
        {!isSingle && (
          <>
            {highPending > 0 && (
              <div className="flex gap-2 px-3 py-2 rounded-md bg-status-warning-bg mt-3">
                <span className="text-status-warning shrink-0 mt-px">{PIcon.alert(12)}</span>
                <span className="text-[11px] text-text-primary leading-relaxed">
                  <b>{t('permission.highNotice.bold', { n: highPending })}</b>{t('permission.highNotice.rest')}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2.5 mt-3">
              <span className="text-[11px] text-text-tertiary shrink-0">
                {allDecided ? (
                  <span className="text-status-success font-semibold">{t('permission.progress.allDone', { n: items.length })}</span>
                ) : (
                  <>
                    {t('permission.progress.pendingLabel')} <b className="text-text-secondary">{items.length - decidedCount}</b> / {items.length}
                  </>
                )}
              </span>
              <span className="flex-1" />
              {/* "Deny all" is unaffected by the high-risk stripping — it denies every undecided item, which is the
                  **safe direction**, and it should not disappear just because the whole batch was judged high risk
                  (that would leave a user who wants to deny everything in one click unable to do so). */}
              {!allDecided && (
                <>
                  <button
                    type="button"
                    onClick={denyAllPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-default text-xs font-semibold text-status-error"
                  >
                    {PIcon.ban(12)} {t('permission.action.denyAll')}
                  </button>
                  {pendingNonHigh > 0 && (
                    <button
                      type="button"
                      onClick={allowNonHigh}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-blue text-white text-xs font-semibold"
                    >
                      {PIcon.check(12)} {t('permission.action.allowAll', { n: pendingNonHigh })}
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
