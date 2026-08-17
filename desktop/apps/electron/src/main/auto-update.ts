/**
 * Thin wrapper around `electron-updater`.
 *
 * Wires updater events to a callback sink so the renderer can render progress /
 * "restart to update" UI, and owns the two decisions that make updates safe on
 * this product: where the feed lives, and when the installer is allowed to run.
 *
 * Disabled automatically in dev (not packaged) and when `APP_UPDATE_URL` is empty.
 *
 * Invariants:
 *   - On Windows the installer is ONLY ever launched from `update:installNow`,
 *     which stops the daemon gracefully first (see `handlers/update.ts`).
 *     `autoInstallOnAppQuit` is off there for exactly that reason; on macOS it
 *     stays on because Squirrel needs it to stage anything at all.
 *   - `hasStagedUpdate()` is the single source of truth for "there is something
 *     to install"; the `update-downloaded` event sets it and `error` clears it.
 *   - Checks repeat on a timer, and every check goes through `runCheck()` so the
 *     "already busy / already staged" guards can never be bypassed.
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, autoUpdater as squirrel } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { APP_BUNDLE_ID } from '../shared/app-meta'
import { updateLog } from './logger'
import { createRebuildDeps, prepareDifferentialSource } from './rebuild-update-zip'

export type AutoUpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; info: UpdateInfo }
  /** Rebuilding the differential source; can hold the download for ~a minute. */
  | { type: 'preparing' }
  | { type: 'not-available' }
  | { type: 'error'; message: string; code?: string }
  | { type: 'progress'; percent: number; bytesPerSecond: number }
  | { type: 'downloaded'; info: UpdateInfo }
  | { type: 'install-failed'; message: string }

export type AutoUpdateSink = (event: AutoUpdateEvent) => void

/** Why a check did or did not start. Mirrored to the renderer by `update:checkNow`. */
export type UpdateCheckOutcome = 'started' | 'busy' | 'staged' | 'disabled'

/**
 * How often a running app re-checks the feed.
 *
 * A launch-only check never reaches the users who need it most: this app is
 * tray-resident and runs unattended schedules, so an install can stay up for
 * weeks between restarts and would never learn a release exists.
 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** How often the macOS handover watchdog checks whether Squirrel got staged. */
const HANDOVER_POLL_MS = 10_000

/**
 * How long to wait for the macOS handover before declaring it failed.
 *
 * Generous on purpose: Squirrel re-fetches the whole archive through
 * electron-updater's loopback proxy and code-signature-verifies a ~300 MB
 * bundle before ShipIt is staged — measured at ~100s on this project's payload.
 */
const HANDOVER_TIMEOUT_MS = 240_000

let sink: AutoUpdateSink | undefined

/** Set by the `update-downloaded` event; read by the install handler. */
let stagedUpdate: UpdateInfo | null = null

/** True once `quitAndInstall` has been called; a second call is a no-op upstream. */
let handoverStarted = false

/**
 * True from the moment a check is dispatched until it reaches a terminal event.
 *
 * NOT the same as "a check is running": `autoDownload` is on, so a successful
 * check flows straight into a download that can outlive the next tick of the
 * timer. Only `update-not-available`, `update-downloaded` and `error` end it.
 */
let checkInFlight = false

/**
 * True once the feed has been configured successfully.
 *
 * Distinguishes "no update available" from "this build never had an updater",
 * which the Settings → About row has to tell apart: a disabled build must say so
 * rather than leave a Check button that silently does nothing.
 */
let updaterEnabled = false

export function setAutoUpdateSink(s: AutoUpdateSink): void {
  sink = s
}

function emit(e: AutoUpdateEvent): void {
  if (sink) sink(e)
}

/** True once an update has finished downloading and is waiting to be installed. */
export function hasStagedUpdate(): boolean {
  return stagedUpdate !== null
}

/** Snapshot for a UI that opened after the interesting events already fired. */
export function getUpdateStatus(): { isEnabled: boolean; stagedVersion: string | null } {
  return { isEnabled: updaterEnabled, stagedVersion: stagedUpdate?.version ?? null }
}

