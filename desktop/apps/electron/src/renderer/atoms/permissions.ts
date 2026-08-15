/**
 * Frontend state of the tool permission gate: sending approvals back + reading/writing the execution mode.
 *
 * The approval card renders inline in the conversation stream (its data lives in the permission
 * block of `atoms/agent.ts`). After the user decides item by item, `respondPermissionAtom` sends
 * it back over a **dedicated `permission_answer` frame** (no longer stuffed into a chat message):
 * per item `{call_index, decision, instruction?}`, carrying `request_id`; the daemon resumes the
 * suspended turn item by item by call_index, producing no user message.
 *
 * The execution mode (request|auto|full) is a global user attribute, read/written via `/me/execution-mode`.
 */
import { atom } from 'jotai'
import { i18n } from '@/lib/i18n'
import { rlog } from '@/lib/logger'
import { buildAmphiClient } from './backend'
import { markSessionAnsweredAtom } from './sessions'
import { showToastAtom } from './toast'

/** Global tool-permission execution mode. */
export type ExecutionMode = 'request' | 'auto' | 'full'

/** One approval decision: the allow/deny for a particular ASK call in the suspended turn (aligned
 *  by `callIndex`); `instruction` is attached only on allow, constraining this execution. */
export interface PermissionDecision {
  callIndex: number
  allow: boolean
  instruction?: string
}

/**
 * Submits the approval decisions: assembles a `permission_answer` frame and sends it back over the
 * dedicated channel (not through chat, producing no user message); the daemon resumes the
 * suspended turn item by item by call_index. A missing requestId / no decisions is a no-op.
 */
export const respondPermissionAtom = atom(
  null,
  async (
    _get,
    set,
    payload: {
      sessionId: string
      requestId: string
      decisions: PermissionDecision[]
    },
  ) => {
    if (!payload.requestId || payload.decisions.length === 0) return
    const answers = payload.decisions.map((d) => ({
      call_index: d.callIndex,
      decision: d.allow ? ('allow' as const) : ('deny' as const),
      instruction: d.instruction?.trim() || undefined,
    }))
    // Optimistically mark the card as decided: it shows the terminal state immediately, and after
    // the follow-up openTurn solidifies it (stream → message, component remount) it is still the
    // terminal state rather than reverting to the button state. The dynamic import keeps
    // agent ↔ permissions acyclic (mirroring human-request).
    const agent = await import('./agent')
    set(agent.markPermissionDecidedAtom, {
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      decisions: payload.decisions,
    })
    set(agent.prepareInteractionContinuationAtom, { sessionId: payload.sessionId })
    set(markSessionAnsweredAtom, payload.sessionId)
    const { getAmphiWsConnection } = await import('@/lib/amphiWsConnection')
    getAmphiWsConnection().respondPermission(payload.sessionId, {
      request_id: payload.requestId,
      answers,
    })
    const allow = answers.filter((a) => a.decision === 'allow').length
    rlog.debug('[permissions] responded via permission_answer', {
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      total: answers.length,
      allow,
      deny: answers.length - allow,
    })
  },
)

// ── Execution mode ──
const _executionMode = atom<ExecutionMode>('auto')

/** Current execution mode (read-only). */
export const executionModeAtom = atom((get) => get(_executionMode))

/** Reads the execution mode from the daemon (GET /me/execution-mode). */
export const loadExecutionModeAtom = atom(null, async (get, set) => {
  try {
    const client = buildAmphiClient(get)
    if (!client) return
    const { mode } = await client.getExecutionMode()
    set(_executionMode, mode)
  } catch (err) {
    rlog.warn('[permissions] load execution-mode failed', err)
  }
})

/**
 * Switches the execution mode: optimistic local update + POST /me/execution-mode;
 * **on failure it MUST roll back and rethrow**.
 *
 * The displayed safety tier must not lie. Silently swallowing a failure leads to: the user
 * switches to "request approval" and the UI shows it too, while the daemon
 * is still on `auto` —— the user therefore assumes "from now on it will ask me about everything",
 * whereas subsequent grey-area calls are in fact let straight through. That displays the tier as
 * **stricter than it really is**, which is the worst direction to be wrong in.
 */
export const setExecutionModeAtom = atom(null, async (get, set, mode: ExecutionMode) => {
  const previous = get(_executionMode)
  set(_executionMode, mode)
  try {
    const client = buildAmphiClient(get)
    if (!client) throw new Error(i18n.t('error.daemonNotReadyExecutionMode'))
    await client.setExecutionMode(mode)
  } catch (err) {
    set(_executionMode, previous) // Better to leave the UI unchanged than to display it as stricter than reality
    set(showToastAtom, i18n.t('error.executionModeSwitchFailed'))
    rlog.warn('[permissions] set execution-mode failed', err)
  }
})
