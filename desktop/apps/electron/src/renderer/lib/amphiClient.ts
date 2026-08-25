/**
 * Minimal hand-written HTTP client for the Bridgic Agent
 * service. Contract source: the backend route registration in
 * `amphi_service._app`, handlers, and protocol schemas.
 *
 * Hand-written on purpose: no openapi-typescript codegen, so the client is one
 * file with no build step of its own and no generated artifact to keep in sync.
 *
 * This used to be written as a plan — "switch to a generated client if the
 * surface grows past ~15 endpoints". The surface passed that a long time ago
 * (26 distinct paths, ~1.6k lines), and nobody switched, which means the
 * threshold was never the real decision criterion. Recording it as a standing
 * choice instead: a reader can disagree with a choice, but a stale plan just
 * looks like work someone forgot to do.
 *
 * Chat streaming lives in `amphiWsConnection.ts` — the daemon's turn stream
 * is WebSocket-only (`/ws`); the SSE `POST /sessions/{id}/turns` route is
 * retired. The WS wire protocol (frames + turn events + `ChatBlock`) lives in
 * `shared/ws-protocol.ts` — this file is HTTP-only.
 *
 * Auth (M1+):
 *  - `/api/*` endpoints require `Authorization: Bearer <token>`
 *  - `/api/gateway/health` is the one exception — public probe
 *  - Legacy paths (no `/api/` prefix) remain unauthenticated
 *  - All requests SHOULD carry `X-Client-Id` + `X-Client-Type` for the
 *    daemon's multi-client tracking
 */

import { z } from 'zod'
import {
  AUTH_HEADER_NAME,
  CLIENT_ID_HEADER,
  CLIENT_TYPE_HEADER,
  GATEWAY_API_PATHS,
} from '@shared/app-meta'
import type {
  ClientInfoResponse,
  AgentStatusResponse,
  GatewayHealthResponse,
  GatewayInfoResponse,
  ShutdownResponse,
} from '../../main/python-client/types'
import type {
  AgentMessage,
  AgentTurnStatus,
  AskUserQuestion,
  PermissionItem,
  SubAgentMode,
  ThinkPosition,
  WorkflowRunState,
} from '@shared/types'
import { askUserQuestionSchema } from './askUserQuestionSchema'
import { i18n } from './i18n'

// ───── Request / response shapes mirrored from backend schemas ─────────────

export interface CreateSessionRequest {
  model?: string
  workspace_root?: string
}

export interface SessionDetail {
  id: string
  model: string
  workspace_root: string
  tokens: number
  last_answer: string | null
  parent_session_id: string | null
  subagent_mode: SubAgentMode | null
}

export interface SessionSummary {
  id: string
  model: string
  workspace_root: string
  tokens: number
  last_answer_preview: string | null
  /** First user message of the session (backend session_summary). Empty
   *  until a turn runs. Used as the desktop sidebar title. */
  title: string
  /** Mutually exclusive Session projection used by the sidebar. */
  status: 'finish' | 'completed' | 'awaiting' | 'running'
  /** Exact latest Turn state; optional for compatibility with older daemons. */
  turn_status?: AgentTurnStatus | null
  parent_session_id: string | null
  subagent_mode: SubAgentMode | null
}

export interface WorkflowSummary {
  id: string
  name: string
  workflow_dir: string
  desc?: string | null
  source_session_id?: string | null
}

export interface WorkflowFile {
  path: string
  language?: string | null
  content: string
}

export interface WorkflowProgram {
  files: WorkflowFile[]
  readme?: string | null
}

export interface WorkflowTextField {
  value?: string | null
  editable?: boolean
}

export interface WorkflowDetail {
  id: string
  name: string
  info?: {
    desc?: string | null
    domain?: string | null
    created_at?: string | null
    owner?: string | null
    workflow_dir?: string | null
    source_session_id?: string | null
  }
  fields: {
    task?: WorkflowTextField
    explore?: WorkflowTextField
    verify?: WorkflowTextField
    program?: WorkflowProgram
  }
}

export interface WorkflowRunSummary {
  id: string
  workflow_id: string
  workflow_name: string
  source_session_id: string
  workflow_input: {
    text: string
    blocks: Array<Record<string, unknown>>
  }
  status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled'
  validation_status: 'pending' | 'passed' | 'failed' | 'not_required'
  created_at: string
  finished_at?: string | null
}

export interface WorkflowRunFile {
  path: string
  name: string
  size: number
}

export interface WorkflowRunFileContent extends WorkflowRunFile {
  content: string | null
  truncated: boolean
}

export interface WorkflowRunRawFile {
  content: ArrayBuffer
  mime: string
}

export type WorkflowSourceAvailability = 'available' | 'missing'

export interface WorkflowRunDetail extends WorkflowRunSummary {
  run_dir: string
  files: WorkflowRunFile[]
}

/** One per-session mounted local path (GET/POST /sessions/{id}/mounts).
 *
 *  A mount is a REFERENCE to a real path on the daemon's filesystem —
 *  never a copy. `size_bytes` is stat-ed live at list time for files;
 *  `item_count` is ALWAYS null — the daemon never reads a mounted directory
 *  (listing one trips the macOS TCC prompt and walks the whole tree), so a
 *  folder's count comes from `fs.listDir` on expand instead. `exists=false`
 *  flags a mount whose target was moved/deleted out-of-band (still listed so
 *  it can be removed). */
// ───── Schedules ──────────────────────────────────────────────────────────

/** One row in the schedule list; run-state fields are derived by the daemon. */
export interface ScheduleSummary {
  id: string
  name: string
  desc: string
  cron: string
  enabled: boolean
  /** Derived display status (needs-action > running > paused > active). */
  status: 'active' | 'paused' | 'running' | 'needsAction'
  /** Live in-flight signal, flat alongside `status` — `status` is mutually exclusive, so a
   *  schedule with parked AWAITING runs reports `needsAction` while runs are still flying.
   *  Never infer in-flight from `status === 'running'`. */
  running: boolean
  needs_action: number
  refs: string[]
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
}

/** One scheduled run — a Session; full detail lives at the session endpoints. */
export interface ScheduleRunSummary {
  session_id: string
  status: string
  /** The root or one of its Child Sessions currently owns an active invocation. */
  running: boolean
  /** The root Turn is terminal and the entire Session tree is idle. */
  can_continue: boolean
  created_at: string
  last_answer: string | null
}

/** Schedule detail = summary + its run history (newest first). */
export interface ScheduleDetail extends ScheduleSummary {
  runs: ScheduleRunSummary[]
}

/** Body of `POST /schedules`. */
export interface CreateScheduleBody {
  name: string
  desc: string
  cron: string
  refs?: string[]
  enabled?: boolean
}

/** Body of `PATCH /schedules/{id}` — only provided fields change. */
export interface PatchScheduleBody {
  name?: string
  desc?: string
  cron?: string
  enabled?: boolean
}

