import { describe, expect, it, mock } from 'bun:test'
import type { App } from 'electron'
import {
  APP_BUNDLE_ID,
  APP_PRODUCT_NAME,
  WIN_GUI_AUTOSTART_NAME,
} from '../../shared/app-meta'
import { applyApplicationIdentity } from '../app-identity'

function fakeApp(packaged = true): Pick<App, 'isPackaged' | 'setAppUserModelId' | 'setName'> {
  return {
    isPackaged: packaged,
    setAppUserModelId: mock(() => {}),
    setName: mock(() => {}),
  }
}

describe('application identity', () => {
  it('keeps the internal OS identity out of the user-facing Startup Apps label', () => {
    expect(WIN_GUI_AUTOSTART_NAME).toBe(APP_PRODUCT_NAME)
    expect(WIN_GUI_AUTOSTART_NAME).not.toBe(APP_BUNDLE_ID)
  })

  it('uses the stable internal appId for a packaged Windows build', () => {
    const app = fakeApp()

    applyApplicationIdentity(app, APP_PRODUCT_NAME, 'win32')

    expect(app.setName).toHaveBeenCalledWith(APP_PRODUCT_NAME)
    expect(app.setAppUserModelId).toHaveBeenCalledWith(APP_BUNDLE_ID)
  })

  it('does not expose a display-name override as the Windows AppUserModelID', () => {
    const app = fakeApp()

    applyApplicationIdentity(app, 'Friendly Test Name', 'win32')

    expect(app.setName).toHaveBeenCalledWith('Friendly Test Name')
    expect(app.setAppUserModelId).toHaveBeenCalledWith(APP_BUNDLE_ID)
  })

  it('keeps development isolated from the installed Windows identity', () => {
    const app = fakeApp(false)

    applyApplicationIdentity(app, APP_PRODUCT_NAME, 'win32')

    expect(app.setName).toHaveBeenCalledWith(APP_PRODUCT_NAME)
    expect(app.setAppUserModelId).not.toHaveBeenCalled()
  })

  it('does not apply a Windows-only identity on macOS', () => {
    const app = fakeApp()

    applyApplicationIdentity(app, APP_PRODUCT_NAME, 'darwin')

    expect(app.setName).toHaveBeenCalledWith(APP_PRODUCT_NAME)
    expect(app.setAppUserModelId).not.toHaveBeenCalled()
  })
})
