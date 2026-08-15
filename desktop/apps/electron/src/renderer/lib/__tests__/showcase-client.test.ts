import { afterEach, describe, expect, test } from 'bun:test'

import {
  ShowcaseHttpError,
  fetchShowcaseWorkflows,
  showcaseAssetUrls,
  showcasePageUrl,
} from '../showcaseClient'

const BASE = 'https://showcase.bridgic.ai'
const JSON_MIRROR = 'https://cdn.jsdelivr.net/gh/bitsky-tech/showcase@main/docs/public'
const ASSET_MIRROR = 'https://gcore.jsdelivr.net/gh/bitsky-tech/showcase@main/docs/public'

const INDEX = {
  endpoints: { workflows: { zh: 'api/workflows.zh.json', en: 'api/workflows.en.json' } },
}

const MANIFEST = {
  lang: 'zh',
  workflows: [
    {
      id: 'xiaohongshu',
      name: '小红书内容爬虫',
      desc: '自动抓取指定话题的笔记与互动数据',
      domain: '浏览器自动化',
      status: 'verified',
      path: 'zh/workflows/xiaohongshu',
      // Dropped from the schema, kept here on purpose: showcase still publishes
      // these three until its own cleanup lands, so this is the payload a shipped
      // build actually meets, and passthrough has to carry it without complaint.
      goal: 'goal',
      requirement: 'requirement',
      output: 'output',
    },
    // Carries an unknown key and an unfamiliar status, which a shipped build must
    // tolerate rather than reject.
    {
      id: 'mailReply',
      name: '邮件自动回复',
      desc: '按规则分类并回复常见邮件',
      domain: '邮件集成',
      status: 'beta',
      path: 'zh/workflows/mail-reply',
      goal: 'goal',
      requirement: 'requirement',
      output: 'output',
      cover: 'static/mail.png',
    },
  ],
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('showcaseAssetUrls / showcasePageUrl', () => {
  test('resolve against the primary origin and the asset mirror', () => {
    expect(showcaseAssetUrls('static/logo.png')).toEqual({
      url: `${BASE}/static/logo.png`,
      mirror: `${ASSET_MIRROR}/static/logo.png`,
    })
    // A leading slash must not produce a double slash.
    expect(showcaseAssetUrls('/static/logo.png').url).toBe(`${BASE}/static/logo.png`)
    expect(showcasePageUrl('zh/workflows/xiaohongshu')).toBe(`${BASE}/zh/workflows/xiaohongshu`)
  })

  test('embed mode adds the chrome-less and theme parameters', () => {
    expect(showcasePageUrl('zh/workflows/xiaohongshu', { theme: 'dark' })).toBe(
      `${BASE}/zh/workflows/xiaohongshu?bridgic-embed=1&bridgic-theme=dark`,
    )
    expect(showcasePageUrl('en/workflows/mail-reply', { theme: 'light' })).toBe(
      `${BASE}/en/workflows/mail-reply?bridgic-embed=1&bridgic-theme=light`,
    )
  })

  test('a hostile path cannot escape the showcase origin', () => {
    // The payload is fetched over https from a repo we control, but the value still
    // reaches shell.openExternal without a confirmation dialog, so the origin has to
    // be guaranteed here rather than assumed upstream.
    expect(showcasePageUrl('//evil.com/phish')).toBe(`${BASE}/evil.com/phish`)
  })
})

describe('fetchShowcaseWorkflows', () => {
  test('discovers the language path from the index and returns the list', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      calls.push(u)
      return json(u.endsWith('index.json') ? INDEX : MANIFEST)
    }) as typeof fetch

    const workflows = await fetchShowcaseWorkflows('zh')

    expect(calls).toEqual([`${BASE}/api/index.json`, `${BASE}/api/workflows.zh.json`])
    expect(workflows).toHaveLength(2)
    expect(workflows[0]?.id).toBe('xiaohongshu')
  })

  test('tolerates unknown fields and unfamiliar status values', async () => {
    globalThis.fetch = (async (url: string | URL) =>
      json(String(url).endsWith('index.json') ? INDEX : MANIFEST)) as typeof fetch

    const workflows = await fetchShowcaseWorkflows('zh')

    // Forward compatibility: the publisher can add fields or statuses without
    // breaking an already-shipped build.
    expect(workflows[1]?.status).toBe('beta')
    // `as unknown as` because ShowcaseWorkflow deliberately declares no index
    // signature; the field is present at runtime thanks to schema passthrough.
    expect((workflows[1] as unknown as Record<string, unknown>).cover).toBe('static/mail.png')
  })

  test('falls back to the JSON mirror, and the mirror path keeps the docs/public prefix', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      calls.push(u)
      if (u.startsWith(BASE)) throw new DOMException('timed out', 'TimeoutError')
      return json(u.endsWith('index.json') ? INDEX : MANIFEST)
    }) as typeof fetch

    const workflows = await fetchShowcaseWorkflows('zh')

    expect(workflows).toHaveLength(2)
    // Without the docs/public segment the mirror 404s -- and only when the primary
    // origin is already down, so this assertion guards the hardest-to-notice bug.
    expect(calls).toEqual([
      `${BASE}/api/index.json`,
      `${JSON_MIRROR}/api/index.json`,
      `${BASE}/api/workflows.zh.json`,
      `${JSON_MIRROR}/api/workflows.zh.json`,
    ])
  })

  test('revalidates instead of trusting the HTTP cache', async () => {
    const inits: RequestInit[] = []
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      inits.push(init ?? {})
      return json(String(url).endsWith('index.json') ? INDEX : MANIFEST)
    }) as typeof fetch

    await fetchShowcaseWorkflows('zh')

    // The mirror advertises max-age=604800; without no-cache one fallback response
    // would be reused locally for a week.
    expect(inits.every((i) => i.cache === 'no-cache')).toBe(true)
  })

  test('surfaces an HTML 404 as a status-carrying error, not a parse error', async () => {
    globalThis.fetch = (async (_url: string | URL) =>
      new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } })) as typeof fetch

    await expect(fetchShowcaseWorkflows('zh')).rejects.toThrow(ShowcaseHttpError)
  })

  test('rejects a malformed manifest at the schema boundary', async () => {
    globalThis.fetch = (async (url: string | URL) =>
      json(
        String(url).endsWith('index.json') ? INDEX : { lang: 'zh', workflows: [{ id: 'x', name: 'x' }] },
      )) as typeof fetch

    await expect(fetchShowcaseWorkflows('zh')).rejects.toThrow()
  })

  test('throws when the index has no endpoint for the requested language', async () => {
    globalThis.fetch = (async (_url: string | URL) =>
      json({ endpoints: { workflows: { zh: 'api/workflows.zh.json' } } })) as typeof fetch

    await expect(fetchShowcaseWorkflows('en')).rejects.toThrow(/no workflows endpoint for 'en'/)
  })
})
