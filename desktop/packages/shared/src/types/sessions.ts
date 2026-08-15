/**
 * Cross-process session + message types, consumed by the renderer atoms
 * (`atoms/sessions.ts`, `atoms/agent.ts`).
 *
 * These describe the SHAPE of a session, not where it is stored. The daemon is
 * the single source of truth: `SessionMeta` is what `GET /sessions` hydrates
 * into (see `atoms/sessions.ts` `hydrateSessionsFromDaemonAtom`).
 *
 * The header used to document a local `{userData}/sessions.json` +
 * `{userData}/sessions/<id>.jsonl` layout written by a main-process
 * `session-store.ts`. All three are gone: that file does not exist, the local
 * JSONL persistence is deprecated (`atoms/sessions.ts:11`), and the desktop
 * deliberately does not use `userData` at all — it owns `~/.bridgic/amphi/`
 * (see `main/paths.ts`). Nothing about session storage changed in the 2026-08
 * product rename; only this stale description did.
 *
 * Backwards compatibility: any new field MUST be optional, so a client reading
 * data from a newer peer loses the unknown field rather than the whole session.
 */

export type SubAgentMode = 'background' | 'blocking' | 'rpc'
export type AgentTurnStatus =
  | 'awaiting_human'
  | 'awaiting_permission'
  | 'awaiting_subagents'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface SessionMeta {
  id: string
  title: string
  /** 0-4 index of the 5-stage Pipeline; undefined = idle / not in build flow. */
  stage?: number
  /** Human-readable stage label (e.g. "Exploring — analyzing data sources..."). */
  stageLabel?: string
  hasRedDot?: boolean
  /** A parked request_human_choice is still unanswered. */
  hasPendingInteraction?: boolean
  /** The latest Turn is still executing, including a blocking Child join. */
  isRunning?: boolean
  /** Exact durable latest-Turn state, when supplied by the daemon. */
  turnStatus?: AgentTurnStatus
  /** Absolute path of the session working directory (daemon
   *  SessionSummary.workspace_root). Used to locate `<workspaceRoot>/.work/.build/task.md`
   *  directly for writing to disk (manual edits of the requirements spec); a draft
   *  session doesn't have one yet. */
  workspaceRoot?: string
  /** Parent relationship for durable Child Sessions shown beneath a root. */
  parentSessionId?: string
  /** Only background children join the conversation sidebar hierarchy. */
  subagentMode?: SubAgentMode
  createdAt: number
  updatedAt: number
}

export interface AgentMessageSubagent {
  invocationId: string
  goal: string
  status: string
  answer?: string | null
  error?: string | null
}

export interface AgentMessageToolCall {
  toolUseId: string
  name: string
  input: unknown
  result?: { output: unknown; isError: boolean; durationMs: number }
  subagents?: AgentMessageSubagent[]
}

