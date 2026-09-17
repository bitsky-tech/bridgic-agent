import { app, BrowserWindow, dialog } from 'electron'
import { basename, extname, join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { OfficeCloseDecision, OfficeFileKind, OfficeFileSaveRequest } from '../../shared/office-files'
import { createOfficeRecoveryStore, inspectOfficeFile, OFFICE_EXTENSIONS, saveOfficeFile } from '../office-files'
import { loggedHandle } from './logged-handle'
import { createOfficeWorkspaceFiles } from '../office-workspace-files'
import { officeWorkspaceRequest } from '../office-workspace-backend'
import { downloadOfficeImage } from '../../shared/office-images'

export function registerOfficeFileHandlers(owner: (kind: OfficeFileKind, contentsId: number) => string, request = officeWorkspaceRequest): void {
  const workspace = createOfficeWorkspaceFiles(request, (sessionId) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('office-files:changed', sessionId)
  })
  loggedHandle('office-files:prepare', (event, kind: OfficeFileKind, path: string) => workspace.prepare(owner(kind, event.sender.id), kind, path))
  loggedHandle('office-files:read-image', (event, kind: OfficeFileKind, url: string) => {
    owner(kind, event.sender.id)
    return downloadOfficeImage(url)
  })
  loggedHandle('office-files:read-base64', async (event, kind: OfficeFileKind, path: string) => {
    owner(kind, event.sender.id)
    const source = await inspectOfficeFile(kind, path)
    if ((await stat(source.path)).size > 150 * 1024 * 1024) throw new Error('Office file exceeds the size limit')
    return (await readFile(source.path)).toString('base64')
  })
  const recovery = createOfficeRecoveryStore(join(app.getPath('userData'), 'office-recovery'))
  loggedHandle('office-files:inspect', (event, kind: OfficeFileKind, path: string) => {
    owner(kind, event.sender.id)
    return inspectOfficeFile(kind, path)
  })
  loggedHandle('office-files:save', async (event, request: OfficeFileSaveRequest) => {
    const sessionId = owner(request.kind, event.sender.id)
    if (request.managed) return workspace.save(sessionId, request)
    let destination = request.destination ?? request.source?.path
    let approved = false
    if (!request.destination && (request.saveAs || !destination)) {
      const extension = OFFICE_EXTENSIONS[request.kind]
      const name = basename(request.suggestedName || `Untitled${extension}`)
      const options = { defaultPath: extname(name).toLowerCase() === extension ? name : `${name}${extension}`, filters: [{ name: extension.slice(1).toUpperCase(), extensions: [extension.slice(1)] }] }
      const window = BrowserWindow.getFocusedWindow()
      const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) return { ok: false, reason: 'canceled' }
      destination = extname(picked.filePath).toLowerCase() === extension ? picked.filePath : `${picked.filePath}${extension}`
      approved = true
    }
    if (!destination) throw new TypeError('An Office save destination is required')
    return saveOfficeFile(request, destination, approved)
  }, { transformLogArgs: ([request]) => ({ kind: (request as OfficeFileSaveRequest)?.kind, bytes: (request as OfficeFileSaveRequest)?.bytes?.byteLength }) })
  loggedHandle('office-files:confirm-close', async (_event, fileName: string, locale: string): Promise<OfficeCloseDecision> => {
    const zh = locale.startsWith('zh')
    const options = {
      type: 'question' as const,
      message: zh ? `要保存对“${fileName}”的修改吗？` : `Save changes to “${fileName}”?`,
      detail: zh ? '不保存将放弃此文档的未保存修改。' : 'Discarding will remove this document’s unsaved changes.',
      buttons: zh ? ['保存', '不保存', '取消'] : ['Save', 'Discard', 'Cancel'],
      defaultId: 0, cancelId: 2, noLink: true,
    }
    const window = BrowserWindow.getFocusedWindow()
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    return (['save', 'discard', 'cancel'] as const)[result.response] ?? 'cancel'
  })
  loggedHandle('office-files:get-recovery', (event, kind: OfficeFileKind, sessionId: string) => {
    if (owner(kind, event.sender.id) !== sessionId) throw new Error('Office recovery belongs to another Session')
    return recovery.read(kind, sessionId)
  })
  loggedHandle('office-files:set-recovery', (event, kind: OfficeFileKind, sessionId: string, value: string) => {
    if (owner(kind, event.sender.id) !== sessionId) throw new Error('Office recovery belongs to another Session')
    return recovery.write(kind, sessionId, value)
  }, { transformLogArgs: ([kind, sessionId, value]) => ({ kind, sessionId, bytes: typeof value === 'string' ? value.length : 0 }) })
}
