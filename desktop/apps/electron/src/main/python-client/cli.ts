/**
 * Thin wrappers around `amphi server <subcommand>` execFile calls.
 *
 * Each function shells out to the CLI and parses its stdout. No state
 * is kept here — callers (PythonClient) own the state machine. These
 * helpers exist to:
 *   1. Centralize timeout / error normalization across all CLI calls.
 *   2. Make the discriminated-union nature of `status --json` explicit.
 *   3. Keep PythonClient.ts focused on state transitions.
 *
 * `amphi server start` MUST block until the
 * daemon reports ready (exit 0 ⟺ daemon is now serving). We rely on
 * that and do NOT poll `/health` after `start()`.
 *
 * `status` always exits 0 — the JSON's `status`
 * field is the real signal. We treat non-zero exit as a hard
 * environment failure (binary corrupt / Python not installed) rather
 * than "no service registered".
 */
import { execFile, type ExecFileException } from 'node:child_process'
import { promisify } from 'node:util'
import { mainLog } from '../logger'
import { amphiAbsolutePath } from './path-resolver'
import type { AutostartStatusJson, StatusJson } from './types'

const execFileAsync = promisify(execFile)

/** Timeout for the synchronous `status --json` probe.
 *
 *  Two slow paths share this budget:
 *   - dev: the CLI is a `uv run` wrapper — dependency resolution on a
 *     cold cache takes 5-8s (slower on weaker hardware).
 *   - packaged: signed-binary verification and endpoint protection can still
 *     delay the first launch, although the current onedir build avoids the old
 *     per-invocation extraction cost.
 *  30s covers both; a genuinely missing binary still fails instantly
 *  (ENOENT, not timeout). */
const STATUS_TIMEOUT_MS = 30_000

/** Timeout for `start`.
 *
 * The backend may legally spend 40s waiting for its lifecycle lock and then
 * another 40s waiting for readiness. Leave additional headroom for signed
 * executable verification / endpoint protection on a cold Windows launch. */
const START_TIMEOUT_MS = 110_000

/** Restart can wait 48s for the lock, drain for 8s, then wait 40s for
 * readiness. Configure-only autostart uses the same generous lock budget so a
 * concurrent lifecycle command finishes instead of leaving a partial toggle. */
const RESTART_TIMEOUT_MS = 130_000
const AUTOSTART_TIMEOUT_MS = 130_000

/** Stop can wait 8s for the lock and another 8s for graceful termination. */
const STOP_TIMEOUT_MS = 60_000

/** Run `amphi server status --json` and return the parsed snapshot.
 *
 * Returns `null` if the CLI binary is missing entirely; throws when the
 * binary exists but errors unexpectedly (so callers see real bugs). */
export async function cliStatus(): Promise<StatusJson | null> {
  let amphi: string
  try {
    amphi = amphiAbsolutePath()
  } catch (err) {
    mainLog.warn('[python-client] CLI binary not found', err)
    return null
  }
  try {
    // `amphi server status` always emits JSON on stdout — there is no
    // `--json` flag; its output is JSON unconditionally.
    const { stdout } = await execFileAsync(amphi, ['server', 'status'], {
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
    })
    return JSON.parse(stdout) as StatusJson
  } catch (err) {
    const fail = err as ExecFileException
    mainLog.error('[python-client] cliStatus failed', {
      code: fail.code,
      signal: fail.signal,
      stderr: typeof fail.stderr === 'string' ? fail.stderr.slice(0, 500) : undefined,
    })
    throw err
  }
}

/** Run `amphi server start`. Resolves true on exit 0 (= daemon ready).
 *
 * Does not throw on CLI non-zero exit — returns false and logs. Callers
 * decide whether to retry or move to `unavailable` state. */
export async function cliStart(
  opts?: { host?: string; port?: number },
): Promise<boolean> {
  let amphi: string
  try {
    amphi = amphiAbsolutePath()
  } catch (err) {
    mainLog.error('[python-client] cliStart: binary not found', err)
    return false
  }
  const args = ['server', 'start']
  if (opts?.host) args.push('--host', opts.host)
  if (opts?.port) args.push('--port', String(opts.port))
  try {
    const { stdout } = await execFileAsync(amphi, args, {
      timeout: START_TIMEOUT_MS,
      windowsHide: true,
    })
    mainLog.info(`[python-client] cliStart ok: ${stdout.trim()}`)
    return true
  } catch (err) {
    const fail = err as ExecFileException
    const stderr = typeof fail.stderr === 'string' ? fail.stderr : ''
    mainLog.error('[python-client] cliStart failed', {
      code: fail.code,
      signal: fail.signal,
      stderr: stderr.slice(0, 500),
    })
    return false
  }
}

/** Run `amphi server restart` — equivalent to stop + start. Used when
 *  the renderer requests an explicit recovery (GUI "Restart Service"
 *  button) or when version-incompat detection fires. */
