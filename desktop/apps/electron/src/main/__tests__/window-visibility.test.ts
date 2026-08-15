import { describe, expect, it } from 'bun:test'
import {
  initializeTrayWithFailOpen,
  isNativeWindowForeground,
  MainWindowVisibilityLatch,
} from '../window-visibility'

describe('MainWindowVisibilityLatch', () => {
  it('keeps an initial background window hidden when it becomes ready', () => {
    const latch = new MainWindowVisibilityLatch()

    latch.beginCreation(false)

    expect(latch.markReady(false)).toBe(false)
  })

  it('shows a normal initial window when it becomes ready', () => {
    const latch = new MainWindowVisibilityLatch()

    latch.beginCreation(true)

    expect(latch.markReady(false)).toBe(true)
  })

  it('latches a foreground request that arrives while a hidden window loads', () => {
    const latch = new MainWindowVisibilityLatch()
    latch.beginCreation(false)

    expect(latch.requestForeground()).toBe(false)
    expect(latch.markReady(false)).toBe(true)
  })

  it('reveals an existing native host immediately even before renderer readiness', () => {
    const latch = new MainWindowVisibilityLatch()
    latch.beginCreation(false)

    expect(latch.requestForeground(true)).toBe(true)
  })

  it('asks the caller to reveal immediately once the hidden window is ready', () => {
    const latch = new MainWindowVisibilityLatch()
    latch.beginCreation(false)
    expect(latch.markReady(false)).toBe(false)

    expect(latch.requestForeground()).toBe(true)
  })

  it('does not reveal after session-ending marks presentation blocked', () => {
    const latch = new MainWindowVisibilityLatch()
    latch.beginCreation(true)

    expect(latch.markReady(true)).toBe(false)
  })

  it('drops foreground state when the native window is destroyed', () => {
    const latch = new MainWindowVisibilityLatch()
    latch.beginCreation(true)
    expect(latch.markReady(false)).toBe(true)

    latch.reset()
    latch.beginCreation(false)

    expect(latch.markReady(false)).toBe(false)
  })
})

describe('isNativeWindowForeground', () => {
  it('requires the native window to be visible, focused, and restored', () => {
    const state = { destroyed: false, focused: true, minimized: false, visible: true }
    const window = {
      isDestroyed: () => state.destroyed,
      isFocused: () => state.focused,
      isMinimized: () => state.minimized,
      isVisible: () => state.visible,
    }

    expect(isNativeWindowForeground(window)).toBe(true)
    state.focused = false
    expect(isNativeWindowForeground(window)).toBe(false)
    state.focused = true
    state.minimized = true
    expect(isNativeWindowForeground(window)).toBe(false)
    state.minimized = false
    state.visible = false
    expect(isNativeWindowForeground(window)).toBe(false)
    state.visible = true
    state.destroyed = true
    expect(isNativeWindowForeground(window)).toBe(false)
  })
})

describe('initializeTrayWithFailOpen', () => {
  it('enables hide-on-close only after native tray initialization succeeds', () => {
    const events: string[] = []

    const initialized = initializeTrayWithFailOpen({
      initialize: () => events.push('initialize'),
      destroyPartial: () => events.push('destroy'),
      setHideOnClose: (enabled) => events.push(`hide:${enabled}`),
      failOpen: () => events.push('fail-open'),
      reportError: () => events.push('error'),
    })

    expect(initialized).toBe(true)
    expect(events).toEqual(['initialize', 'hide:true'])
  })

  it('destroys partial tray state, keeps close native, and fails open on error', () => {
    const events: string[] = []
    const failure = new Error('tray unavailable')

    const initialized = initializeTrayWithFailOpen({
      initialize: () => {
        events.push('initialize')
        throw failure
      },
      destroyPartial: () => events.push('destroy'),
      setHideOnClose: (enabled) => events.push(`hide:${enabled}`),
      failOpen: () => events.push('fail-open'),
      reportError: (error) => events.push(error === failure ? 'error' : 'wrong-error'),
    })

    expect(initialized).toBe(false)
    expect(events).toEqual(['initialize', 'destroy', 'hide:false', 'error', 'fail-open'])
  })

  it('still fails open when partial tray cleanup also throws', () => {
    const events: string[] = []

    initializeTrayWithFailOpen({
      initialize: () => {
        throw new Error('init')
      },
      destroyPartial: () => {
        throw new Error('cleanup')
      },
      setHideOnClose: (enabled) => events.push(`hide:${enabled}`),
      failOpen: () => events.push('fail-open'),
      reportError: () => events.push('error'),
      reportCleanupError: () => events.push('cleanup-error'),
    })

    expect(events).toEqual(['cleanup-error', 'hide:false', 'error', 'fail-open'])
  })
})
