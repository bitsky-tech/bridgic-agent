/**
 * Type definitions for the PythonClient backend integration.
 *
 * Shape mirrors what `amphi server status` emits and what the
 * renderer subscribes to via IPC. Kept in `main/python-client/` because
 * it is owned by the main process; the renderer imports it transitively
 * through `shared/types.ts` once the IPC contract surfaces these shapes.
 *
 * Backend contract sources: `amphi_cli._server` for the command surface and
 * `amphi_service.server._manager` for runtime registration.
 */
import type { BackendCompatibility } from './compatibility'

// Re-exported so renderer code can pull the whole backend vocabulary from one
// module (it already imports BackendState/BackendSnapshot from here).
export { CompatibilityState } from './compatibility'
export type { BackendCompatibility } from './compatibility'

/**
 * Daemon liveness state — drives renderer UI banners and atom subscriptions.
 *
 *   `idle`         initial, before start() is called (one-shot at app boot)
 *   `discovering`  status probe in flight
 *   `spawning`     daemon not running, `amphi server start` is racing
 *   `ready`        endpoint resolved, /health probed OK
 *   `unhealthy`    health-check failed mid-flight; reconnecting
 *   `unavailable`  daemon not reachable AND auto-recovery exhausted OR
 *                  user explicitly stopped via Settings / tray. Manual
 *                  start required — GatewayBootGate renders this with
 *                  the "Gateway not running + [Start Gateway]" recovery card.
 *   `incompatible` a daemon IS running and reachable, but its version does not
 *                  match the one this GUI was released against. Distinct from
 *                  `unavailable` on purpose: the recovery action is "restart the
 *                  gateway", not "start the gateway", and telling the user their
 *                  gateway is down when it is demonstrably up sends them
 *                  debugging the wrong thing.
 *
 * Exposed as a const + matching type (declaration merging) so callers
 * use `BackendState.Discovering` rather than `'discovering'` — single
 * source of truth, grep-friendly, refactor-safe.
 */
export const BackendState = {
  Idle: 'idle',
  Discovering: 'discovering',
  Spawning: 'spawning',
  Ready: 'ready',
  Unhealthy: 'unhealthy',
  Unavailable: 'unavailable',
  Incompatible: 'incompatible',
} as const
export type BackendState = (typeof BackendState)[keyof typeof BackendState]

/**
 * Discriminator values for {@link StatusJson} — the `status` field of
 * `amphi server status` output. Three mutually exclusive outcomes.
 */
export const StatusKind = {
  Running: 'running',
  Stopped: 'stopped',
  Stale: 'stale',
} as const
export type StatusKind = (typeof StatusKind)[keyof typeof StatusKind]

/**
 * Logical type of a client connecting to the Bridgic Agent daemon.
 *
 * Used by the GUI for the ``X-Client-Type`` request header consumed by the
 * daemon's client registry. The set is intentionally finite and closed.
 */
export const ClientKind = {
  Gui: 'gui',
  Cli: 'cli',
  Tray: 'tray',
  Unknown: 'unknown',
} as const
export type ClientKind = (typeof ClientKind)[keyof typeof ClientKind]

/**
 * Resolved backend endpoint — what the renderer needs to talk HTTP/WS
 * to the daemon.
 *
 * Most fields come from `amphi server status` JSON output; `token` is
 * read from `runtime.json` directly because the status command
 * intentionally does NOT print it because users may share status output in
 * bug reports.
 */
interface BackendEndpointFields {
  baseUrl: string
  /** Reported by `GET /version` (or runtime.json on a v2 daemon). */
  version: string | null
  /** ISO 8601 timestamp — drives uptime read-out in gateway settings. */
  startedAt: string | null
  /** WebSocket endpoint path (e.g. '/ws'). Consumed in M4. Null on
   *  legacy v1 daemons. */
  wsPath: string | null
  /** Absolute path to the daemon's `runtime.json`, as reported by
   *  `amphi server status` → `runtime_file`. The bearer token is read
   *  from this exact path (the daemon chooses the dir — we don't guess). */
  runtimeFile: string | null
  /** Absolute path of the daemon's structured log, as the daemon itself
   *  reported it (runtime.json / status `log_file`). Null when file logging
   *  is degraded or the daemon predates the field — "Open Logs" then falls
   *  back to guessing beside `runtimeFile`. */
  logFile: string | null
  /** This GUI process's stable `X-Client-Id` (see `guiClientId`). Injected
   *  by `PythonClient._adoptEndpoint` so the renderer can put it on the WS
   *  `hello` frame — without it the daemon never registers the chat
   *  connection in `GET /api/gateway/clients`. Optional: a legacy/no-id
   *  path degrades to the previous "not listed" behavior. */
  clientId?: string
}

/**
 * Unverified endpoint assembled during discovery. It never crosses the IPC
 * boundary: a missing token is a discovery/auth failure, not a usable backend.
 */
export interface BackendEndpointCandidate extends BackendEndpointFields {
  /** Null when runtime.json is unreadable, stale, or predates bearer auth. */
  token: string | null
}

