import type { Protocol, Session } from 'electron'
import { stat } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  LOCAL_RESOURCE_HOST,
  LOCAL_RESOURCE_SCHEME,
} from '../shared/local-resource'

type FileStat = { isFile(): boolean }

export interface LocalResourceHandlerDependencies {
  fetchFile: (
    input: string,
    init: RequestInit & { bypassCustomProtocolHandlers?: boolean },
  ) => Promise<Response>
  statFile?: (path: string) => Promise<FileStat>
}

function response(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers })
}

function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual || !expected) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function parseSource(requestUrl: string, expectedToken: string): URL | null {
  let internalUrl: URL
  try {
    internalUrl = new URL(requestUrl)
  } catch {
    return null
  }

  if (
    internalUrl.protocol !== `${LOCAL_RESOURCE_SCHEME}:` ||
    internalUrl.hostname !== LOCAL_RESOURCE_HOST ||
    (internalUrl.pathname !== '' && internalUrl.pathname !== '/') ||
    internalUrl.username !== '' ||
    internalUrl.password !== '' ||
    internalUrl.port !== '' ||
    internalUrl.hash !== '' ||
    !tokenMatches(internalUrl.searchParams.get('token'), expectedToken)
  ) {
    return null
  }

  const source = internalUrl.searchParams.get('src')
  if (!source) return null

  try {
    const sourceUrl = new URL(source)
    if (
      sourceUrl.protocol !== 'file:' ||
      sourceUrl.username !== '' ||
      sourceUrl.password !== '' ||
      sourceUrl.port !== '' ||
      sourceUrl.search !== '' ||
      sourceUrl.hash !== ''
    ) {
      return null
    }
    // Validate platform-specific file URL details (for example, UNC hosts)
    // before any request reaches Electron's network stack.
    fileURLToPath(sourceUrl)
    return sourceUrl
  } catch {
    return null
  }
}

/**
 * Create the protocol handler separately from Electron registration so its
 * validation and forwarding behavior can be unit-tested without a live app.
 */
export function createLocalResourceHandler(
  expectedToken: string,
  dependencies: LocalResourceHandlerDependencies,
): (request: Request) => Promise<Response> {
  const statFile = dependencies.statFile ?? stat

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return response(405, { Allow: 'GET, HEAD' })
    }

    const sourceUrl = parseSource(request.url, expectedToken)
    if (!sourceUrl) return response(403)

    let sourceStat: FileStat
    try {
      sourceStat = await statFile(fileURLToPath(sourceUrl))
    } catch {
      return response(404)
    }
    if (!sourceStat.isFile()) return response(404)

    try {
      const forwarded = await dependencies.fetchFile(sourceUrl.href, {
        method: request.method,
        headers: request.headers,
        bypassCustomProtocolHandlers: true,
      })
      const headers = new Headers(forwarded.headers)
      headers.set('Cache-Control', 'no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(forwarded.body, {
        status: forwarded.status,
        statusText: forwarded.statusText,
        headers,
      })
    } catch {
      return response(500)
    }
  }
}

/** Must run before Electron emits ready. */
export function registerLocalResourceScheme(
  registrar: Pick<Protocol, 'registerSchemesAsPrivileged'>,
): void {
  registrar.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_RESOURCE_SCHEME,
      privileges: {
        stream: true,
      },
    },
  ])
}

/** Install the handler only on the trusted main-window Electron session. */
export function installLocalResourceProtocol(
  browserSession: Pick<Session, 'fetch' | 'protocol'>,
  token: string,
): void {
  const handler = createLocalResourceHandler(token, {
    fetchFile: (input, init) => browserSession.fetch(input, init),
  })
  browserSession.protocol.handle(LOCAL_RESOURCE_SCHEME, handler)
}

export function createLocalResourceToken(): string {
  return randomBytes(32).toString('base64url')
}
