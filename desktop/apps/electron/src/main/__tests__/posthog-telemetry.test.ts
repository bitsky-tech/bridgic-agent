import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventMessage, PostHogOptions } from 'posthog-node'
import {
  PostHogTelemetry,
  type TelemetryClient,
} from '../telemetry/posthog-telemetry'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

class FakeClient implements TelemetryClient {
  readonly captured: EventMessage[] = []
  readonly persisted = new Map<string, unknown>()
  disabled = false
  shutdownCount = 0

  capture(message: EventMessage): void {
    this.captured.push(message)
  }

  async disable(): Promise<void> {
    this.disabled = true
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1
  }

  on(): void {}

  setPersistedProperty(key: string, value: unknown): void {
    this.persisted.set(key, value)
  }
}

function createHarness(createUuid: () => string = () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
  const directory = mkdtempSync(join(tmpdir(), 'bridgic-telemetry-'))
  tempDirectories.push(directory)
  const clients: FakeClient[] = []
  const clientOptions: PostHogOptions[] = []
  const identityPath = join(directory, 'telemetry-state.json')
  const createTelemetry = () => new PostHogTelemetry({
    projectToken: 'phc_public_write_only_token',
    identityPath,
    appVersion: '1.2.3',
    releaseChannel: 'production',
    distribution: 'official',
    platform: 'darwin',
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    createUuid,
    createClient: (_token, options) => {
      const client = new FakeClient()
      clients.push(client)
      clientOptions.push(options)
      return client
    },
    log: { debug: () => undefined, warn: () => undefined },
  })
  return { clients, clientOptions, createTelemetry, identityPath }
}

describe('PostHogTelemetry', () => {
  test('does not create a client or identity before the enabled state is applied', () => {
    const harness = createHarness()
    const telemetry = harness.createTelemetry()

    telemetry.captureLaunch('foreground')

    expect(harness.clients).toHaveLength(0)
    expect(existsSync(harness.identityPath)).toBe(false)
  })

  test('reuses one anonymous installation ID across restarts', async () => {
    const harness = createHarness()
    const first = harness.createTelemetry()
    first.setConsent(true)
    first.captureLaunch('foreground')
    await first.shutdown()

    const second = harness.createTelemetry()
    second.setConsent(true)
    second.captureWindowOpened('initial')

    expect(harness.clients[0]?.captured[0]?.distinctId).toBe(
      'installation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )
    expect(harness.clients[1]?.captured[0]?.distinctId).toBe(
      harness.clients[0]?.captured[0]?.distinctId,
    )
    expect(harness.clientOptions[0]).toMatchObject({
      host: 'https://us.i.posthog.com',
      isServer: false,
      disableGeoip: true,
      enableExceptionAutocapture: false,
      flushAt: 1,
      flushInterval: 0,
      fetchRetryCount: 0,
    })
  })

  test('revoking consent deletes the ID, blocks captures, and creates a new ID on re-enable', async () => {
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]
    const harness = createHarness(() => ids.shift() ?? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    const telemetry = harness.createTelemetry()
    telemetry.setConsent(true)
    telemetry.captureLaunch('foreground')

    telemetry.setConsent(false)
    telemetry.captureWindowOpened('reopen')
    expect(existsSync(harness.identityPath)).toBe(false)
    expect(harness.clients[0]?.captured).toHaveLength(1)

    telemetry.setConsent(true)
    telemetry.captureWindowOpened('reopen')
    await Promise.resolve()

    expect(harness.clients[0]?.disabled).toBe(true)
    expect(harness.clients[0]?.persisted.get('queue')).toEqual([])
    expect(harness.clients[1]?.captured[0]?.distinctId).toBe(
      'installation:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    )
    expect(harness.clients[1]?.captured[0]?.distinctId).not.toBe(
      harness.clients[0]?.captured[0]?.distinctId,
    )
  })

  test('emits only fixed anonymous metadata for active periods', () => {
    const harness = createHarness()
    const telemetry = harness.createTelemetry()
    telemetry.setConsent(true)

    telemetry.captureActivePeriod({
      activeSeconds: 42.4,
      intervalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      endReason: 'window-blurred',
    })

    expect(harness.clients[0]?.captured[0]).toEqual({
      distinctId: 'installation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      event: 'app.active_period',
      properties: {
        schema_version: 1,
        app_version: '1.2.3',
        release_channel: 'production',
        distribution: 'official',
        platform: 'darwin',
        session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        active_seconds: 42,
        interval_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        end_reason: 'window-blurred',
        $process_person_profile: false,
      },
    })
  })
})
