/** Session-scoped workbench selection and browser expansion state. */
import { describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'

const g = globalThis as { window?: unknown }
g.window ??= {}
const w = g.window as { api?: Record<string, unknown>; addEventListener?: () => void }
w.api = {
  ...w.api,
  settings: {
    set: mock(async (_next: GuiSettings) => {}),
    get: mock(async () => DEFAULT_SETTINGS),
  },
}
w.addEventListener ??= () => {}

const {
  SessionWorkbenchSurface,
  browserExpandedAtom,
  sessionWorkbenchSurfaceAtom,
  setSessionWorkbenchSurfaceAtom,
} = await import('../browser')
const {
  browserNeedsAttentionFamily,
  purgeBrowserAttentionAtom,
  setBrowserNeedsAttentionAtom,
} = await import('../browser-attention')
const { filesNeedsAttentionFamily } = await import('../files-attention')
const {
  requestRightPanelCollapseAtom,
  rightPanelCollapsedAtom,
  setRightPanelCollapsedAtom,
} = await import('../layout')
const {
  SessionFocusPaneKind,
  setSessionFocusPaneAtom,
} = await import('../session-focus-pane')
const { activeSessionIdAtom } = await import('../sessions')
const { settingsAtom } = await import('../settings')
const { notifySessionWorkbenchActivityAtom } = await import('../workbench')

describe('sessionWorkbenchSurfaceAtom', () => {
  it('defaults every viewed Session to the file system', () => {
    const store = createStore()
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
  })

  it('keeps all six tool selections isolated by viewed Session', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Schedules)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)
    store.set(setSessionWorkbenchSurfaceAtom, () => SessionWorkbenchSurface.Browser)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Schedules)
    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)

    store.set(activeSessionIdAtom, 'session-c')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Excel)
    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Schedules)
    store.set(activeSessionIdAtom, 'session-c')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Excel)
  })

  it('ignores writes while no Session is being viewed', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: 'assets' },
    })

    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Workflows)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)

    store.set(settingsAtom, DEFAULT_SETTINGS)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
  })
})

describe('browserExpandedAtom', () => {
  it('does not let one Session expansion affect another Session', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(browserExpandedAtom, true)
    expect(store.get(browserExpandedAtom)).toBe(true)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(browserExpandedAtom)).toBe(false)
    store.set(browserExpandedAtom, (expanded) => !expanded)
    expect(store.get(browserExpandedAtom)).toBe(true)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(browserExpandedAtom)).toBe(true)
    store.set(browserExpandedAtom, false)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(browserExpandedAtom)).toBe(true)
    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(browserExpandedAtom)).toBe(false)
  })

  it('is collapsed and immutable while no Session is being viewed', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: 'assets' },
    })

    store.set(browserExpandedAtom, true)
    expect(store.get(browserExpandedAtom)).toBe(false)

    store.set(settingsAtom, DEFAULT_SETTINGS)
    expect(store.get(browserExpandedAtom)).toBe(false)
  })
})

describe('notifySessionWorkbenchActivityAtom', () => {
  it('reveals each new activity when the right column is empty', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)

    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Browser,
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(browserNeedsAttentionFamily('session-a'))).toBe(true)

    store.set(setRightPanelCollapsedAtom, true)
    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Files,
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily('session-a'))).toBe(true)
  })

  it('keeps an occupied surface and latches background attention', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, false)

    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Browser,
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(browserNeedsAttentionFamily('session-a'))).toBe(true)
  })

  it('never replays a background Session activity after switching back', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(setRightPanelCollapsedAtom, true)
    store.set(activeSessionIdAtom, 'session-b')

    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Browser,
    })
    expect(store.get(browserNeedsAttentionFamily('session-a'))).toBe(true)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
  })

  it('never replays activity that began outside the Home view', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(setRightPanelCollapsedAtom, true)
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: 'assets' },
    })

    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Browser,
    })
    expect(store.get(browserNeedsAttentionFamily('session-a'))).toBe(true)

    store.set(settingsAtom, DEFAULT_SETTINGS)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
  })

  it('lets Agent ownership and pending collapse outrank auto-reveal', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(setRightPanelCollapsedAtom, true)
    store.set(setSessionFocusPaneAtom, { kind: SessionFocusPaneKind.TaskSpec })
    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Files,
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(filesNeedsAttentionFamily('session-a'))).toBe(true)

    store.set(setSessionFocusPaneAtom, null)
    store.set(requestRightPanelCollapseAtom)
    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Browser,
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(browserNeedsAttentionFamily('session-a'))).toBe(true)
  })

  it('atomically gives the first simultaneous activity the foreground', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(setRightPanelCollapsedAtom, true)

    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Files,
    })
    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: 'session-a',
      surface: SessionWorkbenchSurface.Browser,
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily('session-a'))).toBe(true)
    expect(store.get(browserNeedsAttentionFamily('session-a'))).toBe(true)
  })
})

describe('browserNeedsAttentionFamily', () => {
  it('isolates attention by Session and drops deleted Session state', () => {
    const store = createStore()
    store.set(setBrowserNeedsAttentionAtom, {
      sessionId: 'session-a',
      needsAttention: true,
    })
    expect(store.get(browserNeedsAttentionFamily('session-a'))).toBe(true)
    expect(store.get(browserNeedsAttentionFamily('session-b'))).toBe(false)

    store.set(setBrowserNeedsAttentionAtom, {
      sessionId: 'session-b',
      needsAttention: true,
    })
    store.set(purgeBrowserAttentionAtom, 'session-a')
    expect(store.get(browserNeedsAttentionFamily('session-a'))).toBe(false)
    expect(store.get(browserNeedsAttentionFamily('session-b'))).toBe(true)
  })
})
