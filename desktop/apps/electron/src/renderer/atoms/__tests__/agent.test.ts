/**
 * Tests for atoms/agent.ts — reducer / appendUserMessageAtom / transcript
 * Lazy-load concurrency guards and hasConversationAtom view selection.
 *
 * Isolate atom state with Jotai createStore(); IPC is replaced by a window.api mock.
 */
import { describe, it, expect, mock, setSystemTime } from 'bun:test'
import { createStore } from 'jotai'
import {
  applyAgentEventAtom,
  appendUserMessageAtom,
  currentAgentRunningAtom,
  currentBrowserAgentActiveAtom,
  currentPowerPointAgentActiveAtom,
  contextUsageFamily,
  currentMessagesAtom,
  currentPendingFrameworkInteractionAtom,
  currentStreamingAtom,
  currentWorkflowRunAtom,
  hasConversationAtom,
  hasPendingBuildConfirmAtom,
  hasPendingPermissionAtom,
  hasPendingTaskConfirmAtom,
  isBrowserAgentActionToolName,
  isPowerPointAgentActionToolName,
  loadSessionMessagesAtom,
  messageFamily,
  prepareInteractionContinuationAtom,
  purgeSessionAtom,
  runningSessionIdsAtom,
  streamingFamily,
  thinkingModeFamily,
  workflowRunFamily,
} from '../agent'
import { backendSnapshotAtom } from '../backend'
import { pendingBySessionAtom, setHumanRequestAtom } from '../human-request'
import { subagentsAtom } from '../subagents'
import { toastAtom } from '../toast'
import {
  briefFamily,
  currentBriefAtom,
  openSpecPreviewAtom,
} from '../build'
import { currentSessionFocusPaneAtom } from '../session-focus-pane'
import { browserNeedsAttentionFamily } from '../browser-attention'
import {
  powerPointNeedsAttentionFamily,
  setPowerPointNeedsAttentionAtom,
} from '../powerpoint-attention'
import {
  presentationPaneViewFamily,
  presentationTemplateSelectionFamily,
} from '../presentation'
import {
  SessionWorkbenchSurface,
  sessionWorkbenchSurfaceAtom,
  setSessionWorkbenchSurfaceAtom,
} from '../browser'
import {
  filesNeedsAttentionFamily,
  setFilesNeedsAttentionAtom,
} from '../files-attention'
import { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } from '../layout'
import { BackendState } from '../../../main/python-client/types'
import { AgentRole, type AgentMessage, type MessageBlock } from '@app/shared/types'
import {
  activeSessionIdAtom,
  materializeSessionAtom,
  newSessionAtom,
  renameSessionAtom,
  sessionCompletionSeqByIdAtom,
  replaceDraftWithDaemonIdAtom,
  sessionDraftsAtom,
  sessionsMetaAtom,
  setSessionDraftAtom,
} from '../sessions'

// Stub window.api with the surfaces the atoms reach into:
//   - sessions.*      (persistMessage / persistMeta — Phase B persistence)
//   - askUser.respond (respondAskUserAtom — Phase A HITL)
// Each is a no-op resolving Promise so the fire-and-forget calls don't blow up.
;(globalThis as { window?: unknown }).window = {
  api: {
    sessions: {
      listMeta: mock(async () => []),
      loadMessages: mock(async () => []),
      appendMessage: mock(async () => {}),
      saveMeta: mock(async () => {}),
      deleteSession: mock(async () => {}),
    },
    askUser: {
      respond: mock(async () => {}),
    },
  },
} as never

function makeStore() {
  return createStore()
}

function setupSession(store: ReturnType<typeof createStore>): string {
  const id = store.set(newSessionAtom)
  return id
}

/**
 * Create a materialized session through the production draft -> replaceDraftWithDaemonId path.
 *
 * Unmaterialized sessions share DRAFT_SESSION_ID, so two consecutive newSession calls return
 * the same ID. Tests that need **multiple independent sessions** must materialize them this way.
 * Literal IDs are insufficient because they do not enter sessionsMeta, which runningSessionIdsAtom traverses.
 */
function setupDaemonSession(store: ReturnType<typeof createStore>, daemonId: string): string {
  const draftId = store.set(newSessionAtom)
  store.set(replaceDraftWithDaemonIdAtom, { draftId, daemonId })
  return daemonId
}

