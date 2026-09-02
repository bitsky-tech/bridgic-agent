/**
 * WebSocket wire protocol — the SINGLE source of truth for every frame the
 * renderer exchanges with the daemon over `/ws`.
 *
 * Three event families live here, each with a `const` vocabulary object + the
 * typed frame/event shapes that go on the wire:
 *  1. Outbound client frames (renderer → daemon): `hello` / `subscribe` / `chat`
 *  2. Inbound control frames (daemon → renderer, non-turn): `ready` / `ack` /
 *     `cmd_error` / `system.shutdown`
 *  3. Per-session turn events (daemon → renderer stream): `token` / `tool` / … —
 *     translated into renderer `AgentEvent`s by `lib/turnTranslate.ts`.
 *
 * Invariants:
 *  - Every magic string a `switch`/object-literal needs is a member of one of
 *    the three `const` objects below — never a bare literal at the call site.
 *    Rename an event in ONE place here and every consumer updates with it.
 *  - The frame `data`/payload is still re-validated at the boundary by Zod in
 *    `turnTranslate.ts` (untrusted external data) — these types document the
 *    contract; they do NOT replace runtime validation.
 *
 * Contract source: the backend models in `amphi_service.protocol._ws_messages`
 * and `amphi_service.protocol._events`. Both ends MUST stay aligned.
 *
 * Re-exported through `./types` so consumers import from `@shared/types`.
 */
import type { SubAgentMode } from '@app/shared/types'
import type { AskUserQuestion, PermissionItem } from './agent-events'

// ───── Topics ────────────────────────────────────────────────────────────────

/** The process-wide system topic (daemon lifecycle frames). */
export const SYSTEM_TOPIC = 'system'

/** Per-session topic name — subscribe to receive a session's turn events. */
export function sessionTopic(sessionId: string): string {
  return `session:${sessionId}`
}

// ───── Chat input blocks (payload of the outbound `chat` frame) ──────────────

/** One structured input block — mirrors the composer `Segment` (text / @mention
 *  / /slash). Sent as `ChatFrame.blocks`; the daemon walks them in order to
 *  inline-resolve @mention paths in place. `group` rides for GUI history badge
 *  rendering only (the daemon ignores it).
 *
 *  `path` (optional) = mount-relative POSIX path for @-referencing a file/
 *  folder INSIDE a mounted folder; absent = the mount root. Deliberately
 *  mount-id + RELATIVE path, not a client-built absolute path: resolution
 *  must stay anchored to the session's ownership-gated mount table on the
 *  daemon (fail-closed `..`/symlink checks live there), and a removed mount
 *  then degrades its stale mentions to a clean `@label` automatically — an
 *  absolute path would bypass both. Full rationale: backend `WsMentionBlock`. */
export type ChatBlock =
  | { type: 'text'; value: string }
  | { type: 'mention'; id: string; label: string; group: string; path?: string }
  | { type: 'slash'; id: string; label: string; resource?: 'workflow' | 'schedule' }

// ───── Outbound client frames (renderer → daemon) ────────────────────────────

/** `type` tags for frames the renderer sends to the daemon. */
export const CLIENT_FRAME = {
  Hello: 'hello',
  SetLocale: 'set_locale',
  Subscribe: 'subscribe',
  Unsubscribe: 'unsubscribe',
  Chat: 'chat',
  AcceptRule: 'accept_rule',
  BuildConfirm: 'build_confirm',
  TaskConfirm: 'task_confirm',
  WorkflowConfirm: 'workflow_confirm',
  PermissionAnswer: 'permission_answer',
  ChoiceAnswer: 'choice_answer',
} as const

/** Handshake frame — first thing sent on connect. Token-less endpoints are
 *  never connected (a `hello` would 4401), so token is effectively present. */
export interface HelloFrame {
  type: typeof CLIENT_FRAME.Hello
  token?: string | null
  client_type: string
  client_id?: string | null
  /** The UI language the daemon should render its display text in. Carried in the frame
   *  because the browser WebSocket API cannot set request headers, so the handshake's
   *  `Accept-Language` reflects the OS language rather than the user's in-app choice. */
  locale?: string
}

/** Retarget the daemon's display language mid-connection, after the user switches the UI
 *  language. A frame rather than a reconnect: the socket carries the live token stream and
 *  dropping it would abort the reply on screen. */
