import { describe, expect, it, mock } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import type { WordHost } from '../word-host'
import { electronModuleMock, loggerModuleMock, testIpcHandlers } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { IPC } = await import('../../shared/ipc-channels')
const { registerWordHostHandlers } = await import('../handlers/word-host')

describe('Word host IPC boundary', () => {
  it('uses the sending child identity for runtime reports, completion and hide requests', async () => {
    const calls: unknown[][] = []
    const events: unknown[][] = []
    const word = {
      requestHide: (sender: number) => {
        if (sender !== 17) throw new Error('Word Session does not own this renderer')
        calls.push(['hide', sender])
        return { sessionId: 'session-a', expanded: false }
      },
      reportState: (...args: unknown[]) => { calls.push(['report', ...args]) },
      completeOpenFile: (...args: unknown[]) => { calls.push(['open', ...args]) },
      completeFlush: (...args: unknown[]) => { calls.push(['flush', ...args]) },
      setExpanded: (sender: number, expanded: boolean) => {
        calls.push(['expanded', sender, expanded])
        return { sessionId: 'session-a', expanded }
      },
    } as unknown as WordHost
    testIpcHandlers.clear()
    registerWordHostHandlers(word, (...args) => { events.push(args) })
    const event = { sender: { id: 17 } } as unknown as IpcMainInvokeEvent
    const state = { documentCount: 0, persistenceStatus: 'saved' }
    await testIpcHandlers.get(IPC.wordHost.reportState)?.(event, state)
    await testIpcHandlers.get(IPC.wordHost.completeOpenFile)?.(event, 'open-ticket', 'import failed')
    await testIpcHandlers.get(IPC.wordHost.completeFlush)?.(event, 'flush-ticket', true)
    await testIpcHandlers.get(IPC.wordHost.requestHide)?.(event)
    await testIpcHandlers.get(IPC.wordHost.setExpanded)?.(event, true)
    expect(calls).toEqual([
      ['report', 17, state], ['open', 17, 'open-ticket', 'import failed'],
      ['flush', 17, 'flush-ticket', true], ['hide', 17], ['expanded', 17, true],
    ])
    expect(events).toEqual([
      [IPC.events.wordHostExpandedChanged, { sessionId: 'session-a', expanded: false }],
      [IPC.events.wordHostHideRequested, 'session-a'],
      [IPC.events.wordHostExpandedChanged, { sessionId: 'session-a', expanded: true }],
    ])
    await expect(testIpcHandlers.get(IPC.wordHost.requestHide)?.({ sender: { id: 99 } } as IpcMainInvokeEvent)).rejects.toThrow('does not own')
  })

  it('converts renderer bounds through host zoom and only focuses on explicit hides', async () => {
    const bounds: unknown[] = []
    const visibility: boolean[] = []
    const word = {
      setBounds: (value: unknown) => { bounds.push(value) },
      setVisible: (value: boolean) => { visibility.push(value) },
    } as unknown as WordHost
    let focused = 0
    const event = { sender: {
      getZoomFactor: () => 1.5, isDestroyed: () => false, focus: () => { focused += 1 },
    } } as unknown as IpcMainInvokeEvent
    testIpcHandlers.clear()
    registerWordHostHandlers(word, () => undefined)
    await testIpcHandlers.get(IPC.wordHost.setBounds)?.(event, { x: 10, y: 20, width: 600, height: 400 })
    await testIpcHandlers.get(IPC.wordHost.setVisible)?.(event, true, true)
    await testIpcHandlers.get(IPC.wordHost.setVisible)?.(event, false)
    await testIpcHandlers.get(IPC.wordHost.setVisible)?.(event, false, true)
    expect(bounds).toEqual([{ x: 15, y: 30, width: 900, height: 600 }])
    expect(visibility).toEqual([true, false, false])
    expect(focused).toBe(1)
  })
})
