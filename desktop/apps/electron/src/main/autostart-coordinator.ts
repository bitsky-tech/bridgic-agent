import type { AutostartResult, AutostartStatusJson } from './python-client/types'
import {
  combineAutostartStatus,
  type GuiAutostartStatus,
} from './gui-autostart'

export interface AutostartCoordinatorDeps {
  readDaemon: () => Promise<AutostartStatusJson | null>
  setDaemon: (enabled: boolean) => Promise<boolean>
  readTray: () => GuiAutostartStatus
  setTray: (enabled: boolean) => GuiAutostartStatus
  warn?: (message: string, error?: unknown) => void
  error?: (message: string, error?: unknown) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readDaemonSafely(
  deps: AutostartCoordinatorDeps,
): Promise<AutostartStatusJson | null> {
  try {
    return await deps.readDaemon()
  } catch (error) {
    deps.warn?.('daemon autostart status failed', error)
    return null
  }
}

function readTraySafely(deps: AutostartCoordinatorDeps): GuiAutostartStatus | null {
  try {
    return deps.readTray()
  } catch (error) {
    deps.warn?.('tray autostart status failed', error)
    return null
  }
}

/** A CLI timeout is not proof that its side effects did not happen. Always
 * re-read the effective state; callers retain the command acknowledgement for
 * operations where effective state alone cannot prove registration deletion. */
async function setAndVerifyDaemon(
  enabled: boolean,
  deps: AutostartCoordinatorDeps,
): Promise<{ reported: boolean; status: AutostartStatusJson | null }> {
  let reported = false
  try {
    reported = await deps.setDaemon(enabled)
    if (!reported) deps.warn?.(`daemon autostart ${enabled ? 'enable' : 'disable'} reported failure`)
  } catch (error) {
    deps.warn?.(`daemon autostart ${enabled ? 'enable' : 'disable'} threw`, error)
  }
  return { reported, status: await readDaemonSafely(deps) }
}

export async function readCombinedAutostart(
  deps: AutostartCoordinatorDeps,
): Promise<AutostartResult> {
  const daemon = await readDaemonSafely(deps)
  if (!daemon) return { ok: false as const, reason: 'autostart status unavailable' }
  const tray = readTraySafely(deps)
  if (!tray) return { ok: false as const, reason: 'tray autostart status unavailable' }
  return { ok: true as const, status: combineAutostartStatus(daemon, tray) }
}

/** Apply the product's single auto-start preference to two independent OS
 * registrations. Ordering ensures every interrupted intermediate state keeps
 * an observable recovery path instead of a permanently headless daemon. */
export async function setCombinedAutostart(
  enabled: boolean,
  deps: AutostartCoordinatorDeps,
): Promise<AutostartResult> {
  const daemonBefore = await readDaemonSafely(deps)
  if (!daemonBefore) return { ok: false as const, reason: 'autostart status unavailable' }
  const trayBefore = readTraySafely(deps)
  if (!trayBefore) return { ok: false as const, reason: 'tray autostart status unavailable' }
  let trayEnabledByTransaction = false

  if (enabled) {
    // GUI first: if the process is interrupted, Electron still starts on the
    // next login and can repair or explain a missing daemon.
    if (trayBefore.supported && !trayBefore.enabled) {
      try {
        const trayAfter = deps.setTray(true)
        if (!trayAfter.registered) {
          return { ok: false as const, reason: trayAfter.detail ?? 'tray login item was not registered' }
        }
        // System policy is authoritative. Do not turn on a headless daemon
        // when Windows Startup Apps kept the item disabled or macOS still
        // requires approval; return the component state so the UI can explain
        // the exact action still required.
        if (!trayAfter.enabled) return readCombinedAutostart(deps)
        trayEnabledByTransaction = true
      } catch (cause) {
        return { ok: false as const, reason: `tray autostart enable failed: ${errorMessage(cause)}` }
      }
    }

    if (!daemonBefore.enabled) {
      const { status: daemonAfter } = await setAndVerifyDaemon(true, deps)
      if (!daemonAfter?.enabled) {
        // Restore the previous effective-disabled tray state when this
        // transaction was the operation that enabled it. On Windows the API
        // may represent that rollback by removing the registered-but-disabled
        // item, but it never leaves a failed request overriding the opt-out.
        // If status itself is unavailable, also retain the tray: the CLI may
        // have succeeded before timing out, and observability is safer than
        // recreating a daemon-only startup.
        if (daemonAfter && trayEnabledByTransaction) {
          try {
            const trayRollback = deps.setTray(false)
            if (trayRollback.registered) {
              deps.warn?.('tray rollback after daemon enable failure did not remove registration')
            }
          } catch (cause) {
            deps.warn?.('tray rollback after daemon enable failure failed', cause)
          }
        }
        return { ok: false as const, reason: 'daemon autostart enable failed' }
      }
    }
  } else {
    // Daemon first: until it is confirmed off, the tray remains the recovery
    // and diagnostic path for any partial failure.
    if (daemonBefore.supported) {
      const { reported, status: daemonAfter } = await setAndVerifyDaemon(false, deps)
      // `enabled` is the effective StartupApproved state, not proof that the
      // Windows Run registration is absent. Even a true -> false transition can
      // come from an approval read failure or a concurrent Windows opt-out, so
      // a false/throwing CLI result is never enough to remove the diagnostic
      // tray. A retry can finish the idempotent delete without risking a future
      // daemon-only startup if approval changes later.
      if (!reported || !daemonAfter || daemonAfter.enabled) {
        return { ok: false as const, reason: 'daemon autostart disable failed' }
      }
    }

    if (trayBefore.supported && trayBefore.registered) {
      try {
        const trayAfter = deps.setTray(false)
        if (trayAfter.registered) {
          throw new Error(trayAfter.detail ?? 'tray login item is still registered')
        }
      } catch (cause) {
        // Restore the previously enabled daemon if removing the tray failed,
        // keeping the product in its old consistent state whenever possible.
        if (daemonBefore.enabled) {
          const { status: rolledBack } = await setAndVerifyDaemon(true, deps)
          if (!rolledBack?.enabled) deps.error?.('daemon rollback after tray disable failure failed')
        }
        return {
          ok: false as const,
          reason: `tray autostart disable failed: ${errorMessage(cause)}`,
        }
      }
    }
  }

  return readCombinedAutostart(deps)
}