/**
 * Run `teardown` when Squirrel quits the app to install an update.
 *
 * REQUIRED on macOS, and the reason an update could hand over but never
 * complete: `autoUpdater.quitAndInstall()` closes the windows through a path
 * that **does not emit `before-quit`** (Electron docs on
 * `before-quit-for-update`). Every "is the app quitting?" flag in this codebase
 * is set from the `before-quit` handler, so without this the window-close guard
 * still believes the app is merely being closed, calls `preventDefault()` and
 * hides to tray — the app stays alive, and the waiting ShipIt process never gets
 * the exit it needs to swap the bundle. The update then sits there, applied only
 * if the user happens to quit manually.
 *
 * Registered even when the updater is disabled: the listener is inert until
 * Squirrel actually initiates a handover, and gating it on `updaterEnabled`
 * would just add a way to forget it.
 */
export function onQuitForUpdate(teardown: () => void): void {
  squirrel.on('before-quit-for-update', () => {
    updateLog.warn('[update] squirrel is quitting the app to install; releasing window guards')
    teardown()
  })
}

/**
 * Ask the feed for a newer version, unless a previous round is still open.
 *
 * Both guards matter on the timer path. Re-checking while a download is in
 * flight makes electron-updater fetch the same payload a second time, and
 * re-checking once something is staged would re-download an update the user has
 * already been offered but not yet chosen to install.
 */
function runCheck(reason: 'launch' | 'timer' | 'manual'): UpdateCheckOutcome {
  if (!updaterEnabled) {
    updateLog.info(`[update] ${reason} check skipped: updater is disabled in this build`)
    return 'disabled'
  }
  if (checkInFlight) {
    updateLog.info(`[update] ${reason} check skipped: a check or download is still in flight`)
    return 'busy'
  }
  if (hasStagedUpdate()) {
    updateLog.info(`[update] ${reason} check skipped: an update is already staged`)
    return 'staged'
  }

  checkInFlight = true
  autoUpdater.checkForUpdates().catch((err) => {
    // The `error` event normally clears the flag, but a synchronous rejection
    // (malformed feed URL, DNS failure before the request is made) can arrive
    // without one — and a stuck flag would silence every later tick.
    checkInFlight = false
    updateLog.warn('[update] checkForUpdates failed', err)
  })
  return 'started'
}

/**
 * Run a check on the user's behalf (Settings → About → Check for updates).
 *
 * Goes through the same guards as the timer: a manual click during a download
 * must not start a second one just because a human asked.
 */
export function requestManualCheck(): UpdateCheckOutcome {
  return runCheck('manual')
}

/**
 * Make the download as small as it can be, then start it.
 *
 * Called from `update-available` because `autoDownload` is off. The rebuild has
 * to happen here rather than at launch: it is only worth ~44 s of CPU once we
 * know an update actually exists, and on the overwhelmingly common path
 * (`needsRebuild` false, because a previous download already left an
 * `update.zip`) it costs nothing at all.
 *
 * Deliberately does NOT touch `checkInFlight`. That flag is set by `runCheck`
 * and cleared only by the three terminal events; a rebuild happening in between
 * just makes the in-flight window longer, which is exactly what should keep the
 * 4-hourly timer from starting a second round on top of this one.
 */
async function beginDownload(): Promise<void> {
  try {
    // Never throws — a failed rebuild is reported by returning false and only
    // means this download is a full one.
    await prepareDifferentialSource(
      createRebuildDeps(
        (message) => updateLog.info(`[update] ${message}`),
        (message, error) => updateLog.warn(`[update] ${message}`, error),
      ),
      () => emit({ type: 'preparing' }),
    )
    await autoUpdater.downloadUpdate()
  } catch (error) {
    // `downloadUpdate()` both rejects AND dispatches `error` (AppUpdater.js),
    // and our own `error` handler is what clears `checkInFlight` and notifies
    // the renderer. Emitting here too would report one failure twice; this
    // catch exists to keep the rejection from surfacing as an unhandled one.
    updateLog.warn('[update] download did not start', error)
  }
}

/**
 * Configure the updater, check once, then keep checking every
 * {@link CHECK_INTERVAL_MS}. No-op in dev builds and when no feed is configured.
 */
