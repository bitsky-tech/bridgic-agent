# Desktop debug API contract

This document describes Turn observation, on-demand Cognitive Prompt assembly,
and single-tool execution, followed by proposed normalized trace and replay APIs.

## Implemented debug paths

### Raw Turn traces

`bun run debug` starts a read-only adapter inside the Bun development launcher.
Its only data route is
`GET /__debug-api/sessions/{sessionId}/turns?before={cursor}&limit=20`.
It reads the existing Desktop database and returns `DesktopDebugTurnsPage` from
`apps/electron/src/shared/debug-types.ts`: latest-first Turns with raw
`otaRecords`, `otaContext`, `contextUsage`, and captured Turn metadata. Its
`otaContextSource` distinguishes stored context from assembly of stored fields.
It rejects non-GET requests, requires the debug launcher's bearer token, and
accepts only that launcher's renderer origin. This adapter is solely for raw
Turn traces; it does not serve prompt data or execute tools or models.

New tool executions record each call's elapsed milliseconds in the round's
`tool_durations_ms` map, keyed by tool-call id. The inspector matches these
durations by call id; explicit durations on individual results remain supported.
`act_duration_ms` describes the whole action group and is never substituted for
an individual tool's time. Older records without per-call timings show no duration.

### Live execution cards

The debug renderer also projects the existing Session events into in-memory
execution cards. No new backend event or OTA field is required. Each
`context_usage` event closes a model response; subsequent text/reasoning or
another usage event opens the next card. Tool calls after that boundary still
belong to the completed response, and results match by tool-call id. Model
transport retries roll back only the current card's discarded text/reasoning.

The projection is installed only by the debug renderer and captures events
synchronously before React batches its renders. It is Session-scoped, retains
parked content across interaction continuations, and keeps settled cards visible
until persisted Turn records become available. Conversation view retains the
ordinary streaming presentation. Live tool rows expand to show received results;
the saved-record inspector becomes available after persistence.

Saved records replace a projection only when they cover its responses and
received tool results. An older snapshot cannot erase newer continuation cards,
and refreshing another Turn does not switch complete cards back to live mode.
If a resumed transcript contains content absent from the projection, an expanded
product conversation record preserves that content until complete history arrives.

These cards are a presentation of received events, not authoritative OTA
snapshots. Internal tools omitted from the ordinary stream and full request data
are filled in from persisted records. Missing timing remains unknown and
estimated token usage is not shown as provider-reported usage. A late subscriber
can only display the events still available to it until durable history arrives.
The proposed `liveTrace` capability below describes a future authoritative trace
protocol, not this frontend projection.

### On-demand Cognitive Prompt API

`POST /api/debug/sessions/{sessionId}/prompts` assembles one selected round:

```ts
type AssemblePromptInput = {
  turnId: string
  roundIndex: number // Zero-based index in the Turn's OTA records.
  mode: string
  stage: string
}
```

The handler uses normal bearer authentication, resolves the current user, and
checks Session/Turn ownership and the supplied round scope. It delegates to
`self.invocation.get_prompt`, which calls the Agent method to identify the
Cognitive worker and assemble the request for that round's context.

The response uses `Cache-Control: no-store`:

```ts
type AssembledPromptResponse = {
  sessionId: string
  item: {
    id: string
    turnId: string
    turnOrdinal: number
    roundIndex: number
    stage: string
    mode: string
    availability: 'assembled'
    request: {
      schemaVersion: 1
      kind: 'cognitive'
      worker: string // Resolved Cognitive worker class.
      providerId: string | null
      modelId: string | null
      protocol: string | null
      messages: unknown[]
      tools: unknown[]
      extraBody: unknown
    }
  }
}
```

The frontend lists rounds from its existing Session trace, requests assembly only
when a round or comparison baseline is selected, and keeps results in panel
memory. It does not enable capture or request a persisted Prompt feed.

