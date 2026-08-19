import { StateDataSource, InvalidCursorError, SourceUnavailableError, normalizeLimit } from './data-source'
import { BRIDGIC_AGENT_STATE_DB, LAB_HOST, readApiPort } from './constants'
import { rebuildPromptFromSource, rebuildSessionPromptsFromSource } from './prompt-adapter'
import { PromptRebuildError } from './prompt/types'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

function decodeId(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new HttpError(400, 'invalid_id', 'The resource id is invalid.')
  }
  if (!decoded || decoded.length > 256 || decoded.includes('/')) {
    throw new HttpError(400, 'invalid_id', 'The resource id is invalid.')
  }
  return decoded
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status)
  }
  if (error instanceof InvalidCursorError) {
    return json({ error: { code: 'invalid_cursor', message: error.message } }, 400)
  }
  if (error instanceof SourceUnavailableError) {
    return json({ error: { code: error.code, message: error.message } }, 503)
  }
  if (error instanceof PromptRebuildError) {
    const status = error.code === 'TURN_NOT_FOUND' || error.code === 'ROUND_NOT_FOUND' ? 404 : 400
    return json({ error: { code: error.code.toLowerCase(), message: error.message } }, status)
  }

  console.error('[Bridgic Agent Lab] API request failed', error)
  return json({
    error: {
      code: 'internal_error',
      message: 'The local Lab service could not complete this request.',
    },
  }, 500)
}

export function createApiHandler(source = new StateDataSource()): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'GET') {
        return json({
          error: {
            code: 'method_not_allowed',
            message: 'The local Lab API is read-only and accepts GET requests only.',
          },
        }, 405)
      }

      const url = new URL(request.url)
      const { pathname, searchParams } = url
      if (pathname === '/api/source/health') {
        return json(source.health())
      }

      if (pathname === '/api/sessions') {
        return json(source.listSessions({
          cursor: searchParams.get('cursor') || undefined,
          limit: normalizeLimit(searchParams.get('limit')),
          query: searchParams.get('query') || undefined,
        }))
      }

      const sessionTurnsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/)
      if (sessionTurnsMatch?.[1]) {
        const sessionId = decodeId(sessionTurnsMatch[1])
        const page = source.listTurns(sessionId, {
          cursor: searchParams.get('cursor') || undefined,
          limit: normalizeLimit(searchParams.get('limit')),
        })
        if (!page) {
          throw new HttpError(404, 'session_not_found', 'The requested session does not exist.')
        }
        return json(page)
      }

      const sessionPromptsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompts$/)
      if (sessionPromptsMatch?.[1]) {
        const sessionId = decodeId(sessionPromptsMatch[1])
        const items = rebuildSessionPromptsFromSource(source, sessionId)
        if (!items) {
          throw new HttpError(404, 'session_not_found', 'The requested session does not exist.')
        }
        return json({ items, total: items.length })
      }

      const turnMatch = pathname.match(/^\/api\/turns\/([^/]+)$/)
      if (turnMatch?.[1]) {
        const turn = source.getTurnDetail(decodeId(turnMatch[1]))
        if (!turn) {
          throw new HttpError(404, 'turn_not_found', 'The requested session turn does not exist.')
        }
        return json({ item: turn })
      }

      const promptMatch = pathname.match(/^\/api\/turns\/([^/]+)\/rounds\/([^/]+)\/prompt$/)
      if (promptMatch?.[1] && promptMatch[2]) {
        const turnId = decodeId(promptMatch[1])
        const roundId = decodeId(promptMatch[2])
        return json({ item: rebuildPromptFromSource(source, turnId, roundId) })
      }

      return json({
        error: {
          code: 'not_found',
          message: 'The requested Lab API route does not exist.',
        },
      }, 404)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

export function startApiServer(options: { port?: number; dbPath?: string } = {}) {
  const source = new StateDataSource(options.dbPath ?? BRIDGIC_AGENT_STATE_DB)
  const server = Bun.serve({
    hostname: LAB_HOST,
    port: options.port ?? readApiPort(),
    fetch: createApiHandler(source),
  })

  return {
    server,
    stop: async (): Promise<void> => {
      source.close()
      await server.stop(true)
    },
  }
}
