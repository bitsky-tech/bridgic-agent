/**
 * Tests for lib/turn-translate.ts — the pure daemon TurnEvent → AgentEvent
 * translator. No WebSocket / window.api needed; the translator is pure, so
 * tests feed frame sequences and assert the emitted AgentEvent stream.
 *
 * Locks the boundary behaviors that daemon-chat.ts used to bury inline:
 * message_start injection, FIFO tool pairing (+ unpaired warning, ex-bug3),
 * final/error terminality, sawContent answer-injection, payload validation.
 */
import { describe, it, expect } from 'bun:test'
import {
  translateTurnEvent,
  initialTranslatorState,
  type TranslatorState,
} from '../turnTranslate'
import type { AgentEvent, TurnEvent } from '@shared/types'

/** Feed a frame sequence through the translator, collecting events + warnings. */
function run(frames: TurnEvent[], messageId = 'm1') {
  let state: TranslatorState = initialTranslatorState
  const events: AgentEvent[] = []
  const warnings: string[] = []
  for (const f of frames) {
    const r = translateTurnEvent(f, messageId, state)
    state = r.state
    if (r.warning) warnings.push(r.warning)
    events.push(...r.events)
  }
  return { events, warnings, state }
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type)

describe('translateTurnEvent', () => {
  it('injects message_start before the first content event', () => {
    const { events } = run([{ event: 'token', data: { text: 'hi' } }])
    expect(types(events)).toEqual(['message_start', 'text_delta'])
    const start = events[0]
    if (start?.type !== 'message_start') throw new Error('expected message_start')
    expect(start.messageId).toBe('m1')
    expect(start.role).toBe('assistant')
  })

  it('emits message_start only once across a turn', () => {
    const { events } = run([
      { event: 'token', data: { text: 'a' } },
      { event: 'token', data: { text: 'b' } },
    ])
    expect(types(events).filter((t) => t === 'message_start')).toHaveLength(1)
    expect(types(events)).toEqual(['message_start', 'text_delta', 'text_delta'])
  })

  it('maps token → text_delta and reasoning → thinking_delta', () => {
    const { events } = run([
      { event: 'token', data: { text: 'x' } },
      { event: 'reasoning', data: { text: 'thinking' } },
    ])
    expect(types(events)).toEqual(['message_start', 'text_delta', 'thinking_delta'])
  })

  it('maps model retry lifecycle without creating message content', () => {
    const { events } = run([
      {
        event: 'model_retry',
        data: { active: true, attempt: 1, max_retries: 5, delay_seconds: 2 },
      },
      {
        event: 'model_retry',
        data: { active: false, attempt: 1, max_retries: 5, delay_seconds: 0 },
      },
    ])
    expect(types(events)).toEqual(['message_start', 'model_retry', 'model_retry'])
    expect(events[1]).toEqual({
      type: 'model_retry',
      active: true,
      attempt: 1,
      maxRetries: 5,
      delaySeconds: 2,
      discardTextChars: 0,
      discardReasoningChars: 0,
    })
  })

  it('maps context compaction lifecycle without creating message content', () => {
    const { events, warnings } = run([
      { event: 'context_compaction', data: { active: true } },
      { event: 'context_compaction', data: { active: false } },
    ])
    expect(warnings).toEqual([])
    expect(events).toEqual([
      { type: 'message_start', messageId: 'm1', role: 'assistant' },
      { type: 'context_compaction', active: true },
      { type: 'context_compaction', active: false },
    ])
  })

  it('maps context usage into the renderer snapshot shape', () => {
    const { events, warnings } = run([{
      event: 'context_usage',
      data: {
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
          dynamic_context_tokens: 10,
          tool_schema_tokens: 10,
          session_history_tokens: 20,
          current_input_tokens: 10,
        },
      },
    }])
    expect(warnings).toEqual([])
    expect(events).toEqual([
      { type: 'message_start', messageId: 'm1', role: 'assistant' },
      {
        type: 'context_usage',
        usage: {
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
            dynamicContextTokens: 10,
            toolSchemaTokens: 10,
            sessionHistoryTokens: 20,
            currentInputTokens: 10,
          },
        },
      },
    ])
  })

  it('drops empty token text (no text_delta)', () => {
    const { events } = run([{ event: 'token', data: { text: '' } }])
    expect(types(events)).toEqual(['message_start'])
  })

  it('pairs tool → tool_result FIFO and assigns synthetic ids', () => {
    const { events } = run([
      { event: 'tool', data: { name: 'Read', arguments: { path: '/a' } } },
      { event: 'tool', data: { name: 'Bash', arguments: { cmd: 'ls' } } },
      { event: 'tool_result', data: { success: true, error: null, output: 'A' } },
      { event: 'tool_result', data: { success: false, error: 'boom', output: '' } },
    ])
    const calls = events.filter((e) => e.type === 'tool_call')
    const results = events.filter((e) => e.type === 'tool_result')
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(2)
    // FIFO: first result pairs with first call's id.
    const call0 = calls[0]
    const res0 = results[0]
    const res1 = results[1]
    if (call0?.type !== 'tool_call' || res0?.type !== 'tool_result' || res1?.type !== 'tool_result')
      throw new Error('type narrow')
    expect(res0.toolUseId).toBe(call0.toolUseId)
    expect(res0.isError).toBe(false)
    expect(res0.output).toBe('A')
    // Second result is an error → output falls back to the error string.
    expect(res1.isError).toBe(true)
    expect(res1.output).toBe('boom')
  })

  it('passes through the daemon-measured duration_ms; 0 when absent (legacy frame)', () => {
    const { events } = run([
      { event: 'tool', data: { name: 'Bash', arguments: {} } },
      { event: 'tool_result', data: { success: true, error: null, output: 'x', duration_ms: 1234 } },
      { event: 'tool', data: { name: 'Read', arguments: {} } },
      { event: 'tool_result', data: { success: true, error: null, output: 'y' } },
    ])
    const results = events.filter((e) => e.type === 'tool_result')
    const [withTiming, legacy] = results
    if (withTiming?.type !== 'tool_result' || legacy?.type !== 'tool_result')
      throw new Error('type narrow')
    expect(withTiming.durationMs).toBe(1234)
    expect(legacy.durationMs).toBe(0)
  })

  it('warns (not silently drops) a tool_result with no pending tool_call (ex-bug3)', () => {
    const { events, warnings } = run([
      { event: 'tool_result', data: { success: true, error: null, output: 'orphan' } },
    ])
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(0)
    expect(warnings.some((w) => w.includes('without pending tool_call'))).toBe(true)
  })

  it('finalizes with message_stop + done(end_turn)', () => {
    const { events } = run([
      { event: 'token', data: { text: 'answer' } },
      {
        event: 'final',
        data: {
          answer: 'answer', tokens_spent: 5, input_tokens: 3, output_tokens: 2,
          duration_ms: 1234, completed_at: '2026-07-21T12:34:56+00:00',
        },
      },
    ])
    expect(types(events)).toEqual(['message_start', 'text_delta', 'message_stop', 'done'])
    const stop = events[events.length - 2]
    if (stop?.type !== 'message_stop') throw new Error('expected message_stop')
    expect(stop.durationMs).toBe(1234)
    expect(stop.completedAt).toBe(Date.parse('2026-07-21T12:34:56+00:00'))
    const done = events[events.length - 1]
    if (done?.type !== 'done') throw new Error('expected done')
    expect(done.reason).toBe('end_turn')
  })

  it('injects the final answer when no token deltas streamed', () => {
    const { events } = run([{ event: 'final', data: { answer: 'only-final', tokens_spent: 1 } }])
    // message_start, then injected text_delta, then stop + done.
    expect(types(events)).toEqual(['message_start', 'text_delta', 'message_stop', 'done'])
    const delta = events[1]
    if (delta?.type !== 'text_delta') throw new Error('expected text_delta')
    expect(delta.text).toBe('only-final')
  })

  it('does NOT inject answer when content already streamed', () => {
    const { events } = run([
      { event: 'token', data: { text: 'streamed' } },
      { event: 'final', data: { answer: 'streamed', tokens_spent: 1 } },
    ])
    // Only the original streamed text_delta — no duplicate injection.
    expect(types(events)).toEqual(['message_start', 'text_delta', 'message_stop', 'done'])
  })

  it('maps error frame to an error event with message fallback', () => {
    const { events } = run([{ event: 'error', data: { message: 'kaboom' } }])
    const err = events.find((e) => e.type === 'error')
    if (!err || err.type !== 'error') throw new Error('expected error')
    expect(err.message).toBe('kaboom')
  })

  it('maps cancelled to a stopped turn without an error', () => {
    const { events } = run([{ event: 'cancelled', data: {} }])
    expect(types(events)).toEqual(['message_start', 'message_stop', 'done'])
    const stop = events[events.length - 2]
    if (stop?.type !== 'message_stop') throw new Error('expected message_stop')
    expect(stop.reason).toBe('cancelled')
    const done = events[events.length - 1]
    if (done?.type !== 'done') throw new Error('expected done')
    expect(done.reason).toBe('cancelled')
  })

  it('stays terminal-safe on malformed final/error payloads', () => {
    const final = run([{ event: 'final', data: null } as unknown as TurnEvent])
    expect(types(final.events)).toEqual(['message_start', 'message_stop', 'done'])
    expect(final.warnings.some((w) => w.includes('final payload invalid'))).toBe(true)

    const err = run([{ event: 'error', data: 'oops' } as unknown as TurnEvent])
    const e = err.events.find((ev) => ev.type === 'error')
    if (!e || e.type !== 'error') throw new Error('expected error')
    expect(e.message).toBe('chat failed') // fallback
  })

  it('ignores unmodeled events (loop_abort) without emitting content', () => {
    const { events } = run([{ event: 'loop_abort', data: { reason: 'guard' } }])
    // Only the message_start prelude — loop_abort itself emits nothing.
    expect(types(events)).toEqual(['message_start'])
  })
})