/**
 * Ordered blocks of one message's content. Assistant streaming events accumulate
 * into a `MessageBlock[]` in arrival order, so thinking / tool calls / text render
 * **interleaved** in the order they actually happened; user messages instead use
 * text / mention / slash blocks to rebuild the @ badges of the input (history
 * replay + immediate optimistic display).
 */
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool'
      toolUseId: string
      name: string
      input: unknown
      result?: { output: unknown; isError: boolean; durationMs: number }
      subagents?: AgentMessageSubagent[]
    }
  | {
      type: 'task_confirm'
      requestId: string
      taskMarkdown: string
      previousTaskMarkdown?: string | null
      operation?: 'create' | 'edit'
      workflowId?: string | null
      originalTaskMarkdown?: string | null
      status?: 'pending' | 'confirmed' | 'revision_requested'
      feedback?: string | null
    }
  | {
      type: 'build_confirm'
      requestId: string
      goal: string
      reason?: string | null
      status?: 'pending' | 'confirmed' | 'cancelled'
    }
  | {
      type: 'workflow_confirm'
      requestId: string
      defaultName: string
      summary?: string | null
      operation?: 'create' | 'edit'
      status?: 'pending' | 'confirmed' | 'cancelled' | 'continued'
      workflowId?: string | null
      name?: string | null
    }
  | {
      type: 'confirmation'
      prompt?: string
      question: string
      response: string
      kind?: 'answer' | 'accept_rule' | 'accept_rule_message' | 'confirmation_message'
      rules?: Array<{ id: string; text: string }>
      acceptanceMode?: 'criteria' | 'execution_only'
    }
  /** `path` = path relative to the mount, same meaning as on the inbound ChatBlock.
   *  When the composer recalls history with ↑, it relies on this to restore @ chips
   *  equivalent to the original input. */
  | { type: 'mention'; id: string; label: string; group: string; path?: string }
  | { type: 'slash'; id: string; label: string; resource?: 'workflow' | 'schedule' }
  | {
      /** Ordered Build-process boundary. `null` closes the current Build section
       *  without rendering a fifth heading when cognition returns to Main. */
      type: 'build_stage'
      stage: string | null
    }
  | {
      type: 'workflow_step'
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
      /** Absent on cards persisted by older daemon versions. */
      resultFileCount?: number
      summary?: string | null
    }
  // Tool permission gate: the data of the inline approval card (the criteria of
  // each pending call + the allow/deny questions). The shape is defined inline
  // rather than importing apps/electron's PermissionItem/AskUserQuestion across
  // packages (that would form a reverse dependency); the fields are kept in sync
  // with those. Two states: pending (still undecided, `decided` false/absent) and
  // decided (final adjudicated state, `decided` true and every item carries a
  // `decision`) — the backend's GET messages derives decided cards, while pending
  // ones are produced by pending_request/live events. `requestId` lets a pending
  // card correlate the permission_answer it sends back.
  | {
      type: 'permission'
      requestId?: string | null
      decided?: boolean
      items: {
        callIndex: number
        tool: string
        arguments: unknown
        capability: string
        boundary: string
        label: string
        decision?: 'allow' | 'deny'
        instruction?: string | null
      }[]
      questions: {
        question: string
        options: { label: string; description?: string }[]
      }[]
    }
  | {
      type: 'subagent'
      invocationId: string
      goal: string
      status: string
      answer?: string | null
      error?: string | null
    }

/**
 * Pipeline-mock UI hint payload. Renderer-only semantics, but persisted so
 * loading an old conversation re-renders the same option bubbles instead of
 * a plain text message.
 */
export interface AgentMessageOptions {
  choices: { label: string; desc?: string }[]
  defaultIndex?: number
}

/**
 * Persistence-level role on AgentMessage — a strict subset of
 * `ChatRole` (no tool / system entries on disk, those are reconstructed
 * by the reducer). Exported as a value so renderer + main agree on
 * literal strings via `AgentRole.User` / `AgentRole.Assistant`.
 */
export const AgentRole = {
  User: 'user',
  Assistant: 'assistant',
} as const
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole]

export interface AgentMessage {
  id: string
  /** Durable Session Turn identity. Live-only messages omit it until hydration. */
  turnId?: string
  /** Model selected for this durable Turn. Live-only messages may omit it until hydration. */
  model?: string
  /** Tool-permission mode selected for this durable Turn. */
  executionMode?: 'request' | 'auto' | 'full'
  role: AgentRole
  text: string
  thinking?: string
  toolCalls: AgentMessageToolCall[]
  /** Ordered content blocks (text/thinking/tool interleaved chronologically), the
   *  source of truth for rendering new messages. Older persisted messages may lack
   *  this field; rendering then falls back to building it from
   *  text/thinking/toolCalls. */
  blocks?: MessageBlock[]
  done: boolean
  stopped?: boolean
  error?: string
  /** The backend's authoritative final answer (the `final` frame's answer). Empty
   *  string = this turn has no externally visible answer (e.g. it ended on a
   *  request_human_choice); `undefined` = old message / unknown. At render time it
   *  is handed to `splitProcessAndAnswer` for an exact "execution process vs final
   *  answer" split. */
  finalAnswer?: string | null
  /** Durable backend Turn state. Present when the UI needs to preserve a
   *  parked logical reply across transcript hydration. */
  turnStatus?: AgentTurnStatus
  createdAt: number
  /** Completion metadata for the assistant footer. Optional for legacy rows. */
  completedAt?: number | null
  durationMs?: number | null
  /** Pipeline-mock UI hint: render `text` as a markdown block. */
  markdown?: boolean
  /** Pipeline-mock UI hint: render an interactive option list under `text`. */
  options?: AgentMessageOptions
}

/** Wrapper for the {userData}/sessions.json index file. Includes a schema
 *  version so future migrations can be detected (`if (version < 2) migrate`). */
export interface SessionsIndexFile {
  version: 1
  sessions: SessionMeta[]
}
