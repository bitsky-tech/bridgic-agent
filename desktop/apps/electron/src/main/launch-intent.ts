import { GUI_BACKGROUND_ARG } from '../shared/app-meta'

/** Historical alias accepted so existing login-item commands keep working. */
const LEGACY_HIDDEN_ARG = '--hidden'

export interface LaunchIntent {
  /** Suppress only the initial main-window presentation; native hosts still boot. */
  background: boolean
  /** Deep links always override a background switch and request foreground. */
  deepLinkUrl: string | null
}

export interface LaunchEnvironment {
  /** Electron exposes this only for the initial packaged macOS process. */
  wasOpenedAtLogin?: boolean
}

export interface LaunchAutostartState {
  /** Effective OS state, not merely the presence of a Run/plist definition. */
  enabled: boolean
}

/**
 * Interpret process/second-instance argv without touching Electron globals.
 *
 * `--background` is the canonical login-start switch. `--hidden` remains a
 * compatibility alias, while a deep link always wins because handling one is
 * an explicit user activation.
 */
export function parseLaunchIntent(
  argv: readonly string[],
  scheme: string,
  environment: LaunchEnvironment = {},
): LaunchIntent {
  const deepLinkUrl = argv.find((arg) => arg.startsWith(`${scheme}://`)) ?? null
  const requestedBackground =
    argv.some((arg) => arg === GUI_BACKGROUND_ARG || arg === LEGACY_HIDDEN_ARG) ||
    environment.wasOpenedAtLogin === true

  return {
    background: requestedBackground && deepLinkUrl === null,
    deepLinkUrl,
  }
}

export type SecondInstanceAction =
  | { kind: 'background' }
  | { kind: 'focus' }
  | { kind: 'deep-link'; url: string }

/** Keep second-instance routing deterministic and independently testable. */
export function classifySecondInstance(intent: LaunchIntent): SecondInstanceAction {
  if (intent.deepLinkUrl) return { kind: 'deep-link', url: intent.deepLinkUrl }
  return intent.background ? { kind: 'background' } : { kind: 'focus' }
}

/** A login/background launch must respect an OS-level autostart opt-out. A
 * manual foreground launch is explicit user intent and always discovers or
 * starts the backend. Unknown login state fails closed while leaving the tray
 * available for diagnostics and a manual Start action. */
export function shouldStartBackendForLaunch(
  intent: LaunchIntent,
  autostart: LaunchAutostartState | null,
  explicitForegroundRequested = false,
): boolean {
  if (!intent.background || explicitForegroundRequested) return true
  return autostart?.enabled === true
}
