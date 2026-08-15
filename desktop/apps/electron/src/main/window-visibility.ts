/**
 * Visibility state shared by initial window creation and foreground requests.
 * Pure on purpose: startup races can be tested without loading Electron.
 */
export class MainWindowVisibilityLatch {
  private readyToShow = false
  private foregroundRequested = false

  /** Start a new native window while preserving any pre-ready foreground request. */
  beginCreation(showWhenReady: boolean): void {
    this.readyToShow = false
    if (showWhenReady) this.foregroundRequested = true
  }

  /**
   * Returns true when the caller can reveal now. An explicit user activation
   * may show an existing native host even before renderer ready-to-show; when
   * no host exists yet, the request remains latched for markReady().
   */
  requestForeground(nativeWindowAvailable = false): boolean {
    this.foregroundRequested = true
    return nativeWindowAvailable || this.readyToShow
  }

  /** Returns true when ready-to-show may reveal the window. */
  markReady(blocked: boolean): boolean {
    this.readyToShow = true
    return this.foregroundRequested && !blocked
  }

  reset(): void {
    this.readyToShow = false
    this.foregroundRequested = false
  }
}

/** Minimal native window surface needed to decide whether the app is foreground. */
export interface NativeWindowForegroundSource {
  isDestroyed(): boolean
  isFocused(): boolean
  isMinimized(): boolean
  isVisible(): boolean
}

/** True only while a user can actively view the native host window. */
export function isNativeWindowForeground(window: NativeWindowForegroundSource): boolean {
  return !window.isDestroyed()
    && window.isVisible()
    && window.isFocused()
    && !window.isMinimized()
}

export interface TrayInitializationHooks {
  initialize: () => void
  destroyPartial: () => void
  setHideOnClose: (enabled: boolean) => void
  failOpen: () => void
  reportError: (error: unknown) => void
  reportCleanupError?: (error: unknown) => void
}

/** Initialize hide-to-tray atomically, with a visible-window fallback. */
export function initializeTrayWithFailOpen(hooks: TrayInitializationHooks): boolean {
  try {
    hooks.initialize()
    hooks.setHideOnClose(true)
    return true
  } catch (error) {
    try {
      hooks.destroyPartial()
    } catch (cleanupError) {
      hooks.reportCleanupError?.(cleanupError)
    }
    hooks.setHideOnClose(false)
    hooks.reportError(error)
    hooks.failOpen()
    return false
  }
}
