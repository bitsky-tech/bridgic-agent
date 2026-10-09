import { describe, expect, it, mock } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import type { ExcelHost } from '../excel-host'
import type { EmbeddedBrowserManager } from '../embedded-browser-manager'
import { electronModuleMock, loggerModuleMock, testIpcHandlers } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { IPC } = await import('../../shared/ipc-channels')
const { registerExcelHostHandlers } = await import('../handlers/excel-host')

describe('Excel host close requests', () => {
  it('binds renderer state reports to the sending Excel target', async () => {
    const calls: unknown[][] = []
    const excel = {
      reportState: (sender: number, state: unknown) => { calls.push([sender, state]) },
    } as unknown as ExcelHost
    testIpcHandlers.clear()
    registerExcelHostHandlers(excel, {} as EmbeddedBrowserManager, () => undefined)

    await testIpcHandlers.get(IPC.excelHost.reportState)?.(
      { sender: { id: 17 } } as IpcMainInvokeEvent,
      { documentCount: 0, dirty: false },
    )

    expect(calls).toEqual([[17, { documentCount: 0, dirty: false }]])
  })

  it('resolves the owning Session from the sender and retracts its panel before deferred destruction', async () => {
    const events: unknown[][] = []
    const closed: number[] = []
    const excel = {
      sessionForContents: (sender: number) => {
        if (sender !== 17) throw new Error('Excel Session does not own this renderer')
        return 'session-a'
      },
      closeCurrentSession: (sender: number) => { closed.push(sender) },
    } as unknown as ExcelHost
    testIpcHandlers.clear()
    registerExcelHostHandlers(excel, {} as EmbeddedBrowserManager, (...args) => { events.push(args) })
    await testIpcHandlers.get(IPC.excelHost.requestClose)?.({ sender: { id: 17 } } as IpcMainInvokeEvent, 'foreign-session')
    expect(events).toEqual([[IPC.events.excelHostCloseRequested, 'session-a']])
    await expect(testIpcHandlers.get(IPC.excelHost.requestClose)?.({ sender: { id: 99 } } as IpcMainInvokeEvent))
      .rejects.toThrow('does not own')
    expect(events).toHaveLength(1)
    expect(closed).toEqual([])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closed).toEqual([17])
  })
})
