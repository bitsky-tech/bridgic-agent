import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'bun:test'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import { ExcelHost } from '../excel-host'
import { IPC } from '../../shared/ipc-channels'

class FakeDebugger {
  private attached = false

  constructor(private readonly targetId: () => string) {}

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
  }

  async sendCommand(method: string): Promise<unknown> {
    if (method !== 'Target.getTargetInfo') throw new Error(`unexpected command: ${method}`)
    return { targetInfo: { targetId: this.targetId() } }
  }
}

class FakeWebContents extends EventEmitter {
  readonly sent: Array<{ channel: string; value: unknown }> = []
  readonly debugger: FakeDebugger
  readonly session = {
    setPermissionCheckHandler: () => undefined,
    setPermissionRequestHandler: () => undefined,
  }
  private destroyed = false
  private loading = false
  private loadCount = 0
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null

  constructor(readonly id: number, private readonly targetId: string) {
    super()
    this.debugger = new FakeDebugger(() => this.loadCount <= 1
      ? this.targetId
      : `${this.targetId}-recovered-${this.loadCount}`)
  }

  async loadURL(_url: string): Promise<void> {
    this.loading = true
    this.loadCount += 1
    this.loading = false
    this.emit('did-finish-load')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isLoading(): boolean {
    return this.loading
  }

  setBackgroundThrottling(): void {}

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler
  }

  send(channel: string, value: unknown): void {
    this.sent.push({ channel, value })
  }

  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('destroyed')
  }
}

class FakeView {
  readonly boundsHistory: Rectangle[] = []
  readonly visibilityHistory: boolean[] = []

  constructor(readonly webContents: FakeWebContents) {}

  setBounds(bounds: Rectangle): void {
    this.boundsHistory.push({ ...bounds })
  }

  setVisible(visible: boolean): void {
    this.visibilityHistory.push(visible)
  }
}

function fakeHost() {
  const children = new Set<FakeView>()
  return {
    children,
    window: {
      isDestroyed: () => false,
      contentView: {
        addChildView: (view: WebContentsView) => children.add(view as unknown as FakeView),
        removeChildView: (view: WebContentsView) => children.delete(view as unknown as FakeView),
      },
    } as unknown as BrowserWindow,
  }
}

function setup(confirmDiscardDirty?: (count: number) => Promise<boolean>, openExternal?: (url: string) => void) {
  const views: FakeView[] = []
  const host = fakeHost()
  const manager = new ExcelHost(
    () => {
      const ordinal = views.length + 1
      const view = new FakeView(new FakeWebContents(ordinal, `excel-target-${ordinal}`))
      views.push(view)
      return view as unknown as WebContentsView
    },
    '/dist/excel-host-preload.cjs',
    'http://localhost:5173',
    '/dist/renderer/excel.html',
    () => undefined,
    confirmDiscardDirty,
    openExternal,
  )
  manager.attachHost(host.window)
  return { host, manager, views }
}

