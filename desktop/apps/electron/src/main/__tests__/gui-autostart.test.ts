import { describe, expect, it, mock } from 'bun:test'
import type { App, LoginItemSettings, Settings } from 'electron'
import { GUI_BACKGROUND_ARG, WIN_GUI_AUTOSTART_NAME } from '../../shared/app-meta'
import {
  combineAutostartStatus,
  readGuiAutostart,
  setGuiAutostart,
} from '../gui-autostart'
import type { AutostartStatusJson } from '../python-client/types'

function loginSettings(overrides: Partial<LoginItemSettings> = {}): LoginItemSettings {
  return {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    status: 'not-registered',
    executableWillLaunchAtLogin: false,
    launchItems: [],
    ...overrides,
  }
}

function fakeApp(options: {
  packaged?: boolean
  settings?: LoginItemSettings
  onSet?: (value: Settings) => void
} = {}): Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'> {
  let current = options.settings ?? loginSettings()
  return {
    isPackaged: options.packaged ?? true,
    getLoginItemSettings: mock(() => current),
    setLoginItemSettings: mock((value: Settings) => {
      options.onSet?.(value)
      const registered = value.openAtLogin === true
      const writtenPath = value.path ?? process.execPath
      const parsedPath = writtenPath.startsWith('"') && writtenPath.endsWith('"')
        ? writtenPath.slice(1, -1)
        : writtenPath
      current = loginSettings({
        // Electron's legacy openAtLogin readback checks the AppUserModelID
        // value name, not the custom name supplied above.
        openAtLogin: false,
        status: registered ? 'enabled' : 'not-registered',
        executableWillLaunchAtLogin: registered,
        launchItems: registered
          ? [{
              name: value.name ?? WIN_GUI_AUTOSTART_NAME,
              path: parsedPath,
              // Chromium CommandLine::GetArgs() excludes switches, so the
              // real Electron 39 readback omits `--background` here.
              args: (value.args ?? []).filter((arg) => !arg.startsWith('-')),
              scope: 'user',
              enabled: value.enabled ?? true,
            }]
          : [],
      })
    }),
  }
}

describe('GUI login autostart', () => {
  it('never writes a real login item from a development build', () => {
    const app = fakeApp({ packaged: false })

    const state = setGuiAutostart(app, true, 'win32')

    expect(state.supported).toBe(false)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('writes and verifies the stable Windows name/path/background argv contract', () => {
    const written: Settings[] = []
    const app = fakeApp({ onSet: (value) => { written.push(value) } })

    const state = setGuiAutostart(app, true, 'win32')

    expect(written[0]).toEqual({
      openAtLogin: true,
      enabled: true,
      name: WIN_GUI_AUTOSTART_NAME,
      path: `"${process.execPath}"`,
      args: [GUI_BACKGROUND_ARG],
    })
    expect(state).toMatchObject({ supported: true, registered: true, enabled: true })
  })

  it('finds the custom Run value when Electron omits the background switch from args', () => {
    const app = fakeApp({
      settings: loginSettings({
        openAtLogin: false,
        executableWillLaunchAtLogin: true,
        launchItems: [{
          name: WIN_GUI_AUTOSTART_NAME,
          path: process.execPath,
          args: [],
          scope: 'user',
          enabled: true,
        }],
      }),
    })

    expect(readGuiAutostart(app, 'win32')).toMatchObject({
      registered: true,
      enabled: true,
      detail: null,
    })
  })

  it('matches Windows registry names and paths case-insensitively', () => {
    const app = fakeApp({
      settings: loginSettings({
        launchItems: [{
          name: WIN_GUI_AUTOSTART_NAME.toUpperCase(),
          path: process.execPath.toUpperCase(),
          args: [],
          scope: 'user',
          enabled: true,
        }],
      }),
    })

    expect(readGuiAutostart(app, 'win32')).toMatchObject({ registered: true, enabled: true })
  })

  it('distinguishes a registered Windows item disabled through Startup Apps', () => {
    const app = fakeApp({
      settings: loginSettings({
        openAtLogin: false,
        executableWillLaunchAtLogin: false,
        launchItems: [{
          name: WIN_GUI_AUTOSTART_NAME,
          path: process.execPath,
          args: [],
          scope: 'user',
          enabled: false,
        }],
      }),
    })

    expect(readGuiAutostart(app, 'win32')).toMatchObject({
      registered: true,
      enabled: false,
    })
  })

  it('requires the expected user-level name, path, scope, and no positional args', () => {
    const app = fakeApp({
      settings: loginSettings({
        openAtLogin: true,
        executableWillLaunchAtLogin: true,
        launchItems: [
          {
            name: `${WIN_GUI_AUTOSTART_NAME} Helper`,
            path: process.execPath,
            args: [],
            scope: 'user',
            enabled: true,
          },
          {
            name: WIN_GUI_AUTOSTART_NAME,
            path: `${process.execPath}.old`,
            args: [],
            scope: 'user',
            enabled: true,
          },
          {
            name: WIN_GUI_AUTOSTART_NAME,
            path: process.execPath,
            args: ['unexpected-document.txt'],
            scope: 'user',
            enabled: true,
          },
          {
            name: WIN_GUI_AUTOSTART_NAME,
            path: process.execPath,
            args: [],
            scope: 'machine',
            enabled: true,
          },
        ],
      }),
    })

    expect(readGuiAutostart(app, 'win32')).toMatchObject({
      registered: false,
      enabled: false,
      detail: 'Electron tray login item is not registered',
    })
  })

  it('reports macOS approval as a distinct non-effective state', () => {
    const app = fakeApp({
      settings: loginSettings({ openAtLogin: true, status: 'requires-approval' }),
    })

    expect(readGuiAutostart(app, 'darwin')).toMatchObject({
      registered: true,
      enabled: false,
      requiresApproval: true,
    })
  })

  it('does not call a stale macOS login item effective when its executable is missing', () => {
    const app = fakeApp({
      settings: loginSettings({ openAtLogin: true, status: 'not-found' }),
    })

    expect(readGuiAutostart(app, 'darwin')).toMatchObject({
      registered: false,
      enabled: false,
      requiresApproval: false,
      detail: 'Electron tray login item executable was not found',
    })
  })

  it('uses the legacy hidden hint on macOS while leaving actual hiding to launch intent', () => {
    const written: Settings[] = []
    const app = fakeApp({ onSet: (value) => { written.push(value) } })

    setGuiAutostart(app, true, 'darwin')

    expect(written[0]).toEqual({ openAtLogin: true, openAsHidden: true })
  })

  it('reports enabled only when both daemon and tray login items are effective', () => {
    const daemon: AutostartStatusJson = {
      manager: 'run-key',
      supported: true,
      enabled: true,
      active: null,
      definition: 'HKCU Run',
      detail: null,
    }

    const combined = combineAutostartStatus(daemon, {
      supported: true,
      registered: true,
      enabled: false,
      requiresApproval: false,
      detail: 'disabled in Startup Apps',
    })

    expect(combined).toMatchObject({
      enabled: false,
      daemon_enabled: true,
      tray_registered: true,
      tray_enabled: false,
    })
  })
})
