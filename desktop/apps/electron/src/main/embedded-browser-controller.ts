import type { App } from 'electron'
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  AUTH_HEADER_NAME,
  CLIENT_ID_HEADER,
  CLIENT_TYPE_HEADER,
  GATEWAY_API_PATHS,
} from '../shared/app-meta'
import type { EmbeddedBrowserSessionInfo, EmbeddedBrowserTabInfo } from '../shared/types'
import type { BackendEndpoint } from './python-client/types'
import type { EmbeddedBrowserManager } from './embedded-browser-manager'
import { mainLog } from './logger'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 16 * 1024
const REQUEST_TIMEOUT_MS = 3_000
const REGISTRATION_REFRESH_MS = 10_000

interface ControllerRegistration {
  controller_id: string
  generation: string
  control_url: string
  control_token: string
  cdp_endpoint: string
  owner_pid: number
}

interface SessionRequest {
  session_id?: unknown
}

interface TabRequest extends SessionRequest {
  target_id?: unknown
  url?: unknown
}

/** Electron-owned loopback bridge used by the Python BrowserHost. */
export class EmbeddedBrowserController {
  private readonly controllerId = randomUUID()
  private readonly generation = randomUUID()
  private readonly controlToken = randomBytes(32).toString('base64url')
  private server: Server | null = null
  private controlUrl: string | null = null
  private registeredDaemon: BackendEndpoint | null = null
  private registrationInflight: Promise<void> | null = null
  private stopping = false
  private desiredDaemon: BackendEndpoint | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private refreshInflight: Promise<void> | null = null

  constructor(
    private readonly browser: EmbeddedBrowserManager,
    private readonly cdpEndpoint: string,
  ) {}

  /** Enable Chromium's loopback DevTools endpoint before Electron becomes ready. */
  static configureRemoteDebugging(app: App): string {
    if (app.isReady()) throw new Error('embedded browser debugging must be configured before app ready')

    const existing = app.commandLine.getSwitchValue('remote-debugging-port')
    const configured = process.env.AMPHI_EMBEDDED_BROWSER_CDP_PORT
    let port = randomInt(20_000, 60_000)
    if (existing) {
      port = this.parsePort(existing, 'remote-debugging-port')
    } else if (configured) {
      port = this.parsePort(configured, 'AMPHI_EMBEDDED_BROWSER_CDP_PORT')
    }

    if (!existing) app.commandLine.appendSwitch('remote-debugging-port', String(port))
    app.commandLine.appendSwitch('remote-debugging-address', LOOPBACK_HOST)
    return `http://${LOOPBACK_HOST}:${port}`
  }

  /** Start the authenticated controller on an ephemeral loopback port. */
  async start(): Promise<void> {
    if (this.server) return
    this.stopping = false
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = server.address() as AddressInfo | null
    if (!address) {
      server.close()
      throw new Error('embedded browser controller did not bind a loopback address')
    }
    this.server = server
    this.controlUrl = `http://${LOOPBACK_HOST}:${address.port}`
    mainLog.info(`[embedded-browser] controller ready at ${this.controlUrl}`)
  }

  /** Register or refresh this Electron controller in the active daemon. */
  async registerWithDaemon(endpoint: BackendEndpoint): Promise<void> {
    if (this.stopping || !endpoint.token || !this.controlUrl) return
    this.desiredDaemon = endpoint
    this.scheduleRefresh()
    if (
      this.registeredDaemon?.baseUrl === endpoint.baseUrl
      && this.registeredDaemon.token === endpoint.token
    ) {
      return
    }
    if (this.registrationInflight) {
      // A failed old endpoint must not prevent a newer daemon from registering.
      await this.registrationInflight.catch(() => {})
      if (this.stopping || !this.controlUrl || this.desiredDaemon !== endpoint) return
      if (
        this.registeredDaemon?.baseUrl === endpoint.baseUrl
        && this.registeredDaemon.token === endpoint.token
      ) {
        return
      }
    }
    const registration = this.performRegistration(endpoint)
    this.registrationInflight = registration
    try {
      await registration
      this.registeredDaemon = endpoint
    } finally {
      if (this.registrationInflight === registration) this.registrationInflight = null
    }
  }

