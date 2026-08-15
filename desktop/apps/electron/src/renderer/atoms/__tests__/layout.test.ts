/** Session isolation for the right-side dock's geometry and handoff state. */
import { describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'

const g = globalThis as { window?: unknown }
g.window ??= {}
const w = g.window as { api?: Record<string, unknown> }
w.api = {
  ...w.api,
  settings: {
    set: mock(async (_next: GuiSettings) => {}),
    get: mock(async () => DEFAULT_SETTINGS),
  },
}

const {
  browserDockWidthAtom,
  clearRightPanelCollapseRequestAtom,
  purgeRightPanelLayoutState,
  rememberRightPanelStateAtom,
  remapRightPanelLayoutStateAtom,
  requestRightPanelCollapseAtom,
  rightPanelCollapseRequestAtom,
  rightPanelCollapsedAtom,
  rightPanelWidthAtom,
  setBrowserDockWidthAtom,
  setRightPanelCollapsedAtom,
  setRightPanelWidthAtom,
} = await import('../layout')
const { activeSessionIdAtom } = await import('../sessions')

describe('right-panel Session state', () => {
  it('restores each Session\'s own open or collapsed state after switching', () => {
    const store = createStore()

    store.set(activeSessionIdAtom, 'session-a')
    store.set(setRightPanelCollapsedAtom, false)

    store.set(activeSessionIdAtom, 'session-b')
    store.set(setRightPanelCollapsedAtom, true)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
  })

  it('snapshots an inherited state before another Session changes the fallback', () => {
    const store = createStore()

    store.set(activeSessionIdAtom, 'session-a')
    store.set(rememberRightPanelStateAtom, 'session-a')

    store.set(activeSessionIdAtom, 'session-b')
    store.set(setRightPanelCollapsedAtom, true)
    store.set(setRightPanelWidthAtom, 460)
    store.set(setBrowserDockWidthAtom, 700)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(rightPanelWidthAtom)).toBe(320)
    expect(store.get(browserDockWidthAtom)).toBeNull()
  })

  it('restores both ordinary panel and Browser widths per Session', () => {
    const store = createStore()

    store.set(activeSessionIdAtom, 'session-a')
    store.set(setRightPanelWidthAtom, 440)
    store.set(setBrowserDockWidthAtom, 680)

    store.set(activeSessionIdAtom, 'session-b')
    store.set(setRightPanelWidthAtom, 600)
    store.set(setBrowserDockWidthAtom, 760)
    expect(store.get(rightPanelWidthAtom)).toBe(600)
    expect(store.get(browserDockWidthAtom)).toBe(760)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(rightPanelWidthAtom)).toBe(440)
    expect(store.get(browserDockWidthAtom)).toBe(680)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(rightPanelWidthAtom)).toBe(600)
    expect(store.get(browserDockWidthAtom)).toBe(760)
  })

  it('does not deliver a pending collapse handoff to another Session', () => {
    const store = createStore()

    store.set(activeSessionIdAtom, 'session-a')
    store.set(requestRightPanelCollapseAtom)
    expect(store.get(rightPanelCollapseRequestAtom)).toBe(true)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(rightPanelCollapseRequestAtom)).toBe(false)
    store.set(requestRightPanelCollapseAtom)
    store.set(clearRightPanelCollapseRequestAtom)
    expect(store.get(rightPanelCollapseRequestAtom)).toBe(false)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(rightPanelCollapseRequestAtom)).toBe(true)
  })

  it('releases remembered widths when a Session is deleted', () => {
    const store = createStore()

    store.set(activeSessionIdAtom, 'session-deleted')
    store.set(setRightPanelWidthAtom, 440)
    store.set(setBrowserDockWidthAtom, 680)
    store.set(activeSessionIdAtom, 'session-fallback')
    store.set(setRightPanelWidthAtom, 600)
    store.set(setBrowserDockWidthAtom, 760)

    purgeRightPanelLayoutState('session-deleted')
    store.set(activeSessionIdAtom, 'session-deleted')
    expect(store.get(rightPanelWidthAtom)).toBe(600)
    expect(store.get(browserDockWidthAtom)).toBe(760)
  })

  it('moves draft visibility and handoff state to the materialized daemon id', () => {
    const store = createStore()

    store.set(activeSessionIdAtom, 'draft:new')
    store.set(setRightPanelCollapsedAtom, true)
    store.set(setRightPanelWidthAtom, 430)
    store.set(setBrowserDockWidthAtom, 650)
    store.set(requestRightPanelCollapseAtom)

    // Another Session changes the persisted fallback while the create request is
    // in flight; the daemon id must still receive the draft's own state.
    store.set(activeSessionIdAtom, 'session-other')
    store.set(setRightPanelCollapsedAtom, false)
    store.set(setRightPanelWidthAtom, 360)
    store.set(setBrowserDockWidthAtom, 520)
    store.set(remapRightPanelLayoutStateAtom, {
      sourceSessionId: 'draft:new',
      targetSessionId: 'session-materialized',
    })

    store.set(activeSessionIdAtom, 'session-materialized')
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(rightPanelWidthAtom)).toBe(430)
    expect(store.get(browserDockWidthAtom)).toBe(650)
    expect(store.get(rightPanelCollapseRequestAtom)).toBe(true)

    store.set(activeSessionIdAtom, 'draft:new')
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(rightPanelWidthAtom)).toBe(360)
    expect(store.get(browserDockWidthAtom)).toBe(520)
    expect(store.get(rightPanelCollapseRequestAtom)).toBe(false)
  })
})
