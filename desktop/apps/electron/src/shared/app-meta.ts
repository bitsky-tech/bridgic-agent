/**
 * Project naming constants — single source of truth.
 *
 * Project-specific names MUST live in this one file and be imported
 * everywhere else. The CI naming check (`scripts/check-naming.sh`)
 * enforces that bare literals like `"amphi"` / `"Amphi Desktop"` / `"AmphiLoop"` do
 * not appear scattered in source code.
 *
 * Two namespaces are kept distinct:
 *
 *   - **Frontend (this app)**: display name `Bridgic Agent`, slug `amphi`.
 *     The 2026-08 rename moved the *user-visible* name to `Bridgic Agent`
 *     (window title, installer, About dialog) while every *identifier* stayed
 *     on `amphi` — CLI name, deep-link scheme, `~/.bridgic/amphi/`, the
 *     Windows Run value, npm package names. That split is deliberate: the
 *     identifiers are runtime contracts held by already-installed copies,
 *     the OS and the backend, so renaming them would orphan existing
 *     installs rather than just relabel them.
 *     Before 2026-07 this side simultaneously carried three sets of names —
 *     `Amphi Desktop` (window / installer), `amphi-desktop` (directories),
 *     and `AmphiLoop` (menu bar / sidebar / home page); those are gone.
 *   - **Backend**: the same product. Its Python distribution is
 *     `bridgic-agent` and its environment variables use the matching
 *     `BRIDGIC_AGENT_*` prefix, so the name lines up on both sides.
 *     Two identifiers still do not: `amphi` is the CLI, and `AmphiAgent` is
 *     both the on-disk runtime directory (registration lives at
 *     `~/.bridgic/AmphiAgent/runtime.json`) and the Python class name of the
 *     agent itself. Neither is a product name — they are contracts held by
 *     installed copies, the OS and the packaging toolchain, so they are
 *     matched, not renamed. Prose that names the running backend should say
 *     "the Bridgic Agent daemon".
 *
 * Mirror these constants in any non-TypeScript location that needs
 * them (installer scripts, build config). Never re-declare values.
 */
import type { ResolvedLocale } from './locale'

// ─── Frontend (Electron app) identity ──────────────────────────────────────

/** Product display name — used by electron-builder, window title, About dialog. */
export const APP_PRODUCT_NAME = 'Bridgic Agent'

/** Short URL-safe slug — directory names, package names. */
export const APP_SLUG = 'amphi'

/**
 * Shared family-root basename under `~/` for the whole bridgic suite: the
 * desktop (`~/.bridgic/amphi/`) and the daemon (`~/.bridgic/AmphiAgent/`)
 * live side by side under it. Centralized so any code needing the family root
 * (e.g. the `fs:writeFile` path guard) doesn't re-hardcode `'.bridgic'`.
 */
export const BRIDGIC_DIR_BASENAME = '.bridgic'

/**
 * Stable OS-level application identity.
 *
 * This is intentionally not a display name: electron-builder uses it as the
 * cross-platform `appId`, macOS uses it as the bundle identifier, and packaged
 * Windows builds use it as their AppUserModelID for taskbar / notification
 * identity. User-facing surfaces continue to use `APP_PRODUCT_NAME`.
 */
export const APP_BUNDLE_ID = 'ai.bridgic.agent'

/**
 * Custom URL scheme (`amphi://…`) — the Codex OAuth success page uses it to
 * pull the token back into the app.
 *
 * **Must match three other places character for character**; a mismatch in any
 * one of them makes deep links fail silently:
 *   - `protocols.schemes` in `electron-builder.yml` (written into Info.plist /
 *     the NSIS registry entries)
 *   - the backend's `src/amphi_service/protocol/llms/_codex_oauth.py::APP_SCHEME`
 *   - `.env`'s `APP_DEEPLINK_SCHEME` (an optional override, see below)
 *
 * Why this constant exists: the only source used to be the gitignored `.env`,
 * with a single bare literal in `index.ts` as the fallback. When a dev
 * machine's `.env` was stale (still the old scheme after a rename), the
 * artifact would bake in the old value while Info.plist registered the new one
 * — macOS's `open-url` branch doesn't validate the scheme, so it can't be
 * caught locally; only Windows/Linux argv prefix matching fails: the URL is
 * dropped, the window merely gets focused, and the token never arrives. Same
 * class of trap as `APP_NAME`, plugged here as well.
 */
export const APP_DEEPLINK_SCHEME = 'amphi'

/** App version — keep in sync with root and apps/electron package.json. */
export const APP_VERSION = '0.1.2'

