import type {
  App,
  LaunchItems,
  LoginItemSettings,
  LoginItemSettingsOptions,
  Settings,
} from 'electron'
import { GUI_BACKGROUND_ARG, WIN_GUI_AUTOSTART_NAME } from '../shared/app-meta'
import type { AutostartStatusJson } from './python-client/types'

type LoginItemApp = Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>

export interface GuiAutostartStatus {
  supported: boolean
  registered: boolean
  enabled: boolean
  requiresApproval: boolean
  detail: string | null
}

const unsupported = (detail: string): GuiAutostartStatus => ({
  supported: false,
  registered: false,
  enabled: false,
  requiresApproval: false,
  detail,
})

function windowsOptions(): LoginItemSettingsOptions {
  // Electron 39 concatenates `path + " " + args` before writing HKCU Run; it
  // does not quote the executable itself. Supplying the quotes here keeps an
  // install path such as `...\Bridgic Agent.exe` both launchable and parseable
  // during the subsequent launchItems readback.
  return { path: `"${process.execPath}"`, args: [GUI_BACKGROUND_ARG] }
}

function windowsLaunchItem(settings: LoginItemSettings): LaunchItems | undefined {
  const executable = process.execPath.toLocaleLowerCase('en-US')
  const entryName = WIN_GUI_AUTOSTART_NAME.toLocaleLowerCase('en-US')
  return settings.launchItems.find((candidate) => {
    // Registry value names and executable paths are case-insensitive on
    // Windows, even though Electron returns their original spelling.
    if (candidate.name.toLocaleLowerCase('en-US') !== entryName) return false
    if (candidate.scope !== 'user') return false
    if (candidate.path.toLocaleLowerCase('en-US') !== executable) return false
    // Electron builds this array with Chromium CommandLine::GetArgs(), which
    // excludes switches such as our `--background` marker. The Run value is
    // exclusively owned by the installer and setGuiAutostart, both of which
    // write that switch; all that remains observable here is whether an
    // unexpected positional argument was appended.
    return candidate.args.length === 0
  })
}

/** Read the OS login item owned by the Electron/tray process.
 *
 * The daemon has its own registration and remains independently useful for
 * unattended schedules. This second item exists solely because no Electron
 * process means no tray icon. Development builds deliberately do not touch a
 * real user's login configuration.
 */
export function readGuiAutostart(
  electronApp: LoginItemApp,
  platform: NodeJS.Platform = process.platform,
): GuiAutostartStatus {
  if (!electronApp.isPackaged) return unsupported('desktop login item is disabled in development')

  if (platform === 'win32') {
    const settings = electronApp.getLoginItemSettings(windowsOptions())
    // `openAtLogin` is Electron's legacy compatibility field. On Windows it
    // only reads the Run value named after the AppUserModelID; our deliberately
    // user-facing value name is `Bridgic Agent`, so that field remains false
    // even when the exact custom entry exists. launchItems is authoritative.
    const item = windowsLaunchItem(settings)
    const registered = item !== undefined
    return {
      supported: true,
      registered,
      enabled: item?.enabled ?? false,
      requiresApproval: false,
      detail: registered ? null : 'Electron tray login item is not registered',
    }
  }

  if (platform === 'darwin') {
    const settings = electronApp.getLoginItemSettings()
    const requiresApproval = settings.status === 'requires-approval'
    const registrationMissing =
      settings.status === 'not-registered' || settings.status === 'not-found'
    const registered = settings.openAtLogin && !registrationMissing
    let detail: string | null = null
    if (requiresApproval) {
      detail = 'Electron tray login item requires approval in System Settings'
    } else if (settings.status === 'not-found') {
      detail = 'Electron tray login item executable was not found'
    } else if (!registered) {
      detail = 'Electron tray login item is not registered'
    }
    return {
      supported: true,
      registered,
      enabled: registered && !requiresApproval,
      requiresApproval,
      detail,
    }
  }

  return unsupported(`desktop login item is unsupported on ${platform}`)
}

/** Register/remove the Electron tray login item, then read back the actual OS
 * state. Callers must use the readback rather than assuming the requested
 * value took effect (Windows StartupApproved and macOS approval can disagree).
 */
export function setGuiAutostart(
  electronApp: LoginItemApp,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
): GuiAutostartStatus {
  if (!electronApp.isPackaged || (platform !== 'win32' && platform !== 'darwin')) {
    return readGuiAutostart(electronApp, platform)
  }

  if (platform === 'win32') {
    const options = windowsOptions()
    const settings: Settings = {
      openAtLogin: enabled,
      enabled,
      name: WIN_GUI_AUTOSTART_NAME,
      path: options.path,
      args: options.args,
    }
    electronApp.setLoginItemSettings(settings)
  } else {
    // `openAsHidden` helps pre-macOS-13 systems. It is ignored on 13+, where
    // launch intent is detected through `wasOpenedAtLogin` and the main window
    // is kept hidden by our own startup coordinator.
    electronApp.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled })
  }

  return readGuiAutostart(electronApp, platform)
}

/** Project the daemon + tray registrations into the existing IPC status while
 * retaining component fields for diagnostics and repair UI. */
export function combineAutostartStatus(
  daemon: AutostartStatusJson,
  tray: GuiAutostartStatus,
): AutostartStatusJson {
  if (!tray.supported) {
    return { ...daemon, daemon_enabled: daemon.enabled }
  }
  return {
    ...daemon,
    daemon_enabled: daemon.enabled,
    tray_registered: tray.registered,
    tray_enabled: tray.enabled,
    tray_requires_approval: tray.requiresApproval,
    tray_detail: tray.detail,
    enabled: daemon.enabled && tray.enabled,
  }
}
