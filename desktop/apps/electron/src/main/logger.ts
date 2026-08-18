import log from 'electron-log/main'
import { amphiUserFile } from './paths'
import { toLogLine, toLogText } from './log-serialize'

// All desktop-owned files live under one root (~/.bridgic/amphi —
// see paths.ts). Redirect electron-log's default (~/Library/Logs/<app>/)
// so logs follow: <root>/logs/main.log (rotation: main.old.log alongside).
log.transports.file.resolvePathFn = () => amphiUserFile('logs', 'main.log')

function resolveDebugMode(): boolean {
  if (process.argv.includes('--debug')) return true
  if (process.env.APP_DEBUG === '1' || process.env.APP_DEBUG === 'true') return true
  if (process.env.APP_DEBUG === 'false') return false

  // Electron heuristic: defaultApp = dev (electron CLI), otherwise packaged.
  const isElectron = typeof process.versions?.electron === 'string'
  if (isElectron) return Boolean(process.defaultApp)

  return true
}

export const isDebugMode = resolveDebugMode()

// NDJSON file format — same shape for dev and prod so log tools can parse
// uniformly. The whole line is built inside toLogLine (never here) because
// this callback runs before electron-log's own serialization transform and a
// callback that throws is swallowed by Logger.processMessage — anything
// evaluated in the argument list would be outside the safety net, which is
// how the shell-env failure warning went missing in the first place.
log.transports.file.format = ({ message }) => [toLogLine(message)]

if (isDebugMode) {
  log.transports.file.level = 'debug'
  log.transports.file.maxSize = 5 * 1024 * 1024 // 5 MB

  log.transports.console.format = ({ message }) => {
    const scope = message.scope ? `[${message.scope}]` : ''
    const level = message.level.toUpperCase().padEnd(5)
    const data = message.data.map(toLogText).join(' ')
    return [`${message.date.toISOString()} ${level} ${scope} ${data}`]
  }
  log.transports.console.level = 'debug'
} else {
  // Production: `info` and above, so a user report carries the story and not
  // just its last line. Was `warn`, which turned out to be too aggressive: the
  // auto-update flow routes electron-updater's own logger here, and ALL of its
  // diagnostics (feed check, proxy server for Squirrel, which archive got
  // handed over) are `info`. A stalled update therefore left a log file with
  // literally nothing in it — the interesting half hour was simply gone.
  // `debug` stays filtered, which is where the per-IPC volume lives.
  // Console is muted to avoid leaking to terminal of packaged apps.
  log.transports.file.level = 'info'
  log.transports.file.maxSize = 2 * 1024 * 1024 // 2 MB cap in prod
  log.transports.console.level = false
}

// NOTE: we intentionally do NOT call `log.errorHandler.startCatching()` here.
// That helper attaches its own `process.on('uncaughtException')` and
// `process.on('unhandledRejection')` listeners (see electron-log
// src/node/ErrorHandler.js), which would double-fire alongside
// `installProcessErrorHooks()` from `./process-hooks.ts`. We keep ours so
// we can format the entries consistently with the rest of the log.

export const mainLog = log.scope('main')
export const windowLog = log.scope('window')
export const handlerLog = log.scope('handler')
export const updateLog = log.scope('update')
export const telemetryLog = log.scope('telemetry')

/**
 * Path to the active log file. Available in both debug and prod modes (prod
 * keeps warn+error). Surfaced in the application menu via "View → Open Log".
 */
export function getLogFilePath(): string | undefined {
  return log.transports.file.getFile()?.path
}

export default log
