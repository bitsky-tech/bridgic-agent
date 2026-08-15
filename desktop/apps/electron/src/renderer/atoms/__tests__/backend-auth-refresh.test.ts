import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'
import { backendSnapshotAtom, buildAmphiClient } from '../backend'
import { BackendState } from '../../../main/python-client/types'

const globals = globalThis as unknown as Record<string, unknown>
const originalFetch = globalThis.fetch
const originalWindow = globals['window']

function readySnapshot(token: string, endpointEpoch: number) {
  return {
    state: BackendState.Ready,
    endpoint: {
      baseUrl: 'http://127.0.0.1:7421',
      token,
      version: '0.1.0',
      startedAt: '2026-08-08T12:00:00',
      wsPath: '/ws',
      runtimeFile: 'C:\\test\\runtime.json',
      clientId: 'gui-test',
    },
    endpointEpoch,
    lastError: null,
    compatibility: null,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) delete globals['window']
  else globals['window'] = originalWindow
})

describe('buildAmphiClient auth recovery', () => {
  it('coalesces a burst of 401s but immediately refreshes a newly published token', async () => {
    const refresh = mock(async () => readySnapshot('new-token', 2))
    globals['window'] = { api: { backend: { refresh } } }
    const requests = mock(async () => new Response(
      JSON.stringify({ detail: 'Unauthorized' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ))
    globalThis.fetch = requests as unknown as typeof fetch
    const store = createStore()
    store.set(backendSnapshotAtom, readySnapshot('old-token', 1) as never)
    const oldClient = buildAmphiClient(store.get)
    expect(oldClient).not.toBeNull()

    await Promise.allSettled([
      oldClient!.getGatewayInfo(),
      oldClient!.getGatewayClients(),
    ])

    expect(requests).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenLastCalledWith(1)

    store.set(backendSnapshotAtom, readySnapshot('new-token', 2) as never)
    await buildAmphiClient(store.get)!.getGatewayInfo().catch(() => undefined)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenLastCalledWith(2)
  })
})
