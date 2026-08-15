/**
 * PythonClient — Electron-side facade for the Bridgic Agent daemon.
 *
 * Key invariants:
 *
 *   - Does NOT hold a ChildProcess reference. The daemon is managed by
 *     the user / launchd / `amphi server start` subprocess. Electron is
 *     a client, never the owner of the daemon's lifetime.
 *
 *   - On Electron `before-quit`, `stop()` only tears down OUR local
 *     state (timers, listeners). It never invokes `amphi server stop`.
 *
 *   - State transitions broadcast via the `onState` event so renderer
 *     atoms and IPC subscribers stay in sync without polling.
 *
 *   - One singleton per process — created and accessed via the module's
 *     default export from `./index.ts`.
 *
 * State machine (Phase 2 minimal — health-check loop arrives later):
 *
 *   idle → discovering → ready                ← happy path (daemon already up)
 *                     → spawning → ready      ← cold-start, CLI handles wait-for-ready
 *                                → unavailable ← CLI start failed; user must intervene
 */
import { EventEmitter } from 'node:events'
import { mainLog } from '../logger'
import {
  AUTH_HEADER_NAME,
  CLIENT_ID_HEADER,
  CLIENT_TYPE_HEADER,
  GATEWAY_API_PATHS,
} from '../../shared/app-meta'
import {
  cliAutostartDisable,
  cliAutostartEnable,
  cliRestart,
  cliStart,
  cliStatus,
  cliStop,
} from './cli'
import { BackendBinaryMissing } from './path-resolver'
import {
  buildEndpoint,
  readRuntimeFile,
  runtimeFilePath,
  tokenRotated,
  type RuntimeFile,
} from './runtime-file'
import { guiClientId } from '../gui-client-id'
import { readReleaseManifest } from '../release-manifest'
import {
  CompatibilityState,
  compareBackendVersion,
  describeIncompatibility,
  isCompatible,
} from './compatibility'
import {
  BackendState,
  ClientKind,
  StatusKind,
  type BackendCompatibility,
  type BackendEndpoint,
  type BackendEndpointCandidate,
  type BackendSnapshot,
  type GatewayInfoResponse,
  type StatusJson,
} from './types'

/** Interval for the periodic `/api/gateway/health` probe once `ready`. */
const HEALTH_CHECK_INTERVAL_MS = 30_000

/** Timeout for a single health fetch. */
const HEALTH_PROBE_TIMEOUT_MS = 2_000

/**
 * Keep a previously authenticated endpoint published across one short local
 * stall. The daemon and Electron can both remain healthy while the local
 * response path takes slightly longer than the 2s probe timeout to answer;
 * retiring the endpoint immediately would fail every active WebSocket turn.
 */
const HEALTH_CONNECTION_RETRY_DELAY_MS = 5_000

/** Total wall-clock budget for one runtime/status adoption transaction. */
const ADOPTION_TOTAL_TIMEOUT_MS = 2_000

/**
 * runtime.json is atomically replaced, but a daemon restart still has a short
 * clear -> republish window. Keep adoption bounded while covering that window.
 */
const ADOPTION_RETRY_DELAYS_MS = [0, 50, 100, 200, 400, 500, 500] as const

/** Fallback when runtime publication lands after the immediate adoption
 * window. This loop is discovery-only and never starts a daemon. */
const DISCOVERY_RECOVERY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const

type RunningStatus = Extract<StatusJson, { status: typeof StatusKind.Running }>
type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>
type AdoptionVerification =
  | { kind: 'adopted' }
  | { kind: 'auth-rejected' | 'retryable' | 'terminal'; error: string }
  | { kind: 'cancelled' }
type HealthFailureKind = 'auth' | 'connection' | 'process' | 'protocol'
interface LifecycleInflight<T> {
  lifecycleEpoch: number
  promise: Promise<T>
}

class HealthProbeFailure extends Error {
  constructor(
    readonly kind: HealthFailureKind,
    message: string,
  ) {
    super(message)
    this.name = 'HealthProbeFailure'
  }
}

export interface PythonClientDependencies {
  cliStatus: typeof cliStatus
  cliStart: typeof cliStart
  cliRestart: typeof cliRestart
  cliStop: typeof cliStop
  cliAutostartEnable: typeof cliAutostartEnable
  cliAutostartDisable: typeof cliAutostartDisable
  readRuntimeFile: typeof readRuntimeFile
  runtimeFilePath: typeof runtimeFilePath
  guiClientId: typeof guiClientId
  readReleaseManifest: typeof readReleaseManifest
  fetch: FetchFunction
  sleep: (milliseconds: number) => Promise<void>
  now: () => number
}

const DEFAULT_DEPENDENCIES: PythonClientDependencies = {
  cliStatus,
  cliStart,
  cliRestart,
  cliStop,
  cliAutostartEnable,
  cliAutostartDisable,
  readRuntimeFile,
  runtimeFilePath,
  guiClientId,
  readReleaseManifest,
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
}

