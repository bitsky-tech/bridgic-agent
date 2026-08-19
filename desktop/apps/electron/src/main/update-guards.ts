/**
 * When a check must not start.
 *
 * Split out of `auto-update.ts` because the module keeps this state in
 * module-level variables that a test cannot reach, and every defect found in
 * two review rounds landed on exactly this decision rather than on the plumbing
 * around it.
 */

import type { UpdateCheckOutcome } from './auto-update'

export interface UpdateCheckState {
  /** False in dev builds and when no feed is configured. */
  updaterEnabled: boolean
  /** A check or its download has not reached a terminal event yet. */
  checkInFlight: boolean
  /** Something is downloaded and waiting for the user to install it. */
  hasStagedUpdate: boolean
  /** `quitAndInstall` has been called and the installer handover is running. */
  handoverStarted: boolean
}

/**
 * Why this check cannot run, or null to go ahead.
 *
 * The handover guard is the subtle one. On macOS with
 * `autoInstallOnAppQuit = false`, `quitAndInstall()` hands off by calling
 * `nativeUpdater.checkForUpdates()` (MacUpdater.js:244-250): Squirrel re-fetches
 * the whole archive through a loopback proxy this process owns and
 * code-signature-verifies it, which takes up to the handover timeout. Any error
 * Squirrel raises in that window reaches us as a normal `error` event —
 * MacUpdater forwards it from a listener registered in its constructor and
 * never removed (MacUpdater.js:18-21) — and that event both clears
 * `stagedUpdate` and arms a retry.
 *
 * Without this guard the retry then starts a fresh round, and the download it
 * completes calls `MacUpdater.updateDownloaded()`, whose first act is
 * `closeServerIfExists()` (MacUpdater.js:124) — tearing down the very proxy
 * Squirrel is still reading from, while the daemon is already stopped and the
 * windows are already hidden. `handoverStarted` only clears on handover
 * timeout, so the user is left with a re-armed banner whose install button is a
 * no-op ("quitAndInstall already called; ignoring repeat").
 */
export function updateCheckBlockedBy(
  state: UpdateCheckState,
): UpdateCheckOutcome | null {
  if (!state.updaterEnabled) return 'disabled'
  // Before `checkInFlight`: during a handover that flag is false (the download
  // that preceded it reached a terminal event), so checking it first would let
  // the round through.
  if (state.handoverStarted) return 'busy'
  if (state.checkInFlight) return 'busy'
  if (state.hasStagedUpdate) return 'staged'
  return null
}