export function startUpdateChecks(): void {
  if (!app.isPackaged) {
    updateLog.info('[update] dev build, skipping update check')
    return
  }
  const feedUrl = process.env.APP_UPDATE_URL
  if (!feedUrl) {
    updateLog.info('[update] APP_UPDATE_URL not set, skipping')
    return
  }

  autoUpdater.logger = updateLog
  // Off so `update-available` can run the differential-source rebuild BEFORE
  // any bytes are fetched (see the handler below). With `true`, electron-updater
  // starts downloading straight out of the check, and on a machine installed
  // from the .pkg that download is the full 222 MB — the rebuild would finish
  // long after the thing it was meant to shrink.
  //
  // `checkInFlight` still spans check + download: nothing clears it between the
  // two, and the only paths that do clear it (`update-not-available`, `error`,
  // `update-downloaded`) are unchanged. The rebuild simply widens the window.
  autoUpdater.autoDownload = false

  // MUST stay false on every platform. Installing is a decision, and quitting is
  // not a decision to install.
  //
  // Windows: `true` installs on quit via `install(isSilent = true, …)`, which
  // spawns the NSIS installer with `--updated /S`. Its built-in "app is running"
  // sweep matches every process whose image path starts with the install
  // directory and `Stop-Process -Force`s them — including
  // `<install>\resources\bin\amphi.exe`. Quitting from the tray would hard-kill
  // an agent mid-turn.
  //
  // Linux: worse. DebUpdater's install is a synchronous `spawnSync` of
  // `pkexec`/`sudo dpkg -i` (LinuxUpdater.js), so "quit" would pop a root
  // password prompt, swap the systemd --user unit under a running agent, and —
  // with `isForceRunAfter` false on the quit path — never bring the app back.
  //
  // macOS: safe to leave off. MacUpdater.quitAndInstall() has an explicit
  // `if (!this.autoInstallOnAppQuit) { this.nativeUpdater.checkForUpdates() }`
  // branch (MacUpdater.js:244), so Squirrel is handed the archive lazily at
  // handover time instead of at download time. Slower, not broken.
  autoUpdater.autoInstallOnAppQuit = false

  // We only ever publish the full NSIS installer, never the `nsisWeb` variant.
  // Left at its default `false`, electron-updater keeps a code path alive that
  // would accept a manifest carrying `packageInfo` and fetch the real payload
  // from somewhere else at install time (NsisUpdater.js:40) — and it logs a
  // warning on every single download telling us to turn it off. Setting it
  // makes a web-installer manifest a hard error instead of a silent second
  // download, and matches the default upstream says it will adopt.
  autoUpdater.disableWebInstaller = true

  // The packaged `app-update.yml` carries `publish.url` from
  // electron-builder.yml, which is a placeholder — and `APP_UPDATE_URL` is only
  // inlined into this file by esbuild (`scripts/electron-build-main.ts`), so
  // without this call it acts as an on/off switch that never affects where the
  // updater actually looks. Setting the feed explicitly is what makes the two
  // agree.
  // Two feed shapes share `APP_UPDATE_URL` so that adding one does not require
  // touching the esbuild define list in `scripts/electron-build-main.ts`:
  //   https://…            → generic (a plain directory of artifacts)
  //   github:owner/repo    → GitHub releases, addressed by tag
  //   github:owner/repo?private → same, but authenticated
  //
  // Why the GitHub shape matters beyond convenience: differential download
  // needs the PREVIOUS version's blockmap, and `Provider.js::getBlockMapFiles`
  // derives its URL by substituting the old version string into the new
  // asset's path. That only resolves when the path carries the version —
  // true for `releases/download/<tag>/…`, false for a fixed
  // `releases/latest/download/…`, which 404s and forces a full download.
  //
  // `?private` makes electron-updater pick PrivateGitHubProvider, which reads
  // the token from the runtime env only (`providerFactory.js:24`), so no
  // credential is ever baked into the package.
  const GITHUB_SCHEME = 'github:'
  let feed: Parameters<typeof autoUpdater.setFeedURL>[0]
  if (feedUrl.startsWith(GITHUB_SCHEME)) {
    const [slug, query] = feedUrl.slice(GITHUB_SCHEME.length).split('?')
    const [owner, repo] = (slug ?? '').split('/')
    if (!owner || !repo) {
      updateLog.error(`[update] malformed github feed "${feedUrl}"; expected github:owner/repo`)
      return
    }
    feed = { provider: 'github', owner, repo, private: query === 'private' }
  } else {
    feed = { provider: 'generic', url: feedUrl }
  }

  if (feed.provider === 'github' && feed.private) {
    // Diagnostic ONLY — must never disable the updater. A missing token is a
    // misconfiguration of the local test setup, not a property of the build,
    // and routing it into the "updates are disabled in this build" state told
    // the user something plainly false about their install. electron-updater's
    // own 404 already ends with "Please double check that your authentication
    // token is correct", so the cause was never actually hidden; this line
    // only makes it greppable next to our own logs.
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
      updateLog.warn(
        '[update] feed declares a private repo but neither GH_TOKEN nor GITHUB_TOKEN is set; ' +
          'checks will fail with a 404 from anonymous access',
      )
    }
    // A private release asset is addressed as `/releases/assets/{id}` — no
    // version string in the path. `Provider.js::getBlockMapFiles` builds the
    // previous version's blockmap URL by substituting the old version INTO
    // that path, so with nothing to substitute it produces a bogus URL that
    // can only fail. Measured cost of letting it try: 2m27s of dead air before
    // the fallback to a full download. Public feeds keep differential enabled.
    autoUpdater.disableDifferentialDownload = true
    updateLog.info('[update] differential download disabled: private feeds have no versioned asset URL')
  }

  try {
    autoUpdater.setFeedURL(feed)
  } catch (err) {
    updateLog.error('[update] setFeedURL failed; update checks disabled', err)
    return
  }
  updaterEnabled = true

  autoUpdater.on('checking-for-update', () => emit({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    // Reset the progress-logging watermark: without this a second download in
    // the same session logs nothing, since its percent starts below the decile
    // the previous one finished at.
    loggedDecile = -1
    emit({ type: 'available', info })
    // `autoDownload` is off, so nothing downloads until this is called.
    void beginDownload()
  })
  autoUpdater.on('update-not-available', () => {
    checkInFlight = false
    emit({ type: 'not-available' })
  })
  autoUpdater.on('error', (err) => {
    checkInFlight = false
    // Clear the staged flag: a post-download failure (evicted cache, checksum
    // mismatch) otherwise leaves the banner offering an install that would stop
    // the daemon and then find nothing to install.
    stagedUpdate = null
    // Forward `code`: electron-updater keeps the machine-readable reason there
    // (builder-util-runtime's `newError`), and the message alone cannot be
    // matched on without string-sniffing a localized sentence.
    emit({ type: 'error', message: err.message, code: (err as { code?: string }).code })
  })
  // Log once per 10% rather than per event: a 222MB download emits thousands of
  // progress events, but with none of them logged there is no way to tell a
  // stalled download from a slow one after the fact (measured: 285KB/s on the
  // first leg of a real transfer, so this window is minutes long).
  let loggedDecile = -1
  autoUpdater.on('download-progress', (p) => {
    const decile = Math.floor(p.percent / 10)
    if (decile > loggedDecile) {
      loggedDecile = decile
      updateLog.info(
        `[update] downloading ${Math.round(p.percent)}% (${Math.round(p.bytesPerSecond / 1024)} KB/s)`,
      )
    }
    emit({ type: 'progress', percent: p.percent, bytesPerSecond: p.bytesPerSecond })
  })
  autoUpdater.on('update-downloaded', (info) => {
    checkInFlight = false
    stagedUpdate = info
    emit({ type: 'downloaded', info })
  })

  runCheck('launch')
  // Never cleared: the interval lives exactly as long as the process, and the
  // guards inside runCheck() are what keep a tick from doing damage.
  setInterval(() => runCheck('timer'), CHECK_INTERVAL_MS)
}