The output is assembled using current Cognitive code, configuration, and Session
resources. Conversation history stops before the selected response. Each new
`OTARecord` stores its complete round snapshot in `think_scope` immediately before
the model request, after any accepted context compaction. Cognitive fields such
as `mode`, `stage`, `step_index`, `workflow_id`, and `generation` stay at the top
level. The other Agent state fields (including the full `context_compaction`
summaries and coverage), all three tool-loading flags, and `prompt_time` live
alongside them. There is no second `prompt_context` or duplicate `state.think`.
The endpoint restores this round's values rather than the final Turn state.
Snapshots contain no copied history, messages, or tool schemas, and remain
independent of later state mutations. Existing trace navigation still reads
`think_scope.mode`, `think_scope.stage`, and the optional `think_scope.step_index`.
Previously saved split `prompt_context` snapshots remain readable. Older rounds
without either snapshot retain the Turn-state fallback and any
recorded `think_scope.step_index`; their overwritten intermediate states cannot
be recovered retroactively.
Presentation state retains only `mode`, `stage`, and `step_index`. Human decisions
are recorded in the corresponding confirmation tool result. Confirmed outlines
and template decisions produce artifacts under the Session's `.ppt/` directory;
Prompt assembly resolves only artifact paths from preceding tool results. New
confirmations produce new files instead of overwriting earlier confirmed output.
The shared UI projection also reads these tool results, not business fields from
Turn state. Mutable Brief/Plan/Review documents are read through file tools.
Workflow inspection restores the recorded workflow identity and cursor from the
round's state. Legacy records resolve their entry from preceding
`request_run_workflow` results and their section from `think_scope.step_index`.
The original input is resolved from preceding entry results. Inspection loads
the recorded Workflow's saved definition,
without opening the Session's active `.run` or comparing its current cursor.
Completed Turns can assemble after returning to Main or after another Run starts.
The inspection context does not need a Run generation; execution still requires
the generation and cursor to match the durable Run before accepting controls.
`AmphiAgent.get_prompt(context, ota_context)` calls the worker's original
`assemble_messages` and returns those messages and tool definitions, before
runtime-tail injection or new context compaction. Existing retained summaries may affect
history projection, but this endpoint does not run new compaction because that
could invoke a model.

Internal assembly state is preserved for new rounds; mutable external resources
such as `.build` files are read from the current environment. This is not a
historical provider HTTP body. The endpoint does not call a model or execute
tools. Round snapshots use the existing `ota_records` JSON column, with no new
database columns, tables, or migrations. Storage grows with the serialized state,
particularly the length of retained compaction summaries. Unsupported workers or
insufficient round context return an error rather than a substituted Prompt.

### Single-tool execution API

`POST /api/debug/sessions/{sessionId}/tools/execute` runs one explicitly submitted
tool call using the current Session resources:

```ts
type ToolExecutionInput = {
  toolName: string
  arguments: Record<string, unknown>
}
type ToolExecutionResponse = {
  sessionId: string
  durationMs: number
  result: {
    tool_id: string // A new id for this execution.
    tool_name: string
    tool_arguments: Record<string, unknown>
    tool_result: unknown
    success: boolean
    error: string | null
  }
}
```

The normal backend bearer token and Session ownership check are required.
The handler delegates to `self.invocations.execute_tool`; Invocation uses the
shared `_load_context` resource loader and calls `AmphiAgent.execute_tool`.
The Agent selects the current ToolSpec and reuses its ordinary single-tool
worker runner. Recorded strings receive the existing argument coercion, while
native JSON arrays, objects, booleans, numbers, and nulls retain their types.

The explicit click executes the tool directly with the user's current execution
mode. It does not enter model-driven admission, cognitive result processing, or
the Turn loop. Control tools return their request data without opening a
confirmation interaction or advancing a workflow. Tool-specific runtime checks
still apply, including read-before-modify checks and required workflow state.

Workspace files, mounts, browser pages, and Office targets are current resources;
no historical restoration is attempted. Tool changes affect those resources.
The endpoint does not create or overwrite conversation Turns or recorded calls.
Unavailable resources retain their native errors. Completed calls, including
tool failures, return HTTP 200 and `Cache-Control: no-store`; unavailable
Sessions return 404, context-loading conflicts return 409, and malformed requests
or unknown tool names return 422.

The renderer submits only on a click, blocks repeat clicks while running, and
keeps the result and submitted arguments in the current Session's panel memory.
Inspector navigation does not cancel a running tool. Switching Sessions discards
its local test state and ignores late results. There is no automatic retry,
run-polling endpoint, cancellation contract, or 30-second transport timeout;
individual tools retain their own runtime limits. A disconnected request cannot
establish whether its tool already took effect.