describe('human_request routing (choose vs free-text)', () => {
  it('emits human_request for an ask that carries options', () => {
    const { events } = run([
      {
        event: 'human_request',
        data: {
          questions: [
            { question: 'Skill or code?', options: [{ label: 'skill' }, { label: 'code' }] },
          ],
        },
      },
    ])
    expect(types(events)).toEqual(['message_start', 'human_request'])
  })

  it('preserves the complete rich-question contract and request id', () => {
    const { events } = run([{
      event: 'human_request',
      data: {
        request_id: 'human-rich-1',
        prompt: '![架构图](file:///tmp/architecture.png)\n\n```mermaid\nflowchart LR\nA --> B\n```',
        questions: [{
          question: '选择方案',
          header: '方案',
          layout: 'review-list',
          multiSelect: true,
          allowOther: false,
          allowEmpty: true,
          emptyLabel: '都不选',
          minSelections: 0,
          maxSelections: 2,
          options: [
            { label: 'A', description: '首选', preview: '[详情](https://example.com/a)' },
            { label: 'B' },
          ],
        }],
      },
    }])
    const request = events[1]
    if (request?.type !== 'human_request') throw new Error('expected human_request')
    expect(request.requestId).toBe('human-rich-1')
    expect(request.prompt).toBe(
      '![架构图](file:///tmp/architecture.png)\n\n```mermaid\nflowchart LR\nA --> B\n```',
    )
    expect(request.questions[0]).toEqual({
      question: '选择方案',
      header: '方案',
      layout: 'review-list',
      multiSelect: true,
      allowOther: false,
      allowEmpty: true,
      emptyLabel: '都不选',
      minSelections: 0,
      maxSelections: 2,
      options: [
        { label: 'A', description: '首选', preview: '[详情](https://example.com/a)' },
        { label: 'B' },
      ],
    })
  })

  it('routes an all-option-less ask through the same interaction card', () => {
    const { events } = run([
      { event: 'token', data: { text: '前置说明' } },
      {
        event: 'human_request',
        data: {
          questions: [
            { question: '爬虫目标是什么?', options: [] },
            { question: '技术栈偏好?', options: [] },
          ],
        },
      },
      { event: 'final', data: { answer: null, tokens_spent: 0 } },
    ])
    expect(types(events)).toEqual([
      'message_start',
      'text_delta',
      'human_request',
      'message_stop',
      'done',
    ])
    const request = events[2]
    if (request?.type !== 'human_request') throw new Error('expected human_request')
    expect(request.questions.map((question) => question.question)).toEqual([
      '爬虫目标是什么?',
      '技术栈偏好?',
    ])
  })

  it('keeps the banner for a mixed ask (some questions carry options)', () => {
    const { events } = run([
      {
        event: 'human_request',
        data: {
          questions: [
            { question: 'pick one', options: [{ label: 'a' }] },
            { question: 'free text', options: [] },
          ],
        },
      },
    ])
    expect(types(events)).toEqual(['message_start', 'human_request'])
  })
})

