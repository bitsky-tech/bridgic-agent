/**
 * Serves the built Univer sheet page over loopback HTTP.
 *
 * The Session dock renders the page through the embedded browser, and that
 * browser only navigates to http(s) URLs (see EmbeddedBrowserManager's
 * navigation guard), so a `file://` or custom-scheme page is not an option. A
 * tiny static server is the smallest thing that closes the gap.
 *
 * In development the renderer is already served by Vite, so the host stands
 * aside and reports the dev URL instead of binding a second port.
 */
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, normalize, sep } from 'node:path'
import { mainLog } from './logger'

const LOOPBACK_HOST = '127.0.0.1'
const PAGE_PATH = 'univer/index.html'

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** Resolve one request path against the served root, or null if it escapes it. */
export function resolveAssetPath(rootDir: string, prefix: string, requestUrl: string): string | null {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname)
  } catch {
    return null
  }
  if (!pathname.startsWith(`/${prefix}/`)) return null
  const relative = pathname.slice(prefix.length + 2)
  if (!relative) return null
  // normalize() collapses `..` segments; anything that still climbs out of the
  // root after that is a traversal attempt, not a path we should serve.
  const resolved = join(rootDir, normalize(relative))
  if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) return null
  return resolved
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot < 0 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()])
    ?? 'application/octet-stream'
}

export class UniverHost {
  /** An unguessable prefix keeps other local processes off this origin. */
  private readonly prefix = randomBytes(16).toString('hex')
  private origin: string | null = null
  private server: Server | null = null

  constructor(
    private readonly rootDir: string,
    private readonly devServerUrl?: string,
  ) {}

  async start(): Promise<void> {
    if (this.devServerUrl || this.server) return
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = server.address() as AddressInfo | null
    if (!address) {
      server.close()
      throw new Error('univer host did not bind a loopback address')
    }
    this.server = server
    this.origin = `http://${LOOPBACK_HOST}:${address.port}`
    mainLog.info(`[univer] sheet host ready on port ${address.port}`)
  }

  /** The URL the agent navigates to, or null while the host is not running. */
  pageUrl(): string | null {
    if (this.devServerUrl) return `${this.devServerUrl.replace(/\/$/, '')}/${PAGE_PATH}`
    return this.origin ? `${this.origin}/${this.prefix}/${PAGE_PATH}` : null
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.origin = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end()
      return
    }
    const path = resolveAssetPath(this.rootDir, this.prefix, request.url ?? '')
    if (!path) {
      response.writeHead(404).end()
      return
    }
    try {
      const info = await stat(path)
      if (!info.isFile()) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': info.size,
        'Content-Type': contentTypeFor(path),
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      createReadStream(path).pipe(response)
    } catch {
      response.writeHead(404).end()
    }
  }
}
