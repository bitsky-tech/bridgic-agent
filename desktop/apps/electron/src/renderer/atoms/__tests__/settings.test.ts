/**
 * Tests for atoms/settings.ts — updateSettingsAtom 的 setter 内读改写
 * (同 tick 连续更新不丢)与 IPC 失败后的磁盘真值 resync。
 */
import { describe, it, expect, mock } from 'bun:test'
import { createStore } from 'jotai'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'

// settings.ts 在【模块顶层】读 window.__initialSettings__——静态 import 会被
// 提升到本文件语句之前执行,window stub 来不及就位(ReferenceError)。所以
// 必须 stub 后再动态 import。merge 而非整体替换,避免覆盖其他测试文件装的
// window.api 命名空间。
const g = globalThis as { window?: unknown }
g.window ??= {}
const w = g.window as { api?: Record<string, unknown>; addEventListener?: () => void }
const settingsApi = {
  set: mock(async (_next: GuiSettings) => {}),
  get: mock(async () => DEFAULT_SETTINGS),
}
w.api = { ...w.api, settings: settingsApi }
// electron-log/renderer 模块加载时若发现 window 存在会注册 message 监听
// (静态 import 提升的测试文件加载它时 window 尚未定义,不会走到这里)。
w.addEventListener ??= () => {}
const { applyExternalSettingsAtom, settingsAtom, updateSettingsAtom } = await import('../settings')

function makeStore() {
  return createStore()
}

describe('updateSettingsAtom', () => {
  it('applies back-to-back same-tick updates without losing the first', async () => {
    const store = makeStore()
    settingsApi.set.mockImplementation(async () => {})
    // 旧实现(hook 闭包读渲染期快照)下第二个 recipe 基于陈旧 prev,
    // 会把第一次的 zoomLevel 改动静默丢掉——这里固化新行为。
    await Promise.all([
      store.set(updateSettingsAtom, (p) => ({ ...p, zoomLevel: 2 })),
      store.set(updateSettingsAtom, (p) => ({
        ...p,
        theme: { ...p.theme, accent: '#123456' },
      })),
    ])
    const after = store.get(settingsAtom)
    expect(after.zoomLevel).toBe(2)
    expect(after.theme.accent).toBe('#123456')
  })

  it('resyncs from disk truth when persist fails', async () => {
    const store = makeStore()
    settingsApi.set.mockImplementation(async () => {
      throw new Error('IPC down')
    })
    settingsApi.get.mockImplementation(async () => DEFAULT_SETTINGS)
    await store.set(updateSettingsAtom, (p) => ({ ...p, zoomLevel: 1.5 }))
    // 乐观值被磁盘真值替换,而不是停留在磁盘从未接受过的 1.5
    expect(store.get(settingsAtom).zoomLevel).toBe(DEFAULT_SETTINGS.zoomLevel)
    expect(settingsApi.get).toHaveBeenCalled()
  })

  it('ignores an external snapshot while a write is still in flight', async () => {
    const store = makeStore()
    let releasePersist = () => {}
    settingsApi.set.mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          releasePersist = resolve
        }),
    )
    // 用户点会话:先切 nav,写入尚未落盘。
    const pending = store.set(updateSettingsAtom, (p) => ({
      ...p,
      ui: { ...p.ui, lastNav: 'home' },
    }))
    // 主进程把「切 nav 之前」的旧快照广播回来(自己那次写的回声,或另一次写
    // 的回声晚到)。整块覆盖会把 lastNav 回滚成 schedules —— 界面就跳回调度。
    store.set(applyExternalSettingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: 'schedules' },
    })
    expect(store.get(settingsAtom).ui.lastNav).toBe('home')
    releasePersist()
    await pending
  })

  it('applies an external snapshot once no write is in flight', async () => {
    const store = makeStore()
    settingsApi.set.mockImplementation(async () => {})
    await store.set(updateSettingsAtom, (p) => ({ ...p, zoomLevel: 1 }))
    store.set(applyExternalSettingsAtom, { ...DEFAULT_SETTINGS, zoomLevel: 3 })
    expect(store.get(settingsAtom).zoomLevel).toBe(3)
  })

  it('keeps the optimistic value when even the resync read fails', async () => {
    const store = makeStore()
    settingsApi.set.mockImplementation(async () => {
      throw new Error('IPC down')
    })
    settingsApi.get.mockImplementation(async () => {
      throw new Error('IPC down')
    })
    await store.set(updateSettingsAtom, (p) => ({ ...p, zoomLevel: 1.5 }))
    // IPC 整体故障:保留乐观值,UI 至少自洽
    expect(store.get(settingsAtom).zoomLevel).toBe(1.5)
  })
})
