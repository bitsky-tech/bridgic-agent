/**
 * Tests for atoms/cloud.ts — signing in wires the cloud token into a local
 * provider channel.
 *
 * Mirrors the models-fetch harness: a fresh `createStore`, a seeded
 * `backendSnapshotAtom` so `buildAmphiClient` resolves, and one mocked
 * `globalThis.fetch` standing in for BOTH the gateway and the daemon. Nothing
 * is stubbed at the atom layer, so the real `addProviderAtom` runs and the
 * assertion is on the credential request the daemon actually receives.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'

import { BackendState } from '../../../main/python-client/types'
import { backendSnapshotAtom } from '../backend'
import {
  CLOUD_PROVIDER_ID,
  cloudAccountAtom,
  cloudErrorAtom,
  cloudRefreshAtom,
  cloudSignInAtom,
  cloudSignedInAtom,
} from '../cloud'

const DAEMON = 'http://127.0.0.1:7421'
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Recorded {
  url: string
  body: unknown
}

/**
 * Answer the gateway and the daemon from one mock, recording what was sent.
 *
 * `gatewayOverrides` lets a test make one gateway route fail while the rest of
 * the world keeps working.
 */
function harness(
  store: ReturnType<typeof createStore>,
  gatewayOverrides: Record<string, Response> = {},
): Recorded[] {
  store.set(backendSnapshotAtom, {
    state: BackendState.Ready,
    endpoint: {
      baseUrl: DAEMON,
      token: 'test-token',
      version: null,
      startedAt: null,
      wsPath: null,
    },
    lastError: null,
  } as never)

  const recorded: Recorded[] = []

  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const raw = init?.body
    recorded.push({ url, body: typeof raw === 'string' ? JSON.parse(raw) : null })

    for (const [path, response] of Object.entries(gatewayOverrides)) {
      if (url.endsWith(path)) return response.clone()
    }

    if (url.endsWith('/auth/login')) {
      return jsonResponse({ access_token: 'tok-abc', account_id: 7, credits_balance: 50_000 })
    }
    if (url.includes('8787') && url.endsWith('/me')) {
      return jsonResponse({
        account_id: 7,
        email: 'a@b.com',
        credits_balance: 50_000,
        credits_per_yuan: 1000,
      })
    }
    if (url.includes('8787') && url.endsWith('/me/models')) {
      return jsonResponse([
        {
          model_id: 'deepseek-v4-flash',
          display_name: 'DeepSeek V4 Flash',
          context_window: 128_000,
          filing_number: 'FILING-1',
        },
        // A model whose window is unknown must not produce a bogus zero limit.
        {
          model_id: 'no-window-model',
          display_name: 'Unknown Window',
          context_window: 0,
          filing_number: null,
        },
      ])
    }

    // Daemon: the credential write, then the hydrate that follows it.
    if (url.startsWith(DAEMON)) {
      if (url.endsWith('/providers')) return jsonResponse([])
      if (url.endsWith('/me/providers')) return jsonResponse([])
      if (url.endsWith('/me')) return jsonResponse({ current_model: 'deepseek-v4-flash' })
      return jsonResponse({})
    }
    return jsonResponse({ detail: 'Not Found' }, 404)
  }) as never

  return recorded
}

describe('cloud sign-in', () => {
  it('stores the cloud token as a provider channel and records the balance', async () => {
    const store = createStore()
    const recorded = harness(store)

    await store.set(cloudSignInAtom, { email: 'a@b.com', password: 'secret-pass' })

    const credentialWrite = recorded.find(
      (r) => r.url === `${DAEMON}/me/providers` && r.body !== null,
    )
    expect(credentialWrite?.body).toMatchObject({
      provider_id: CLOUD_PROVIDER_ID,
      auth_mode: 'api_key',
      api_key: 'tok-abc',
      base_url: 'http://127.0.0.1:8787/v1',
      protocol: 'openai',
      models: ['deepseek-v4-flash', 'no-window-model'],
      // Only the model that reported a window gets a limit; a zero would render
      // as "0 tokens of context" in the occupancy pill.
      model_limits: { 'deepseek-v4-flash': { input: 128_000 } },
    })

    expect(store.get(cloudAccountAtom)).toEqual({
      accountId: 7,
      email: 'a@b.com',
      creditsBalance: 50_000,
      // Read back from the gateway rather than assumed: the balance is
      // unreadable without it, and a hard-coded guess goes wrong silently.
      creditsPerYuan: 1000,
    })
    expect(store.get(cloudSignedInAtom)).toBe(true)
  })

  it('surfaces the gateway reason and stays signed out on bad credentials', async () => {
    const store = createStore()
    const recorded = harness(store, {
      '/auth/login': jsonResponse({ detail: 'Invalid email or password' }, 401),
    })

    await expect(
      store.set(cloudSignInAtom, { email: 'a@b.com', password: 'wrong' }),
    ).rejects.toThrow('Invalid email or password')

    expect(store.get(cloudErrorAtom)).toBe('Invalid email or password')
    expect(store.get(cloudSignedInAtom)).toBe(false)
    // A rejected sign-in must not leave a half-written credential behind.
    expect(recorded.some((r) => r.url === `${DAEMON}/me/providers` && r.body !== null)).toBe(false)
  })
})

describe('cloud refresh', () => {
  it('re-reads the model list, so a withdrawn model stops being offered', async () => {
    const store = createStore()
    harness(store)
    await store.set(cloudSignInAtom, { email: 'a@b.com', password: 'secret-pass' })

    // The operator withdraws one model and puts another on sale. Nothing on
    // this machine changed, and the local list is now a lie in both
    // directions: it offers a model that 404s and hides one that works.
    const recorded = harness(store, {
      '/me/models': jsonResponse([
        {
          model_id: 'agnes-2.5-flash',
          display_name: 'Agnes 2.5 Flash',
          context_window: 512_000,
          filing_number: null,
        },
      ]),
    })
    await store.set(cloudRefreshAtom)

    const write = recorded.find((r) => r.url === `${DAEMON}/me/providers` && r.body !== null)
    expect(write?.body).toMatchObject({
      provider_id: CLOUD_PROVIDER_ID,
      models: ['agnes-2.5-flash'],
      model_limits: { 'agnes-2.5-flash': { input: 512_000 } },
    })
    // The token is not re-sent. The upsert keeps the stored one when the field
    // is absent, and a refresh has no reason to move a secret around.
    expect((write?.body as { api_key?: string }).api_key).toBeUndefined()
  })

  it('drops the stored credential when the gateway rejects the token', async () => {
    const store = createStore()
    harness(store)
    await store.set(cloudSignInAtom, { email: 'a@b.com', password: 'secret-pass' })

    // `8787/me` and not `/me`: the daemon has a `/me` of its own, and the
    // harness matches an override against every request.
    const recorded = harness(store, {
      '8787/me': jsonResponse({ detail: 'Invalid or expired credentials' }, 401),
    })
    await store.set(cloudRefreshAtom)

    expect(store.get(cloudSignedInAtom)).toBe(false)
    // Clearing the session in memory is not enough: the credential IS the
    // token, so leaving the row behind keeps a dead channel in the model
    // picker, and its stale model list with it.
    expect(
      recorded.some((r) => r.url === `${DAEMON}/me/providers/${CLOUD_PROVIDER_ID}`),
    ).toBe(true)
  })
})
