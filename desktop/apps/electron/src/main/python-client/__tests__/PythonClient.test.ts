import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { PythonClient as PythonClientInstance, PythonClientDependencies } from '../PythonClient'
import {
  BackendState,
  StatusKind,
  type BackendSnapshot,
  type GatewayInfoResponse,
  type StatusJson,
} from '../types'
import type { RuntimeFile } from '../runtime-file'
import {
  electronModuleMock,
  loggerModuleMock,
} from '../../__tests__/electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../../logger', () => loggerModuleMock)

const { PythonClient } = await import('../PythonClient')

const RUNTIME_PATH = 'C:\\test\\runtime.json'

function runtime(overrides: Partial<RuntimeFile> = {}): RuntimeFile {
  return {
    host: '127.0.0.1',
    port: 7421,
    pid: 1001,
    startedAt: '2026-08-08T12:00:00',
    token: 'token-a',
    lockFile: 'C:\\test\\gateway.lock',
    wsPath: '/ws',
    version: '0.1.0',
    ...overrides,
  }
}

function info(value: RuntimeFile): GatewayInfoResponse {
  return {
    pid: value.pid,
    host: value.host,
    port: value.port,
    version: value.version ?? '0.1.0',
    started_at: value.startedAt,
    uptime_seconds: 1,
    ws_path: value.wsPath ?? '/ws',
    connected_clients_count: 0,
  }
}

