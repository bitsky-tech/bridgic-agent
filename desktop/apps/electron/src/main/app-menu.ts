/**
 * The application menu bar.
 *
 * Deliberately MINIMAL: the tray menu plus per-window UI cover navigation, so the only
 * roles here are the ones the OS needs us to declare. `editMenu` is what binds the
 * clipboard accelerators (Cmd/Ctrl+C / V / X / A + undo/redo) — `setApplicationMenu(null)`
 * drops them and copy/paste silently stops working in every input. macOS additionally needs
 * `appMenu` for the app-name + Quit items. `autoHideMenuBar` (window-manager) keeps the bar
 * itself hidden on Windows/Linux while leaving the accelerators live.
 *
 * A function rather than a module-level constant because the labels are translated: the
 * menu has to be rebuilt when the user switches language, which `gui-settings.applyLocale`
 * does. Extracted out of `index.ts` for the same reason — `applyLocale` needs to call it,
 * and importing the process entry point would be a cycle.
 */
import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { ZOOM_LEVEL_STEP } from '@app/shared/types'
import { stepZoomLevel } from './gui-settings'
import { mt } from './i18n'

/**
 * Zoom accelerators. Only the canonical combo per action lives here — the un-shifted
 * `CmdOrCtrl+=` and the numpad keys are caught by raw key handling in `window-manager`
 * instead. Hidden duplicate menu items would have been simpler, but
 * `acceleratorWorksWhenHidden` is macOS-only: on Windows/Linux a hidden item's accelerator
 * is not guaranteed to fire, so those users would silently get zoom on `Ctrl+Shift+=` only.
 * The two sets are disjoint key combos, so nothing double-fires.
 */
function zoomItems(): MenuItemConstructorOptions[] {
  return [
    { label: mt('main.menu.zoomIn'), accelerator: 'CmdOrCtrl+Plus', click: () => stepZoomLevel(ZOOM_LEVEL_STEP) },
    { label: mt('main.menu.zoomOut'), accelerator: 'CmdOrCtrl+-', click: () => stepZoomLevel(-ZOOM_LEVEL_STEP) },
    { type: 'separator' },
    { label: mt('main.menu.actualSize'), accelerator: 'CmdOrCtrl+0', click: () => stepZoomLevel(0) },
  ]
}

/** Build and install the menu in the language `mt` currently resolves to. */
export function buildApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    // A real (visible) View menu, unlike the rest of this minimal bar: the
    // shortcuts are only discoverable if they're listed somewhere.
    { label: mt('main.menu.view'), submenu: zoomItems() },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
