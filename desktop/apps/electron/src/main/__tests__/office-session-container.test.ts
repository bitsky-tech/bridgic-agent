import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import { OfficeSessionContainer, type OfficeSessionRecord } from '../office-session-container'

class FakeContents extends EventEmitter {
  destroyed = false
  attached = false
  closeOptions: { waitForBeforeUnload: boolean } | undefined
  targetRequest: () => Promise<unknown> = async () => ({ targetInfo: { targetId: `target-${this.id}` } })
  readonly debugger = {
    isAttached: () => this.attached,
    attach: () => { this.attached = true },
    detach: () => { this.attached = false },
    sendCommand: () => this.targetRequest(),
  }
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.destroyed }
  close(options?: { waitForBeforeUnload: boolean }): void {
    this.closeOptions = options
    this.destroyed = true
    this.emit('destroyed')
  }
}

class FakeView {
  bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  visible = false
  constructor(readonly webContents: FakeContents) {}
  setBounds(bounds: Rectangle): void { this.bounds = { ...bounds } }
  setVisible(visible: boolean): void { this.visible = visible }
}

function fakeHost() {
  const children = new Set<WebContentsView>()
  const host = {
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: WebContentsView) => children.add(view),
      removeChildView: (view: WebContentsView) => children.delete(view),
    },
  } as unknown as BrowserWindow
  return { host, children }
}

