/**
 * IPC handler for installing an already-downloaded desktop update.
 *
 * Surface:
 *   - `update:installNow` → stop the daemon gracefully, then quit and install
 *   - `update:checkNow`   → run a check on the user's behalf (Settings → About)
 *   - `update:getStatus`  → snapshot for a UI that opened after the events fired
 *
 * Why the daemon stop lives HERE and not in the installer
 * ------------------------------------------------------
 * On Windows the NSIS installer's built-in "is the app running?" check matches
 * every process whose image path starts with the install directory and
 * `Stop-Process -Force`s all of them
 * (app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh).
 * Our daemon lives at `<install>\resources\bin\amphi.exe`, so it is caught by
 * that sweep and hard-killed — mid-write, mid-agent-turn, with no chance to
 * flush. The installer also runs a graceful stop first (see
 * `build/installer.nsh :: customCheckAppRunning`), but by the time it does, the
 * GUI's 30s health probe may already have re-spawned the daemon. Doing it here,
 * immediately before `quitAndInstall`, is the only point where the GUI is still
 * in control and can guarantee it will not resurrect what it just stopped.
 *
 * Refusals are values, not exceptions: an update that cannot be applied right
 * now stays staged on disk and the banner explains why.
 */
import { IPC } from '../../shared/ipc-channels'
import type { UpdateCheckOutcome, UpdateInstallResult, UpdateStatus } from '../../shared/types'
import { getUpdateStatus, hasStagedUpdate, quitAndInstall, requestManualCheck } from '../auto-update'
import { updateLog } from '../logger'
import { BrowserWindow } from 'electron'
import { pythonClient } from '../python-client'
import { clearQuitConfirmed, markQuitConfirmed } from '../quit-with-daemon'
import { loggedHandle } from './logged-handle'
import type { ExcelHost } from '../excel-host'

/** How long the install handover gets before we assume it did not happen. */
const HANDOVER_GRACE_MS = 60_000

export function registerUpdateHandlers(excelHost: ExcelHost): void {
  loggedHandle(IPC.update.installNow, async (): Promise<UpdateInstallResult> => {
    if (!hasStagedUpdate()) {
      return { ok: false as const, reason: 'no-update-staged' as const }
    }
    if (!await excelHost.confirmClose()) {
      return { ok: false as const, reason: 'unsaved-workbooks' as const }
    }

    // Take the window away FIRST, before the gateway goes down.
    //
    // Stopping the daemon is part of the handover, not something the user is
    // meant to watch or interfere with — and while it happens the renderer sees
    // an ordinary "gateway is not running" state and offers a Start button.
    // Taking that offer spawns a daemon the installer is about to kill again.
    // Hiding is enough (and reversible): the app is about to quit anyway, and a
    // refusal below can bring the window straight back.
    // Remember which were actually visible so a refusal can restore exactly
    // those — blanket-showing would also un-hide a window the user had minimised
    // to tray on purpose.
    const hiddenForHandover = BrowserWindow.getAllWindows().filter((w) => w.isVisible())
    hiddenForHandover.forEach((w) => w.hide())

    // Always ask, whatever our own state says. An earlier version skipped the
    // stop when the snapshot was not in a hand-picked set of "live" states, and
    // that set could not be made right: `incompatible` means a daemon is running
    // (it answered a health probe with a version), and `idle` covers a
    // launchd/Run-key daemon that was up before our first discovery finished.
    // Both would have been handed straight to an installer that force-kills
    // whatever it finds. `server stop` on a daemon that is not running is a
    // no-op that exits 0, so asking unconditionally costs nothing.
    //
    // The return value is the signal, NOT the resulting state: stopDaemon()
    // reports `unavailable` either way — it stopped, or we gave up on it.
    const stopped = await pythonClient.stopDaemon()
    if (!stopped) {
      // `stopDaemon` also reports failure when the bundled CLI cannot be located
      // at all (`BackendBinaryMissing` inside cliStop). That is a broken
      // installation — exactly what an update repairs — and there is no daemon
      // to protect, so refusing would leave the user permanently unable to
      // update. A null endpoint means we never successfully adopted one, which
      // is the distinguishing fact: a stop that failed against a LIVE daemon
      // leaves the endpoint in place.
      if (pythonClient.snapshot().endpoint !== null) {
        updateLog.warn('[update] daemon did not stop; leaving the update staged')
        hiddenForHandover.forEach((w) => w.show())
        return {
          ok: false as const,
          reason: 'daemon-busy' as const,
          detail: 'The gateway did not shut down.',
        }
      }
      updateLog.info('[update] stop reported failure but no daemon was ever adopted; continuing')
    }

    updateLog.info('[update] daemon stopped, handing over to the installer')
    // quitAndInstall() calls app.quit() internally, which hits the before-quit
    // intercept in index.ts. Without this the intercept would run the *quit
    // confirmation* flow — asking a daemon we just stopped for its client list,
    // failing, and showing a modal whose Cancel leaves the app running with the
    // gateway down and the update uninstalled.
    markQuitConfirmed()
    quitAndInstall(() => hiddenForHandover.forEach((w) => w.show()))

    // Windows/Linux only. There quitAndInstall hands over synchronously (and
    // auto-update.ts arms its own 1s app.quit() fallback), so still being alive a
    // minute later means the handover failed — and leaving the flag set would
    // make the NEXT quit skip the daemon stop and the "other clients are
    // connected" confirmation entirely.
    //
    // NOT on macOS: there Squirrel unzips a ~300 MB bundle and code-signature-
    // verifies every file in it before quitting us, which for a payload with a
    // bundled Python runtime can easily outlast any grace window worth picking.
    // Clearing the flag mid-install would put up the very dialog
    // markQuitConfirmed exists to suppress, and Cancel would leave the app
    // running with the gateway stopped and the update unapplied.
    if (process.platform !== 'darwin') {
      setTimeout(() => {
        updateLog.warn('[update] still running after the handover; restoring normal quit behaviour')
        clearQuitConfirmed()
      }, HANDOVER_GRACE_MS).unref?.()
    }

    return { ok: true as const }
  })

  loggedHandle(IPC.update.checkNow, async (): Promise<UpdateCheckOutcome> => requestManualCheck())

  loggedHandle(IPC.update.getStatus, async (): Promise<UpdateStatus> => getUpdateStatus())

  updateLog.info('[handlers] update handlers registered')
}