export async function cliRestart(): Promise<boolean> {
  let amphi: string
  try {
    amphi = amphiAbsolutePath()
  } catch (err) {
    mainLog.error('[python-client] cliRestart: binary not found', err)
    return false
  }
  try {
    const { stdout } = await execFileAsync(amphi, ['server', 'restart'], {
      timeout: RESTART_TIMEOUT_MS,
      windowsHide: true,
    })
    mainLog.info(`[python-client] cliRestart ok: ${stdout.trim()}`)
    return true
  } catch (err) {
    logCliFailure('cliRestart', err)
    return false
  }
}

/** Run `amphi server stop`. Should ONLY be called from explicit user
 *  intent (CLI "Stop Service" UI), never from `before-quit`: Electron
 *  closing must not bring the shared daemon down. */
export async function cliStop(): Promise<boolean> {
  let amphi: string
  try {
    amphi = amphiAbsolutePath()
  } catch {
    return false
  }
  try {
    await execFileAsync(amphi, ['server', 'stop'], {
      // 30s, not 15s: on Windows the PyInstaller CLI takes seconds to cold
      // start, and the backend stop flow itself waits 8s for a graceful
      // drain before falling back to taskkill — 15s could kill the stop
      // process before it even issued the stop, leaving the daemon alive
      // (the log would only show "cliStop failed").
      timeout: STOP_TIMEOUT_MS,
      windowsHide: true,
    })
    return true
  } catch (err) {
    mainLog.error('[python-client] cliStop failed', err)
    return false
  }
}

/**
 * Read the current autostart configuration. `null` = CLI missing or errored.
 *
 * Autostart is not cosmetic on macOS: enabling it moves the daemon from a
 * detached child of whoever ran the CLI (inherits our full PATH) to a launchd
 * agent (gets launchd's bare PATH). That switch is exactly what made `uv`
 * unreachable and killed the first conversation, so the setting has to be
 * visible and reversible from the GUI rather than CLI-only.
 *
 * ONLY `status` emits JSON. `enable` / `disable` print a human sentence
 * (`_server.py::_autostart` — `print(f"Autostart enabled via …")`), so they get
 * their own boolean-returning helper below. Parsing their stdout as JSON made
 * every successful toggle look like a failure.
 */
export async function cliAutostartStatus(): Promise<AutostartStatusJson | null> {
  let amphi: string
  try {
    amphi = amphiAbsolutePath()
  } catch (err) {
    mainLog.warn('[python-client] CLI binary not found', err)
    return null
  }
  try {
    const { stdout } = await execFileAsync(amphi, ['server', 'autostart', 'status'], {
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
    })
    return JSON.parse(stdout) as AutostartStatusJson
  } catch (err) {
    logCliFailure('cliAutostartStatus', err)
    return null
  }
}

/**
 * Run `amphi server autostart enable|disable --configure-only`.
 *
 * Deliberately does NOT parse stdout — these two verbs print prose, and the
 * authoritative post-state comes from a follow-up `status` call. Configure-only
 * changes login registration while preserving the current gateway process.
 */
async function cliAutostartVerb(verb: 'enable' | 'disable'): Promise<boolean> {
  let amphi: string
  try {
    amphi = amphiAbsolutePath()
  } catch (err) {
    mainLog.error(`[python-client] cliAutostart ${verb}: binary not found`, err)
    return false
  }
  try {
    const { stdout } = await execFileAsync(
      amphi,
      ['server', 'autostart', verb, '--configure-only'],
      {
        timeout: AUTOSTART_TIMEOUT_MS,
        windowsHide: true,
      },
    )
    mainLog.info(`[python-client] cliAutostart ${verb} ok: ${stdout.trim()}`)
    return true
  } catch (err) {
    logCliFailure(`cliAutostart ${verb}`, err)
    return false
  }
}

/** Install login autostart without changing the current service. */
export function cliAutostartEnable(): Promise<boolean> {
  return cliAutostartVerb('enable')
}

/** Remove login autostart without changing the current service. */
export function cliAutostartDisable(): Promise<boolean> {
  return cliAutostartVerb('disable')
}

/** Log an execFile rejection with the fields that actually identify it.
 *
 *  Passing the raw ExecFileException to electron-log serializes to `{}` —
 *  the failure that prompted this helper showed up in the log as
 *  `cliAutostart disable failed {}`, which says nothing. Mirrors what
 *  `cliStart` already does by hand. */
function logCliFailure(label: string, err: unknown): void {
  const fail = err as ExecFileException
  mainLog.error(`[python-client] ${label} failed`, {
    code: fail.code,
    signal: fail.signal,
    message: fail.message,
    stderr: typeof fail.stderr === 'string' ? fail.stderr.slice(0, 500) : undefined,
  })
}
