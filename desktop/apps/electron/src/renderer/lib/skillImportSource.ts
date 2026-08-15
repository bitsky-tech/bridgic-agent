/**
 * Remote-source detection for Skill remote import (pure function).
 *
 * Classifies the URL the user pasted into the "remote address" input into one of the
 * supported remote sources, so the import wizard can render the "recognized as X" hint and
 * decide whether the Import button is clickable. GitHub and skills.sh pages are both
 * importable (`importable`), clawhub is display-only — aligned with the backend's
 * `_is_github_url` / `_is_skills_sh_url`.
 *
 * Only lightweight detection happens here; the real owner/repo/ref/path parsing and
 * validation happens in the backend scan — an invalid URL gets a 400 back from scan and is
 * surfaced inside the modal. Side-effect free, no DOM dependency, unit-testable.
 */

/** Remote source kinds (closed set, §4.11). */
export type SkillRemoteSourceKind = 'github' | 'skillsSh' | 'clawhub' | 'unknown'

/** The result of detecting one remote address. */
export interface SkillRemoteSource {
  kind: SkillRemoteSourceKind
  /** Locale-neutral fallback label — the UI localizes known kinds through the
   *  `skill.import.pick.source.*` catalog keys and reads this only for
   *  `unknown` sources (where it is the bare hostname). Never display copy. */
  label: string
  /** Review source-row badge (`GitHub` / `skills.sh` …); a single source keeping call sites from hardcoding it. */
  badge: string
  /** Whether this source can currently actually be imported (GitHub / skills.sh pages). */
  importable: boolean
}

/** host → description mapping for the known remote sources. Order-independent (exact host match). */
const KNOWN_SOURCES: ReadonlyArray<{
  host: string
  kind: SkillRemoteSourceKind
  badge: string
  importable: boolean
}> = [
  { host: 'github.com', kind: 'github', badge: 'GitHub', importable: true },
  { host: 'skills.sh', kind: 'skillsSh', badge: 'skills.sh', importable: true },
  { host: 'clawhub.ai', kind: 'clawhub', badge: 'ClawHub', importable: false },
]

/**
 * Detect the source of a remote address string.
 *
 * @param input User input (may carry leading/trailing whitespace).
 * @returns `null` for an empty string / a non-http(s) URL (the UI shows no detection hint
 *   then); a valid http(s) URL that hits a known host returns the matching source,
 *   otherwise `kind: 'unknown'` (with its host as the label).
 */
export function detectSkillRemoteSource(input: string): SkillRemoteSource | null {
  const raw = input.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const known = KNOWN_SOURCES.find((s) => s.host === host)
  if (known)
    return { kind: known.kind, label: known.badge, badge: known.badge, importable: known.importable }
  return { kind: 'unknown', label: host, badge: host, importable: false }
}
