import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { handlerLog } from '../logger'
import { sanitizeForLogging } from './sanitize'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: never[]) => unknown | Promise<unknown>

export interface LoggedHandleOptions {
  /** Transform arguments before sanitization/logging, for channels carrying sensitive values. */
  transformLogArgs?: (args: readonly unknown[]) => unknown
}

/**
 * Wraps `ipcMain.handle` with consistent logging: every invocation gets an
 * arrow line at debug level (with sanitized args), every return gets a
 * duration, every throw gets the full Error logged at error level.
 *
 * Use this for ALL new IPC handlers — direct `ipcMain.handle` calls bypass
 * the trace and make support debugging much harder.
 */
export function loggedHandle(channel: string, fn: HandlerFn, options: LoggedHandleOptions = {}): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const start = performance.now()
    const logArgs = options.transformLogArgs ? options.transformLogArgs(args) : args
    handlerLog.debug(`→ ${channel}`, sanitizeForLogging(logArgs))
    try {
      const result = await Promise.resolve(fn(event, ...(args as never[])))
      const ms = Math.round(performance.now() - start)
      handlerLog.debug(`← ${channel} (${ms}ms)`)
      return result
    } catch (err) {
      const ms = Math.round(performance.now() - start)
      handlerLog.error(`✗ ${channel} (${ms}ms)`, err)
      throw err
    }
  })
}
