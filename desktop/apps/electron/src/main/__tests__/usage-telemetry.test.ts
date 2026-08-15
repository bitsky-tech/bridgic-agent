import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type {
  BrowserWindowLifecycleEvent,
  BrowserWindowLike,
  PowerMonitorLike,
  PowerMonitorLifecycleEvent,
} from '../telemetry/foreground-usage-tracker'
import {
  UsageTelemetry,
  type UsageTelemetryTransport,
} from '../telemetry/usage-telemetry'

class FakeWindow extends EventEmitter implements BrowserWindowLike {
  visible = false
  focused = false
  minimized = false
  destroyed = false

  override on(event: BrowserWindowLifecycleEvent, listener: () => void): this {
    return super.on(event, listener)
  }

  override removeListener(event: BrowserWindowLifecycleEvent, listener: () => void): this {
    return super.removeListener(event, listener)
  }

  isVisible(): boolean { return this.visible }
  isFocused(): boolean { return this.focused }
  isMinimized(): boolean { return this.minimized }
  isDestroyed(): boolean { return this.destroyed }

  show(): void {
    this.visible = true
    this.emit('show')
  }

  focus(): void {
    this.focused = true
    this.emit('focus')
  }

  hide(): void {
    this.visible = false
    this.focused = false
    this.emit('hide')
  }
}

class FakePowerMonitor extends EventEmitter implements PowerMonitorLike {
  override on(event: PowerMonitorLifecycleEvent, listener: () => void): this {
    return super.on(event, listener)
  }

  override removeListener(event: PowerMonitorLifecycleEvent, listener: () => void): this {
    return super.removeListener(event, listener)
  }

  getSystemIdleTime(): number { return 0 }
}

class FakeTransport implements UsageTelemetryTransport {
  readonly calls: string[] = []

  setConsent(consented: boolean): void { this.calls.push(`consent:${consented}`) }
  captureLaunch(mode: 'foreground' | 'background'): void { this.calls.push(`launch:${mode}`) }
  captureWindowOpened(reason: 'initial' | 'reopen'): void { this.calls.push(`window:${reason}`) }
  captureActivePeriod(): void { this.calls.push('active-period') }
  async shutdown(): Promise<void> { this.calls.push('shutdown') }
  stopWithoutFlush(): void { this.calls.push('stop-without-flush') }
}

describe('UsageTelemetry', () => {
  test('records launch and visible-window opens when telemetry is enabled at startup', async () => {
    const transport = new FakeTransport()
    const telemetry = new UsageTelemetry({ transport, powerMonitor: new FakePowerMonitor() })
    const window = new FakeWindow()
    telemetry.attachMainWindow(window)

    telemetry.start(true, 'foreground')
    window.show()
    window.focus()
    window.hide()
    window.show()

    expect(transport.calls).toEqual([
      'consent:true',
      'launch:foreground',
      'window:initial',
      'window:reopen',
    ])
    await telemetry.shutdown()
    expect(transport.calls.at(-1)).toBe('shutdown')
  })

  test('does not backfill launches or window opens that happened while disabled', async () => {
    const transport = new FakeTransport()
    const telemetry = new UsageTelemetry({ transport, powerMonitor: new FakePowerMonitor() })
    const window = new FakeWindow()
    telemetry.attachMainWindow(window)

    telemetry.start(false, 'background')
    window.show()
    window.focus()
    telemetry.setConsent(true)
    window.hide()
    window.show()

    expect(transport.calls).toEqual([
      'consent:false',
      'consent:true',
      'window:reopen',
    ])
    telemetry.setConsent(false)
    expect(transport.calls.at(-1)).toBe('consent:false')
    await telemetry.shutdown()
  })

  test('uses the non-blocking transport stop for OS session end', () => {
    const transport = new FakeTransport()
    const telemetry = new UsageTelemetry({ transport, powerMonitor: new FakePowerMonitor() })
    telemetry.start(true, 'foreground')

    telemetry.stopWithoutFlush()
    telemetry.stopWithoutFlush()

    expect(transport.calls.filter((call) => call === 'stop-without-flush')).toHaveLength(1)
  })
})