export interface SetLocaleFrame {
  type: typeof CLIENT_FRAME.SetLocale
  locale: string
}

/** Subscribe to one or more topics (`session:<id>` or `system`). */
export interface SubscribeFrame {
  type: typeof CLIENT_FRAME.Subscribe
  topics: string[]
}

/** Stop receiving one or more topics' events (mirror of `SubscribeFrame`).
 *  Sent when a session is deleted so the daemon drops the relay AND the local
 *  `subscribed` set won't re-subscribe a dead `session:<id>` on the next
 *  reconnect. The daemon's `ChatHandler._on_unsubscribe` handler `ack`s with
 *  `for:"unsubscribe"` (ignored like every other ack). */
export interface UnsubscribeFrame {
  type: typeof CLIENT_FRAME.Unsubscribe
  topics: string[]
}

/** Start one chat turn for a session. `input` = clean flattened display text;
 *  `blocks` = the structured input the daemon walks to resolve @mentions. */
export interface ChatFrame {
  type: typeof CLIENT_FRAME.Chat
  session_id: string
  input: string
  blocks: ChatBlock[]
}

/** Resume Main after the user accepts or declines a Build proposal. */
export interface BuildConfirmFrame {
  type: typeof CLIENT_FRAME.BuildConfirm
  session_id: string
  request_id: string
  action: 'confirm' | 'cancel'
}

/** Resume Clarify with structured decisions for proposed acceptance rules. */
export interface AcceptRuleFrame {
  type: typeof CLIENT_FRAME.AcceptRule
  session_id: string
  request_id: string
  mode: 'criteria' | 'execution_only'
  decisions: ('accept' | 'reject')[]
  feedback: string[]
  supplement: string
}

/** Resume a parked task-contract review from the Clarify stage. */
export interface TaskConfirmFrame {
  type: typeof CLIENT_FRAME.TaskConfirm
  session_id: string
  request_id: string
  action: 'confirm' | 'revise'
  feedback?: string | null
}

/** Save or cancel a Workflow Build and resume its parked confirmation turn. */
export interface WorkflowConfirmFrame {
  type: typeof CLIENT_FRAME.WorkflowConfirm
  session_id: string
  request_id: string
  action: 'confirm' | 'save_as_new' | 'cancel'
  name?: string | null
}

/** One held call's decision inside a `PermissionAnswerFrame`. `call_index` is the
 *  held call's position in the parked round (echoed from the request's item);
 *  `instruction` (optional) constrains an allowed call. Wire is snake_case to
 *  match the daemon's `WsPermissionAnswerItem`. */
export interface PermissionAnswerItem {
  call_index: number
  decision: 'allow' | 'deny'
  instruction?: string | null
}

/** Resume a parked permission turn with the user's per-call decisions — the
 *  DEDICATED approval channel (never a chat message, so it produces no user
 *  message). `request_id` must match the parked `permission_request`; a stale /
 *  duplicate one is ignored by the daemon (idempotent). */
export interface PermissionAnswerFrame {
  type: typeof CLIENT_FRAME.PermissionAnswer
  session_id: string
  request_id: string
  answers: PermissionAnswerItem[]
}

/** One question's resolved answer inside a `ChoiceAnswerFrame`. `index` is the
 *  question's position in the card's `questions`; exactly one of `option_id`
 *  (the clicked option's stable backend-owned id) / `text` (free-typed "other"
 *  input) carries the answer. Wire is snake_case to match the daemon's
 *  `WsChoiceAnswerItem`. */
export interface ChoiceAnswerItem {
  index: number
  option_id?: string
  text?: string
}

/** Resume a parked choice card (request_human_choice / build_conflict /
 *  workflow_run_choice) with the selected option ids — the DEDICATED choice
 *  channel (never a chat message, so it produces no user message). Ids resolve
 *  to actions on the daemon; display copy never travels back, so relabeling or
 *  relocalizing an option can't change what executes. `request_id` must match
 *  the parked ask; a stale one is ignored (idempotent). */
export interface ChoiceAnswerFrame {
  type: typeof CLIENT_FRAME.ChoiceAnswer
  session_id: string
  request_id: string
  answers: ChoiceAnswerItem[]
}

