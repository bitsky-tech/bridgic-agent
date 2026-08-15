/**
 * Semantics of "Quit Completely": quit the GUI **and** stop the gateway, but
 * never silently cut off someone else's connection.
 *
 * Background, plus one architectural invariant that was deliberately changed:
 *   Earlier, `before-quit` explicitly did **not** stop the daemon because the
 *   daemon is shared with the CLI and with a potential second client. The cost
 *   was that the tray's "Quit Completely" did not live up to its name — the
 *   icon disappeared, the gateway kept running in the background, the port
 *   stayed occupied, and one second earlier the user had been looking at
 *   "● Gateway running".
 *
 *   The invariant is now narrowed to: **closing the window** does not take the
 *   daemon with it (hide-to-tray as before), and only an **explicit click on
 *   "Quit Completely"** does — and even then we first ask the daemon who else
 *   is still connected. `/api/gateway/clients` is already being polled, so
 *   "only me" vs. "someone else is here" is decidable; we don't have to choose
 *   between "always stop" and "never stop".
 *
 * Invariants:
 *   - A failed check (daemon unreachable / no token / timeout) is always
 *     **treated as "someone else is connected"** and we ask once more — with
 *     no evidence in hand we must not make an irreversible decision on the
 *     user's behalf.
 *   - The dialog is a **native** dialog, not a renderer-side popup: the window
 *     may already have been hidden by hide-to-tray at this point, and nobody
 *     would see a renderer modal.
 *   - The dialog offers **three choices**; "Cancel" means not even quitting.
 *     What used to be written here — "the GUI quits no matter what the user
 *     picks" — was itself a wrong invariant: when the menu item was clicked by
 *     mistake, or the user simply changed their mind, they need a way out, and
 *     ESC is the universal way to express it.
 */

import { app, BrowserWindow, dialog } from 'electron'
import { APP_PRODUCT_NAME } from '../shared/app-meta'
import { mt } from './i18n'
import { mainLog } from './logger'
import { guiClientId } from './gui-client-id'
import { pythonClient } from './python-client'
import { cliStop } from './python-client/cli'
import { fetchGatewayClients } from './handlers/backend'
import { ClientKind, type ClientInfoResponse } from './python-client/types'

/**
 * Clients still connected other than ourselves; returns null when it can't be
 * determined (callers then treat it as "someone else is connected").
 *
 * Self-identification relies on `client_id`: what the GUI registers with is
 * exactly `guiClientId()`. `client_type` is not enough — a second Amphi window
 * is also `gui`, so filtering by type would count it as ourselves too.
 */
export async function otherClients(): Promise<ClientInfoResponse[] | null> {
  const result = await fetchGatewayClients()
  if (!result.ok) {
    mainLog.warn('[quit] could not read gateway clients', { reason: result.reason })
    return null
  }
  const self = guiClientId()
  return result.clients.filter((client) => client.client_id !== self)
}

/** Human-readable client types for the dialog body. Unknown types are shown as-is, never swallowed. */
function describeKinds(kinds: string[]): string {
  const label: Record<string, string> = {
    [ClientKind.Gui]: mt('main.quit.kind.gui'),
    [ClientKind.Cli]: mt('main.quit.kind.cli'),
    [ClientKind.Tray]: mt('main.quit.kind.tray'),
  }
  const unique = [...new Set(kinds.map((kind) => label[kind] ?? kind))]
  return unique.join(' / ')
}

/** The user's three possible answers to "someone else is connected — quit anyway?". */
const QuitChoice = {
  /** Stop the gateway and quit. */
  StopAndQuit: 'stop-and-quit',
  /** Quit the UI, leave the gateway running. */
  KeepAndQuit: 'keep-and-quit',
  /** Do nothing at all — even the quit is cancelled. */
  Cancel: 'cancel',
} as const
type QuitChoice = (typeof QuitChoice)[keyof typeof QuitChoice]

/**
 * Ask how to quit when other clients are still connected.
 *
 * **There must be three choices.** Earlier there were only two buttons — "Stop
 * the gateway anyway" / "Keep the gateway and quit" — with ESC bound to the
 * latter, which made the intent "I want to undo that click" **impossible to
 * express**: pressing ESC quit the app all the same. But the universal
 * semantics of ESC is to cancel the operation just started, and that operation
 * is precisely "Quit Completely".
 * (The user raised exactly this point during hands-on testing on 2026-07-29.)
 *
 * Default focus goes to "Keep the gateway and quit" rather than "Cancel": the
 * user got here by **deliberately** clicking Quit Completely, so Enter should
 * follow that intent, just without dragging others down; ESC is the way back out.
 */
async function askQuitChoice(count: number | null, kinds: string[]): Promise<QuitChoice> {
  const detail =
    count === null
      ? mt('main.quit.detailUnknown')
      : mt('main.quit.detailCount', { count, kinds: describeKinds(kinds) || mt('main.quit.kind.unknown') })
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [mt('main.quit.buttonStop'), mt('main.quit.buttonKeep'), mt('main.quit.buttonCancel')],
    defaultId: 1,
    cancelId: 2,
    title: mt('main.quit.title', { product: APP_PRODUCT_NAME }),
    message: mt('main.quit.message'),
    detail: `${detail}\n\n${mt('main.quit.detailHint')}`,
  })
  if (response === 0) return QuitChoice.StopAndQuit
  if (response === 1) return QuitChoice.KeepAndQuit
  return QuitChoice.Cancel
}