export class PythonClient extends EventEmitter {
  private readonly _deps: PythonClientDependencies
  private _state: BackendState = BackendState.Idle
  private _endpoint: BackendEndpoint | null = null
  private _lastError: string | null = null
  private _healthTimer: NodeJS.Timeout | null = null
  private _discoveryRecoveryTimer: NodeJS.Timeout | null = null
  private _discoveryRecoveryAttempt = 0
  private _startInflight: LifecycleInflight<void> | null = null
  private _refreshInflight: LifecycleInflight<BackendSnapshot> | null = null
  private _stopInflight: LifecycleInflight<boolean> | null = null
  private _restartInflight: LifecycleInflight<void> | null = null
  private _autostartInflight:
    | (LifecycleInflight<boolean> & { enabled: boolean })
    | null = null
  /** Lifecycle whose explicit control command currently forbids cliStart. */
  private _spawnBlockedLifecycleEpoch: number | null = null
  /** Serializes lifecycle commands and adjacent login-autostart writes. */
  private _cliControlTail: Promise<void> = Promise.resolve()
  /**
   * Last runtime.json path we actually read and authenticated against, seeded
   * with our own resolver. Survives endpoint retirement so refresh keeps using
   * a CLI-provided path once one has proven itself.
   *
   * Written only after a read succeeds. A path the CLI merely *reported* is
   * used directly where it arrives and never cached before it opens: caching
   * it unread turned a single unreadable registration into a permanent outage,
   * since every later discovery reused the bad path and only an app restart
   * reseeded the hint.
   */
  private _runtimeFileHint: string
  /** Last adoption failure written to the log, for deduplication only. Cleared
   *  on a successful adoption so a recurrence is reported again. */
  private _lastLoggedAdoptionError: string | null = null
  /** Verdict for the currently adopted endpoint. `null` = not evaluated (dev). */
  private _compatibility: BackendCompatibility | null = null
  /**
   * Bumped on every adoption. A restarted daemon comes back on the SAME
   * host:port, so comparing `baseUrl` cannot tell one endpoint from the next —
   * an in-flight `_fetchVersion` against the daemon we just replaced would pass
   * that check and overwrite the new daemon's version with the old one's.
   */
  private _endpointEpoch = 0
  /** Bumped by every stop()/stopDaemon(). An in-flight _runStart snapshots it
   *  on entry and re-checks before spawning — see the teardown guard there. */
  private _lifecycleEpoch = 0
  /**
   * Single-writer guard for discovery/adoption. A newer start/refresh/stop
   * invalidates every older async probe before it can publish an endpoint.
   */
  private _adoptionEpoch = 0

  constructor(dependencies: Partial<PythonClientDependencies> = {}) {
    super()
    this._deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
    this._runtimeFileHint = this._deps.runtimeFilePath()
  }

  /**
   * Idempotent start. Resolves once we've reached a terminal state for
   * this attempt (`ready` or `unavailable`). Multiple concurrent callers
   * await the same in-flight promise.
   */
  async start(): Promise<void> {
    const lifecycleEpoch = this._lifecycleEpoch
    if (this._startInflight?.lifecycleEpoch === lifecycleEpoch) {
      return this._startInflight.promise
    }
    // Foregrounding an already-running background-login instance may call
    // start() again. Ready is already the terminal success state; rediscovery
    // here would retire the live endpoint and fail active WebSocket turns.
    if (this._state === BackendState.Ready && this._endpoint !== null) return
    const promise: Promise<void> = this._runStart(lifecycleEpoch).finally(() => {
      if (this._startInflight?.promise === promise) this._startInflight = null
    })
    this._startInflight = { lifecycleEpoch, promise }
    return promise
  }

  private async _runStart(lifecycleEpoch: number): Promise<void> {
    if (
      lifecycleEpoch !== this._lifecycleEpoch ||
      this._spawnBlockedLifecycleEpoch === lifecycleEpoch
    ) {
      mainLog.info('[python-client] start ignored while a process-control command is active')
      return
    }
    this._cancelDiscoveryRecovery(true)
    const adoptionEpoch = ++this._adoptionEpoch
    this._clearHealthTimer()
    this._retireEndpoint()
    this._lastError = null
    this._setState(BackendState.Discovering)

    // Fast path first — see _tryAdoptRunningDaemon for why this exists.
    if (await this._tryAdoptRunningDaemon(adoptionEpoch, lifecycleEpoch)) {
      if (this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) this._settleAfterAdopt()
      return
    }
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return

    let status: StatusJson | null
    try {
      status = await this._deps.cliStatus()
    } catch (err) {
      if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return
      // Unexpected CLI failure (binary corrupt, Python not installed).
      this._lastError = errorMessage(err)
      this._setState(BackendState.Unavailable)
      return
    }
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return

    // Path A: CLI binary missing entirely.
    if (status === null) {
      this._lastError = 'amphi CLI binary not found — see logs for searched paths'
      this._setState(BackendState.Unavailable)
      return
    }

    // Path B: daemon running, just adopt its endpoint.
    if (status.status === StatusKind.Running) {
      if (await this._tryAdoptStatus(status, adoptionEpoch, lifecycleEpoch)) {
        if (this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) this._settleAfterAdopt()
      } else if (this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) {
        this._lastError ??= 'Gateway is running but its authenticated endpoint is unavailable'
        this._setState(BackendState.Unavailable)
      }
      return
    }

    // Path C: daemon stopped or stale — try to start it.
    //
    // Teardown guard: if stop()/stopDaemon() landed while we were probing
    // above (a self-heal start racing a user stop / full quit), spawning now
    // would resurrect the daemon that was just torn down — the same
    // port-alive-after-quit bug through a different door. Bail; the stop
    // path owns the terminal state.
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) {
      mainLog.info('[python-client] start aborted — teardown began during discovery')
      return
    }
    this._setState(BackendState.Spawning)
    let ok: boolean | null
    try {
      ok = await this._queueCliControl(async () => {
        // A stop/restart intent may have arrived while this start was waiting
        // behind another lifecycle operation.
        if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return null
        return this._deps.cliStart()
      })
    } catch (err) {
      if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return
      this._lastError = `amphi server start failed: ${errorMessage(err)}`
      this._setState(BackendState.Unavailable)
      return
    }
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return
    if (ok !== true) {
      this._lastError = 'amphi server start failed — see backend log'
      this._setState(BackendState.Unavailable)
      return
    }

