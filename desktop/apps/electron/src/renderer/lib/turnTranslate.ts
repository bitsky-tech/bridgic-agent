/**
 * Pure translator: daemon `TurnEvent` stream → renderer `AgentEvent` sequence.
 *
 * Kept separate from the WS shell so the protocol translation is testable in isolation — no
 * WebSocket, no global mutable Maps. Given the same (frame, messageId, state)
 * it deterministically returns the same { events, state }: pure, side-effect
 * free. The WS connection (amphi-ws-connection.ts) owns the socket and threads
 * the immutable `TranslatorState` per session across frames.
 *
 * Boundary validation (coding-style: external data MUST be validated at system boundaries):
 * each frame's `data` is parsed with a Zod schema. A malformed payload degrades gracefully
 * — it yields a `warning` (logged by the shell) and skips, rather than
 * crashing the turn or silently emitting an empty block. Terminal events
 * stay terminal even when their data is malformed.
 *
 * Contract: backend event models in `amphi_service.protocol._events`. `final`,
 * `cancelled`, and `error` are mutually exclusive terminal frames.
 */
import { z } from 'zod'
import type { AgentEvent, ThinkPosition, TurnEvent } from '@shared/types'
import { TURN_EVENT } from '@shared/types'
import { askUserQuestionSchema } from './askUserQuestionSchema'

/** Turn-scoped translation state, threaded immutably across frames. */
export interface TranslatorState {
  readonly started: boolean
  readonly sawContent: boolean
  readonly pendingToolIds: readonly string[]
  readonly toolSeq: number
}

/** Fresh state for a new turn — pass to the first `translateTurnEvent` call. */
export const initialTranslatorState: TranslatorState = {
  started: false,
  sawContent: false,
  pendingToolIds: [],
  toolSeq: 0,
}

export interface TranslateResult {
  events: AgentEvent[]
  state: TranslatorState
  /** Non-empty → the shell should `rlog.warn` it (pairing miss / bad payload). */
  warning?: string
}

const textDataSchema = z.object({ text: z.string().optional() })
const modelRetryDataSchema = z.object({
  active: z.boolean(),
  attempt: z.number().int().nonnegative(),
  max_retries: z.number().int().nonnegative(),
  delay_seconds: z.number().nonnegative(),
  discard_text_chars: z.number().int().nonnegative().default(0),
  discard_reasoning_chars: z.number().int().nonnegative().default(0),
})
const contextUsageDataSchema = z.object({
  model_id: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  used_tokens: z.number().int().nonnegative(),
  usable_tokens: z.number().int().positive().nullable(),
  percentage: z.number().nonnegative().nullable(),
  source: z.enum(['provider', 'estimated']),
})
const toolDataSchema = z.object({
  tool_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
})
const toolResultDataSchema = z.object({
  tool_id: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().nullable().optional(),
  output: z.string().optional(),
  // The real execution duration the daemon measures in TurnRunner, from the monotonic-clock
  // delta between on_tool (before execution) / on_tool_result (after execution); old
  // daemons don't carry this field → fall back to 0.
  duration_ms: z.number().optional(),
})
const finalDataSchema = z.object({
  answer: z.string().nullable().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  completed_at: z.string().nullable().optional(),
})
const errorDataSchema = z.object({ message: z.string().optional() })
const humanRequestDataSchema = z.object({
  prompt: z.string().optional(),
  questions: z.array(askUserQuestionSchema).default([]),
  request_id: z.string().nullable().optional(),
})
const acceptRuleDataSchema = z.object({
  request_id: z.string(),
  rules: z.array(z.string()).min(1),
})
const buildConfirmDataSchema = z.object({
  request_id: z.string(),
  goal: z.string(),
  reason: z.string().nullable().optional(),
})
const taskConfirmDataSchema = z.object({
  request_id: z.string(),
  task_markdown: z.string(),
  previous_task_markdown: z.string().nullable().optional(),
  operation: z.enum(['create', 'edit']).default('create'),
  workflow_id: z.string().nullable().optional(),
  original_task_markdown: z.string().nullable().optional(),
})
const workflowConfirmDataSchema = z.object({
  request_id: z.string(),
  default_name: z.string(),
  summary: z.string().nullable().optional(),
  operation: z.enum(['create', 'edit']).default('create'),
  workflow_id: z.string().nullable().optional(),
})
const workflowProgressDataSchema = z.object({
  workflow_id: z.string(),
  generation: z.string(),
  workflow_name: z.string(),
  phase: z.enum(['execute', 'validate']),
  step_index: z.number().int().nonnegative(),
  step_count: z.number().int().positive(),
  title: z.string(),
  status: z.enum(['running', 'success', 'failure']),
  summary: z.string().nullable().optional(),
  execution_steps: z.array(z.string()).optional(),
  validation_steps: z.array(z.string()).optional(),
})
const workflowResultDataSchema = z.object({
  run_id: z.string(),
  workflow_id: z.string(),
  workflow_name: z.string(),
  status: z.enum(['completed', 'failed']),
  validation_status: z.enum(['passed', 'failed', 'not_required']),
  created_at: z.string(),
  result_file_count: z.number().int().nonnegative().optional(),
  summary: z.string().nullable().optional(),
})
// The permission gate: questions (one allow/deny per ASK call) + the per-item judgement
// `items` (used by the inline approval card).
// The wire uses snake `call_index` (the alignment key), normalized to camel `callIndex`
// (see the map inside the case).
const permissionItemSchema = z.object({
  // The alignment key: **no default**. If a missing value collapsed to 0, the daemon would
  // parse only item 0 out of the reply and every other ASK would take the fail-closed deny
  // path — the user plainly clicked "allow" yet got silently bulk-denied. Better to fail
  // parsing the whole thing.
  call_index: z.number(),
  // Display fields: give them defaults — don't throw away the whole card just because one
  // field of one item is missing (that would hang the turn forever).
  tool: z.string().default(''),
  arguments: z.unknown(),
  capability: z.string().default(''),
  boundary: z.string().default(''),
  label: z.string().default(''),
  summary: z.string().default(''),
  // Objective judgement flags (old daemons don't send them → false → the frontend
  // conservatively treats them as medium risk, not counted toward "allow all").
  sensitive: z.boolean().default(false),
  deletion: z.boolean().default(false),
  regenerable: z.boolean().default(false),
  uncertain_destruction: z.boolean().default(false),
  touches_risk_surface: z.boolean().default(false),
})
const permissionRequestDataSchema = z.object({
  questions: z.array(askUserQuestionSchema).default([]),
  items: z.array(permissionItemSchema).default([]),
  request_id: z.string().nullable().default(null),
})
// Two-layer think position: `mode` (loop) is required; `stage` (unit) is nullable
// because normal chat is presented as {mode:'normal', stage:null} on the wire.
const stageDataSchema = z.object({
  mode: z.enum(['build', 'normal', 'run_workflow']),
  stage: z.string().nullable().optional(),
  workflow_id: z.string().nullable().optional(),
})
const titleDataSchema = z.object({ title: z.string() })