function fixture(visibility: 'hide' | 'park-active' = 'hide') {
  const host = fakeHost()
  const views: FakeView[] = []
  const snapshots: string[][] = []
  const errors: unknown[] = []
  const container = new OfficeSessionContainer<OfficeSessionRecord>({
    label: 'Office', visibility,
    closeOptions: visibility === 'park-active' ? { waitForBeforeUnload: false } : undefined,
    onStateChanged: () => snapshots.push([...container.values()].map((record) => record.sessionId)),
    onError: (error) => { errors.push(error) },
  })
  container.attachHost(host.host)
  const create = (sessionId: string) => {
    const view = new FakeView(new FakeContents(views.length + 1))
    views.push(view)
    return { sessionId, view: view as unknown as WebContentsView, targetId: null, crashed: false, ready: Promise.resolve() }
  }
  return { ...host, views, snapshots, errors, container, create }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

describe('Office Session container ownership contract', () => {
  it('deduplicates concurrent initialization and retains separate targets for separate Sessions', async () => {
    const { container, create, views, children } = fixture()
    const load = deferred()
    const first = container.ensure('a', () => create('a'), () => load.promise)
    const duplicate = container.ensure('a', () => create('a'), async () => {})
    const second = container.ensure('b', () => create('b'), async () => {})
    expect(duplicate).toBe(first)
    expect(duplicate.ready).toBe(first.ready)
    expect(views).toHaveLength(2)
    expect(children.size).toBe(2)
    load.resolve()
    await Promise.all([first.ready, second.ready])
    expect(first.targetId).toBe('target-1')
    expect(second.targetId).toBe('target-2')
    expect(container.forWebContents(1)).toBe(first)
    expect(container.forWebContents(99)).toBeNull()
    container.closeAll()
  })

  it('rejects a closed pending target without removing its replacement', async () => {
    const { container, create, views, children } = fixture()
    const loading = deferred()
    const old = container.ensure('a', () => create('a'), () => loading.promise)
    container.closeSession('a')
    const replacement = container.ensure('a', () => create('a'), async () => {})
    await replacement.ready
    loading.resolve()
    await expect(old.ready).rejects.toThrow('closed during creation')
    expect(container.get('a')).toBe(replacement)
    expect(children.size).toBe(1)
    expect(views[0]!.webContents.destroyed).toBe(true)
    expect(views[1]!.webContents.destroyed).toBe(false)
    container.closeAll()
  })

  it('does not publish a debugger result that arrives after target disposal', async () => {
    const { container, create, views, snapshots } = fixture()
    const target = deferred<unknown>()
    const record = container.ensure('a', () => {
      const created = create('a')
      views[0]!.webContents.targetRequest = () => target.promise
      return created
    }, async () => {})
    await Promise.resolve()
    container.closeSession('a')
    const countAfterClose = snapshots.length
    target.resolve({ targetInfo: { targetId: 'late-target' } })
    await expect(record.ready).rejects.toThrow('closed during creation')
    expect(record.targetId).toBeNull()
    expect([...container.values()]).toEqual([])
    expect(snapshots).toHaveLength(countAfterClose)
  })

  it('disposes failed initialization and permits a later retry', async () => {
    const { container, create, views, children } = fixture()
    const first = container.ensure('a', () => create('a'), async () => { throw new Error('load failed') })
    await expect(first.ready).rejects.toThrow('load failed')
    expect(container.get('a')).toBeUndefined()
    expect(children.size).toBe(0)
    expect(views[0]!.webContents.destroyed).toBe(true)
    const retry = container.ensure('a', () => create('a'), async () => {})
    await retry.ready
    expect(retry.targetId).toBe('target-2')
    container.closeAll()
  })

  it('rejects missing CDP identity and releases the unusable native view', async () => {
    const { container, create, views, children } = fixture()
    const record = container.ensure('a', () => {
      const created = create('a')
      views[0]!.webContents.targetRequest = async () => ({ targetInfo: {} })
      return created
    }, async () => {})
    await expect(record.ready).rejects.toThrow('returned no CDP target id')
    expect(container.get('a')).toBeUndefined()
    expect(children.size).toBe(0)
    expect(views[0]!.webContents.attached).toBe(false)
    expect(views[0]!.webContents.destroyed).toBe(true)
  })

  it('preserves an existing debugger attachment while resolving the Session target', async () => {
    const { container, create, views } = fixture()
    const record = container.ensure('a', () => {
      const created = create('a')
      views[0]!.webContents.attached = true
      return created
    }, async () => {})
    await record.ready
    expect(record.targetId).toBe('target-1')
    expect(views[0]!.webContents.attached).toBe(true)
    container.closeAll()
  })

  it('keeps the newest reload when an older recovery fails later', async () => {
    const { container, create } = fixture()
    const record = container.ensure('a', () => create('a'), async () => {})
    await record.ready
    const oldLoad = deferred()
    const oldReady = container.reload(record, () => oldLoad.promise)
    const newReady = container.reload(record, async () => {})
    await newReady
    oldLoad.reject(new Error('superseded recovery failed'))
    await expect(oldReady).rejects.toThrow('superseded recovery failed')
    expect(record.ready).toBe(newReady)
    expect(container.get('a')).toBe(record)
    expect(record.targetId).toBe('target-1')
    container.closeAll()
  })

  it('keeps a repeated crash visible in inventory without accepting its in-flight target result', async () => {
    const { container, create, views } = fixture()
    const record = container.ensure('a', () => create('a'), async () => {})
    await record.ready
    const target = deferred<unknown>()
    views[0]!.webContents.targetRequest = () => target.promise
    const recovering = container.reload(record, async () => {})
    await Promise.resolve()
    container.invalidate(record)
    target.resolve({ targetInfo: { targetId: 'crashed-recovery-target' } })
    await expect(recovering).rejects.toThrow('closed during creation')
    expect(container.get('a')).toBe(record)
    expect(record.targetId).toBeNull()
    expect(record.crashed).toBe(true)
    expect(views[0]!.webContents.destroyed).toBe(false)
    container.closeAll()
  })

  it('replaces a crashed target while retaining its active Session', async () => {
    const { container, create, views } = fixture()
    const first = container.ensure('a', () => create('a'), async () => {})
    await first.ready
    container.activateSession('a')
    container.setVisible(true)
    first.crashed = true
    const second = container.ensure('a', () => create('a'), async () => {}, (record) => record.crashed)
    await second.ready
    expect(container.activeSessionId).toBe('a')
    expect(views[0]!.webContents.destroyed).toBe(true)
    expect(views[1]!.visible).toBe(true)
    container.closeAll()
  })

  it('closes an old host inventory and ignores detachment of an unrelated host', async () => {
    const state = fixture()
    const record = state.container.ensure('a', () => state.create('a'), async () => {})
    await record.ready
    const nextHost = fakeHost()
    state.container.detachHost(nextHost.host)
    expect(state.container.get('a')).toBe(record)
    state.container.attachHost(nextHost.host)
    expect([...state.container.values()]).toEqual([])
    expect(state.children.size).toBe(0)
    expect(state.views[0]!.webContents.destroyed).toBe(true)
    const next = state.container.ensure('b', () => state.create('b'), async () => {})
    await next.ready
    expect(nextHost.children.size).toBe(1)
    state.container.detachHost(nextHost.host)
    expect(nextHost.children.size).toBe(0)
    expect(() => state.container.ensure('c', () => state.create('c'), async () => {})).toThrow('main window is unavailable')
  })

  for (const visibility of ['hide', 'park-active'] as const) {
    it(`keeps ${visibility} presentation policy independent of Session ownership`, async () => {
      const { container, create, views } = fixture(visibility)
      const first = container.ensure('a', () => create('a'), async () => {})
      const second = container.ensure('b', () => create('b'), async () => {})
      await Promise.all([first.ready, second.ready])
      container.setBounds({ x: 100, y: 50, width: 600, height: 400 })
      container.activateSession('b')
      container.setVisible(true)
      expect(views[0]!.visible).toBe(false)
      expect(views[1]!.visible).toBe(true)
      expect(views[1]!.bounds).toEqual({ x: 100, y: 50, width: 600, height: 400 })
      container.setVisible(false)
      expect(views[1]!.visible).toBe(visibility === 'park-active')
      expect(views[1]!.bounds).toEqual(visibility === 'park-active'
        ? { x: -599, y: -399, width: 600, height: 400 }
        : { x: 100, y: 50, width: 600, height: 400 })
      container.activateSession(null)
      expect(views.every((view) => !view.visible)).toBe(true)
      expect([...container.values()]).toHaveLength(2)
      container.closeAll()
      expect(views[0]!.webContents.closeOptions).toEqual(visibility === 'park-active' ? { waitForBeforeUnload: false } : undefined)
    })
  }
})
