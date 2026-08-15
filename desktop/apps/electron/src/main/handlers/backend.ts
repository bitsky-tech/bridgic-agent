/**
 * IPC handlers for backend daemon coordination.
 *
 * Surface (see `ipc-channels.ts` for the channel names):
 *
 *   - `backend:snapshot`  → returns current PythonClient snapshot
 *   - `backend:restart`   → user-initiated restart
 *   - `backend:openLogs`  → reveal ~/.bridgic/AmphiAgent/server.log via shell
 *   - `backend:autostartStatus` / `backend:setAutostart` → login autostart
 *
 * State broadcast happens at module load time: we subscribe to
 * `pythonClient.onState` and forward to all renderer webContents via
 * `IPC.events.backendState`. Atoms in the renderer absorb this stream.
 */
import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { IPC } from '../../shared/ipc-channels'
import {
  APP_SLUG,
  APP_VERSION,
  AUTH_HEADER_NAME,
  BACKEND_LOG_FILE_NAME,
  BACKEND_RUNTIME_DIR_REL,
  CLIENT_ID_HEADER,
  CLIENT_TYPE_HEADER,
  GATEWAY_API_PATHS,
} from '../../shared/app-meta'
import { mainLog } from '../logger'
import { pythonClient } from '../python-client'
import {
  BackendState,
  ClientKind,
  type AutostartResult,
  type ClientInfoResponse,
  type GetClientsResult,
} from '../python-client/types'
import { cliAutostartStatus } from '../python-client/cli'
import { guiClientId } from '../gui-client-id'
import {
  readGuiAutostart,
  setGuiAutostart,
} from '../gui-autostart'
import {
  readCombinedAutostart,
  setCombinedAutostart,
  type AutostartCoordinatorDeps,
} from '../autostart-coordinator'
import { loggedHandle } from './logged-handle'

/** Timeout for the main-side /api/gateway/clients fetch. */
const GET_CLIENTS_TIMEOUT_MS = 5_000

/** User-Agent we self-report to the daemon. Surfaces in /api/gateway/clients
 *  rows (default 'node' is ugly + unhelpful for distinguishing GUI vs
 *  a custom Node script). */
const USER_AGENT = `${APP_SLUG}/${APP_VERSION}`

/** Serialize the two-part daemon + tray login-item transaction. Renderer UI
 * has its own busy guard, but IPC can also be called by a second window and the
 * OS registrations must still observe one total order. */
let autostartTail: Promise<void> = Promise.resolve()

function serializeAutostart<T>(operation: () => Promise<T>): Promise<T> {
  const result = autostartTail.then(operation, operation)
  autostartTail = result.then(() => undefined, () => undefined)
  return result
}

const autostartDeps: AutostartCoordinatorDeps = {
  readDaemon: cliAutostartStatus,
  setDaemon: (enabled) => pythonClient.setAutostart(enabled),
  readTray: () => readGuiAutostart(app),
  setTray: (enabled) => setGuiAutostart(app, enabled),
  warn: (message, error) => mainLog.warn(`[autostart] ${message}`, error),
  error: (message, error) => mainLog.error(`[autostart] ${message}`, error),
}

export function registerBackendHandlers(): void {
  loggedHandle(IPC.backend.snapshot, async () => {
    return pythonClient.snapshot()
  })

  loggedHandle(IPC.backend.refresh, async (_event, expectedEndpointEpoch?: number) => {
    await pythonClient.refresh(expectedEndpointEpoch)
    return pythonClient.snapshot()
  })

  loggedHandle(IPC.backend.start, async () => {
    await pythonClient.start()
  })

  loggedHandle(IPC.backend.stop, async () => {
    await pythonClient.stopDaemon()
  })

  loggedHandle(IPC.backend.restart, async () => {
    await pythonClient.restart()
  })

  loggedHandle(IPC.backend.getClients, async (): Promise<GetClientsResult> => {
    return fetchGatewayClients()
  })

  loggedHandle(IPC.backend.autostartStatus, async (): Promise<AutostartResult> => {
    return serializeAutostart(() => readCombinedAutostart(autostartDeps))
  })

  loggedHandle(
    IPC.backend.setAutostart,
    async (_event, enabled: boolean): Promise<AutostartResult> => {
      return serializeAutostart(() => setCombinedAutostart(enabled, autostartDeps))
    },
  )

  // The ONLY automatic-restart-free escape from a version mismatch. Kept as its
  // own channel rather than reusing `restart` so a grep for callers proves that
  // nothing but the mismatch screen can trigger it: restarting the gateway
  // disconnects every attached client, and doing that on the app's own
  // initiative would kill in-flight agent work during a half-applied update.
  loggedHandle(IPC.backend.resolveCompatibility, async () => {
    await pythonClient.restart()
    return pythonClient.snapshot()
  })

  loggedHandle(IPC.backend.openLogs, openDaemonLogs)

  // Broadcast state transitions to all renderer windows.
  pythonClient.onState((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue
      win.webContents.send(IPC.events.backendState, snapshot)
    }
  })

  mainLog.info('[handlers] backend handlers registered')
}