describe('reducer: message lifecycle', () => {
  it('keeps a live human request rich payload and stable request id', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'human_request',
        requestId: 'human-rich-1',
        prompt: '**上下文**',
        questions: [{
          question: '选择方案',
          layout: 'review-list',
          allowOther: false,
          options: [{ label: 'A', preview: '![图](https://example.com/a.png)' }],
        }],
      },
    })

    expect(store.get(pendingBySessionAtom).get(id)).toEqual({
      sessionId: id,
      requestId: 'human-rich-1',
      prompt: '**上下文**',
      questions: [{
        question: '选择方案',
        layout: 'review-list',
        allowOther: false,
        options: [{ label: 'A', preview: '![图](https://example.com/a.png)' }],
      }],
    })
  })

  it('tracks running Sessions independently for sidebar status', () => {
    const store = makeStore()
    const first = setupDaemonSession(store, 'session_first')
    const second = setupDaemonSession(store, 'session_second')
    const stream = {
      messageId: 'm1',
      content: '',
      toolCalls: [],
      blocks: [],
      startedAt: Date.now(),
    }

    store.set(streamingFamily(first), stream)
    expect(store.get(runningSessionIdsAtom)).toEqual(new Set([first]))

    store.set(streamingFamily(second), { ...stream, messageId: 'm2' })
    expect(store.get(runningSessionIdsAtom)).toEqual(new Set([first, second]))

    store.set(streamingFamily(first), undefined)
    expect(store.get(runningSessionIdsAtom)).toEqual(new Set([second]))
  })

  it('restores parent activity from a durable blocking Child wait', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(materializeSessionAtom, id)
    store.set(activeSessionIdAtom, id)
    store.set(messageFamily(id), [{
      id: 'parked-parent',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'subagent',
        invocationId: 'child-1',
        goal: '检查结果',
        status: 'completed',
      }],
      done: true,
      turnStatus: 'awaiting_subagents',
      createdAt: 1,
    }])

    expect(store.get(currentAgentRunningAtom)).toBe(true)
    expect(store.get(runningSessionIdsAtom)).toEqual(new Set([id]))

    store.set(messageFamily(id), store.get(messageFamily(id)).map((message) => ({
      ...message,
      turnStatus: 'completed',
    })))
    expect(store.get(currentAgentRunningAtom)).toBe(false)
    expect(store.get(runningSessionIdsAtom)).toEqual(new Set())
  })

  it('creates a stream and appends text and thinking deltas', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    expect(store.get(currentStreamingAtom)?.messageId).toBe('m1')
    expect(store.get(currentStreamingAtom)?.content).toBe('')
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'm1', text: '收到。' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'm1', text: '我会帮你。' },
    })
    expect(store.get(currentStreamingAtom)?.content).toBe('收到。我会帮你。')
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'thinking_delta', messageId: 'm1', text: '分析中...' },
    })
    expect(store.get(currentStreamingAtom)?.thinking).toBe('分析中...')
  })

  it('model retry is transient state and clears after reconnecting', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'model_retry', active: true, attempt: 1, maxRetries: 5, delaySeconds: 2,
        discardTextChars: 0, discardReasoningChars: 0,
      },
    })
    expect(store.get(currentStreamingAtom)?.retry).toEqual({
      attempt: 1,
      maxRetries: 5,
      delaySeconds: 2,
    })

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'model_retry', active: false, attempt: 1, maxRetries: 5, delaySeconds: 0,
        discardTextChars: 0, discardReasoningChars: 0,
      },
    })
    expect(store.get(currentStreamingAtom)?.retry).toBeUndefined()
  })

  it('context compaction is transient state and clears after finishing', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'context_compaction', active: true },
    })
    expect(store.get(currentStreamingAtom)?.compacting).toBe(true)

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'context_compaction', active: false },
    })
    expect(store.get(currentStreamingAtom)?.compacting).toBeUndefined()
  })

  it('clears stale model retry state as soon as recovered output arrives', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'model_retry', active: true, attempt: 1, maxRetries: 5, delaySeconds: 2,
        discardTextChars: 0, discardReasoningChars: 0,
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'thinking_delta', messageId: 'm1', text: '恢复输出' },
    })

    expect(store.get(currentStreamingAtom)?.retry).toBeUndefined()
  })

  it('discards partial model deltas before rendering a retried stream', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'm1', text: '保留内容。半截🙂' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'thinking_delta', messageId: 'm1', text: '失败推理' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'model_retry', active: true, attempt: 1, maxRetries: 2, delaySeconds: 1,
        discardTextChars: 3, discardReasoningChars: 4,
      },
    })

    expect(store.get(currentStreamingAtom)?.content).toBe('保留内容。')
    expect(store.get(currentStreamingAtom)?.thinking).toBeUndefined()
    expect(store.get(currentStreamingAtom)?.blocks).toEqual([
      { type: 'text', text: '保留内容。' },
    ])
  })

  it('workflow progress updates the same section instead of duplicating it', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(workflowRunFamily(id), {
      workflowId: 'wf-report',
      generation: 'gen-report',
      workflowName: '生成报告',
      sourceSessionId: id,
      phase: 'execute',
      stepIndex: 1,
      executionSteps: ['收集数据', '生成报告'],
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    const progress = {
      type: 'workflow_progress' as const,
      workflowId: 'wf-report',
      generation: 'gen-report',
      workflowName: '生成报告',
      phase: 'execute' as const,
      stepIndex: 0,
      stepCount: 2,
      title: '收集数据',
      executionSteps: ['收集数据', '生成报告'],
    }
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { ...progress, status: 'running' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { ...progress, status: 'success', summary: '数据已收集' },
    })

    const blocks = store.get(currentStreamingAtom)?.blocks ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'workflow_step',
      status: 'success',
      summary: '数据已收集',
    })
    expect(store.get(currentWorkflowRunAtom)).toEqual({
      workflowId: 'wf-report',
      generation: 'gen-report',
      workflowName: '生成报告',
      sourceSessionId: id,
      phase: 'execute',
      stepIndex: 0,
      executionSteps: ['收集数据', '生成报告'],
    })

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })
    expect(store.get(currentWorkflowRunAtom)).toBeUndefined()
  })

  it('deduplicates a live Workflow result and persists it on message stop', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm-result', role: 'assistant' },
    })
    const result = {
      type: 'workflow_result' as const,
      runId: 'wfr-report',
      workflowId: 'wf-report',
      workflowName: '生成报告',
      status: 'completed' as const,
      createdAt: '2026-08-03T06:00:00Z',
      resultFileCount: 1,
    }
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { ...result, summary: '第一次投影' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { ...result, summary: '幂等更新' },
    })

    expect(store.get(currentStreamingAtom)?.blocks).toEqual([
      { ...result, summary: '幂等更新' },
    ])
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_stop', messageId: 'm-result', finalAnswer: '' },
    })
    expect(store.get(currentMessagesAtom)[0]?.blocks).toEqual([
      { ...result, summary: '幂等更新' },
    ])
  })

  it('message_stop finalizes streamingState into messages array', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'm1', text: 'hello' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'message_stop', messageId: 'm1', durationMs: 4567,
        completedAt: 1784637296000,
      },
    })
    expect(store.get(currentStreamingAtom)).toBeUndefined()
    const msgs = store.get(currentMessagesAtom)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.text).toBe('hello')
    expect(msgs[0]!.role).toBe('assistant')
    expect(msgs[0]!.done).toBe(true)
    expect(msgs[0]!.durationMs).toBe(4567)
    expect(msgs[0]!.completedAt).toBe(1784637296000)
  })

  it('message_start commits an uncommitted parked turn (permission card survives resume openTurn)', () => {
    // Reproduce the bug where all messages disappeared after approval. A parked approval turn
    // remained streaming and uncommitted; resuming opened a new turn, which overwrote its thinking
    // and approval card unless the parked turn was committed first.
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    // First turn: thinking plus approval card remains streaming without message_stop to simulate parking.
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'thinking_delta', messageId: 'm1', text: '分析中' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'permission_request',
        requestId: 'r1',
        items: [
          { callIndex: 0, tool: 'write_file', arguments: {}, capability: 'edit', boundary: 'out', label: '' },
        ],
        questions: [{ question: 'q', options: [{ label: 'allow' }, { label: 'deny' }] }],
      },
    })
    // Approving resumes through openTurn and starts a new m2 turn.
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm2', role: 'assistant' },
    })
    // After the fix, the parked turn is committed, its approval card survives instead of being
    // replaced by m2, and the new streaming turn is open.
    const perm = store
      .get(currentMessagesAtom)
      .flatMap((m) => m.blocks ?? [])
      .filter((b) => b.type === 'permission')
    expect(perm).toHaveLength(1)
    expect(store.get(currentStreamingAtom)?.messageId).toBe('m2')
  })

  it('continues a resumed interaction in one assistant reply', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'text_delta',
        messageId: 'm1',
        text: '我先确认范围。\n\n需要统计几层?',
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_stop', messageId: 'm1', finalAnswer: null },
    })
    store.set(prepareInteractionContinuationAtom, {
      sessionId: id,
      confirmation: { question: '需要统计几层?', response: '只统计第一层' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm2', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'm2', text: '\n\n已完成统计。' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_stop', messageId: 'm2', finalAnswer: '已完成统计。' },
    })

    const assistants = store.get(currentMessagesAtom).filter((message) => message.role === AgentRole.Assistant)
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.blocks).toEqual([
      { type: 'text', text: '我先确认范围。' },
      { type: 'confirmation', question: '需要统计几层?', response: '只统计第一层' },
      { type: 'text', text: '\n\n已完成统计。' },
    ])
    expect(assistants[0]?.finalAnswer).toBe('已完成统计。')
  })

  it('starts resumed elapsed time from now instead of the transcript ordering sequence', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(messageFamily(id), [{
      id: 'hydrated-review',
      role: AgentRole.Assistant,
      text: '请确认任务说明书。',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-review',
        taskMarkdown: '# Task\n内容',
        status: 'pending',
      }],
      done: true,
      createdAt: 1,
    }])

    const before = Date.now()
    store.set(prepareInteractionContinuationAtom, { sessionId: id })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'resumed-message', role: 'assistant' },
    })
    const after = Date.now()

    const startedAt = store.get(currentStreamingAtom)?.startedAt
    expect(startedAt).toBeGreaterThanOrEqual(before)
    expect(startedAt).toBeLessThanOrEqual(after)
  })

  it('continues accumulated execution time without counting the human wait', () => {
    const store = makeStore()
    const id = setupSession(store)
    const startedAt = Date.parse('2026-09-04T10:00:00Z')
    const parkedAt = startedAt + 12_000
    setSystemTime(new Date(parkedAt + 30_000))
    try {
      store.set(activeSessionIdAtom, id)
      store.set(messageFamily(id), [{
        id: 'hydrated-review',
        role: AgentRole.Assistant,
        text: '请确认任务说明书。',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-review',
          taskMarkdown: '# Task\n内容',
          status: 'pending',
        }],
        done: true,
        createdAt: 1,
        completedAt: parkedAt,
        durationMs: 12_000,
      }])

      store.set(prepareInteractionContinuationAtom, { sessionId: id })
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'message_start', messageId: 'resumed-message', role: 'assistant' },
      })

      expect(store.get(currentStreamingAtom)?.startedAt).toBe(parkedAt + 30_000 - 12_000)
    } finally {
      setSystemTime()
    }
  })

  it('does not carry an assistant reply from an earlier Session Turn', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(messageFamily(id), [
      {
        id: 'previous-assistant',
        role: AgentRole.Assistant,
        text: '上一个 Turn',
        toolCalls: [],
        blocks: [{ type: 'text', text: '上一个 Turn' }],
        done: true,
        createdAt: 1,
      },
      {
        id: 'current-user',
        role: AgentRole.User,
        text: '当前 Turn',
        toolCalls: [],
        blocks: [{ type: 'text', text: '当前 Turn' }],
        done: true,
        createdAt: 2,
      },
    ])
    store.set(prepareInteractionContinuationAtom, {
      sessionId: id,
      confirmation: { question: '继续吗?', response: '继续' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'current-assistant', role: 'assistant' },
    })

    expect(store.get(messageFamily(id)).map((message) => message.id)).toEqual([
      'previous-assistant',
      'current-user',
    ])
    expect(store.get(streamingFamily(id))?.blocks).toEqual([
      { type: 'confirmation', question: '继续吗?', response: '继续' },
    ])
  })

  it('maps every framework confirmation request to its pending block', () => {
    const cases = [
      {
        event: {
          type: 'workflow_confirm_request' as const,
          requestId: 'workflow-1',
          defaultName: '小红书内容爬虫',
          summary: '验证通过',
          operation: 'edit' as const,
          workflowId: 'wf_existing',
        },
        expected: {
          type: 'workflow_confirm',
          requestId: 'workflow-1',
          defaultName: '小红书内容爬虫',
          summary: '验证通过',
          operation: 'edit',
          workflowId: 'wf_existing',
          status: 'pending',
        } satisfies MessageBlock,
      },
      {
        event: {
          type: 'build_confirm_request' as const,
          requestId: 'build-1',
          goal: '每周生成目录报告',
          reason: '这项任务需要稳定复用。',
        },
        expected: {
          type: 'build_confirm',
          requestId: 'build-1',
          goal: '每周生成目录报告',
          reason: '这项任务需要稳定复用。',
          status: 'pending',
        } satisfies MessageBlock,
      },
      {
        event: {
          type: 'task_confirm_request' as const,
          requestId: 'task-1',
          taskMarkdown: '## Task\n\n```mermaid\nflowchart TD\nA --> B\n```',
          previousTaskMarkdown: '## Task\n\nPrevious review',
          operation: 'edit' as const,
          workflowId: 'wf-existing',
          originalTaskMarkdown: '## Task\n\nOld flow',
        },
        expected: {
          type: 'task_confirm',
          requestId: 'task-1',
          taskMarkdown: '## Task\n\n```mermaid\nflowchart TD\nA --> B\n```',
          previousTaskMarkdown: '## Task\n\nPrevious review',
          operation: 'edit',
          workflowId: 'wf-existing',
          originalTaskMarkdown: '## Task\n\nOld flow',
          status: 'pending',
        } satisfies MessageBlock,
      },
      {
        event: {
          type: 'presentation_outline_confirm_request' as const,
          requestId: 'outline-1',
        },
        expected: {
          type: 'presentation_outline_confirm',
          requestId: 'outline-1',
          status: 'pending',
        } satisfies MessageBlock,
      },
      {
        event: {
          type: 'presentation_template_selection_request' as const,
          requestId: 'template-selection-1',
        },
        expected: {
          type: 'presentation_template_selection',
          requestId: 'template-selection-1',
          status: 'pending',
        } satisfies MessageBlock,
      },
    ]

    for (const { event, expected } of cases) {
      const store = makeStore()
      const id = setupSession(store)
      store.set(activeSessionIdAtom, id)
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
      })
      store.set(applyAgentEventAtom, { sessionId: id, event })
      expect(store.get(currentStreamingAtom)?.blocks[0]).toEqual(expected)
    }
  })
})