/**
 * Authenticated endpoint exposed to the renderer.
 *
 * PythonClient only constructs this after the bearer token has successfully
 * called `/api/gateway/info`, so every published endpoint is usable for both
 * REST and the WebSocket hello handshake.
 */
export interface BackendEndpoint extends BackendEndpointFields {
  token: string
}

/**
 * Status JSON shape from `amphi server status`.
 *
 * Three discriminated variants emitted by `amphi_cli._server`:
 *   - `running`  — typical case
 *   - `stopped`  — no registration / never started
 *   - `stale`    — registration exists but daemon dead (crashed)
 *
 * M1-additional fields on the `running` variant (`version`, `ws_path`,
 * `lock_file`, `token_set`) are OPTIONAL on the type so a v1
 * daemon's reduced output still parses. The actual bearer token is NOT
 * in this payload — read it from runtime.json (see `runtime-file.ts`).
 */
export type StatusJson =
  | {
      status: typeof StatusKind.Running
      host: string
      port: number
      base_url: string
      pid: number
      started_at: string
      runtime_file: string
      // M1 additions — all optional for v1 backward compatibility.
      version?: string | null
      ws_path?: string | null
      lock_file?: string | null
      token_set?: boolean
      log_file?: string | null
    }
  | {
      status: typeof StatusKind.Stopped
      runtime_file: string
    }
  | {
      status: typeof StatusKind.Stale
      registration: { host: string; port: number; pid: number; started_at: string }
      runtime_file: string
      note: string
    }

/** Snapshot returned to renderer via `window.api.backend.snapshot()`. */
export interface BackendSnapshot {
  state: BackendState
  endpoint: BackendEndpoint | null
  /** Monotonic within the Electron process. Auth-failure refresh requests use
   *  this as a compare-and-swap guard so a late 401 from endpoint A cannot
   *  retire an already authenticated endpoint B. */
  endpointEpoch?: number
  /** Last error message if state is `unavailable` or `unhealthy`. */
  lastError: string | null
  /**
   * Verdict of comparing the packaged `requiredBackendVersion` against the
   * adopted daemon's version. `null` = not evaluated, which happens only in a
   * development build with no generated release manifest — packaged builds
   * always carry one (the reader throws otherwise).
   */
  compatibility: BackendCompatibility | null
}

// ───── Gateway endpoint response shapes ──────────────────────────────────
//
// These mirror the daemon's `/api/gateway/*` responses verbatim. Owned here
// (rather than amphi-client.ts) so both main-process IPC handlers and the
// renderer's amphi-client can import without cross-layer coupling.

/** No-auth liveness probe response. */
export interface GatewayHealthResponse {
  status: 'ok'
  version: string
  started_at: string
}

/**
 * Live agent-activity snapshot returned by GET /api/agent/status.
 *
 * Deliberately just a boolean — the daemon exposes no count, and the update
 * flow only needs "is it safe to restart right now?".
 */
export interface AgentStatusResponse {
  running: boolean
}

/** Daemon metadata returned by GET /api/gateway/info. */
export interface GatewayInfoResponse {
  pid: number
  host: string
  port: number
  version: string
  started_at: string
  uptime_seconds: number
  ws_path: string
  connected_clients_count: number
}

/** One connected client as returned by GET /api/gateway/clients. */
export interface ClientInfoResponse {
  client_id: string
  client_type: string
  /** Unix epoch seconds (float). */
  connected_at: number
  /** Unix epoch seconds (float). */
  last_seen: number
  user_agent: string | null
}

/**
 * `amphi server autostart status` output.
 *
 * In raw CLI output, `enabled` means the daemon login item is effective, not
 * merely registered (on Windows this includes StartupApproved). Electron
 * later reuses the shape for the combined daemon + tray state and preserves
 * the raw value as `daemon_enabled`.
 * `active` = launchd reports the JOB as loaded — **not** that the daemon
 * process is alive. The two diverge right after a stop, so never render
 * `active` as "Gateway running"; that answer comes from `BackendState`.
 */
export interface AutostartStatusJson {
  manager: string
  supported: boolean
  /** Raw CLI: effective daemon item. Electron-augmented result: true only when
   *  both the daemon and Electron tray login items are effective. */
  enabled: boolean
  active: boolean | null
  definition: string | null
  detail: string | null
  /** Component-level fields are added by Electron after reading the daemon's
   *  CLI status. They remain optional for CLI-only callers and unsupported
   *  platforms. */
  daemon_enabled?: boolean
  tray_registered?: boolean
  tray_enabled?: boolean
  tray_requires_approval?: boolean
  tray_detail?: string | null
}

/** IPC-friendly result for the autostart channels — same shape as getClients. */
export type AutostartResult =
  | { ok: true; status: AutostartStatusJson }
  | { ok: false; reason: string }

/** 202 body returned by POST /api/gateway/shutdown. */
export interface ShutdownResponse {
  shutting_down: boolean
  delay_seconds: number
}

/**
 * IPC-friendly result for backend:getClients. Errors are surfaced as
 * { ok: false, reason } so renderer code stays branchless on rejections
 * (consistent with backend:openLogs shape).
 */
export type GetClientsResult =
  | { ok: true; clients: ClientInfoResponse[] }
  | { ok: false; reason: string }
