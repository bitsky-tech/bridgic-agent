import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'

export interface OfficeSessionRecord {
  sessionId: string
  view: WebContentsView
  targetId: string | null
  crashed: boolean
  ready: Promise<void>
}

export interface OfficeSessionContainerOptions<T extends OfficeSessionRecord> {
  label: string
  visibility?: 'hide' | 'park-active'
  closeOptions?: { waitForBeforeUnload: boolean }
  onStateChanged: () => void
  onError?: (error: unknown, record: T) => void
}

/** Owns native views and asynchronous target creation, independently of editor documents. */
export class OfficeSessionContainer<T extends OfficeSessionRecord> {
  private host: BrowserWindow | null = null
  private readonly records = new Map<string, T>()
  private readonly generations = new WeakMap<T, number>()
  private activeId: string | null = null
  private bounds: Rectangle = { x: 0, y: 0, width: 1280, height: 800 }
  private visible = false

  constructor(private readonly options: OfficeSessionContainerOptions<T>) {}

  get activeSessionId(): string | null { return this.activeId }
  get(sessionId: string): T | undefined { return this.records.get(sessionId) }
  values(): IterableIterator<T> { return this.records.values() }
  owns(record: T): boolean { return this.records.get(record.sessionId) === record }

  forWebContents(webContentsId: number): T | null {
    return [...this.records.values()].find((record) => (
      record.view.webContents.id === webContentsId && !record.view.webContents.isDestroyed()
    )) ?? null
  }

  attachHost(host: BrowserWindow): void {
    if (this.host === host) return
    if (this.host) this.closeAll()
    this.host = host
  }

  detachHost(host: BrowserWindow): void {
    if (this.host !== host) return
    this.closeAll()
    this.host = null
  }

  /** Register synchronously before starting async loading so concurrent ensures share one target. */
  ensure(sessionId: string, create: () => T, load: (record: T) => Promise<void>, shouldReplace?: (record: T) => boolean): T {
    const previous = this.records.get(sessionId)
    if (previous && !previous.view.webContents.isDestroyed() && !shouldReplace?.(previous)) return previous
    const host = this.host
    if (!host || host.isDestroyed()) throw new Error('main window is unavailable')
    if (previous) {
      this.records.delete(sessionId)
      this.dispose(previous)
    }
    let record: T
    try {
      record = create()
      if (record.sessionId !== sessionId) {
        this.dispose(record)
        throw new Error(`${this.options.label} record Session does not match`)
      }
    } catch (error) {
      if (this.activeId === sessionId) this.activeId = null
      this.publish()
      throw error
    }
    this.records.set(sessionId, record)
    try {
      record.view.setBounds(this.bounds)
      record.view.setVisible(false)
      host.contentView.addChildView(record.view)
    } catch (error) {
      this.closeSession(sessionId)
      throw error
    }
    record.view.webContents.once('destroyed', () => {
      if (!this.owns(record)) return
      this.records.delete(sessionId)
      if (this.activeId === sessionId) this.activeId = null
      this.removeView(record)
      this.publish()
    })
    this.reload(record, load)
    this.publish()
    return record
  }

  /** A late load or debugger result cannot revive a closed or superseded target. */
  reload(record: T, load: (record: T) => Promise<void>): Promise<void> {
    const generation = (this.generations.get(record) ?? 0) + 1
    this.generations.set(record, generation)
    record.targetId = null
    const current = () => this.owns(record)
      && this.generations.get(record) === generation
      && !record.view.webContents.isDestroyed()
    const assertCurrent = () => {
      if (!current()) throw new Error(`${this.options.label} Session closed during creation: ${record.sessionId}`)
    }
    const ready = (async () => {
      assertCurrent()
      await load(record)
      assertCurrent()
      const targetId = await this.resolveTargetId(record.view)
      assertCurrent()
      record.targetId = targetId
      record.crashed = false
      this.publish()
    })().catch((error) => {
      if (this.owns(record) && this.generations.get(record) === generation) {
        this.closeSession(record.sessionId)
      }
      throw error
    })
    record.ready = ready
    void ready.catch((error) => this.options.onError?.(error, record))
    return ready
  }

  /** Keep a crashed Session in inventory while invalidating in-flight target discovery. */
  invalidate(record: T): void {
    if (!this.owns(record)) return
    this.generations.set(record, (this.generations.get(record) ?? 0) + 1)
    record.targetId = null
    record.crashed = true
    this.publish()
  }

  activateSession(sessionId: string | null): void {
    if (sessionId !== null && !this.records.has(sessionId)) {
      throw new Error(`${this.options.label} Session is unavailable: ${sessionId}`)
    }
    this.activeId = sessionId
    this.syncVisibility()
  }

  setBounds(bounds: Rectangle): void {
    if (bounds.width === 0 || bounds.height === 0) return
    this.bounds = { ...bounds }
    this.syncVisibility()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.syncVisibility()
  }

  closeSession(sessionId: string): void {
    const record = this.records.get(sessionId)
    if (!record) return
    this.records.delete(sessionId)
    if (this.activeId === sessionId) this.activeId = null
    this.dispose(record)
    this.publish()
  }

  closeAll(): void {
    const records = [...this.records.values()]
    this.records.clear()
    this.activeId = null
    this.visible = false
    for (const record of records) this.dispose(record)
    this.publish()
  }

  publish(): void {
    this.syncVisibility()
    this.options.onStateChanged()
  }

  private syncVisibility(): void {
    const hostAvailable = this.host && !this.host.isDestroyed()
    if (this.options.visibility === 'park-active') {
      const active = hostAvailable && this.activeId ? this.records.get(this.activeId) : undefined
      for (const record of this.records.values()) {
        if (record === active || record.view.webContents.isDestroyed()) continue
        record.view.setVisible(false)
        record.view.setBounds(this.bounds)
      }
      if (active && !active.view.webContents.isDestroyed()) {
        active.view.setBounds(this.visible
          ? this.bounds
          : { ...this.bounds, x: 1 - this.bounds.width, y: 1 - this.bounds.height })
        active.view.setVisible(true)
      }
      return
    }
    for (const record of this.records.values()) {
      if (record.view.webContents.isDestroyed()) continue
      const active = Boolean(hostAvailable && this.activeId === record.sessionId)
      if (active && this.visible) record.view.setBounds(this.bounds)
      record.view.setVisible(active && this.visible)
    }
  }

  private removeView(record: T): void {
    if (!this.host || this.host.isDestroyed()) return
    try {
      this.host.contentView.removeChildView(record.view)
    } catch {
      // The native host may already have removed its child view.
    }
  }

  private dispose(record: T): void {
    const contents = record.view.webContents
    if (!contents.isDestroyed()) record.view.setVisible(false)
    this.removeView(record)
    if (!contents.isDestroyed()) {
      if (this.options.closeOptions) contents.close(this.options.closeOptions)
      else contents.close()
    }
  }

  private async resolveTargetId(view: WebContentsView): Promise<string> {
    const debug = view.webContents.debugger
    const attachedHere = !debug.isAttached()
    if (attachedHere) debug.attach('1.3')
    try {
      const response = await debug.sendCommand('Target.getTargetInfo') as { targetInfo?: { targetId?: unknown } }
      const targetId = response.targetInfo?.targetId
      if (typeof targetId !== 'string' || !targetId) {
        throw new Error(`${this.options.label} renderer returned no CDP target id`)
      }
      return targetId
    } finally {
      if (attachedHere && !view.webContents.isDestroyed() && debug.isAttached()) debug.detach()
    }
  }
}