describe('reducer: tool calls', () => {
  it('treats only interactive Browser tools as user-visible Browser activity', () => {
    // Exhaustive partition of `browser_tool_specs` in
    // `src/amphi_agent/tools/_browser.py`. Keep the catalog and this contract
    // synchronized when a Browser tool is added or renamed.
    const interactiveBrowserTools = [
      'browser_open',
      'browser_close',
      'browser_click',
      'browser_input',
      'browser_back',
      'browser_forward',
      'browser_reload',
      'browser_scroll',
      'browser_key',
      'browser_search',
      'browser_new_tab',
      'browser_switch_tab',
      'browser_close_tab',
      'browser_scroll_to_text',
      'browser_hover',
      'browser_focus',
      'browser_select',
      'browser_check',
      'browser_uncheck',
      'browser_fill_form',
      'browser_scroll_to_ref',
      'browser_double_click',
      'browser_upload_file',
      'browser_drag',
      'browser_evaluate_javascript',
      'browser_evaluate_javascript_on_ref',
      'browser_type_text',
      'browser_key_down',
      'browser_key_up',
      'browser_mouse_click',
      'browser_mouse_move',
      'browser_mouse_drag',
      'browser_mouse_down',
      'browser_mouse_up',
      'browser_resize',
    ]
    const observationOnlyBrowserTools = [
      'browser_snapshot',
      'browser_page_info',
      'browser_tabs',
      'browser_wait',
      'browser_wait_for_network_idle',
      'browser_screenshot',
      'browser_verify_text',
      'browser_verify_visible',
      'browser_verify_url',
      'browser_verify_title',
      'browser_get_dropdown_options',
      'browser_get_network_requests',
      'browser_get_cookies',
      'browser_verify_role_visible',
      'browser_verify_state',
      'browser_verify_value',
      'browser_get_console_messages',
    ]
    const nonVisualBrowserControlTools = [
      'browser_save_pdf',
      'browser_start_network_capture',
      'browser_stop_network_capture',
      'browser_setup_dialog_handler',
      'browser_handle_dialog',
      'browser_remove_dialog_handler',
      'browser_set_cookie',
      'browser_clear_cookies',
      'browser_save_storage_state',
      'browser_restore_storage_state',
      'browser_start_console_capture',
      'browser_stop_console_capture',
      'browser_start_tracing',
      'browser_add_trace_chunk',
      'browser_stop_tracing',
      'browser_start_video',
      'browser_stop_video',
      'load_browser_tools',
    ]

    expect(interactiveBrowserTools.every(isBrowserAgentActionToolName)).toBe(true)
    expect(observationOnlyBrowserTools.some(isBrowserAgentActionToolName)).toBe(false)
    expect(nonVisualBrowserControlTools.some(isBrowserAgentActionToolName)).toBe(false)
    expect([
      'browser_future_inspection',
      'read_file',
    ].some(isBrowserAgentActionToolName)).toBe(false)

    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(streamingFamily(id), {
      messageId: 'browser-observation',
      content: '',
      toolCalls: [{ toolUseId: 'snapshot', name: 'browser_snapshot', input: {} }],
      blocks: [],
      startedAt: Date.now(),
    })
    expect(store.get(currentBrowserAgentActiveAtom)).toBe(false)

    store.set(streamingFamily(id), {
      messageId: 'browser-action',
      content: '',
      toolCalls: [{ toolUseId: 'click', name: 'browser_click', input: { ref: 'button-1' } }],
      blocks: [],
      startedAt: Date.now(),
    })
    expect(store.get(currentBrowserAgentActiveAtom)).toBe(true)
  })

  it('arbitrates every Browser action at tool_call time, including an immediately completed call', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'browser-actions', role: 'assistant' },
    })

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_call',
        messageId: 'browser-actions',
        toolUseId: 'open-first',
        toolName: 'browser_open',
        input: { url: 'https://example.com' },
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_result',
        toolUseId: 'open-first',
        output: 'done',
        isError: false,
        durationMs: 0,
      },
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)

    store.set(setRightPanelCollapsedAtom, true)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_call',
        messageId: 'browser-actions',
        toolUseId: 'click-second',
        toolName: 'browser_click',
        input: { ref: 'button-1' },
      },
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(browserNeedsAttentionFamily(id))).toBe(true)
  })

  it('classifies visible PowerPoint actions and reveals their Session surface', () => {
    const visibleActions = [
      'view_ppt',
      'update_ppt_design',
      'edit_ppt_page',
      'insert_ppt_element',
      'remove_ppt_element',
      'insert_ppt_page',
      'remove_ppt_page',
      'move_ppt_page',
      'goto_ppt_page',
    ]
    expect(visibleActions.every(isPowerPointAgentActionToolName)).toBe(true)
    expect(isPowerPointAgentActionToolName('get_ppt_page')).toBe(false)

    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'powerpoint-write', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_call',
        messageId: 'powerpoint-write',
        toolUseId: 'view-deck',
        toolName: 'view_ppt',
        input: { target: 'quarterly-review' },
      },
    })

    expect(store.get(currentPowerPointAgentActiveAtom)).toBe(true)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Presentation)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(powerPointNeedsAttentionFamily(id))).toBe(true)

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_result',
        toolUseId: 'view-deck',
        output: 'done',
        isError: false,
        durationMs: 20,
      },
    })
    expect(store.get(currentPowerPointAgentActiveAtom)).toBe(false)
  })

  it('keeps Agent mode ahead of Browser action auto-reveal', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)
    store.set(thinkingModeFamily(id), { mode: 'build', stage: 'explore' })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'browser-under-agent', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_call',
        messageId: 'browser-under-agent',
        toolUseId: 'open-under-agent',
        toolName: 'browser_open',
        input: { url: 'https://example.com' },
      },
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(browserNeedsAttentionFamily(id))).toBe(true)
  })

  it('latches background Browser attention and purges all dock attention with the Session', () => {
    const store = makeStore()
    const viewedSessionId = setupSession(store)
    const backgroundSessionId = 'session-background-browser-attention'
    store.set(activeSessionIdAtom, backgroundSessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(activeSessionIdAtom, viewedSessionId)
    store.set(applyAgentEventAtom, {
      sessionId: backgroundSessionId,
      event: { type: 'message_start', messageId: 'browser-background', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: backgroundSessionId,
      event: {
        type: 'tool_call',
        messageId: 'browser-background',
        toolUseId: 'background-click',
        toolName: 'browser_click',
        input: { ref: 'button-1' },
      },
    })

    expect(store.get(browserNeedsAttentionFamily(backgroundSessionId))).toBe(true)
    expect(store.get(browserNeedsAttentionFamily(viewedSessionId))).toBe(false)
    store.set(setFilesNeedsAttentionAtom, {
      sessionId: backgroundSessionId,
      needsAttention: true,
    })
    expect(store.get(filesNeedsAttentionFamily(backgroundSessionId))).toBe(true)
    store.set(setPowerPointNeedsAttentionAtom, {
      sessionId: backgroundSessionId,
      needsAttention: true,
    })
    expect(store.get(powerPointNeedsAttentionFamily(backgroundSessionId))).toBe(true)

    store.set(purgeSessionAtom, backgroundSessionId)
    expect(store.get(browserNeedsAttentionFamily(backgroundSessionId))).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(backgroundSessionId))).toBe(false)
    expect(store.get(powerPointNeedsAttentionFamily(backgroundSessionId))).toBe(false)
    store.set(activeSessionIdAtom, backgroundSessionId)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
  })

  it('tool_call appends to streaming toolCalls', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_call',
        messageId: 'm1',
        toolUseId: 't1',
        toolName: 'WebFetch',
        input: { url: 'https://example.com' },
      },
    })
    expect(store.get(currentStreamingAtom)?.toolCalls).toHaveLength(1)
    expect(store.get(currentStreamingAtom)?.toolCalls[0]!.name).toBe('WebFetch')
  })

  it('tool_result attaches to matching toolUseId', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_call',
        messageId: 'm1',
        toolUseId: 't1',
        toolName: 'WebFetch',
        input: {},
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_result',
        toolUseId: 't1',
        output: 'OK',
        isError: false,
        durationMs: 500,
      },
    })
    const tc = store.get(currentStreamingAtom)?.toolCalls[0]
    expect(tc?.result?.output).toBe('OK')
    expect(tc?.result?.isError).toBe(false)
    expect(tc?.result?.durationMs).toBe(500)
  })
})