describe('workflow confirm request routing', () => {
  it('maps workflow_confirm_request into a workflow confirm event', () => {
    const { events, warnings, state } = run([
      {
        event: 'workflow_confirm_request',
        data: {
          request_id: 'req-1',
          default_name: '小红书内容爬虫',
          summary: '验证通过',
          operation: 'edit',
          workflow_id: 'wf_existing',
        },
      },
    ])
    expect(types(events)).toEqual(['message_start', 'workflow_confirm_request'])
    const event = events[1]
    if (event?.type !== 'workflow_confirm_request') throw new Error('expected workflow confirm')
    expect(event.requestId).toBe('req-1')
    expect(event.defaultName).toBe('小红书内容爬虫')
    expect(event.summary).toBe('验证通过')
    expect(event.operation).toBe('edit')
    expect(event.workflowId).toBe('wf_existing')
    expect(state.sawContent).toBe(true)
    expect(warnings).toEqual([])
  })
})

describe('workflow progress routing', () => {
  it('maps one runtime section into a structured progress event', () => {
    const { events, warnings } = run([{
      event: 'workflow_progress',
      data: {
        workflow_id: 'wf-report',
        generation: 'gen-report',
        workflow_name: '生成报告',
        phase: 'execute',
        step_index: 0,
        step_count: 2,
        title: '收集数据',
        status: 'running',
        summary: null,
        execution_steps: ['收集数据', '生成报告'],
      },
    }])

    expect(types(events)).toEqual(['message_start', 'workflow_progress'])
    const event = events[1]
    if (event?.type !== 'workflow_progress') throw new Error('expected Workflow progress')
    expect(event.workflowId).toBe('wf-report')
    expect(event.generation).toBe('gen-report')
    expect(event.title).toBe('收集数据')
    expect(event.status).toBe('running')
    expect(event.executionSteps).toEqual(['收集数据', '生成报告'])
    expect(warnings).toEqual([])
  })
})

