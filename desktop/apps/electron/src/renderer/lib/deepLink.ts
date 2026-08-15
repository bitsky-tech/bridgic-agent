/**
 * Parse `amphi://` deep links into typed navigation targets.
 *
 * Pure — no atoms, no window; unit-tested in isolation (§4.12 spirit: URLs
 * arrive from the OS / notification clicks, i.e. an external boundary).
 * Unknown hosts/shapes return null so future link kinds (e.g. the Codex
 * OAuth callback) pass through this parser without breaking navigation.
 */

export type DeepLinkTarget =
  /** A scheduled run's log drawer: `amphi://schedule-run/<scheduleId>/<sessionId>`. */
  | { kind: 'schedule-run'; scheduleId: string; sessionId: string }

/** Parse an `amphi://…` URL; null = not a navigation link (ignore it). */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'amphi:') return null
  // `amphi://schedule-run/a/b` → host 'schedule-run', pathname '/a/b'.
  if (parsed.host === 'schedule-run') {
    const segments = parsed.pathname.split('/').filter(Boolean)
    const [scheduleId, sessionId] = segments
    if (segments.length !== 2 || !scheduleId || !sessionId) return null
    return { kind: 'schedule-run', scheduleId, sessionId }
  }
  return null
}