/**
 * True once ShipIt — Squirrel's out-of-process installer — is up and waiting for
 * this process to exit.
 *
 * Detected by the mtime of ShipIt's own stderr log, which it writes to the
 * moment it starts ("Detected this as an install request"). Deliberately NOT the
 * `update.XXXXXXX` directory next to it: that one appears as soon as Squirrel
 * finishes *unpacking*, which is well before ShipIt exists. Treating unpack as
 * "staged" made the watchdog quit the app mid-handover, so nothing was left to
 * swap the bundle — the app just disappeared and the update silently did not
 * apply.
 *
 * Read from disk because Squirrel offers no API for this: the `update-downloaded`
 * event that would tell us is exactly the one observed to go missing.
 */
function isShipItWaiting(since: number): boolean {
  const shipItLog = path.join(
    app.getPath('home'),
    'Library/Caches',
    `${APP_BUNDLE_ID}.ShipIt`,
    'ShipIt_stderr.log',
  )
  try {
    // Must be from THIS handover: the log survives previous installs.
    return statSync(shipItLog).mtimeMs >= since
  } catch {
    return false
  }
}

/**
 * Force the macOS handover to a conclusion, one way or the other.
 *
 * `quitAndInstall()` returning does NOT mean the app is going to quit: on macOS
 * electron-updater waits for a native `update-downloaded` that has been observed
 * never to arrive, leaving the app alive with its gateway already stopped and
 * ShipIt waiting forever. Rather than trusting that event, poll the one piece of
 * ground truth Squirrel leaves on disk:
 *
 *   - staged  → quit ourselves; that exit is all ShipIt was waiting for
 *   - timeout → tell the user, and undo the quit-confirmed flag so the next ⌘Q
 *               behaves normally instead of skipping the daemon checks
 */