/**
 * Fetch /api/gateway/clients from the live daemon.
 *
 * Why a main-side wrapper (rather than letting renderer fetch directly)?
 *  1. The Tray (Phase E) needs this data and lives in main — sharing
 *     one code path avoids two fetch implementations diverging.
 *  2. Centralizes the headers contract (Authorization / X-Client-Id /
 *     X-Client-Type) so renderer atoms don't need to thread the token.
 *
 * Returns a discriminated union so renderer atoms can branch without
 * exception handling (consistent with backend:openLogs' shape).
 */
/**
 * Reveal the daemon log with the OS default handler.
 *
 * Exported (not just the IPC handler body) because the tray's error line links
 * here too — the tray lives in main and has no renderer to route through.
 */
export async function openDaemonLogs(): Promise<
  { ok: true; path: string } | { ok: false; reason: string }
> {
  // `server.log` lives in the same dir as runtime.json. Prefer the exact
  // path the daemon reported (`endpoint.runtimeFile` → its dirname) — the
  // daemon owns its layout (e.g. ~/.bridgic/AmphiAgent/). Fall back to the
  // legacy basename guess only when we have no live endpoint (daemon down).
  const runtimeFile = pythonClient.snapshot().endpoint?.runtimeFile
  const logPath = runtimeFile
    ? path.join(path.dirname(runtimeFile), BACKEND_LOG_FILE_NAME)
    : path.join(os.homedir(), BACKEND_RUNTIME_DIR_REL, BACKEND_LOG_FILE_NAME)
  if (!existsSync(logPath)) {
    return { ok: false as const, reason: `log file does not exist yet: ${logPath}` }
  }
  await shell.openPath(logPath)
  return { ok: true as const, path: logPath }
}

export async function fetchGatewayClients(): Promise<GetClientsResult> {
  const snap = pythonClient.snapshot()
  // `incompatible` is included on purpose: it means a daemon IS running and
  // reachable, we simply refuse to drive it. The endpoint and bearer token are
  // both populated, and the version-mismatch screen needs this count to tell the
  // user how much a restart will disconnect. Excluding it made that warning fall
  // back to its vaguest wording 100% of the time.
  if (snap.state !== BackendState.Ready && snap.state !== BackendState.Incompatible) {
    return { ok: false as const, reason: `daemon not ready (state=${snap.state})` }
  }
  const endpoint = snap.endpoint
  if (!endpoint || !endpoint.token) {
    return {
      ok: false as const,
      reason: 'no bearer token available — legacy daemon or runtime.json missing',
    }
  }

  const url = `${endpoint.baseUrl}${GATEWAY_API_PATHS.Clients}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), GET_CLIENTS_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        [AUTH_HEADER_NAME]: `Bearer ${endpoint.token}`,
        [CLIENT_ID_HEADER]: guiClientId(),
        [CLIENT_TYPE_HEADER]: ClientKind.Gui,
        'User-Agent': USER_AGENT,
      },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      if (res.status === 401) {
        void pythonClient.refresh(snap.endpointEpoch).catch((err: unknown) => {
          mainLog.warn('[backend] getClients auth refresh failed', err)
        })
      }
      const body = await res.text().catch(() => '')
      mainLog.warn('[backend] getClients non-ok', {
        status: res.status,
        bodyPreview: body.slice(0, 200),
      })
      return { ok: false as const, reason: `HTTP ${res.status}` }
    }
    const parsed: unknown = await res.json()
    if (!Array.isArray(parsed)) {
      // Daemon drift / an HTTP-200 error body: don't hand the renderer a value
      // typed as an array that isn't one (a later `.map` would throw deep in UI).
      mainLog.warn('[backend] getClients: expected an array', { got: typeof parsed })
      return { ok: false as const, reason: 'malformed response (expected array)' }
    }
    return { ok: true as const, clients: parsed as ClientInfoResponse[] }
  } catch (err) {
    mainLog.warn('[backend] getClients fetch failed', err)
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false as const, reason }
  } finally {
    clearTimeout(timer)
  }
}
