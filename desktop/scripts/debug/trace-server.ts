import { timingSafeEqual } from 'node:crypto'
import { DebugTraceError, DebugTraceSource, validateDebugSessionId } from './trace-source'
import type { DesktopDebugError } from '../../apps/electron/src/shared/debug-types'

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } })
}

export function createDebugTraceHandler(options: { source: DebugTraceSource; token: string; origin: string }) {
  const authorization = Buffer.from(`Bearer ${options.token}`)
  return (request: Request): Response => {
    const supplied = Buffer.from(request.headers.get('authorization') ?? '')
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      return json({ error: { code: 'unauthorized', message: 'Debug launcher authorization required.' } }, 401)
    }
    if (request.headers.has('origin') && request.headers.get('origin') !== options.origin) {
      return json({ error: { code: 'invalid_origin', message: 'The request origin is not this Desktop renderer.' } }, 403)
    }
    if (request.method !== 'GET') {
      return json({ error: { code: 'read_only', message: 'Debug trace access only accepts GET requests.' } }, 405)
    }
    try {
      const url = new URL(request.url)
      const match = /^\/__debug-api\/sessions\/([^/]+)\/turns$/.exec(url.pathname)
      if (!match?.[1]) return json({ error: { code: 'not_found', message: 'Unknown debug route.' } }, 404)
      let sessionId: string
      try { sessionId = validateDebugSessionId(decodeURIComponent(match[1])) }
      catch { throw new DebugTraceError(400, 'invalid_session', 'The Session id is invalid.') }
      const limit = url.searchParams.get('limit')
      let parsedLimit: number | undefined
      if (limit !== null) parsedLimit = /^\d+$/.test(limit) ? Number(limit) : NaN
      return json(options.source.listTurns(sessionId, {
        before: url.searchParams.get('before') || undefined,
        limit: parsedLimit,
      }))
    } catch (error) {
      const known = error instanceof DebugTraceError ? error
        : new DebugTraceError(500, 'debug_unavailable', 'Debug trace access failed.')
      const body: DesktopDebugError = { error: { code: known.code, message: known.message } }
      return json(body, known.status)
    }
  }
}

/** Runs inside the existing Bun launcher, never in Electron or the renderer. */
export function startDebugTraceServer(options: { token: string; origin: string; dbPath?: string }) {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: createDebugTraceHandler({ ...options, source: new DebugTraceSource(options.dbPath) }),
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}