describe('ExcelHost Session target ownership', () => {
  it('reuses exactly one WebContentsView/CDP target for every workbook tab in a Session', async () => {
    const { manager, views } = setup()
    const config = { sessionId: 'session-a', locale: 'zh-CN', theme: 'dark' } as const

    const first = await manager.ensureSession('session-a', config)
    const afterAnotherWorkbookTab = await manager.ensureSession('session-a', config)

    expect(views).toHaveLength(1)
    expect(first.targetId).toBe('excel-target-1')
    expect(afterAnotherWorkbookTab.targetId).toBe(first.targetId)
    expect(afterAnotherWorkbookTab.webContentsId).toBe(first.webContentsId)
  })

  it('routes an opaque workbook ticket to the exact Session target without creating another target', async () => {
    const { manager, views } = setup()
    const config = { sessionId: 'session-a', locale: 'zh-CN', theme: 'dark' } as const

    await manager.openWorkbook('session-a', config, {
      path: '/tmp/report.xlsx',
      replaceInitialBlank: true,
    })

    expect(views).toHaveLength(1)
    const delivery = views[0]?.webContents.sent.find(
      (message) => message.channel === IPC.events.excelWorkbookOpenRequested,
    )
    expect(delivery?.value).toEqual({
      requestId: expect.any(String),
      replaceInitialBlank: true,
    })
    expect(delivery?.value).not.toHaveProperty('path')
    const requestId = (delivery?.value as { requestId: string }).requestId
    expect(manager.consumeWorkbookOpenRequest(1, requestId)).toBe('/tmp/report.xlsx')
    expect(() => manager.consumeWorkbookOpenRequest(1, requestId)).toThrow('invalid or expired')
  })

  it('creates a different target for a different Agent Session and keeps both alive', async () => {
    const { host, manager, views } = setup()
    const first = await manager.ensureSession('session-a', {
      sessionId: 'session-a', locale: 'en-US', theme: 'light',
    })
    const second = await manager.ensureSession('session-b', {
      sessionId: 'session-b', locale: 'en-US', theme: 'light',
    })

    expect(views).toHaveLength(2)
    expect(host.children.size).toBe(2)
    expect(second.targetId).not.toBe(first.targetId)
    expect(manager.snapshot().sessions.map((session) => session.sessionId)).toEqual([
      'session-a',
      'session-b',
    ])
  })

  it('presents only the active Session target and disposes only the requested Session', async () => {
    const { host, manager, views } = setup()
    await manager.ensureSession('session-a', {
      sessionId: 'session-a', locale: 'en-US', theme: 'light',
    })
    await manager.ensureSession('session-b', {
      sessionId: 'session-b', locale: 'en-US', theme: 'light',
    })
    manager.setBounds({ x: 400, y: 50, width: 700, height: 600 })
    manager.activateSession('session-b')
    manager.setVisible(true)

    expect(views[0]?.visibilityHistory.at(-1)).toBe(false)
    expect(views[1]?.visibilityHistory.at(-1)).toBe(true)
    expect(views[1]?.boundsHistory.at(-1)).toEqual({ x: 400, y: 50, width: 700, height: 600 })

    manager.closeSession('session-a')
    expect(host.children.size).toBe(1)
    expect(manager.snapshot().sessions.map((session) => session.sessionId)).toEqual(['session-b'])
  })

  it('lets the child renderer close only the Session target that owns it', async () => {
    const { host, manager } = setup()
    const first = await manager.ensureSession('session-a', {
      sessionId: 'session-a', locale: 'en-US', theme: 'light',
    })
    await manager.ensureSession('session-b', {
      sessionId: 'session-b', locale: 'en-US', theme: 'light',
    })

    manager.closeCurrentSession(first.webContentsId)

    expect(host.children.size).toBe(1)
    expect(manager.snapshot().sessions.map((session) => session.sessionId)).toEqual(['session-b'])
  })

  it('reloads a crashed renderer in place and retains its recovery snapshot', async () => {
    const { manager, views } = setup()
    const first = await manager.ensureSession('session-a', {
      sessionId: 'session-a', locale: 'en-US', theme: 'light',
    })
    manager.setRecoveryState(first.webContentsId, { version: 1, tabs: [{ tabId: 'tab-a' }] })
    manager.setDirty(first.webContentsId, true)

    views[0]?.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    const recovered = await manager.ensureSession('session-a', {
      sessionId: 'session-a', locale: 'en-US', theme: 'light',
    })

    expect(views).toHaveLength(1)
    expect(recovered.ready).toBe(true)
    expect(recovered.crashed).toBe(false)
    expect(recovered.dirty).toBe(true)
    expect(recovered.targetId).toBe('excel-target-1-recovered-2')
    expect(manager.getRecoveryState(first.webContentsId)).toEqual({
      version: 1,
      tabs: [{ tabId: 'tab-a' }],
    })
  })

  it('requires explicit confirmation before discarding dirty Session workbooks', async () => {
    const confirmations: number[] = []
    const { manager } = setup(async (count) => {
      confirmations.push(count)
      return false
    })
    const session = await manager.ensureSession('session-a', {
      sessionId: 'session-a', locale: 'en-US', theme: 'light',
    })
    manager.setDirty(session.webContentsId, true)

    expect(await manager.confirmClose()).toBe(false)
    expect(confirmations).toEqual([1])
  })

  it('hands workbook hyperlinks to the trusted external URL boundary', async () => {
    const opened: string[] = []
    const { manager, views } = setup(undefined, (url) => opened.push(url))
    await manager.ensureSession('session-a', {
      sessionId: 'session-a', locale: 'en-US', theme: 'light',
    })

    expect(views[0]?.webContents.windowOpenHandler?.({ url: 'https://example.com/report' })).toEqual({ action: 'deny' })
    expect(opened).toEqual(['https://example.com/report'])
  })
})
