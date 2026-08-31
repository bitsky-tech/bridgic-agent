import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { ExcelHostConfig, ExcelHostPreloadAPI } from '../shared/types'

const api: ExcelHostPreloadAPI = {
  open: () => ipcRenderer.invoke(IPC.excel.open),
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
}

contextBridge.exposeInMainWorld('excelHostApi', api)