## Proposed normalized trace and replay routes

All proposed routes must use the existing backend bearer authentication and
current-user resolution. Each Session, Turn, round, tool call, and debug run must
belong to the requested Session and authenticated user. The debug renderer uses
the same backend, data, workspace, and native Session hosts as ordinary Desktop.

| Method and path | Purpose |
| --- | --- |
| `GET /api/debug/capabilities` | Advertise implemented debug operations. |
| `GET /api/debug/sessions/{sessionId}/trace` | Read normalized, paginated Turn → round → tool traces. |
| `POST /api/debug/sessions/{sessionId}/tool-runs` | Future asynchronous tool run; the implemented synchronous endpoint is `tools/execute`. |
| `POST /api/debug/sessions/{sessionId}/llm-runs` | Start one explicitly requested LLM call from an edited request draft. |
| `GET /api/debug/sessions/{sessionId}/runs/{runId}` | Read that debug run's status and result. |
| `POST /api/debug/sessions/{sessionId}/runs/{runId}/cancel` | Request cancellation, when supported. |

Capability values describe the deployed backend, not the presence of buttons:

```json
{
  "schemaVersion": 1,
  "promptAssembly": true,
  "traceRead": false,
  "liveTrace": false,
  "toolRun": true,
  "llmRun": false,
  "cancelRun": false
}
```

The capability endpoint itself remains proposed. Once implemented, its values
must describe the deployed backend rather than the presence of buttons. Until
then, the implemented Prompt and tool execution routes and raw Turn adapter above
are the debug transports. Model execution controls remain disabled. Production
remains the ordinary Desktop renderer; a frontend debug switch is not
authorization to expose backend execution routes.

## Trace envelope and ordering

The trace query accepts `before` and `limit` (default 20, maximum 100 Turns).
The initial page contains the newest window of Turns, **returned in ascending
`sessionOrdinal` order** for rendering. Each older page is also ascending and is
prepended. This differs from the current adapter's latest-first transport.

Cursors are opaque, bound to the Session and a stable Turn ordering boundary;
they must not use offsets or mutable timestamps. A new Turn arriving between
page requests must not duplicate or skip older Turns. Never split a Turn across
pages. `nextCursor: null` means there are no earlier Turns. Refreshing recent
Turns replaces their existing IDs at a newer revision rather than appending a
second copy. An empty Session returns an empty successful page, while an unknown
or inaccessible Session returns an appropriate error.

Within a Turn, rounds are ordered by their recorded ordinal. Within a round,
tool calls retain declaration order even when execution finishes out of order.
Mode and stage are attributes of each round, so a stage transition never changes
the label of an earlier round. Round IDs and provider call IDs are distinct from
display ordinals. Legacy records can receive deterministic IDs derived from the
Turn and source index; `idOrigin` must mark them as derived.

The following proposed trace example shows one completed round and one executed
tool. Its `promptSource` identifies the separate on-demand assembly request; it
does not embed a saved Prompt. The provider attempt's outgoing wire body is
explicitly unavailable.