describe('workflow result routing', () => {
  it('maps a published Run into a durable result event', () => {
    const { events, warnings } = run([{
      event: 'workflow_result',
      data: {
        run_id: 'wfr-report',
        workflow_id: 'wf-report',
        workflow_name: '生成报告',
        status: 'completed',
        created_at: '2026-08-03T06:00:00Z',
        result_file_count: 1,
        summary: '报告已生成并通过验证。',
      },
    }])

    expect(types(events)).toEqual(['message_start', 'workflow_result'])
    expect(events[1]).toEqual({
      type: 'workflow_result',
      runId: 'wfr-report',
      workflowId: 'wf-report',
      workflowName: '生成报告',
      status: 'completed',
      createdAt: '2026-08-03T06:00:00Z',
      resultFileCount: 1,
      summary: '报告已生成并通过验证。',
    })
    expect(warnings).toEqual([])
  })
})

describe('build confirm request routing', () => {
  it('maps build_confirm_request into a Build proposal event', () => {
    const { events, warnings, state } = run([
      {
        event: 'build_confirm_request',
        data: {
          request_id: 'build-1',
          goal: '每周生成目录报告',
          reason: '这项任务需要稳定复用。',
        },
      },
    ])
    expect(types(events)).toEqual(['message_start', 'build_confirm_request'])
    const event = events[1]
    if (event?.type !== 'build_confirm_request') throw new Error('expected Build proposal')
    expect(event.requestId).toBe('build-1')
    expect(event.goal).toBe('每周生成目录报告')
    expect(event.reason).toBe('这项任务需要稳定复用。')
    expect(state.sawContent).toBe(true)
    expect(warnings).toEqual([])
  })
})

describe('task confirm request routing', () => {
  it('maps task_confirm_request into a task review event', () => {
    const { events, warnings, state } = run([
      {
        event: 'task_confirm_request',
        data: {
          request_id: 'task-1',
          task_markdown: '## Task\n\n```mermaid\nflowchart TD\nA --> B\n```',
          previous_task_markdown: '## Task\n\nPrevious review',
          operation: 'edit',
          workflow_id: 'wf-existing',
          original_task_markdown: '## Task\n\nOld flow',
        },
      },
    ])
    expect(types(events)).toEqual(['message_start', 'task_confirm_request'])
    const event = events[1]
    if (event?.type !== 'task_confirm_request') throw new Error('expected task confirm')
    expect(event.requestId).toBe('task-1')
    expect(event.taskMarkdown).toContain('flowchart TD')
    expect(event.previousTaskMarkdown).toContain('Previous review')
    expect(event.operation).toBe('edit')
    expect(event.workflowId).toBe('wf-existing')
    expect(event.originalTaskMarkdown).toContain('Old flow')
    expect(state.sawContent).toBe(true)
    expect(warnings).toEqual([])
  })
})