/** GitHub page used for user-confirmed issue reports from the desktop app. */
export const APP_NEW_ISSUE_URL = 'https://github.com/bitsky-tech/bridgic-agent/issues/new'

/** Full privacy notice linked from the desktop privacy settings. */
export const APP_PRIVACY_NOTICE_URL =
  'https://github.com/bitsky-tech/bridgic-agent/blob/main/PRIVACY.md'

/**
 * Base directory (under `~/`) where the desktop app stores everything it
 * owns: `gui-settings.json` + `logs/` today, possibly caches /
 * per-session artifacts in the future. Lives under `~/.bridgic/` so the
 * desktop and the daemon (`~/.bridgic/AmphiAgent/`) share one family dir.
 *
 * Resolved via `main/paths.ts :: amphiUserDir()`, which also performs a
 * one-time migration of the legacy `~/.amphi-desktop/`. `AMPHI_USER_DIR`
 * env var fully overrides the location (useful for tests + dev sandboxes
 * that want to avoid polluting the real dir).
 */
export const AMPHI_USER_DIR_BASENAME = `${BRIDGIC_DIR_BASENAME}/${APP_SLUG}`

/** Pre-2026-06 root (`~/.amphi-desktop/`) — referenced ONLY by the
 *  one-time migration in `main/paths.ts`. Never write new files here.
 *
 *  The 2026-07 `amphi-desktop` → `amphi` rename is deliberately **not**
 *  registered here: the product had not shipped yet, so there is no install
 *  that needs migrating. If a dev machine still has `~/.bridgic/amphi-desktop/`
 *  lying around, just `mv` it — writing migration code for a user base that
 *  doesn't exist only leaves maintenance surface behind. */
export const AMPHI_USER_DIR_LEGACY_BASENAME = '.amphi-desktop'

/** File name (relative to amphi user dir) holding the GuiSettings blob. */
export const GUI_SETTINGS_FILE_NAME = 'gui-settings.json'

/** File name holding the consent-bound random analytics installation ID. */
export const TELEMETRY_STATE_FILE_NAME = 'telemetry-state.json'

/**
 * Stem of the file name offered when an oversized issue report is exported to
 * disk (`<stem>-<yyyymmdd-hhmm>.md`, or bare `<stem>.md` as the main-process
 * fallback).
 *
 * Centralized because it is USER-VISIBLE: it lands in the save dialog and then
 * in the user's Downloads folder. It spelled `AmphiAgent-feedback` until the
 * rename — a retired product name shipped straight into a file the user keeps.
 * The renderer and the main process each had their own literal, so the two
 * could drift independently and neither was covered by `check-naming.sh`
 * (its retired-name pattern does not include `AmphiAgent`, which is a live
 * identifier elsewhere).
 */
export const ISSUE_REPORT_FILE_STEM = 'bridgic-agent-feedback'

/** File name holding per-session composer drafts (unsent input w/ @ chips). */
export const DRAFTS_FILE_NAME = 'drafts.json'

/** File name holding per-session staged spec comments (unsent selection comments). */
export const SPEC_COMMENTS_FILE_NAME = 'spec-comments.json'

/** File name holding the workflow-market payload cached from showcase.bridgic.ai,
 *  together with when it was fetched. Unlike the two blobs above this one is not
 *  keyed by session -- it holds a single global entry. */
export const MARKET_CACHE_FILE_NAME = 'market-cache.json'

/** Session-workspace-relative path of the requirements spec markdown. Maintained
 *  by the daemon's clarify persona; read via daemon GET /files and written via
 *  `fs:writeFile`. Centralized so the path guard + renderer don't re-hardcode it. */
export const SESSION_TASK_FILE_REL = '.work/.build/task.md'

// ─── Licence & copyright ───────────────────────────────────────────────────
//
// The repo ships the GNU Affero General Public License v3.0 (`/LICENSE`),
// unmodified.
//
// The copyright notice below is still rendered by Settings → About: AGPL §5(a)
// requires modified versions to carry appropriate legal notices, so these remain
// contractual strings rather than decoration.
//
// Commercial licensing sits alongside the AGPL as the second half of a dual
// licence: the copyleft terms are what a buyer is paying to be released from.

/** Where to ask for a commercial licence (the non-AGPL half of the dual licence). */
export const COMMERCIAL_LICENSE_CONTACT = 'bd@bitsky-tech.com'

/** Where to report security vulnerabilities privately. Mirrors `/SECURITY.md`,
 *  which also offers GitHub's private advisory flow. */
export const SECURITY_CONTACT = 'security@bitsky-tech.com'

