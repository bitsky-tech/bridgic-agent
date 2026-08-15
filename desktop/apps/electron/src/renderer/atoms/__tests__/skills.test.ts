/**
 * Tests for atoms/skills.ts — hydrate + toggle + delete against a mocked daemon.
 *
 * Mirrors the sessions.test harness: a fresh `createStore`, a seeded
 * `backendSnapshotAtom` endpoint so `buildAmphiClient` resolves, and a mocked
 * `globalThis.fetch` standing in for the daemon.
 */
import { describe, it, expect, mock } from 'bun:test'
import { createStore } from 'jotai'

import {
  skillsAtom,
  skillsHydrationStateAtom,
  hydrateSkillsAtom,
  toggleSkillAtom,
  deleteSkillAtom,
} from '../skills'
import { backendSnapshotAtom } from '../backend'
import { BackendState } from '../../../main/python-client/types'
import type { SkillDetail } from '../../lib/amphiClient'

function skill(over: Partial<SkillDetail> = {}): SkillDetail {
  return {
    skill_id: 1,
    name: 'web-scraper',
    description: '通用网页抓取',
    skill_dir: '/skills/web-scraper',
    group: 'imported',
    source: 'github',
    source_uri: 'https://github.com/x/web-scraper',
    enabled: true,
    updated_at: '2026-06-20T00:00:00',
    ...over,
  }
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

describe('hydrateSkillsAtom', () => {
  it('replaces the list with the fetched skills and reaches ready', async () => {
    const store = createStore()
    withDaemon(
      store,
      mock(async () =>
        jsonResponse([skill({ skill_id: 1 }), skill({ skill_id: 2, name: 'feishu-bot' })]),
      ) as never,
    )
    await store.set(hydrateSkillsAtom)
    expect(store.get(skillsAtom).map((s) => s.skill_id)).toEqual([1, 2])
    expect(store.get(skillsHydrationStateAtom)).toBe('ready')
  })

  it('goes to error state when no backend endpoint is configured', async () => {
    const store = createStore()
    // Default snapshot has endpoint=null → buildAmphiClient returns null (no fetch).
    await store.set(hydrateSkillsAtom)
    expect(store.get(skillsHydrationStateAtom)).toBe('error')
  })
})

describe('toggleSkillAtom', () => {
  it('patches the toggled row with the server-returned skill', async () => {
    const store = createStore()
    withDaemon(
      store,
      mock(async (url: string) => {
        if (url.endsWith('/skills')) return jsonResponse([skill({ skill_id: 1, enabled: true })])
        // `/skill/1/toggle` returns the updated row.
        return jsonResponse(skill({ skill_id: 1, enabled: false }))
      }) as never,
    )
    await store.set(hydrateSkillsAtom)
    await store.set(toggleSkillAtom, { skillId: 1, enabled: false })
    expect(store.get(skillsAtom).find((s) => s.skill_id === 1)?.enabled).toBe(false)
  })
})

describe('deleteSkillAtom', () => {
  it('refreshes the list after delete so the removed row is gone', async () => {
    const store = createStore()
    let deleted = false
    withDaemon(
      store,
      mock(async (url: string, init?: { method?: string }) => {
        void url
        if (init?.method === 'DELETE') {
          deleted = true
          return new Response(null, { status: 204 })
        }
        return jsonResponse(deleted ? [] : [skill({ skill_id: 1 })])
      }) as never,
    )
    await store.set(hydrateSkillsAtom)
    expect(store.get(skillsAtom)).toHaveLength(1)
    await store.set(deleteSkillAtom, 1)
    expect(store.get(skillsAtom)).toHaveLength(0)
  })
})
