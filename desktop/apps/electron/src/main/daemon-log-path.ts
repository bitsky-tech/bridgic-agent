/**
 * Where to look for the daemon's log, and which candidate to open.
 *
 * "Open Logs" used to hard-guess `<runtime_dir>/server.log` — a path the
 * launchd-supervised daemon never wrote to, so the button failed on a default
 * (pkg-installed) macOS setup. The daemon now reports its actual log path
 * through runtime.json/status (`log_file`); the rest of the chain covers
 * older daemons, a stopped daemon, and the crash-net files that hold the
 * output of a daemon which died before its logging came up.
 *
 * Selection is deliberately NOT "first one that exists". Once server.log has
 * been created by any earlier successful run it exists forever, and taking it
 * unconditionally would open yesterday's log while today's import-failure
 * traceback sits unread in daemon.stderr.log. Only the daemon's own live
 * report is trusted outright; among the guesses, the most recently written
 * file wins.
 *
 * Pure module (no Electron imports) so the ranking is unit-testable; the IPC
 * handler in handlers/backend.ts owns shell.openPath.
 */
import os from 'node:os'
import path from 'node:path'
import {
  BACKEND_LOG_FILE_NAME,
  BACKEND_RUNTIME_DIR_REL,
  BACKEND_STDERR_LOG_FILE_NAME,
  BACKEND_STDOUT_LOG_FILE_NAME,
} from '../shared/app-meta'

/** The endpoint facts the chain can use; both may be absent (daemon down). */
export interface DaemonLogHints {
  logFile?: string | null
  runtimeFile?: string | null
}

/** Filesystem probes, injected so the ranking can be tested without a disk. */
export interface DaemonLogProbes {
  exists: (candidate: string) => boolean
  modifiedAt: (candidate: string) => number
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
    // 4-5. Crash net: a daemon that died before its logging came up has no
    //    server.log, but its traceback lands here. Both streams are
    //    configured (see the launchd plist), so both are searched.
    runtimeDir ? path.join(runtimeDir, BACKEND_STDERR_LOG_FILE_NAME) : null,
    runtimeDir ? path.join(runtimeDir, BACKEND_STDOUT_LOG_FILE_NAME) : null,
    path.join(fallbackDir, BACKEND_STDERR_LOG_FILE_NAME),
    path.join(fallbackDir, BACKEND_STDOUT_LOG_FILE_NAME),
    // 6. Legacy launchd location (macOS installs whose daemon predates the
    //    runtime-dir crash net); the plist migrates on the next start.
    ...(platform === 'darwin'
      ? [
          path.join(homeDir, 'Library', 'Logs', 'Amphi', 'daemon.stderr.log'),
          path.join(homeDir, 'Library', 'Logs', 'Amphi', 'daemon.stdout.log'),
        ]
      : []),
  ]
  return [...new Set(candidates.filter((candidate): candidate is string => candidate !== null))]
}

/**
 * Pick the log to open: the daemon's own live report if it exists, otherwise
 * the most recently modified candidate that does. Returns null when none of
 * them exist, leaving the caller to report every path it tried.
 */
export function selectDaemonLog(
  candidates: string[],
  probes: DaemonLogProbes,
  reportedLogFile?: string | null,
): string | null {
  const existing = candidates.filter((candidate) => probes.exists(candidate))
  if (existing.length === 0) return null
  if (reportedLogFile && existing.includes(reportedLogFile)) return reportedLogFile
  return existing.reduce((newest, candidate) =>
    probes.modifiedAt(candidate) > probes.modifiedAt(newest) ? candidate : newest,
  )
}
