# Prompt reconstruction

This module rebuilds the native model request immediately before one persisted
OTA round. It is deliberately independent from SQLite and HTTP: the data server
queries and normalizes state, then calls one pure function.

## HTTP integration

The intended read-only route is:

```text
GET /api/turns/:turnId/rounds/:roundId/prompt
```

The response envelope is:

```ts
{ item: PromptRebuildResult }
```

Session-wide analysis can load every reconstructable call in one read-only request:

```text
GET /api/sessions/:sessionId/prompts
```

It returns `{ items: PromptRebuildResult[], total }`, ordered by Turn ordinal and
then Round ordinal. Only OTA records with a persisted `think_result` contribute
items; records opened without a completed model decision are skipped while their
original Round indexes remain unchanged.

`roundId` may use the existing synthetic OTA id, for example
`turn_abc:round:2`. The adapter converts its one-based ordinal to the pure
rebuilder's zero-based `targetRoundIndex` and preserves the original id in the
response.

```ts
import { rebuildPromptFromSource } from '../prompt-adapter'

const item = rebuildPromptFromSource(source, turnId, roundId)
return json({ item })
```

`prompt-adapter.ts` maps the data-server DTO to `PromptRebuildInput`.
`getPromptConversation` fetches the target Turn and all earlier Turns in
the same Session with their `user_input`, `ota_records`, status/error, Agent
state, lazy-tool flags, and model metadata. It should order the rows by
`session_ordinal`; the adapter also sorts defensively.

## Pure input

`PromptRebuildInput` contains:

- `session`: Session identity, parent relation, and `workspaceRoot`.
- `turns`: normalized Turns through the target Turn, including raw OTA records.
- `targetTurnId`, `targetRoundIndex`, and optional route-level `targetRoundId`.
- optional `workspace` and `context` snapshots for mounts, runtime environment,
  Skills, memories, schedules, Workflows, browser tabs, Build artifacts, and an
  active Workflow Run.
- optional exact `toolCatalog`, `personas`, `uiLanguage`, and `promptTime` snapshots. When
  omitted, the Lab uses its own maintained copies and reports the limitation.

The server-level `prompt-adapter.ts` already maps `TurnDetail` to this contract. API code
normally should not assemble the contract by hand.

## Pure output

`PromptRebuildResult` is directly JSON serializable and contains:

- `messages`: native system/user/assistant/tool messages with tool-call ids,
  arguments, results, and persisted reasoning extras.
- `tools`: ordered visible tool names and schema summaries for that round.
- `components`: persona, context, Session history, current input, prior-round
  replay, and tool-surface breakdown with message indexes. Session history uses
  structured inputs, failed-Turn markers, and persisted compaction summaries
  followed by the uncovered raw tail. Historical Turns likewise apply their
  persisted normal/Main Turn summaries, while the active Turn selects the
  summary for its exact cognitive mode and stage.
- `fidelity`: a score and explicit limitations for information not historically
  persisted in `state.db`.

The selected OTA record itself is never replayed. The reconstruction represents
the call boundary before that round ran, so only records with an index lower
than `targetRoundIndex` appear in the current-Turn message block.

`state.db` stores one final `context_compaction` projection per Turn rather than
a version for every OTA round. The Lab applies that final projection to the
latest persisted request, where it represents the runtime state at the call
boundary. For an earlier round it uses the prior Turn's Session boundary and
does not apply the later stage summary, preventing future execution history
from leaking backwards; the affected components are explicitly marked partial.

## Persona source snapshot

All eight runtime personas are copied in full to `personas.generated.ts`:
normal Main, Child, all four Build stages, and both Workflow Run stages. The
generated module records the SHA-256 of the complete, automatically discovered
modular prompt source graph (with normalized line endings) and the shared
failed-Turn marker. `personas.test.ts` checks that source manifest and hash,
then compares every rendered persona byte-for-byte with the Python renderer in
both UI languages, including conditional Child delegation guidance.

After intentionally changing `src/amphi_agent/_prompt.py` or a module under
`src/amphi_agent/_prompts/`, refresh the Lab copy from the repository root with:

```sh
cd lab
bun run scripts/snapshot-personas.ts
bun test server/prompt/personas.test.ts
```

The generator uses `PYTHON` when set, otherwise the repository `.venv`, then a
system `python3` or `python` executable.

The generation command is a development-time synchronization aid only. The Lab
runtime imports the static TypeScript snapshot and never imports or invokes the
Python backend.
