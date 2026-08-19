import {
  LabApiAbortError,
  LabApiHttpError,
  LabApiInvalidResponseError,
  LabApiNetworkError,
  isLabApiError,
} from './errors'
import type {
  ListSessionsParams,
  ListTurnsParams,
  Page,
  PromptReconstruction,
  PromptReconstructionList,
  RequestOptions,
  SessionSummary,
  SourceHealth,
  TurnDetail,
  TurnSummary,
} from './types'
import {
  parsePage,
  parsePromptReconstruction,
  parsePromptReconstructionList,
  parseSessionSummary,
  parseSourceHealth,
  parseTurnDetail,
  parseTurnSummary,
} from './validation'

export interface LabApiClient {
  getSourceHealth(options?: RequestOptions): Promise<SourceHealth>
  listSessions(params?: ListSessionsParams, options?: RequestOptions): Promise<Page<SessionSummary>>
  listSessionTurns(sessionId: string, params?: ListTurnsParams, options?: RequestOptions): Promise<Page<TurnSummary>>
  getTurnDetail(turnId: string, options?: RequestOptions): Promise<TurnDetail>
  reconstructPrompt(turnId: string, roundId: string, options?: RequestOptions): Promise<PromptReconstruction>
  listSessionPrompts(sessionId: string, options?: RequestOptions): Promise<PromptReconstructionList>
}

export interface LabApiClientOptions {
  baseUrl?: string
  fetch?: LabApiFetch
}

export type LabApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function normalizeBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/, '')
  return normalized || '/api'
}

function withQuery(path: string, values: object): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value))
  }
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

function errorMessage(body: unknown, status: number, statusText: string): string {
  if (typeof body === 'object' && body !== null) {
    const item = body as Record<string, unknown>
    if (typeof item.message === 'string') return item.message
    if (typeof item.error === 'string') return item.error
    if (typeof item.error === 'object' && item.error !== null) {
      const nested = item.error as Record<string, unknown>
      if (typeof nested.message === 'string') return nested.message
    }
  }
  return `Lab API request failed with ${status} ${statusText || 'HTTP error'}.`
}

async function responseBody(response: Response, path: string): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    if (response.ok) throw new LabApiInvalidResponseError(path, 'expected a JSON body')
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (!response.ok) return text
    throw new LabApiInvalidResponseError(path, 'body is not valid JSON', { cause: error })
  }
}

export function createLabApiClient(options: LabApiClientOptions = {}): LabApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? '/api')
  const fetchImpl = options.fetch ?? globalThis.fetch

  async function get<T>(path: string, parse: (value: unknown, path: string) => T, signal?: AbortSignal): Promise<T> {
    const url = `${baseUrl}${path}`
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
      })
    } catch (error) {
      if (isLabApiError(error)) throw error
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new LabApiAbortError({ cause: error })
      }
      throw new LabApiNetworkError('The Lab API could not be reached.', { cause: error })
    }

    let body: unknown
    try {
      body = await responseBody(response, path)
    } catch (error) {
      if (isLabApiError(error)) throw error
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new LabApiAbortError({ cause: error })
      }
      throw new LabApiNetworkError('The Lab API response could not be read.', { cause: error })
    }
    if (!response.ok) {
      throw new LabApiHttpError(
        response.status,
        response.statusText,
        errorMessage(body, response.status, response.statusText),
        body,
        url,
      )
    }
    return parse(body, '$')
  }

  return {
    getSourceHealth: (requestOptions) =>
      get('/source/health', parseSourceHealth, requestOptions?.signal),

    listSessions: (params = {}, requestOptions) =>
      get(
        withQuery('/sessions', params),
        (value, path) => parsePage(value, parseSessionSummary, path),
        requestOptions?.signal,
      ),

    listSessionTurns: (sessionId, params = {}, requestOptions) =>
      get(
        withQuery(`/sessions/${encodeURIComponent(sessionId)}/turns`, params),
        (value, path) => parsePage(value, parseTurnSummary, path),
        requestOptions?.signal,
      ),

    getTurnDetail: (turnId, requestOptions) =>
      get(`/turns/${encodeURIComponent(turnId)}`, (value, path) => {
        const envelope = value as { item?: unknown }
        return parseTurnDetail(envelope?.item, `${path}.item`)
      }, requestOptions?.signal),

    reconstructPrompt: (turnId, roundId, requestOptions) =>
      get(
        `/turns/${encodeURIComponent(turnId)}/rounds/${encodeURIComponent(roundId)}/prompt`,
        (value, path) => {
          const envelope = value as { item?: unknown }
          return parsePromptReconstruction(envelope?.item, `${path}.item`)
        },
        requestOptions?.signal,
      ),

    listSessionPrompts: (sessionId, requestOptions) =>
      get(
        `/sessions/${encodeURIComponent(sessionId)}/prompts`,
        parsePromptReconstructionList,
        requestOptions?.signal,
      ),
  }
}

export const labApi = createLabApiClient()