  /** Suspend repair while the daemon is being rediscovered. */
  suspendRegistration(): void {
    this.desiredDaemon = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
  }

  private scheduleRefresh(): void {
    if (this.stopping || !this.desiredDaemon || this.refreshTimer || this.refreshInflight) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      const refresh = this.refreshRegistration().catch((error) => {
        mainLog.warn('[embedded-browser] registration check failed; retrying in 10 seconds', error)
      })
      this.refreshInflight = refresh
      void refresh.finally(() => {
        this.refreshInflight = null
        this.scheduleRefresh()
      })
    }, REGISTRATION_REFRESH_MS)
    this.refreshTimer.unref()
  }

  private async refreshRegistration(): Promise<void> {
    const endpoint = this.desiredDaemon
    if (!endpoint || this.stopping) return
    await this.registrationInflight?.catch(() => {})
    if (this.stopping || this.desiredDaemon !== endpoint) return
    const response = await fetch(`${endpoint.baseUrl}${GATEWAY_API_PATHS.BrowserController}`, {
      headers: this.daemonHeaders(endpoint),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`browser controller status failed: HTTP ${response.status}`)
    const status: unknown = await response.json()
    if (this.stopping || this.desiredDaemon !== endpoint) return
    if (!status || typeof status !== 'object' || !('available' in status)
      || typeof status.available !== 'boolean') {
      throw new Error('browser controller status returned an invalid response')
    }
    // Another desktop may have explicitly taken ownership. Do not steal it back.
    if (status.available) {
      if (!('controller_id' in status) || !('generation' in status)) {
        throw new Error('browser controller status returned no owner')
      }
      if (status.controller_id === this.controllerId && status.generation === this.generation) {
        this.registeredDaemon = endpoint
      }
      return
    }
    mainLog.warn('[embedded-browser] daemon lost browser registration; restoring it')
    // URL/token can stay unchanged even when the daemon loses its registration.
    this.registeredDaemon = null
    await this.registerWithDaemon(endpoint)
  }

  /** Best-effort unregister and stop accepting daemon commands. */
  async stop(): Promise<void> {
    this.stopping = true
    this.suspendRegistration()
    await this.refreshInflight
    try {
      await this.registrationInflight
    } catch {
      // A failed registration leaves nothing to unregister.
    }
    const endpoint = this.registeredDaemon
    this.registeredDaemon = null
    if (endpoint?.token) {
      try {
        await fetch(`${endpoint.baseUrl}${GATEWAY_API_PATHS.BrowserController}`, {
          method: 'DELETE',
          headers: this.daemonHeaders(endpoint),
          body: JSON.stringify({ controller_id: this.controllerId }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        // The daemon commonly exits before Electron during a full quit.
      }
    }
    const server = this.server
    this.server = null
    this.controlUrl = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private async performRegistration(endpoint: BackendEndpoint): Promise<void> {
    const response = await fetch(`${endpoint.baseUrl}${GATEWAY_API_PATHS.BrowserController}`, {
      method: 'PUT',
      headers: this.daemonHeaders(endpoint),
      body: JSON.stringify(this.registration()),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`embedded browser controller registration failed: HTTP ${response.status}`)
    }
    mainLog.info('[embedded-browser] controller registered with daemon')
  }

  private registration(): ControllerRegistration {
    if (!this.controlUrl) throw new Error('embedded browser controller is not running')
    return {
      controller_id: this.controllerId,
      generation: this.generation,
      control_url: this.controlUrl,
      control_token: this.controlToken,
      cdp_endpoint: this.cdpEndpoint,
      owner_pid: process.pid,
    }
  }

  private daemonHeaders(endpoint: BackendEndpoint): Record<string, string> {
    return {
      [AUTH_HEADER_NAME]: `Bearer ${endpoint.token}`,
      [CLIENT_ID_HEADER]: endpoint.clientId ?? this.controllerId,
      [CLIENT_TYPE_HEADER]: 'gui',
      'Content-Type': 'application/json',
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(request)) {
        this.sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      if (request.method === 'GET' && request.url === '/v1/health') {
        this.sendJson(response, 200, {
          controller_id: this.controllerId,
          generation: this.generation,
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sessions/ensure') {
        const body = await this.readJson<SessionRequest>(request)
        const sessionId = this.sessionId(body.session_id)
        this.sendJson(response, 200, this.sessionWire(await this.browser.ensureSession(sessionId)))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sessions/tabs/list') {
        const body = await this.readJson<SessionRequest>(request)
        const sessionId = this.sessionId(body.session_id)
        this.sendJson(response, 200, this.sessionWire(await this.browser.sessionTabs(sessionId)))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sessions/tabs/create') {
        const body = await this.readJson<TabRequest>(request)
        const sessionId = this.sessionId(body.session_id)
        await this.browser.createTab(sessionId, this.optionalUrl(body.url))
        this.sendJson(response, 200, this.sessionWire(await this.browser.sessionTabs(sessionId)))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sessions/tabs/activate') {
        const body = await this.readJson<TabRequest>(request)
        const info = this.browser.activateTarget(
          this.sessionId(body.session_id),
          this.targetId(body.target_id),
        )
        this.sendJson(response, 200, this.sessionWire(info))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sessions/tabs/close') {
        const body = await this.readJson<TabRequest>(request)
        const info = await this.browser.closeTarget(
          this.sessionId(body.session_id),
          this.targetId(body.target_id),
        )
        this.sendJson(response, 200, this.sessionWire(info))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sessions/release') {
        const body = await this.readJson<SessionRequest>(request)
        this.browser.closeSession(this.sessionId(body.session_id))
        this.sendJson(response, 200, { released: true })
        return
      }
      this.sendJson(response, 404, { error: 'not_found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mainLog.warn(`[embedded-browser] controller request failed: ${message}`)
      this.sendJson(response, 400, { error: message })
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const received = Buffer.from(header.slice('Bearer '.length))
    const expected = Buffer.from(this.controlToken)
    return received.length === expected.length && timingSafeEqual(received, expected)
  }

  private async readJson<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
      chunks.push(buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    return JSON.parse(raw || '{}') as T
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify(body))
  }

  private sessionId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('session_id is required')
    }
    return value.trim()
  }

  private targetId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('target_id is required')
    }
    return value.trim()
  }

  private optionalUrl(value: unknown): string {
    if (value === undefined || value === null || value === '') return 'about:blank'
    if (typeof value !== 'string' || value.length > 16_384) {
      throw new Error('url must be a string no longer than 16384 characters')
    }
    return value
  }

  private sessionWire(info: EmbeddedBrowserSessionInfo): Record<string, unknown> {
    const active = info.tabs.find((tab) => tab.tabId === info.activeTabId) ?? null
    return {
      session_id: info.sessionId,
      active_tab_id: info.activeTabId,
      active_target_id: active?.targetId ?? null,
      tabs: info.tabs.map((tab) => this.tabWire(tab)),
    }
  }

  private tabWire(tab: EmbeddedBrowserTabInfo): Record<string, unknown> {
    return {
      tab_id: tab.tabId,
      target_id: tab.targetId,
      web_contents_id: tab.webContentsId,
      title: tab.title,
      url: tab.url,
      loading: tab.loading,
      can_go_back: tab.canGoBack,
      can_go_forward: tab.canGoForward,
      favicon_url: tab.faviconUrl,
      crashed: tab.crashed,
    }
  }

  private static parsePort(value: string, source: string): number {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${source} must be an integer TCP port`)
    }
    return port
  }
}