export interface MountSummary {
  id: string
  name: string
  path: string
  kind: 'file' | 'folder'
  size_bytes: number | null
  item_count: number | null
  exists: boolean
  /** System-owned roots such as `.work` cannot be unmounted. */
  removable?: boolean
  created_at: string
}

/** One user-visible mount in the global asset browser, retaining the Session
 *  relationship that gives the file its Agent context. */
export interface SessionFileAsset extends MountSummary {
  session_id: string
  session_title: string
}

export interface HealthResponse {
  status: 'ok'
}

export interface VersionResponse {
  version: string
  model_default: string
}

// ───── Providers + Active Model ─────────────────────────────────────────────
//
// Multi-provider credential management mirrors the backend provider handlers.
// `api_key` is never echoed by the server — wire shapes only carry
// `api_key_set: bool` to signal "configured / not". OAuth flow endpoints
// return 501 today; we don't expose them here until they ship.

export interface ModelLimits {
  context?: number
  input?: number
  output?: number
  source?: 'provider' | 'models_dev' | 'manual'
  source_provider_id?: string
  source_model_id?: string
}

export interface ProviderModelInfo {
  id: string
  name: string
  vision?: boolean
  tool_call?: boolean
  reasoning?: boolean
  limits?: ModelLimits
}

/** Static catalog entry from `GET /providers`.
 *
 *  Phase-2 backend role change: this is now a **UI prefill template source**,
 *  not a validation gate. `provider_id` on POST /me/providers may be any
 *  user-chosen slug. `protocol` + `default_base_url` are the values the
 *  add-flow auto-fills into the form when the user clicks this entry.
 */
export interface ProviderCatalogEntry {
  id: string
  display_name: string
  protocol: 'openai' | 'anthropic'
  default_base_url: string
  auth_modes: Array<'oauth' | 'api_key'>
  default_auth_mode: 'oauth' | 'api_key'
  models: ProviderModelInfo[]
}

/** A user's configured provider — from `GET /me/providers`.
 *
 *  Phase-2 wire shape: includes `protocol` (which LLM family chat will
 *  dispatch to), `display_name` (user-given channel name, nullable),
 *  and `available_models` is now the **user's whitelist** (not
 *  catalog-derived) — picker's single source of truth.
 *
 *  Phase-2.5 adds `is_enabled` — user-controlled disable flag. Distinct
 *  from `is_active` (which is "globally selected for chat right now")
 *  and from row existence (delete drops credentials; disable keeps them
 *  for later re-enable without re-entering the key). The chat picker
 *  must hide disabled rows; the settings list still shows them but with
 *  a visibly off Toggle so the user can flip back.
 */
export interface ConfiguredProvider {
  id: string
  auth_mode: 'oauth' | 'api_key'
  api_key_set: boolean
  base_url: string | null
  is_active: boolean
  is_enabled: boolean
  protocol: 'openai' | 'anthropic' | 'openai-codex'
  display_name: string | null
  available_models: string[]
  model_limits: Record<string, ModelLimits>
}

/** Body for `POST /me/providers/{provider_id}/toggle` — flip is_enabled. */
export interface ToggleProviderBody {
  enabled: boolean
}

/** Body for `POST /me/providers/test` — probe credentials without saving.
 *
 *  Sent fresh from the add/edit form; the server NEVER reads the user's
 *  stored row for this call, so typed-but-unsaved values can be probed
 *  before committing. Successful probe does NOT persist — the client
 *  still has to POST /me/providers to save. */
export interface TestProviderBody {
  provider_id: string
  protocol: 'openai' | 'anthropic' | 'openai-codex'
  api_key: string
  base_url?: string
  model: string
}

/** Response from `POST /me/providers/test` — always HTTP 200.
 *
 *  Connectivity / auth / model failures land in `ok: false` + `error`
 *  (Chinese, ready to display). Successful probe carries `latency_ms`.
 *  Caller reads `ok` for the boolean outcome; no try/catch around fetch
 *  needed (server NEVER returns 4xx/5xx for credential issues). */
export interface TestProviderResult {
  ok: boolean
  latency_ms?: number
  error?: string
}

/** Body for `POST /me/providers/fetch-models` — list a provider's models.
 *
 *  Same "fresh from the form" contract as {@link TestProviderBody}, minus
 *  `model`: listing is how the user discovers model ids, so requiring one
 *  would reintroduce the chicken-and-egg that "test connection" has. */
export interface FetchModelsBody {
  provider_id: string
  protocol: 'openai' | 'anthropic' | 'openai-codex'
  api_key: string
  base_url?: string
}

/** One model advertised by a provider's list-models endpoint. */
export interface FetchedModel {
  id: string
  /** Provider-supplied label; falls back to `id` when none is advertised. */
  name: string
  vision?: boolean | null
  tool_call?: boolean | null
  reasoning?: boolean | null
  limits?: ModelLimits
  limits_source?: 'provider' | 'models_dev' | 'unknown'
  source_provider_id?: string
  source_model_id?: string
}

/** Response from `POST /me/providers/fetch-models` — always HTTP 200.
 *
 *  Same envelope discipline as {@link TestProviderResult}: auth / network /
 *  parse failures land in `ok: false` + a display-ready Chinese `error`.
 *  An empty upstream list is reported as `ok: false` (nothing to show). */
export interface FetchModelsResult {
  ok: boolean
  models?: FetchedModel[]
  error?: string
}

/** Body for `POST /me/providers`.
 *
 *  Phase-2: `provider_id` accepts any user-chosen slug (catalog membership
 *  no longer required). `protocol` / `display_name` / `models` are optional
 *  on update (server preserves existing values when omitted) and default
 *  to `"openai"` / `null` / `[]` on first insert.
 */
export interface AddProviderBody {
  provider_id: string
  auth_mode: 'oauth' | 'api_key'
  api_key?: string
  base_url?: string
  // 'openai-codex' covers the Codex (ChatGPT subscription) channel — used when
  // re-upserting its user-managed model list without disturbing the OAuth shape.
  protocol?: 'openai' | 'anthropic' | 'openai-codex'
  display_name?: string | null
  models?: string[]
  model_limits?: Record<string, ModelLimits>
}

/** Body for `POST /me/active-model`. */
export interface SetActiveModelBody {
  provider_id: string
  model: string
}

/** `MeProfile` — returned by `GET /me` and `POST /me/active-model`.
 *
 *  Phase-2 added `protocol` — mirrored from the active provider so the
 *  GUI can reflect which LLM family the next chat will dispatch to.
 */
export interface MeProfile {
  id: string
  display_name: string | null
  current_model: string | null
  base_url: string | null
  default_max_rounds: number
  default_temperature: number
  api_key_set: boolean
  protocol: 'openai' | 'anthropic' | 'openai-codex'
}

