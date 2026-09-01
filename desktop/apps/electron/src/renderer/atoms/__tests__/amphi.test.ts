/**
 * Tests for atoms/amphi.ts — navigation persistence (activeNavAtom derives from
 * `settings.ui.lastNav`, while selectNavAtom persists through updateSettingsAtom)
 * and boundary fallbacks in `toNavKey`.
 *
 * amphi.ts now transitively depends on settings.ts, which reads
 * `window.__initialSettings__` at module scope. Static imports run before the stub, so
 * follow settings.test.ts: install the window stub first, then import dynamically.
 */
import { describe, it, expect, mock } from 'bun:test'
import { createStore } from 'jotai'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'

const g = globalThis as { window?: unknown }
g.window ??= {}
const w = g.window as { api?: Record<string, unknown>; addEventListener?: () => void }
const settingsApi = {
  set: mock(async (_next: GuiSettings) => {}),
  get: mock(async () => DEFAULT_SETTINGS),
}
w.api = { ...w.api, settings: settingsApi }
w.addEventListener ??= () => {}

const { activeNavAtom, selectNavAtom, showRightPanelAtom, toNavKey } = await import('../amphi')
const { settingsAtom } = await import('../settings')
const { materializeSessionAtom, newSessionAtom } = await import('../sessions')
const { NavKey } = await import('../../components/amphi/LeftSidebar')

describe('toNavKey', () => {
  it('accepts every known NavKey', () => {
    for (const key of Object.values(NavKey)) {
      expect(toNavKey(key)).toBe(key)
    }
  })

  it('falls back to Home on an unknown / stale stored value', () => {
    // Legacy keys or malformed edited configuration must not leave the center pane blank.
    expect(toNavKey('retired-nav')).toBe(NavKey.Home)
    expect(toNavKey('')).toBe(NavKey.Home)
  })
})

describe('activeNavAtom', () => {
  it('derives from settings.ui.lastNav', () => {
    const store = createStore()
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: NavKey.Schedules },
    })
    expect(store.get(activeNavAtom)).toBe(NavKey.Schedules)
  })

  it('defaults to Home', () => {
    const store = createStore()
    expect(store.get(activeNavAtom)).toBe(NavKey.Home)
  })
})

describe('selectNavAtom', () => {
  it('persists the pick so the next launch restores it', async () => {
    const store = createStore()
    settingsApi.set.mockImplementation(async () => {})
    await store.set(selectNavAtom, NavKey.Assets)
    expect(store.get(activeNavAtom)).toBe(NavKey.Assets)
    // Persistence, not merely updating the atom, guarantees the same tab after restart.
    const persisted = settingsApi.set.mock.calls.at(-1)?.[0]
    expect(persisted?.ui.lastNav).toBe(NavKey.Assets)
  })
})

describe('showRightPanelAtom', () => {
  it('hides a fresh draft and reveals the dock only after it becomes a conversation', () => {
    const store = createStore()
    const sessionId = store.set(newSessionAtom)

    expect(store.get(showRightPanelAtom)).toBe(false)

    store.set(materializeSessionAtom, sessionId)
    expect(store.get(showRightPanelAtom)).toBe(true)

    store.set(selectNavAtom, NavKey.Workflows)
    expect(store.get(showRightPanelAtom)).toBe(false)
  })
})