describe('reducer: subagent cards', () => {
  it('groups CLI Child Agents under the Bash call that launched them', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'parent', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_call',
        messageId: 'parent',
        toolUseId: 'call-bash',
        toolName: 'bash',
        input: { command: 'for file in *; do amphi agent run "$file"; done' },
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'subagent_event',
        invocationId: 'inv-child',
        parentToolCallId: 'call-bash',
        mode: 'rpc',
        goal: 'Inspect one file',
        status: 'queued',
        phase: 'started',
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'subagent_event',
        invocationId: 'inv-child',
        parentToolCallId: 'call-bash',
        mode: 'rpc',
        goal: '',
        status: 'running',
        phase: 'status',
      },
    })

    const streaming = store.get(streamingFamily(id))
    expect(streaming?.blocks).toHaveLength(1)
    expect(streaming?.blocks[0]).toMatchObject({
      type: 'tool',
      toolUseId: 'call-bash',
      subagents: [{
        invocationId: 'inv-child',
        goal: 'Inspect one file',
        status: 'running',
      }],
    })
    expect(streaming?.toolCalls[0]?.subagents).toHaveLength(1)
  })

  it('moves an early Child event under its Bash call when the tool stream arrives', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'subagent_event',
        invocationId: 'inv-early',
        parentToolCallId: 'call-bash',
        mode: 'rpc',
        goal: 'Inspect early.txt',
        status: 'queued',
        phase: 'started',
      },
    })
    expect(store.get(messageFamily(id))).toHaveLength(1)

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'parent', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'tool_call',
        messageId: 'parent',
        toolUseId: 'call-bash',
        toolName: 'bash',
        input: { command: 'amphi agent run inspect' },
      },
    })

    expect(store.get(messageFamily(id))).toHaveLength(0)
    expect(store.get(streamingFamily(id))?.blocks[0]).toMatchObject({
      type: 'tool',
      subagents: [{ invocationId: 'inv-early', status: 'queued' }],
    })
  })

  it('attaches a Child lifecycle card without copying its Session trace', () => {
    const store = makeStore()
    store.set(applyAgentEventAtom, {
      sessionId: 'session-child',
      event: { type: 'message_start', messageId: 'm-child', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: 'session-child',
      event: {
        type: 'subagent_event',
        invocationId: 'inv-child',
        mode: 'blocking',
        goal: 'Inspect files',
        status: 'created',
        phase: 'started',
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: 'session-child',
      event: {
        type: 'subagent_event',
        invocationId: 'inv-child',
        mode: 'blocking',
        goal: 'Inspect files',
        status: 'running',
        phase: 'status',
      },
    })

    const card = store.get(streamingFamily('session-child'))?.blocks[0]
    expect(card?.type).toBe('subagent')
    const child = store.get(subagentsAtom).get('inv-child')
    expect(child?.status).toBe('running')
    expect(child?.parentSessionId).toBe('session-child')
  })

  it('keeps a background Child out of the parent message stream', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'parent', role: 'assistant' },
    })

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'subagent_event',
        invocationId: 'background-child',
        mode: 'background',
        goal: 'Analyze in background',
        status: 'queued',
        phase: 'started',
      },
    })

    expect(store.get(streamingFamily(id))?.blocks).toEqual([])
    expect(store.get(subagentsAtom).get('background-child')).toMatchObject({
      parentSessionId: id,
      mode: 'background',
      status: 'queued',
    })
  })

  it('continues the parent reply when a waiting Child rejoins internally', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'parent-1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'subagent_event',
        invocationId: 'child-1',
        mode: 'blocking',
        goal: 'Inspect files',
        status: 'running',
        phase: 'started',
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_stop', messageId: 'parent-1', finalAnswer: null },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'subagent_event',
        invocationId: 'child-1',
        mode: 'blocking',
        goal: 'Inspect files',
        status: 'completed',
        phase: 'status',
        answer: 'Done',
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'parent-2', role: 'assistant' },
    })

    expect(store.get(messageFamily(id))).toHaveLength(0)
    const blocks = store.get(streamingFamily(id))?.blocks ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'subagent',
      invocationId: 'child-1',
      status: 'completed',
      answer: 'Done',
    })
    expect(store.get(sessionCompletionSeqByIdAtom)).toEqual({ 'child-1': 1 })
  })
})

