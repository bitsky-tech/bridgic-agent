/**
 * Tests for `fetchProviderModelsAtom` (atoms/models.ts) — the "Fetch from provider"
 * data path, against a mocked daemon.
 *
 * Mirrors the skills.test harness: a fresh `createStore`, a seeded
 * `backendSnapshotAtom` endpoint so `buildAmphiClient` resolves, and a mocked
 * `globalThis.fetch` standing in for the daemon.
 *
 * The invariant under test: this atom NEVER throws. The form renders its
 * result inline next to the button, so a daemon-side 500 or a dead socket has
 * to arrive as `{ok: false, error}` — an exception would take the whole
 * settings modal down mid-edit.
 */
import { describe, it, expect, mock } from 'bun:test'
import { createStore } from 'jotai'

import { fetchProviderApiKeyAtom, fetchProviderModelsAtom } from '../models'
import { backendSnapshotAtom } from '../backend'
import { BackendState } from '../../../main/python-client/types'
import { i18n } from '../../lib/i18n'

const INPUT = {
  providerId: 'openai',
  protocol: 'openai' as const,
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
}

function withDaemon(store: ReturnType<typeof createStore>, fetchImpl: typeof fetch): void {
  store.set(backendSnapshotAtom, {
    state: BackendState.Ready,
    endpoint: {
      baseUrl: 'http://127.0.0.1:7421',
      token: 'test-token',
      version: null,
      startedAt: null,
      wsPath: null,
    },
    lastError: null,
  } as never)
  globalThis.fetch = fetchImpl as never
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchProviderModelsAtom', () => {
  it('passes the envelope through untouched on success', async () => {
    const store = createStore()
    withDaemon(
      store,
      mock(async () =>
        jsonResponse({
          ok: true,
          models: [{
            id: 'gpt-4o',
            name: 'GPT-4o',
            limits: { context: 128_000, output: 16_384 },
            limits_source: 'provider',
          }],
        }),
      ) as never,
    )
    const result = await store.set(fetchProviderModelsAtom, INPUT)
    expect(result).toEqual({
      ok: true,
      models: [{
        id: 'gpt-4o',
        name: 'GPT-4o',
        limits: { context: 128_000, output: 16_384 },
        limits_source: 'provider',
      }],
    })
  })

  it('posts to /me/providers/fetch-models WITHOUT a model field', async () => {
    // The endpoint's `extra='forbid'` schema 422s on a stray `model`, and
    // Requiring no model breaks the Test Connection chicken-and-egg problem.
    const store = createStore()
    const spy = mock(async () => jsonResponse({ ok: true, models: [{ id: 'a', name: 'a' }] }))
    withDaemon(store, spy as never)
    await store.set(fetchProviderModelsAtom, INPUT)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/me/providers/fetch-models')
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      provider_id: 'openai',
      protocol: 'openai',
      api_key: 'sk-test',
      base_url: 'https://api.openai.com/v1',
    })
    expect('model' in body).toBe(false)
  })

  it('surfaces the provider error verbatim instead of throwing', async () => {
    const store = createStore()
    withDaemon(
      store,
      mock(async () => jsonResponse({ ok: false, error: 'API Key 校验失败（401）' })) as never,
    )
    const result = await store.set(fetchProviderModelsAtom, INPUT)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('API Key 校验失败（401）')
  })

  it('degrades a daemon-side throw into ok:false rather than propagating', async () => {
    const store = createStore()
    withDaemon(
      store,
      mock(async () => {
        throw new Error('socket hang up')
      }) as never,
    )
    const result = await store.set(fetchProviderModelsAtom, INPUT)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('socket hang up')
  })

  it('reports the localized backend-not-ready error when no daemon is configured', async () => {
    const store = createStore()
    // Default snapshot has endpoint=null → buildAmphiClient returns null.
    const result = await store.set(fetchProviderModelsAtom, INPUT)
    expect(result).toEqual({ ok: false, error: i18n.t('error.backendNotReady') })
  })
})

describe('fetchProviderModelsAtom — 订阅(Codex)渠道', () => {
  it('posts protocol=openai-codex with an empty api_key', async () => {
    // Subscription channels have no key to enter. The backend returns a static catalog for
    // this protocol, so an empty api_key must pass through unchanged instead of being blocked.
    const store = createStore()
    const spy = mock(async () =>
      jsonResponse({ ok: true, models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] }),
    )
    withDaemon(store, spy as never)
    const result = await store.set(fetchProviderModelsAtom, {
      providerId: 'openai',
      protocol: 'openai-codex' as const,
      apiKey: '',
    })
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      provider_id: 'openai',
      protocol: 'openai-codex',
      api_key: '',
      base_url: undefined,
    })
    expect(result.ok).toBe(true)
  })
})

describe('fetchProviderApiKeyAtom', () => {
  it('returns the stored key so the edit form can prefill it', async () => {
    const store = createStore()
    withDaemon(store, mock(async () => jsonResponse({ api_key: 'sk-stored' })) as never)
    expect(await store.set(fetchProviderApiKeyAtom, 'openai')).toBe('sk-stored')
  })

  it('degrades to empty string instead of throwing', async () => {
    // A failure here must never block opening the editor — the form just
    // starts from an empty field, exactly as it did before prefill existed.
    // null covers OAuth/Codex channels, which legitimately have no key.
    const store = createStore()
    withDaemon(store, mock(async () => jsonResponse({ api_key: null })) as never)
    expect(await store.set(fetchProviderApiKeyAtom, 'codex')).toBe('')

    const boom = createStore()
    withDaemon(boom, mock(async () => { throw new Error('daemon down') }) as never)
    expect(await boom.set(fetchProviderApiKeyAtom, 'openai')).toBe('')

    // No daemon configured at all.
    expect(await createStore().set(fetchProviderApiKeyAtom, 'openai')).toBe('')
  })
})
