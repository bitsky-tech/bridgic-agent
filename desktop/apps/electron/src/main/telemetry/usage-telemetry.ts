import type {
  ActivePeriodEvent,
  BrowserWindowLike,
  PowerMonitorLike,
} from './foreground-usage-tracker'
import { ForegroundUsageTracker } from './foreground-usage-tracker'
import type {
  ActivePeriodEndReason as TransportActivePeriodEndReason,
  LaunchMode,
  WindowOpenReason,
} from './posthog-telemetry'

const IDLE_THRESHOLD_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 30 * 1000
const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000

interface MainWindowLike extends BrowserWindowLike {
  on(event: 'show', listener: () => void): unknown
  removeListener(event: 'show', listener: () => void): unknown
}

export interface UsageTelemetryOptions {
  transport: UsageTelemetryTransport
  powerMonitor: PowerMonitorLike
  log?: Pick<Console, 'warn'>
}

export interface UsageTelemetryTransport {
  setConsent(consented: boolean): void
  captureLaunch(launchMode: LaunchMode): void
  captureWindowOpened(reason: WindowOpenReason): void
  captureActivePeriod(input: {
    activeSeconds: number
    intervalId: string
    endReason: TransportActivePeriodEndReason
  }): void
  shutdown(): Promise<void>
  stopWithoutFlush(): void
}

/**
 * Coordinate consent, main-window lifecycle events, and foreground timing.
 *
 * No application content crosses this boundary: only fixed lifecycle events
 * and numeric active durations can reach the PostHog transport.
 */
export class UsageTelemetry {
  private readonly transport: UsageTelemetryTransport
  private readonly tracker: ForegroundUsageTracker
  private mainWindow: MainWindowLike | null = null
  private hasShownWindow = false
  private consented: boolean | null = null
  private started = false
  private closed = false
  private readonly onWindowShown = () => {
    const reason = this.hasShownWindow ? 'reopen' : 'initial'
    this.hasShownWindow = true
    if (this.consented === true) this.transport.captureWindowOpened(reason)
  }

  constructor(options: UsageTelemetryOptions) {
    this.transport = options.transport
    const log = options.log ?? console
    this.tracker = new ForegroundUsageTracker({
      powerMonitor: options.powerMonitor,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      checkpointIntervalMs: CHECKPOINT_INTERVAL_MS,
      onActivePeriod: (event) => this.captureActivePeriod(event),
      onError: (error) => log.warn('[telemetry] foreground usage tracking failed', error),
    })
  }

  /** Apply startup consent and record this process launch when permitted. */
  start(consented: boolean, launchMode: LaunchMode): void {
    if (this.started || this.closed) return
    this.started = true
    this.setConsent(consented)
    if (consented) this.transport.captureLaunch(launchMode)
  }

  /** Attach the singleton main window before it can first become visible. */
  attachMainWindow(window: MainWindowLike): void {
    if (this.closed || this.mainWindow === window) return
    if (this.mainWindow) this.mainWindow.removeListener('show', this.onWindowShown)
    this.mainWindow = window
    window.on('show', this.onWindowShown)
    this.tracker.attachWindow(window)
  }

  /** Apply an explicit settings change without counting pre-consent time. */
  setConsent(consented: boolean): void {
    if (this.closed || this.consented === consented) return
    this.consented = consented
    if (consented) {
      this.transport.setConsent(true)
      this.tracker.start()
      return
    }

    // Close transport first so the tracker's stop segment is intentionally
    // discarded rather than sending activity measured before revocation.
    this.transport.setConsent(false)
    this.tracker.stop()
  }

  /** Finish the final active segment and flush consented events on normal quit. */
  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.tracker.stop()
    this.detachWindowListener()
    await this.transport.shutdown()
  }

  /** Synchronous best effort for Windows logoff/shutdown, which cannot be delayed. */
  stopWithoutFlush(): void {
    if (this.closed) return
    this.closed = true
    this.tracker.stop()
    this.detachWindowListener()
    this.transport.stopWithoutFlush()
  }

  private captureActivePeriod(event: ActivePeriodEvent): void {
    if (this.consented !== true) return
    const activeSeconds = Math.floor(event.activeMs / 1000)
    if (activeSeconds < 1) return
    this.transport.captureActivePeriod({
      activeSeconds,
      intervalId: `${event.periodId}:${event.segmentIndex}`,
      endReason: event.endReason,
    })
  }

  private detachWindowListener(): void {
    this.mainWindow?.removeListener('show', this.onWindowShown)
    this.mainWindow = null
  }
}