function watchMacHandover(onFailure: (message: string) => void): void {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    if (isShipItWaiting(startedAt)) {
      clearInterval(timer)
      updateLog.warn('[update] ShipIt is waiting but we are still alive; quitting so it can finish')
      app.quit()
      return
    }
    if (Date.now() - startedAt < HANDOVER_TIMEOUT_MS) return

    clearInterval(timer)
    handoverStarted = false
    updateLog.error('[update] handover timed out: ShipIt never started')
    onFailure('timeout')
  }, HANDOVER_POLL_MS)
}

/**
 * Quit and hand over to the installer.
 *
 * Only called from `handlers/update.ts`, after the daemon has been stopped.
 */
export function quitAndInstall(onHandoverFailed?: () => void): void {
  // Guard against a second call. electron-updater's own `install()` refuses a
  // repeat by returning false WITHOUT dispatching an error
  // (BaseUpdater.js: "install call ignored"), so a second click would look like
  // success to the caller while nothing happened — after the daemon had already
  // been stopped for it.
  if (handoverStarted) {
    updateLog.warn('[update] quitAndInstall already called; ignoring repeat')
    return
  }
  handoverStarted = true

  // (isSilent, isForceRunAfter) = (true, true) — Windows/Linux only; MacUpdater
  // takes no arguments.
  //
  // Silent matters because this is an *assisted* installer (`oneClick: false`):
  // app-builder-lib's installSection.nsh relaunches the app after install only
  // when `isForceRun && Silent`. With `isSilent = false` the user would get the
  // full wizard — welcome page and all — for an update they already confirmed,
  // and the relaunch would depend on them leaving the finish-page checkbox
  // ticked.
  //
  // Consequence to keep in mind when touching build/installer.nsh: every
  // MessageBox there MUST carry a `/SD` default, because NSIS still shows
  // message boxes under `/S`.
  autoUpdater.quitAndInstall(true, true)

  // macOS never hands over synchronously — MacUpdater kicks off a fresh Squirrel
  // fetch and only quits once it sees a native `update-downloaded`. Racing that
  // with a 1s `app.quit()` would abort the install, so this platform gets the
  // watchdog instead: it waits for Squirrel to actually stage, then quits.
  if (process.platform === 'darwin') {
    watchMacHandover((message) => {
      // Order matters: the caller hid the windows before stopping the daemon, so
      // the card below would otherwise be painted on something invisible — which
      // to the user is indistinguishable from the freeze this watchdog exists to
      // report.
      onHandoverFailed?.()
      emit({ type: 'install-failed', message })
    })
    return
  }
  // Belt and braces for the platforms where quitAndInstall hands over
  // synchronously.
  setTimeout(() => {
    if (BrowserWindow.getAllWindows().length > 0) app.quit()
  }, 1000)
}
