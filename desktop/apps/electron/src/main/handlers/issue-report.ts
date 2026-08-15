import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { IssueReportExportRequest } from '../../shared/types'
import { mt } from '../i18n'
import { IssueReportExporter, redactIssueReportExportLogArgs } from './issue-report-export'
import { loggedHandle } from './logged-handle'

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function registerIssueReportHandlers(): void {
  const exporter = new IssueReportExporter({
    selectDestination: async (suggestedName) => {
      const options = {
        title: mt('issueReport.fileMode.saveDialogTitle'),
        defaultPath: suggestedName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }
      const window = focusedWindow()
      return window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
    },
    writeUtf8: async (filePath, content) => writeFile(filePath, content, 'utf-8'),
  })

  loggedHandle(
    IPC.issueReport.exportFile,
    async (_event, request: IssueReportExportRequest) => exporter.exportFile(request),
    { transformLogArgs: redactIssueReportExportLogArgs },
  )
}