function runningStatus(value: RuntimeFile): Extract<StatusJson, { status: 'running' }> {
  return {
    status: StatusKind.Running,
    host: value.host,
    port: value.port,
    base_url: `http://${value.host}:${value.port}`,
    pid: value.pid,
    started_at: value.startedAt,
    runtime_file: RUNTIME_PATH,
    version: value.version,
    ws_path: value.wsPath,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function baseDependencies(
  overrides: Partial<PythonClientDependencies> = {},
): Partial<PythonClientDependencies> {
  return {
    runtimeFilePath: () => RUNTIME_PATH,
    guiClientId: () => 'gui-test',
    readReleaseManifest: () => null,
    sleep: async () => undefined,
    cliStatus: async () => ({ status: StatusKind.Stopped, runtime_file: RUNTIME_PATH }),
    cliStart: async () => false,
    cliRestart: async () => false,
    cliStop: async () => true,
    ...overrides,
  }
}

const clients: PythonClientInstance[] = []

function createClient(dependencies: Partial<PythonClientDependencies>): PythonClientInstance {
  const client = new PythonClient(dependencies)
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
})

describe('PythonClient authenticated readiness', () => {
  it('publishes Ready only after /api/gateway/info accepts the runtime token', async () => {
    const registration = runtime()
    let infoCalls = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        fetch: async (url, init) => {
          infoCalls += 1
          expect(url).toBe('http://127.0.0.1:7421/api/gateway/info')
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-a')
          return jsonResponse(info(registration))
        },
      }),
    )
    const snapshots: BackendSnapshot[] = []
    client.onState((snapshot) => snapshots.push(snapshot))

    await client.start()

    expect(infoCalls).toBe(1)
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-a')
    expect(
      snapshots
        .filter((snapshot) => snapshot.state === BackendState.Ready)
        .every((snapshot) => Boolean(snapshot.endpoint?.token)),
    ).toBe(true)
  })

  it('leaves an authenticated endpoint untouched when start is called again', async () => {
    const registration = runtime()
    let reads = 0
    let infoCalls = 0
    let statusCalls = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => {
          reads += 1
          return registration
        },
        cliStatus: async () => {
          statusCalls += 1
          return runningStatus(registration)
        },
        fetch: async () => {
          infoCalls += 1
          return jsonResponse(info(registration))
        },
      }),
    )
    await client.start()
    const before = client.snapshot()
    const readsBefore = reads
    const infoCallsBefore = infoCalls
    const states: BackendState[] = []
    client.onState((snapshot) => states.push(snapshot.state))

    await client.start()

    const after = client.snapshot()
    expect(after.state).toBe(BackendState.Ready)
    expect(after.endpoint).toBe(before.endpoint)
    expect(after.endpointEpoch).toBe(before.endpointEpoch)
    expect(reads).toBe(readsBefore)
    expect(infoCalls).toBe(infoCallsBefore)
    expect(statusCalls).toBe(0)
    expect(states).toEqual([])
  })

  it('changes autostart without retiring or refreshing a ready endpoint', async () => {
    const registration = runtime()
    let runtimeReads = 0
    let infoCalls = 0
    let enables = 0
    let disables = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => {
          runtimeReads += 1
          return registration
        },
        fetch: async () => {
          infoCalls += 1
          return jsonResponse(info(registration))
        },
        cliAutostartEnable: async () => {
          enables += 1
          return true
        },
        cliAutostartDisable: async () => {
          disables += 1
          return false
        },
      }),
    )
    await client.start()
    const before = client.snapshot()
    const readsBefore = runtimeReads
    const infoCallsBefore = infoCalls
    const states: BackendState[] = []
    client.onState((snapshot) => states.push(snapshot.state))

    expect(await client.setAutostart(true)).toBe(true)
    expect(await client.setAutostart(false)).toBe(false)

    const after = client.snapshot()
    expect(enables).toBe(1)
    expect(disables).toBe(1)
    expect(after.state).toBe(BackendState.Ready)
    expect(after.endpoint).toBe(before.endpoint)
    expect(after.endpointEpoch).toBe(before.endpointEpoch)
    expect(after.lastError).toBe(before.lastError)
    expect(runtimeReads).toBe(readsBefore)
    expect(infoCalls).toBe(infoCallsBefore)
    expect(states).toEqual([])
  })

  it('never publishes a tokenless running daemon and does not try to spawn it', async () => {
    const registration = runtime({ token: null })
    let reads = 0
    let starts = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => {
          reads += 1
          return registration
        },
        cliStatus: async () => runningStatus(registration),
        cliStart: async () => {
          starts += 1
          return true
        },
        fetch: async () => {
          throw new Error('/info must not be called without a token')
        },
      }),
    )
    const states: string[] = []
    client.onState((snapshot) => states.push(snapshot.state))

    await client.start()

    expect(reads).toBe(14)
    expect(starts).toBe(0)
    expect(states).not.toContain(BackendState.Ready)
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
    expect(client.snapshot().endpoint).toBeNull()
  })

  it('retries a status/runtime identity race before publishing', async () => {
    const expected = runtime()
    const raced = runtime({ pid: 2002, token: 'token-b' })
    let statusRead = false
    let readsAfterStatus = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => {
          if (!statusRead) return null
          readsAfterStatus += 1
          return readsAfterStatus === 1 ? raced : expected
        },
        cliStatus: async () => {
          statusRead = true
          return runningStatus(expected)
        },
        fetch: async () => jsonResponse(info(expected)),
      }),
    )

    await client.start()

    expect(readsAfterStatus).toBe(3)
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-a')
  })

  it('never publishes a persistent status/runtime pid mismatch or spawns over it', async () => {
    const statusRuntime = runtime()
    const diskRuntime = runtime({ pid: 2002, token: 'token-b' })
    let statusRead = false
    let starts = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => (statusRead ? diskRuntime : null),
        cliStatus: async () => {
          statusRead = true
          return runningStatus(statusRuntime)
        },
        cliStart: async () => {
          starts += 1
          return true
        },
        fetch: async () => {
          throw new Error('/info must not be called for mismatched identities')
        },
      }),
    )

    await client.start()

    expect(starts).toBe(0)
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
    expect(client.snapshot().endpoint).toBeNull()
    expect(client.snapshot().lastError).toContain('different processes')
  })

  it('rejects a token that /info answers with 401', async () => {
    const registration = runtime()
    let starts = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliStatus: async () => runningStatus(registration),
        cliStart: async () => {
          starts += 1
          return true
        },
        fetch: async () => jsonResponse({ detail: 'Unauthorized' }, 401),
      }),
    )

    await client.start()

    expect(starts).toBe(0)
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
    expect(client.snapshot().endpoint).toBeNull()
    expect(client.snapshot().lastError).toContain('HTTP 401')
  })
})

