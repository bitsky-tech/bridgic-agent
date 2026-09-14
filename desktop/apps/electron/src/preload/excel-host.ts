import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  ExcelHostConfig,
  ExcelHostPreloadAPI,
  ExcelWorkbookOpenTicket,
} from '../shared/types'

const workbookOpenListeners = new Set<(ticket: ExcelWorkbookOpenTicket) => void>()
const pendingWorkbookOpenTickets: ExcelWorkbookOpenTicket[] = []

ipcRenderer.on(
  IPC.events.excelWorkbookOpenRequested,
  (_event: Electron.IpcRendererEvent, ticket: ExcelWorkbookOpenTicket) => {
    if (workbookOpenListeners.size === 0) {
      pendingWorkbookOpenTickets.push(ticket)
      return
    }
    for (const listener of workbookOpenListeners) listener(ticket)
  },
)

const api: ExcelHostPreloadAPI = {
  open: () => ipcRenderer.invoke(IPC.excel.open),
  openRequestedWorkbook: (requestId) => (
    ipcRenderer.invoke(IPC.excel.openRequestedWorkbook, requestId)
  ),
  save: (request) => ipcRenderer.invoke(IPC.excel.save, request),
  saveAs: (request) => ipcRenderer.invoke(IPC.excel.saveAs, request),
  closeSession: () => ipcRenderer.invoke(IPC.excelHost.closeCurrentSession),
  setDirty: (dirty) => ipcRenderer.invoke(IPC.excelHost.setDirty, dirty),
  getRecoveryState: () => ipcRenderer.invoke(IPC.excelHost.getRecoveryState),
  setRecoveryState: (state) => ipcRenderer.invoke(IPC.excelHost.setRecoveryState, state),
  onConfigChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, config: ExcelHostConfig) => callback(config)
    ipcRenderer.on(IPC.events.excelHostConfigChanged, listener)
    return () => ipcRenderer.removeListener(IPC.events.excelHostConfigChanged, listener)
  },
  onWorkbookOpenRequested: (callback) => {
    workbookOpenListeners.add(callback)
    const queued = pendingWorkbookOpenTickets.splice(0)
    for (const ticket of queued) callback(ticket)
    return () => workbookOpenListeners.delete(callback)
  },
}

contextBridge.exposeInMainWorld('excelHostApi', api)
