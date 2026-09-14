# Desktop debug API contract

**Proposal; not implemented.** This document specifies a future backend contract
for the Desktop debug renderer. It does not add execution endpoints, change the
Python backend, or promise that historical requests were captured.

Today, `bun run debug` starts a read-only adapter inside the Bun development
launcher. Its only route is
`GET /__debug-api/sessions/{sessionId}/turns?before={cursor}&limit=20`.
It reads the existing Desktop database and returns `DesktopDebugTurnsPage` from
`apps/electron/src/shared/debug-types.ts`: latest-first Turns with raw
`otaRecords`, `otaContext`, `contextUsage`, and captured Turn metadata. Its
`otaContextSource` distinguishes stored context from assembly of stored fields.
It rejects non-GET requests. The current renderer adapts these records locally;
neither tool execution nor LLM execution is available through this adapter.

## Proposed routes and availability

All proposed routes use the existing backend bearer authentication and current
user resolution. Each Session, Turn, round, tool call, and debug run must belong
to the requested Session and authenticated user. The debug renderer uses the
same backend, data, workspace, and native Session hosts as ordinary Desktop.

| Method and path | Purpose |
| --- | --- |
| `GET /api/debug/capabilities` | Advertise implemented debug operations. |
| `GET /api/debug/sessions/{sessionId}/trace` | Read normalized, paginated Turn → round → tool traces. |
| `POST /api/debug/sessions/{sessionId}/tool-runs` | Start one explicitly requested tool execution from an edited draft. |
| `POST /api/debug/sessions/{sessionId}/llm-runs` | Start one explicitly requested LLM call from an edited request draft. |
| `GET /api/debug/sessions/{sessionId}/runs/{runId}` | Read that debug run's status and result. |
| `POST /api/debug/sessions/{sessionId}/runs/{runId}/cancel` | Request cancellation, when supported. |

Capability values describe the deployed backend, not the presence of buttons:

```json
{
  "schemaVersion": 1,
  "traceRead": true,
  "liveTrace": false,
  "toolRun": false,
  "llmRun": false,
  "cancelRun": false
}
```

A missing capability endpoint means the proposed protocol is unavailable; the
frontend can continue using the current read-only adapter. Unsupported execution
controls remain disabled. Production remains the ordinary Desktop renderer; a
frontend debug switch is not authorization to expose backend execution routes.

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

The following compact example shows one completed round and one executed tool.
Its request is deliberately partial: the captured messages are present, while
the original outgoing wire body is unavailable.

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
      "modelAttempts": [{
        "id": "turn_12:round:1:attempt:1",
        "idOrigin": "derived",
        "ordinal": 1,
        "status": "succeeded",
        "request": {
          "availability": "partial",
          "origin": "captured",
          "missingFields": ["/wireRequest"],
          "value": {
            "model": { "providerId": "provider_example", "protocol": "openai", "modelId": "captured-model" },
            "messages": [{ "role": "user", "content": "Read the project summary." }],
            "tools": [{ "type": "function", "function": { "name": "read_file", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } } }],
            "options": { "temperature": 0.2 },
            "wireRequest": null
          }
        },
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

## Request snapshots and missing facts

A request snapshot represents the request associated with **one model attempt**,
after context assembly and provider option processing. It is not a concatenated
display prompt. Preserve message order, roles, structured/multimodal content,
tool-result links, tool schemas, and effective model options. Preserve provider
extensions in `wireRequest` when captured. Never serialize authentication headers
or provider credentials into a snapshot or debug response.

The essential shared shapes are:

```ts
type Snapshot<T> = {
  availability: 'complete' | 'partial' | 'unavailable'
  origin: 'captured' | 'unavailable'
  value: T | null
  missingFields: string[] // JSON pointers into value; [] only when complete.
}
type RequestSnapshot = Snapshot<{
  model: { providerId: string | null; protocol: string | null; modelId: string | null }
  messages: Array<{
    role: string
    content: unknown
    toolCallId?: string
    toolCalls?: unknown[]
  }> | null
  tools: unknown[] | null
  options: Record<string, unknown> | null
  wireRequest: unknown
}>
type Timing = { startedAt: string | null; endedAt: string | null; durationMs: number | null }
type TraceIssue = { code: string; field: string; sourcePointers: string[] }
type ExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
```

`complete` requires the actual outgoing request body and its effective metadata,
not a reconstruction from today's templates, tools, credentials, or model
selection. `partial` exposes exactly the captured subset and lists missing
fields. `unavailable` has `value: null` and an explicit reason in the entity's
`issues`. Assembled OTA context, visible chat text, and reconstructed prompts
must never be relabeled as original model requests. The UI can display an
unavailable request without blocking access to the rest of a trace.

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
arguments, request snapshot, or result. Submitting a draft creates a new linked
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
supplies the edited `RequestSnapshot.value` shape as `input.request`, with
`input.basis: "captured" | "user_authored"`. A partial or unavailable original
must not be silently completed from current settings. The UI must identify
user-authored replacements and require any missing execution parameters.
Replay references a finalized source snapshot at the specified revisions. The
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
