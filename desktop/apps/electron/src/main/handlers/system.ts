/**
 * OS-level signals not stored in settings.json.
 *
 * Currently exposes `system:osPrefersDark` for renderer atoms that
 * resolve `theme.mode === 'system'` to an actual `light`/`dark` value.
 *
 * Also relays `nativeTheme.updated` to renderers via the
 * `system-theme-changed` event so derived atoms recompute without their
 * own native-theme subscription.
 */
import { release } from 'node:os'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { SystemDiagnostics } from '../../shared/types'
import { mainLog } from '../logger'
import { loggedHandle } from './logged-handle'

export function registerSystemHandlers(): void {
  loggedHandle(IPC.system.osPrefersDark, async (): Promise<boolean> => {
    return nativeTheme.shouldUseDarkColors
  })

  loggedHandle(IPC.system.getDiagnostics, (): SystemDiagnostics => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
  }))

  nativeTheme.on('updated', () => {
    const dark = nativeTheme.shouldUseDarkColors
    mainLog.debug(`[system] OS theme updated → ${dark ? 'dark' : 'light'}`)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue
      win.webContents.send(IPC.events.systemThemeChanged, dark)
    }
  })
}