/** Union of every frame the renderer sends. */
export type ClientFrame =
  | HelloFrame
  | SetLocaleFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | ChatFrame
  | AcceptRuleFrame
  | BuildConfirmFrame
  | TaskConfirmFrame
  | WorkflowConfirmFrame
  | PermissionAnswerFrame
  | ChoiceAnswerFrame

// ───── Inbound control frames (daemon → renderer, non-turn) ──────────────────

/** `type` tags for the daemon's non-turn control frames. */
export const CONTROL_FRAME = {
  /** Handshake complete — safe to subscribe + send chat. */
  Ready: 'ready',
  /** Handshake noise; daemon attaches the relay synchronously. Ignored. */
  Ack: 'ack',
  /** A command (e.g. chat) failed before producing turn events. */
  CmdError: 'cmd_error',
  /** Daemon is shutting down — fail in-flight turns. */
  Shutdown: 'system.shutdown',
  /** A session's turn finished — cross-session broadcast for the unread dot. */
  SessionCompleted: 'session.completed',
  /** Child Session lifecycle event. */
  SubAgentEvent: 'subagent.event',
  /** A scheduled run failed / needs a human — show a desktop notification.
   *  Only sent when a gui client is subscribed; otherwise the daemon falls
   *  back to its OS-level notifier. title/body arrive pre-localized. */
  ScheduleNotify: 'schedule.notify',
} as const

export interface ReadyFrame {
  type: typeof CONTROL_FRAME.Ready
}
export interface AckFrame {
  type: typeof CONTROL_FRAME.Ack
}
export interface CmdErrorFrame {
  type: typeof CONTROL_FRAME.CmdError
  session_id?: string
  message?: string
}
export interface ShutdownFrame {
  type: typeof CONTROL_FRAME.Shutdown
}
export interface SessionCompletedFrame {
  type: typeof CONTROL_FRAME.SessionCompleted
  session_id: string
}
export interface SubAgentEventFrame {
  type: typeof CONTROL_FRAME.SubAgentEvent
  session_id: string
  invocation_id: string
  parent_invocation_id: string | null
  parent_tool_call_id: string | null
  mode: SubAgentMode
  goal: string
  status: string
  phase: 'started' | 'status'
  answer: string | null
  error: string | null
}
export interface ScheduleNotifyFrame {
  type: typeof CONTROL_FRAME.ScheduleNotify
  kind: 'failed' | 'action_required'
  title: string
  body: string
  session_id: string
  schedule_id: string
  schedule_name: string
}

/** Union of the daemon's non-turn control frames. */
export type ControlFrame =
  | ReadyFrame
  | AckFrame
  | CmdErrorFrame
  | ShutdownFrame
  | SessionCompletedFrame
  | SubAgentEventFrame
  | ScheduleNotifyFrame

// ───── Turn events (daemon → renderer, per-session stream) ───────────────────
//
// Mirrors backend turn-event models. Translated into renderer AgentEvents by turnTranslate.ts.

/** The daemon's full turn-event vocabulary. `final` / `cancelled` / `error` are terminal for
 *  a turn's bus; the rest are streamed mid-turn. `loop_abort` /
 *  `model_switch_warning` are non-terminal guards the translator currently
 *  ignores (they fall through to its `default`), but they're listed here so the
 *  vocabulary is complete in one place. */
export const TURN_EVENT = {
  Token: 'token',
  Reasoning: 'reasoning',
  ModelRetry: 'model_retry',
  ContextCompaction: 'context_compaction',
  ContextUsage: 'context_usage',
  Tool: 'tool',
  ToolResult: 'tool_result',
  Stage: 'stage',
  Title: 'title',
  Final: 'final',
  Cancelled: 'cancelled',
  Error: 'error',
  HumanRequest: 'human_request',
  AcceptRuleRequest: 'accept_rule_request',
  BuildConfirmRequest: 'build_confirm_request',
  PermissionRequest: 'permission_request',
  TaskConfirmRequest: 'task_confirm_request',
  WorkflowConfirmRequest: 'workflow_confirm_request',
  WorkflowProgress: 'workflow_progress',
  WorkflowResult: 'workflow_result',
  LoopAbort: 'loop_abort',
  ModelSwitchWarning: 'model_switch_warning',
} as const

/** Any turn-event name in the vocabulary above. */
export type TurnEventName = (typeof TURN_EVENT)[keyof typeof TURN_EVENT]

