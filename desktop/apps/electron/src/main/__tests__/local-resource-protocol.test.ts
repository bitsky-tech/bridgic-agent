import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LOCAL_RESOURCE_SCHEME,
  LOCAL_RESOURCE_TOKEN_ARGUMENT_PREFIX,
  createLocalResourceUrl,
  localResourceTokenFromArgv,
} from '../../shared/local-resource'
import {
  createLocalResourceHandler,
  createLocalResourceToken,
  registerLocalResourceScheme,
} from '../local-resource-protocol'

const TOKEN = 'test-startup-token'
const SOURCE_PATH = join(tmpdir(), 'local image.png')
const SOURCE_URL = pathToFileURL(SOURCE_PATH).href

describe('local-resource URL contract', () => {
  it('round-trips an encoded file URL and startup token', () => {
    const result = new URL(createLocalResourceUrl(SOURCE_URL, TOKEN))

    expect(result.protocol).toBe(`${LOCAL_RESOURCE_SCHEME}:`)
    expect(result.hostname).toBe('file')
    expect(result.searchParams.get('src')).toBe(SOURCE_URL)
    expect(result.searchParams.get('token')).toBe(TOKEN)
  })

  it('refuses empty tokens and non-file sources', () => {
    expect(() => createLocalResourceUrl(SOURCE_URL, '')).toThrow('token')
    expect(() => createLocalResourceUrl('https://example.com/image.png', TOKEN)).toThrow('file:')
  })

  it('extracts only a non-empty injected startup token', () => {
    expect(localResourceTokenFromArgv(['electron', `${LOCAL_RESOURCE_TOKEN_ARGUMENT_PREFIX}${TOKEN}`]))
      .toBe(TOKEN)
    expect(localResourceTokenFromArgv(['electron', LOCAL_RESOURCE_TOKEN_ARGUMENT_PREFIX])).toBeNull()
    expect(localResourceTokenFromArgv(['electron'])).toBeNull()
  })

  it('creates a high-entropy URL-safe token', () => {
    const token = createLocalResourceToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('local-resource privileged scheme', () => {
  it('allows renderer fetches through the main-window content security policy', () => {
    const html = readFileSync(new URL('../../renderer/index.html', import.meta.url), 'utf8')
    const policy = html.match(/content="(default-src[^"]+)"/)?.[1]
    const connections = policy?.split(';').find(directive => directive.trim().startsWith('connect-src '))
    expect(connections?.trim().split(/\s+/)).toContain(`${LOCAL_RESOURCE_SCHEME}:`)
  })

  it('grants only the read privileges needed by media elements and renderer imports', () => {
    let registration: Electron.CustomScheme[] = []

    registerLocalResourceScheme({
      registerSchemesAsPrivileged: (schemes) => {
        registration = schemes
      },
    })

    expect(registration).toEqual([
      {
        scheme: LOCAL_RESOURCE_SCHEME,
        privileges: {
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
    ])
  })
})

describe('local-resource request handler', () => {
  it('allows fetch only from the current main-window origin, including packaged file pages', async () => {
    let mainOrigin = 'http://localhost:5173'
    let reads = 0
    const handler = createLocalResourceHandler(TOKEN, {
      getFetchOrigin: () => mainOrigin,
      statFile: async () => ({ isFile: () => true }),
      fetchFile: async () => {
        reads += 1
        return new Response('pptx bytes')
      },
    })
    const fetchFrom = (origin: string, token = TOKEN) => handler(new Request(createLocalResourceUrl(SOURCE_URL, token), {
      headers: { Origin: origin },
    }))
    const allowed = await fetchFrom(mainOrigin)
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(mainOrigin)
    expect((await fetchFrom('https://example.com')).status).toBe(403)
    expect((await fetchFrom('http://localhost:5174')).status).toBe(403)
    expect((await fetchFrom(mainOrigin, 'wrong-token')).status).toBe(403)
    expect(reads).toBe(1)
    mainOrigin = 'null'
    const packaged = await fetchFrom('null')
    expect(packaged.status).toBe(200)
    expect(packaged.headers.get('access-control-allow-origin')).toBe('null')
    expect((await fetchFrom('http://localhost:5173')).status).toBe(403)
  })

  it('forwards GET headers to file fetch after checking for a regular file', async () => {
    const calls: Array<{ input: string; init: RequestInit & { bypassCustomProtocolHandlers?: boolean } }> = []
    const statPaths: string[] = []
    const handler = createLocalResourceHandler(TOKEN, {
      statFile: async (path) => {
        statPaths.push(path)
        return { isFile: () => true }
      },
      fetchFile: async (input, init) => {
        calls.push({ input, init })
        return new Response('image bytes', {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Range': 'bytes 0-10/100',
            'Content-Type': 'image/png',
            'X-Upstream': 'preserved',
          },
        })
      },
    })

    const result = await handler(new Request(createLocalResourceUrl(SOURCE_URL, TOKEN), {
      headers: { Range: 'bytes=0-1023', 'X-Test': 'forwarded' },
    }))

    expect(result.status).toBe(206)
    expect(result.statusText).toBe('Partial Content')
    expect(await result.text()).toBe('image bytes')
    expect(result.headers.get('content-range')).toBe('bytes 0-10/100')
    expect(result.headers.get('content-type')).toBe('image/png')
    expect(result.headers.get('x-upstream')).toBe('preserved')
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(statPaths).toEqual([SOURCE_PATH])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe(SOURCE_URL)
    expect(calls[0]?.init.method).toBe('GET')
    expect(new Headers(calls[0]?.init.headers).get('range')).toBe('bytes=0-1023')
    expect(new Headers(calls[0]?.init.headers).get('x-test')).toBe('forwarded')
    expect(calls[0]?.init.bypassCustomProtocolHandlers).toBe(true)
  })

  it('forwards HEAD requests for metadata-only loads', async () => {
    let forwardedMethod: string | undefined
    const handler = createLocalResourceHandler(TOKEN, {
      statFile: async () => ({ isFile: () => true }),
      fetchFile: async (_input, init) => {
        forwardedMethod = init.method
        return new Response(null, { status: 200 })
      },
    })

    const result = await handler(new Request(createLocalResourceUrl(SOURCE_URL, TOKEN), {
      method: 'HEAD',
    }))

    expect(result.status).toBe(200)
    expect(forwardedMethod).toBe('HEAD')
  })

  it('accepts and canonicalizes short-form file URLs', async () => {
    let forwardedSource: string | undefined
    const handler = createLocalResourceHandler(TOKEN, {
      statFile: async () => ({ isFile: () => true }),
      fetchFile: async (input) => {
        forwardedSource = input
        return new Response('ok')
      },
    })
    const requestUrl = new URL(`${LOCAL_RESOURCE_SCHEME}://file`)
    requestUrl.searchParams.set('src', SOURCE_URL.replace(/^file:\/\//, 'file:'))
    requestUrl.searchParams.set('token', TOKEN)

    const result = await handler(new Request(requestUrl))

    expect(result.status).toBe(200)
    expect(forwardedSource).toBe(SOURCE_URL)
  })

  it('rejects methods other than GET and HEAD before touching the file system', async () => {
    let touched = false
    const handler = createLocalResourceHandler(TOKEN, {
      statFile: async () => {
        touched = true
        return { isFile: () => true }
      },
      fetchFile: async () => {
        touched = true
        return new Response()
      },
    })

    const result = await handler(new Request(createLocalResourceUrl(SOURCE_URL, TOKEN), {
      method: 'POST',
    }))

    expect(result.status).toBe(405)
    expect(result.headers.get('allow')).toBe('GET, HEAD')
    expect(touched).toBe(false)
  })

  it('rejects a missing or incorrect startup token', async () => {
    const handler = createLocalResourceHandler(TOKEN, {
      statFile: async () => ({ isFile: () => true }),
      fetchFile: async () => new Response(),
    })
    const wrongToken = await handler(new Request(createLocalResourceUrl(SOURCE_URL, 'wrong-token')))
    const missingTokenUrl = new URL(createLocalResourceUrl(SOURCE_URL, TOKEN))
    missingTokenUrl.searchParams.delete('token')
    const missingToken = await handler(new Request(missingTokenUrl))

    expect(wrongToken.status).toBe(403)
    expect(missingToken.status).toBe(403)
  })

  it('rejects non-file sources even when the internal URL has a valid token', async () => {
    const handler = createLocalResourceHandler(TOKEN, {
      statFile: async () => ({ isFile: () => true }),
      fetchFile: async () => new Response(),
    })
    const requestUrl = new URL(`${LOCAL_RESOURCE_SCHEME}://file`)
    requestUrl.searchParams.set('src', 'https://example.com/private.png')
    requestUrl.searchParams.set('token', TOKEN)

    expect((await handler(new Request(requestUrl))).status).toBe(403)
  })

  it('returns not found for missing paths and non-regular files without fetching', async () => {
    let fetched = false
    const missingHandler = createLocalResourceHandler(TOKEN, {
      statFile: async () => { throw new Error('ENOENT') },
      fetchFile: async () => {
        fetched = true
        return new Response()
      },
    })
    const directoryHandler = createLocalResourceHandler(TOKEN, {
      statFile: async () => ({ isFile: () => false }),
      fetchFile: async () => {
        fetched = true
        return new Response()
      },
    })

    expect((await missingHandler(new Request(createLocalResourceUrl(SOURCE_URL, TOKEN)))).status)
      .toBe(404)
    expect((await directoryHandler(new Request(createLocalResourceUrl(SOURCE_URL, TOKEN)))).status)
      .toBe(404)
    expect(fetched).toBe(false)
  })

  it('contains file-fetch failures behind a generic server error', async () => {
    const handler = createLocalResourceHandler(TOKEN, {
      statFile: async () => ({ isFile: () => true }),
      fetchFile: async () => { throw new Error('network stack failed') },
    })

    const result = await handler(new Request(createLocalResourceUrl(SOURCE_URL, TOKEN)))
    expect(result.status).toBe(500)
  })
})
