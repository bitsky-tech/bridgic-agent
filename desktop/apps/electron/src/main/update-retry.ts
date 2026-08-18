/**
 * When to try an update again after it failed.
 *
 * Without this a failure costs the user the full check interval. The updater
 * clears its in-flight flag on `error` and then nothing happens until the next
 * four-hourly tick — so a laptop that slept mid-download, or briefly changed
 * networks, sits on a stale version for hours despite being online the whole
 * time. On macOS that used to mean re-fetching 222 MB from zero; even with the
 * differential source in place the wasted wait is the same.
 *
 * The ladder is short on purpose. It exists to bridge a transient outage, not
 * to replace the regular schedule: if fifteen minutes of retries have not
 * worked, the next scheduled check is a better place to try than a loop that
 * lives as long as this tray-resident process does.
 */

/** Delays before each retry, in order. Exhausting them hands back to the timer. */
const RETRY_LADDER_MS = [60_000, 120_000, 240_000, 480_000]

/**
 * Failures that will come out identical however many times they are retried.
 *
 * Everything NOT listed here is treated as transient, which is the deliberate
 * direction to be wrong in: a missed retry costs the user hours of staleness,
 * while a pointless one costs a bounded handful of requests. The list therefore
 * holds only codes that describe the *release or the config* being wrong —
 * never the transfer.
 *
 * Codes come from electron-updater's `newError` (builder-util-runtime keeps the
 * machine-readable reason on `error.code`; the message alone is not matchable
 * without string-sniffing a localized sentence).
 */
const PERMANENT_FAILURES = new Set([
  // No artifact for this CPU in the feed — what Intel machines hit before the
  // arm64/x64 feeds were merged. Settings → About has dedicated copy for it.
  'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
  'ERR_UPDATER_ASSET_NOT_FOUND',
  // The downloaded installer is not signed by this app's publisher (Windows).
  // Retrying would re-download the same rejected bytes.
  'ERR_UPDATER_INVALID_SIGNATURE',
  // The packaged updater configuration itself is wrong; only a new build fixes
  // these.
  'ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION',
  'ERR_UPDATER_UNSUPPORTED_PROVIDER',
  'ERR_UPDATER_INVALID_CHANNEL',
  'ERR_UPDATER_WEB_INSTALLER_DISABLED',
])

/** Whether a failed check or download is worth another attempt soon. */
export function isRetriableUpdateError(code: string | undefined): boolean {
  return code === undefined || !PERMANENT_FAILURES.has(code)
}

/**
 * How long to wait before retry number `attempt` (0-based), or null once the
 * ladder is spent and the regular interval should take over again.
 */
export function retryDelayMs(attempt: number): number | null {
  return RETRY_LADDER_MS[attempt] ?? null
}

/**
 * Take one step down the ladder: what to wait, and what counter to keep.
 *
 * Exhausting the ladder rewinds the counter to zero. Leaving it at the top
 * would arm the backoff exactly once for the lifetime of the process — a feed
 * that is down long enough to burn all four rungs would then give every later
 * transient failure no retry at all, which is the behaviour this module exists
 * to replace. Rewinding does not make the retries unbounded: a spent ladder
 * still returns a null delay, so this round stops and the regular interval
 * takes over; only a *later* round gets the rungs back.
 */
export function advanceRetry(attempt: number): {
  delayMs: number | null
  nextAttempt: number
} {
  const delayMs = retryDelayMs(attempt)
  return delayMs === null
    ? { delayMs: null, nextAttempt: 0 }
    : { delayMs, nextAttempt: attempt + 1 }
}