describe('PythonClient discovery-only refresh', () => {
  it('deduplicates concurrent refreshes and adopts a rotated runtime directly', async () => {
    const first = runtime()
    const second = runtime({
      pid: 2002,
      startedAt: '2026-08-08T12:01:00',
      token: 'token-b',
    })
    let registration: RuntimeFile | null = first
    let fetchCalls = 0
    let statusCalls = 0
    let starts = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliStatus: async () => {
          statusCalls += 1
          return { status: StatusKind.Stopped, runtime_file: RUNTIME_PATH }
        },
        cliStart: async () => {
          starts += 1
          return true
        },
        fetch: async (_url, init) => {
          fetchCalls += 1
          const token = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '')
          return jsonResponse(info(token === 'token-b' ? second : first))
        },
      }),
    )
    await client.start()
    const firstEndpointEpoch = client.snapshot().endpointEpoch
    expect(client.snapshot().endpoint?.token).toBe('token-a')

    registration = second
    fetchCalls = 0
    const [left, right] = await Promise.all([client.refresh(), client.refresh()])

    expect(fetchCalls).toBe(1)
    expect(statusCalls).toBe(0)
    expect(starts).toBe(0)
    expect(left.endpoint?.token).toBe('token-b')
    expect(right.endpoint?.token).toBe('token-b')
    expect(client.snapshot().state).toBe(BackendState.Ready)

    const callsBeforeStaleFault = fetchCalls
    await client.refresh(firstEndpointEpoch)
    expect(fetchCalls).toBe(callsBeforeStaleFault)
    expect(client.snapshot().endpoint?.token).toBe('token-b')
  })

  it('keeps the authenticated endpoint published during a successful side refresh', async () => {
    const registration = runtime()
    const refreshStarted = deferred<void>()
    const refreshResponse = deferred<Response>()
    let fetches = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        fetch: async () => {
          fetches += 1
          if (fetches === 1) return jsonResponse(info(registration))
          refreshStarted.resolve()
          return refreshResponse.promise
        },
      }),
    )
    await client.start()

    const refreshing = client.refresh(client.snapshot().endpointEpoch)
    await refreshStarted.promise
    expect(client.snapshot().state).toBe(BackendState.Unhealthy)
    expect(client.snapshot().endpoint?.token).toBe('token-a')

    refreshResponse.resolve(jsonResponse(info(registration)))
    await refreshing
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-a')
  })

  it('keeps the live endpoint across one transient health connection failure', async () => {
    const registration = runtime()
    let fetchCalls = 0
    let statusCalls = 0
    let starts = 0
    const retryDelays: number[] = []
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliStatus: async () => {
          statusCalls += 1
          return runningStatus(registration)
        },
        cliStart: async () => {
          starts += 1
          return true
        },
        sleep: async (milliseconds) => {
          retryDelays.push(milliseconds)
        },
        fetch: async () => {
          fetchCalls += 1
          if (fetchCalls === 2) {
            const timeout = new Error('health probe timed out')
            timeout.name = 'AbortError'
            throw timeout
          }
          return jsonResponse(info(registration))
        },
      }),
    )
    await client.start()
    const before = client.snapshot()
    const states: BackendState[] = []
    client.onState((snapshot) => states.push(snapshot.state))

    await (
      client as unknown as { _probeHealth: () => Promise<void> }
    )._probeHealth()

    const after = client.snapshot()
    expect(fetchCalls).toBe(3)
    expect(retryDelays).toEqual([5_000])
    expect(statusCalls).toBe(0)
    expect(starts).toBe(0)
    expect(after.state).toBe(BackendState.Ready)
    expect(after.endpoint).toBe(before.endpoint)
    expect(after.endpointEpoch).toBe(before.endpointEpoch)
    expect(after.lastError).toBeNull()
    expect(states).toEqual([])
  })

  it('refreshes first and self-heals a crashed daemon after a connection failure', async () => {
    const first = runtime()
    const second = runtime({
      pid: 2002,
      startedAt: '2026-08-08T12:01:00',
      token: 'token-b',
    })
    let registration: RuntimeFile | null = first
    let crashed = false
    let statusCalls = 0
    let starts = 0
    const retryDelays: number[] = []
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliStatus: async () => {
          statusCalls += 1
          return registration
            ? runningStatus(registration)
            : { status: StatusKind.Stopped, runtime_file: RUNTIME_PATH }
        },
        cliStart: async () => {
          starts += 1
          registration = second
          crashed = false
          return true
        },
        sleep: async (milliseconds) => {
          retryDelays.push(milliseconds)
        },
        fetch: async () => {
          if (crashed) throw new Error('connection reset')
          return jsonResponse(info(registration ?? first))
        },
      }),
    )
    await client.start()
    crashed = true
    registration = null

    await (
      client as unknown as { _probeHealth: () => Promise<void> }
    )._probeHealth()

    expect(retryDelays.filter((delay) => delay === 5_000)).toEqual([5_000])
    expect(statusCalls).toBe(2)
    expect(starts).toBe(1)
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-b')
  })

  it('discards a stale health failure after a newer endpoint is adopted', async () => {
    const first = runtime()
    const second = runtime({
      pid: 2002,
      startedAt: '2026-08-08T12:01:00',
      token: 'token-b',
    })
    let registration = first
    let fetchCalls = 0
    const staleProbe = deferred<Response>()
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        fetch: async (_url, init) => {
          fetchCalls += 1
          if (fetchCalls === 2) return staleProbe.promise
          const authorization = new Headers(init?.headers).get('Authorization')
          return jsonResponse(info(authorization === 'Bearer token-b' ? second : first))
        },
      }),
    )
    await client.start()

    const probing = (
      client as unknown as { _probeHealth: () => Promise<void> }
    )._probeHealth()
    registration = second
    await client.refresh()
    staleProbe.resolve(jsonResponse({ detail: 'old daemon failed' }, 500))
    await probing

    expect(fetchCalls).toBe(3)
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-b')
  })

  it('refreshes but never spawns on a health 401 with no replacement token', async () => {
    const registration = runtime()
    let rejectToken = false
    let starts = 0
    let statusCalls = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliStatus: async () => {
          statusCalls += 1
          return runningStatus(registration)
        },
        cliStart: async () => {
          starts += 1
          return true
        },
        fetch: async () =>
          rejectToken
            ? jsonResponse({ detail: 'Unauthorized' }, 401)
            : jsonResponse(info(registration)),
      }),
    )
    await client.start()
    rejectToken = true

    await (
      client as unknown as { _probeHealth: () => Promise<void> }
    )._probeHealth()

    expect(statusCalls).toBe(0)
    expect(starts).toBe(0)
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
    expect(client.snapshot().lastError).toContain('HTTP 401')
  })

  it('does not self-heal a failed health probe after stopDaemon begins', async () => {
    const registration = runtime()
    const healthStarted = deferred<void>()
    const healthResponse = deferred<Response>()
    let fetchCalls = 0
    let starts = 0
    let stops = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliStart: async () => {
          starts += 1
          return true
        },
        cliStop: async () => {
          stops += 1
          return true
        },
        fetch: async () => {
          fetchCalls += 1
          if (fetchCalls === 1) return jsonResponse(info(registration))
          healthStarted.resolve()
          return healthResponse.promise
        },
      }),
    )
    await client.start()

    const probing = (
      client as unknown as { _probeHealth: () => Promise<void> }
    )._probeHealth()
    await healthStarted.promise
    const stopping = client.stopDaemon()
    healthResponse.resolve(jsonResponse({ detail: 'old endpoint failed' }, 500))
    await Promise.all([probing, stopping])

    expect(starts).toBe(0)
    expect(stops).toBe(1)
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })

  it('recovers directly from /info 401 when runtime.json already has the new token', async () => {
    const first = runtime()
    const second = runtime({
      pid: 2002,
      startedAt: '2026-08-08T12:01:00',
      token: 'token-b',
    })
    let registration = first
    let rejectOldToken = false
    let statusCalls = 0
    let starts = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliStatus: async () => {
          statusCalls += 1
          return { status: StatusKind.Stopped, runtime_file: RUNTIME_PATH }
        },
        cliStart: async () => {
          starts += 1
          return true
        },
        fetch: async (_url, init) => {
          const authorization = new Headers(init?.headers).get('Authorization')
          if (rejectOldToken && authorization === 'Bearer token-a') {
            return jsonResponse({ detail: 'Unauthorized' }, 401)
          }
          return jsonResponse(info(authorization === 'Bearer token-b' ? second : first))
        },
      }),
    )
    await client.start()
    registration = second
    rejectOldToken = true

    await (
      client as unknown as { _probeHealth: () => Promise<void> }
    )._probeHealth()

    expect(statusCalls).toBe(0)
    expect(starts).toBe(0)
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-b')
  })

  it('stop invalidates an authentication probe before it can publish Ready', async () => {
    const registration = runtime()
    const fetchStarted = deferred<void>()
    const response = deferred<Response>()
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        fetch: async () => {
          fetchStarted.resolve()
          return response.promise
        },
      }),
    )
    const states: string[] = []
    client.onState((snapshot) => states.push(snapshot.state))

    const starting = client.start()
    await fetchStarted.promise
    client.stop()
    response.resolve(jsonResponse({ detail: 'Unauthorized' }, 401))
    await starting

    expect(client.snapshot().state).toBe(BackendState.Idle)
    expect(client.snapshot().endpoint).toBeNull()
    expect(client.snapshot().lastError).toBeNull()
    expect(states.at(-1)).toBe(BackendState.Idle)
    expect(states).not.toContain(BackendState.Ready)
  })

  it('does not settle an endpoint after stop wins the publish-to-settle microtask window', async () => {
    const registration = runtime()
    let reads = 0
    let client!: PythonClientInstance
    client = createClient(
      baseDependencies({
        readRuntimeFile: () => {
          reads += 1
          // The second read is the stability check immediately before publish.
          // Queue stop ahead of the caller continuation that settles Ready.
          if (reads === 2) queueMicrotask(() => client.stop())
          return registration
        },
        fetch: async () => jsonResponse(info(registration)),
      }),
    )

    await client.start()

    expect(client.snapshot().state).toBe(BackendState.Idle)
    expect(client.snapshot().endpoint).toBeNull()
  })

  it('waits for runtime replacement when a new daemon rejects the old token first', async () => {
    const first = runtime()
    const second = runtime({
      pid: 2002,
      startedAt: '2026-08-08T12:01:00',
      token: 'token-b',
    })
    let registration = first
    let rotating = false
    let refreshFetches = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        fetch: async (_url, init) => {
          const authorization = new Headers(init?.headers).get('Authorization')
          if (rotating) refreshFetches += 1
          if (rotating && authorization === 'Bearer token-a') {
            // The replacement starts accepting connections just before its
            // atomic runtime.json publication becomes visible.
            registration = second
            return jsonResponse({ detail: 'Unauthorized' }, 401)
          }
          return jsonResponse(info(authorization === 'Bearer token-b' ? second : first))
        },
      }),
    )
    await client.start()
    rotating = true

    await client.refresh()

    expect(refreshFetches).toBe(2)
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-b')
  })

  it('keeps discovery-only recovery alive when runtime replacement misses the first window', async () => {
    const first = runtime()
    const second = runtime({
      pid: 2002,
      startedAt: '2026-08-08T12:01:00',
      token: 'token-b',
    })
    let registration = first
    let rejectOld = false
    let starts = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliStart: async () => {
          starts += 1
          return true
        },
        fetch: async (_url, init) => {
          const authorization = new Headers(init?.headers).get('Authorization')
          if (rejectOld && authorization === 'Bearer token-a') {
            return jsonResponse({ detail: 'Unauthorized' }, 401)
          }
          return jsonResponse(info(authorization === 'Bearer token-b' ? second : first))
        },
      }),
    )
    await client.start()
    rejectOld = true

    await client.refresh()
    expect(client.snapshot().state).toBe(BackendState.Unavailable)

    const recovered = deferred<void>()
    const unsubscribe = client.onState((snapshot) => {
      if (snapshot.state === BackendState.Ready && snapshot.endpoint?.token === 'token-b') {
        recovered.resolve()
      }
    })
    registration = second
    let recoveryTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        recovered.promise,
        new Promise<never>((_resolve, reject) => {
          recoveryTimeout = setTimeout(
            () => reject(new Error('discovery recovery did not run')),
            1_500,
          )
        }),
      ])
    } finally {
      if (recoveryTimeout !== null) clearTimeout(recoveryTimeout)
    }
    unsubscribe()

    expect(starts).toBe(0)
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-b')
  })

  it('restart waits for and supersedes an older start before adopting the new daemon', async () => {
    const first = runtime()
    const second = runtime({
      pid: 2002,
      startedAt: '2026-08-08T12:01:00',
      token: 'token-b',
    })
    let registration = first
    let fetchCalls = 0
    let restarts = 0
    const firstFetchStarted = deferred<void>()
    const firstResponse = deferred<Response>()
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        cliRestart: async () => {
          restarts += 1
          return true
        },
        fetch: async (_url, init) => {
          fetchCalls += 1
          if (fetchCalls === 1) {
            firstFetchStarted.resolve()
            return firstResponse.promise
          }
          const authorization = new Headers(init?.headers).get('Authorization')
          expect(authorization).toBe('Bearer token-b')
          return jsonResponse(info(second))
        },
      }),
    )

    const initialStart = client.start()
    await firstFetchStarted.promise
    const restarting = client.restart()
    registration = second
    firstResponse.resolve(jsonResponse(info(first)))
    await Promise.all([initialStart, restarting])

    expect(restarts).toBe(1)
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-b')
  })
})

