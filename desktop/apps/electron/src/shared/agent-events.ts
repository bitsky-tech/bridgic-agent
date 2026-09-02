/**
 * Renderer-side agent event protocol — the wire shape the daemon WS stream is
 * translated into (see `lib/turnTranslate.ts`) and consumed by the reducer
 * (`atoms/agent.ts :: applyAgentEventAtom`).
 *
 * Invariant: this is the SINGLE source of truth for `AgentEvent` /
 * `AskUserQuestion`. Previously these lived in the `@app/agent-core` package
 * (the pre-Python TypeScript agent), which has been removed now that the agent
 * runs entirely in the Python daemon (`../src`). Only the types the live
 * daemon-WS render path actually needs survived here; the dead subprocess-only
 * variants (`permission_ask`, `ask_user_request`), the never-read
 * `message_stop.usage` field, and the dead `/build` mock's `stage_change`
 * variant were dropped.
 *
 * Re-exported through `./types` so consumers keep importing from `@shared/types`.
 */

import type { SubAgentMode } from '@app/shared/types'

/** Single option inside an `AskUserQuestion`. */
export interface AskUserQuestionOption {
  /** Stable semantic value for locally generated options; display labels may be localized. */
  id?: string
  label: string
  description?: string
  /** Optional rich preview (markdown), shown next to the option list. */
  preview?: string
}

/**
 * One multiple-choice question surfaced to the user during a `human_request`
 * pause (`kind: 'choose'`). Used by the live HITL banner (`HumanRequestBanner`).
 */
export interface AskUserQuestion {
  question: string
  /** Short label shown as a chip/tab (≤12 chars works best). */
  header?: string
  options: AskUserQuestionOption[]
  /** Rich candidate review keeps long evidence out of the question text. */
  layout?: 'compact' | 'review-list'
  multiSelect?: boolean
  /** Compact questions default to true; review lists default to false. */
  allowOther?: boolean
  /** Allow an explicit no-selection answer instead of forcing a candidate. */
  allowEmpty?: boolean
  emptyLabel?: string
  minSelections?: number
  maxSelections?: number
}

/**
 * One held (ASK) tool call's judgement, carried by a `permission_request`. The
 * approval card renders risk colour / category icon / "why asked" from these
 * (`label` is the human-readable reason). `capability` / `boundary` are the
 * engine's classification (e.g. `'execute'` / `'out_of_bounds'`); the card maps
 * them to display, the kernel has no risk concept.
 */
export interface PermissionItem {
  /** The held call's position in the parked round — the stable alignment key
   *  echoed back in the `permission_answer` frame (the daemon's `StepToolCall`
   *  has no id, so the round-local index is the key). Camel-cased at the WS
   *  boundary from the wire's `call_index`. */
  callIndex: number
  tool: string
  arguments: unknown
  capability: string
  boundary: string
  label: string
  /** A plain-language summary of the command produced by the classifier (for
   *  non-technical users): what this call will actually do. Defaults to an empty string. */
  summary?: string
  /** The objective criteria flags from the backend's `Judgement` — the approval
   *  card's risk grading / high-risk extraction **may only read these** and must
   *  not parse `label`: on the auto path that label is free-form Chinese text
   *  generated on the spot by the safety classifier, and substring matching would
   *  yield conclusions opposite to the criteria. Old daemons / old persisted rows
   *  carry none of these fields, so they default to false (treated as "cannot be evaluated"). */
  sensitive?: boolean
  deletion?: boolean
  regenerable?: boolean
  uncertainDestruction?: boolean
  touchesRiskSurface?: boolean
  /** Present only on a DECIDED (terminal) card rehydrated from the transcript —
   *  the user's final verdict for this call. Absent while the card is pending. */
  decision?: 'allow' | 'deny'
  /** DECIDED card: the per-call instruction the user attached when allowing. */
  instruction?: string | null
}

/**
 * The turn's thinking position — the daemon's two-layer think loop laid bare.
 * `mode` is the loop: Build pipeline, presentation pipeline, saved Workflow run, or normal chat.
 * `stage` is the Build unit, Workflow Run unit, or Main unit; it is null on a clean
 * close frame. The Build focus rail remains active only for `mode === 'build'`.
 *
 * Carried by both the live WS `stage` event and the REST transcript's
 * `thinking_mode` (state rehydration on reload). Open `string` on `stage` because
 * display policy maps the units it knows.
 */
export interface PresentationProgressReport {
  stage: string
  stepId: string
  summary: string
  evidence: string[]
}

export interface ThinkPosition {
  mode: 'build' | 'normal' | 'presentation' | 'run_workflow'
  stage: string | null
  /** Present while Build is editing an existing saved Workflow. */
  workflowId?: string | null
  /** Presentation-only durable cursor and completed production reports. */
  presentationGoal?: string | null
  presentationStepIndex?: number
  presentationReports?: PresentationProgressReport[]
}

/** Session-level projection of one active saved Workflow run. */
export interface WorkflowRunState {
  workflowId: string
  generation: string
  workflowName: string
  sourceSessionId: string
  phase: 'execute' | 'validate'
  stepIndex: number
  executionSteps: string[]
  validationSteps: string[]
}

/** Persisted composition of the latest model call's input context. */
export interface ContextUsageBreakdown {
  systemPromptTokens: number
  dynamicContextTokens: number
  toolSchemaTokens: number
  sessionHistoryTokens: number
  currentInputTokens: number
}

