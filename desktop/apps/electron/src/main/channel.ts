/**
 * Runtime channel — lets the development GUI and the installed production EXE
 * run at the same time.
 *
 * Background: the two used to share one Electron profile, and therefore one
 * single-instance lock (`requestSingleInstanceLock()` in `deep-link.ts`).
 * Whichever started second failed to acquire the lock and called `app.quit()`
 * — showing up as "the terminal says electron started, but the window never
 * appears". With the production build installed on the machine and living in
 * the tray, `bun run dev` could never come up.
 *
 * The isolation mechanism is swapping the **Electron userData** directory: the
 * single-instance lock is scoped to that directory (a SingletonSocket inside
 * it on macOS/Linux, a mutex derived from the path on Windows), so swapping it
 * gives each channel its own lock — they no longer exclude each other, while
 * each still keeps "one instance per channel".
 *
 * Invariants:
 *   - `applyDesktopChannel()` must be called before **any** code that touches
 *     userData — the single-instance lock, BrowserWindow, session, extension
 *     registration. `index.ts` places it at the earliest position, right next
 *     to `loadShellEnv()`, for the same reason that one "must take effect
 *     before the remaining imports".
 *   - Only the two allowlisted values are accepted. An invalid value falls
 *     back to production with a warning; we **never** splice an unvalidated
 *     environment-variable value into a path.
 *   - Production (the packaged artifact) does not set this variable, so it uses
 *     the Electron default profile — the user-data location of installed
 *     builds is not affected by this change in any way.
 *
 * Non-obvious deps:
 *   - Desktop business data and logs are **not** isolated by this module; they
 *     go through the `AMPHI_USER_DIR` environment variable in
 *     `paths.ts :: amphiUserDir()` (passed in by the dev launcher). The two
 *     mechanisms are decoupled: even if the launcher only passes the channel
 *     and not AMPHI_USER_DIR, the single-instance lock is still isolated.
 *   - Uses `console` rather than `mainLog`: this module has to run before the
 *     logger finishes `initialize()` (same as the migration warning in
 *     `paths.ts`).
 */

import { app } from 'electron'
import path from 'node:path'
import { amphiUserDir } from './paths'

/** Runtime channel — a closed set, declared as a const object + same-named type per §4.11. */
export const DesktopChannel = {
  Production: 'production',
  Development: 'development',
} as const
export type DesktopChannel = (typeof DesktopChannel)[keyof typeof DesktopChannel]

const CHANNEL_ENV = 'AMPHI_DESKTOP_CHANNEL'

/** Sub-directory name for the Electron profile on the development channel (nested under `amphiUserDir()`). */
const DEV_PROFILE_DIRNAME = 'electron'

/**
 * The current process's channel.
 *
 * Unset → production (the normal case for a packaged artifact). Set but not
 * allowlisted → also falls back to production with a warning: a typo in a dev
 * variable should not stop a GUI from starting, and silently accepting an
 * unknown value would splice it into the profile path.
 */
export function resolveDesktopChannel(): DesktopChannel {
  const raw = process.env[CHANNEL_ENV]
  if (!raw) return DesktopChannel.Production
  if (raw === DesktopChannel.Production || raw === DesktopChannel.Development) return raw
  console.warn(
    `[channel] ignoring unknown ${CHANNEL_ENV}="${raw}" — falling back to ${DesktopChannel.Production}`,
  )
  return DesktopChannel.Production
}

/**
 * Pin down the Electron profile according to the channel and return the
 * channel in effect.
 *
 * Only development changes `userData`; production leaves the Electron default
 * path untouched. Must be called before any code that touches userData (see
 * the invariants in the file header).
 */
export function applyDesktopChannel(): DesktopChannel {
  const channel = resolveDesktopChannel()
  if (channel === DesktopChannel.Development) {
    const profile = path.join(amphiUserDir(), DEV_PROFILE_DIRNAME)
    app.setPath('userData', profile)
    console.log(`[channel] development — electron profile: ${profile}`)
  }
  return channel
}
