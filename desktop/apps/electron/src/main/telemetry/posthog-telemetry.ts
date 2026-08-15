import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  PostHog,
  type EventMessage,
  type PostHogOptions,
} from 'posthog-node'
import type { ActivePeriodEndReason } from './foreground-usage-tracker'
export type { ActivePeriodEndReason } from './foreground-usage-tracker'

type PostHogFetch = NonNullable<PostHogOptions['fetch']>
type PostHogFetchOptions = Parameters<PostHogFetch>[1]
type PostHogFetchResponse = Awaited<ReturnType<PostHogFetch>>

const IDENTITY_SCHEMA_VERSION = 1
const POSTHOG_HOST = 'https://us.i.posthog.com'
const SHUTDOWN_TIMEOUT_MS = 2_000

export type LaunchMode = 'foreground' | 'background'
export type WindowOpenReason = 'initial' | 'reopen'
interface TelemetryIdentity {
  schema_version: typeof IDENTITY_SCHEMA_VERSION
  installation_id: string
}

export interface TelemetryClient {
  capture(message: EventMessage): void
  disable(): Promise<void>
  shutdown(timeoutMs?: number): Promise<void>
  on(event: 'error', listener: (error: unknown) => void): unknown
}

export interface PostHogTelemetryOptions {
  projectToken: string
  identityPath: string
  appVersion: string
  releaseChannel: 'production' | 'development'
  distribution: 'official' | 'development'
  platform: 'darwin' | 'win32' | 'linux'
  sessionId?: string
  createClient?: (projectToken: string, options: PostHogOptions) => TelemetryClient
  createUuid?: () => string
  log?: Pick<Console, 'debug' | 'warn'>
}

interface ClientSession {
  client: TelemetryClient
  fetchGate: ConsentFetchGate
}

/**
 * Consent-bound PostHog transport for anonymous desktop usage events.
 *
 * The class never identifies a person and exposes only fixed-schema event
 * methods. The random installation ID is created only after opt-in, survives
 * restarts, and is deleted when consent is revoked.
 */
export class PostHogTelemetry {
  private readonly options: PostHogTelemetryOptions
  private readonly createUuid: () => string
  private readonly createClient: (projectToken: string, options: PostHogOptions) => TelemetryClient
  private readonly log: Pick<Console, 'debug' | 'warn'>
  private readonly sessionId: string
  private consented: boolean | null = null
  private installationId: string | null = null
  private clientSession: ClientSession | null = null

  constructor(options: PostHogTelemetryOptions) {
    this.options = options
    this.createUuid = options.createUuid ?? randomUUID
    this.createClient = options.createClient ?? ((token, clientOptions) => new PostHog(token, clientOptions))
    this.log = options.log ?? console
    this.sessionId = options.sessionId ?? this.createUuid()
  }

  /** Enable or disable future collection immediately. */
  setConsent(consented: boolean): void {
    if (this.consented === consented) return
    this.consented = consented

    if (!consented) {
      const previous = this.clientSession
      this.clientSession = null
      this.installationId = null
      this.deleteIdentity()
      if (previous) void this.discardAndClose(previous)
      return
    }

    const projectToken = this.options.projectToken.trim()
    if (!projectToken) {
      this.log.debug('[telemetry] enabled, but this build has no project token; collection is inactive')
      return
    }

    let fetchGate: ConsentFetchGate | null = null
    try {
      const installationId = this.loadOrCreateIdentity()
      fetchGate = new ConsentFetchGate()
      const client = this.createClient(projectToken, {
        host: POSTHOG_HOST,
        isServer: false,
        disableGeoip: true,
        enableExceptionAutocapture: false,
        flushAt: 1,
        flushInterval: 0,
        fetchRetryCount: 0,
        requestTimeout: 5_000,
        fetch: fetchGate.fetch,
      })
      client.on('error', (error) => {
        this.log.warn('[telemetry] PostHog delivery failed; app behavior is unaffected', error)
      })
      this.installationId = installationId
      this.clientSession = { client, fetchGate }
    } catch (error) {
      fetchGate?.close()
      this.installationId = null
      this.clientSession = null
      this.log.warn('[telemetry] initialization failed; collection is inactive', error)
    }
  }

  captureLaunch(launchMode: LaunchMode): void {
    this.capture('app.launched', { launch_mode: launchMode })
  }

