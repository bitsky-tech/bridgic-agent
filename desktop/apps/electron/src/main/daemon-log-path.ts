/**
 * Candidate locations for the daemon's log file, most authoritative first.
 *
 * "Open Logs" used to hard-guess `<runtime_dir>/server.log` — a path the
 * launchd-supervised daemon never wrote to, so the button failed 100% of the
 * time on a default (pkg-installed) macOS setup. The daemon now reports its
 * actual log path through runtime.json/status (`log_file`); everything after
 * candidate 1 exists to keep the button useful against older daemons, a
 * degraded daemon, or a daemon that is not running at all.
 *
 * Pure module (no Electron imports) so the chain is unit-testable; the IPC
 * handler in handlers/backend.ts owns the existence check and shell.openPath.
 */
import os from 'node:os'
import path from 'node:path'
import {
  BACKEND_LOG_FILE_NAME,
  BACKEND_RUNTIME_DIR_REL,
  BACKEND_STDERR_LOG_FILE_NAME,
} from '../shared/app-meta'

/** The endpoint facts the chain can use; both may be absent (daemon down). */
export interface DaemonLogHints {
  logFile?: string | null
  runtimeFile?: string | null
}

export function daemonLogCandidates(
  hints: DaemonLogHints,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string[] {
  const runtimeDir = hints.runtimeFile ? path.dirname(hints.runtimeFile) : null
  const fallbackDir = path.join(homeDir, BACKEND_RUNTIME_DIR_REL)
  const candidates: Array<string | null> = [
    // 1. The daemon's own answer — exact, supervisor-independent.
    hints.logFile ?? null,
    // 2-3. Guess beside the runtime file the daemon reported, then beside
    //    the conventional runtime dir (daemon down or pre-log_file daemon).
    runtimeDir ? path.join(runtimeDir, BACKEND_LOG_FILE_NAME) : null,
    path.join(fallbackDir, BACKEND_LOG_FILE_NAME),
    // 4. Crash net: a daemon that died before its logging came up has no
    //    server.log, but its import-failure traceback lands here.
    path.join(fallbackDir, BACKEND_STDERR_LOG_FILE_NAME),
    // 5. Legacy launchd location (macOS installs whose daemon predates the
    //    runtime-dir crash net); the plist migrates on the next start.
    platform === 'darwin'
      ? path.join(homeDir, 'Library', 'Logs', 'Amphi', 'daemon.stderr.log')
      : null,
  ]
  return [...new Set(candidates.filter((candidate): candidate is string => candidate !== null))]
}