/** The confirmation flow has finished and we may really quit. `before-quit` uses it to tell the first pass from the second. */
let quitConfirmed = false
/** Flow in flight — prevents repeated ⌘Q presses from stacking up dialogs. */
let quitInFlight = false

/** Whether the quit flow has been confirmed (used by `before-quit` to let the second pass through). */
export function isQuitConfirmed(): boolean {
  return quitConfirmed
}

/**
 * Mark the quit as already decided, for a caller that has done the daemon work
 * itself.
 *
 * Only `update:installNow` uses this. electron-updater's `quitAndInstall()`
 * calls `app.quit()` internally, which lands on the `before-quit` intercept in
 * index.ts — and that would run the *confirmation* flow: it asks the daemon for
 * its connected clients, gets a refusal because we just stopped it, and shows
 * the "cannot tell whether other clients are connected" dialog. On ESC the app
 * simply keeps running, with the gateway stopped and the update not installed.
 * The handler has already made the decision and already stopped the daemon, so
 * there is nothing left to confirm.
 */
export function markQuitConfirmed(): void {
  quitConfirmed = true
}

/**
 * Undo {@link markQuitConfirmed}.
 *
 * The flag is what lets `before-quit` through unchallenged, so leaving it set
 * after a handover that did NOT quit turns every later ⌘Q into a quit that skips
 * the daemon stop and the "other clients are connected" confirmation. That is
 * reachable: on macOS `quitAndInstall` returns immediately and Squirrel quits us
 * later — or errors and never does.
 */
export function clearQuitConfirmed(): void {
  quitConfirmed = false
}

/**
 * The single entry point for "Quit Completely": stop the daemon if needed,
 * then quit the app.
 *
 * Three gestures share it — the tray's "Quit Completely", ⌘Q, and Dock
 * right-click Quit. Earlier only the tray was wired up, so even though it
 * means the same thing ("quit the app"), quitting from the Dock would
 * **silently leave the gateway running**, and the user would later wonder why
 * the port was still occupied — exactly the confusion this change removes,
 * just via a different entry point.
 * (Closing the window with ✕ is not in this list: that's hide-to-tray
 * "tuck away", not quit.)
 *
 * When only we ourselves are connected we stop it directly, without bothering
 * the user; otherwise we show the native three-way confirmation. Choosing
 * "Cancel" means **not even quitting**: the function simply returns without
 * setting `quitConfirmed`.
 * `beforeQuit` runs only after the user has confirmed the quit, and is awaited
 * before the final `app.quit()`.
 */
export async function quitWithDaemon(beforeQuit?: () => Promise<void>): Promise<void> {
  if (quitInFlight) return
  quitInFlight = true
  try {
    await runQuitFlow(beforeQuit)
  } finally {
    quitInFlight = false
  }
}

async function runQuitFlow(beforeQuit?: () => Promise<void>): Promise<void> {
  let choice: QuitChoice = QuitChoice.StopAndQuit
  try {
    const others = await otherClients()
    if (others === null) {
      choice = await askQuitChoice(null, [])
    } else if (others.length > 0) {
      choice = await askQuitChoice(
        others.length,
        others.map((client) => client.client_type),
      )
    }
  } catch (err) {
    // Even if the check itself blows up it must not block the quit — degrade to "ask once".
    mainLog.warn('[quit] client check failed', err)
    choice = await askQuitChoice(null, [])
  }

  if (choice === QuitChoice.Cancel) {
    mainLog.info('[quit] cancelled by user')
    return
  }

  // Hide the window **immediately** once we've decided to quit — the
  // remaining cliStop is where the time actually goes (on Windows it has to
  // launch the PyInstaller-built amphi.exe, and just starting that process
  // takes several seconds), and until then the UI doesn't move at all, so the
  // user thinks the click didn't register and clicks again and again. On macOS
  // the whole flow takes about 1 second so it never showed up; on Windows it
  // measurably felt "long enough to seem unresponsive".
  //
  // Placed here rather than at the top of the function: at the top we don't
  // yet know whether the user will cancel, and hiding first only to pop back
  // up looks worse; on the path that shows the confirmation dialog, the dialog
  // itself is the immediate feedback.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.hide()
  }

  // Tear down the local state machine (health-probe timer) BEFORE stopping
  // the gateway. The probe's failure branch self-heals via `void start()`,
  // and the cliStop below can run for 10+ seconds on Windows — leave the
  // timer armed and a single probe landing inside that stop window would
  // cliStart the daemon we just stopped right back up (the CLI child
  // outlives the GUI process, so quitting doesn't save us). Clearing on the
  // KeepAndQuit path too is harmless: the second before-quit pass calls
  // pythonClient.stop() again anyway.
  pythonClient.stop()

  if (choice === QuitChoice.StopAndQuit) {
    const stopped = await cliStop()
    if (!stopped) {
      // A failed stop must not block the quit: the user asked to quit, a leftover gateway is secondary (and already logged).
      mainLog.warn('[quit] cliStop failed; quitting anyway')
    }
  }
  mainLog.info('[quit] full quit', { stoppedDaemon: choice === QuitChoice.StopAndQuit })
  try {
    await beforeQuit?.()
  } catch (error) {
    mainLog.warn('[quit] browser shutdown failed; quitting anyway', error)
  }
  // Set the flag before quitting: `before-quit` fires a second time, and that
  // pass must be let through instead of intercepted into another confirmation
  // run (otherwise infinite recursion).
  quitConfirmed = true
  app.quit()
}
