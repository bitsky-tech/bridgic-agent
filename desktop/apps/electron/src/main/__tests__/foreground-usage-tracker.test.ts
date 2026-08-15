import { describe, expect, it } from 'bun:test'
import {
  ACTIVE_PERIOD_EVENT_NAME,
  ForegroundUsageTracker,
  MAX_ACTIVE_PERIOD_CHECKPOINT_MS,
  type ActivePeriodEvent,
  type BrowserWindowLifecycleEvent,
  type BrowserWindowLike,
  type IntervalScheduler,
  type MonotonicClock,
  type PowerMonitorLifecycleEvent,
  type PowerMonitorLike,
} from '../telemetry/foreground-usage-tracker'

class FakeLifecycleSource<EventName extends string> {
  private readonly listeners = new Map<EventName, Set<() => void>>()

  on(event: EventName, listener: () => void): this {
    const listeners = this.listeners.get(event) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  removeListener(event: EventName, listener: () => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: EventName): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener()
  }

  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

class FakeWindow extends FakeLifecycleSource<BrowserWindowLifecycleEvent> implements BrowserWindowLike {
  private visible = false
  private focused = false
  private minimized = false
  private destroyed = false

  isVisible(): boolean {
    return this.visible
  }

  isFocused(): boolean {
    return this.focused
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  show(): void {
    this.visible = true
    this.emit('show')
  }

  focus(): void {
    this.focused = true
    this.emit('focus')
  }

  blur(): void {
    this.focused = false
    this.emit('blur')
  }

  hide(): void {
    this.visible = false
    this.focused = false
    this.emit('hide')
  }

  minimize(): void {
    this.minimized = true
    this.focused = false
    this.emit('minimize')
  }

  restore(): void {
    this.minimized = false
    this.visible = true
    this.emit('restore')
  }

  close(): void {
    this.destroyed = true
    this.visible = false
    this.focused = false
    this.emit('closed')
  }
}

class FakePowerMonitor extends FakeLifecycleSource<PowerMonitorLifecycleEvent> implements PowerMonitorLike {
  idleSeconds = 0

  getSystemIdleTime(): number {
    return this.idleSeconds
  }
}

class FakeClock implements MonotonicClock {
  value = 0

  now(): number {
    return this.value
  }

  advance(ms: number): void {
    this.value += ms
  }
}

class FakeScheduler implements IntervalScheduler {
  private callback: (() => void) | null = null
  delayMs: number | null = null
  clearCount = 0

  setInterval(callback: () => void, delayMs: number): unknown {
    this.callback = callback
    this.delayMs = delayMs
    return 1
  }

  clearInterval(): void {
    this.callback = null
    this.clearCount += 1
  }