    // CLI's `start` blocks until ready, so a
    // follow-up status call should now be `running`. If not, treat
    // as `unavailable` — something's racing or broken.
    let after: StatusJson | null
    try {
      after = await this._deps.cliStatus()
    } catch (err) {
      if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return
      this._lastError = err instanceof Error ? err.message : String(err)
      this._setState(BackendState.Unavailable)
      return
    }
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return
    if (after === null || after.status !== StatusKind.Running) {
      this._lastError = 'amphi server reported started but status still not running'
      this._setState(BackendState.Unavailable)
      return
    }
    if (await this._tryAdoptStatus(after, adoptionEpoch, lifecycleEpoch)) {
      if (this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) this._settleAfterAdopt()
      return
    }
    if (this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) {
      this._lastError ??= 'Gateway started but did not publish a usable bearer token'
      this._setState(BackendState.Unavailable)
    }
  }

  /**
   * Decide the terminal state for a freshly adopted endpoint.
   *
   * Every verified adoption path funnels through here — the runtime.json fast
   * path, the status path, and the post-spawn path. Keeping the terminal-state
   * decision here gives all three the same compatibility and readiness gates.
   *
   * A mismatched daemon must NOT start the health probe: that probe re-discovers
   * and would keep flapping the state while the user is looking at the blocking
   * screen deciding whether to restart.
   */
  private _settleAfterAdopt(): void {
    // Runtime defence for the public invariant expressed by BackendEndpoint's
    // non-null token type. No adoption bug may ever turn the tray green with an
    // endpoint the renderer cannot authenticate against.
    if (!this._endpoint || this._endpoint.token.length === 0) {
      this._clearHealthTimer()
      this._retireEndpoint()
      this._lastError = 'Gateway registration did not provide a usable bearer token'
      this._setState(BackendState.Unavailable)
      return
    }
    if (isCompatible(this._compatibility)) {
      const wasReady = this._state === BackendState.Ready
      this._setState(BackendState.Ready)
      this._startHealthCheck()
      // _setState only emits on a CHANGE. Re-adopting while already ready (the
      // legacy-daemon version backfill, a token rotation) changes the payload
      // but not the state, and subscribers read version/token off that payload.
      if (wasReady) this._emitState()
      return
    }
    if (this._healthTimer) {
      clearInterval(this._healthTimer)
      this._healthTimer = null
    }
    this._lastError = describeIncompatibility(this._compatibility)
    mainLog.warn(`[python-client] blocking on compatibility: ${this._lastError}`)
    const wasIncompatible = this._state === BackendState.Incompatible
    this._setState(BackendState.Incompatible)
    // _setState only emits on a *change*. Re-adopting while already blocked (a
    // different daemon, or the version backfill landing) changes the payload but
    // not the state, so the renderer would keep showing the previous versions.
    if (wasIncompatible) this._emitState()
  }

  /**
   * Recompute the verdict for the current endpoint.
   *
   * Reading the manifest can throw in a packaged build with a broken install
   * (see release-manifest.ts — it fails closed on purpose). Swallowing that here
   * would silently disable the gate, so it becomes its own verdict rather than
   * being folded into `unknown`, which would blame the daemon for our problem.
   */
  private _evaluateCompatibility(): void {
    let expected: string | null = null
    try {
      expected = this._deps.readReleaseManifest()?.requiredBackendVersion ?? null
    } catch (err) {
      mainLog.error('[python-client] release manifest unreadable', err)
      this._compatibility = {
        state: CompatibilityState.ManifestUnavailable,
        detail: err instanceof Error ? err.message : String(err),
      }
      return
    }
    if (expected === null) {
      // Development build with no generated manifest — gate disabled.
      this._compatibility = null
      return
    }
    this._compatibility = compareBackendVersion(expected, this._endpoint?.version ?? null)
  }

  /**
   * Tear down local state. Does NOT stop the daemon. Called from
   * Electron `before-quit`.
   */
  stop(): void {
    this._lifecycleEpoch += 1
    this._adoptionEpoch += 1
    this._clearHealthTimer()
    this._cancelDiscoveryRecovery(true)
    this._retireEndpoint()
    this._setState(BackendState.Idle)
  }

  /**
   * Restart the daemon — graceful stop + start. Only call from
   * explicit user action ("Restart Service" button) or version
   * incompatibility detection. Never from quit/cleanup.
   */
  restart(): Promise<void> {
    if (this._restartInflight?.lifecycleEpoch === this._lifecycleEpoch) {
      return this._restartInflight.promise
    }
    mainLog.info('[python-client] user-initiated restart')
    const supersededStart = this._startInflight?.promise ?? null
    const supersededRefresh = this._refreshInflight?.promise ?? null
    const lifecycleEpoch = this._beginControlIntent(BackendState.Discovering)
    const promise = this._runRestart(
      lifecycleEpoch,
      supersededStart,
      supersededRefresh,
    ).finally(() => {
      if (this._restartInflight?.promise === promise) this._restartInflight = null
    })
    this._restartInflight = { lifecycleEpoch, promise }
    return promise
  }

  private async _runRestart(
    lifecycleEpoch: number,
    supersededStart: Promise<void> | null,
    supersededRefresh: Promise<BackendSnapshot> | null,
  ): Promise<void> {
    let ok: boolean
    try {
      ok = await this._queueCliControl(() => this._deps.cliRestart())
    } catch (err) {
      if (lifecycleEpoch !== this._lifecycleEpoch) return
      const duringControlStart = this._startInflight?.promise ?? null
      const duringControlRefresh = this._refreshInflight?.promise ?? null
      this._invalidateAdoption()
      this._lastError = `amphi server restart failed: ${errorMessage(err)}`
      this._setState(BackendState.Unavailable)
      await Promise.all([
        duringControlStart?.catch(() => undefined),
        duringControlRefresh?.catch(() => undefined),
      ])
      this._releaseControlBlock(lifecycleEpoch)
      return
    }
    if (lifecycleEpoch !== this._lifecycleEpoch) return
    const duringControlStart = this._startInflight?.promise ?? null
    const duringControlRefresh = this._refreshInflight?.promise ?? null
    this._invalidateAdoption()
    if (!ok) {
      this._lastError = 'amphi server restart failed'
      this._setState(BackendState.Unavailable)
      await Promise.all([
        supersededStart?.catch(() => undefined),
        supersededRefresh?.catch(() => undefined),
        duringControlStart?.catch(() => undefined),
        duringControlRefresh?.catch(() => undefined),
      ])
      this._releaseControlBlock(lifecycleEpoch)
      return
    }

    // A refresh may have started after the control intent but before the CLI
    // finished. Invalidate and retire anything it observed from the old process.
    this._setState(BackendState.Discovering)

    // The old discovery promises have already been invalidated. Let their
    // finally handlers clear the public de-duplication slots before starting a
    // fresh adoption of the restarted daemon.
    await Promise.all([
      supersededStart?.catch(() => undefined),
      supersededRefresh?.catch(() => undefined),
      duringControlStart?.catch(() => undefined),
      duringControlRefresh?.catch(() => undefined),
    ])
    if (lifecycleEpoch !== this._lifecycleEpoch) return
    this._releaseControlBlock(lifecycleEpoch)
    await this.start()
  }

  /**
   * Change login autostart through the same single-writer queue as start/stop.
   * The CLI's configure-only contract never changes the live daemon, so this
   * operation must not retire the endpoint, interrupt health checks, or publish
   * a backend state transition. The queue only prevents a registry/plist write
   * from racing an explicit lifecycle command.
   */
  setAutostart(enabled: boolean): Promise<boolean> {
    if (
      this._autostartInflight?.enabled === enabled &&
      this._autostartInflight.lifecycleEpoch === this._lifecycleEpoch
    ) {
      return this._autostartInflight.promise
    }
    const lifecycleEpoch = this._lifecycleEpoch
    const promise = this._runSetAutostart(enabled).finally(() => {
      if (this._autostartInflight?.promise === promise) this._autostartInflight = null
    })
    this._autostartInflight = { enabled, lifecycleEpoch, promise }
    return promise
  }

  private async _runSetAutostart(enabled: boolean): Promise<boolean> {
    try {
      return await this._queueCliControl(() =>
        enabled ? this._deps.cliAutostartEnable() : this._deps.cliAutostartDisable(),
      )
    } catch (err) {
      mainLog.error(
        `[python-client] autostart ${enabled ? 'enable' : 'disable'} failed without changing the gateway`,
        err,
      )
      return false
    }
  }

  /**
   * Re-read and authenticate the currently registered daemon without ever
   * starting one. Intended for auth failures (HTTP 401 / WS 4401) and health
   * recovery. Concurrent callers share one in-flight refresh.
   */
  refresh(expectedEndpointEpoch?: number): Promise<BackendSnapshot> {
    if (
      expectedEndpointEpoch !== undefined &&
      expectedEndpointEpoch !== this._endpointEpoch
    ) {
      return Promise.resolve(this.snapshot())
    }
    const lifecycleEpoch = this._lifecycleEpoch
    // A stop/restart command owns the process identity until its CLI
    // transaction completes. Re-publishing runtime.json in the middle would
    // briefly turn the tray green against a daemon that is being replaced.
    if (this._spawnBlockedLifecycleEpoch === lifecycleEpoch) {
      return Promise.resolve(this.snapshot())
    }
    if (this._refreshInflight?.lifecycleEpoch === lifecycleEpoch) {
      return this._refreshInflight.promise
    }
    const promise = this._runRefresh(lifecycleEpoch).finally(() => {
      if (this._refreshInflight?.promise === promise) this._refreshInflight = null
    })
    this._refreshInflight = { lifecycleEpoch, promise }
    return promise
  }

  private async _runRefresh(lifecycleEpoch: number): Promise<BackendSnapshot> {
    if (lifecycleEpoch !== this._lifecycleEpoch) return this.snapshot()
    this._cancelDiscoveryRecovery(false)
    const runtimePath = this._endpoint?.runtimeFile ?? this._runtimeFileHint
    const adoptionEpoch = ++this._adoptionEpoch

    this._clearHealthTimer()
    // Keep the last authenticated endpoint published while side-probing the
    // replacement. Renderer business UI is blocked by `Unhealthy`, but an
    // unchanged WS can continue carrying an active turn. We only retire on a
    // failed refresh or atomically replace it after successful authentication.
    this._lastError = null
    this._setState(BackendState.Unhealthy)

    if (await this._tryAdoptRuntimeFile(runtimePath, adoptionEpoch, lifecycleEpoch)) {
      if (this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) this._settleAfterAdopt()
      return this.snapshot()
    }
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return this.snapshot()

    this._retireEndpoint()
    this._lastError ??= 'No authenticated gateway endpoint is available from runtime.json'
    this._setState(BackendState.Unavailable)
    this._scheduleDiscoveryRecovery(lifecycleEpoch)
    return this.snapshot()
  }

  snapshot(): BackendSnapshot {
    return {
      state: this._state,
      endpoint: this._endpoint,
      endpointEpoch: this._endpointEpoch,
      lastError: this._lastError,
      compatibility: this._compatibility,
    }
  }

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onState(listener: (snapshot: BackendSnapshot) => void): () => void {
    this.on('state', listener)
    return () => this.off('state', listener)
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * Adopt an already-running daemon without spawning the CLI. `false` = caller
   * must fall through to the authoritative `cliStatus()` path.
   *
   * Why: `cliStatus()` execFile's the `amphi` binary. Even with the current
   * onedir bundle, paying a full signed process start just to ask "is the daemon
   * up?" makes the GUI sit on
   * "Connecting to gateway…" at every cold start — including the common case where a
   * launchd-managed daemon has been serving all along.
   *
   * runtime.json already carries everything an endpoint needs, so read it and
   * authenticate a direct `/api/gateway/info` probe. It is only ever a HINT: a
   * stale file or stale token fails the probe and we fall through, so this can
   * never adopt an unusable endpoint. Never throws.
   */
  private async _tryAdoptRunningDaemon(
    adoptionEpoch: number,
    lifecycleEpoch: number,
  ): Promise<boolean> {
    const adopted = await this._tryAdoptRuntimeFile(
      this._runtimeFileHint,
      adoptionEpoch,
      lifecycleEpoch,
    )
    if (adopted) {
      mainLog.info('[python-client] adopted authenticated daemon from runtime.json')
    }
    return adopted
  }

  /**
   * Adopt a CLI status only when a separately-read runtime registration still
   * describes that exact process. Retrying closes the status/runtime TOCTOU
   * window without ever publishing the intermediate token-less candidate.
   */
  private async _tryAdoptStatus(
    status: RunningStatus,
    adoptionEpoch: number,
    lifecycleEpoch: number,
  ): Promise<boolean> {
    const deadline = this._deps.now() + ADOPTION_TOTAL_TIMEOUT_MS
    let authRejectedRegistration: RuntimeFile | null = null
    let authRejectedError: string | null = null
    for (const delay of ADOPTION_RETRY_DELAYS_MS) {
      if (!(await this._waitForAdoption(delay, deadline, adoptionEpoch, lifecycleEpoch))) {
        return false
      }
      const runtime = this._deps.readRuntimeFile(status.runtime_file)
      if (runtime === null) {
        this._recordAdoptionError(
          // The path is part of the message because the CLI supplied it: when
          // its stdout decoding goes wrong the path itself is the defect, and
          // showing it turns an opaque "unreadable" into an obvious one.
          `Gateway runtime registration is missing or unreadable: ${status.runtime_file}`,
          adoptionEpoch,
          lifecycleEpoch,
        )
        continue
      }
      // Reading it is what makes the path worth remembering: the daemon owns
      // its on-disk layout, so a CLI-reported path that opens beats our own
      // resolver's guess for every later discovery. Authentication may still
      // fail below — that says something about the token, not the path.
      if (this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) {
        this._runtimeFileHint = status.runtime_file
      }
      if (
        authRejectedRegistration !== null &&
        sameRegistration(authRejectedRegistration, runtime)
      ) {
        this._recordAdoptionError(
          authRejectedError ?? 'Gateway rejected the published bearer token',
          adoptionEpoch,
          lifecycleEpoch,
        )
        continue
      }
      authRejectedRegistration = null
      authRejectedError = null
      const candidate = buildEndpoint(status, runtime)
      if (candidate.token === null) {
        this._recordAdoptionError(
          sameDaemon(status, runtime)
            ? 'Gateway runtime registration has no bearer token'
            : 'Gateway status and runtime registration identify different processes',
          adoptionEpoch,
          lifecycleEpoch,
        )
        continue
      }
      const verification = await this._verifyAndPublish(
        candidate,
        runtime,
        status.runtime_file,
        deadline,
        adoptionEpoch,
        lifecycleEpoch,
      )
      if (verification.kind === 'adopted') return true
      if (verification.kind === 'cancelled') return false
      this._recordAdoptionError(verification.error, adoptionEpoch, lifecycleEpoch)
      if (verification.kind === 'auth-rejected') {
        // A replacement daemon can accept connections just before its atomic
        // runtime.json publication lands. Do not keep hammering the rejected
        // token; wait within the bounded adoption window for registration to
        // change, then authenticate the new snapshot.
        authRejectedRegistration = runtime
        authRejectedError = verification.error
        continue
      }
      if (verification.kind === 'terminal') return false
    }
    return false
  }

  /**
   * Runtime-first discovery used at app boot and for recovery. `/info` is both
   * the liveness check and proof that the token belongs to the live daemon.
   */
  private async _tryAdoptRuntimeFile(
    filePath: string,
    adoptionEpoch: number,
    lifecycleEpoch: number,
  ): Promise<boolean> {
    const deadline = this._deps.now() + ADOPTION_TOTAL_TIMEOUT_MS
    let authRejectedRegistration: RuntimeFile | null = null
    let authRejectedError: string | null = null
    for (const delay of ADOPTION_RETRY_DELAYS_MS) {
      if (!(await this._waitForAdoption(delay, deadline, adoptionEpoch, lifecycleEpoch))) {
        return false
      }
      const runtime = this._deps.readRuntimeFile(filePath)
      if (runtime === null) {
        this._recordAdoptionError(
          `Gateway runtime registration is missing or unreadable: ${filePath}`,
          adoptionEpoch,
          lifecycleEpoch,
        )
        continue
      }
      if (
        authRejectedRegistration !== null &&
        sameRegistration(authRejectedRegistration, runtime)
      ) {
        this._recordAdoptionError(
          authRejectedError ?? 'Gateway rejected the published bearer token',
          adoptionEpoch,
          lifecycleEpoch,
        )
        continue
      }
      authRejectedRegistration = null
      authRejectedError = null
      const status: RunningStatus = {
        status: StatusKind.Running,
        host: runtime.host,
        port: runtime.port,
        base_url: runtimeBaseUrl(runtime),
        pid: runtime.pid,
        started_at: runtime.startedAt,
        runtime_file: filePath,
        version: runtime.version,
        ws_path: runtime.wsPath,
      }
      const candidate = buildEndpoint(status, runtime)
      if (candidate.token === null) {
        this._recordAdoptionError(
          'Gateway runtime registration has no bearer token',
          adoptionEpoch,
          lifecycleEpoch,
        )
        continue
      }
      const verification = await this._verifyAndPublish(
        candidate,
        runtime,
        filePath,
        deadline,
        adoptionEpoch,
        lifecycleEpoch,
      )
      if (verification.kind === 'adopted') return true
      if (verification.kind === 'cancelled') return false
      this._recordAdoptionError(verification.error, adoptionEpoch, lifecycleEpoch)
      if (verification.kind === 'auth-rejected') {
        authRejectedRegistration = runtime
        authRejectedError = verification.error
        continue
      }
      if (verification.kind === 'terminal') return false
    }
    return false
  }

  private async _verifyAndPublish(
    candidate: BackendEndpointCandidate,
    runtime: RuntimeFile,
    runtimePath: string,
    deadline: number,
    adoptionEpoch: number,
    lifecycleEpoch: number,
  ): Promise<AdoptionVerification> {
    const token = candidate.token
    if (token === null) {
      return { kind: 'terminal', error: 'Gateway runtime registration has no bearer token' }
    }
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return { kind: 'cancelled' }
    const remaining = deadline - this._deps.now()
    if (remaining <= 0) {
      return { kind: 'retryable', error: 'Gateway authentication probe timed out' }
    }
    const clientId = this._deps.guiClientId()
    let info: GatewayInfoResponse
    try {
      const response = await this._deps.fetch(`${candidate.baseUrl}${GATEWAY_API_PATHS.Info}`, {
        headers: {
          [AUTH_HEADER_NAME]: `Bearer ${token}`,
          [CLIENT_ID_HEADER]: clientId,
          [CLIENT_TYPE_HEADER]: ClientKind.Gui,
        },
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
      })
      if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return { kind: 'cancelled' }
      if (this._deps.now() >= deadline) {
        return { kind: 'retryable', error: 'Gateway authentication probe timed out' }
      }
      if (!response.ok) {
        return {
          kind:
            response.status === 401 || response.status === 403
              ? 'auth-rejected'
              : 'retryable',
          error: `Gateway authentication probe returned HTTP ${response.status}`,
        }
      }
      const parsed: unknown = await response.json()
      if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return { kind: 'cancelled' }
      if (this._deps.now() >= deadline) {
        return { kind: 'retryable', error: 'Gateway authentication probe timed out' }
      }
      if (!isGatewayInfoResponse(parsed)) {
        return {
          kind: 'terminal',
          error: 'Gateway authentication probe returned invalid metadata',
        }
      }
      info = parsed
    } catch (err) {
      if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return { kind: 'cancelled' }
      return {
        kind: 'retryable',
        error: `Gateway authentication probe failed: ${errorMessage(err)}`,
      }
    }

    if (!sameRuntimeAndInfo(runtime, info)) {
      return {
        kind: 'retryable',
        error: 'Gateway runtime registration does not match the authenticated process',
      }
    }

    // Close the other half of the race: runtime.json may have been replaced
    // after /info succeeded. Never publish unless the registration is stable.
    const current = this._deps.readRuntimeFile(runtimePath)
    if (!sameRegistration(runtime, current)) {
      return {
        kind: 'retryable',
        error: 'Gateway runtime registration changed during authentication',
      }
    }
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return { kind: 'cancelled' }

    this._endpoint = {
      ...candidate,
      token,
      version: nonEmptyString(info.version) ?? candidate.version,
      clientId,
    }
    this._cancelDiscoveryRecovery(true)
    this._runtimeFileHint = runtimePath
    this._lastError = null
    this._lastLoggedAdoptionError = null
    this._endpointEpoch += 1
    this._evaluateCompatibility()
    if (this._endpoint.version === null) void this._fetchVersion()
    return { kind: 'adopted' }
  }

  private async _waitForAdoption(
    delay: number,
    deadline: number,
    adoptionEpoch: number,
    lifecycleEpoch: number,
  ): Promise<boolean> {
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return false
    const remaining = deadline - this._deps.now()
    if (remaining <= 0) return false
    if (delay > 0) await this._deps.sleep(Math.min(delay, remaining))
    return (
      this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch) &&
      this._deps.now() < deadline
    )
  }

  private _recordAdoptionError(
    error: string,
    adoptionEpoch: number,
    lifecycleEpoch: number,
  ): void {
    if (!this._isAdoptionCurrent(adoptionEpoch, lifecycleEpoch)) return
    // Adoption failures used to reach `_lastError` only, so a gateway the user
    // could see running in their terminal produced a silent main.log.
    //
    // Deduplicated on the message, and NOT against `_lastError` (which every
    // start/refresh resets): one adoption burns 7 retries, and a stopped daemon
    // keeps `_scheduleDiscoveryRecovery` re-refreshing at 30s forever. Logging
    // each round would push ~14 lines/minute through a 2 MB prod cap and rotate
    // away the very history this line exists to preserve.
    if (error !== this._lastLoggedAdoptionError) {
      mainLog.warn(`[python-client] adoption attempt failed: ${error}`)
      this._lastLoggedAdoptionError = error
    }
    this._lastError = error
  }

  private _isAdoptionCurrent(adoptionEpoch: number, lifecycleEpoch: number): boolean {
    return adoptionEpoch === this._adoptionEpoch && lifecycleEpoch === this._lifecycleEpoch
  }

  /**
   * Fetch the daemon version from the public gateway health endpoint and
   * merge it into the current endpoint. Best-effort: failures are logged
   * but don't move the state machine — version is informational.
   *
   * Only called when neither runtime.json nor `amphi server status` gave
   * a version (legacy v1 daemon). The bare `/version` route is retired —
   * `GET /api/gateway/health` returns `{status, version, started_at}`.
   */
  private async _fetchVersion(): Promise<void> {
    if (!this._endpoint) return
    const baseUrl = this._endpoint.baseUrl
    const epoch = this._endpointEpoch
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 3_000)
      const res = await this._deps.fetch(`${baseUrl}${GATEWAY_API_PATHS.Health}`, {
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { version?: string }
      if (this._endpointEpoch === epoch && this._endpoint && body.version) {
        this._endpoint = { ...this._endpoint, version: body.version }
        // The verdict computed during adoption was `unknown` (that is the only
        // reason we are here). Now that a version exists it has to be redone —
        // otherwise a legacy daemon that CAN report a version stays blocked
        // forever, and, worse, a genuinely mismatched one that only answers on
        // /health would sail through as merely "unknown".
        this._evaluateCompatibility()
        this._settleAfterAdopt()
      }
    } catch (err) {
      mainLog.warn('[python-client] version fetch failed (non-fatal)', err)
    }
  }

  /**
   * Stop the daemon via `amphi server stop`. Distinct from `stop()` —
   * `stop()` only tears down OUR local state (timers, listeners) and
   * leaves the daemon running. This sends SIGTERM to the daemon.
   *
   * Only called from explicit user intent (the gateway settings panel
   * "Stop" button). Never from quit/cleanup — that's the shared-daemon
   * lifecycle invariant.
   */
  stopDaemon(): Promise<boolean> {
    if (this._stopInflight?.lifecycleEpoch === this._lifecycleEpoch) {
      return this._stopInflight.promise
    }
    mainLog.info('[python-client] user-initiated stop')
    // The probe timer MUST be cleared before cliStop: while cliStop runs
    // (cold CLI spawn + the backend's 8s graceful drain — 10+ seconds on
    // Windows), the daemon is mid-death, and one failed probe would trigger
    // _probeHealth's self-heal branch (`void start()`) and bring the daemon
    // the user just stopped right back up. The old order (clear after the
    // stop) exposed the entire stop window to that race. The epoch bump
    // additionally aborts any _runStart already in flight before it spawns.
    const lifecycleEpoch = this._beginControlIntent(BackendState.Unhealthy)
    const promise = this._runStopDaemon(lifecycleEpoch).finally(() => {
      if (this._stopInflight?.promise === promise) this._stopInflight = null
    })
    this._stopInflight = { lifecycleEpoch, promise }
    return promise
  }

  private async _runStopDaemon(lifecycleEpoch: number): Promise<boolean> {
    let ok: boolean
    try {
      // Never freshness-skip this command. If cliStart was already entered,
      // the queue guarantees this final stop runs immediately after it.
      ok = await this._queueCliControl(() => this._deps.cliStop())
    } catch (err) {
      if (lifecycleEpoch === this._lifecycleEpoch) {
        const duringControlStart = this._startInflight?.promise ?? null
        const duringControlRefresh = this._refreshInflight?.promise ?? null
        this._invalidateAdoption()
        this._lastError = `amphi server stop failed: ${errorMessage(err)}`
        this._setState(BackendState.Unavailable)
        await Promise.all([
          duringControlStart?.catch(() => undefined),
          duringControlRefresh?.catch(() => undefined),
        ])
        this._releaseControlBlock(lifecycleEpoch)
      }
      return false
    }
    if (lifecycleEpoch !== this._lifecycleEpoch) return ok
    const duringControlStart = this._startInflight?.promise ?? null
    const duringControlRefresh = this._refreshInflight?.promise ?? null
    this._invalidateAdoption()
    if (!ok) {
      // The state still goes to `unavailable` — we are no longer talking to it —
      // but the caller MUST be able to tell "it stopped" from "we gave up on it".
      // The update handler in particular hands over to an installer that
      // force-kills whatever is left, so treating a failed stop as success is
      // exactly the hard-kill this whole path exists to avoid.
      this._lastError = 'amphi server stop failed'
      this._setState(BackendState.Unavailable)
      await Promise.all([
        duringControlStart?.catch(() => undefined),
        duringControlRefresh?.catch(() => undefined),
      ])
      this._releaseControlBlock(lifecycleEpoch)
      return false
    }
    this._lastError = null
    // Unavailable (not Idle) so GatewayBootGate shows the
    // "Gateway not running + [Start Gateway]" card immediately. Idle is the
    // pre-discovery transient state and BootGate renders it as a
    // spinner — leaving the user staring at an indefinite loader.
    // After user-initiated stop, the daemon is genuinely unavailable
    // until they (or another client) start it again.
    this._setState(BackendState.Unavailable)
    await Promise.all([
      duringControlStart?.catch(() => undefined),
      duringControlRefresh?.catch(() => undefined),
    ])
    this._releaseControlBlock(lifecycleEpoch)
    return true
  }

  private _beginControlIntent(nextState: BackendState): number {
    const lifecycleEpoch = ++this._lifecycleEpoch
    this._spawnBlockedLifecycleEpoch = lifecycleEpoch
    this._invalidateAdoption()
    this._lastError = null
    this._setState(nextState)
    return lifecycleEpoch
  }

  private _releaseControlBlock(lifecycleEpoch: number): void {
    if (
      lifecycleEpoch === this._lifecycleEpoch &&
      this._spawnBlockedLifecycleEpoch === lifecycleEpoch
    ) {
      this._spawnBlockedLifecycleEpoch = null
    }
  }

  private _invalidateAdoption(): void {
    this._adoptionEpoch += 1
    this._clearHealthTimer()
    this._cancelDiscoveryRecovery(true)
    this._retireEndpoint()
  }

  private _queueCliControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this._cliControlTail.then(operation, operation)
    this._cliControlTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private _setState(next: BackendState): void {
    if (next === BackendState.Ready && (!this._endpoint || this._endpoint.token.length === 0)) {
      mainLog.error('[python-client] refused invalid ready transition without an authenticated token')
      this._lastError = 'Gateway endpoint is not authenticated'
      next = BackendState.Unavailable
    }
    if (this._state === next) return
    const previous = this._state
    this._state = next
    mainLog.info(`[python-client] state: ${previous} → ${next}`)
    this._emitState()
  }

  private _emitState(): void {
    try {
      this.emit('state', this.snapshot())
    } catch (err) {
      // State observers are notification sinks. A destroyed renderer or a
      // faulty listener must not strand lifecycle locks or abort daemon
      // control after the state transition has already committed.
      mainLog.error('[python-client] state listener failed', err)
    }
  }

  private _startHealthCheck(): void {
    this._clearHealthTimer()
    this._healthTimer = setInterval(() => {
      void this._probeHealth()
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private async _probeHealth(): Promise<void> {
    if (!this._endpoint || this._state !== BackendState.Ready) return
    const endpoint = this._endpoint
    const endpointEpoch = this._endpointEpoch
    const lifecycleEpoch = this._lifecycleEpoch
    const probe = async (): Promise<void> => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS)
      try {
        const res = await this._deps.fetch(`${endpoint.baseUrl}${GATEWAY_API_PATHS.Info}`, {
          headers: {
            [AUTH_HEADER_NAME]: `Bearer ${endpoint.token}`,
            [CLIENT_ID_HEADER]: endpoint.clientId ?? this._deps.guiClientId(),
            [CLIENT_TYPE_HEADER]: ClientKind.Gui,
          },
          signal: ctrl.signal,
        })
        if (res.status === 401 || res.status === 403) {
          throw new HealthProbeFailure('auth', `HTTP ${res.status}`)
        }
        if (!res.ok) throw new HealthProbeFailure('connection', `HTTP ${res.status}`)
        let info: unknown
        try {
          info = await res.json()
        } catch (err) {
          throw new HealthProbeFailure(
            'protocol',
            `invalid gateway metadata: ${errorMessage(err)}`,
          )
        }
        if (!isGatewayInfoResponse(info)) {
          throw new HealthProbeFailure('protocol', 'invalid gateway metadata')
        }
        if (!sameEndpointAndInfo(endpoint, info)) {
          throw new HealthProbeFailure('process', 'gateway process changed')
        }
      } finally {
        clearTimeout(timer)
      }
    }

    let failed = false
    let failure: unknown = undefined
    try {
      await probe()
    } catch (err) {
      failed = true
      failure = err
    }

    if (
      failed &&
      (lifecycleEpoch !== this._lifecycleEpoch ||
        !this._isEndpointCurrent(endpoint, endpointEpoch))
    ) {
      return
    }

    // A connection failure is not yet proof that the authenticated daemon is
    // gone. Give the same endpoint one bounded grace retry without changing
    // state or retiring it, so a short response-path stall cannot
    // tear down active renderer turns. Auth, protocol, and process-identity
    // failures still enter discovery immediately.
    if (
      failed &&
      (failure instanceof HealthProbeFailure ? failure.kind : 'connection') === 'connection'
    ) {
      mainLog.warn(
        '[python-client] health connection probe failed; retrying before endpoint retirement',
        {
          error: errorMessage(failure),
          retryDelayMs: HEALTH_CONNECTION_RETRY_DELAY_MS,
        },
      )
      await this._deps.sleep(HEALTH_CONNECTION_RETRY_DELAY_MS)
      if (
        lifecycleEpoch !== this._lifecycleEpoch ||
        !this._isEndpointCurrent(endpoint, endpointEpoch)
      ) {
        return
      }
      try {
        await probe()
        failed = false
        failure = undefined
        this._lastError = null
      } catch (err) {
        failure = err
      }
    }

    if (failed) {
      // Timer already null = stop()/stopDaemon() tore things down while this
      // probe was in flight — the failure means "we are stopping it", not
      // "it is sick". Never take the self-heal path below: start() would
      // cliStart the daemon the user just stopped right back up (the root
      // cause of port 7421 staying alive after a full quit).
      if (
        lifecycleEpoch !== this._lifecycleEpoch ||
        !this._isEndpointCurrent(endpoint, endpointEpoch)
      ) {
        return
      }
      const kind = failure instanceof HealthProbeFailure ? failure.kind : 'connection'
      this._lastError = errorMessage(failure)
      // Stop the periodic probe before discovery-only recovery. refresh()
      // re-arms it only after a newly authenticated endpoint reaches ready.
      this._clearHealthTimer()
      const recovered = await this.refresh()
      if (kind === 'auth' || kind === 'protocol') return
      if (
        lifecycleEpoch === this._lifecycleEpoch &&
        recovered.state === BackendState.Unavailable
      ) {
        await this.start()
      }
      return
    }
    if (!this._isEndpointCurrent(endpoint, endpointEpoch)) return
    // `/info` proved the current token still works. Also inspect runtime.json so
    // a freshly-published token is adopted before the next renderer request.
    if (
      endpoint.runtimeFile &&
      tokenRotated(endpoint, this._deps.readRuntimeFile(endpoint.runtimeFile))
    ) {
      const recovered = await this.refresh()
      if (
        lifecycleEpoch === this._lifecycleEpoch &&
        recovered.state === BackendState.Unavailable
      ) {
        await this.start()
      }
    }
  }

  private _isEndpointCurrent(endpoint: BackendEndpoint, endpointEpoch: number): boolean {
    return (
      endpointEpoch === this._endpointEpoch &&
      endpoint === this._endpoint &&
      this._state === BackendState.Ready
    )
  }

  private _clearHealthTimer(): void {
    if (!this._healthTimer) return
    clearInterval(this._healthTimer)
    this._healthTimer = null
  }

  private _scheduleDiscoveryRecovery(lifecycleEpoch: number): void {
    if (
      this._discoveryRecoveryTimer !== null ||
      lifecycleEpoch !== this._lifecycleEpoch ||
      this._spawnBlockedLifecycleEpoch === lifecycleEpoch ||
      this._state !== BackendState.Unavailable
    ) {
      return
    }
    const index = Math.min(
      this._discoveryRecoveryAttempt,
      DISCOVERY_RECOVERY_DELAYS_MS.length - 1,
    )
    const delay = DISCOVERY_RECOVERY_DELAYS_MS[index]!
    this._discoveryRecoveryAttempt += 1
    this._discoveryRecoveryTimer = setTimeout(() => {
      this._discoveryRecoveryTimer = null
      if (
        lifecycleEpoch !== this._lifecycleEpoch ||
        this._spawnBlockedLifecycleEpoch === lifecycleEpoch ||
        this._state !== BackendState.Unavailable
      ) {
        return
      }
      void this.refresh().catch((err: unknown) => {
        mainLog.warn('[python-client] discovery-only recovery failed', err)
        this._scheduleDiscoveryRecovery(lifecycleEpoch)
      })
    }, delay)
    this._discoveryRecoveryTimer.unref()
  }

  private _cancelDiscoveryRecovery(resetAttempt: boolean): void {
    if (this._discoveryRecoveryTimer !== null) {
      clearTimeout(this._discoveryRecoveryTimer)
      this._discoveryRecoveryTimer = null
    }
    if (resetAttempt) this._discoveryRecoveryAttempt = 0
  }

  private _retireEndpoint(): void {
    this._endpoint = null
    this._compatibility = null
    this._endpointEpoch += 1
  }
}