describe('reducer: done / error / cancelled', () => {
  it('done(cancelled) flags its assistant message as stopped', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    const startedAt = Date.parse('2026-09-03T10:00:00+08:00')
    const completedAt = startedAt + 4_321
    setSystemTime(new Date(startedAt))
    try {
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
      })
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'text_delta', messageId: 'm1', text: 'partial' },
      })
      setSystemTime(new Date(completedAt))
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'message_stop', messageId: 'm1' },
      })
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'done', reason: 'cancelled', messageId: 'm1' },
      })
      const message = store.get(currentMessagesAtom).at(-1)
      expect(message?.stopped).toBe(true)
      expect(message?.completedAt).toBe(completedAt)
      expect(message?.durationMs).toBe(4_321)
    } finally {
      setSystemTime()
    }
  })

  it('done(cancelled) creates a stopped placeholder before the first content block', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'done', reason: 'cancelled', messageId: 'm-empty' },
    })

    const message = store.get(currentMessagesAtom).at(-1)
    expect(message).toMatchObject({
      id: 'm-empty',
      role: AgentRole.Assistant,
      stopped: true,
      blocks: [],
    })
  })

  it('cancelled message_stop timestamps a turn stopped before its first content block', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    const startedAt = Date.parse('2026-09-03T11:00:00+08:00')
    const completedAt = startedAt + 2_500
    setSystemTime(new Date(startedAt))
    try {
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'message_start', messageId: 'm-empty', role: 'assistant' },
      })
      setSystemTime(new Date(completedAt))
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'message_stop', messageId: 'm-empty', reason: 'cancelled' },
      })
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'done', reason: 'cancelled', messageId: 'm-empty' },
      })

      const message = store.get(currentMessagesAtom).at(-1)
      expect(message).toMatchObject({
        id: 'm-empty',
        stopped: true,
        completedAt,
        durationMs: 2_500,
      })
    } finally {
      setSystemTime()
    }
  })

  it('error finalizes partial as errored message', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'm1', text: 'partial' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'error', message: 'rate limited' },
    })
    expect(store.get(currentStreamingAtom)).toBeUndefined()
    const msgs = store.get(currentMessagesAtom)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.error).toBe('rate limited')
    expect(msgs[0]!.text).toBe('partial')
  })

  it('error with no active streaming still appends an errored message', () => {
    // Missing tokens, session-creation failures, or late errors after a turn ends have no active
    // streaming state. The reducer must still add a standalone error bubble; otherwise the error
    // reaches only logs and the UI stays blank, as observed for WebSocket 401 failures.
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'error', message: '后端网关未就绪' },
    })
    expect(store.get(currentStreamingAtom)).toBeUndefined()
    const msgs = store.get(currentMessagesAtom)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.error).toBe('后端网关未就绪')
    expect(msgs[0]!.role).toBe('assistant')
    expect(msgs[0]!.text).toBe('')
  })

  it('finalizes a failed interaction continuation as the same assistant reply', () => {
    const store = makeStore()
    const id = setupSession(store)
    const parked: AgentMessage = {
      id: 'parked',
      role: AgentRole.Assistant,
      text: '准备执行',
      toolCalls: [],
      blocks: [{ type: 'text', text: '准备执行' }],
      done: true,
      createdAt: 1,
    }
    store.set(messageFamily(id), [parked])
    const before = Date.now()
    store.set(prepareInteractionContinuationAtom, { sessionId: id })

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'error', message: '续跑失败' },
    })

    expect(store.get(streamingFamily(id))).toBeUndefined()
    const messages = store.get(messageFamily(id))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: parked.id,
      text: parked.text,
      blocks: parked.blocks,
      error: '续跑失败',
    })
    expect(messages[0]!.createdAt).toBeGreaterThanOrEqual(before)
    expect(messages[0]!.createdAt).toBeLessThanOrEqual(Date.now())
  })

  it('command_error shows a toast without corrupting the active reply', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(activeSessionIdAtom, id)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'm1', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'm1', text: '仍在生成' },
    })

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'command_error', message: '请等待当前回复完成' },
    })

    expect(store.get(currentStreamingAtom)?.content).toBe('仍在生成')
    expect(store.get(currentMessagesAtom)).toHaveLength(0)
    expect(store.get(toastAtom)?.message).toBe('请等待当前回复完成')
  })
})

