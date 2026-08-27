/**
 * Tests for amphi-client.ts — focuses on M1 additions:
 *
 *  - Authorization: Bearer <token> header (replaces the old X-App-Token)
 *  - X-Client-Id / X-Client-Type / User-Agent passthrough
 *  - Gateway endpoint methods (getGatewayHealth/Info/Clients + shutdown)
 *  - Token-less mode (legacy daemon) sends no Authorization header
 *
 * We stub globalThis.fetch with a small recorder that captures each
 * request's URL + headers + method, then returns a canned Response.
 * No real network. No nock-style heavy mocking — the surface is small
 * enough to assert directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { AmphiClient } from '../amphiClient'
import { i18n } from '../i18n'

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: BodyInit | null
}

let captured: CapturedRequest[] = []
let originalFetch: typeof fetch

function installFetchStub(jsonBody: unknown, status = 200): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    // Normalize headers: Init.headers may be Headers / array / object.
    const headers: Record<string, string> = {}
    const raw = init?.headers
    if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        headers[k] = v
      })
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw) headers[k] = v
    } else if (raw) {
      Object.assign(headers, raw as Record<string, string>)
    }
    captured.push({ url, method, headers, body: init?.body })
    return Promise.resolve(
      new Response(JSON.stringify(jsonBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  captured = []
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await i18n.changeLanguage('zh')
})

// ─── Auth header ────────────────────────────────────────────────────────────

describe('AmphiClient auth header', () => {
  it('sends Authorization: Bearer <token> when token is set', async () => {
    installFetchStub({ status: 'ok' })
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421',
      token: 'tok_abc',
    })
    await client.getGatewayInfo()
    expect(captured[0]?.headers['Authorization']).toBe('Bearer tok_abc')
  })

  it('does NOT send Authorization when token is null (legacy daemon)', async () => {
    installFetchStub({ status: 'ok' })
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421',
      token: null,
    })
    await client.getHealth()
    expect(captured[0]?.headers['Authorization']).toBeUndefined()
  })

  it('notifies auth recovery on 401 without swallowing the HTTP error', async () => {
    installFetchStub({ detail: 'Unauthorized' }, 401)
    let authFailures = 0
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421',
      token: 'stale-token',
      onAuthFailure: () => {
        authFailures += 1
      },
    })

    await expect(client.getGatewayInfo()).rejects.toMatchObject({ status: 401 })
    expect(authFailures).toBe(1)
  })

  it('does not report a public tokenless 401 as an auth rotation', async () => {
    installFetchStub({ detail: 'Unauthorized' }, 401)
    let authFailures = 0
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421',
      token: null,
      onAuthFailure: () => {
        authFailures += 1
      },
    })

    await expect(client.getHealth()).rejects.toMatchObject({ status: 401 })
    expect(authFailures).toBe(0)
  })

  it('reports 401 from a raw response path without replaying the mutation', async () => {
    installFetchStub({ detail: 'Unauthorized' }, 401)
    let authFailures = 0
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421',
      token: 'stale-token',
      onAuthFailure: () => {
        authFailures += 1
      },
    })

    await expect(client.deleteProvider('provider-1')).rejects.toMatchObject({ status: 401 })
    expect(authFailures).toBe(1)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.method).toBe('DELETE')
  })

  it('keeps the original 401 when auth recovery throws', async () => {
    installFetchStub({ detail: 'Unauthorized' }, 401)
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421',
      token: 'stale-token',
      onAuthFailure: () => {
        throw new Error('refresh bridge unavailable')
      },
    })

    await expect(client.getGatewayInfo()).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    })
  })

  it('does not refresh auth for non-auth HTTP errors', async () => {
    installFetchStub({ detail: 'Forbidden' }, 403)
    let authFailures = 0
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421',
      token: 'token',
      onAuthFailure: () => {
        authFailures += 1
      },
    })

    await expect(client.getGatewayInfo()).rejects.toMatchObject({ status: 403 })
    expect(authFailures).toBe(0)
  })
})

describe('AmphiClient locale header', () => {
  it('sends the active UI language through the standard Accept-Language header', async () => {
    await i18n.changeLanguage('en')
    installFetchStub({ status: 'ok' })
    const client = new AmphiClient({ baseUrl: 'http://127.0.0.1:7421', token: null })

    await client.getHealth()

    expect(captured[0]?.headers['Accept-Language']).toBe('en')
  })
})

// ─── X-Client-Id / X-Client-Type / User-Agent ───────────────────────────────

describe('AmphiClient client identification headers', () => {
  it('sends X-Client-Id when configured', async () => {
    installFetchStub({ status: 'ok' })
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421',
      token: 't',
      clientId: 'gui-laptop-001',
      clientType: 'gui',
    })
    await client.getGatewayInfo()
    expect(captured[0]?.headers['X-Client-Id']).toBe('gui-laptop-001')
    expect(captured[0]?.headers['X-Client-Type']).toBe('gui')
  })

  it('omits X-Client-Id when not configured', async () => {
    installFetchStub({ status: 'ok' })
    const client = new AmphiClient({ baseUrl: 'http://x', token: null })
    await client.getHealth()
    expect(captured[0]?.headers['X-Client-Id']).toBeUndefined()
    expect(captured[0]?.headers['X-Client-Type']).toBeUndefined()
  })

  it('sends User-Agent when configured', async () => {
    installFetchStub({ status: 'ok' })
    const client = new AmphiClient({
      baseUrl: 'http://x',
      token: 't',
      userAgent: 'amphi/0.1.0',
    })
    await client.getGatewayInfo()
    expect(captured[0]?.headers['User-Agent']).toBe('amphi/0.1.0')
  })
})

// ─── Gateway endpoint routing ───────────────────────────────────────────────

describe('AmphiClient gateway endpoints', () => {
  it('getGatewayHealth → GET /api/gateway/health', async () => {
    installFetchStub({ status: 'ok', version: '0.1.0', started_at: 'x' })
    const client = new AmphiClient({ baseUrl: 'http://127.0.0.1:7421', token: null })
    const body = await client.getGatewayHealth()
    expect(captured[0]?.url).toBe('http://127.0.0.1:7421/api/gateway/health')
    expect(captured[0]?.method).toBe('GET')
    expect(body.version).toBe('0.1.0')
  })

  it('getGatewayInfo → GET /api/gateway/info with bearer', async () => {
    installFetchStub({
      pid: 1, host: '127.0.0.1', port: 7421, version: '0.1.0',
      started_at: 'x', uptime_seconds: 1,
      ws_path: '/ws', connected_clients_count: 2,
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })
    const body = await client.getGatewayInfo()
    expect(captured[0]?.url).toBe('http://x/api/gateway/info')
    expect(captured[0]?.method).toBe('GET')
    expect(captured[0]?.headers['Authorization']).toBe('Bearer tok')
    expect(body.connected_clients_count).toBe(2)
  })

  it('getGatewayClients → returns parsed array', async () => {
    installFetchStub([
      {
        client_id: 'gui-1', client_type: 'gui',
        connected_at: 1.0, last_seen: 2.0, user_agent: 'amphi/0.1.0',
      },
      {
        client_id: 'cli-1', client_type: 'cli',
        connected_at: 3.0, last_seen: 4.0, user_agent: null,
      },
    ])
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })
    const list = await client.getGatewayClients()
    expect(captured[0]?.url).toBe('http://x/api/gateway/clients')
    expect(list).toHaveLength(2)
    expect(list[0]?.client_id).toBe('gui-1')
    expect(list[1]?.user_agent).toBeNull()
  })

  it('postGatewayShutdown → POST /api/gateway/shutdown', async () => {
    installFetchStub({ shutting_down: true, delay_seconds: 0.3 })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })
    const body = await client.postGatewayShutdown()
    expect(captured[0]?.url).toBe('http://x/api/gateway/shutdown')
    expect(captured[0]?.method).toBe('POST')
    expect(captured[0]?.headers['Authorization']).toBe('Bearer tok')
    expect(body.shutting_down).toBe(true)
    expect(body.delay_seconds).toBe(0.3)
  })
})

// ─── Workflow endpoints ────────────────────────────────────────────────────

describe('AmphiClient workflow endpoints', () => {
  it('getWorkflow → GET /workflows/{id} and parses detail fields', async () => {
    installFetchStub({
      id: 'wf_1',
      name: '目录文件统计工作流',
      info: { desc: '统计目录文件', source_session_id: 'session_1' },
      fields: {
        task: { value: 'Task brief', editable: true },
        explore: { value: 'Explore report', editable: false },
        verify: { value: 'Verify report', editable: false },
        program: {
          files: [{ path: 'main.py', language: 'python', content: "print('ok')\n" }],
        },
      },
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })
    const detail = await client.getWorkflow('wf_1')

    expect(captured[0]?.url).toBe('http://x/workflows/wf_1')
    expect(captured[0]?.method).toBe('GET')
    expect(detail.fields.task?.value).toBe('Task brief')
    expect(detail.fields.program?.files[0]?.path).toBe('main.py')
  })

  it('distinguishes a missing Workflow source from an availability check error', async () => {
    installFetchStub({ detail: 'Workflow not found.' }, 404)
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    expect(await client.getWorkflowAvailability('wf_missing')).toBe('missing')
    expect(captured[0]?.url).toBe('http://x/workflows/wf_missing')

    installFetchStub({ detail: 'temporary failure' }, 503)
    await expect(client.getWorkflowAvailability('wf_error')).rejects.toThrow('temporary failure')
  })

  it('imports and exports portable Workflow files', async () => {
    installFetchStub({
      id: 'wf_imported',
      name: '导入工作流',
      workflow_dir: '/workflows/wf_imported',
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })
    const imported = await client.importWorkflow(
      new File(['archive'], 'workflow.amphi-workflow'),
    )
    expect(captured[0]?.url).toBe('http://x/workflows')
    expect(captured[0]?.method).toBe('PUT')
    expect(imported.id).toBe('wf_imported')

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: input.toString(),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: init?.headers as Record<string, string>,
      })
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])))
    }) as typeof fetch
    const exported = await client.exportWorkflow('wf 1')
    expect(captured[1]?.url).toBe('http://x/workflows/wf%201?archive=true')
    expect(Array.from(exported)).toEqual([1, 2, 3])
  })

  it('deletes one Workflow definition without requiring a response body', async () => {
    installFetchStub({})
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    await client.deleteWorkflow('wf 1')

    expect(captured[0]?.url).toBe('http://x/workflows/wf%201')
    expect(captured[0]?.method).toBe('DELETE')
  })

  it('renames one Workflow definition through PATCH', async () => {
    installFetchStub({
      id: 'wf 1',
      name: '新名称',
      workflow_dir: '/workflows/wf 1',
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    const renamed = await client.renameWorkflow('wf 1', '新名称')

    expect(captured[0]?.url).toBe('http://x/workflows/wf%201')
    expect(captured[0]?.method).toBe('PATCH')
    expect(captured[0]?.body).toBe(JSON.stringify({ name: '新名称' }))
    expect(renamed.name).toBe('新名称')
  })

  it('lists global Workflow results with filters', async () => {
    installFetchStub([{
      id: 'wfr_1',
      workflow_id: 'wf_1',
      workflow_name: '目录文件统计工作流',
      source_session_id: 'session_1',
      workflow_input: { text: '/目录文件统计工作流 本周', blocks: [] },
      status: 'completed',
      validation_status: 'passed',
      created_at: '2026-07-19T08:00:00Z',
      finished_at: '2026-07-19T08:01:00Z',
    }])
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    const runs = await client.listWorkflowRuns('wf_1', '报告', { limit: 20, offset: 40 })

    expect(captured[0]?.url).toBe('http://x/workflow-runs?workflow_id=wf_1&q=%E6%8A%A5%E5%91%8A&limit=20&offset=40')
    expect(runs[0]?.id).toBe('wfr_1')
    expect(runs[0]?.validation_status).toBe('passed')
  })

  it('lists Workflow results associated with one Session', async () => {
    installFetchStub([])
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    await client.listWorkflowRuns(undefined, undefined, { sessionId: 'session 1' })

    expect(captured[0]?.url).toBe('http://x/workflow-runs?session_id=session+1')
  })

  it('deletes one Workflow result without requiring a response body', async () => {
    installFetchStub({})
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    await client.deleteWorkflowRun('wfr 1')

    expect(captured[0]?.url).toBe('http://x/workflow-runs/wfr%201')
    expect(captured[0]?.method).toBe('DELETE')
  })

  it('lists Workflows associated with one Session', async () => {
    installFetchStub([])
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    await client.listWorkflows('session 1')

    expect(captured[0]?.url).toBe('http://x/workflows?session_id=session%201')
  })

  it('reads one Workflow result with its original input and files', async () => {
    installFetchStub({
      id: 'wfr_2',
      workflow_id: 'wf_1',
      workflow_name: '目录文件统计工作流',
      source_session_id: 'session_2',
      workflow_input: {
        text: '/目录文件统计工作流 使用 @上一份结果 和 @paper.csv',
        blocks: [
          { type: 'mention', id: 'wfr_1', label: '上一份结果', group: 'WorkflowRun' },
          { type: 'mention', id: 'mount_1', label: 'paper.csv', group: '文件/文件夹' },
        ],
      },
      status: 'completed',
      validation_status: 'passed',
      created_at: '2026-07-19T09:00:00Z',
      finished_at: '2026-07-19T09:01:00Z',
      run_dir: '/results/wf_1/wfr_2',
      files: [{ path: 'result/report.md', name: 'report.md', size: 12 }],
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    const run = await client.getWorkflowRun('wfr_2')

    expect(captured[0]?.url).toBe('http://x/workflow-runs/wfr_2')
    expect(run.workflow_input.blocks).toHaveLength(2)
    expect(run.files[0]?.path).toBe('result/report.md')

    installFetchStub({ path: 'result/report.md', name: 'report.md', size: 12, content: '# 报告\n', truncated: false })
    const file = await client.getWorkflowRunFile('wfr_2', 'result/report.md')
    expect(captured[1]?.url).toBe('http://x/workflow-runs/wfr_2/file?path=result%2Freport.md')
    expect(file.content).toBe('# 报告\n')

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: input.toString(),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: init?.headers as Record<string, string>,
      })
      return Promise.resolve(new Response(new Uint8Array([0, 1, 2]), {
        headers: { 'content-type': 'application/octet-stream' },
      }))
    }) as typeof fetch
    const raw = await client.getWorkflowRunFileRaw('wfr_2', 'result/report.bin')
    expect(captured[2]?.url).toBe('http://x/workflow-runs/wfr_2/file?path=result%2Freport.bin&raw=true')
    expect(Array.from(new Uint8Array(raw.content))).toEqual([0, 1, 2])
    expect(raw.mime).toBe('application/octet-stream')

    const archive = await client.exportWorkflowRun('wfr_2')
    expect(captured[3]?.url).toBe('http://x/workflow-runs/wfr_2?archive=true')
    expect(Array.from(archive)).toEqual([0, 1, 2])
  })
})

describe('AmphiClient mount endpoints', () => {
  it('lists Session file assets with their conversation relationship', async () => {
    installFetchStub([{
      id: 'mnt_1',
      session_id: 'session_1',
      session_title: '分析论文',
      name: 'paper.pdf',
      path: '/tmp/paper.pdf',
      kind: 'file',
      size_bytes: 42,
      item_count: null,
      exists: true,
      created_at: '2026-07-22T08:00:00Z',
    }])
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    const assets = await client.listSessionFileAssets()

    expect(captured[0]?.url).toBe('http://x/mounts')
    expect(assets[0]?.session_title).toBe('分析论文')
    expect(assets[0]?.size_bytes).toBe(42)
  })

  it('uploads bytes directly as a Session mount', async () => {
    installFetchStub({
      id: 'mnt_upload',
      name: 'shot.png',
      path: '/tmp/session/.internal/attachments/session_1/shot.png',
      kind: 'file',
      size_bytes: 3,
      item_count: null,
      exists: true,
      created_at: '2026-07-22T08:00:00Z',
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    const mount = await client.uploadMount(
      'session_1',
      'shot.png',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    )

    expect(captured[0]?.url).toBe('http://x/sessions/session_1/mounts/upload')
    expect(captured[0]?.method).toBe('POST')
    expect(mount.id).toBe('mnt_upload')
  })
})

describe('AmphiClient session transcript', () => {
  it('rehydrates the same rich-question contract used by live events', async () => {
    installFetchStub({
      messages: [],
      pending_request: {
        kind: 'choose',
        request_id: 'human-rich-1',
        prompt: '![图](file:///tmp/architecture.png)',
        questions: [{
          question: '选择方案',
          layout: 'review-list',
          allowOther: false,
          allowEmpty: true,
          minSelections: 0,
          maxSelections: 2,
          options: [
            { label: 'A', preview: '```mermaid\nflowchart LR\nA --> B\n```' },
            { label: 'B' },
          ],
        }],
      },
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    const transcript = await client.getSessionMessages('session_1')

    expect(transcript.pendingRequest).toEqual({
      kind: 'choose',
      requestId: 'human-rich-1',
      prompt: '![图](file:///tmp/architecture.png)',
      items: [],
      rules: [],
      questions: [{
        question: '选择方案',
        layout: 'review-list',
        allowOther: false,
        allowEmpty: true,
        minSelections: 0,
        maxSelections: 2,
        options: [
          { label: 'A', preview: '```mermaid\nflowchart LR\nA --> B\n```' },
          { label: 'B' },
        ],
      }],
    })
  })

  it('rehydrates a persisted Workflow runtime position', async () => {
    installFetchStub({
      messages: [],
      pending_request: null,
      thinking_mode: { mode: 'run_workflow', stage: 'validate' },
      workflow_run: {
        workflow_id: 'wf-report',
        generation: 'gen-report',
        workflow_name: '生成报告',
        source_session_id: 'session_1',
        phase: 'validate',
        step_index: 0,
        execution_steps: ['收集数据', '生成报告'],
        validation_steps: ['检查报告'],
      },
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    const transcript = await client.getSessionMessages('session_1')

    expect(transcript.thinkingMode).toEqual({ mode: 'run_workflow', stage: 'validate' })
    expect(transcript.workflowRun).toEqual({
      workflowId: 'wf-report',
      generation: 'gen-report',
      workflowName: '生成报告',
      sourceSessionId: 'session_1',
      phase: 'validate',
      stepIndex: 0,
      executionSteps: ['收集数据', '生成报告'],
      validationSteps: ['检查报告'],
    })
  })

  it('rehydrates the latest durable context usage snapshot', async () => {
    installFetchStub({
      messages: [],
      context_usage: {
        model_id: 'gpt-test',
        input_tokens: 60,
        output_tokens: 10,
        cached_input_tokens: 42,
        used_tokens: 60,
        usable_tokens: 100,
        percentage: 60,
        source: 'provider',
        breakdown: {
          system_prompt_tokens: 10,
          dynamic_context_tokens: 20,
          session_history_tokens: 20,
          current_input_tokens: 10,
        },
      },
    })
    const client = new AmphiClient({ baseUrl: 'http://x', token: 'tok' })

    const transcript = await client.getSessionMessages('session_1')

    expect(transcript.contextUsage).toEqual({
      modelId: 'gpt-test',
      inputTokens: 60,
      outputTokens: 10,
      cachedInputTokens: 42,
      usedTokens: 60,
      usableTokens: 100,
      percentage: 60,
      source: 'provider',
      breakdown: {
        systemPromptTokens: 10,
        dynamicContextTokens: 20,
        toolSchemaTokens: 0,
        sessionHistoryTokens: 20,
        currentInputTokens: 10,
      },
    })
  })
})

// ─── Request timeout ────────────────────────────────────────────────────────

describe('AmphiClient request timeout', () => {
  it('rejects with a readable timeout error when the daemon hangs', async () => {
    // Simulate a hung daemon: the fetch promise only settles when the timeout
    // signal aborts (mirrors real fetch semantics — reject with signal.reason).
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason))
      })) as typeof fetch
    const client = new AmphiClient({
      baseUrl: 'http://x',
      token: 't',
      requestTimeoutMs: 20,
    })
    await expect(client.getGatewayInfo()).rejects.toThrow(/请求超时/)
  })
})

// ─── Trailing slash normalization (regression) ──────────────────────────────

describe('AmphiClient URL normalization', () => {
  it('strips trailing slash from baseUrl', async () => {
    installFetchStub({ status: 'ok', version: 'x', started_at: 'x' })
    const client = new AmphiClient({
      baseUrl: 'http://127.0.0.1:7421/',
      token: null,
    })
    await client.getGatewayHealth()
    // No double-slash between baseUrl and path.
    expect(captured[0]?.url).toBe('http://127.0.0.1:7421/api/gateway/health')
  })
})