/** Privacy requests and general feedback. Mirrors `/PRIVACY.md` §14.
 *
 *  NOT for bug reports — those go to `APP_NEW_ISSUE_URL` so they stay public and
 *  trackable. The About page labels the two rows accordingly. */
export const FEEDBACK_CONTACT = 'feedback@bitsky-tech.com'

/** Copyright holder. Mirrors `/NOTICE`, NOT `/LICENSE` — the latter is the
 *  unmodified FSF text of the AGPL and carries no project copyright line at
 *  all (the only `Copyright` in it belongs to the Free Software Foundation,
 *  for the licence document itself). `/NOTICE` is where this project asserts
 *  its own copyright, so that is the file to keep these two in step with. */
export const COPYRIGHT_HOLDER = 'BitSky-Tech Inc.'

/** Copyright year. Mirrors `/NOTICE` — see the note above. */
export const COPYRIGHT_YEAR = '2026'

/**
 * Public repository — rendered by Settings → About as the AGPL §6 source offer,
 * and the base of `APP_NEW_ISSUE_URL` / `APP_PRIVACY_NOTICE_URL` above.
 *
 * This is where the source is published. Until the repository is actually
 * public at that address, all three URLs 404 for anyone outside the org —
 * which is a reason to finish publishing, not a reason to repoint the
 * constants at whatever private repository currently holds the code. The
 * About page renders this as an AGPL §6 offer, and an offer pointing at
 * something a reader cannot reach is not an offer.
 *
 * Auto-update does NOT read this: the feed comes from `APP_UPDATE_URL`, which CI
 * derives from the repository the workflow runs in.
 */
export const PUBLIC_REPO_URL = 'https://github.com/bitsky-tech/bridgic-agent'

// ─── Community ─────────────────────────────────────────────────────────────
//
// Same rule as the addresses above: these live here rather than in the i18n
// catalogs because they are identical in every language, and a translator
// editing one would silently repoint a link instead of rewording it. Only the
// row labels are translated.

/** X account. One account for the whole product, so it is not per-language. */
export const SOCIAL_X_URL = 'https://x.com/bridgic'

/** Link text for the row above — the handle, not the bare URL. */
export const SOCIAL_X_HANDLE = '@bridgic'

/**
 * Discord invite, per UI language. The server runs a Chinese channel alongside
 * the English one, and dropping someone into the half they cannot read is worse
 * than offering no link at all.
 *
 * Keyed by `ResolvedLocale` rather than written as two constants plus a ternary
 * at the call site: a third UI language then fails to compile here until its
 * channel is decided, instead of silently landing in English.
 */
export const DISCORD_INVITE_URL: Record<ResolvedLocale, string> = {
  en: 'https://discord.gg/yFYVSm9tPC',
  zh: 'https://discord.gg/XcEqrwKUXN',
}

// ─── Backend discovery ─────────────────────────────────────────────────────

/** Backend CLI binary name. Installed by `uv sync` into the venv, or by
 *  the desktop installer onto the user's PATH. Electron *always* resolves
 *  via an absolute path; this constant identifies the basename for both
 *  bundled binary lookup and CI naming checks. */
export const BACKEND_CLI_NAME = 'amphi'

/** Runtime directory, relative to the user's home. Backend writes
 *  `runtime.json`, `server.log`, `gateway.lock`, and `control.lock` under
 *  `~/<BACKEND_RUNTIME_DIR_REL>/`. Mirrors the backend's hard-coded
 *  `~/.bridgic/AmphiAgent/` (src/amphi_service/server/_manager.py `RUNTIME_FILE`).
 *
 *  FALLBACK ONLY: when a daemon is live, prefer the path it reports
 *  (`runtime_file` / `lock_file` on the endpoint) — the daemon owns its
 *  on-disk layout, so we never guess while it's running. This constant is
 *  used solely to render a best-effort path when no daemon is up to ask. */
export const BACKEND_RUNTIME_DIR_REL = '.bridgic/AmphiAgent'

/** Discovery file name — written by daemon at startup, read by clients. */
export const BACKEND_RUNTIME_FILE_NAME = 'runtime.json'

/** Daemon log file name (relative to runtime dir). */
export const BACKEND_LOG_FILE_NAME = 'server.log'

/** Single-daemon-instance file lock name (relative to runtime dir).
 *  M1+ daemons acquire this on startup; the file may persist after a
 *  crash but the lock state lives in the kernel — see backend
 *  src/amphi_service/server/_manager.py `ServerInstanceLock`. */
export const BACKEND_LOCK_FILE_NAME = 'gateway.lock'