describe('reducer: cross-session independence', () => {
  it('streamingStates is per-session: session B does not see session A streaming', () => {
    const store = makeStore()
    const idA = setupSession(store)
    // Use a literal ID because unmaterialized sessions are singletons and another newSession returns idA.
    const idB = 'session_b'
    store.set(applyAgentEventAtom, {
      sessionId: idA,
      event: { type: 'message_start', messageId: 'mA', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: idA,
      event: { type: 'text_delta', messageId: 'mA', text: 'hello A' },
    })
    // Switch active session to B
    store.set(activeSessionIdAtom, idB)
    expect(store.get(currentStreamingAtom)).toBeUndefined()
    // Switch back to A
    store.set(activeSessionIdAtom, idA)
    expect(store.get(currentStreamingAtom)?.content).toBe('hello A')
  })
})

describe('appendUserMessageAtom', () => {
  it('appends user message and materializes draft session', () => {
    const store = makeStore()
    const id = store.set(newSessionAtom) // newSessionAtom also sets it active
    store.set(appendUserMessageAtom, { sessionId: id, text: 'hi' })
    const msgs = store.get(currentMessagesAtom)
    // First is the optimistic user bubble; second is the synchronous gateway error emitted when
    // no backend token exists. Before the fix, the reducer swallowed it and left a blank UI;
    // now it becomes a visible error bubble.
    expect(msgs[0]!.text).toBe('hi')
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[1]!.role).toBe('assistant')
    // Assert only that an error is visible, not its exact i18n copy. The copy has changed before,
    // and binding it would make wording edits fail this test. The regression is the reducer
    // swallowing the error and leaving a blank UI, so non-empty content is sufficient.
    expect(msgs[1]!.error).toBeTruthy()
  })

  it('点「新会话」拿到的是空白会话 —— 上一次发送残留在草稿槽位上的内容被清掉', () => {
    // The draft slot has a singleton ID. A send that never reaches the daemon leaves optimistic
    // and error bubbles on it, while drafts are hidden from the sidebar. Opening New Session must
    // not reveal the previously submitted content.
    const store = makeStore()
    const id = store.set(newSessionAtom)
    store.set(appendUserMessageAtom, { sessionId: id, text: 'hi' })
    expect(store.get(currentMessagesAtom).length).toBeGreaterThan(0)

    store.set(newSessionAtom)

    expect(store.get(currentMessagesAtom)).toHaveLength(0)
  })

  it('clears the per-session draft on send', () => {
    // Bug repro: user typed → draft landed in the atom (300ms debounce). On
    // send the view switches Landing → Pipeline, FreeFormInput remounts and
    // re-seeds from sessionDraftsAtom. If send doesn't clear the draft, the
    // input shows the just-sent text again.
    const store = makeStore()
    const id = store.set(newSessionAtom)
    store.set(setSessionDraftAtom, { id, segments: [{ type: 'text', value: 'hello draft' }] })
    expect(store.get(sessionDraftsAtom)[id]).toEqual([{ type: 'text', value: 'hello draft' }])
    store.set(appendUserMessageAtom, { sessionId: id, text: 'hello draft' })
    // Send clears the draft entirely (key removed), so a remount re-seeds empty.
    expect(store.get(sessionDraftsAtom)[id]).toBeUndefined()
  })

  it('keeps a resumed human answer inside the stopped assistant process', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(materializeSessionAtom, id)
    store.set(activeSessionIdAtom, id)
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)
    store.set(messageFamily(id), [
      {
        id: 'root-user',
        role: AgentRole.User,
        text: '/build report',
        toolCalls: [],
        blocks: [{ type: 'text', text: '/build report' }],
        done: true,
        createdAt: 1,
      },
      {
        id: 'parked-assistant',
        role: AgentRole.Assistant,
        text: '我先确认范围。\n\n需要统计几层?',
        toolCalls: [],
        blocks: [{ type: 'text', text: '我先确认范围。\n\n需要统计几层?' }],
        done: true,
        finalAnswer: null,
        createdAt: 2,
      },
    ])
    store.set(setHumanRequestAtom, {
      sessionId: id,
      questions: [{ question: '需要统计几层?', options: [] }],
    })

    store.set(appendUserMessageAtom, { sessionId: id, text: '只统计第一层' })
    expect(store.get(messageFamily(id)).filter((message) => message.role === AgentRole.User)).toHaveLength(1)

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'resumed-assistant', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'resumed-assistant', text: '继续探索中。' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_stop', messageId: 'resumed-assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'done', reason: 'cancelled', messageId: 'resumed-assistant' },
    })

    const messages = store.get(messageFamily(id))
    expect(messages.map((message) => message.role)).toEqual([AgentRole.User, AgentRole.Assistant])
    expect(messages[1]?.stopped).toBe(true)
    expect(messages[1]?.blocks).toEqual([
      { type: 'text', text: '我先确认范围。' },
      { type: 'confirmation', question: '需要统计几层?', response: '只统计第一层' },
      { type: 'text', text: '继续探索中。' },
    ])
  })

  it('treats direct composer input as a reply to every pending confirmation card', () => {
    const cases: Array<{ block: MessageBlock; question: string }> = [
      {
        block: {
          type: 'build_confirm',
          requestId: 'build-1',
          goal: '构建目录统计工作流',
          status: 'pending',
        },
        question: '工作流构建确认',
      },
      {
        block: {
          type: 'task_confirm',
          requestId: 'task-1',
          taskMarkdown: '# Task',
          status: 'pending',
        },
        question: '任务说明书确认',
      },
      {
        block: {
          type: 'workflow_confirm',
          requestId: 'workflow-1',
          defaultName: '目录统计',
          status: 'pending',
        },
        question: '工作流保存确认',
      },
      {
        block: {
          type: 'presentation_outline_confirm',
          requestId: 'outline-1',
          status: 'pending',
        },
        question: 'PPT 大纲已生成',
      },
    ]

    for (const { block, question } of cases) {
      const store = makeStore()
      const id = setupSession(store)
      store.set(materializeSessionAtom, id)
      store.set(activeSessionIdAtom, id)
      store.set(backendSnapshotAtom, {
        state: BackendState.Ready,
        endpoint: {
          baseUrl: 'http://127.0.0.1:7421',
          token: 'test-token',
          version: null,
          startedAt: null,
          wsPath: null,
        },
        lastError: null,
      } as never)
      store.set(messageFamily(id), [
        {
          id: 'original-user',
          role: AgentRole.User,
          text: '构建工作流',
          toolCalls: [],
          done: true,
          createdAt: 1,
        },
        {
          id: 'parked-assistant',
          role: AgentRole.Assistant,
          text: '',
          toolCalls: [],
          blocks: [block],
          done: true,
          finalAnswer: null,
          createdAt: 2,
        },
      ])

      expect(store.get(currentPendingFrameworkInteractionAtom)?.requestId).toBe(
        'requestId' in block ? block.requestId : undefined,
      )
      store.set(appendUserMessageAtom, {
        sessionId: id,
        text: '请结合整张卡片继续调整',
      })

      expect(store.get(currentPendingFrameworkInteractionAtom)).toBeNull()
      expect(
        store.get(messageFamily(id)).filter((message) => message.role === AgentRole.User),
      ).toHaveLength(1)
      store.set(applyAgentEventAtom, {
        sessionId: id,
        event: { type: 'message_start', messageId: 'resumed-assistant', role: 'assistant' },
      })
      expect(store.get(streamingFamily(id))?.blocks).toEqual([{
        type: 'confirmation',
        kind: 'confirmation_message',
        question,
        response: '请结合整张卡片继续调整',
      }])
    }
  })

  it('does not resurrect an older pending card after the tail interaction is answered', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(materializeSessionAtom, id)
    store.set(activeSessionIdAtom, id)
    store.set(messageFamily(id), [
      {
        id: 'old-permission',
        role: AgentRole.Assistant,
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'permission',
          requestId: 'permission-old',
          items: [],
          questions: [],
        }],
        done: true,
        createdAt: 1,
      },
      {
        id: 'old-build',
        role: AgentRole.Assistant,
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'build_confirm',
          requestId: 'build-old',
          goal: '旧工作流',
          status: 'pending',
        }],
        done: true,
        createdAt: 2,
      },
      {
        id: 'old-task',
        role: AgentRole.Assistant,
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-old',
          taskMarkdown: '# 旧任务',
          status: 'pending',
        }],
        done: true,
        createdAt: 3,
      },
      {
        id: 'current-workflow',
        role: AgentRole.Assistant,
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'workflow_confirm',
          requestId: 'workflow-current',
          defaultName: '当前工作流',
          status: 'pending',
        }],
        done: true,
        createdAt: 4,
      },
    ])

    expect(store.get(currentPendingFrameworkInteractionAtom)?.requestId).toBe('workflow-current')
    store.set(appendUserMessageAtom, {
      sessionId: id,
      text: '先根据整体意见修改',
    })

    expect(store.get(currentPendingFrameworkInteractionAtom)).toBeNull()
    expect(store.get(hasPendingPermissionAtom)).toBe(false)
    expect(store.get(hasPendingBuildConfirmAtom)).toBe(false)
    expect(store.get(hasPendingTaskConfirmAtom)).toBe(false)
  })
})

