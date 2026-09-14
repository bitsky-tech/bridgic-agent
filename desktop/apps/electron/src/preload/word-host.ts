import { contextBridge, ipcRenderer } from 'electron'
import type { GuiSettings } from '@app/shared/types'
import { IPC } from '../shared/ipc-channels'
import type { WordHostOpenRequest, WordHostPreloadAPI } from '../shared/types'

/** Install listeners before the runtime loads so startup events cannot be lost. */
function queuedEvents<T>(channel: string) {
  const listeners = new Set<(value: T) => void>()
  const pending: T[] = []
  ipcRenderer.on(channel, (_event: Electron.IpcRendererEvent, value: T) => {
    if (listeners.size === 0) pending.push(value)
    else for (const listener of listeners) listener(value)
  })
  return (listener: (value: T) => void) => {
    listeners.add(listener)
    for (const value of pending.splice(0)) listener(value)
    return () => { listeners.delete(listener) }
  }
}

/** Configuration is state, so only its newest value needs replaying. */
function latestEvent<T>(channel: string) {
  const listeners = new Set<(value: T) => void>()
  let latest: { value: T } | null = null
  ipcRenderer.on(channel, (_event: Electron.IpcRendererEvent, value: T) => {
    latest = { value }
    for (const listener of listeners) listener(value)
  })
  return (listener: (value: T) => void) => {
    listeners.add(listener)
    if (latest) listener(latest.value)
    return () => { listeners.delete(listener) }
  }
}

const api: WordHostPreloadAPI = {
  getConfig: () => ipcRenderer.invoke(IPC.wordHost.getConfig),
  readDocument: (path) => ipcRenderer.invoke(IPC.word.readDocument, path),
  reportState: (state) => ipcRenderer.invoke(IPC.wordHost.reportState, state),
  requestHide: () => ipcRenderer.invoke(IPC.wordHost.requestHide),
  setExpanded: (expanded) => ipcRenderer.invoke(IPC.wordHost.setExpanded, expanded),
  onExpandedChanged: latestEvent<{ sessionId: string; expanded: boolean }>(IPC.events.wordHostExpandedChanged),
  onConfigChanged: latestEvent<GuiSettings>(IPC.events.wordHostConfigChanged),
  onOpenFileRequested: queuedEvents<WordHostOpenRequest>(IPC.events.wordHostOpenFileRequested),
  completeOpenFile: (requestId, error) => ipcRenderer.invoke(IPC.wordHost.completeOpenFile, requestId, error),
  onFlushRequested: queuedEvents<string>(IPC.events.wordHostFlushRequested),
  completeFlush: (requestId, success) => ipcRenderer.invoke(IPC.wordHost.completeFlush, requestId, success),
}

contextBridge.exposeInMainWorld('wordHostApi', api)
