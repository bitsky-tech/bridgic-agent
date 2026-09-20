import { expect, it, spyOn } from 'bun:test'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EmbeddedPowerPointManager } from '../embedded-powerpoint-manager'
import { windowLog } from '../logger'

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
  executedScripts: string[] = []

  constructor(readonly id: number) {
    this.debugger = new FakeDebugger(`ppt-target-${id}`)
  }

  setBackgroundThrottling(): void {}
  setZoomLevel(level: number): void { this.zoomLevel = level }
  send(channel: string, value: unknown): void { this.sent.push([channel, value]) }
  isDestroyed(): boolean { return this.destroyed }
  isLoading(): boolean { return false }
  async executeJavaScript(script: string): Promise<unknown> {
    this.executedScripts.push(script)
    return {
      ok: true,
      value: {
        document_id: 'opened-document',
        deck: { id: 'opened-document', title: 'Opened deck', total_pages: 3 },
        reused: false,
      },
    }
  }
  on(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  once(event: string, listener: () => void): void { this.on(event, listener) }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
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
  expect(first.documentCount).toBeNull()
  expect(second.documentCount).toBeNull()
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

  const presentationDirectory = await mkdtemp(path.join(tmpdir(), 'bridgic-ppt-open-'))
  try {
    const presentationPath = path.join(presentationDirectory, 'deck.pptx')
    await writeFile(presentationPath, new Uint8Array([4, 5, 6]))
    expect(await manager.openFile('session-a', presentationPath)).toEqual({
      documentId: 'opened-document',
      fileName: 'deck.pptx',
      reused: false,
      slideCount: 3,
      title: 'Opened deck',
    })
    expect(views[0]!.webContents.executedScripts.at(-1)).toContain('"method":"open"')
    expect(views[0]!.webContents.executedScripts.at(-1)).toContain('"content_base64":"BAUG"')
    await expect(manager.openFile('session-a', path.join(presentationDirectory, 'deck.txt')))
      .rejects.toThrow('must end with .pptx')
  } finally {
    await rm(presentationDirectory, { recursive: true, force: true })
  }

  manager.closeSession('session-b')
  expect(children).toHaveLength(1)
  expect(manager.snapshot().sessions.map((item) => item.sessionId)).toEqual(['session-a'])
})

it('publishes authoritative project counts without treating the native target as a document', async () => {
  const views: FakeView[] = []
  const snapshots: Array<ReturnType<EmbeddedPowerPointManager['snapshot']>> = []
  const manager = new EmbeddedPowerPointManager(
    () => {
      const view = new FakeView(views.length + 1)
      views.push(view)
      return view as unknown as WebContentsView
    },
    async () => {},
    (snapshot) => snapshots.push(snapshot),
  )
  manager.attachHost({
    isDestroyed: () => false,
    contentView: { addChildView: () => {}, removeChildView: () => {} },
  } as unknown as BrowserWindow)

  const session = await manager.ensureSession('session-a')
  expect(session.documentCount).toBeNull()
  manager.reportState(session.webContentsId, { documentCount: 0 })
  expect(manager.sessionInfo('session-a')?.documentCount).toBe(0)
  manager.reportState(session.webContentsId, { documentCount: 2 })
  expect(manager.snapshot().sessions[0]?.documentCount).toBe(2)
  const publishCount = snapshots.length
  manager.reportState(session.webContentsId, { documentCount: 2 })
  expect(snapshots).toHaveLength(publishCount)

  views[0]!.webContents.emit('did-start-loading')
  expect(manager.sessionInfo('session-a')?.documentCount).toBeNull()
  expect(() => manager.reportState(session.webContentsId, { documentCount: -1 }))
    .toThrow('Invalid PowerPoint runtime document count')
  expect(() => manager.reportState(999, { documentCount: 1 })).toThrow('does not own')
  manager.closeAll()
})

it('rejects unknown close senders and preserves a replacement target during deferred close', async () => {
  const views: FakeView[] = []
  const manager = new EmbeddedPowerPointManager(
    () => {
      const view = new FakeView(views.length + 1)
      views.push(view)
      return view as unknown as WebContentsView
    },
    async () => {},
  )
  manager.attachHost({
    isDestroyed: () => false,
    contentView: { addChildView: () => {}, removeChildView: () => {} },
  } as unknown as BrowserWindow)
  const first = await manager.ensureSession('session-a')
  const other = await manager.ensureSession('session-b')
  expect(manager.sessionForContents(first.webContentsId)).toBe('session-a')
  expect(() => manager.sessionForContents(99)).toThrow('does not own')
  manager.closeSession('session-a')
  const replacement = await manager.ensureSession('session-a')
  manager.closeCurrentSession(first.webContentsId)
  expect(manager.snapshot().sessions.map((item) => item.webContentsId)).toEqual([
    other.webContentsId, replacement.webContentsId,
  ])
  manager.closeCurrentSession(replacement.webContentsId)
  expect(manager.snapshot().sessions.map((item) => item.sessionId)).toEqual(['session-b'])
  manager.closeAll()
})

it('shares one pending PPT initialization and rejects it if the Session closes before load completes', async () => {
  const views: FakeView[] = []
  const children = new Set<WebContentsView>()
  let completeLoad!: () => void
  const manager = new EmbeddedPowerPointManager(
    () => {
      const view = new FakeView(views.length + 1)
      views.push(view)
      return view as unknown as WebContentsView
    },
    () => new Promise<void>((resolve) => { completeLoad = resolve }),
  )
  manager.attachHost({
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: WebContentsView) => children.add(view),
      removeChildView: (view: WebContentsView) => children.delete(view),
    },
  } as unknown as BrowserWindow)
  const first = manager.ensureSession('session-a')
  const second = manager.ensureSession('session-a')
  expect(views).toHaveLength(1)
  const results = Promise.allSettled([first, second])
  const warn = spyOn(windowLog, 'warn').mockImplementation(() => {})
  try {
    manager.closeSession('session-a')
    completeLoad()
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('closed during creation') }) },
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('closed during creation') }) },
    ])
  } finally {
    warn.mockRestore()
  }
  expect(children.size).toBe(0)
  expect(manager.snapshot().sessions).toEqual([])
})

it('recreates a crashed PPT target without changing its Session or losing active presentation', async () => {
  const views: FakeView[] = []
  const manager = new EmbeddedPowerPointManager(
    () => {
      const view = new FakeView(views.length + 1)
      views.push(view)
      return view as unknown as WebContentsView
    },
    async () => {},
  )
  manager.attachHost({
    isDestroyed: () => false,
    contentView: { addChildView: () => {}, removeChildView: () => {} },
  } as unknown as BrowserWindow)
  const before = await manager.ensureSession('session-a')
  manager.activateSession('session-a')
  manager.setVisible(true)
  views[0]!.webContents.emit('render-process-gone')
  expect(manager.sessionInfo('session-a')?.crashed).toBe(true)
  expect(manager.sessionInfo('session-a')?.targetId).toBeNull()
  const after = await manager.ensureSession('session-a')
  expect(after.sessionId).toBe(before.sessionId)
  expect(after.targetId).not.toBe(before.targetId)
  expect(after.crashed).toBe(false)
  expect(views[0]!.webContents.isDestroyed()).toBe(true)
  expect(views[1]!.visible).toBe(true)
  manager.closeAll()
})
