import { expect, it } from 'bun:test'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import { EmbeddedPowerPointManager } from '../embedded-powerpoint-manager'

class FakeDebugger {
  attached = false

  constructor(private readonly targetId: string) {}

  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  isAttached(): boolean { return this.attached }
  async sendCommand(): Promise<unknown> { return { targetInfo: { targetId: this.targetId } } }
}

class FakeContents {
  readonly debugger: FakeDebugger
  private destroyed = false
  private readonly listeners = new Map<string, Array<() => void>>()
  zoomLevel = 0
  sent: Array<[string, unknown]> = []

  constructor(readonly id: number) {
    this.debugger = new FakeDebugger(`ppt-target-${id}`)
  }

  setBackgroundThrottling(): void {}
  setZoomLevel(level: number): void { this.zoomLevel = level }
  send(channel: string, value: unknown): void { this.sent.push([channel, value]) }
  isDestroyed(): boolean { return this.destroyed }
  isLoading(): boolean { return false }
  on(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  once(event: string, listener: () => void): void { this.on(event, listener) }
  close(): void {
    this.destroyed = true
    for (const listener of this.listeners.get('destroyed') ?? []) listener()
  }
}

class FakeView {
  readonly webContents: FakeContents
  bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  visible = false

  constructor(id: number) { this.webContents = new FakeContents(id) }
  setBounds(bounds: Rectangle): void { this.bounds = bounds }
  setVisible(visible: boolean): void { this.visible = visible }
}

it('owns exactly one CDP target per Session and presents only the active one', async () => {
  const views: FakeView[] = []
  const children: FakeView[] = []
  const host = {
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: FakeView) => children.push(view),
      removeChildView: (view: FakeView) => children.splice(children.indexOf(view), 1),
    },
  } as unknown as BrowserWindow
  const manager = new EmbeddedPowerPointManager(
    () => {
      const view = new FakeView(views.length + 1)
      views.push(view)
      return view as unknown as WebContentsView
    },
    async () => {},
  )
  manager.attachHost(host)

  const first = await manager.ensureSession('session-a')
  expect(await manager.ensureSession('session-a')).toEqual(first)
  const second = await manager.ensureSession('session-b')
  expect(first.targetId).toBe('ppt-target-1')
  expect(second.targetId).toBe('ppt-target-2')
  expect(views).toHaveLength(2)

  manager.setBounds({ x: 12, y: 24, width: 900, height: 600 })
  manager.activateSession('session-b')
  manager.setVisible(true)
  expect(views[0]!.visible).toBe(false)
  expect(views[1]!.visible).toBe(true)
  expect(views[1]!.bounds).toEqual({ x: 12, y: 24, width: 900, height: 600 })

  manager.applySettings({ zoomLevel: 2 } as never)
  expect(views[1]!.webContents.zoomLevel).toBe(2)
  expect(views[1]!.webContents.sent.at(-1)?.[0]).toBe('settings-changed')

  manager.closeSession('session-b')
  expect(children).toHaveLength(1)
  expect(manager.snapshot().sessions.map((item) => item.sessionId)).toEqual(['session-a'])
})
