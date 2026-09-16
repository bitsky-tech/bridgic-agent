import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import type { BrowserWindow, Rectangle, WebContentsView, WebContentsViewConstructorOptions } from 'electron'
import { DEFAULT_SETTINGS } from '@app/shared/types'
import { IPC } from '../../shared/ipc-channels'
import type { WordHostOpenRequest } from '../../shared/types'
import { WORD_FLUSH_TIMEOUT_MS, WORD_IMPORT_TIMEOUT_MS, WORD_OPEN_TIMEOUT_MS, WordHost } from '../word-host'
import { windowLog } from '../logger'

type Listener = (...args: unknown[]) => void

class FakeContents {
  destroyed = false
  zoom = 0
  url = 'http://localhost:5273/word.html?sessionId=a'
  sent: Array<[string, unknown]> = []
  listeners = new Map<string, Listener[]>()
  windowOpen: ((details: { url: string }) => { action: string }) | null = null
  debugger = {
    isAttached: () => false,
    attach: () => undefined,
    detach: () => undefined,
    sendCommand: async () => ({ targetInfo: { targetId: `word-target-${this.id}` } }),
  }

  constructor(readonly id: number) {}
  setBackgroundThrottling(): void {}
  setZoomLevel(value: number): void { this.zoom = value }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void { this.windowOpen = handler }
  isDestroyed(): boolean { return this.destroyed }
  isLoading(): boolean { return false }
  getURL(): string { return this.url }
  send(channel: string, value: unknown): void { this.sent.push([channel, value]) }
  on(event: string, listener: Listener): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]) }
  once(event: string, listener: Listener): void { this.on(event, listener) }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
  close(): void { this.destroyed = true; this.emit('destroyed') }
}

class FakeView {
  webContents: FakeContents
  bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  visible = false
  constructor(id: number) { this.webContents = new FakeContents(id) }
  setBounds(value: Rectangle): void { this.bounds = value }
  setVisible(value: boolean): void { this.visible = value }
}

const hosts = new Set<WordHost>()
afterEach(() => { for (const host of hosts) host.closeAll(); hosts.clear() })

function fixture(load: (view: FakeView, sessionId: string) => Promise<void> = async () => undefined, openExternal?: (url: string) => void) {
  const views: FakeView[] = []
  const options: WebContentsViewConstructorOptions[] = []
  const children: WebContentsView[] = []
  const host = new WordHost((value) => {
    options.push(value)
    const view = new FakeView(views.length + 1)
    views.push(view)
    return view as unknown as WebContentsView
  }, (view, sessionId) => load(view as unknown as FakeView, sessionId), undefined, openExternal)
  host.attachHost({
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: WebContentsView) => children.push(view),
      removeChildView: (view: WebContentsView) => {
        const index = children.indexOf(view)
        if (index !== -1) children.splice(index, 1)
      },
    },
  } as unknown as BrowserWindow)
  hosts.add(host)
  return { host, views, children, options }
}

const request: WordHostOpenRequest = { id: 'renderer-request', sessionId: 'a', name: 'document.docx', path: '/tmp/document.docx' }
async function settle(): Promise<void> { for (let index = 0; index < 12; index += 1) await Promise.resolve() }
function openTickets(view: FakeView): WordHostOpenRequest[] {
  return view.webContents.sent.filter(([channel]) => channel === IPC.events.wordHostOpenFileRequested).map(([, value]) => value as WordHostOpenRequest)
}
function flushTickets(view: FakeView): string[] {
  return view.webContents.sent.filter(([channel]) => channel === IPC.events.wordHostFlushRequested).map(([, value]) => value as string)
}

