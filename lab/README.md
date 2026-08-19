# Bridgic Agent Lab

Local browser workspace for inspecting and tuning Bridgic Agent subsystems. It runs as a local browser service and reads the Bridgic Agent state database directly; the Python backend does not need to be running.

The interface supports Chinese and English. Use the language control in the header; the selected locale is stored in the browser and restored on reload. Raw prompt, log, state, and tool payloads remain in their source language.

## Run locally

```bash
cd lab
bun install
bun run dev
```

Open `http://127.0.0.1:4319`.

`bun run dev` starts both the React development server and a read-only Bun data API. Vite proxies `/api` to the Bun service, so the browser still uses the single URL above.

The data source is intentionally fixed in code:

```text
~/.bridgic/AmphiAgent/state.db
```

The service expands `~` with the current user's home directory and opens SQLite with both `readonly` and `PRAGMA query_only = ON`. It only queries `sessions`, `session_turns`, and `session_mounts`. There is currently no source picker, import, export, write, or arbitrary SQL endpoint.

Set `BRIDGIC_AGENT_LAB_PORT` before either command to use a different local browser port. The internal development API uses `127.0.0.1:4320` by default; set `BRIDGIC_AGENT_LAB_API_PORT` only if that port is already occupied.

## Interface

- The left Session pane and right Analysis pane can be resized by dragging their separators. Arrow keys, Home, and End also resize a focused separator; each pane can be collapsed, and its last width is kept in browser storage.
- Child Agent Sessions are grouped under their root Session and collapsed by default. Searching for or selecting a child expands the relevant root group.
- Selecting a Turn opens its persisted OTA rounds in the center. Selecting a round expands Overview, Prompt, and Tools directly inside the center timeline.
- Prompt inspection separates the ordered Message input from the parallel Tool Definitions request field. The Message track contains five readable blocks—Persona, dynamic Context, Session history, current input, and structured Turn history—while Tool Definitions are shown beside it rather than as a final Message. The raw request dialog uses the same two-track structure instead of a JSON dump.
- The right Analysis pane starts collapsed so the execution trace keeps the primary workspace. When opened, Turn input/output Tokens and the Prompt cache hit/miss overview remain visible; only the longer Turn/Round cache details start collapsed and expand on demand.

`state.db` currently persists input/output token totals per Turn, not per OTA round. It also does not persist Provider cache-read/cache-write token details, so the cache hit/miss values are structural estimates derived from reconstructed requests. Each model-request row shows an estimated input size. Output is shown only when a completed Turn contains exactly one model request, where the Turn total can be assigned without splitting; multi-request Turns display it as unavailable. If a Turn has no earlier same-model request to compare with, the Lab shows an explicit “no comparable request” state instead of a misleading 0% result.

## Local data API

All routes are same-origin, read-only `GET` requests:

```text
GET /api/source/health
GET /api/sessions?cursor=&limit=&query=
GET /api/sessions/:sessionId/turns?cursor=&limit=
GET /api/sessions/:sessionId/prompts
GET /api/turns/:turnId
GET /api/turns/:turnId/rounds/:roundId/prompt
```

List endpoints return `{ items, nextCursor, total }`; the Session Prompt collection returns `{ items, total }`. Cursors are opaque and should be passed back unchanged. Turn detail includes parsed user input, normalized OTA rounds, agent state, the owning session, and that session's mounted paths. The single Prompt endpoint accepts the round id returned by Turn detail, such as `turn_abcd:round:1`, and reconstructs the native message list and tool surface immediately before that round. Session-wide Prompt analysis includes only OTA records with a persisted `think_result`, while retaining each record's original Round id and ordinal. Unknown or malformed historical JSON degrades to empty values instead of failing the whole request.

## Prompt reconstruction

Prompt assembly is implemented independently in TypeScript under `server/prompt/`; it does not call the Python backend or read the old `_msg_debug` output. The Lab rebuilds the target call boundary as two peer request fields:

```text
messages:
  SYSTEM (persona + context)
  → bounded prior Session messages
  → current user input + inferred current_time
  → completed OTA rounds before the selected round

tools:
  visible function definitions sent separately beside messages
```

The eight persona variants are complete static snapshots of `src/amphi_agent/_prompt.py`, pinned by SHA-256 and checked byte-for-byte in tests. Prompt diff keeps ordered Message blocks and the unordered Tool surface in separate comparison sections, so a Tool Schema change is not reported as the last Message change. See `server/prompt/README.md` for the synchronization command and internal reconstruction model.

## Verify

```bash
bun run typecheck
bun run test
bun run build
```

`bun run preview` serves the production build and the same local data API together on `http://127.0.0.1:4319`. Run `bun run build` first.
