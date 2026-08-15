import { describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { App, BrowserWindow } from 'electron'
import { installWindowsSessionEndGuard } from '../windows-session-end'

function fakeApp(): EventEmitter & App {
  return new EventEmitter() as EventEmitter & App
}

function fakeWindow(): EventEmitter & BrowserWindow {
  return new EventEmitter() as EventEmitter & BrowserWindow
}

describe('installWindowsSessionEndGuard', () => {
  it('does not register the app lifecycle hook off Windows', () => {
    const app = fakeApp()
    const onSessionEnd = mock(() => {})

    installWindowsSessionEndGuard(app, onSessionEnd, 'darwin')

    expect(app.listenerCount('browser-window-created')).toBe(0)
    expect(onSessionEnd).not.toHaveBeenCalled()
  })

  it('binds every created window and deduplicates each event kind across them', () => {
    const app = fakeApp()
    const firstWindow = fakeWindow()
    const recreatedWindow = fakeWindow()
    const onSessionEnd = mock(() => {})
    const preventDefault = mock(() => {})
    const dispose = installWindowsSessionEndGuard(app, onSessionEnd, 'win32')

    app.emit('browser-window-created', {}, firstWindow)
    expect(firstWindow.listenerCount('query-session-end')).toBe(1)
    expect(firstWindow.listenerCount('session-end')).toBe(1)

    // A replacement main window created later receives the same protection.
    app.emit('browser-window-created', {}, recreatedWindow)
    expect(recreatedWindow.listenerCount('query-session-end')).toBe(1)
    expect(recreatedWindow.listenerCount('session-end')).toBe(1)

    firstWindow.emit('query-session-end', { preventDefault })
    recreatedWindow.emit('query-session-end', { preventDefault })
    recreatedWindow.emit('session-end', { preventDefault })
    firstWindow.emit('session-end', { preventDefault })

    expect(onSessionEnd).toHaveBeenNthCalledWith(1, 'query-session-end')
    expect(onSessionEnd).toHaveBeenNthCalledWith(2, 'session-end')
    expect(onSessionEnd).toHaveBeenCalledTimes(2)
    expect(preventDefault).not.toHaveBeenCalled()

    dispose()
    expect(app.listenerCount('browser-window-created')).toBe(0)
    expect(firstWindow.listenerCount('query-session-end')).toBe(0)
    expect(firstWindow.listenerCount('session-end')).toBe(0)
    expect(recreatedWindow.listenerCount('query-session-end')).toBe(0)
    expect(recreatedWindow.listenerCount('session-end')).toBe(0)
  })

  it('releases a destroyed window without affecting future window bindings', () => {
    const app = fakeApp()
    const firstWindow = fakeWindow()
    const recreatedWindow = fakeWindow()
    const onSessionEnd = mock(() => {})
    const dispose = installWindowsSessionEndGuard(app, onSessionEnd, 'win32')

    app.emit('browser-window-created', {}, firstWindow)
    firstWindow.emit('closed')
    expect(firstWindow.listenerCount('query-session-end')).toBe(0)
    expect(firstWindow.listenerCount('session-end')).toBe(0)
    expect(firstWindow.listenerCount('closed')).toBe(0)

    app.emit('browser-window-created', {}, recreatedWindow)
    recreatedWindow.emit('query-session-end', {})
    expect(onSessionEnd).toHaveBeenCalledWith('query-session-end')

    dispose()
    expect(recreatedWindow.listenerCount('query-session-end')).toBe(0)
    expect(recreatedWindow.listenerCount('session-end')).toBe(0)
    expect(recreatedWindow.listenerCount('closed')).toBe(0)
  })
})