```json
{
  "schemaVersion": 1,
  "sessionId": "session_example",
  "turns": [{
    "id": "turn_12",
    "sessionOrdinal": 12,
    "revision": 3,
    "status": "completed",
    "persisted": true,
    "userInput": { "text": "Read the project summary.", "blocks": [] },
    "finalAnswer": "The summary is ready.",
    "timing": { "startedAt": "2026-09-11T10:00:00.000Z", "endedAt": "2026-09-11T10:00:01.500Z", "durationMs": 1500 },
    "rounds": [{
      "id": "turn_12:round:1",
      "idOrigin": "derived",
      "ordinal": 1,
      "revision": 2,
      "phase": "final",
      "mode": "normal",
      "stage": "main",
      "source": { "turnId": "turn_12", "otaField": "ota_records", "roundIndex": 0, "pointer": "/ota_records/0" },
      "promptSource": { "turnId": "turn_12", "roundIndex": 0, "mode": "normal", "stage": "main" },
      "modelAttempts": [{
        "id": "turn_12:round:1:attempt:1",
        "idOrigin": "derived",
        "ordinal": 1,
        "status": "succeeded",
        "wireRequest": { "availability": "unavailable", "origin": "unavailable", "value": null, "missingFields": ["/providerWireBody"] },
        "timing": { "startedAt": null, "endedAt": null, "durationMs": 1200 },
        "usage": { "source": "provider", "inputTokens": 120, "outputTokens": 20, "cacheReadInputTokens": 80, "cacheWriteInputTokens": null, "totalTokens": 140, "inputTokenSemantics": "includes_cache" },
        "response": { "text": "I will read the summary.", "reasoning": null, "toolCalls": [{ "id": "call_1", "name": "read_file", "arguments": { "path": "summary.md" } }] }
      }],
      "tools": [{
        "id": "turn_12:round:1:tool:1",
        "idOrigin": "derived",
        "ordinal": 1,
        "modelAttemptId": "turn_12:round:1:attempt:1",
        "sourceCallId": "call_1",
        "name": "read_file",
        "arguments": { "path": "summary.md" },
        "hasResult": true,
        "result": "Example summary text.",
        "status": "succeeded",
        "error": null,
        "timing": { "startedAt": null, "endedAt": null, "durationMs": 300 },
        "correlation": "id",
        "source": { "callIndex": 0, "resultIndex": 0 }
      }],
      "issues": []
    }]
  }],
  "nextCursor": "opaque-earlier-turn-cursor",
  "hasMore": true
}
```

## Assembled requests and missing facts

A Cognitive request is assembled on demand through the implemented POST above.
It preserves message order, roles, structured and multimodal blocks, tool-result
links, tool schemas, semantic options, and current model metadata. It stops
before new compaction, uses current runtime resources, and does not promise a
historical intermediate state. Never serialize authentication headers or
provider credentials into a debug response.

A provider request snapshot is a separate future concern. It belongs to one
provider attempt after protocol conversion and effective option processing. A
provider adapter may make several attempts for one Cognitive request. The
on-demand assembly API must not infer those attempts from the final response.

The essential shared shapes for assembly and the separate proposed provider
observations are:

```ts
type AssembledCognitiveRequest = AssembledPromptResponse['item']['request']
type Snapshot<T> = {
  availability: 'complete' | 'partial' | 'unavailable'
  origin: 'captured' | 'unavailable'
  value: T | null
  missingFields: string[] // JSON pointers into value; [] only when complete.
}
type ProviderRequestSnapshot = Snapshot<{
  model: { providerId: string | null; protocol: string | null; modelId: string | null }
  providerWireBody: unknown
}>
type Timing = { startedAt: string | null; endedAt: string | null; durationMs: number | null }
type TraceIssue = { code: string; field: string; sourcePointers: string[] }
type ExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
```

For a future provider snapshot, `complete` requires the actual outgoing request
body and its effective metadata. `partial` exposes exactly the captured subset
and lists missing fields. `unavailable` has `value: null` and an explicit reason
in the entity's `issues`. An on-demand Cognitive
assembly must retain its `assembled` origin; it must never be relabeled as a
historical capture or provider request. The UI can display an assembly failure
or unavailable provider observation without blocking the rest of a trace.

Use ISO 8601 UTC timestamps with an explicit `Z`; do not guess the timezone of a
legacy naive timestamp. Durations are finite, nonnegative milliseconds. Token
counts are nonnegative integers; `null` means unknown and zero means an actual
recorded zero. Usage belongs to its declared attempt, round, or Turn scope.
Provider-reported totals, cached input reads, and cache creation remain separate;
never add cached tokens to input tokens without knowing the provider's inclusion
semantics. Estimated counts are explicitly marked `source: "estimated"`.
Conflicting or invalid measurements become `null` with a `TraceIssue`, retaining
the original source values for inspection.

Each normalized entity retains source pointers and an optional raw source object
for unsupported fields. A missing tool result uses `hasResult: false`; a tool
that returned JSON `null` uses `hasResult: true, result: null`. Preserve structured
errors, malformed legacy arguments, and unmatched results rather than silently
dropping or coercing them. Display unknown status as unknown.

## Streaming, final records, and multiple tools

