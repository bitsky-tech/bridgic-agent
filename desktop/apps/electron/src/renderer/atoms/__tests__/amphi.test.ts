/**
 * Tests for atoms/amphi.ts — nav 持久化(activeNavAtom 派生自
 * `settings.ui.lastNav`,selectNavAtom 经 updateSettingsAtom 落盘)与
 * `toNavKey` 的边界回退。
 *
 * amphi.ts 现在传递依赖 settings.ts,后者在【模块顶层】读
 * `window.__initialSettings__` —— 静态 import 会被提升到 stub 之前执行,
 * 所以照 settings.test.ts 的做法:先装 window stub,再动态 import。
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
    // 磁盘上的旧值(改名前的 key)或手改坏的配置不能让中央区渲染空白。
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
    // 落盘才是"下次打开还在这一栏"的实际保障 —— 只改 atom 不算。
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
