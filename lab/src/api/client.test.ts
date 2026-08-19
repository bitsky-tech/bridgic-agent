import { describe, expect, test } from 'bun:test'
import { createLabApiClient } from './client'
import {
  LabApiAbortError,
  LabApiHttpError,
  LabApiInvalidResponseError,
} from './errors'

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

const session = {
  id: 'session/one',
  title: 'Inspect prompts',
  status: 'completed',
  kind: 'user',
  parentSessionId: null,
  parentCallId: null,
  subagentMode: null,
  workspaceRoot: '/tmp/work',
  scheduleId: null,
  lastUsedModel: 'gpt-5',
  lastAnswer: 'Done',
  createdAt: '2026-08-18T00:00:00Z',
  updatedAt: '2026-08-18T00:01:00Z',
  turnCount: 1,
  inputTokens: 10,
  outputTokens: 2,
}

const turn = {
  id: 'turn/one',
  sessionId: session.id,
  sessionOrdinal: 1,
  userInput: { text: 'Show me the prompt', blocks: [] },
  status: 'completed',
  finalAnswer: 'Done',
  error: null,
  executionMode: 'auto',
  maxRounds: 8,
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 2,
  createdAt: '2026-08-18T00:00:00Z',
  completedAt: '2026-08-18T00:00:01Z',
  durationMs: 123,
}

const reconstructedPrompt = {
  sessionId: session.id,
  turnId: turn.id,
  roundId: `${turn.id}:round:1`,
  roundIndex: 0,
  stage: 'main',
  model: 'gpt-5',
  messages: [{ role: 'system', content: 'System prompt' }],
  tools: [{
    name: 'read_file',
    description: 'Read a file',
    group: 'workspace',
    advanced: false,
    required: ['path'],
    properties: ['path'],
    parameters: { type: 'object' },
    schemaFidelity: 'lab_catalog',
  }],
  components: [{
    id: 'persona',
    kind: 'persona',
    label: 'Main persona',
    content: 'System prompt',
    messageIndexes: [0],
    source: ['lab/server/prompt/catalog.ts'],
    fidelity: 'reconstructed',
    limitations: [],
  }],
  fidelity: {
    level: 'reconstructed',
    score: 0.9,
    exactComponents: 1,
    totalComponents: 2,
    limitations: ['Workspace files are current.'],
  },
  reconstructedAt: '2026-08-18T00:02:00Z',
}

describe('Lab API client', () => {
  test('uses the same-origin API prefix, query parameters, and AbortSignal', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return json({ items: [session], nextCursor: 'next', total: 1 })
    }
    const controller = new AbortController()
    const client = createLabApiClient({ fetch: fetchMock })

    const page = await client.listSessions(
      { cursor: 'cursor/一', limit: 20, query: 'prompt lab' },
      { signal: controller.signal },
    )

    expect(page.items[0]?.id).toBe(session.id)
    expect(calls[0]?.input).toBe('/api/sessions?cursor=cursor%2F%E4%B8%80&limit=20&query=prompt+lab')
    expect(calls[0]?.init?.signal).toBe(controller.signal)
    expect(calls[0]?.init?.headers).toEqual({ Accept: 'application/json' })
  })

  test('encodes path identifiers and normalizes persisted OTA records', async () => {
    let requested = ''
    const client = createLabApiClient({
      baseUrl: '/api/',
      fetch: async (input) => {
        requested = String(input)
        return json({
          item: {
            ...turn,
            otaRecords: [{
              observation_result: 'Observed',
              think_result: {
                step_content: 'Use a tool',
                tool_calls: [{ call_id: 'call_1', tool: 'read_file', tool_arguments: [] }],
              },
              action_result: {
                results: [{
                  tool_id: 'call_1',
                  tool_name: 'read_file',
                  tool_arguments: { path: '/tmp/work/a.md' },
                  tool_result: 'contents',
                  success: true,
                }],
              },
            }],
            agentState: { mode: 'normal', stage: 'main' },
            browserToolLoaded: false,
            workspaceToolsLoaded: true,
            skillsToolLoaded: true,
            mounts: [{
              id: 'mnt_1',
              sessionId: session.id,
              name: 'work',
              absPath: '/tmp/work',
              kind: 'folder',
              createdAt: '2026-08-18T00:00:00Z',
            }],
            session,
          },
        })
      },
    })

    const detail = await client.getTurnDetail(turn.id)

    expect(requested).toBe('/api/turns/turn%2Fone')
    expect(detail.otaRecords[0]?.id).toBe('turn/one:round:1')
    expect(detail.otaRecords[0]?.thinkResult?.toolCalls[0]?.tool).toBe('read_file')
    expect(detail.otaRecords[0]?.actionResult?.results[0]?.toolName).toBe('read_file')
    expect(detail.workspace).toEqual({ root: '/tmp/work', mounts: detail.mounts })
  })

  test('returns a typed HTTP error with server details', async () => {
    const client = createLabApiClient({
      fetch: async () => json({ error: { message: 'Turn not found' } }, {
        status: 404,
        statusText: 'Not Found',
      }),
    })

    try {
      await client.getTurnDetail('missing')
      throw new Error('Expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(LabApiHttpError)
      expect((error as LabApiHttpError).kind).toBe('http')
      expect((error as LabApiHttpError).status).toBe(404)
      expect((error as LabApiHttpError).message).toBe('Turn not found')
    }
  })

  test('loads a reconstructed prompt for a specific OTA round', async () => {
    let requested = ''
    const client = createLabApiClient({
      fetch: async (input) => {
        requested = String(input)
        return json({ item: reconstructedPrompt })
      },
    })

    const prompt = await client.reconstructPrompt(turn.id, `${turn.id}:round:1`)

    expect(requested).toBe(
      '/api/turns/turn%2Fone/rounds/turn%2Fone%3Around%3A1/prompt',
    )
    expect(prompt.messages[0]?.role).toBe('system')
    expect(prompt.components[0]?.fidelity).toBe('reconstructed')
    expect(prompt.fidelity.score).toBe(0.9)
  })

  test('loads every reconstructed prompt for a Session in one request', async () => {
    let requested = ''
    const controller = new AbortController()
    const client = createLabApiClient({
      fetch: async (input, init) => {
        requested = String(input)
        expect(init?.signal).toBe(controller.signal)
        return json({ items: [reconstructedPrompt], total: 1 })
      },
    })

    const collection = await client.listSessionPrompts(session.id, { signal: controller.signal })

    expect(requested).toBe('/api/sessions/session%2Fone/prompts')
    expect(collection.total).toBe(1)
    expect(collection.items[0]?.roundId).toBe(`${turn.id}:round:1`)
    expect(collection.items[0]?.messages[0]?.content).toBe('System prompt')
  })

  test('rejects malformed successful responses', async () => {
    const client = createLabApiClient({
      fetch: async () => json({ status: 'connected', path: 42 }),
    })

    await expect(client.getSourceHealth()).rejects.toBeInstanceOf(LabApiInvalidResponseError)
  })

  test('distinguishes aborted requests', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = createLabApiClient({
      fetch: async (_input, init) => {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        return json(null)
      },
    })

    await expect(client.getSourceHealth({ signal: controller.signal })).rejects.toBeInstanceOf(
      LabApiAbortError,
    )
  })
})