describe('PythonClient process-control serialization', () => {
  it('blocks a new start for the full duration of stopDaemon', async () => {
    const registration = runtime()
    const stopResult = deferred<boolean>()
    let starts = 0
    let fetches = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => registration,
        fetch: async () => {
          fetches += 1
          return jsonResponse(info(registration))
        },
        cliStart: async () => {
          starts += 1
          return true
        },
        cliStop: async () => stopResult.promise,
      }),
    )
    await client.start()

    const stopping = client.stopDaemon()
    await client.start()
    const duringStop = await client.refresh()
    expect(starts).toBe(0)
    expect(fetches).toBe(1)
    expect(duringStop.state).toBe(BackendState.Unhealthy)
    stopResult.resolve(true)
    await stopping

    expect(starts).toBe(0)
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })

  it('runs one final cliStop after an already-entered cliStart', async () => {
    const startEntered = deferred<void>()
    const startResult = deferred<boolean>()
    const events: string[] = []
    let stops = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => null,
        cliStart: async () => {
          events.push('start-entered')
          startEntered.resolve()
          const ok = await startResult.promise
          events.push('start-finished')
          return ok
        },
        cliStop: async () => {
          stops += 1
          events.push('stop')
          return true
        },
      }),
    )

    const starting = client.start()
    await startEntered.promise
    const stopping = client.stopDaemon()
    const duplicateStop = client.stopDaemon()
    expect(duplicateStop).toBe(stopping)
    expect(stops).toBe(0)

    startResult.resolve(true)
    await Promise.all([starting, stopping])

    expect(stops).toBe(1)
    expect(events).toEqual(['start-entered', 'start-finished', 'stop'])
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })

  it('queues an autostart write behind an already-entered cliStart', async () => {
    const startEntered = deferred<void>()
    const startResult = deferred<boolean>()
    const events: string[] = []
    let starts = 0
    let disables = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => null,
        cliStart: async () => {
          starts += 1
          events.push('start-entered')
          startEntered.resolve()
          const ok = await startResult.promise
          events.push('start-finished')
          return ok
        },
        cliAutostartDisable: async () => {
          disables += 1
          events.push('disable')
          return true
        },
      }),
    )

    const starting = client.start()
    await startEntered.promise
    const disabling = client.setAutostart(false)
    expect(disables).toBe(0)
    startResult.resolve(true)
    await Promise.all([starting, disabling])

    expect(starts).toBe(1)
    expect(disables).toBe(1)
    expect(events).toEqual(['start-entered', 'start-finished', 'disable'])
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })

  it('deduplicates concurrent restart requests', async () => {
    const restartResult = deferred<boolean>()
    let restarts = 0
    const client = createClient(
      baseDependencies({
        cliRestart: async () => {
          restarts += 1
          return restartResult.promise
        },
      }),
    )

    const first = client.restart()
    const second = client.restart()
    expect(second).toBe(first)
    restartResult.resolve(false)
    await Promise.all([first, second])

    expect(restarts).toBe(1)
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })

  it('preserves the last restart in a restart-stop-restart sandwich', async () => {
    const firstEntered = deferred<void>()
    const secondEntered = deferred<void>()
    const firstResult = deferred<boolean>()
    const secondResult = deferred<boolean>()
    const events: string[] = []
    let restarts = 0
    const client = createClient(
      baseDependencies({
        cliRestart: async () => {
          restarts += 1
          const call = restarts
          events.push(`restart-${call}`)
          const entered = call === 1 ? firstEntered : secondEntered
          entered.resolve()
          const ok = await (call === 1 ? firstResult.promise : secondResult.promise)
          events.push(`restart-${call}-done`)
          return ok
        },
        cliStop: async () => {
          events.push('stop')
          return true
        },
      }),
    )

    const first = client.restart()
    await firstEntered.promise
    const stopping = client.stopDaemon()
    const finalRestart = client.restart()
    expect(finalRestart).not.toBe(first)

    firstResult.resolve(false)
    await secondEntered.promise
    secondResult.resolve(false)
    await Promise.all([first, stopping, finalRestart])

    expect(restarts).toBe(2)
    expect(events).toEqual([
      'restart-1',
      'restart-1-done',
      'stop',
      'restart-2',
      'restart-2-done',
    ])
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })

  it('preserves the last stop in a stop-restart-stop sandwich', async () => {
    const firstEntered = deferred<void>()
    const secondEntered = deferred<void>()
    const firstResult = deferred<boolean>()
    const secondResult = deferred<boolean>()
    const events: string[] = []
    let stops = 0
    const client = createClient(
      baseDependencies({
        cliStop: async () => {
          stops += 1
          const call = stops
          events.push(`stop-${call}`)
          const entered = call === 1 ? firstEntered : secondEntered
          entered.resolve()
          const ok = await (call === 1 ? firstResult.promise : secondResult.promise)
          events.push(`stop-${call}-done`)
          return ok
        },
        cliRestart: async () => {
          events.push('restart')
          return false
        },
      }),
    )

    const first = client.stopDaemon()
    await firstEntered.promise
    const restarting = client.restart()
    const finalStop = client.stopDaemon()
    expect(finalStop).not.toBe(first)

    firstResult.resolve(true)
    await secondEntered.promise
    secondResult.resolve(true)
    await Promise.all([first, restarting, finalStop])

    expect(stops).toBe(2)
    expect(events).toEqual(['stop-1', 'stop-1-done', 'restart', 'stop-2', 'stop-2-done'])
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })

  it('preserves the last autostart change after another control intent', async () => {
    const firstEntered = deferred<void>()
    const secondEntered = deferred<void>()
    const firstResult = deferred<boolean>()
    const secondResult = deferred<boolean>()
    const events: string[] = []
    let disables = 0
    const client = createClient(
      baseDependencies({
        readRuntimeFile: () => null,
        cliAutostartDisable: async () => {
          disables += 1
          const call = disables
          events.push(`disable-${call}`)
          const entered = call === 1 ? firstEntered : secondEntered
          entered.resolve()
          const ok = await (call === 1 ? firstResult.promise : secondResult.promise)
          events.push(`disable-${call}-done`)
          return ok
        },
        cliRestart: async () => {
          events.push('restart')
          return false
        },
      }),
    )

    const first = client.setAutostart(false)
    await firstEntered.promise
    const restarting = client.restart()
    const finalDisable = client.setAutostart(false)
    expect(finalDisable).not.toBe(first)

    firstResult.resolve(true)
    await secondEntered.promise
    secondResult.resolve(true)
    await Promise.all([first, restarting, finalDisable])

    expect(disables).toBe(2)
    expect(events).toEqual([
      'disable-1',
      'disable-1-done',
      'restart',
      'disable-2',
      'disable-2-done',
    ])
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })
})

