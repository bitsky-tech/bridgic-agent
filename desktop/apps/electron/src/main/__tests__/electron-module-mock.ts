/**
 * Shared Electron and logger mocks for Bun main-process tests.
 *
 * Bun keeps `mock.module` overrides for the lifetime of the test process, so every
 * test that replaces Electron must expose the same surface. Keep mutable IPC state
 * here as well, allowing handler tests to observe registrations regardless of which
 * test file Bun evaluates first.
 */

import type { IpcMainInvokeEvent } from 'electron'

/** Async IPC handler captured by the shared `ipcMain.handle` test double. */
export type TestIpcHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown>

/** Handlers registered through the shared Electron test double. */
export const testIpcHandlers = new Map<string, TestIpcHandler>()

/** Electron export surface shared by all main-process tests that mock the module. */
export const electronModuleMock = {
  app: {
    isPackaged: false,
    getAppPath: (): string => process.cwd(),
    getPath: (): string => '/tmp',
  },
  BrowserWindow: {
    getAllWindows: (): never[] => [],
  },
  ipcMain: {
    handle: (channel: string, handler: TestIpcHandler): void => {
      testIpcHandlers.set(channel, handler)
    },
    on: (): void => undefined,
  },
  nativeTheme: {
    themeSource: 'system',
  },
}

const noop = (): void => undefined
const testLogger = {
  debug: noop,
  error: noop,
  info: noop,
  warn: noop,
}

/** Complete export surface of the main-process logger module used by tests. */
export const loggerModuleMock = {
  default: {
    ...testLogger,
    initialize: noop,
  },
  getLogFilePath: (): undefined => undefined,
  handlerLog: testLogger,
  isDebugMode: true,
  mainLog: testLogger,
  telemetryLog: testLogger,
  updateLog: testLogger,
  windowLog: testLogger,
}
