/**
 * Pure version-compatibility policy between this GUI and the daemon it adopts.
 *
 * Invariants:
 *   - Pure. No I/O, no Electron, no logging — so it is fully unit-testable and
 *     callable from both the discovery fast-path and the async version backfill.
 *   - Exactly one of three verdicts, and `compatible` requires **exact string
 *     equality** in P0. Range/semver compatibility is deliberately not modelled:
 *     desktop and backend are released as one unit (the release manifest refuses
 *     to build when the two versions differ), so anything other than equality
 *     means the user is running a combination we never shipped or tested.
 *   - `unknown` is NOT a pass. A daemon that reports no version at all predates
 *     the version field entirely; treating that as compatible would let the
 *     oldest possible daemon through the very gate meant to stop it.
 *
 * Why this matters beyond Windows: neither the macOS pkg postinstall nor the
 * Linux deb postinst stops the running daemon, so on those platforms an upgrade
 * *always* leaves the previous daemon serving until something restarts it. The
 * mismatch this module detects is the default outcome there, not an edge case.
 */

/** Verdict kinds. Closed set shared with the renderer, hence the const+type pair. */
export const CompatibilityState = {
  Compatible: 'compatible',
  /** Daemon reported no version — a build older than the version field itself. */
  Unknown: 'unknown',
  Incompatible: 'incompatible',
  /**
   * OUR release manifest is missing or malformed, so there is no expectation to
   * compare against. Kept distinct from the daemon-side verdicts because the
   * user-facing answer is the opposite one: restarting the gateway can never fix
   * a broken app install, and telling someone their gateway is too old when it
   * is fine sends them to the wrong place.
   */
  ManifestUnavailable: 'manifest-unavailable',
} as const
export type CompatibilityState = (typeof CompatibilityState)[keyof typeof CompatibilityState]

/**
 * Result of comparing the packaged `requiredBackendVersion` with the version the
 * adopted daemon reports. Carries the versions so the renderer can show them
 * without re-deriving anything.
 */
export type BackendCompatibility =
  | { state: typeof CompatibilityState.Compatible }
  | { state: typeof CompatibilityState.Unknown; expected: string }
  | { state: typeof CompatibilityState.Incompatible; expected: string; actual: string }
  | { state: typeof CompatibilityState.ManifestUnavailable; detail: string }

/**
 * Compare the backend version this GUI requires with what the daemon reports.
 *
 * @param expected - `requiredBackendVersion` from the packaged release manifest
 * @param actual - version from `runtime.json` / `server status` / `GET /api/gateway/health`,
 *   or `null` when the daemon never reported one
 */
export function compareBackendVersion(
  expected: string,
  actual: string | null | undefined,
): BackendCompatibility {
  // Empty string is what an older runtime.json writes for "field present but
  // unset"; runtime-file.ts already normalizes it to null, but the health-probe
  // path can hand us one directly, so collapse it here too rather than
  // reporting an incompatibility against "".
  if (actual === null || actual === undefined || actual === '') {
    return { state: CompatibilityState.Unknown, expected }
  }
  if (actual === expected) {
    return { state: CompatibilityState.Compatible }
  }
  return { state: CompatibilityState.Incompatible, expected, actual }
}

/**
 * One-line, log-and-diagnostics summary of a blocking verdict.
 *
 * Deliberately distinguishes "the daemon is stale" from "this app's own manifest
 * is unreadable": the second is a broken install, and restarting the gateway —
 * the only action the mismatch screen offers — cannot fix it.
 */
export function describeIncompatibility(compatibility: BackendCompatibility | null): string {
  if (compatibility === null) return 'compatibility was not evaluated'
  switch (compatibility.state) {
    case CompatibilityState.Incompatible:
      return `Gateway version ${compatibility.actual} does not match this app (expects ${compatibility.expected})`
    case CompatibilityState.Unknown:
      return 'Gateway did not report a version — it predates the version check'
    case CompatibilityState.ManifestUnavailable:
      return `This installation is missing its release manifest (${compatibility.detail})`
    case CompatibilityState.Compatible:
      return 'compatible'
  }
}

/** Convenience predicate — the only state that may advance the GUI to `ready`. */
export function isCompatible(compatibility: BackendCompatibility | null): boolean {
  // `null` means "not evaluated" (development builds without a packaged
  // manifest). Those must stay usable, so an unevaluated verdict passes.
  return compatibility === null || compatibility.state === CompatibilityState.Compatible
}
