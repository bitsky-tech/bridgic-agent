/**
 * Renderer-side logger that pipes through to the main process log file via
 * the electron-log IPC bridge. Use this instead of `console.*` so that:
 *   - Production logs reach `~/.bridgic/amphi/logs/main.log`
 *   - Errors caught by ErrorBoundary land in a queryable place
 *   - The same `[scope]` taxonomy works on both sides of the IPC fence
 *
 * Falls back to `console.*` when `window.api` is missing (Playwright /
 * plain Vite preview) — see `electron-log/renderer`'s built-in handling.
 */

import log from 'electron-log/renderer'

export const rlog = log.scope('renderer')
export default log