describe('Session-owned Word host', () => {
  it('allows large imports more time than renderer startup and still expires stalled requests', async () => {
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = []
    const setTimer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    const clearTimer = spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: unknown) => {
      const found = timers.find((item) => item === timer)
      if (found) found.cleared = true
    }) as typeof clearTimeout)
    try {
      const { host, views } = fixture()
      const opening = host.openFile('a', request)
      await settle()
      host.reportState(1, { documentCount: 0, persistenceStatus: 'saved' })
      expect(timers.find((timer) => timer.delay === WORD_OPEN_TIMEOUT_MS)?.cleared).toBe(true)
      expect(WORD_IMPORT_TIMEOUT_MS).toBeGreaterThan(WORD_OPEN_TIMEOUT_MS)
      expect(timers.filter((timer) => !timer.cleared).map((timer) => timer.delay)).toEqual([WORD_IMPORT_TIMEOUT_MS])
      host.completeOpenFile(1, openTickets(views[0]!)[0]!.id)
      await opening
      expect(timers.every((timer) => timer.cleared)).toBe(true)

      const stalled = host.openFile('a', request).catch((error: Error) => error)
      await settle()
      const ticket = openTickets(views[0]!).at(-1)!
      timers.find((timer) => !timer.cleared)!.callback()
      expect((await stalled as Error).message).toBe('Word document opening timed out')
      expect(() => host.completeOpenFile(1, ticket.id)).toThrow('invalid or expired')
      expect(views[0]!.webContents.destroyed).toBe(false)
    } finally { setTimer.mockRestore(); clearTimer.mockRestore() }
  })

  it('deduplicates target creation, preserves the default storage partition and keeps hidden Sessions alive', async () => {
    let loaded!: () => void
    const state = fixture(() => new Promise<void>((resolve) => { loaded = resolve }))
    const first = state.host.ensureSession('a')
    const again = state.host.ensureSession('a')
    expect(state.views).toHaveLength(1)
    expect(state.host.snapshot().sessions[0]?.documentCount).toBeNull()
    expect(state.options[0]?.webPreferences?.partition).toBeUndefined()
    loaded()
    expect(await first).toEqual(await again)
    state.host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
    state.host.activateSession('a')
    state.host.setBounds({ x: 10, y: 20, width: 600, height: 500 })
    state.host.setVisible(true)
    expect(state.views[0]?.visible).toBe(true)
    state.host.setVisible(false)
    expect(state.views[0]?.visible).toBe(false)
    expect(state.views[0]?.webContents.destroyed).toBe(false)
    expect(state.host.snapshot().sessions[0]?.documentCount).toBe(1)
  })

  it('queues imports until domain restoration and accepts only the owning renderer and one-use ticket', async () => {
    const { host, views } = fixture()
    await host.ensureSession('a')
    await host.ensureSession('b')
    const opening = host.openFile('a', request)
    await settle()
    expect(openTickets(views[0]!)).toEqual([])
    host.reportState(1, { documentCount: 0, persistenceStatus: 'saved' })
    const ticket = openTickets(views[0]!)[0]!
    expect(ticket.id).not.toBe(request.id)
    expect(ticket.sessionId).toBe('a')
    expect(openTickets(views[1]!)).toEqual([])
    expect(() => host.completeOpenFile(2, ticket.id)).toThrow('invalid or expired')
    expect(() => host.completeOpenFile(99, ticket.id)).toThrow('does not own')
    host.completeOpenFile(1, ticket.id)
    await opening
    expect(() => host.completeOpenFile(1, ticket.id)).toThrow('invalid or expired')
    await expect(host.openFile('b', request)).rejects.toThrow('identify its Session')
  })

  it('propagates import failure and rejects pending imports when their Session is deleted', async () => {
    const { host, views } = fixture()
    await host.ensureSession('a')
    host.reportState(1, { documentCount: 0, persistenceStatus: 'saved' })
    const failed = host.openFile('a', request).catch((error: Error) => error)
    await settle()
    host.completeOpenFile(1, openTickets(views[0]!)[0]!.id, 'Invalid DOCX archive')
    expect((await failed as Error).message).toBe('Invalid DOCX archive')
    const closed = host.openFile('a', request).catch((error: Error) => error)
    await settle()
    host.closeSession('a')
    expect((await closed as Error).message).toContain('was closed')
    expect(host.snapshot().sessions).toEqual([])
  })

  it('waits for an explicit flush acknowledgement from every Session instead of trusting saved status', async () => {
    const { host, views } = fixture()
    await host.ensureSession('a')
    await host.ensureSession('b')
    host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
    host.reportState(2, { documentCount: 0, persistenceStatus: 'saved' })
    let finished = false
    const flushing = host.flushAll().then((result) => { finished = true; return result })
    await settle()
    expect(finished).toBe(false)
    const ticketA = flushTickets(views[0]!)[0]!
    const ticketB = flushTickets(views[1]!)[0]!
    expect(() => host.completeFlush(2, ticketA, true)).toThrow('invalid or expired')
    host.completeFlush(1, ticketA, true)
    await settle()
    expect(finished).toBe(false)
    host.completeFlush(2, ticketB, true)
    expect(await flushing).toBe(true)
    expect(() => host.completeFlush(1, ticketA, true)).toThrow('invalid or expired')
    expect(views.every((view) => !view.webContents.destroyed)).toBe(true)
  })

  it('returns false for failed and timed-out flushes without destroying document targets', async () => {
    const { host, views } = fixture()
    await host.ensureSession('a')
    host.reportState(1, { documentCount: 1, persistenceStatus: 'error' })
    const failed = host.flushAll()
    await settle()
    host.completeFlush(1, flushTickets(views[0]!)[0]!, false)
    expect(await failed).toBe(false)
    const timeoutCallbacks: Array<() => void> = []
    const originalSetTimeout = globalThis.setTimeout
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      if (delay === WORD_FLUSH_TIMEOUT_MS) {
        timeoutCallbacks.push(callback)
        return 0 as unknown as ReturnType<typeof setTimeout>
      }
      return originalSetTimeout(callback, delay)
    }) as typeof setTimeout)
    try {
      const timedOut = host.flushAll()
      await settle()
      for (const callback of timeoutCallbacks) callback()
      expect(await timedOut).toBe(false)
      expect(views[0]?.webContents.destroyed).toBe(false)
    } finally { timerSpy.mockRestore() }
  })

  it('queues flush requests while the runtime is restoring its workspace', async () => {
    const { host, views } = fixture()
    await host.ensureSession('a')
    const flushing = host.flushAll()
    await settle()
    expect(flushTickets(views[0]!)).toEqual([])
    host.reportState(1, { documentCount: 0, persistenceStatus: 'saved' })
    const ticket = flushTickets(views[0]!)[0]!
    host.completeFlush(1, ticket, true)
    expect(await flushing).toBe(true)
  })

  it('restores a crashed runtime once and stops repeated crash recovery', async () => {
    let loads = 0
    const { host, views } = fixture(async () => { loads += 1 })
    await host.ensureSession('a')
    host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
    const opening = host.openFile('a', request).catch((error: Error) => error)
    await settle()
    views[0]!.webContents.emit('render-process-gone')
    expect((await opening as Error).message).toContain('crashed')
    await settle()
    expect(loads).toBe(2)
    expect(host.snapshot().sessions[0]?.documentCount).toBeNull()
    expect(host.snapshot().sessions[0]?.crashed).toBe(false)
    host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
    views[0]!.webContents.emit('render-process-gone')
    await settle()
    expect(loads).toBe(2)
    expect(host.snapshot().sessions[0]?.crashed).toBe(true)
    expect(await host.flushAll()).toBe(false)
  })

  it('does not revive a Session deleted while its target is still loading', async () => {
    let loaded!: () => void
    const { host, children } = fixture(() => new Promise<void>((resolve) => { loaded = resolve }))
    const creating = host.ensureSession('a').catch((error: Error) => error)
    host.closeSession('a')
    const warn = spyOn(windowLog, 'warn').mockImplementation(() => undefined)
    try {
      loaded()
      expect((await creating as Error).message).toContain('closed during loading')
    } finally { warn.mockRestore() }
    expect(host.snapshot().sessions).toEqual([])
    expect(children).toEqual([])
  })

  it('does not let target discovery revive a runtime that crashed again during recovery', async () => {
    const { host, views } = fixture()
    await host.ensureSession('a')
    let discovered!: () => void
    views[0]!.webContents.debugger.sendCommand = () => new Promise((resolve) => {
      discovered = () => resolve({ targetInfo: { targetId: 'stale-recovery-target' } })
    })
    views[0]!.webContents.emit('render-process-gone')
    await settle()
    views[0]!.webContents.emit('render-process-gone')
    const warn = spyOn(windowLog, 'warn').mockImplementation(() => undefined)
    try {
      discovered()
      await settle()
    } finally { warn.mockRestore() }
    expect(host.snapshot().sessions[0]?.crashed).toBe(true)
    expect(host.snapshot().sessions[0]?.targetId).toBeNull()
    expect(await host.flushAll()).toBe(false)
  })

  it('validates runtime reports and isolates expansion, settings and native navigation', async () => {
    const { host, views } = fixture()
    await host.ensureSession('a')
    await host.ensureSession('b')
    expect(() => host.reportState(1, { documentCount: -1, persistenceStatus: 'saved' })).toThrow('Invalid Word runtime')
    expect(() => host.reportState(1, { documentCount: 0, persistenceStatus: 'unknown' })).toThrow('Invalid Word runtime')
    expect(host.setExpanded(1, true)).toEqual({ sessionId: 'a', expanded: true })
    expect(host.snapshot().sessions[1]?.expanded).toBe(false)
    const settings = { ...DEFAULT_SETTINGS, zoomLevel: 2, locale: 'en' }
    host.applySettings(settings)
    expect(host.getConfig()).toEqual(settings)
    expect(views.every((view) => view.webContents.zoom === 2)).toBe(true)
    let prevented = false
    views[0]!.webContents.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'https://example.com/word.html')
    expect(prevented).toBe(true)
    expect(views[0]!.webContents.windowOpen?.({ url: 'https://example.com' }).action).toBe('deny')
  })

  it('checkpoints the owning editor once before reloading and waits for the new workspace to restore', async () => {
    const opened: string[] = []
    const loads: string[] = []
    const { host, views } = fixture(async (_view, sessionId) => { loads.push(sessionId) }, (url) => opened.push(url))
    await host.ensureSession('a')
    await host.ensureSession('b')
    const contents = views[0]!.webContents
    for (const url of ['http://localhost:5273/word.html?sessionId=a', 'file:///application/word.html?sessionId=a']) {
      contents.url = url
      host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
      const previousLoads = loads.length
      const previousFlushes = flushTickets(views[0]!).length
      let prevented = false
      contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, url)
      contents.emit('will-navigate', { preventDefault: () => undefined }, url)
      await settle()
      expect(prevented).toBe(true)
      expect(loads).toHaveLength(previousLoads)
      expect(flushTickets(views[0]!)).toHaveLength(previousFlushes + 1)
      expect(flushTickets(views[1]!)).toEqual([])
      expect(contents.windowOpen?.({ url }).action).toBe('deny')
      expect(opened).toEqual([])
      host.completeFlush(1, flushTickets(views[0]!).at(-1)!, true)
      await settle()
      expect(loads).toHaveLength(previousLoads + 1)
      expect(loads.at(-1)).toBe('a')
      expect(host.snapshot().sessions[0]?.documentCount).toBeNull()
      expect(host.snapshot().sessions[0]?.persistenceStatus).toBeNull()

      const previousOpens = openTickets(views[0]!).length
      const opening = host.openFile('a', request)
      await settle()
      expect(openTickets(views[0]!)).toHaveLength(previousOpens)
      host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
      host.completeOpenFile(1, openTickets(views[0]!).at(-1)!.id)
      await opening
    }
    host.closeSession('a')
    let prevented = false
    contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, contents.url)
    expect(prevented).toBe(true)
    expect(opened).toEqual([])
  })

  it('retains the editor when a reload checkpoint fails or times out and permits a later retry', async () => {
    let loads = 0
    const { host, views } = fixture(async () => { loads += 1 })
    await host.ensureSession('a')
    host.reportState(1, { documentCount: 1, persistenceStatus: 'error' })
    const contents = views[0]!.webContents
    const reload = () => contents.emit('will-navigate', { preventDefault: () => undefined }, contents.url)
    reload()
    await settle()
    host.completeFlush(1, flushTickets(views[0]!).at(-1)!, false)
    await settle()
    expect(loads).toBe(1)
    expect(host.snapshot().sessions[0]?.documentCount).toBe(1)
    const timeoutCallbacks: Array<() => void> = []
    const originalSetTimeout = globalThis.setTimeout
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      if (delay === WORD_FLUSH_TIMEOUT_MS) {
        timeoutCallbacks.push(callback)
        return 0 as unknown as ReturnType<typeof setTimeout>
      }
      return originalSetTimeout(callback, delay)
    }) as typeof setTimeout)
    const warn = spyOn(windowLog, 'warn').mockImplementation(() => undefined)
    try {
      reload()
      await settle()
      for (const callback of timeoutCallbacks) callback()
      await settle()
      expect(loads).toBe(1)
      expect(contents.destroyed).toBe(false)
    } finally { timerSpy.mockRestore(); warn.mockRestore() }
    reload()
    await settle()
    host.completeFlush(1, flushTickets(views[0]!).at(-1)!, true)
    await settle()
    expect(loads).toBe(2)
  })

  it('does not interrupt a document import received after the reload checkpoint', async () => {
    let loads = 0
    const { host, views } = fixture(async () => { loads += 1 })
    await host.ensureSession('a')
    host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
    const contents = views[0]!.webContents
    contents.emit('will-navigate', { preventDefault: () => undefined }, contents.url)
    await settle()
    const opening = host.openFile('a', request)
    await settle()
    host.completeFlush(1, flushTickets(views[0]!)[0]!, true)
    await settle()
    expect(loads).toBe(1)
    expect(host.snapshot().sessions[0]?.documentCount).toBe(1)
    host.completeOpenFile(1, openTickets(views[0]!)[0]!.id)
    await opening
  })

  it('cancels a pending reload when input arrives after the native snapshot was captured', async () => {
    for (const inputEvent of ['before-input-event', 'before-mouse-event']) {
      let loads = 0
      const { host, views } = fixture(async () => { loads += 1 })
      await host.ensureSession('a')
      host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
      const contents = views[0]!.webContents
      const reload = () => contents.emit('will-navigate', { preventDefault: () => undefined }, contents.url)
      reload()
      await settle()
      // The renderer is waiting for storage, but a new edit's debounced native
      // snapshot has not reached the host's persistence status yet.
      let inputBlocked = false
      contents.emit(inputEvent, { preventDefault: () => { inputBlocked = true } }, {})
      host.completeFlush(1, flushTickets(views[0]!)[0]!, true)
      await settle()
      expect(inputBlocked).toBe(false)
      expect(loads).toBe(1)
      expect(host.snapshot().sessions[0]?.documentCount).toBe(1)
      reload()
      await settle()
      host.completeFlush(1, flushTickets(views[0]!).at(-1)!, true)
      await settle()
      expect(loads).toBe(2)
    }
  })

  it('does not reload a closed or crashed editor after its checkpoint was acknowledged', async () => {
    for (const interrupted of ['closed', 'crashed'] as const) {
      let loads = 0
      const { host, views } = fixture(async () => { loads += 1 })
      await host.ensureSession('a')
      host.reportState(1, { documentCount: 1, persistenceStatus: 'saved' })
      const contents = views[0]!.webContents
      contents.emit('will-navigate', { preventDefault: () => undefined }, contents.url)
      await settle()
      host.completeFlush(1, flushTickets(views[0]!)[0]!, true)
      if (interrupted === 'closed') host.closeSession('a')
      else contents.emit('render-process-gone')
      await settle()
      expect(loads).toBe(interrupted === 'closed' ? 1 : 2)
      if (interrupted === 'closed') expect(host.snapshot().sessions).toEqual([])
    }
  })

  it('opens document links externally while preventing child windows and editor navigation', async () => {
    const opened: string[] = []
    const { host, views } = fixture(undefined, (url) => opened.push(url))
    await host.ensureSession('a')
    const contents = views[0]!.webContents
    for (const url of ['https://example.com/document', 'http://example.com/reference', 'mailto:support@example.com']) {
      expect(contents.windowOpen?.({ url }).action).toBe('deny')
      let prevented = false
      contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, url)
      expect(prevented).toBe(true)
      expect(opened.slice(-2)).toEqual([url, url])
    }
    expect(opened).toHaveLength(6)
    expect(contents.destroyed).toBe(false)
    expect(host.snapshot().sessions[0]?.sessionId).toBe('a')
  })

  it('blocks unsafe URLs and redirects without forwarding them to the operating system', async () => {
    const opened: string[] = []
    const { host, views } = fixture(undefined, (url) => opened.push(url))
    await host.ensureSession('a')
    const contents = views[0]!.webContents
    for (const url of ['javascript:alert(1)', 'data:text/html,unsafe', 'file:///tmp/private.docx', 'custom:command', 'not a URL']) {
      expect(contents.windowOpen?.({ url }).action).toBe('deny')
      let prevented = false
      contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, url)
      expect(prevented).toBe(true)
    }
    let redirected = false
    contents.emit('will-redirect', { preventDefault: () => { redirected = true } }, 'https://example.com/redirect')
    expect(redirected).toBe(true)
    expect(opened).toEqual([])
  })

  it('ignores external-link callbacks from superseded or destroyed Word targets', async () => {
    const opened: string[] = []
    const { host, views } = fixture(undefined, (url) => opened.push(url))
    await host.ensureSession('a')
    const previous = views[0]!.webContents
    host.closeSession('a')
    await host.ensureSession('a')
    previous.destroyed = false
    const current = views[1]!.webContents
    current.destroyed = true
    for (const contents of [previous, current]) {
      expect(contents.windowOpen?.({ url: 'https://example.com/stale' }).action).toBe('deny')
      let prevented = false
      contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'https://example.com/stale')
      expect(prevented).toBe(true)
    }
    expect(opened).toEqual([])
  })

  it('still denies navigation when an external-link handler throws and redacts its warning', async () => {
    const { host, views } = fixture(undefined, () => { throw new Error('OS launch failure') })
    await host.ensureSession('a')
    const warn = spyOn(windowLog, 'warn').mockImplementation(() => undefined)
    try {
      expect(views[0]!.webContents.windowOpen?.({ url: 'https://example.com/page?token=secret#fragment' }).action).toBe('deny')
      expect(warn).toHaveBeenCalledWith('[word-host] external link failed url=https://example.com/page?[redacted]#[redacted]')
    } finally { warn.mockRestore() }
  })

  it('resets expansion on hide without closing documents or hiding another Session', async () => {
    const { host, views } = fixture()
    await host.ensureSession('a')
    await host.ensureSession('b')
    host.reportState(1, { documentCount: 2, persistenceStatus: 'saved' })
    host.setExpanded(1, true)
    host.activateSession('b')
    host.setVisible(true)
    expect(host.requestHide(1)).toEqual({ sessionId: 'a', expanded: false })
    expect(views[1]?.visible).toBe(true)
    expect(host.snapshot().sessions[0]?.expanded).toBe(false)
    expect(host.snapshot().sessions[0]?.documentCount).toBe(2)
    host.requestHide(2)
    expect(views[1]?.visible).toBe(false)
    expect(views.every((view) => !view.webContents.destroyed)).toBe(true)
    expect(() => host.requestHide(99)).toThrow('does not own')
  })
})
