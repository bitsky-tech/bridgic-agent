import { describe, expect, it, mock } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import type { EmbeddedPowerPointManager } from '../embedded-powerpoint-manager'
import { electronModuleMock, loggerModuleMock, testIpcHandlers } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { IPC } = await import('../../shared/ipc-channels')
const { registerPowerPointHandlers } = await import('../handlers/powerpoint')

describe('PowerPoint IPC boundary', () => {
  it('opens a picked PPTX only in the sending child renderer Session', async () => {
    const originalShowOpenDialog = electronModuleMock.dialog.showOpenDialog
    const opened: unknown[][] = []
    electronModuleMock.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/tmp/Agent Report.pptx'] })
    const powerpoint = {
      sessionForContents: (sender: number) => {
        expect(sender).toBe(17)
        return 'session-a'
      },
      openFile: async (...args: unknown[]) => { opened.push(args) },
    } as unknown as EmbeddedPowerPointManager
    testIpcHandlers.clear()
    registerPowerPointHandlers(powerpoint, () => undefined)
    try {
      await testIpcHandlers.get(IPC.powerpoint.openDocument)?.({ sender: { id: 17 } } as IpcMainInvokeEvent)
      expect(opened).toEqual([['session-a', '/tmp/Agent Report.pptx']])
    } finally {
      electronModuleMock.dialog.showOpenDialog = originalShowOpenDialog
    }
  })

  it('rejects a child renderer that names another Session while preserving trusted host routing', async () => {
    const opened: unknown[][] = []
    const powerpoint = {
      ownedSessionForContents: (sender: number) => sender === 17 ? 'session-a' : null,
      openFile: async (...args: unknown[]) => { opened.push(args) },
    } as unknown as EmbeddedPowerPointManager
    testIpcHandlers.clear()
    registerPowerPointHandlers(powerpoint, () => undefined)
    const openFile = testIpcHandlers.get(IPC.powerpoint.openFile)!
    await expect(openFile({ sender: { id: 17 } } as IpcMainInvokeEvent, 'session-b', '/tmp/report.pptx'))
      .rejects.toThrow('does not own')
    await openFile({ sender: { id: 17 } } as IpcMainInvokeEvent, 'session-a', '/tmp/report.pptx')
    await openFile({ sender: { id: 99 } } as IpcMainInvokeEvent, 'session-b', '/tmp/other.pptx')
    expect(opened).toEqual([
      ['session-a', '/tmp/report.pptx'],
      ['session-b', '/tmp/other.pptx'],
    ])
  })
})
