/**
 * GuiSettings IPC handlers.
 *
 * The contract carries the **entire** GuiSettings blob; we never
 * write key-by-key. Atomic write + broadcast is centralised in
 * `main/gui-settings.ts` — this file is just the IPC adapter layer.
 */

import { dialog, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  DEFAULT_SETTINGS,
  type GuiSettings,
} from '@app/shared/types'
import { APP_PRODUCT_NAME, APP_SLUG } from '../../shared/app-meta'
import { IPC } from '../../shared/ipc-channels'
import {
  getGuiSettings,
  migrate,
  writeGuiSettings,
} from '../gui-settings'
import { mainLog } from '../logger'
import { amphiUserFile } from '../paths'
import { loggedHandle } from './logged-handle'

const SETTINGS_FILE_LABEL = 'gui-settings.json'

function settingsAbsolutePath(): string {
  return amphiUserFile(SETTINGS_FILE_LABEL)
}

export function registerSettingsHandlers(): void {
  loggedHandle(IPC.settings.get, async (): Promise<GuiSettings> => {
    return getGuiSettings()
  })

  loggedHandle(IPC.settings.set, async (event, next: GuiSettings): Promise<void> => {
    // Don't echo back to the originator: it already applied this value
    // optimistically, and a late echo would only roll back the changes it made
    // afterwards (see gui-settings.ts :: writeGuiSettings). reset / import are
    // still broadcast to every window — on those two paths the new value is
    // computed by the main process, so the originator needs to hear it too.
    writeGuiSettings(next, event.sender.id)
  })

  loggedHandle(IPC.settings.reset, async (): Promise<GuiSettings> => {
    const current = getGuiSettings()
    const next: GuiSettings = {
      ...DEFAULT_SETTINGS,
      ui: {
        ...DEFAULT_SETTINGS.ui,
        // Resetting unrelated preferences must not undo an explicit telemetry choice.
        telemetryOptIn: current.ui.telemetryOptIn,
      },
    }
    writeGuiSettings(next)
    return next
  })

  loggedHandle(IPC.settings.export, async () => {
    const current = getGuiSettings()
    const result = await dialog.showSaveDialog({
      title: `Export ${APP_PRODUCT_NAME} settings`,
      defaultPath: `${APP_SLUG}-settings.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) {
      return { ok: false as const, reason: 'cancelled' }
    }
    writeFileSync(result.filePath, JSON.stringify(current, null, 2), 'utf-8')
    return { ok: true as const, path: result.filePath }
  })

  loggedHandle(IPC.settings.import, async () => {
    const result = await dialog.showOpenDialog({
      title: `Import ${APP_PRODUCT_NAME} settings`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false as const, reason: 'cancelled' }
    }
    const target = result.filePaths[0]
    if (!target) return { ok: false as const, reason: 'no file selected' }
    try {
      const raw = readFileSync(target, 'utf-8')
      // Normalize through the SAME migrate + deep-merge used on disk read: an
      // older / partially-shaped imported blob must not drop nested default
      // keys. A shallow `{ ...DEFAULT_SETTINGS, ...parsed }` would replace whole
      // sub-objects (e.g. import `{theme:{mode:'dark'}}` → theme loses `accent`),
      // and writeGuiSettings broadcasts that to the renderer before any re-read.
      const imported = migrate(JSON.parse(raw))
      // Consent must be changed by the person using this installation, not by
      // a portable settings file. Preserve the current choice in both
      // directions: importing cannot silently enable or revoke telemetry.
      const next: GuiSettings = {
        ...imported,
        ui: {
          ...imported.ui,
          telemetryOptIn: getGuiSettings().ui.telemetryOptIn,
        },
      }
      writeGuiSettings(next)
      return { ok: true as const, path: target }
    } catch (err) {
      mainLog.error('[settings] import failed', err)
      return {
        ok: false as const,
        reason: err instanceof Error ? err.message : 'parse failed',
      }
    }
  })

  loggedHandle(IPC.settings.openFile, async () => {
    const p = settingsAbsolutePath()
    if (!existsSync(p)) {
      return { ok: false as const, reason: `${SETTINGS_FILE_LABEL} does not exist yet: ${p}` }
    }
    await shell.showItemInFolder(p)
    return { ok: true as const, path: p }
  })
}