When `liveTrace` is supported, reuse the backend's Session event subscription
with proposed `debug_trace_upsert` events. Each event carries `sessionId`,
`entityType`, `entityId`, `revision`, and a replacement snapshot. A client ignores
older revisions and replaces an existing entity on finalization. Reconnect can
resynchronize from the paginated trace; it must not concatenate a final response
onto the same text already received while streaming.

`phase: "streaming" | "final"` describes record delivery, while execution status
describes the outcome. A finalized cancelled attempt can contain partial output.
A persisted Turn awaiting human input is not a completed conversation. Requests
retried by a provider wrapper remain separate model attempts with separate
usage and outcomes; only the accepted attempt's calls proceed to tool execution.
Legacy traces that did not capture retries mark attempt history unavailable;
they must not fabricate missing attempts from the final aggregate.

Correlate a tool result using its Session, Turn, round, attempt, and call ID.
Never join by tool name alone, array completion order, or timestamps. For legacy
records without IDs, an unambiguous recorded name-and-arguments match can be
labeled `correlation: "arguments"`; ambiguous results stay unmatched and visible.
Do not assign a whole action-group duration to every tool or infer individual
durations from parallel completion order. A model returning `tool_calls` proves
neither that those tools ran nor that they succeeded.

## Edited drafts and independent debug runs

Editing happens in a local draft. It never modifies the original Turn, round,
arguments, assembled request, or result. Submitting a draft creates a new linked
debug run in the existing backend; it does not rewind Session files or create
an isolated database. Original trace records remain immutable. Debug results
are stored separately from normal conversation Turns and do not silently become
future Agent history.

Each POST carries a caller-generated `clientRequestId` for idempotency, a source
reference, and the edited input. Repeated delivery of the same ID and payload
returns the same run; reuse with different input returns a conflict.

```json
{
  "clientRequestId": "draft-tool-001",
  "source": { "turnId": "turn_12", "turnRevision": 3, "roundId": "turn_12:round:1", "roundRevision": 2, "toolId": "turn_12:round:1:tool:1" },
  "input": { "name": "read_file", "arguments": { "path": "revised-summary.md" } }
}
```

The `llm-runs` request uses the same envelope but references `modelAttemptId` and
supplies the edited `AssembledCognitiveRequest` shape as `input.request`, with
`input.basis: "assembled" | "user_authored"`. An assembled input uses the current
Cognitive/runtime boundary described above; it is not a historical request. The
UI must identify user-authored replacements and require missing execution
parameters. Replay references a finalized source trace at the specified revisions. The
backend rejects changed or unavailable source revisions rather than silently
executing against a newer trace, and retains the accepted source link and draft.

Both POSTs return `202` with `{ "runId": "debug_run_1", "status": "queued" }`.
The run resource contains its `kind` (`tool` or `llm`), source reference,
submitted input, revision, execution status, timing, result, usage where
applicable, and error. Accepted draft input is immutable; another edit creates
another run. A cancellation request is not proof that execution was cancelled;
the final run status is authoritative. A failed tool/model call is a failed run,
while invalid input, unavailable capability, and stale source references use
HTTP errors with `{ "error": { "code": "...", "message": "..." } }`.

Tool runs reuse the authenticated Session's current tool registry, argument
validation, execution mode and permission checks, workspace/mounts, and
Session-owned Browser/PowerPoint targets. Existing Agent runtime construction
and tool dispatch provide the reusable building blocks. Tools can affect that
live Session environment; a replay is a new execution, not historical state
restoration. Concurrent conflicting Session work must be rejected or explicitly
serialized by the backend. Agent control-flow tools that need loop continuation
must report unsupported until their standalone behavior is defined.

LLM runs reuse backend provider selection, credentials, protocol adapters, and
cancellation. They execute one logical model request and return text, recorded
reasoning where available, usage, and proposed tool calls. Provider retries are
reported as attempts. **They do not execute returned tools, continue the Agent
loop, or write a normal conversation Turn.** Running a model and then its tools
would be a separate capability, not an implicit interpretation of `llm-runs`.

The frontend can adopt the normalized trace through one transport adapter when
the backend advertises support, while retaining the current raw-record adapter
for older deployments. Draft editors and unavailable-state UI can be implemented
now; actual execution stays disabled until the backend capability exists.