  captureWindowOpened(reason: WindowOpenReason): void {
    this.capture('app.window_opened', { open_reason: reason })
  }

  captureActivePeriod(input: {
    activeSeconds: number
    intervalId: string
    endReason: ActivePeriodEndReason
  }): void {
    const activeSeconds = Math.max(1, Math.min(300, Math.round(input.activeSeconds)))
    this.capture('app.active_period', {
      active_seconds: activeSeconds,
      interval_id: input.intervalId,
      end_reason: input.endReason,
    })
  }

  /** Flush consented events before normal application exit. */
  async shutdown(): Promise<void> {
    const current = this.clientSession
    this.clientSession = null
    if (!current) return
    try {
      await current.client.shutdown(SHUTDOWN_TIMEOUT_MS)
    } catch (error) {
      this.log.warn('[telemetry] shutdown flush failed; quitting anyway', error)
    } finally {
      current.fetchGate.close()
    }
  }

  /** Stop all network work synchronously for an unpreventable OS shutdown. */
  stopWithoutFlush(): void {
    const current = this.clientSession
    this.clientSession = null
    current?.fetchGate.close()
    if (current) void current.client.disable().catch(() => undefined)
  }

  private capture(event: string, eventProperties: Record<string, string | number>): void {
    if (this.consented !== true || !this.clientSession || !this.installationId) return
    try {
      this.clientSession.client.capture({
        distinctId: `installation:${this.installationId}`,
        event,
        properties: {
          schema_version: IDENTITY_SCHEMA_VERSION,
          app_version: this.options.appVersion,
          release_channel: this.options.releaseChannel,
          distribution: this.options.distribution,
          platform: this.options.platform,
          session_id: this.sessionId,
          ...eventProperties,
          $process_person_profile: false,
        },
      })
    } catch (error) {
      this.log.warn('[telemetry] event capture failed; app behavior is unaffected', error)
    }
  }

  private loadOrCreateIdentity(): string {
    try {
      const parsed = JSON.parse(readFileSync(this.options.identityPath, 'utf-8')) as Partial<TelemetryIdentity>
      if (
        parsed.schema_version === IDENTITY_SCHEMA_VERSION &&
        typeof parsed.installation_id === 'string' &&
        isUuid(parsed.installation_id)
      ) {
        return parsed.installation_id
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.log.warn('[telemetry] anonymous ID could not be read; replacing it')
    }

    const installationId = this.createUuid()
    const file = this.options.identityPath
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    const state: TelemetryIdentity = {
      schema_version: IDENTITY_SCHEMA_VERSION,
      installation_id: installationId,
    }
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(temporary, file)
    return installationId
  }

  private deleteIdentity(): void {
    try {
      rmSync(this.options.identityPath, { force: true })
    } catch {
      this.log.warn('[telemetry] anonymous ID could not be deleted')
    }
  }

  private async discardAndClose(session: ClientSession): Promise<void> {
    session.fetchGate.close()
    try {
      await session.client.disable()
      // posthog-node has no public "drop pending" API. Its in-memory queue
      // setter is public, so clear the three queue keys after the network gate
      // is closed; a future SDK change can only make this best-effort cleanup
      // fail, never reopen network access.
      const queueClient = session.client as TelemetryClient & {
        setPersistedProperty?: (key: string, value: unknown) => void
      }
      for (const key of ['queue', 'ai_queue', 'logs_queue']) {
        queueClient.setPersistedProperty?.(key, [])
      }
      await session.client.shutdown(SHUTDOWN_TIMEOUT_MS)
    } catch (error) {
      this.log.warn('[telemetry] client cleanup failed after opt-out', error)
    }
  }
}

/** Abortable network gate that permanently closes when its consent is revoked. */
class ConsentFetchGate {
  private open = true
  private readonly controllers = new Set<AbortController>()

  readonly fetch = async (url: string, options: PostHogFetchOptions): Promise<PostHogFetchResponse> => {
    if (!this.open) throw new Error('telemetry consent has been revoked')
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) forwardAbort()
    else options.signal?.addEventListener('abort', forwardAbort, { once: true })
    this.controllers.add(controller)
    try {
      if (!this.open) controller.abort()
      return await fetch(url, { ...options, signal: controller.signal })
    } finally {
      this.controllers.delete(controller)
      options.signal?.removeEventListener('abort', forwardAbort)
    }
  }

  close(): void {
    if (!this.open) return
    this.open = false
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