/**
 * Translate one daemon frame into renderer AgentEvents + the next state.
 *
 * @param frame - the daemon TurnEvent (`{event, data}`)
 * @param messageId - synthetic assistant message id for this turn
 * @param state - immutable translator state (start from `initialTranslatorState`)
 */
export function translateTurnEvent(
  frame: TurnEvent,
  messageId: string,
  state: TranslatorState,
): TranslateResult {
  const events: AgentEvent[] = []
  let next = state
  // A message_start must precede any content (mirrors the old ensureStarted()).
  if (!next.started) {
    events.push({ type: 'message_start', messageId, role: 'assistant' })
    next = { ...next, started: true }
  }

  switch (frame.event) {
    case TURN_EVENT.Token: {
      const r = textDataSchema.safeParse(frame.data)
      if (!r.success) return { events, state: next, warning: 'token payload invalid — skipped' }
      const t = r.data.text ?? ''
      if (t) {
        events.push({ type: 'text_delta', messageId, text: t })
        next = { ...next, sawContent: true }
      }
      return { events, state: next }
    }
    case TURN_EVENT.Reasoning: {
      const r = textDataSchema.safeParse(frame.data)
      if (!r.success) return { events, state: next, warning: 'reasoning payload invalid — skipped' }
      const t = r.data.text ?? ''
      if (t) events.push({ type: 'thinking_delta', messageId, text: t })
      return { events, state: next }
    }
    case TURN_EVENT.ModelRetry: {
      const r = modelRetryDataSchema.safeParse(frame.data)
      if (!r.success) return { events, state: next, warning: 'model_retry payload invalid — skipped' }
      events.push({
        type: 'model_retry',
        active: r.data.active,
        attempt: r.data.attempt,
        maxRetries: r.data.max_retries,
        delaySeconds: r.data.delay_seconds,
        discardTextChars: r.data.discard_text_chars,
        discardReasoningChars: r.data.discard_reasoning_chars,
      })
      return { events, state: next }
    }
    case TURN_EVENT.ContextUsage: {
      const r = contextUsageDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'context_usage payload invalid — skipped' }
      events.push({
        type: 'context_usage',
        usage: {
          modelId: r.data.model_id,
          inputTokens: r.data.input_tokens,
          outputTokens: r.data.output_tokens,
          usedTokens: r.data.used_tokens,
          usableTokens: r.data.usable_tokens,
          percentage: r.data.percentage,
          source: r.data.source,
        },
      })
      return { events, state: next }
    }
    case TURN_EVENT.Tool: {
      const r = toolDataSchema.safeParse(frame.data)
      if (!r.success) return { events, state: next, warning: 'tool payload invalid — skipped' }
      const id = r.data.tool_id || `t-${next.toolSeq + 1}`
      next = {
        ...next,
        toolSeq: next.toolSeq + 1,
        pendingToolIds: [...next.pendingToolIds, id],
      }
      events.push({
        type: 'tool_call',
        messageId,
        toolUseId: id,
        toolName: r.data.name ?? 'tool',
        input: r.data.arguments ?? {},
      })
      return { events, state: next }
    }
    case TURN_EVENT.ToolResult: {
      const r = toolResultDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'tool_result payload invalid — skipped' }
      // New daemons provide the durable call id; old frames retain FIFO pairing.
      const id = r.data.tool_id || next.pendingToolIds[0]
      if (id === undefined) {
        // No pending tool_call to pair with (out of order / missing) — don't drop it
        // silently, leave a clue (bug3).
        return { events, state: next, warning: 'tool_result without pending tool_call — dropped' }
      }
      next = { ...next, pendingToolIds: next.pendingToolIds.filter((pending) => pending !== id) }
      const isError = r.data.success === false
      events.push({
        type: 'tool_result',
        toolUseId: id,
        // On success use the tool's real output; on failure fall back to the error message.
        output: r.data.output || (isError ? (r.data.error ?? '') : ''),
        isError,
        durationMs: r.data.duration_ms ?? 0,
      })
      return { events, state: next }
    }
    case TURN_EVENT.Final: {
      const r = finalDataSchema.safeParse(frame.data)
      const answer = r.success ? r.data.answer : null
      // Some models stream only a final answer (no token deltas) — inject it
      // so the finalized message isn't empty.
      if (!next.sawContent && answer) {
        events.push({ type: 'text_delta', messageId, text: answer })
      }
      // Surface the backend's authoritative final answer on the finalize frame — the render
      // layer uses it to split "execution process vs final answer" precisely (empty string =
      // this turn has no outward answer, e.g. one ending in request_human_choice).
      const completedAt = r.success && r.data.completed_at
        ? Date.parse(r.data.completed_at)
        : Date.now()
      events.push({
        type: 'message_stop',
        messageId,
        finalAnswer: answer,
        durationMs: r.success ? r.data.duration_ms : undefined,
        completedAt: Number.isFinite(completedAt) ? completedAt : Date.now(),
      })
      events.push({ type: 'done', reason: 'end_turn' })
      return {
        events,
        state: next,
        warning: r.success ? undefined : 'final payload invalid — finalized with empty answer',
      }
    }
    case TURN_EVENT.Cancelled: {
      events.push({ type: 'message_stop', messageId })
      events.push({ type: 'done', reason: 'cancelled', messageId })
      return { events, state: next }
    }
    case TURN_EVENT.Error: {
      const r = errorDataSchema.safeParse(frame.data)
      const message = (r.success && r.data.message) || 'chat failed'
      events.push({ type: 'error', message })
      return { events, state: next }
    }
    case TURN_EVENT.HumanRequest: {
      // Every ask is one pending interaction card. The user's response resumes
      // the same logical reply, where the completed card becomes a process row.
      const r = humanRequestDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'human_request payload invalid — skipped' }
      events.push({
        type: 'human_request',
        ...(r.data.prompt ? { prompt: r.data.prompt } : {}),
        questions: r.data.questions,
        requestId: r.data.request_id ?? undefined,
      })
      return { events, state: next }
    }
    case TURN_EVENT.AcceptRuleRequest: {
      const r = acceptRuleDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'accept_rule_request payload invalid — skipped' }
      events.push({
        type: 'accept_rule_request',
        requestId: r.data.request_id,
        rules: r.data.rules,
      })
      return { events, state: next }
    }
    case TURN_EVENT.BuildConfirmRequest: {
      const r = buildConfirmDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'build_confirm_request payload invalid — skipped' }
      events.push({
        type: 'build_confirm_request',
        requestId: r.data.request_id,
        goal: r.data.goal,
        reason: r.data.reason ?? null,
      })
      next = { ...next, sawContent: true }
      return { events, state: next }
    }
    case TURN_EVENT.WorkflowConfirmRequest: {
      const r = workflowConfirmDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'workflow_confirm_request payload invalid — skipped' }
      events.push({
        type: 'workflow_confirm_request',
        requestId: r.data.request_id,
        defaultName: r.data.default_name,
        summary: r.data.summary ?? null,
        operation: r.data.operation,
        workflowId: r.data.workflow_id ?? null,
      })
      next = { ...next, sawContent: true }
      return { events, state: next }
    }
    case TURN_EVENT.WorkflowProgress: {
      const r = workflowProgressDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'workflow_progress payload invalid — skipped' }
      events.push({
        type: 'workflow_progress',
        workflowId: r.data.workflow_id,
        generation: r.data.generation,
        workflowName: r.data.workflow_name,
        phase: r.data.phase,
        stepIndex: r.data.step_index,
        stepCount: r.data.step_count,
        title: r.data.title,
        status: r.data.status,
        summary: r.data.summary ?? null,
        executionSteps: r.data.execution_steps,
        validationSteps: r.data.validation_steps,
      })
      return { events, state: next }
    }
    case TURN_EVENT.WorkflowResult: {
      const r = workflowResultDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'workflow_result payload invalid — skipped' }
      events.push({
        type: 'workflow_result',
        runId: r.data.run_id,
        workflowId: r.data.workflow_id,
        workflowName: r.data.workflow_name,
        status: r.data.status,
        validationStatus: r.data.validation_status,
        createdAt: r.data.created_at,
        ...(r.data.result_file_count === undefined
          ? {}
          : { resultFileCount: r.data.result_file_count }),
        summary: r.data.summary ?? null,
      })
      return { events, state: next }
    }
    case TURN_EVENT.TaskConfirmRequest: {
      const r = taskConfirmDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'task_confirm_request payload invalid — skipped' }
      events.push({
        type: 'task_confirm_request',
        requestId: r.data.request_id,
        taskMarkdown: r.data.task_markdown,
        previousTaskMarkdown: r.data.previous_task_markdown ?? null,
        operation: r.data.operation,
        workflowId: r.data.workflow_id ?? null,
        originalTaskMarkdown: r.data.original_task_markdown ?? null,
      })
      next = { ...next, sawContent: true }
      return { events, state: next }
    }
    case TURN_EVENT.PermissionRequest: {
      // The tool-permission gate: held ASK calls + their judgement `items`. Unlike
      // `human_request` this renders as an INLINE approval card (the reducer
      // attaches it to the current assistant message). The ask ENDS the turn; the
      // user's per-item allow/deny goes back on the dedicated `permission_answer`
      // frame (keyed by `callIndex`, echoing `requestId`) — never a chat message.
      const r = permissionRequestDataSchema.safeParse(frame.data)
      if (!r.success)
        return { events, state: next, warning: 'permission_request payload invalid — skipped' }
      if (r.data.questions.some((q) => q.options.length > 0)) {
        events.push({
          type: 'permission_request',
          requestId: r.data.request_id,
          items: r.data.items.map((it) => ({
            callIndex: it.call_index,
            tool: it.tool,
            arguments: it.arguments,
            capability: it.capability,
            boundary: it.boundary,
            label: it.label,
            summary: it.summary,
            sensitive: it.sensitive,
            deletion: it.deletion,
            regenerable: it.regenerable,
            uncertainDestruction: it.uncertain_destruction,
            touchesRiskSurface: it.touches_risk_surface,
          })),
          questions: r.data.questions,
        })
      }
      return { events, state: next }
    }
    case TURN_EVENT.Stage: {
      // The dispatcher aimed a think unit — the session's thinking position
      // moved. The reducer updates the focus rail and records ordered Build
      // boundaries in the active bubble; this wire event remains state-shaped.
      const r = stageDataSchema.safeParse(frame.data)
      if (!r.success) return { events, state: next, warning: 'stage payload invalid — skipped' }
      const position: ThinkPosition = {
        mode: r.data.mode,
        stage: r.data.stage ?? null,
      }
      if (r.data.workflow_id) position.workflowId = r.data.workflow_id
      events.push({
        type: 'stage',
        position,
      })
      return { events, state: next }
    }
    case TURN_EVENT.Title: {
      // A model-written session title landed mid-turn (first turn only). Pure
      // state signal — no bubble content; the reducer updates the sidebar entry.
      const r = titleDataSchema.safeParse(frame.data)
      if (!r.success) return { events, state: next, warning: 'title payload invalid — skipped' }
      if (r.data.title) events.push({ type: 'title', title: r.data.title })
      return { events, state: next }
    }
    default:
      // loop_abort (non-terminal guard) / model_switch_warning / unknown —
      // not modeled by the reducer; emit nothing (beyond the message_start).
      return { events, state: next }
  }
}
