/**
 * Tests for atoms/settings.ts — read-modify-write inside the updateSettingsAtom setter
 * (preserving same-tick updates) and resynchronization to disk truth after IPC failure.
 */
import { describe, it, expect, mock } from 'bun:test'
import { createStore } from 'jotai'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'

// settings.ts reads window.__initialSettings__ at module scope. A static import runs before
// this file can install the window stub and causes ReferenceError, so import dynamically after
// stubbing. Merge instead of replacing the object to preserve window.api from other tests.
const g = globalThis as { window?: unknown }
g.window ??= {}
const w = g.window as { api?: Record<string, unknown>; addEventListener?: () => void }
const settingsApi = {
  set: mock(async (_next: GuiSettings) => {}),
  get: mock(async () => DEFAULT_SETTINGS),
}
w.api = { ...w.api, settings: settingsApi }
// electron-log/renderer registers a message listener when window exists at load time. Static
// imports in other tests run before window is defined and do not take this path.
w.addEventListener ??= () => {}
const { applyExternalSettingsAtom, settingsAtom, updateSettingsAtom } = await import('../settings')

function makeStore() {
  return createStore()
}

describe('updateSettingsAtom', () => {
  it('applies back-to-back same-tick updates without losing the first', async () => {
    const store = makeStore()
    settingsApi.set.mockImplementation(async () => {})
    // In the old hook closure, the second recipe used a stale render snapshot and silently
    // dropped the first zoomLevel update. This locks in the corrected behavior.
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
    // Replace the optimistic value with disk truth rather than retaining an unaccepted 1.5.
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
    // The user selects Sessions: navigation changes before the write reaches disk.
    const pending = store.set(updateSettingsAtom, (p) => ({
      ...p,
      ui: { ...p.ui, lastNav: 'home' },
    }))
    // The main process broadcasts a snapshot from before the navigation change, either as
    // this write's echo or a delayed earlier write. Replacing the whole object would roll
    // lastNav back to schedules and make the UI jump back.
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
    // If IPC fails completely, retain the optimistic value so the UI remains internally consistent.
    expect(store.get(settingsAtom).zoomLevel).toBe(1.5)
  })
})