describe('loadSessionMessagesAtom', () => {
  /** Mock GET /sessions/{id}/messages returning {messages, pending_request} with manually resolved fetches. */
  function installDaemon(
    store: ReturnType<typeof makeStore>,
    messages: AgentMessage[],
    pendingRequest: unknown = null,
    thinkingMode: unknown = null,
    contextUsage: unknown = null,
  ) {
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fetchMock = mock(async (_input: RequestInfo | URL) => {
      await gate
      return new Response(JSON.stringify({
        messages,
        pending_request: pendingRequest,
        thinking_mode: thinkingMode,
        context_usage: contextUsage,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as never
    return { fetchMock, release }
  }

  const serverMsg: AgentMessage = {
    id: 'srv-m1',
    role: AgentRole.Assistant,
    text: '历史回答',
    toolCalls: [],
    done: true,
    createdAt: 1,
  }

  it('dedupes concurrent loads for the same session (one hydration pair)', async () => {
    const store = makeStore()
    const { fetchMock, release } = installDaemon(store, [serverMsg])
    const p1 = store.set(loadSessionMessagesAtom, 'sess-1')
    const p2 = store.set(loadSessionMessagesAtom, 'sess-1') // Rapid A -> B -> A switch.
    release()
    await Promise.all([p1, p2])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.get(messageFamily('sess-1')).map((m) => m.id)).toEqual(['srv-m1'])
  })

  it('restores durable context usage when a session transcript is hydrated', async () => {
    const store = makeStore()
    const usage = {
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
    }
    const { release } = installDaemon(store, [serverMsg], null, null, usage)

    const pending = store.set(loadSessionMessagesAtom, 'sess-context')
    release()
    await pending

    expect(store.get(contextUsageFamily('sess-context'))).toEqual({
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
    })
  })

  it('刷新后乐观用户消息保留本地 id —— 换 key 会重挂气泡、重播入场动画', async () => {
    // The daemon emits session_completed after every turn and the frontend reloads the transcript.
    // Optimistic messages use `u-<uuid>`, while the daemon returns `<session>:u0`. Replacing the ID
    // changes the React key, remounts the bubble, and replays the 150 ms fade as a visible flash.
    const store = makeStore()
    const optimistic: AgentMessage = {
      id: 'u-local-uuid',
      role: AgentRole.User,
      text: '你好',
      toolCalls: [],
      done: true,
      createdAt: 1,
    }
    store.set(messageFamily('sess-echo'), [optimistic])
    const remoteUser: AgentMessage = {
      id: 'sess-echo:u0',
      role: AgentRole.User,
      text: '你好',
      toolCalls: [],
      blocks: [{ type: 'text', text: '你好' }],
      done: true,
      createdAt: 1,
    }
    const remoteReply: AgentMessage = {
      id: 'sess-echo:0',
      role: AgentRole.Assistant,
      text: '你好！',
      toolCalls: [],
      done: true,
      createdAt: 2,
    }
    const { release } = installDaemon(store, [remoteUser, remoteReply])
    const pending = store.set(loadSessionMessagesAtom, 'sess-echo')
    release()
    await pending

    const rows = store.get(messageFamily('sess-echo'))
    // Preserve identity so the key stays stable and the bubble does not remount.
    expect(rows.map((m) => m.id)).toEqual(['u-local-uuid', 'sess-echo:0'])
    // Still use daemon content because it includes blocks absent from the optimistic message.
    expect(rows[0]!.blocks).toEqual([{ type: 'text', text: '你好' }])
  })

  it('discards a stale transcript when the session was written during fetch', async () => {
    const store = makeStore()
    const { release } = installDaemon(store, [serverMsg])
    const pending = store.set(loadSessionMessagesAtom, 'sess-2')
    // While loading, the user sends an optimistic message that an unguarded replacement would erase.
    const optimistic: AgentMessage = {
      id: 'local-m1',
      role: AgentRole.User,
      text: '刚发的',
      toolCalls: [],
      done: true,
      createdAt: 2,
    }
    store.set(messageFamily('sess-2'), [optimistic])
    release()
    await pending
    expect(store.get(messageFamily('sess-2')).map((m) => m.id)).toEqual(['local-m1'])
  })

  it('discards a transcript fetch that races with a new live reply', async () => {
    const store = makeStore()
    const localUser: AgentMessage = {
      id: 'local-user',
      role: AgentRole.User,
      text: '继续执行',
      toolCalls: [],
      blocks: [{ type: 'text', text: '继续执行' }],
      done: true,
      createdAt: 1,
    }
    store.set(messageFamily('sess-race'), [localUser])
    const { release } = installDaemon(store, [serverMsg])

    const pending = store.set(loadSessionMessagesAtom, 'sess-race')
    store.set(applyAgentEventAtom, {
      sessionId: 'sess-race',
      event: { type: 'message_start', messageId: 'live-reply', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: 'sess-race',
      event: { type: 'text_delta', messageId: 'live-reply', text: '实时结果' },
    })
    release()
    await pending

    expect(store.get(messageFamily('sess-race'))).toEqual([localUser])
    expect(store.get(streamingFamily('sess-race'))?.content).toBe('实时结果')
  })

  it('keeps one logical reply across A→B→A and skips stale hydration while it streams', async () => {
    const store = makeStore()
    const sessionA = setupSession(store)
    const sessionB = setupSession(store)
    const user: AgentMessage = {
      id: 'user-a',
      role: AgentRole.User,
      text: '构建工作流',
      toolCalls: [],
      blocks: [{ type: 'text', text: '构建工作流' }],
      done: true,
      createdAt: 1,
    }
    const parked: AgentMessage = {
      id: 'parked-a',
      role: AgentRole.Assistant,
      text: '准备验证。',
      toolCalls: [],
      blocks: [
        { type: 'text', text: '准备验证。' },
        {
          type: 'permission',
          requestId: 'permission-a',
          decided: true,
          items: [],
          questions: [],
        },
      ],
      done: true,
      createdAt: 2,
    }
    store.set(messageFamily(sessionA), [user, parked])
    store.set(prepareInteractionContinuationAtom, { sessionId: sessionA })
    store.set(applyAgentEventAtom, {
      sessionId: sessionA,
      event: { type: 'message_start', messageId: 'resumed-a', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: sessionA,
      event: { type: 'text_delta', messageId: 'resumed-a', text: '第一段。' },
    })

    store.set(activeSessionIdAtom, sessionB)
    store.set(applyAgentEventAtom, {
      sessionId: sessionA,
      event: { type: 'text_delta', messageId: 'resumed-a', text: '隐藏时继续。' },
    })
    store.set(activeSessionIdAtom, sessionA)

    const staleParked: AgentMessage = {
      ...parked,
      id: 'daemon-parked',
      blocks: parked.blocks?.map((block) =>
        block.type === 'permission' ? { ...block, decided: undefined } : block,
      ),
    }
    const { fetchMock } = installDaemon(store, [user, staleParked])
    await store.set(loadSessionMessagesAtom, sessionA)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.get(messageFamily(sessionA))).toEqual([user])
    expect(store.get(streamingFamily(sessionA))?.blocks).toEqual([
      { type: 'text', text: '准备验证。' },
      {
        type: 'permission',
        requestId: 'permission-a',
        decided: true,
        items: [],
        questions: [],
      },
      { type: 'text', text: '第一段。隐藏时继续。' },
    ])
    const assistantCount = (
      store.get(messageFamily(sessionA)).filter((message) => message.role === AgentRole.Assistant).length +
      (store.get(streamingFamily(sessionA)) ? 1 : 0)
    )
    expect(assistantCount).toBe(1)
  })

  it('keeps a pre-existing optimistic user message while the daemon transcript is behind', async () => {
    const store = makeStore()
    const optimistic: AgentMessage = {
      id: 'u-local-first-message',
      role: AgentRole.User,
      text: '新会话首条消息',
      toolCalls: [],
      done: true,
      createdAt: 1,
    }
    store.set(messageFamily('sess-new'), [optimistic])
    const { release } = installDaemon(store, [])

    const pending = store.set(loadSessionMessagesAtom, 'sess-new')
    release()
    await pending

    expect(store.get(messageFamily('sess-new'))).toEqual([optimistic])
  })

  it('hydrates a new Build without reusing the previous Build presentation', async () => {
    const store = makeStore()
    const sessionId = setupSession(store)
    const oldReview: AgentMessage = {
      id: 'assistant-old-review',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-old-review',
        taskMarkdown: '# Task\nOld definition',
        status: 'confirmed',
      }],
      done: true,
      createdAt: 1,
    }
    store.set(thinkingModeFamily(sessionId), { mode: 'normal', stage: null })
    store.set(briefFamily(sessionId), '# Task\nOld definition')
    store.set(openSpecPreviewAtom)

    const { release } = installDaemon(store, [oldReview], null, {
      mode: 'build',
      stage: 'clarify',
    })
    const pending = store.set(loadSessionMessagesAtom, sessionId)
    release()
    await pending

    expect(store.get(thinkingModeFamily(sessionId))).toEqual({
      mode: 'build',
      stage: 'clarify',
    })
    expect(store.get(briefFamily(sessionId))).toBeNull()
    expect(store.get(currentBriefAtom)).toBeNull()
    expect(store.get(currentSessionFocusPaneAtom)).toBeNull()
  })

  it('rehydrates an option-less pending ask as an interaction card without an extra message', async () => {
    const store = makeStore()
    const { release } = installDaemon(store, [serverMsg], {
      kind: 'choose',
      questions: [{ question: '爬虫目标是什么?', options: [] }],
    })
    const p = store.set(loadSessionMessagesAtom, 'sess-3')
    release()
    await p
    const msgs = store.get(messageFamily('sess-3'))
    expect(msgs.map((message) => message.id)).toEqual(['srv-m1'])
    expect(store.get(pendingBySessionAtom).get('sess-3')?.questions[0]?.question).toBe('爬虫目标是什么?')
  })

  it('rehydrates an ask that carries options into the banner (no extra message)', async () => {
    const store = makeStore()
    const { release } = installDaemon(store, [serverMsg], {
      kind: 'choose',
      questions: [{ question: 'pick one', options: [{ label: 'a' }] }],
    })
    const p = store.set(loadSessionMessagesAtom, 'sess-4')
    release()
    await p
    expect(store.get(messageFamily('sess-4')).map((m) => m.id)).toEqual(['srv-m1'])
    expect(store.get(pendingBySessionAtom).get('sess-4')?.questions[0]?.question).toBe('pick one')
  })
})

describe('hasConversationAtom', () => {
  it('draft with no messages → Landing (false)', () => {
    const store = makeStore()
    setupSession(store) // fresh draft, active
    expect(store.get(hasConversationAtom)).toBe(false)
  })

  it('materialized session stays in conversation view even while messages are empty', () => {
    // Regression: while switching to a non-draft session, loadMessages is pending and
    // currentMessages is briefly empty. This must not flash back to Landing.
    const store = makeStore()
    const id = setupSession(store)
    store.set(materializeSessionAtom, id)
    expect(store.get(currentMessagesAtom)).toHaveLength(0)
    expect(store.get(hasConversationAtom)).toBe(true)
  })

  it('draft with an optimistic message → conversation view', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(messageFamily(id), [
      {
        id: 'm1',
        role: AgentRole.User,
        text: 'hi',
        toolCalls: [],
        done: true,
        createdAt: 1,
      },
    ])
    expect(store.get(hasConversationAtom)).toBe(true)
  })
})

describe('reducer: stage (build focus mode)', () => {
  it('stage event records the two-layer thinking position; purge clears it', async () => {
    const store = makeStore()
    const id = setupSession(store)
    expect(store.get(thinkingModeFamily(id))).toBeNull()
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'build', stage: 'clarify' } },
    })
    expect(store.get(thinkingModeFamily(id))).toEqual({ mode: 'build', stage: 'clarify' })
    // Clean-build close frame collapses back to normal with a null stage.
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })
    expect(store.get(thinkingModeFamily(id))).toEqual({ mode: 'normal', stage: null })
    store.set(purgeSessionAtom, id)
    expect(store.get(thinkingModeFamily(id))).toBeNull()
  })

  it('records ordered Build boundaries, dedupes resumes, and preserves stage returns', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'build-message', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'build', stage: 'clarify' } },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'thinking_delta', messageId: 'build-message', text: '整理需求' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'build', stage: 'clarify' } },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'build', stage: 'explore' } },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'text_delta', messageId: 'build-message', text: '完成探路' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'build', stage: 'clarify' } },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })

    const blocks = store.get(streamingFamily(id))?.blocks ?? []
    expect(
      blocks
        .filter((block): block is Extract<MessageBlock, { type: 'build_stage' }> => (
          block.type === 'build_stage'
        ))
        .map((block) => block.stage),
    ).toEqual(['clarify', 'explore', 'clarify', null])
    expect(blocks.map((block) => block.type)).toEqual([
      'build_stage',
      'thinking',
      'build_stage',
      'text',
      'build_stage',
      'build_stage',
    ])
  })

  it('releases transient presentation UI state when a template request finishes or the session is purged', () => {
    const store = makeStore()
    const id = setupSession(store)
    const requestId = 'presentation-template-request'
    const selection = presentationTemplateSelectionFamily(requestId)
    const paneView = presentationPaneViewFamily(id)
    store.set(selection, 'template-1')
    store.set(paneView, 'templates')

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'stage',
        position: {
          mode: 'presentation',
          stage: 'ppt_plan',
          presentationTemplateSelectionId: requestId,
          presentationTemplateSelectionStatus: 'pending',
        },
      },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'stage',
        position: {
          mode: 'presentation',
          stage: 'ppt_plan',
          presentationTemplateSelectionId: null,
          presentationTemplateSelectionStatus: 'selected',
        },
      },
    })

    expect(presentationTemplateSelectionFamily(requestId)).not.toBe(selection)
    expect(store.get(presentationTemplateSelectionFamily(requestId))).toBeNull()

    store.set(purgeSessionAtom, id)
    expect(presentationPaneViewFamily(id)).not.toBe(paneView)
    expect(store.get(presentationPaneViewFamily(id))).toBe('progress')
  })
})

