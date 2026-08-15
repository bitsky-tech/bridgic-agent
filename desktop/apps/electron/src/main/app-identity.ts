import type { App } from 'electron'
import { APP_BUNDLE_ID } from '../shared/app-meta'

type IdentityApp = Pick<App, 'isPackaged' | 'setAppUserModelId' | 'setName'>

/**
 * Configure display identity separately from the stable OS application ID.
 *
 * `displayName` is user-facing. `APP_BUNDLE_ID` is not: packaged Windows
 * builds use it as their AppUserModelID so the running process agrees with
 * electron-builder's `appId` (taskbar grouping, notifications and shortcuts).
 * Development keeps Electron's default ID so it cannot collide with an
 * installed production build running alongside it.
 */
export function applyApplicationIdentity(
  electronApp: IdentityApp,
  displayName: string,
  platform: NodeJS.Platform = process.platform,
): void {
  electronApp.setName(displayName)
  if (platform === 'win32' && electronApp.isPackaged) {
    electronApp.setAppUserModelId(APP_BUNDLE_ID)
  }
}