/**
 * One daemon turn-event frame (`{event, data}`). The catch-all member keeps the
 * renderer forward-compatible: the spec encourages clients to tolerate unknown
 * event names, and the translator switches on `.event`.
 */
export type TurnEvent =
  | { event: typeof TURN_EVENT.Token; data: { text: string } }
  | { event: typeof TURN_EVENT.Reasoning; data: { text: string } }
  | {
      event: typeof TURN_EVENT.ModelRetry
      data: { active: boolean; attempt: number; max_retries: number; delay_seconds: number }
    }
  | { event: typeof TURN_EVENT.ContextCompaction; data: { active: boolean } }
  | {
      event: typeof TURN_EVENT.ContextUsage
      data: {
        model_id: string
        input_tokens: number
        output_tokens: number
        used_tokens: number
        usable_tokens: number | null
        percentage: number | null
        source: 'provider' | 'estimated'
      }
    }
  | { event: typeof TURN_EVENT.Tool; data: { name: string; arguments: Record<string, unknown> } }
  | {
      event: typeof TURN_EVENT.ToolResult
      data: { success: boolean; error: string | null; output: string; duration_ms?: number }
    }
  | {
      event: typeof TURN_EVENT.Stage
      data: {
        mode: 'build' | 'normal' | 'presentation' | 'run_workflow'
        stage: string | null
        workflow_id?: string | null
        presentation_goal?: string | null
        presentation_step_index?: number
        presentation_reports?: Array<{
          stage: string
          step_id: string
          summary: string
          evidence: string[]
        }>
      }
    }
  | { event: typeof TURN_EVENT.Title; data: { title: string } }
  | { event: typeof TURN_EVENT.LoopAbort; data: { reason: string } }
  | {
      event: typeof TURN_EVENT.Final
      data: {
        answer: string | null
        tokens_spent: number
        duration_ms?: number
        completed_at?: string | null
      }
    }
  | { event: typeof TURN_EVENT.Cancelled; data: Record<string, never> }
  | { event: typeof TURN_EVENT.Error; data: { message: string } }
  | {
      event: typeof TURN_EVENT.HumanRequest
      data: { prompt?: string; questions: AskUserQuestion[]; request_id?: string | null }
    }
  | {
      event: typeof TURN_EVENT.AcceptRuleRequest
      data: { request_id: string; rules: string[] }
    }
  | {
      event: typeof TURN_EVENT.BuildConfirmRequest
      data: { request_id: string; goal: string; reason?: string | null }
    }
  // Permission gate: reuses request_human_choice's questions and attaches the
  // criteria items for each pending call (one-to-one with questions), for the
  // inline approval card to render. request_id is what correlates the
  // permission_answer sent back.
  // Note: on the wire the items use snake-case `call_index`, which turnTranslate
  // normalizes to camel-case `callIndex`.
  | {
      event: typeof TURN_EVENT.PermissionRequest
      data: { questions: AskUserQuestion[]; items: PermissionItem[]; request_id: string | null }
    }
  | {
      event: typeof TURN_EVENT.TaskConfirmRequest
      data: {
        request_id: string
        task_markdown: string
        previous_task_markdown?: string | null
        operation?: 'create' | 'edit'
        workflow_id?: string | null
        original_task_markdown?: string | null
      }
    }
  | {
      event: typeof TURN_EVENT.WorkflowConfirmRequest
      data: { request_id: string; default_name: string; summary?: string | null }
    }
  | {
      event: typeof TURN_EVENT.WorkflowProgress
      data: {
        workflow_id: string
        generation: string
        workflow_name: string
        phase: 'execute' | 'validate'
        step_index: number
        step_count: number
        title: string
        status: 'running' | 'success' | 'failure'
        summary?: string | null
        execution_steps?: string[]
        validation_steps?: string[]
      }
    }
  | {
      event: typeof TURN_EVENT.WorkflowResult
      data: {
        run_id: string
        workflow_id: string
        workflow_name: string
        status: 'completed' | 'failed'
        validation_status: 'passed' | 'failed' | 'not_required'
        created_at: string
        summary?: string | null
      }
    }
  // Catch-all for forward-compatibility — unknown event names are tolerated.
  | { event: string; data: unknown }
