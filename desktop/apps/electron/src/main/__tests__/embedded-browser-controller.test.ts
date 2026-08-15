import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { App } from 'electron'
import type { EmbeddedBrowserManager } from '../embedded-browser-manager'
import type { BackendEndpoint } from '../python-client/types'
import { electronModuleMock, loggerModuleMock } from './electron-module-mock'

mock.module('electron', () => electronModuleMock)
mock.module('../logger', () => loggerModuleMock)

const { EmbeddedBrowserController } = await import('../embedded-browser-controller')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function endpoint(): BackendEndpoint {
  return {
    baseUrl: 'http://127.0.0.1:43110',
    token: 'daemon-token',
    version: null,
    startedAt: null,
    wsPath: null,
    runtimeFile: null,
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