/** Latest model-call context-window occupancy for one Session. */
export interface ContextUsageSnapshot {
  modelId: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number | null
  usedTokens: number
  usableTokens: number | null
  percentage: number | null
  source: 'provider' | 'estimated'
  breakdown: ContextUsageBreakdown
}

/**
 * Daemon → renderer agent event union. Produced by `translateTurnEvent` from
 * the daemon's WS `TurnEvent` frames; every variant is handled by the reducer.
 */
export type AgentEvent =
  | { type: 'message_start'; messageId: string; role: 'assistant' }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'thinking_delta'; messageId: string; text: string }
  | {
      type: 'model_retry'
      active: boolean
      attempt: number
      maxRetries: number
      delaySeconds: number
      discardTextChars: number
      discardReasoningChars: number
    }
  | { type: 'context_compaction'; active: boolean }
  | { type: 'context_usage'; usage: ContextUsageSnapshot }
  | {
      type: 'tool_call'
      messageId: string
      toolUseId: string
      toolName: string
      input: unknown
    }
  | {
      type: 'tool_result'
      toolUseId: string
      output: unknown
      isError: boolean
      durationMs: number
    }
  // Daemon HITL (WS path): the agent paused mid-turn for the user to pick from
  // a fixed set of options — the ONLY HITL kind (free-text questions are just
  // conversation: the agent asks in its reply). The answer is the session's
  // NEXT plain chat message (the daemon resumes off the PENDING status).
  | {
      type: 'human_request'
      /** Required for request_human_choice; optional only for legacy/system-owned cards. */
      prompt?: string
      questions: AskUserQuestion[]
      requestId?: string
    }
  | {
      type: 'accept_rule_request'
      requestId: string
      rules: string[]
    }
  | {
      type: 'build_confirm_request'
      requestId: string
      goal: string
      reason?: string | null
    }
  | {
      type: 'task_confirm_request'
      requestId: string
      taskMarkdown: string
      previousTaskMarkdown?: string | null
      operation?: 'create' | 'edit'
      workflowId?: string | null
      originalTaskMarkdown?: string | null
    }
  | {
      type: 'workflow_confirm_request'
      requestId: string
      defaultName: string
      summary?: string | null
      operation?: 'create' | 'edit'
      workflowId?: string | null
    }
  | {
      type: 'workflow_progress'
      workflowId: string
      generation: string
      workflowName: string
      phase: 'execute' | 'validate'
      stepIndex: number
      stepCount: number
      title: string
      status: 'running' | 'success' | 'failure'
      summary?: string | null
      executionSteps?: string[]
      validationSteps?: string[]
    }
  | {
      type: 'workflow_result'
      runId: string
      workflowId: string
      workflowName: string
      status: 'completed' | 'failed'
      validationStatus: 'passed' | 'failed' | 'not_required'
      createdAt: string
      resultFileCount?: number
      summary?: string | null
    }
  // Tool-permission gate (WS path): a batch of tool calls judged ASK paused the
  // turn awaiting approval. Unlike `human_request` (a generic banner), the
  // approval card renders INLINE in the conversation (the reducer attaches this
  // to the current assistant message's blocks). The reply goes back on the
  // DEDICATED `permission_answer` frame (NOT a chat message) — per-item allow/deny
  // keyed by `item.callIndex`, echoing `requestId`; the daemon resolves each
  // verdict and resumes without a user message. `items[i]` aligns with `questions[i]`.
  | {
      type: 'permission_request'
      requestId: string | null
      items: PermissionItem[]
      questions: AskUserQuestion[]
    }
  | {
      type: 'subagent_event'
      invocationId: string
      parentToolCallId?: string
      mode: SubAgentMode
      goal: string
      status: string
      phase: 'started' | 'status'
      answer?: string
      error?: string
    }
  | { type: 'stream_discard' }
  // The turn's thinking position moved (daemon `stage` frame): the two-layer
  // {mode, stage} — `mode` = loop ('build'|'normal'), `stage` = unit within it.
  | { type: 'stage'; position: ThinkPosition }
  // A model-generated session title is ready (daemon `title` frame): the first
  // turn streams a provisional title from the opener, then optionally a refined
  // one. Updates the sidebar entry live; the daemon also persists it.
  | { type: 'title'; title: string }
  // `finalAnswer` carries the authoritative final answer from the daemon's
  // `final` frame (an empty string = this turn has no visible answer, e.g. it
  // ended on request_human_choice); frozen into AgentMessage.finalAnswer for
  // segmentation to use.
  | {
      type: 'message_stop'
      messageId: string
      finalAnswer?: string | null
      durationMs?: number
      completedAt?: number
    }
  | { type: 'task_spawn'; taskId: string; parentTaskId?: string; description: string }
  | { type: 'task_complete'; taskId: string; summary: string }
  | { type: 'done'; reason: 'end_turn' | 'error' }
  | { type: 'done'; reason: 'cancelled'; messageId: string }
  | { type: 'command_error'; message: string }
  | { type: 'error'; message: string; code?: string }
  // A session's turn finished (daemon `session.completed` SYSTEM broadcast) —
  // cross-session, drives the sidebar unread dot. No turn / message payload.
  | { type: 'session_completed' }
