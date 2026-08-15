import { randomUUID } from 'node:crypto'

export const ACTIVE_PERIOD_EVENT_NAME = 'app.active_period' as const
export const MAX_ACTIVE_PERIOD_CHECKPOINT_MS = 5 * 60 * 1000

const DEFAULT_CHECKPOINT_MS = MAX_ACTIVE_PERIOD_CHECKPOINT_MS
const DEFAULT_IDLE_THRESHOLD_MS = 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000

export type ActivePeriodEndReason =
  | 'checkpoint'
  | 'idle'
  | 'screen-locked'
  | 'system-suspended'
  | 'tracker-stopped'
  | 'window-blurred'
  | 'window-closed'
  | 'window-detached'
  | 'window-hidden'
  | 'window-minimized'
  | 'window-replaced'
  | 'window-state-changed'

export interface ActivePeriodEvent {
  event: typeof ACTIVE_PERIOD_EVENT_NAME
  periodId: string
  segmentIndex: number
  activeMs: number
  endReason: ActivePeriodEndReason
}

export type BrowserWindowLifecycleEvent =
  | 'show'
  | 'hide'
  | 'focus'
  | 'blur'
  | 'minimize'
  | 'restore'
  | 'closed'

export interface BrowserWindowLike {
  on(event: BrowserWindowLifecycleEvent, listener: () => void): unknown
  removeListener(event: BrowserWindowLifecycleEvent, listener: () => void): unknown
  isVisible(): boolean
  isFocused(): boolean
  isMinimized(): boolean
  isDestroyed(): boolean
}

export type PowerMonitorLifecycleEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'

export interface PowerMonitorLike {
  on(event: PowerMonitorLifecycleEvent, listener: () => void): unknown
  removeListener(event: PowerMonitorLifecycleEvent, listener: () => void): unknown
  getSystemIdleTime(): number
}

export interface MonotonicClock {
  now(): number
}

export interface IntervalScheduler {
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
}

export interface ForegroundUsageTrackerOptions {
  powerMonitor: PowerMonitorLike
  onActivePeriod: (event: ActivePeriodEvent) => void
  onError?: (error: unknown) => void
  clock?: MonotonicClock
  scheduler?: IntervalScheduler
  createPeriodId?: () => string
  idleThresholdMs?: number
  pollIntervalMs?: number
  checkpointIntervalMs?: number
}

interface ActivePeriodState {
  id: string
  segmentIndex: number
  segmentStartedAt: number
}

const defaultClock: MonotonicClock = {
  now: () => performance.now(),
}

const defaultScheduler: IntervalScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * Measure foreground human usage without depending on Electron or an analytics SDK.
 *
 * A period is active only while the attached window is visible, focused, not
 * minimized, the screen is unlocked, the machine is awake, and system idle time
 * is below the configured threshold. Emitted segments are additive and never
 * longer than five minutes.
 */
export class ForegroundUsageTracker {
  private readonly powerMonitor: PowerMonitorLike
  private readonly onActivePeriod: (event: ActivePeriodEvent) => void
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly clock: MonotonicClock
  private readonly scheduler: IntervalScheduler
  private readonly createPeriodId: () => string
  private readonly idleThresholdMs: number
  private readonly pollIntervalMs: number
  private readonly checkpointIntervalMs: number

  private window: BrowserWindowLike | null = null
  private windowListeners: Array<[BrowserWindowLifecycleEvent, () => void]> = []
  private powerListeners: Array<[PowerMonitorLifecycleEvent, () => void]> = []
  private intervalHandle: unknown = null
  private activePeriod: ActivePeriodState | null = null
  private running = false
  private screenLocked = false
  private systemSuspended = false
  private lastNow: number | null = null