describe('reducer: context usage', () => {
  it('stores the latest Session snapshot and purge clears it', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
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
    })
    expect(store.get(contextUsageFamily(id))?.percentage).toBe(60)
    store.set(purgeSessionAtom, id)
    expect(store.get(contextUsageFamily(id))).toBeNull()
  })
})

describe('reducer: title (session naming)', () => {
  it('title event renames the session meta live', () => {
    const store = makeStore()
    const id = setupSession(store)
    expect(store.get(sessionsMetaAtom).find((s) => s.id === id)?.title).toBe('新对话')
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'title', title: '目录文件统计工具' },
    })
    expect(store.get(sessionsMetaAtom).find((s) => s.id === id)?.title).toBe('目录文件统计工具')
  })

  it('a backend title pre-empts the done() truncated-opener rename', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(messageFamily(id), [
      { id: 'u1', role: AgentRole.User, text: '帮我做一个很长的需求', toolCalls: [], done: true, createdAt: 1 },
    ])
    // The backend title arrives first, so the title is no longer the default New Conversation.
    store.set(applyAgentEventAtom, { sessionId: id, event: { type: 'title', title: '模型标题' } })
    // done(end_turn) must then NOT overwrite it with the truncated opener.
    store.set(applyAgentEventAtom, { sessionId: id, event: { type: 'done', reason: 'end_turn' } })
    expect(store.get(sessionsMetaAtom).find((s) => s.id === id)?.title).toBe('模型标题')
  })

  it('a late backend title replaces the truncated-opener fallback', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(messageFamily(id), [
      { id: 'u1', role: AgentRole.User, text: '帮我做一个很长的需求', toolCalls: [], done: true, createdAt: 1 },
    ])
    store.set(applyAgentEventAtom, { sessionId: id, event: { type: 'done', reason: 'end_turn' } })
    expect(store.get(sessionsMetaAtom).find((s) => s.id === id)?.title).toBe('帮我做一个很长的需求')

    store.set(applyAgentEventAtom, { sessionId: id, event: { type: 'title', title: '模型标题' } })

    expect(store.get(sessionsMetaAtom).find((s) => s.id === id)?.title).toBe('模型标题')
  })

  it('a late backend title does not overwrite a manual rename', () => {
    const store = makeStore()
    const id = setupSession(store)
    store.set(renameSessionAtom, { id, title: '用户指定标题' })

    store.set(applyAgentEventAtom, { sessionId: id, event: { type: 'title', title: '模型标题' } })

    expect(store.get(sessionsMetaAtom).find((s) => s.id === id)?.title).toBe('用户指定标题')
  })
})

describe('reducer: session_completed', () => {
  it('marks the session unread (the sidebar red dot)', () => {
    const store = makeStore()
    const id = setupSession(store)
    const dot = () => store.get(sessionsMetaAtom).find((s) => s.id === id)?.hasRedDot
    expect(dot()).toBeFalsy()
    store.set(applyAgentEventAtom, { sessionId: id, event: { type: 'session_completed' } })
    expect(dot()).toBe(true)
    expect(store.get(sessionCompletionSeqByIdAtom)).toEqual({ [id]: 1 })
  })
})
