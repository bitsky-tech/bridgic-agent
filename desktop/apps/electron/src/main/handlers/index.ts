import type { WindowManager } from '../window-manager'
import { registerAppHandlers } from './app'
import { registerBackendHandlers } from './backend'
import { registerBrowserHandlers } from './browser'
import { registerDialogHandlers } from './dialog'
import { registerDraftsHandlers } from './drafts'
import { registerFsHandlers } from './fs'
import { registerFsWatchHandlers } from './fs-watch'
import { registerIssueReportHandlers } from './issue-report'
import { registerMarketHandlers } from './market'
import { registerNotifyHandlers } from './notify'
import { registerSettingsHandlers } from './settings'
import { registerSpecCommentsHandlers } from './spec-comments'
import { registerShellHandlers } from './shell'
import { registerSystemHandlers } from './system'
import { registerUpdateHandlers } from './update'
import { registerWindowHandlers } from './window'
import { registerWordHandlers } from './word'

export function registerAllHandlers(windowManager: WindowManager): void {
  registerAppHandlers()
  registerShellHandlers()
  registerDialogHandlers()
  // Local-fs reads for the session-file tree / @ popover (display only).
  registerFsHandlers()
  // Live watchers that keep the expanded session-file tree in sync with disk.
  registerFsWatchHandlers()
  registerSettingsHandlers()
  // Per-session composer drafts (unsent input w/ @ chips) — own JSON blob.
  registerDraftsHandlers()
  // Per-session staged spec comments (unsent selection comments) — own JSON blob.
  registerSpecCommentsHandlers()
  // Workflow-market payload cached from showcase.bridgic.ai — own JSON blob.
  registerMarketHandlers()
  // Theme is part of GuiSettings (settings.theme) — no separate IPC namespace.
  // OS-level dark-mode probing remains under `registerSystemHandlers`.
  registerWindowHandlers(windowManager)
  registerBrowserHandlers(windowManager.getEmbeddedBrowser())
  registerWordHandlers()
  // Bridgic Agent Python daemon control plane (discover / spawn / stop / clients).
  registerBackendHandlers()
  // Desktop auto-update: the user-confirmed "install now" path. Registered after
  // the backend handlers because it drives pythonClient during the handover.
  registerUpdateHandlers()
  registerSystemHandlers()
  registerIssueReportHandlers()
  // Native toasts for daemon `schedule.notify` frames (relayed by the renderer).
  registerNotifyHandlers()
}