  constructor(options: ForegroundUsageTrackerOptions) {
    this.powerMonitor = options.powerMonitor
    this.onActivePeriod = options.onActivePeriod
    this.onError = options.onError
    this.clock = options.clock ?? defaultClock
    this.scheduler = options.scheduler ?? defaultScheduler
    this.createPeriodId = options.createPeriodId ?? randomUUID
    this.idleThresholdMs = this.requirePositive(options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS, 'idleThresholdMs')
    this.checkpointIntervalMs = Math.min(
      this.requirePositive(options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_MS, 'checkpointIntervalMs'),
      MAX_ACTIVE_PERIOD_CHECKPOINT_MS,
    )
    this.pollIntervalMs = Math.min(
      this.requirePositive(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs'),
      this.checkpointIntervalMs,
    )
  }

  /** Attach the sole main window, replacing and unbinding any prior window. */
  attachWindow(window: BrowserWindowLike): void {
    if (this.window === window) return

    if (this.window) {
      this.endActivePeriod('window-replaced', this.readNow())
      this.unbindWindow()
    }

    this.window = window
    if (!this.running) return
    this.bindWindow(window)
    this.reconcileWindowState()
  }

  /** Detach the current main window and finish any active segment. */
  detachWindow(): void {
    if (!this.window) return
    this.endActivePeriod('window-detached', this.readNow())
    this.unbindWindow()
    this.window = null
  }

  /** Start lifecycle observation. Repeated calls are idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    this.screenLocked = false
    this.systemSuspended = false
    this.bindPowerMonitor()
    if (this.window) this.bindWindow(this.window)
    this.intervalHandle = this.scheduler.setInterval(() => this.poll(), this.pollIntervalMs)
    this.reconcileWindowState()
  }

  /** Stop observation, emit the remaining active segment, and remove listeners. */
  stop(): void {
    if (!this.running) return
    this.endActivePeriod('tracker-stopped', this.readNow())
    this.running = false

    if (this.intervalHandle !== null) {
      this.scheduler.clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    this.unbindWindow()
    this.unbindPowerMonitor()
    this.screenLocked = false
    this.systemSuspended = false
  }

  private requirePositive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
    return value
  }

  private bindWindow(window: BrowserWindowLike): void {
    const bindings: Array<[BrowserWindowLifecycleEvent, () => void]> = [
      ['show', () => this.reconcileWindowState()],
      ['focus', () => this.reconcileWindowState()],
      ['restore', () => this.reconcileWindowState()],
      ['hide', () => this.endActivePeriod('window-hidden', this.readNow())],
      ['blur', () => this.endActivePeriod('window-blurred', this.readNow())],
      ['minimize', () => this.endActivePeriod('window-minimized', this.readNow())],
      ['closed', () => this.handleWindowClosed(window)],
    ]
    for (const [event, listener] of bindings) window.on(event, listener)
    this.windowListeners = bindings
  }

  private unbindWindow(): void {
    if (!this.window) {
      this.windowListeners = []
      return
    }
    for (const [event, listener] of this.windowListeners) this.window.removeListener(event, listener)
    this.windowListeners = []
  }

  private handleWindowClosed(window: BrowserWindowLike): void {
    if (this.window !== window) return
    this.endActivePeriod('window-closed', this.readNow())
    this.unbindWindow()
    this.window = null
  }

  private bindPowerMonitor(): void {
    const bindings: Array<[PowerMonitorLifecycleEvent, () => void]> = [
      ['suspend', () => {
        this.systemSuspended = true
        this.endActivePeriod('system-suspended', this.readNow())
      }],
      ['resume', () => {
        this.systemSuspended = false
        this.reconcileWindowState()
      }],
      ['lock-screen', () => {
        this.screenLocked = true
        this.endActivePeriod('screen-locked', this.readNow())
      }],
      ['unlock-screen', () => {
        this.screenLocked = false
        this.reconcileWindowState()
      }],
    ]
    for (const [event, listener] of bindings) this.powerMonitor.on(event, listener)
    this.powerListeners = bindings
  }

  private unbindPowerMonitor(): void {
    for (const [event, listener] of this.powerListeners) this.powerMonitor.removeListener(event, listener)
    this.powerListeners = []
  }

  private poll(): void {
    if (!this.running) return
    const now = this.readNow()
    const idleMs = this.readIdleMs()

    if (!this.hasForegroundWindow()) {
      this.endActivePeriod('window-state-changed', now)
      return
    }
    if (idleMs === null || idleMs >= this.idleThresholdMs) {
      const idleBoundary = idleMs === null
        ? now
        : now - Math.max(0, idleMs - this.idleThresholdMs)
      this.endActivePeriod('idle', Math.max(this.activePeriod?.segmentStartedAt ?? now, idleBoundary))
      return
    }
    if (!this.activePeriod) this.beginActivePeriod(now)
    this.emitDueCheckpoints(now)
  }

  private reconcileWindowState(): void {
    if (!this.running) return
    const now = this.readNow()
    const idleMs = this.readIdleMs()
    if (this.hasForegroundWindow() && idleMs !== null && idleMs < this.idleThresholdMs) {
      if (!this.activePeriod) this.beginActivePeriod(now)
      this.emitDueCheckpoints(now)
      return
    }
    this.endActivePeriod(idleMs !== null && idleMs >= this.idleThresholdMs ? 'idle' : 'window-state-changed', now)
  }

  private hasForegroundWindow(): boolean {
    if (this.screenLocked || this.systemSuspended || !this.window) return false
    try {
      return !this.window.isDestroyed()
        && this.window.isVisible()
        && this.window.isFocused()
        && !this.window.isMinimized()
    } catch (error) {
      this.reportError(error)
      return false
    }
  }

  private readIdleMs(): number | null {
    if (this.screenLocked || this.systemSuspended) return null
    try {
      const idleSeconds = this.powerMonitor.getSystemIdleTime()
      if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return null
      return idleSeconds * 1000
    } catch (error) {
      this.reportError(error)
      return null
    }
  }

  private readNow(): number {
    let now: number
    try {
      now = this.clock.now()
    } catch (error) {
      this.reportError(error)
      now = this.lastNow ?? 0
    }
    if (!Number.isFinite(now)) now = this.lastNow ?? 0
    this.lastNow = this.lastNow === null ? now : Math.max(this.lastNow, now)
    return this.lastNow
  }

  private beginActivePeriod(now: number): void {
    let id: string
    try {
      id = this.createPeriodId()
    } catch (error) {
      this.reportError(error)
      return
    }
    if (!id) return
    this.activePeriod = { id, segmentIndex: 0, segmentStartedAt: now }
  }

  private emitDueCheckpoints(now: number): void {
    while (this.activePeriod && now - this.activePeriod.segmentStartedAt >= this.checkpointIntervalMs) {
      const checkpointAt = this.activePeriod.segmentStartedAt + this.checkpointIntervalMs
      this.emitSegment(checkpointAt, 'checkpoint')
    }
  }

  private endActivePeriod(reason: Exclude<ActivePeriodEndReason, 'checkpoint'>, now: number): void {
    if (!this.activePeriod) return
    this.emitDueCheckpoints(now)
    if (!this.activePeriod) return
    this.emitSegment(now, reason)
    this.activePeriod = null
  }

  private emitSegment(endAt: number, endReason: ActivePeriodEndReason): void {
    const period = this.activePeriod
    if (!period) return
    const activeMs = Math.max(0, endAt - period.segmentStartedAt)
    if (activeMs <= 0) return

    const event: ActivePeriodEvent = {
      event: ACTIVE_PERIOD_EVENT_NAME,
      periodId: period.id,
      segmentIndex: period.segmentIndex,
      activeMs,
      endReason,
    }
    period.segmentStartedAt = endAt
    period.segmentIndex += 1
    try {
      this.onActivePeriod(event)
    } catch (error) {
      this.reportError(error)
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error)
    } catch {
      // Lifecycle tracking must never destabilize the host process.
    }
  }
}