function runtimeBaseUrl(runtime: RuntimeFile): string {
  return endpointBaseUrl(runtime.host, runtime.port)
}

function endpointBaseUrl(runtimeHost: string, port: number): string {
  let host = runtimeHost
  if (host === '0.0.0.0') host = '127.0.0.1'
  if (host === '::') host = '::1'
  const authority = host.includes(':') ? `[${host}]` : host
  return `http://${authority}:${port}`
}

function sameDaemon(status: RunningStatus, runtime: RuntimeFile): boolean {
  return (
    status.host === runtime.host &&
    status.port === runtime.port &&
    status.pid === runtime.pid &&
    status.started_at === runtime.startedAt
  )
}

function sameRegistration(left: RuntimeFile, right: RuntimeFile | null): boolean {
  return (
    right !== null &&
    left.host === right.host &&
    left.port === right.port &&
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.token === right.token
  )
}

function sameRuntimeAndInfo(runtime: RuntimeFile, info: GatewayInfoResponse): boolean {
  return (
    runtime.host === info.host &&
    runtime.port === info.port &&
    runtime.pid === info.pid &&
    runtime.startedAt === info.started_at
  )
}

function sameEndpointAndInfo(endpoint: BackendEndpoint, info: GatewayInfoResponse): boolean {
  return (
    endpoint.baseUrl === endpointBaseUrl(info.host, info.port) &&
    endpoint.startedAt === info.started_at
  )
}

function isGatewayInfoResponse(value: unknown): value is GatewayInfoResponse {
  if (typeof value !== 'object' || value === null) return false
  const info = value as Record<string, unknown>
  return (
    typeof info.pid === 'number' &&
    typeof info.host === 'string' &&
    typeof info.port === 'number' &&
    typeof info.version === 'string' &&
    typeof info.started_at === 'string'
  )
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { BackendBinaryMissing }