// ───── Gateway endpoint response shapes ──────────────────────────────────────
//
// Re-exported from main/python-client/types.ts (canonical home — those types
// are also imported by Electron main's IPC handler in handlers/backend.ts).

export type {
  ClientInfoResponse,
  GatewayHealthResponse,
  GatewayInfoResponse,
  ShutdownResponse,
} from '../../main/python-client/types'

/** Response from `POST /me/providers/openai-codex/oauth/start`. */
export interface CodexOAuthStart {
  /** authorize URL to open in the system browser. */
  auth_url: string
  /** opaque session id — pass to the status poll. */
  state: string
}

/** Response from `GET /me/providers/openai-codex/oauth/status`. */
export interface CodexOAuthStatus {
  status: 'pending' | 'success' | 'failed' | 'unknown'
  error?: string | null
}

/** Response from `GET /me/providers/openai/codex/local` — local-login detection. */
export interface CodexLocalStatus {
  has_local: boolean
  account_id: string | null
}

/** Response from `POST /me/providers/openai/codex/local` — one-click reuse. */
export interface CodexLocalReuse {
  ok: boolean
  error?: string
}

// ───── Client ────────────────────────────────────────────────────────────────

// Hard ceiling for every REST call. Without it a hung daemon (process alive
// but unresponsive) leaves the fetch promise pending forever — and with it any
// caller-side in-flight guard (e.g. the per-session transcript-load guard in
// atoms/agent.ts) permanently locked. All endpoints are local CRUD; 30s is
// generous.
// ── Skills (capability units) ────────────────────────────────────────────────

/** Skill grouping (source) enum —— the closed set of values of the wire `group`. Single source
 *  of truth: it simultaneously tightens the `SkillDetail.group` type, drives the filter tiers, and maps the Chinese labels (§4.11). */
export const SkillGroup = {
  SelfCreated: 'self_created',
  Imported: 'imported',
  Builtin: 'builtin',
} as const
export type SkillGroup = (typeof SkillGroup)[keyof typeof SkillGroup]

/** One installed skill. Wire shape of `GET /skills`, `GET/POST/DELETE /skill/{id}`.
 *  Field names mirror the daemon JSON verbatim (snake_case). */
export interface SkillDetail {
  skill_id: number
  name: string
  description: string | null
  skill_dir: string | null
  group: SkillGroup | null
  /** 'github' | 'skills.sh' | 'clawhub' | 'local' */
  source: string | null
  source_uri: string | null
  enabled: boolean
  /** ISO-8601, or null. */
  updated_at: string | null
}

/** One importable skill discovered by `GET /skills/import/scan` (not yet
 *  installed — no `skill_id`).
 *
 *  `local_path` is the daemon-side directory to copy on import (for a GitHub URL
 *  scan this is a temporary download dir); `source_uri` records the original
 *  source (the canonical github.com URL for a remote import) and is stored
 *  unchanged. The two diverge for remote imports — never conflate them. */
export interface ScannedSkill {
  name: string
  description: string
  source: string
  source_uri: string
  local_path: string
  updated_at: string | null
}

/** Request element for `/skills/import/check` + `/skills/import` — a `ScannedSkill`
 *  handed straight back. `name` + `local_path` (the copy source) are load-bearing;
 *  `source_uri` is stored as provenance. */
export interface SkillImportItem {
  name: string
  source_uri: string
  local_path: string
  description?: string
  source?: string
  updated_at?: string | null
}

/** One conflict-check result (order matches the request items). */
export interface ImportCheckResult {
  /** True when a same-named skill is already installed (import would overwrite it). */
  conflict: boolean
  incoming: ScannedSkill
  /** The same-named installed skill an import overwrites; null when new. */
  existing: SkillDetail | null
}

/** Outcome of `POST /skills/import` — per-item success/failure isolation. */
export interface ImportSummary {
  imported_skills: Array<SkillDetail & { action: 'added' | 'overwritten' }>
  failed_skills: Array<SkillImportItem & { reason: string }>
}

const REQUEST_TIMEOUT_MS = 30_000

export interface AmphiClientOptions {
  baseUrl: string
  token: string | null
  /** Stable identifier this client sends on every request via
   *  `X-Client-Id`. Echoing the same id from multiple windows merges
   *  into one record on the daemon side. Null skips the header. */
  clientId?: string | null
  /** One of 'gui' / 'cli' / 'tray'. Defaults to 'unknown' on
   *  the daemon side if absent. */
  clientType?: string | null
  /** Optional User-Agent override (e.g. `amphi/0.1.0`). */
  userAgent?: string | null
  /** Per-request timeout in ms. Defaults to `REQUEST_TIMEOUT_MS` (30s);
   *  overridable mainly for tests. */
  requestTimeoutMs?: number
  /** Called when an authenticated REST request is rejected. The caller owns
   *  throttling and endpoint refresh; the original request still fails with
   *  `AmphiHttpError` and is never replayed implicitly. */
  onAuthFailure?: () => void
}

// ───── Lenient boundary schemas (§ validate external data) ───────────────────
// Validate only the fields the renderer depends on; `.passthrough()` keeps any
// extra / forward-compat fields. A shape mismatch (daemon drift, or an error
// body returned with HTTP 200) is rejected AT THE BOUNDARY with a clear message
// instead of crashing deep in render. Deliberately lenient — never reject a
// valid payload just because the daemon added fields.
const meProfileSchema = z.object({ current_model: z.string().nullable().optional() }).passthrough()
const providerCatalogSchema = z.array(z.object({ id: z.string() }).passthrough())
const configuredProvidersSchema = z.array(z.object({ id: z.string() }).passthrough())
const sessionFileAssetsSchema = z.array(
  z.object({
    id: z.string(),
    session_id: z.string(),
    session_title: z.string(),
    name: z.string(),
    path: z.string(),
    kind: z.enum(['file', 'folder']),
    size_bytes: z.number().nullable(),
    item_count: z.number().nullable(),
    exists: z.boolean(),
    created_at: z.string(),
  }).passthrough(),
)
// listSessions drives the sidebar (→ hydrateSessionsFromDaemonAtom): `id` is the
// React key + the daemon handle, so a row missing it must be rejected at the
// boundary, not crash deep in render. `title` is optional (handled downstream).
const sessionSummariesSchema = z.array(z.object({ id: z.string() }).passthrough())
const workflowSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    workflow_dir: z.string(),
    desc: z.string().nullable().optional(),
    source_session_id: z.string().nullable().optional(),
  })
  .passthrough()
const workflowSummariesSchema = z.array(workflowSummarySchema)
const workflowFileSchema = z
  .object({
    path: z.string(),
    language: z.string().nullable().optional(),
    content: z.string().default(''),
  })
  .passthrough()
const workflowProgramSchema = z
  .object({
    files: z.array(workflowFileSchema).default([]),
    readme: z.string().nullable().optional(),
  })
  .passthrough()
