import { app, shell } from 'electron'
import { quitWithDaemon } from '../quit-with-daemon'
import { IPC, type AppPathName } from '../../shared/ipc-channels'
import { getLogFilePath } from '../logger'
import { loggedHandle } from './logged-handle'

export function registerAppHandlers(): void {
  loggedHandle(IPC.app.getVersion, () => app.getVersion())

  loggedHandle(IPC.app.getPath, (_event, name: AppPathName) => {
    return app.getPath(name)
  })

  // Renderer-initiated full quit. `window.close()` would only hide to tray
  // (see index.ts `window-all-closed`), which is the wrong answer when the user
  // has been told the app cannot continue and picked "quit".
  //
  // Routed through quitWithDaemon rather than app.quit(): that is the single
  // entry point every other quit gesture uses (tray, ⌘Q, Dock), so the renderer
  // gets the same "other clients are connected" confirmation instead of
  // tripping the before-quit intercept into an unexpected second dialog.
  loggedHandle(IPC.app.quit, async () => {
    await quitWithDaemon()
  })

  loggedHandle(IPC.app.openLogFile, async () => {
    const p = getLogFilePath()
    if (!p) return { ok: false, reason: 'log file path unavailable' as const }
    // Reveal in Finder/Explorer rather than open in a text editor — log files
    // can grow large and the user usually wants to attach them, not read them.
    shell.showItemInFolder(p)
    return { ok: true, path: p }
  })
}
