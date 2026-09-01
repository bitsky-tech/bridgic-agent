/**
 * Tests for the loopback host that serves the embedded workbench pages. The
 * path resolver is the security-relevant part: it is the only thing standing
 * between a request URL and the filesystem.
 */
import { describe, expect, test } from 'bun:test'
import { contentTypeFor, resolveAssetPath, UniverHost } from '../univer-host'

const ROOT = '/app/renderer'
const PREFIX = 'abc123'

describe('resolveAssetPath', () => {
  test('resolves a page and its assets under the prefix', () => {
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/univer/sheet/index.html`))
      .toBe('/app/renderer/univer/sheet/index.html')
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/univer/doc/index.html`))
      .toBe('/app/renderer/univer/doc/index.html')
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/assets/univer-a1b2.js?v=1`))
      .toBe('/app/renderer/assets/univer-a1b2.js')
  })

  test('decodes percent-encoded paths', () => {
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/assets/a%20b.css`))
      .toBe('/app/renderer/assets/a b.css')
  })

  test('refuses a request that does not carry the prefix', () => {
    expect(resolveAssetPath(ROOT, PREFIX, '/univer/sheet/index.html')).toBeNull()
    expect(resolveAssetPath(ROOT, PREFIX, '/other/univer/sheet/index.html')).toBeNull()
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}`)).toBeNull()
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/`)).toBeNull()
  })

  test('refuses traversal out of the served root', () => {
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/../../etc/passwd`)).toBeNull()
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/univer/../../../secret`)).toBeNull()
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/%2e%2e/%2e%2e/secret`)).toBeNull()
  })

  test('refuses a sibling directory that merely shares the root prefix', () => {
    expect(resolveAssetPath('/app/renderer', PREFIX, `/${PREFIX}/../renderer-private/key`))
      .toBeNull()
  })

  test('keeps traversal that stays inside the root', () => {
    expect(resolveAssetPath(ROOT, PREFIX, `/${PREFIX}/univer/../assets/main.js`))
      .toBe('/app/renderer/assets/main.js')
  })
})

describe('contentTypeFor', () => {
  test('maps the types the built page actually serves', () => {
    expect(contentTypeFor('/a/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/a/univer.JS')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/a/univer.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/a/icons.woff2')).toBe('font/woff2')
  })

  test('falls back rather than guessing for anything else', () => {
    expect(contentTypeFor('/a/blob.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('/a/noextension')).toBe('application/octet-stream')
  })
})

describe('UniverHost — workbench base URL', () => {
  test('defers to the Vite dev server instead of binding a second port', async () => {
    const host = new UniverHost(ROOT, 'http://localhost:5173/')
    await host.start()
    expect(host.baseUrl()).toBe('http://localhost:5173/univer/')
    await host.stop()
  })

  test('reports no base until the host has started', () => {
    expect(new UniverHost(ROOT).baseUrl()).toBeNull()
  })

  test('serves the pages from an unguessable loopback path once started', async () => {
    const host = new UniverHost(ROOT)
    await host.start()
    const base = host.baseUrl()
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/univer\/$/)
    await host.stop()
    expect(host.baseUrl()).toBeNull()
  })
})