const workflowTextFieldSchema = z
  .object({
    value: z.string().nullable().optional(),
    editable: z.boolean().optional(),
  })
  .passthrough()
const workflowDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    info: z
      .object({
        desc: z.string().nullable().optional(),
        domain: z.string().nullable().optional(),
        workflow_dir: z.string().nullable().optional(),
        created_at: z.string().nullable().optional(),
        owner: z.string().nullable().optional(),
        source_session_id: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    fields: z
      .object({
        task: workflowTextFieldSchema.optional(),
        config: workflowTextFieldSchema.optional(),
        explore: workflowTextFieldSchema.optional(),
        verify: workflowTextFieldSchema.optional(),
        program: workflowProgramSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough()
const workflowRunSummarySchema = z
  .object({
    id: z.string(),
    workflow_id: z.string(),
    workflow_name: z.string(),
    source_session_id: z.string(),
    workflow_input: z.object({
      text: z.string(),
      blocks: z.array(z.record(z.string(), z.unknown())).default([]),
    }),
    status: z.enum(['running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']),
    validation_status: z.enum(['pending', 'passed', 'failed', 'not_required']),
    summary: z.string().nullable().optional(),
    created_at: z.string(),
    finished_at: z.string().nullable().optional(),
  })
  .passthrough()
const workflowRunSummariesSchema = z.array(workflowRunSummarySchema)
const workflowRunDetailSchema = workflowRunSummarySchema.extend({
  run_dir: z.string(),
  files: z.array(z.object({
    path: z.string(),
    name: z.string(),
    size: z.number(),
  }).passthrough()).default([]),
})
const workflowRunFileContentSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number(),
  content: z.string().nullable(),
  truncated: z.boolean().default(false),
}).passthrough()
const sessionMessagesSchema = z
  .object({
    messages: z.array(z.object({
      id: z.string(),
      turnId: z.string().optional(),
      model: z.string().optional(),
      executionMode: z.enum(['request', 'auto', 'full']).optional(),
    }).passthrough()),
    // Cursor-pagination envelope (absent on older daemons → no more history).
    has_more: z.boolean().optional(),
    next_before: z.number().nullable().optional(),
    // The suspended session's unanswered ask (banner rehydration); absent /
    // null on idle sessions and older daemons.
    pending_request: z
      .object({
        // A permission gate is 'permission' (carrying per-item criteria in items); request_human_choice is 'choose' / absent.
        kind: z.string().optional(),
        prompt: z.string().optional(),
        questions: z.array(askUserQuestionSchema).default([]),
        rules: z.array(z.string()).default([]),
        // Wire items use snake `call_index`; normalize to camel `callIndex` (consistent with the
        // live events) so a rehydrated pending card can send permission_answer back by callIndex.
        items: z
          .array(
            z
              .object({
                call_index: z.number().default(0),
                tool: z.string().default(''),
                arguments: z.unknown(),
                capability: z.string().default(''),
                boundary: z.string().default(''),
                label: z.string().default(''),
                // Plain-language summary: previously missing from the mapping —— after a refresh /
                // reconnect the approval card fell back to a lump of raw shell commands, which
                // is where non-technical users get stuck.
                summary: z.string().default(''),
                // Objective-criteria flags: a rehydrated card must derive its risk level from these too (older rows default to false).
                sensitive: z.boolean().default(false),
                deletion: z.boolean().default(false),
                regenerable: z.boolean().default(false),
                uncertain_destruction: z.boolean().default(false),
                touches_risk_surface: z.boolean().default(false),
              })
              .transform((o) => ({
                callIndex: o.call_index,
                tool: o.tool,
                arguments: o.arguments,
                capability: o.capability,
                boundary: o.boundary,
                label: o.label,
                summary: o.summary,
                sensitive: o.sensitive,
                deletion: o.deletion,
                regenerable: o.regenerable,
                uncertainDestruction: o.uncertain_destruction,
                touchesRiskSurface: o.touches_risk_surface,
              })),
          )
          .default([]),
        // Links to the suspended turn, used when sending permission_answer back (null by default for request_human_choice).
        request_id: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    // Trailing turn's thinking position for Build focus and Workflow resume.
    // Absent/null on fresh sessions and older daemons; stage is nullable.
    thinking_mode: z
      .object({
        mode: z.enum(['build', 'normal', 'run_workflow']),
        stage: z.string().nullable().optional(),
        workflow_id: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    workflow_run: z
      .object({
        workflow_id: z.string(),
        generation: z.string(),
        workflow_name: z.string(),
        source_session_id: z.string(),
        phase: z.enum(['execute', 'validate']),
        step_index: z.number().int().nonnegative(),
        execution_steps: z.array(z.string()).default([]),
        validation_steps: z.array(z.string()).default([]),
      })
      .nullable()
      .optional(),
    // The background sub-Agents of this run (independent Child Sessions, not projected into the
    // transcript, listed separately by the backend), feeding the session-hierarchy left column of the run-detail modal.
    children: z
      .array(
        z.object({
          session_id: z.string(),
          title: z.string().default(''),
          subagent_mode: z.string().nullable().optional(),
          status: z.string().default(''),
        }),
      )
      .default([]),
  })
  .passthrough()

/** GET /sessions/{id}/messages payload: the transcript + the still-unanswered
 *  ask of a suspended session (else null) + the trailing turn's two-layer
 *  thinking position (Build focus / Workflow resume; null when unknown). */
export interface SessionTranscript {
  messages: AgentMessage[]
  /** Cursor pagination: whether the server still has an earlier page of history. */
  hasMore: boolean
  /** Cursor for the next page (before_ordinal); meaningless when hasMore=false. */
  nextBefore: number | null
  pendingRequest: {
    kind?: string
    prompt?: string
    questions: AskUserQuestion[]
    items?: PermissionItem[]
    rules?: string[]
    /** Permission gate: links permission_answer back to the suspended turn (null by default for choose). */
    requestId?: string | null
  } | null
  thinkingMode: ThinkPosition | null
  workflowRun: WorkflowRunState | null
  /** The background sub-Agents of this run (independent Child Sessions), feeding the session hierarchy in the run modal's left column. */
  children: RunChild[]
}

/** Summary of one background sub-Agent (a `children` item of GET messages). */
export interface RunChild {
  sessionId: string
  title: string
  /** Exact latest Turn state, or unknown before the Child has a Turn. */
  status: string
  subagentMode: string | null
}

/** Walk an offset-paginated list to exhaustion — bounded server pages,
 *  complete client index. Stops on a short page.
 *
 *  Runaway guards for daemon version skew (a long-lived daemon predating the
 *  paging params ignores them and serves the FULL list every "page"):
 *  an oversized page means paging was ignored → return it as the full list;
 *  `keyOf` dedupes across pages and a page adding nothing new terminates the
 *  walk (same contract as the workflow-run pager). */
export async function fetchAllOffsetPages<T>(
  fetchPage: (page: { limit: number; offset: number }) => Promise<T[]>,
  keyOf: (row: T) => string,
  pageSize = 200,
): Promise<T[]> {
  const rows: T[] = []
  const seen = new Set<string>()
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage({ limit: pageSize, offset })
    if (page.length > pageSize) return page
    let added = 0
    for (const row of page) {
      const key = keyOf(row)
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
      added += 1
    }
    if (page.length < pageSize || added === 0) return rows
  }
}

/** Parse `data` with `schema`, throwing a labelled boundary error on mismatch. */
function parseResponse<T>(schema: z.ZodTypeAny, data: unknown, label: string): T {
  const r = schema.safeParse(data)
  if (!r.success) {
    const detail = r.error.issues
      .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
      .join('; ')
    throw new Error(i18n.t('error.responseShapeInvalid', { label, detail }))
  }
  return r.data as T
}

export class AmphiHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'AmphiHttpError'
  }
}

export class AmphiClient {
  private readonly baseUrl: string
  private readonly token: string | null
  private readonly clientId: string | null
  private readonly clientType: string | null
  private readonly userAgent: string | null
  private readonly requestTimeoutMs: number
  private readonly onAuthFailure: (() => void) | null

  constructor(opts: AmphiClientOptions) {
    // Normalize trailing slash so endpoint joins are predictable.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.clientId = opts.clientId ?? null
    this.clientType = opts.clientType ?? null
    this.userAgent = opts.userAgent ?? null
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.onAuthFailure = opts.onAuthFailure ?? null
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra }
    // Standard HTTP negotiation header. The service owns its message catalog,
    // so no renderer translation ids travel across this boundary.
    h['Accept-Language'] = i18n.resolvedLanguage ?? i18n.language
    if (this.token) h[AUTH_HEADER_NAME] = `Bearer ${this.token}`
    if (this.clientId) h[CLIENT_ID_HEADER] = this.clientId
    if (this.clientType) h[CLIENT_TYPE_HEADER] = this.clientType
    if (this.userAgent) h['User-Agent'] = this.userAgent
    return h
  }

  // ───── Legacy unauthenticated probes ──────────────────────────────────────

  async getHealth(): Promise<HealthResponse> {
    return this.fetchJson('/health')
  }

  async getVersion(): Promise<VersionResponse> {
    return this.fetchJson('/version')
  }

  // ───── Gateway endpoints (M1+, /api/gateway/*) ────────────────────────────

  /** Public liveness probe — no auth required. */
  async getGatewayHealth(): Promise<GatewayHealthResponse> {
    return this.fetchJson(GATEWAY_API_PATHS.Health)
  }

  /** Daemon metadata: pid / version / uptime / connected client count. */
  async getGatewayInfo(): Promise<GatewayInfoResponse> {
    return this.fetchJson(GATEWAY_API_PATHS.Info)
  }

  /** List of currently-connected clients (the multi-client widget). */
  async getGatewayClients(): Promise<ClientInfoResponse[]> {
    return this.fetchJson(GATEWAY_API_PATHS.Clients)
  }

  /**
   * Whether the daemon currently owns any unfinished Agent task.
   *
   * Root turns, child invocations and runs queued for a concurrency slot all
   * count; a session parked waiting for user confirmation does not (it holds no
   * live task). Snapshot only — it is not a lock, so a turn can start the
   * instant after this returns false.
   */
  async getAgentStatus(): Promise<AgentStatusResponse> {
    return this.fetchJson(GATEWAY_API_PATHS.AgentStatus)
  }

  /**
   * Trigger graceful daemon shutdown.
   *
   * The daemon responds 202 immediately, then schedules SIGTERM after
   * a brief delay (~0.3s) so this HTTP response can flush before the
   * process exits. Callers should NOT wait for the daemon to actually
   * be down via this method — poll `/api/gateway/health` or
   * `amphi server status` instead.
   *
   * Only call from explicit user action (Settings → Gateway → Stop),
   * never from quit/cleanup — that's the architecture's "GUI close
   * does NOT bring daemon down" invariant.
   */
  async postGatewayShutdown(): Promise<ShutdownResponse> {
    return this.fetchJson(GATEWAY_API_PATHS.Shutdown, { method: 'POST' })
  }

  // ───── Providers ─────────────────────────────────────────────────────────
  //
  // `/me/*` is currently unauthenticated (daemon binds 127.0.0.1, single user)
  // but headers() still attaches Bearer + X-Client-* so the same path keeps
  // working once token enforcement turns on.

  /**
   * Current user profile — `api_key` is never echoed;
   * the response carries `api_key_set: bool` instead. Used by hydrate to
   * pick up `current_model` (the globally-active model id).
   */
  async getMe(): Promise<MeProfile> {
    return parseResponse<MeProfile>(meProfileSchema, await this.fetchJson('/me'), 'GET /me')
  }

  /** Current tool-permission execution mode (global, cross-session). */
  async getExecutionMode(): Promise<{ mode: 'request' | 'auto' | 'full' }> {
    return this.fetchJson('/me/execution-mode')
  }

  /** Switch the execution mode; the daemon validates the value (422 on bad input). */
  async setExecutionMode(mode: 'request' | 'auto' | 'full'): Promise<{ mode: string }> {
    return this.fetchJson('/me/execution-mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Static catalog of supported vendors + their selectable models. */
  async listProviderCatalog(): Promise<ProviderCatalogEntry[]> {
    return parseResponse<ProviderCatalogEntry[]>(
      providerCatalogSchema,
      await this.fetchJson('/providers'),
      'GET /providers',
    )
  }

  /** Current user's configured providers (api_key never echoed). */
  async listMeProviders(): Promise<ConfiguredProvider[]> {
    return parseResponse<ConfiguredProvider[]>(
      configuredProvidersSchema,
      await this.fetchJson('/me/providers'),
      'GET /me/providers',
    )
  }

  /**
   * Upsert a provider's credentials by `provider_id`. Returns the stored
   * row (with `api_key_set: true`, never the key itself). If this is the
   * user's first configured provider, the server auto-activates it and
   * mirrors its creds onto the User row so chat works immediately.
   */
  async addProvider(body: AddProviderBody): Promise<ConfiguredProvider> {
    return this.fetchJson('/me/providers', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Delete a provider's stored credentials. 404 if not configured. */
  async deleteProvider(providerId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/me/providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) throw await this.httpError(res)
  }

  /**
   * Activate a (provider, model) pair globally for the current user.
   * The daemon mirrors the chosen provider's api_key / base_url onto
   * the User row and invalidates the LLM client cache, so the next
   * chat call uses the new creds + model — across ALL sessions.
   */
  async setActiveModel(body: SetActiveModelBody): Promise<MeProfile> {
    return this.fetchJson('/me/active-model', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Begin the Codex (ChatGPT subscription) OAuth flow.
   *
   * The daemon starts a temporary localhost:1455 callback server and returns
   * the authorize URL for the caller to open in the system browser. Poll
   * {@link pollCodexOAuthStatus} with the returned `state` until terminal.
   */
  async startCodexOAuth(): Promise<CodexOAuthStart> {
    return this.fetchJson('/me/providers/openai/oauth/start', { method: 'POST' })
  }

  /** Poll the in-flight Codex OAuth session by `state` (pending → success/failed). */
  async pollCodexOAuthStatus(state: string): Promise<CodexOAuthStatus> {
    return this.fetchJson(
      `/me/providers/openai/oauth/status?state=${encodeURIComponent(state)}`,
    )
  }

  /**
   * Cancel an in-flight Codex OAuth sign-in by `state` — the daemon closes the
   * 1455 callback server + drops the session immediately (no waiting for TTL).
   * Idempotent on the server; best-effort here (caller ignores failures). 204,
   * so use a raw fetch (no JSON body) like {@link deleteProvider}.
   */
  async cancelCodexOAuth(state: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/me/providers/openai/oauth/cancel?state=${encodeURIComponent(state)}`,
      { method: 'POST', headers: this.headers() },
    )
    if (!res.ok) throw await this.httpError(res)
  }

  /** Detect whether the machine already has a local Codex login (read-only). */
  async checkCodexLocal(): Promise<CodexLocalStatus> {
    return this.fetchJson('/me/providers/openai/codex/local')
  }

  /** Reuse the local Codex login — activate the channel directly, no OAuth. */
  async useLocalCodex(): Promise<CodexLocalReuse> {
    return this.fetchJson('/me/providers/openai/codex/local', { method: 'POST' })
  }

  /**
   * Flip `is_enabled` on a configured provider. Disabling the active row
   * auto-promotes the next enabled+keyed provider on the server; the GUI
   * must call hydrate afterwards to pick up the new active selection.
   * Returns the updated `ConfiguredProvider` row (with new `is_enabled`).
   */
  async toggleProvider(
    providerId: string,
    body: ToggleProviderBody,
  ): Promise<ConfiguredProvider> {
    return this.fetchJson(
      `/me/providers/${encodeURIComponent(providerId)}/toggle`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  /**
   * Probe a credential pair against the real provider — does NOT save.
   *
   * Returns `{ok: true, latency_ms}` on success or `{ok: false, error}`
   * on auth/404/network failure. The server always returns HTTP 200 for
   * credential problems, so this method never rejects on bad keys; only
   * a true daemon-side bug (which is rare) bubbles up as a thrown error.
   * Callers should read `result.ok` and surface `result.error` directly.
   */
  async testProvider(body: TestProviderBody): Promise<TestProviderResult> {
    return this.fetchJson('/me/providers/test', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Reveal one channel's stored plaintext key (edit-form prefill).
   *
   *  The only call that returns a key; `listProviders` deliberately does not.
   *  Returns null for OAuth/Codex channels, which have no key. */
  async getProviderApiKey(providerId: string): Promise<string | null> {
    const res = await this.fetchJson<{ api_key: string | null }>(
      `/me/providers/${encodeURIComponent(providerId)}/api-key`,
    )
    return res.api_key
  }

  async fetchProviderModels(body: FetchModelsBody): Promise<FetchModelsResult> {
    return this.fetchJson('/me/providers/fetch-models', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async createSession(body: CreateSessionRequest = {}): Promise<SessionDetail> {
    return this.fetchJson('/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Copies a finished run Session wholesale into a new USER session and returns its detail. */
  async duplicateSession(sessionId: string): Promise<SessionDetail> {
    return this.fetchJson(`/sessions/${encodeURIComponent(sessionId)}/duplicate`, { method: 'POST' })
  }

  async listSessions(page?: { limit?: number; offset?: number }): Promise<SessionSummary[]> {
    const params = new URLSearchParams()
    if (page?.limit !== undefined) params.set('limit', String(page.limit))
    if (page?.offset !== undefined) params.set('offset', String(page.offset))
    const query = params.size > 0 ? `?${params.toString()}` : ''
    return parseResponse<SessionSummary[]>(
      sessionSummariesSchema,
      await this.fetchJson(`/sessions${query}`),
      'GET /sessions',
    )
  }

  async listWorkflows(sessionId?: string): Promise<WorkflowSummary[]> {
    const suffix = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
    return parseResponse<WorkflowSummary[]>(
      workflowSummariesSchema,
      await this.fetchJson(`/workflows${suffix}`),
      'GET /workflows',
    )
  }

  async getWorkflow(workflowId: string): Promise<WorkflowDetail> {
    return parseResponse<WorkflowDetail>(
      workflowDetailSchema,
      await this.fetchJson(`/workflows/${encodeURIComponent(workflowId)}`),
      `GET /workflows/${workflowId}`,
    )
  }

  async renameWorkflow(workflowId: string, name: string): Promise<WorkflowSummary> {
    return parseResponse<WorkflowSummary>(
      workflowSummarySchema,
      await this.fetchJson(`/workflows/${encodeURIComponent(workflowId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
        headers: { 'Content-Type': 'application/json' },
      }),
      `PATCH /workflows/${workflowId}`,
    )
  }

  async getWorkflowAvailability(workflowId: string): Promise<WorkflowSourceAvailability> {
    try {
      await this.getWorkflow(workflowId)
      return 'available'
    } catch (err: unknown) {
      if (err instanceof AmphiHttpError && err.status === 404) return 'missing'
      throw err
    }
  }

  async importWorkflow(file: File): Promise<WorkflowSummary> {
    const body = new FormData()
    body.append('file', file)
    return parseResponse<WorkflowSummary>(
      workflowSummarySchema,
      await this.fetchJson('/workflows', {
        method: 'PUT',
        body,
        signal: AbortSignal.timeout(300_000),
      }),
      'PUT /workflows',
    )
  }

  async exportWorkflow(workflowId: string): Promise<Uint8Array> {
    const path = `/workflows/${encodeURIComponent(workflowId)}?archive=true`
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(300_000),
    })
    if (!response.ok) throw await this.httpError(response)
    return new Uint8Array(await response.arrayBuffer())
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/workflows/${encodeURIComponent(workflowId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!response.ok) throw await this.httpError(response)
  }

  async listWorkflowRuns(
    workflowId?: string,
    query?: string,
    page?: { limit?: number; offset?: number; sourceSessionId?: string; sessionId?: string },
  ): Promise<WorkflowRunSummary[]> {
    const params = new URLSearchParams()
    if (workflowId) params.set('workflow_id', workflowId)
    if (query?.trim()) params.set('q', query.trim())
    if (page?.limit !== undefined) params.set('limit', String(page.limit))
    if (page?.offset !== undefined) params.set('offset', String(page.offset))
    if (page?.sourceSessionId) params.set('source_session_id', page.sourceSessionId)
    if (page?.sessionId) params.set('session_id', page.sessionId)
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    return parseResponse<WorkflowRunSummary[]>(
      workflowRunSummariesSchema,
      await this.fetchJson(`/workflow-runs${suffix}`),
      'GET /workflow-runs',
    )
  }

  async getWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
    return parseResponse<WorkflowRunDetail>(
      workflowRunDetailSchema,
      await this.fetchJson(`/workflow-runs/${encodeURIComponent(runId)}`),
      `GET /workflow-runs/${runId}`,
    )
  }

  async exportWorkflowRun(runId: string): Promise<Uint8Array> {
    const path = `/workflow-runs/${encodeURIComponent(runId)}?archive=true`
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(300_000),
    })
    if (!response.ok) throw await this.httpError(response)
    return new Uint8Array(await response.arrayBuffer())
  }

  async deleteWorkflowRun(runId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/workflow-runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!response.ok) throw await this.httpError(response)
  }

  async getWorkflowRunFile(runId: string, path: string): Promise<WorkflowRunFileContent> {
    const params = new URLSearchParams({ path })
    return parseResponse<WorkflowRunFileContent>(
      workflowRunFileContentSchema,
      await this.fetchJson(`/workflow-runs/${encodeURIComponent(runId)}/file?${params.toString()}`),
      `GET /workflow-runs/${runId}/file`,
    )
  }

  async getWorkflowRunFileRaw(runId: string, path: string): Promise<WorkflowRunRawFile> {
    const params = new URLSearchParams({ path, raw: 'true' })
    const response = await this.fetchResponse(
      `/workflow-runs/${encodeURIComponent(runId)}/file?${params.toString()}`,
    )
    return {
      content: await response.arrayBuffer(),
      mime: response.headers.get('content-type') || 'application/octet-stream',
    }
  }

  /** Full transcript of one session + its pending ask, if suspended
   *  (GET /sessions/{id}/messages). Daemon = source of truth. */
  async getSessionMessages(
    id: string,
    page?: { limit?: number; beforeOrdinal?: number },
  ): Promise<SessionTranscript> {
    const params = new URLSearchParams()
    if (page?.limit !== undefined) params.set('limit', String(page.limit))
    if (page?.beforeOrdinal !== undefined) params.set('before_ordinal', String(page.beforeOrdinal))
    const query = params.size > 0 ? `?${params.toString()}` : ''
    const res = parseResponse<{
      messages: AgentMessage[]
      has_more?: boolean
      next_before?: number | null
      pending_request?: {
        kind?: string
        prompt?: string
        questions: AskUserQuestion[]
        items?: PermissionItem[]
        rules?: string[]
        request_id?: string | null
      } | null
      thinking_mode?: {
        mode: ThinkPosition['mode']
        stage?: string | null
        workflow_id?: string | null
      } | null
      workflow_run?: {
        workflow_id: string
        generation: string
        workflow_name: string
        source_session_id: string
        phase: 'execute' | 'validate'
        step_index: number
        execution_steps: string[]
        validation_steps: string[]
      } | null
      children: {
        session_id: string
        title: string
        subagent_mode?: string | null
        status: string
      }[]
    }>(
      sessionMessagesSchema,
      await this.fetchJson(`/sessions/${encodeURIComponent(id)}/messages${query}`),
      `GET /sessions/${id}/messages`,
    )
    const pending = res.pending_request
    return {
      messages: res.messages,
      hasMore: res.has_more ?? false,
      nextBefore: res.next_before ?? null,
      pendingRequest: pending
        ? {
            kind: pending.kind,
            ...(pending.prompt ? { prompt: pending.prompt } : {}),
            questions: pending.questions,
            items: pending.items,
            rules: pending.rules,
            requestId: pending.request_id ?? null,
          }
        : null,
      thinkingMode: res.thinking_mode
        ? {
            mode: res.thinking_mode.mode,
            stage: res.thinking_mode.stage ?? null,
            ...(res.thinking_mode.workflow_id
              ? { workflowId: res.thinking_mode.workflow_id }
              : {}),
          }
        : null,
      workflowRun: res.workflow_run
        ? {
            workflowId: res.workflow_run.workflow_id,
            generation: res.workflow_run.generation,
            workflowName: res.workflow_run.workflow_name,
            sourceSessionId: res.workflow_run.source_session_id,
            phase: res.workflow_run.phase,
            stepIndex: res.workflow_run.step_index,
            executionSteps: res.workflow_run.execution_steps,
            validationSteps: res.workflow_run.validation_steps,
          }
        : null,
      children: (res.children ?? []).map((c) => ({
        sessionId: c.session_id,
        title: c.title,
        status: c.status,
        subagentMode: c.subagent_mode ?? null,
      })),
    }
  }

  /** Read one session-workspace file verbatim (GET /sessions/{id}/files?path=).
   *  Returns `null` on 404 — a missing `.work/.build/task.md` means "no brief yet",
   *  not an error. Other failures throw. */
  async getSessionFile(id: string, path: string): Promise<string | null> {
    const qs = new URLSearchParams({ path }).toString()
    const res = await fetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(id)}/files?${qs}`,
      { headers: this.headers({}) },
    )
    if (res.status === 404) return null
    if (!res.ok) throw await this.httpError(res)
    const body = (await res.json()) as { content?: unknown }
    return typeof body.content === 'string' ? body.content : null
  }

  /** Rename a session (PATCH /sessions/{id}); returns the updated summary.
   *  The daemon persists the custom title (survives reset + reload). */
  async renameSession(id: string, title: string): Promise<SessionSummary> {
    return this.fetchJson(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async deleteSession(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) throw await this.httpError(res)
  }

  /** Hard-stop a session's in-flight turn (POST /sessions/{id}/stop).
   *  The daemon cancels the agent task — the LLM stream is closed, running
   *  tools are killed, and the half-finished turn is discarded entirely.
   *  Idempotent on idle sessions (daemon answers `stopped: false`). */
  async stopSession(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(id)}/stop`,
      { method: 'POST', headers: this.headers() },
    )
    if (!res.ok) throw await this.httpError(res)
  }

  /** Read receipt for the sidebar unread dot: flip the session `completed`→
   *  `finish` so it stops showing a dot. Idempotent — a read / idle session is a
   *  clean no-op (the daemon answers 204). */
  async markSessionRead(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(id)}/read`,
      { method: 'POST', headers: this.headers() },
    )
    if (!res.ok) throw await this.httpError(res)
  }

  /** List a session's mounted local paths (GET /sessions/{id}/mounts). */
  async listMounts(sessionId: string): Promise<MountSummary[]> {
    return this.fetchJson(`/sessions/${encodeURIComponent(sessionId)}/mounts`)
  }

  /** List every user-visible Session mount with its owning conversation. */
  async listSessionFileAssets(page?: { limit?: number; offset?: number }): Promise<SessionFileAsset[]> {
    const params = new URLSearchParams()
    if (page?.limit !== undefined) params.set('limit', String(page.limit))
    if (page?.offset !== undefined) params.set('offset', String(page.offset))
    const query = params.size > 0 ? `?${params.toString()}` : ''
    return parseResponse<SessionFileAsset[]>(
      sessionFileAssetsSchema,
      await this.fetchJson(`/mounts${query}`),
      'GET /mounts',
    )
  }

  /** Mount a local absolute path onto a session (POST, daemon-side validated:
   *  non-absolute → 400, nonexistent on the daemon host → 404). */
  async addMount(sessionId: string, path: string): Promise<MountSummary> {
    return this.fetchJson(`/sessions/${encodeURIComponent(sessionId)}/mounts`, {
      method: 'POST',
      body: JSON.stringify({ path }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Unmount (DELETE ?id=) — drops the registry row, never the real file. */
  async removeMount(sessionId: string, mountId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/mounts?id=${encodeURIComponent(mountId)}`,
      { method: 'DELETE', headers: this.headers() },
    )
    if (!res.ok) throw await this.httpError(res)
  }

  /** Materialize bytes as a Session-owned file mount in one request. */
  async uploadMount(
    sessionId: string,
    filename: string,
    content: Blob,
  ): Promise<MountSummary> {
    const form = new FormData()
    form.append('file', content, filename || 'attachment.bin')
    return this.fetchJson(
      `/sessions/${encodeURIComponent(sessionId)}/mounts/upload`,
      { method: 'POST', body: form },
    )
  }

  /** Every installed skill for the current user (newest first). Disabled rows
   *  ARE included — the management list shows them; only the agent runtime hides
   *  them (server-side, in `SkillLibrary.load()`). */
  async listSkills(): Promise<SkillDetail[]> {
    return this.fetchJson('/skills')
  }

  /** Flip one skill's `enabled`; returns the updated row (unknown id → 404). */
  async toggleSkill(skillId: number, enabled: boolean): Promise<SkillDetail> {
    return this.fetchJson(`/skill/${skillId}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Uninstall one skill (DELETE → 204; unknown id → 404). 204 has no body, so
   *  use a raw fetch like {@link deleteProvider}. */
  async deleteSkill(skillId: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/skill/${skillId}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) throw await this.httpError(res)
  }

  /** Deep-scan a daemon-side directory for importable skills (read-only — nothing
   *  is copied or stored). `path` must be absolute on the daemon host. */
  async scanImportPath(path: string): Promise<ScannedSkill[]> {
    const qs = new URLSearchParams({ path }).toString()
    return this.fetchJson(`/skills/import/scan?${qs}`)
  }

  /** Dry-run conflict check: per item, whether importing overwrites a same-named
   *  installed skill (read-only). Result order matches `items`. */
  async checkSkillImport(items: SkillImportItem[]): Promise<ImportCheckResult[]> {
    return this.fetchJson('/skills/import/check', {
      method: 'POST',
      body: JSON.stringify(items),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Install the chosen skills — copies each dir into the managed root + upserts
   *  its store row. Same-named installs overwrite (reusing `skill_id`); per-item
   *  failures land in `failed_skills` without aborting the rest. */
  async importSkills(items: SkillImportItem[]): Promise<ImportSummary> {
    return this.fetchJson('/skills/import', {
      method: 'POST',
      body: JSON.stringify(items),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ───── Schedules ──────────────────────────────────────────────────────────

  /** Every schedule owned by the current user, with derived run-state. */
  async listSchedules(page?: { limit?: number; offset?: number }): Promise<ScheduleSummary[]> {
    const params = new URLSearchParams()
    if (page?.limit !== undefined) params.set('limit', String(page.limit))
    if (page?.offset !== undefined) params.set('offset', String(page.offset))
    const query = params.size > 0 ? `?${params.toString()}` : ''
    return this.fetchJson(`/schedules${query}`)
  }

  /** One schedule + its run history (unknown id → 404). */
  async getSchedule(scheduleId: string): Promise<ScheduleDetail> {
    return this.fetchJson(`/schedules/${encodeURIComponent(scheduleId)}`)
  }

  /** Create a schedule directly; the daemon primes `next_run_at` and 422s an
   *  invalid cron. */
  async createSchedule(body: CreateScheduleBody): Promise<ScheduleSummary> {
    return this.fetchJson('/schedules', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Partial-update a schedule (name/desc/cron/enabled); unknown id → 404. */
  async patchSchedule(scheduleId: string, body: PatchScheduleBody): Promise<ScheduleSummary> {
    return this.fetchJson(`/schedules/${encodeURIComponent(scheduleId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Delete a schedule (DELETE → 204; unknown id → 404). 204 has no body. */
  async deleteSchedule(scheduleId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/schedules/${encodeURIComponent(scheduleId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) throw await this.httpError(res)
  }

  /** Fire a schedule immediately (202 accepted; ignores the overlap gate). */
  async runScheduleNow(scheduleId: string): Promise<void> {
    await this.fetchJson(`/schedules/${encodeURIComponent(scheduleId)}/run-now`, { method: 'POST' })
  }

  /** Cancel a schedule's in-flight run (202 accepted). */
  async killSchedule(scheduleId: string): Promise<void> {
    await this.fetchJson(`/schedules/${encodeURIComponent(scheduleId)}/kill`, { method: 'POST' })
  }

  private async fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers((init?.headers as Record<string, string>) ?? {}),
        signal: init?.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (err) {
      // Rewrap the opaque TimeoutError DOMException with the endpoint name so
      // callers (and main.log) can tell WHICH request hung.
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(i18n.t('error.requestTimeout', { seconds: Math.round(this.requestTimeoutMs / 1000), path }))
      }
      throw err
    }
    if (!res.ok) throw await this.httpError(res)
    return res
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchResponse(path, init)
    return response.json() as Promise<T>
  }

  private async httpError(res: Response): Promise<AmphiHttpError> {
    if (res.status === 401 && this.token) {
      try {
        this.onAuthFailure?.()
      } catch {
        // Endpoint recovery is best-effort and must not replace the HTTP error
        // the caller is already handling.
      }
    }
    const fallback = `HTTP ${res.status} ${res.statusText}`
    let message = fallback
    try {
      const body = await res.text()
      if (body) {
        try {
          const payload = JSON.parse(body) as { detail?: unknown }
          message = typeof payload.detail === 'string'
            ? payload.detail
            : `${fallback}: ${body.slice(0, 300)}`
        } catch {
          message = `${fallback}: ${body.slice(0, 300)}`
        }
      }
    } catch {
      // Keep the status-only fallback when the error body cannot be read.
    }
    return new AmphiHttpError(res.status, message)
  }
}