/** Backend default port — used when runtime.json does not override it. The
 *  backend's `amphi server start` accepts `--port`. */
export const BACKEND_DEFAULT_PORT = 7421

/** Backend default bind host — loopback only. */
export const BACKEND_DEFAULT_HOST = '127.0.0.1'

// ─── HTTP / auth ───────────────────────────────────────────────────────────

/**
 * HTTP header used for bearer-token auth on `/api/*` endpoints.
 * Combine with `Bearer ` prefix and the token from `runtime.json` —
 * see the daemon runtime registration in `amphi_service.server._manager`
 *
 * Legacy non-`/api/*` paths remain unauthenticated.
 */
export const AUTH_HEADER_NAME = 'Authorization'

/**
 * HTTP header carrying the client's stable, free-form identifier.
 * The daemon registers each unique value in its in-memory client
 * registry exposed by `/api/gateway/clients`. Echoing the same id from multiple
 * GUI windows is allowed and merges into one record.
 */
export const CLIENT_ID_HEADER = 'X-Client-Id'

/**
 * HTTP header tagging the client's category. One of:
 *   'gui' / 'cli' / 'tray' / 'unknown'
 *
 * Use the `ClientKind` const from main/python-client/types.ts for the
 * value side — that's the single source of truth for these labels.
 */
export const CLIENT_TYPE_HEADER = 'X-Client-Type'

/**
 * Paths under the Bridgic Agent daemon's gateway surface, registered in
 * `amphi_service._app` and implemented by the gateway handler modules.
 * Centralized so renderer + main both reference the same strings — grep
 * `GATEWAY_API_PATHS` to find every caller.
 *
 * `Health` is the only one that skips auth (no Bearer required) —
 * it's the bootstrap probe clients use before they have the token.
 */
export const GATEWAY_API_PATHS = {
  Health: '/api/gateway/health',
  Info: '/api/gateway/info',
  Clients: '/api/gateway/clients',
  Shutdown: '/api/gateway/shutdown',
  BrowserController: '/api/browser/controller',
  /** Live "is any Agent task in flight?" probe. Used by the update flow to
   *  avoid restarting the app out from under a running turn. */
  AgentStatus: '/api/agent/status',
} as const
export type GatewayApiPath = (typeof GATEWAY_API_PATHS)[keyof typeof GATEWAY_API_PATHS]

// ─── OS service / installer ────────────────────────────────────────────────

/** launchd label for the daemon's user agent plist. */
export const LAUNCHD_LABEL = `${APP_BUNDLE_ID}.daemon`

/** systemd user service unit name (sans `.service` suffix). */
export const SYSTEMD_UNIT = `${APP_SLUG}-daemon`

/**
 * Windows autostart entry name — the value name under
 * `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (must match installer.nsh).
 *
 * Was a Scheduled Task name until 2026-07-28. Creating a logon-triggered task
 * needs elevation, which this per-user installer never requests, so it failed
 * on every install; see installer.nsh for the full autopsy.
 *
 * Deliberately a literal, NOT derived from `APP_PRODUCT_NAME`: this is a
 * registry value name written by the installer and read back by the backend
 * (`src/amphi_service/server/supervisor/_run_key.py::RUN_VALUE_NAME`) and the
 * installer smoke test (`scripts/test-installer.ps1`). Deriving it means the
 * 2026-08 `Amphi` → `Bridgic Agent` product rename would silently orphan every
 * existing Run entry — the installer would write the new name while uninstall
 * and autostart-disable still look for the old one, leaving a dead autostart
 * command behind that no code path can clean up.
 */
export const WIN_AUTOSTART_NAME = 'Amphi Daemon'

/** Windows login item for the Electron process that owns the tray icon.
 *
 *  Unlike `APP_BUNDLE_ID`, this Run value name can surface in Windows Startup
 *  Apps and registry diagnostics, so it deliberately remains the friendly
 *  product name. It is still a persisted registry contract: changing it
 *  requires an explicit legacy-delete/migration in installer.nsh, not merely
 *  changing the literal here. It must stay in sync with the installer.
 *
 *  Do not replace it with `APP_BUNDLE_ID` just to satisfy Electron's legacy
 *  `openAtLogin` field. `gui-autostart.ts` verifies this custom-named entry via
 *  `launchItems`; the AppUserModelID and Run value name are separate namespaces.
 */
export const WIN_GUI_AUTOSTART_NAME = 'Bridgic Agent'

/** Canonical argv marker for a login launch that must create the tray without
 *  presenting the main window. Also accepted on non-Windows platforms so the
 *  launch-intent path stays portable. */
export const GUI_BACKGROUND_ARG = '--background'
