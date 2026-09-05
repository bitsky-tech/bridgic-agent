import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { App } from 'electron'
import type { EmbeddedBrowserManager } from '../embedded-browser-manager'
import type { BackendEndpoint } from '../python-client/types'
import { electronModuleMock, loggerModuleMock } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { EmbeddedBrowserController } = await import('../embedded-browser-controller')
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
})

function endpoint(): BackendEndpoint {
  return {
    baseUrl: 'http://127.0.0.1:43110',
    token: 'daemon-token',
    version: null,
    startedAt: null,
    wsPath: null,
    runtimeFile: null,
    logFile: null,
    clientId: 'desktop-client',
  }
}

function controller(): InstanceType<typeof EmbeddedBrowserController> {
  const value = new EmbeddedBrowserController(
    {} as EmbeddedBrowserManager,
    'http://127.0.0.1:43112',
  )
  ;(value as unknown as { controlUrl: string }).controlUrl = 'http://127.0.0.1:43111'
  return value
}

describe('embedded browser controller registration lifecycle', () => {
  it('configures Electron remote debugging before App readiness', () => {
    const switches = new Map<string, string>()
    const app = {
      isReady: () => false,
      commandLine: {
        getSwitchValue: (name: string) => switches.get(name) ?? '',
        appendSwitch: (name: string, value: string) => switches.set(name, value),
      },
    } as unknown as App

    const endpoint = EmbeddedBrowserController.configureRemoteDebugging(app)

    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(switches.get('remote-debugging-address')).toBe('127.0.0.1')
    expect(switches.get('remote-debugging-port')).toBe(endpoint.split(':').at(-1))
  })

  it('waits for an in-flight registration before unregistering during stop', async () => {
    let releasePut: (() => void) | undefined
    let markPutStarted: (() => void) | undefined
    const putStarted = new Promise<void>((resolve) => { markPutStarted = resolve })
    const putReleased = new Promise<void>((resolve) => { releasePut = resolve })
    const methods: string[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') {
        markPutStarted?.()
        await putReleased
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const value = controller()
    const registration = value.registerWithDaemon(endpoint())
    await putStarted
    const stopping = value.stop()
    await Promise.resolve()

    expect(methods).toEqual(['PUT'])
    releasePut?.()
    await Promise.all([registration, stopping])
    expect(methods).toEqual(['PUT', 'DELETE'])
  })

  it('coalesces concurrent registration for the same daemon', async () => {
    const methods: string[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      await Promise.resolve()
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const value = controller()
    await Promise.all([
      value.registerWithDaemon(endpoint()),
      value.registerWithDaemon(endpoint()),
    ])

    expect(methods).toEqual(['PUT'])
    await value.stop()
  })
})


/** Run the real scheduled callback without waiting ten seconds in each test. */
function refreshClock(value: InstanceType<typeof EmbeddedBrowserController>): () => Promise<void> {
  let callback: (() => void) | undefined
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    const timer = originalSetTimeout(fn, delay)
    if (delay === 10_000) {
      clearTimeout(timer)
      callback = fn
    }
    return timer
  }) as typeof setTimeout
  return async () => {
    expect(callback).toBeDefined()
    const tick = callback
    callback = undefined
    tick?.()
    await (value as unknown as { refreshInflight: Promise<void> | null }).refreshInflight
  }
}