describe('PythonClient bounded adoption', () => {
  it('uses one approximately two-second deadline across all probe retries', async () => {
    const registration = runtime()
    let now = 0
    let fetchCalls = 0
    const client = createClient(
      baseDependencies({
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
        readRuntimeFile: () => registration,
        fetch: async () => {
          fetchCalls += 1
          now += Math.min(750, 2_000 - now)
          throw new Error('connection refused')
        },
      }),
    )

    await client.refresh()

    expect(now).toBe(2_000)
    expect(fetchCalls).toBe(3)
    expect(client.snapshot().state).toBe(BackendState.Unavailable)
  })

  it('retains a CLI-provided runtime path across failed refreshes', async () => {
    const customPath = 'D:\\custom\\gateway-runtime.json'
    const first = runtime()
    const second = runtime({ token: 'token-b' })
    let registration: RuntimeFile | null = first
    const paths: string[] = []
    const client = createClient(
      baseDependencies({
        readRuntimeFile: (filePath) => {
          paths.push(typeof filePath === 'string' ? filePath : '<default>')
          return filePath === customPath ? registration : null
        },
        cliStatus: async () => ({ ...runningStatus(first), runtime_file: customPath }),
        fetch: async (_url, init) => {
          const token = new Headers(init?.headers).get('Authorization')
          return jsonResponse(info(token === 'Bearer token-b' ? second : first))
        },
      }),
    )
    await client.start()

    registration = null
    paths.length = 0
    await client.refresh()
    expect(new Set(paths)).toEqual(new Set([customPath]))

    registration = second
    paths.length = 0
    await client.refresh()
    expect(new Set(paths)).toEqual(new Set([customPath]))
    expect(client.snapshot().state).toBe(BackendState.Ready)
    expect(client.snapshot().endpoint?.token).toBe('token-b')
  })

  it('does not cache a runtime path it never managed to read', async () => {
    // Counterpart to the test above: a path is worth remembering once it has
    // been read, never before. Reproduces the Windows failure where the CLI
    // handed over a path the client could not open (a cp936 stdout decoded as
    // UTF-8 mangled the user directory). Caching it turned one failed adoption
    // into a permanent one — every later discovery reused the bad path, so only
    // restarting the app recovered while the daemon had been serving all along.
    const unreadable = 'C:\\Users\\<mojibake>\\.bridgic\\AmphiAgent\\runtime.json'
    const registration = runtime()
    let published = false
    const client = createClient(
      baseDependencies({
        readRuntimeFile: (filePath) =>
          filePath === RUNTIME_PATH && published ? registration : null,
        cliStatus: async () => ({
          ...runningStatus(registration),
          runtime_file: unreadable,
        }),
        fetch: async () => jsonResponse(info(registration)),
      }),
    )

    await client.start()
    expect(client.snapshot().state).toBe(BackendState.Unavailable)

    // The daemon was serving the whole time and its registration is readable
    // at the path we resolve ourselves, so a refresh must recover without the
    // user restarting anything.
    published = true

    expect((await client.refresh()).state).toBe(BackendState.Ready)
  })
})
