import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ElectronAPI } from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const persistedSettings: Parameters<ElectronAPI['settings']['set']>[0][] = []
const openedUrls: string[] = []
const apiWindow = window as unknown as { api?: ElectronAPI }
const originalApi = apiWindow.api
apiWindow.api = {
  settings: {
    set: async (settings) => { persistedSettings.push(settings) },
  },
  shell: {
    openExternal: async (url) => { openedUrls.push(url) },
  },
} as ElectronAPI

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { DEFAULT_SETTINGS } = await import('@app/shared/types')
const { APP_PRIVACY_NOTICE_URL } = await import('@shared/app-meta')
const { settingsAtom } = await import('@/atoms/settings')
const { SettingsPrivacyTab } = await import('../SettingsPrivacyTab')

describe('SettingsPrivacyTab', () => {
  it('starts enabled and persists an explicit opt-out through the settings writer', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(settingsAtom, DEFAULT_SETTINGS)
    persistedSettings.length = 0
    openedUrls.length = 0

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SettingsPrivacyTab />
        </Provider>,
      )
    })

    const telemetrySwitch = host.querySelector<HTMLButtonElement>('[data-testid="telemetry-opt-in"]')
    if (!telemetrySwitch) throw new Error('telemetry switch not rendered')
    expect(host.textContent).toContain('帮助我们改进 Bridgic Agent')
    expect(host.textContent).toContain('你的工作内容永远留在本地')
    expect(host.textContent).toContain('匿名使用数据的范围')
    expect(host.textContent).not.toContain('随机安装 ID')
    expect(host.textContent).toContain('匿名使用数据的包含范围见下方详情')
    expect(telemetrySwitch.getAttribute('role')).toBe('switch')
    expect(telemetrySwitch.getAttribute('aria-checked')).toBe('true')

    await act(async () => { telemetrySwitch.click() })

    expect(telemetrySwitch.getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain('当前未收集匿名使用数据，所有核心功能均可正常使用')
    expect(store.get(settingsAtom).ui.telemetryOptIn).toBe(false)
    expect(persistedSettings.at(-1)?.ui.telemetryOptIn).toBe(false)

    const privacyNoticeLink = host.querySelector<HTMLButtonElement>('[data-testid="privacy-notice-link"]')
    if (!privacyNoticeLink) throw new Error('privacy notice link not rendered')
    await act(async () => { privacyNoticeLink.click() })
    expect(openedUrls).toEqual([APP_PRIVACY_NOTICE_URL])

    await act(async () => { root.unmount() })
    host.remove()
  })
})

afterAll(() => {
  if (originalApi) apiWindow.api = originalApi
  else delete apiWindow.api
})