describe('embedded browser automatic recovery', () => {
  it('retries a failed initial registration without a backend state change', async () => {
    const value = controller()
    const advance = refreshClock(value)
    const methods: string[] = []
    let fail = true
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT' && fail) {
        fail = false
        throw new Error('temporary failure')
      }
      return Response.json({ available: false })
    }) as unknown as typeof fetch
    try {
      await expect(value.registerWithDaemon(endpoint())).rejects.toThrow('temporary failure')
      await advance()
      expect(methods).toEqual(['PUT', 'GET', 'PUT'])
    } finally {
      await value.stop()
    }
  })

  it('repairs lost registration even when the daemon URL and token are unchanged', async () => {
    const value = controller()
    const advance = refreshClock(value)
    const methods: string[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return Response.json({ available: false })
    }) as unknown as typeof fetch
    try {
      await value.registerWithDaemon(endpoint())
      await advance()
      expect(methods).toEqual(['PUT', 'GET', 'PUT'])
    } finally {
      await value.stop()
    }
  })

  it('keeps healthy registrations and does not take ownership back from another desktop', async () => {
    const value = controller()
    const advance = refreshClock(value)
    const methods: string[] = []
    let status: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') {
        const registration = JSON.parse(String(init?.body))
        status = { available: true, controller_id: registration.controller_id, generation: registration.generation }
      }
      return Response.json(status)
    }) as unknown as typeof fetch
    try {
      await value.registerWithDaemon(endpoint())
      await advance()
      status = { available: true, controller_id: 'other-desktop', generation: 'other-generation' }
      await advance()
      expect(methods).toEqual(['PUT', 'GET', 'GET'])
    } finally {
      await value.stop()
    }
  })

  it('does not re-register when quit happens during a status request', async () => {
    const value = controller()
    const advance = refreshClock(value)
    const methods: string[] = []
    let releaseGet: (() => void) | undefined
    let markGet: (() => void) | undefined
    const getStarted = new Promise<void>((resolve) => { markGet = resolve })
    const getReleased = new Promise<void>((resolve) => { releaseGet = resolve })
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'GET') {
        markGet?.()
        await getReleased
      }
      return Response.json({ available: false })
    }) as unknown as typeof fetch
    await value.registerWithDaemon(endpoint())
    const refresh = advance()
    await getStarted
    const stopping = value.stop()
    releaseGet?.()
    await Promise.all([refresh, stopping])
    expect(methods).toEqual(['PUT', 'GET', 'DELETE'])
  })

  it('registers a replacement daemon even if the old in-flight registration fails', async () => {
    const value = controller()
    refreshClock(value)
    let releasePut: (() => void) | undefined
    const released = new Promise<void>((resolve) => { releasePut = resolve })
    const tokens: string[] = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const token = (init.headers as Record<string, string>).Authorization
        tokens.push(token ?? "")
        if (tokens.length === 1) {
          await released
          throw new Error('old daemon disappeared')
        }
      }
      return Response.json({ available: false })
    }) as unknown as typeof fetch
    try {
      const first = value.registerWithDaemon(endpoint()).catch(() => {})
      const second = value.registerWithDaemon({ ...endpoint(), token: 'replacement-token' })
      releasePut?.()
      await Promise.all([first, second])
      expect(tokens).toEqual(['Bearer daemon-token', 'Bearer replacement-token'])
    } finally {
      await value.stop()
    }
  })
})

it('continues checking after a failed status request', async () => {
  const value = controller()
  const advance = refreshClock(value)
  const methods: string[] = []
  let failStatus = true
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    methods.push(method)
    if (method === 'GET' && failStatus) {
      failStatus = false
      return new Response(null, { status: 503 })
    }
    return Response.json({ available: false })
  }) as unknown as typeof fetch
  try {
    await value.registerWithDaemon(endpoint())
    await advance()
    expect(methods).toEqual(['PUT', 'GET'])
    await advance()
    expect(methods).toEqual(['PUT', 'GET', 'GET', 'PUT'])
  } finally {
    await value.stop()
  }
})

it('ignores a stale status result when the backend is suspended', async () => {
  const value = controller()
  const advance = refreshClock(value)
  const methods: string[] = []
  let releaseGet: (() => void) | undefined
  let markGet: (() => void) | undefined
  const started = new Promise<void>((resolve) => { markGet = resolve })
  const released = new Promise<void>((resolve) => { releaseGet = resolve })
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    methods.push(method)
    if (method === 'GET') {
      markGet?.()
      await released
    }
    return Response.json({ available: false })
  }) as unknown as typeof fetch
  try {
    await value.registerWithDaemon(endpoint())
    const refresh = advance()
    await started
    value.suspendRegistration()
    releaseGet?.()
    await refresh
    expect(methods).toEqual(['PUT', 'GET'])
    await value.registerWithDaemon({ ...endpoint(), token: 'new-token' })
    await advance()
    expect(methods).toEqual(['PUT', 'GET', 'PUT', 'GET', 'PUT'])
  } finally {
    await value.stop()
  }
})
