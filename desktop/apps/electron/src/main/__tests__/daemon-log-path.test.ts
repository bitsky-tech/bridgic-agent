import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { daemonLogCandidates, selectDaemonLog } from '../daemon-log-path'

const HOME = path.join(path.sep, 'Users', 'tester')
const RUNTIME_DIR = path.join(HOME, '.bridgic', 'AmphiAgent')
const SERVER_LOG = path.join(RUNTIME_DIR, 'server.log')
const STDERR_LOG = path.join(RUNTIME_DIR, 'daemon.stderr.log')
const STDOUT_LOG = path.join(RUNTIME_DIR, 'daemon.stdout.log')
const RUNTIME_JSON = path.join(RUNTIME_DIR, 'runtime.json')

/** A path -> mtime table stands in for the disk; absent from the table means absent. */
function disk(files: Record<string, number>) {
  return {
    exists: (candidate: string) => candidate in files,
    modifiedAt: (candidate: string) => files[candidate] ?? 0,
  }
}

describe('daemonLogCandidates', () => {
  it('ranks the daemon-reported log_file first', () => {
    const candidates = daemonLogCandidates(
      { logFile: SERVER_LOG, runtimeFile: RUNTIME_JSON },
      'darwin',
      HOME,
    )
    expect(candidates[0]).toBe(SERVER_LOG)
  })

  it('guesses from the conventional directory when there is no endpoint, crash-net files included', () => {
    expect(daemonLogCandidates({}, 'linux', HOME)).toEqual([
      SERVER_LOG,
      STDERR_LOG,
      STDOUT_LOG,
    ])
  })

  it('covers the stdout half of the crash net — the launchd plist wires both streams', () => {
    // With only stderr in the chain, a crash whose output went to stdout
    // (bare prints, PyInstaller bootstrap noise) makes "Open Logs" report
    // nothing found while the evidence sits in the same directory.
    const candidates = daemonLogCandidates({ runtimeFile: RUNTIME_JSON }, 'linux', HOME)
    expect(candidates).toContain(STDOUT_LOG)
    expect(candidates).toContain(STDERR_LOG)
  })

  it('guesses beside runtimeFile for a pre-log_file daemon', () => {
    const elsewhere = path.join(path.sep, 'custom', 'dir')
    const candidates = daemonLogCandidates(
      { runtimeFile: path.join(elsewhere, 'runtime.json') },
      'linux',
      HOME,
    )
    expect(candidates[0]).toBe(path.join(elsewhere, 'server.log'))
    expect(candidates).toContain(SERVER_LOG)
  })

  it('appends the legacy launchd location last on macOS only', () => {
    const legacy = path.join(HOME, 'Library', 'Logs', 'Amphi', 'daemon.stderr.log')
    expect(daemonLogCandidates({}, 'darwin', HOME)).toContain(legacy)
    expect(daemonLogCandidates({}, 'win32', HOME)).not.toContain(legacy)
  })

  it('deduplicates repeated candidates', () => {
    const candidates = daemonLogCandidates(
      { logFile: SERVER_LOG, runtimeFile: RUNTIME_JSON },
      'linux',
      HOME,
    )
    expect(candidates.filter((candidate) => candidate === SERVER_LOG)).toHaveLength(1)
  })
})

describe('selectDaemonLog', () => {
  const candidates = daemonLogCandidates(
    { logFile: SERVER_LOG, runtimeFile: RUNTIME_JSON },
    'linux',
    HOME,
  )

  it('returns null when nothing exists, leaving the caller to report every tried path', () => {
    expect(selectDaemonLog(candidates, disk({}), SERVER_LOG)).toBeNull()
  })

  it('takes the daemon-reported file outright when it exists, without comparing mtimes', () => {
    // The reported server.log is the live one, even when a crash-net file is
    // newer (another daemon instance).
    const chosen = selectDaemonLog(
      candidates,
      disk({ [SERVER_LOG]: 100, [STDERR_LOG]: 999 }),
      SERVER_LOG,
    )
    expect(chosen).toBe(SERVER_LOG)
  })

  it('takes the newest candidate without a report: a stale server.log cannot hide today\'s crash', () => {
    // Yesterday's run succeeded, so server.log exists forever; today's start
    // died during import, and the traceback lives only in daemon.stderr.log.
    // "First one that exists" would open yesterday's log.
    const guesses = daemonLogCandidates({ runtimeFile: RUNTIME_JSON }, 'linux', HOME)
    expect(guesses.indexOf(SERVER_LOG)).toBeLessThan(guesses.indexOf(STDERR_LOG))
    const chosen = selectDaemonLog(guesses, disk({ [SERVER_LOG]: 100, [STDERR_LOG]: 500 }))
    expect(chosen).toBe(STDERR_LOG)
  })

  it('falls back to the newest crash-net file when the reported path does not exist (degraded logging)', () => {
    const chosen = selectDaemonLog(
      candidates,
      disk({ [STDOUT_LOG]: 300, [STDERR_LOG]: 700 }),
      SERVER_LOG,
    )
    expect(chosen).toBe(STDERR_LOG)
  })
})
