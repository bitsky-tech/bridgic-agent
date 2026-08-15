import { describe, expect, it, mock } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import type { EmbeddedBrowserManager } from '../embedded-browser-manager'
import {
  electronModuleMock,
  loggerModuleMock,
  testIpcHandlers,
} from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { IPC } = await import('../../shared/ipc-channels')
const { registerBrowserHandlers } = await import('../handlers/browser')

describe('browser IPC handlers', () => {
  it('forwards a requested page overflow inspection', async () => {
    const inspections: string[] = []
    const browser = {
      hasHorizontalOverflow: async (sessionId: string, tabId: string) => {
        inspections.push(`${sessionId}:${tabId}`)
        return true
      },
    } as unknown as EmbeddedBrowserManager

    testIpcHandlers.clear()
    registerBrowserHandlers(browser)
    const inspect = testIpcHandlers.get(IPC.browser.hasHorizontalOverflow)

    expect(await inspect?.({} as IpcMainInvokeEvent, 'session-a', 'tab-a')).toBe(true)
    expect(inspections).toEqual(['session-a:tab-a'])
  })

  it('focuses the renderer only for an explicitly focused hide', async () => {
    const visibility: boolean[] = []
    const browser = {
      setVisible: (visible: boolean) => { visibility.push(visible) },
    } as unknown as EmbeddedBrowserManager
    let focusCount = 0
    const event = {
      sender: {
        focus: () => { focusCount += 1 },
        isDestroyed: () => false,
      },
    } as unknown as IpcMainInvokeEvent

    testIpcHandlers.clear()
    registerBrowserHandlers(browser)
    const setVisible = testIpcHandlers.get(IPC.browser.setVisible)
    expect(setVisible).toBeDefined()

    await setVisible?.(event, false)
    await setVisible?.(event, false, false)
    await setVisible?.(event, true, true)
    expect(focusCount).toBe(0)

    await setVisible?.(event, false, true)
    expect(focusCount).toBe(1)
    expect(visibility).toEqual([false, false, true, false])
  })
})
