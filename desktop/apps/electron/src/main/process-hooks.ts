import { isDebugMode, mainLog } from './logger'

/**
 * Names of `process.on('warning')` events we suppress unless in debug mode —
 * these are routinely emitted by Bun / Electron / Node on startup and would
 * otherwise flood the log file. Add to this set as new noise appears.
 */
const NOISY_WARNINGS = new Set([
  'DeprecationWarning',
  'ExperimentalWarning',
  'UnsupportedWarning',
])

/**
 * Install last-resort error handlers on the main process. Without these,
 * an unhandled promise rejection or uncaught exception goes to stderr and
 * is invisible to anyone reading `~/.bridgic/amphi/logs/main.log`.
 *
 * Call once from `main/index.ts` BEFORE any async work starts.
 */
export function installProcessErrorHooks(): void {
  process.on('unhandledRejection', (reason, promise) => {
    mainLog.error('[process] unhandledRejection', reason)
    // Reference `promise` so it isn't GC'd before the log flushes.
    void promise
  })

  process.on('uncaughtException', (err, origin) => {
    mainLog.error(`[process] uncaughtException (origin=${origin})`, err)
  })

  process.on('warning', (warning) => {
    if (!isDebugMode && NOISY_WARNINGS.has(warning.name)) return
    mainLog.warn(`[process] warning (${warning.name}): ${warning.message}`)
  })
}