  fire(): void {
    this.callback?.()
  }
}

interface FixtureOptions {
  idleThresholdMs?: number
  pollIntervalMs?: number
  checkpointIntervalMs?: number
  onActivePeriod?: (event: ActivePeriodEvent) => void
  onError?: (error: unknown) => void
}

function createFixture(options: FixtureOptions = {}) {
  const window = new FakeWindow()
  const powerMonitor = new FakePowerMonitor()
  const clock = new FakeClock()
  const scheduler = new FakeScheduler()
  const events: ActivePeriodEvent[] = []
  let nextPeriodId = 1
  const tracker = new ForegroundUsageTracker({
    powerMonitor,
    clock,
    scheduler,
    createPeriodId: () => `period-${nextPeriodId++}`,
    onActivePeriod: options.onActivePeriod ?? ((event) => events.push(event)),
    onError: options.onError,
    idleThresholdMs: options.idleThresholdMs,
    pollIntervalMs: options.pollIntervalMs,
    checkpointIntervalMs: options.checkpointIntervalMs,
  })
  tracker.attachWindow(window)
  tracker.start()
  return { tracker, window, powerMonitor, clock, scheduler, events }
}

function activate(window: FakeWindow): void {
  window.show()
  window.focus()
}

describe('ForegroundUsageTracker', () => {
  it('emits additive periods only while the main window is visible and focused', () => {
    const { window, clock, events } = createFixture()

    activate(window)
    clock.advance(30_000)
    window.blur()
    clock.advance(10_000)
    window.focus()
    clock.advance(20_000)
    window.hide()

    expect(events).toEqual([
      {
        event: ACTIVE_PERIOD_EVENT_NAME,
        periodId: 'period-1',
        segmentIndex: 0,
        activeMs: 30_000,
        endReason: 'window-blurred',
      },
      {
        event: ACTIVE_PERIOD_EVENT_NAME,
        periodId: 'period-2',
        segmentIndex: 0,
        activeMs: 20_000,
        endReason: 'window-hidden',
      },
    ])
  })

  it('does not count a background or tray-hidden window', () => {
    const { window, clock, scheduler, events } = createFixture()

    clock.advance(6 * 60_000)
    scheduler.fire()
    expect(events).toEqual([])

    activate(window)
    clock.advance(10_000)
    window.hide()
    clock.advance(6 * 60_000)
    scheduler.fire()

    expect(events).toHaveLength(1)
    expect(events[0]?.activeMs).toBe(10_000)
  })

  it('ends periods for minimize, screen lock, and system suspend', () => {
    const { tracker, window, powerMonitor, clock, events } = createFixture()

    activate(window)
    clock.advance(10_000)
    window.minimize()

    clock.advance(5_000)
    window.restore()
    window.focus()
    clock.advance(10_000)
    powerMonitor.emit('lock-screen')

    clock.advance(20_000)
    powerMonitor.emit('unlock-screen')
    clock.advance(5_000)
    powerMonitor.emit('suspend')

    clock.advance(20_000)
    powerMonitor.emit('resume')
    clock.advance(10_000)
    tracker.stop()

    expect(events.map((event) => [event.activeMs, event.endReason])).toEqual([
      [10_000, 'window-minimized'],
      [10_000, 'screen-locked'],
      [5_000, 'system-suspended'],
      [10_000, 'tracker-stopped'],
    ])
  })

  it('uses system idle time to end at the inferred idle threshold boundary', () => {
    const { window, powerMonitor, clock, scheduler, events } = createFixture({ idleThresholdMs: 60_000 })

    activate(window)
    clock.advance(150_000)
    powerMonitor.idleSeconds = 100
    scheduler.fire()

    expect(events).toEqual([
      {
        event: ACTIVE_PERIOD_EVENT_NAME,
        periodId: 'period-1',
        segmentIndex: 0,
        activeMs: 110_000,
        endReason: 'idle',
      },
    ])

    clock.advance(10_000)
    powerMonitor.idleSeconds = 0
    scheduler.fire()
    clock.advance(10_000)
    window.blur()
    expect(events[1]).toMatchObject({ periodId: 'period-2', activeMs: 10_000 })
  })

  it('checkpoints long foreground periods into segments no longer than five minutes', () => {
    const { window, clock, scheduler, events } = createFixture()

    activate(window)
    clock.advance(12 * 60_000)
    scheduler.fire()
    clock.advance(60_000)
    window.blur()

    expect(events).toEqual([
      {
        event: ACTIVE_PERIOD_EVENT_NAME,
        periodId: 'period-1',
        segmentIndex: 0,
        activeMs: MAX_ACTIVE_PERIOD_CHECKPOINT_MS,
        endReason: 'checkpoint',
      },
      {
        event: ACTIVE_PERIOD_EVENT_NAME,
        periodId: 'period-1',
        segmentIndex: 1,
        activeMs: MAX_ACTIVE_PERIOD_CHECKPOINT_MS,
        endReason: 'checkpoint',
      },
      {
        event: ACTIVE_PERIOD_EVENT_NAME,
        periodId: 'period-1',
        segmentIndex: 2,
        activeMs: 3 * 60_000,
        endReason: 'window-blurred',
      },
    ])
    expect(events.every((event) => event.activeMs <= MAX_ACTIVE_PERIOD_CHECKPOINT_MS)).toBe(true)
  })

  it('caps configured checkpoint and polling intervals at five minutes', () => {
    const tenMinutes = 10 * 60_000
    const { window, clock, scheduler, events } = createFixture({
      checkpointIntervalMs: tenMinutes,
      pollIntervalMs: tenMinutes,
    })

    expect(scheduler.delayMs).toBe(MAX_ACTIVE_PERIOD_CHECKPOINT_MS)
    activate(window)
    clock.advance(MAX_ACTIVE_PERIOD_CHECKPOINT_MS)
    scheduler.fire()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ activeMs: MAX_ACTIVE_PERIOD_CHECKPOINT_MS, endReason: 'checkpoint' })
  })

  it('unbinds replaced and closed windows without losing their final segments', () => {
    const { tracker, window: firstWindow, clock, events } = createFixture()
    const secondWindow = new FakeWindow()

    activate(firstWindow)
    clock.advance(5_000)
    activate(secondWindow)
    tracker.attachWindow(secondWindow)

    expect(firstWindow.listenerCount('focus')).toBe(0)
    expect(events[0]).toMatchObject({ activeMs: 5_000, endReason: 'window-replaced' })

    clock.advance(7_000)
    secondWindow.close()
    expect(secondWindow.listenerCount('focus')).toBe(0)
    expect(events[1]).toMatchObject({ activeMs: 7_000, endReason: 'window-closed' })

    clock.advance(10_000)
    firstWindow.focus()
    expect(events).toHaveLength(2)
  })

  it('stops idempotently, removes every listener, and clears its scheduler', () => {
    const { tracker, window, powerMonitor, clock, scheduler, events } = createFixture()

    activate(window)
    clock.advance(1_000)
    tracker.stop()
    tracker.stop()

    expect(events).toHaveLength(1)
    expect(scheduler.clearCount).toBe(1)
    expect(window.listenerCount('focus')).toBe(0)
    expect(powerMonitor.listenerCount('resume')).toBe(0)

    clock.advance(10_000)
    scheduler.fire()
    window.blur()
    powerMonitor.emit('lock-screen')
    expect(events).toHaveLength(1)
  })

  it('isolates output callback failures from lifecycle tracking', () => {
    const errors: unknown[] = []
    const failure = new Error('capture unavailable')
    const { window, clock } = createFixture({
      onActivePeriod: () => {
        throw failure
      },
      onError: (error) => errors.push(error),
    })

    activate(window)
    clock.advance(1_000)
    expect(() => window.blur()).not.toThrow()
    expect(errors).toEqual([failure])
  })
})
