/**
 * Read the Bridgic Agent daemon's runtime registration file.
 *
 * Path: `~/<BACKEND_RUNTIME_DIR_REL>/<BACKEND_RUNTIME_FILE_NAME>`
 * (e.g. `~/.bridgic/AmphiAgent/runtime.json`).
 *
 * The file is written by the daemon at startup with 0600 permissions
 * because it embeds the bearer token used for /api/* authentication. We
 * read it from Electron main on demand — never cache the parsed result,
 * because the daemon can restart and rotate the token while we're
 * running (rotation = file rewrite + new token).
 *
 * Schema reference: `ServerInstance` in `amphi_service.server._manager`. v1 files
 * (no M1 fields) parse cleanly via defaults.
 *
 * Why a dedicated module rather than extending `path-resolver.ts`?
 * Resolver finds the CLI BINARY (one-shot, cacheable, never changes
 * mid-session). This reads MUTABLE daemon state. Different lifecycles
 * → different files.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BACKEND_RUNTIME_DIR_REL,
  BACKEND_RUNTIME_FILE_NAME,
} from '../../shared/app-meta'
import { mainLog } from '../logger'
import {
  StatusKind,
  type BackendEndpoint,
  type BackendEndpointCandidate,
  type StatusJson,
} from './types'

/**
 * Parsed view of `runtime.json`. All M1-additional fields are nullable
 * so a v1 file (or a corrupt-but-partially-parseable file) still yields
 * a useful object.
 */
export interface RuntimeFile {
  host: string
  port: number
  pid: number
  startedAt: string
  /** Bearer token for /api/* auth. Null on a v1 file or token-less daemon. */
  token: string | null
  /** Absolute path to the daemon's single-instance lockfile. */
  lockFile: string | null
  /** WebSocket endpoint path (default '/ws' on v2; null on v1). */
  wsPath: string | null
  /** Daemon package version. */
  version: string | null
  /** Where the daemon writes its structured log. Null on older daemons or
   *  when the daemon's file logging is degraded. */
  logFile: string | null
}

/** Default absolute path to runtime.json. */
export function runtimeFilePath(): string {
  return path.join(os.homedir(), BACKEND_RUNTIME_DIR_REL, BACKEND_RUNTIME_FILE_NAME)
}

/**
 * Read and parse runtime.json. Returns `null` when:
 *  - the file does not exist (daemon not running)
 *  - the file is unreadable (permissions, race with rotation, etc.)
 *  - the JSON is malformed or missing required v1 fields
 *
 * Never throws — callers (PythonClient) treat `null` as "no info, fall
 * back to whatever the status command says".
 */
export function readRuntimeFile(filePath: string = runtimeFilePath()): RuntimeFile | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    // ENOENT is the common "daemon not running" case, so it stays at debug and
    // is therefore DEV-ONLY (prod files log warn and above — see logger.ts).
    // The path travels with it because `filePath` can come from CLI stdout
    // rather than our own resolver, and a wrong path there is otherwise
    // indistinguishable from a stopped daemon. Production sees the same path
    // through PythonClient's adoption error instead. Other errors always warn.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      mainLog.debug(`[runtime-file] absent: ${filePath}`)
    } else {
      mainLog.warn('[runtime-file] read failed', err)
    }
    return null
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    mainLog.warn('[runtime-file] JSON parse failed', err)
    return null
  }

  // v1 required fields. Anything missing → bail.
  const host = typeof parsed['host'] === 'string' ? (parsed['host'] as string) : null
  const port = typeof parsed['port'] === 'number' ? (parsed['port'] as number) : null
  const pid = typeof parsed['pid'] === 'number' ? (parsed['pid'] as number) : null
  const startedAt = typeof parsed['started_at'] === 'string' ? (parsed['started_at'] as string) : null
  if (!host || port === null || pid === null || !startedAt) {
    mainLog.warn('[runtime-file] missing v1 required fields', { host, port, pid, startedAt })
    return null
  }

  // M1 optional fields. JSON snake_case → TS camelCase mapping happens here.
  return {
    host,
    port,
    pid,
    startedAt,
    token: optStr(parsed['token']),
    lockFile: optStr(parsed['lock_file']),
    wsPath: optStr(parsed['ws_path']),
    version: optStr(parsed['version']),
    logFile: optStr(parsed['log_file']),
  }
}

/** Coerce a JSON value to `string | null`; treats `''` as null too. */
function optStr(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return v
}

/**
 * True when `runtime.json` now carries a token different from the one the
 * live endpoint is using — i.e. the daemon restarted and rotated its token.
 *
 * Used by the health probe: `/api/gateway/health` is PUBLIC, so a restarted
 * daemon answers it with 200 just like the old one — the probe alone can't
 * tell "same daemon" from "new daemon, new token". Comparing the on-disk
 * token catches the rotation so the client can re-adopt before every
 * `/api/*` call + WS `hello` 401/4401s against the stale token.
 *
 * A null/absent runtime token is NOT treated as a rotation: that's the
 * "daemon gone / file mid-rewrite" case, which the probe's failure path
 * (re-discover) already handles — we don't want to drop a good token here.
 */
export function tokenRotated(current: BackendEndpoint, runtime: RuntimeFile | null): boolean {
  return runtime?.token != null && runtime.token !== current.token
}

/**
 * Build a {@link BackendEndpointCandidate} from `amphi server status` output
 * enriched with whatever runtime.json carries.
 *
 * `runtime` may be null (file missing or unparseable) — in that case
 * we use only what status gave us. Token and wsPath fall back to null;
 * version falls back to whatever status reported (v2 status carries it).
 *
 * Cross-check: runtime fields are trusted only when host/port/pid all
 * match the status snapshot. This guards against a brief race where
 * the daemon restarted between the two reads — we don't want to attach
 * the new daemon's token to the previous daemon's snapshot.
 *
 * Exported pure function so it's unit-testable without spinning up
 * PythonClient.
 */
export function buildEndpoint(
  status: Extract<StatusJson, { status: typeof StatusKind.Running }>,
  runtime: RuntimeFile | null,
): BackendEndpointCandidate {
  const sameDaemon =
    runtime !== null &&
    runtime.host === status.host &&
    runtime.port === status.port &&
    runtime.pid === status.pid &&
    runtime.startedAt === status.started_at

  const fromRuntime = sameDaemon ? runtime : null

  return {
    baseUrl: status.base_url,
    token: fromRuntime?.token ?? null,
    version: fromRuntime?.version ?? status.version ?? null,
    startedAt: status.started_at,
    wsPath: fromRuntime?.wsPath ?? status.ws_path ?? null,
    runtimeFile: status.runtime_file,
    logFile: fromRuntime?.logFile ?? status.log_file ?? null,
  }
}