describe('stage frames', () => {
  it('maps stage → stage event carrying the two-layer {mode, stage}', () => {
    const { events, warnings } = run([
      { event: 'stage', data: { mode: 'build', stage: 'clarify' } },
    ])
    expect(types(events)).toEqual(['message_start', 'stage'])
    const stage = events[1]
    if (stage?.type !== 'stage') throw new Error('expected stage')
    expect(stage.position).toEqual({ mode: 'build', stage: 'clarify' })
    expect(warnings).toEqual([])
  })

  it('identifies the saved Workflow when entering edit clarify', () => {
    const { events, warnings } = run([
      {
        event: 'stage',
        data: { mode: 'build', stage: 'clarify', workflow_id: 'wf-existing' },
      },
    ])
    const stage = events[1]
    if (stage?.type !== 'stage') throw new Error('expected stage')
    expect(stage.position).toEqual({
      mode: 'build',
      stage: 'clarify',
      workflowId: 'wf-existing',
    })
    expect(warnings).toEqual([])
  })

  it('carries the Workflow Run cognitive stage', () => {
    const { events, warnings } = run([
      { event: 'stage', data: { mode: 'run_workflow', stage: 'execute' } },
    ])
    const stage = events[1]
    if (stage?.type !== 'stage') throw new Error('expected stage')
    expect(stage.position).toEqual({ mode: 'run_workflow', stage: 'execute' })
    expect(warnings).toEqual([])
  })

  it('carries the normal presentation frame (mode:normal, stage:null) through', () => {
    const { events, warnings } = run([{ event: 'stage', data: { mode: 'normal', stage: null } }])
    const stage = events[1]
    if (stage?.type !== 'stage') throw new Error('expected stage')
    expect(stage.position).toEqual({ mode: 'normal', stage: null })
    expect(warnings).toEqual([])
  })

  it('defaults an absent stage to null (older daemon / normal main turn)', () => {
    const { events, warnings } = run([{ event: 'stage', data: { mode: 'normal' } }])
    const stage = events[1]
    if (stage?.type !== 'stage') throw new Error('expected stage')
    expect(stage.position).toEqual({ mode: 'normal', stage: null })
    expect(warnings).toEqual([])
  })

  it('warns and skips a stage frame without a mode', () => {
    const { events, warnings } = run([{ event: 'stage', data: { stage: 'clarify' } }])
    expect(types(events)).toEqual(['message_start'])
    expect(warnings.length).toBe(1)
  })
})

describe('title frames (session naming)', () => {
  it('maps title → title event carrying the model title', () => {
    const { events, warnings } = run([{ event: 'title', data: { title: '目录文件统计工具' } }])
    expect(types(events)).toEqual(['message_start', 'title'])
    const title = events[1]
    if (title?.type !== 'title') throw new Error('expected title')
    expect(title.title).toBe('目录文件统计工具')
    expect(warnings).toEqual([])
  })

  it('warns and skips a title frame with no title field', () => {
    const { events, warnings } = run([{ event: 'title', data: {} } as unknown as TurnEvent])
    expect(types(events)).toEqual(['message_start'])
    expect(warnings.length).toBe(1)
  })

  it('skips an empty-string title with no warning (never overwrites a good title)', () => {
    const { events, warnings } = run([{ event: 'title', data: { title: '' } }])
    expect(types(events)).toEqual(['message_start'])
    expect(warnings).toEqual([])
  })

  it('permission_request: maps wire call_index→callIndex and carries request_id', () => {
    const { events } = run([
      {
        event: 'permission_request',
        data: {
          request_id: 'req-1',
          questions: [
            { question: 'Approve write_file?', options: [{ label: 'allow' }, { label: 'deny' }] },
          ],
          items: [
            {
              call_index: 2,
              tool: 'write_file',
              arguments: { path: 'a' },
              capability: 'write',
              boundary: 'out_of_bounds',
              label: 'why',
            },
          ],
        },
      } as unknown as TurnEvent,
    ])
    const ev = events.find((e) => e.type === 'permission_request')
    if (ev?.type !== 'permission_request') throw new Error('expected permission_request')
    expect(ev.requestId).toBe('req-1')
    expect(ev.items[0]?.callIndex).toBe(2) // snake call_index → camel callIndex
    expect(ev.items[0]?.tool).toBe('write_file')
  })

  it('permission_request: an all-option-less ask is dropped (not a permission card)', () => {
    const { events } = run([
      {
        event: 'permission_request',
        data: { request_id: 'r', questions: [{ question: 'x', options: [] }], items: [] },
      } as unknown as TurnEvent,
    ])
    expect(events.some((e) => e.type === 'permission_request')).toBe(false)
  })
})
