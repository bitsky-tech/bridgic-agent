import { ipcRenderer } from 'electron'
import type { OfficeFilesAPI } from '../shared/office-files'

export const officeFiles: OfficeFilesAPI = {
  prepare: (kind, path) => ipcRenderer.invoke('office-files:prepare', kind, path),
  readBase64: (kind, path) => ipcRenderer.invoke('office-files:read-base64', kind, path),
  readImage: (kind, url) => ipcRenderer.invoke('office-files:read-image', kind, url),
  onChanged: (callback) => {
    const listener = (_event: unknown, id: string) => callback(id)
    ipcRenderer.on('office-files:changed', listener)
    return () => ipcRenderer.removeListener('office-files:changed', listener)
  },
  inspect: (kind, path) => ipcRenderer.invoke('office-files:inspect', kind, path),
  save: (request) => ipcRenderer.invoke('office-files:save', request),
  confirmClose: (name, locale) => ipcRenderer.invoke('office-files:confirm-close', name, locale),
  getRecovery: (kind, sessionId) => ipcRenderer.invoke('office-files:get-recovery', kind, sessionId),
  setRecovery: (kind, sessionId, value) => ipcRenderer.invoke('office-files:set-recovery', kind, sessionId, value),
}
