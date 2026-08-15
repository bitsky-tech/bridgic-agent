import { shell } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { parseExternalUrl, redactExternalUrlLogArgs } from './external-url'
import { loggedHandle } from './logged-handle'
import { redactLocalPathLogArgs } from './path-log'

export function registerShellHandlers(): void {
  loggedHandle(IPC.shell.openExternal, async (_event, url: string) => {
    const parsed = parseExternalUrl(url)
    try {
      await shell.openExternal(parsed.toString())
    } catch {
      throw new Error('Failed to open external URL')
    }
  }, { transformLogArgs: redactExternalUrlLogArgs })

  loggedHandle(
    IPC.shell.showItemInFolder,
    (_event, fullPath: string) => {
      try {
        shell.showItemInFolder(fullPath)
      } catch {
        throw new Error('Failed to show local path')
      }
    },
    { transformLogArgs: redactLocalPathLogArgs },
  )

  // Open a file/folder with the OS default handler (Launch Services /
  // ShellExecute / xdg-open). No scheme allow-list like openExternal: the path
  // comes from a user-mounted directory and double-click mirrors Finder/Explorer
  // (the user already chose to mount + open it). openPath resolves to an error
  // string (it never throws); convert that to a path-free IPC rejection.
  loggedHandle(
    IPC.shell.openPath,
    async (_event, fullPath: string) => {
      try {
        const err = await shell.openPath(fullPath)
        // OS errors can repeat the absolute path; keep it out of handler logs.
        if (err) throw new Error('Failed to open local path')
      } catch {
        throw new Error('Failed to open local path')
      }
    },
    { transformLogArgs: redactLocalPathLogArgs },
  )
}
