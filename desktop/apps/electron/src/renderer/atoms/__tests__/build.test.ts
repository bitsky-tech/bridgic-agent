/**
 * Tests for atoms/build.ts — focus-mode derivation off the thinking position
 * + brief family lifecycle. Network-touching loadSessionBriefAtom is covered
 * by its no-client early return (the daemon path needs a live backend).
 */
import { describe, it, expect } from 'bun:test'
import { createStore } from 'jotai'
import { i18n } from '../../lib/i18n'
import {
  applyAgentEventAtom,
  currentMessagesAtom,
  messageFamily,
  streamingFamily,
  thinkingModeFamily,
} from '../agent'
import {
  BUILD_STAGES,
  addPendingCommentAtom,
  allPendingCommentsAtom,
  briefFamily,
  clearPendingCommentsAtom,
  closeSpecPreviewAtom,
  composeCommentBatchText,
  currentBriefAtom,
  currentOriginalBriefAtom,
  currentPendingTaskConfirmAtom,
  currentSpecDraftAtom,
  currentTaskConfirmAtom,
  currentTaskDiffBaselineAtom,
  editBaselinePreviewAtom,
  focusModeAtom,
  isBuildStage,
  isFocusMode,
  loadSessionBriefAtom,
  openSpecPreviewAtom,
  originalBriefFamily,
  pendingCommentsAtom,
  purgeBuildState,
  removePendingCommentAtom,
  sendCommentBatchAtom,
  setAllPendingCommentsAtom,
  setSpecCommentDraftAtom,
  setSpecEditDraftAtom,
  setSpecInstructionDraftAtom,
  specPreviewArchivedAtom,
  specPreviewOpenAtom,
  type PendingComment,
} from '../build'
import { activeSessionIdAtom, newSessionAtom } from '../sessions'
import { currentSessionFocusPaneAtom } from '../session-focus-pane'
import { backendSnapshotAtom } from '../backend'
import { BackendState } from '../../../main/python-client/types'

describe('focus mode derivation', () => {
  it('isBuildStage accepts exactly the four pipeline stage units', () => {
    for (const stage of BUILD_STAGES) expect(isBuildStage(stage)).toBe(true)
    expect(isBuildStage('main')).toBe(false) // the normal-loop unit
    expect(isBuildStage('build')).toBe(false) // loop name, not a unit
    expect(isBuildStage(null)).toBe(false)
  })

  it('isFocusMode keys off the loop layer (mode === build)', () => {
    expect(isFocusMode({ mode: 'build', stage: 'clarify' })).toBe(true)
    expect(isFocusMode({ mode: 'build', stage: 'verify' })).toBe(true)
    // The clean-build close frame collapses the rail (normal + null stage).
    expect(isFocusMode({ mode: 'normal', stage: null })).toBe(false)
    expect(isFocusMode({ mode: 'normal', stage: 'main' })).toBe(false)
    expect(isFocusMode(null)).toBe(false)
  })

  it('focusModeAtom follows the active session thinking position', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    expect(store.get(focusModeAtom)).toBe(false)
    store.set(thinkingModeFamily(id), { mode: 'build', stage: 'explore' })
    expect(store.get(focusModeAtom)).toBe(true)
    store.set(thinkingModeFamily(id), { mode: 'build', stage: 'verify' })
    expect(store.get(focusModeAtom)).toBe(true)
    // Clean exit / abort both return to normal → rail collapses.
    store.set(thinkingModeFamily(id), { mode: 'normal', stage: null })
    expect(store.get(focusModeAtom)).toBe(false)
  })
})

describe('brief lifecycle', () => {
  it('currentBriefAtom reads the active session brief; purge clears it', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    expect(store.get(currentBriefAtom)).toBeNull()
    store.set(briefFamily(id), '# Task\nbuild a tool')
    expect(store.get(currentBriefAtom)).toBe('# Task\nbuild a tool')
    purgeBuildState(id)
    expect(store.get(briefFamily(id))).toBeNull() // fresh family atom after purge
  })

  it('clears the previous brief when the current Build has no task.md', async () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(thinkingModeFamily(id), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(id), '# Task\nStale definition')
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
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    try {
      await store.set(loadSessionBriefAtom, id)
      expect(store.get(briefFamily(id))).toBeNull()
      expect(store.get(currentBriefAtom)).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses the pending task review as the immediate preview source', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(briefFamily(id), '# Task\n旧内容')
    store.set(streamingFamily(id), {
      messageId: 'assistant-1',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-1',
        taskMarkdown: '# Task\n待确认的新内容',
        status: 'pending',
      }],
      startedAt: 1,
    })

    expect(store.get(currentTaskConfirmAtom)?.requestId).toBe('task-1')
    expect(store.get(currentBriefAtom)).toContain('待确认的新内容')
  })

  it('keeps an empty create baseline and prefers the previous review for later diffs', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(originalBriefFamily(id), '# Task\nUnrelated old edit')
    store.set(streamingFamily(id), {
      messageId: 'assistant-1',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-1',
        taskMarkdown: '# Task\nFirst draft',
        previousTaskMarkdown: '',
        operation: 'create',
        status: 'pending',
      }],
      startedAt: 1,
    })
    expect(store.get(currentTaskDiffBaselineAtom)).toBe('')

    store.set(streamingFamily(id), {
      messageId: 'assistant-2',
      content: '',
      toolCalls: [],
      blocks: [
        {
          type: 'task_confirm',
          requestId: 'task-1',
          taskMarkdown: '# Task\nFirst draft',
          operation: 'create',
          status: 'revision_requested',
        },
        {
          type: 'task_confirm',
          requestId: 'task-2',
          taskMarkdown: '# Task\nSecond draft',
          operation: 'create',
          status: 'pending',
        },
      ],
      startedAt: 2,
    })
    expect(store.get(currentTaskDiffBaselineAtom)).toBe('# Task\nFirst draft')
  })

  it('finds a persisted task review after its streaming turn is committed', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(messageFamily(id), [{
      id: 'assistant-1',
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-committed',
        taskMarkdown: '# Task\n内容',
        status: 'pending',
      }],
      done: true,
      createdAt: 1,
    }])

    expect(store.get(currentTaskConfirmAtom)?.requestId).toBe('task-committed')
  })

  it('keeps historical task snapshots without treating them as the current review', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(briefFamily(id), '# Task\n当前内容')
    store.set(messageFamily(id), [
      {
        id: 'old-task-review',
        role: 'assistant',
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-old',
          taskMarkdown: '# Task\n旧的待确认内容',
          status: 'pending',
        }],
        done: true,
        createdAt: 1,
      },
      {
        id: 'answered-tail',
        role: 'assistant',
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'confirmation',
          kind: 'confirmation_message',
          question: '工作流保存确认',
          response: '请继续调整。',
        }],
        done: true,
        createdAt: 2,
      },
    ])

    expect(store.get(currentTaskConfirmAtom)?.requestId).toBe('task-old')
    expect(store.get(currentPendingTaskConfirmAtom)).toBeNull()
    expect(store.get(currentBriefAtom)).toBe('# Task\n当前内容')
  })

  it('shows the restored original until an edit task review arrives', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(thinkingModeFamily(id), {
      mode: 'build',
      stage: 'clarify',
      workflowId: 'wf-existing',
    })
    store.set(originalBriefFamily(id), '# Task\n旧内容')
    store.set(briefFamily(id), '# Task\n旧内容')

    expect(store.get(editBaselinePreviewAtom)).toBe(true)
    expect(store.get(currentOriginalBriefAtom)).toContain('旧内容')

    store.set(streamingFamily(id), {
      messageId: 'assistant-edit-review',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-edit-review',
        taskMarkdown: '# Task\n新内容',
        status: 'pending',
      }],
      startedAt: Date.now(),
    })

    expect(store.get(editBaselinePreviewAtom)).toBe(false)
    expect(store.get(currentOriginalBriefAtom)).toContain('旧内容')
    expect(store.get(currentBriefAtom)).toContain('新内容')
  })

  it('retains the reviewed task as a read-only snapshot after the Workflow is saved', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(messageFamily(id), [{
      id: 'assistant-build',
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [
        {
          type: 'task_confirm',
          requestId: 'task-snapshot',
          taskMarkdown: '# Task\n最终内容',
          status: 'confirmed',
        },
        {
          type: 'workflow_confirm',
          requestId: 'workflow-saved',
          defaultName: '报告工作流',
          operation: 'create',
          status: 'confirmed',
        },
      ],
      done: true,
      createdAt: 1,
    }])
    store.set(briefFamily(id), null)
    store.set(thinkingModeFamily(id), { mode: 'normal', stage: null })

    expect(store.get(currentBriefAtom)).toContain('最终内容')
    expect(store.get(specPreviewArchivedAtom)).toBe(true)
  })

  it('starts a later Build without reviving the prior task and preserves resumable input', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'build', stage: 'clarify' } },
    })
    store.set(messageFamily(id), [{
      id: 'assistant-old-build',
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-old-build',
        taskMarkdown: '# Task\nOld definition',
        status: 'confirmed',
      }],
      done: true,
      createdAt: 1,
    }])
    store.set(briefFamily(id), '# Task\nOld definition')
    store.set(openSpecPreviewAtom)
    store.set(addPendingCommentAtom, { quote: 'Old definition', text: 'Old queued note' })
    store.set(setSpecCommentDraftAtom, { quote: 'Old definition', text: 'Old draft note' })
    store.set(setSpecInstructionDraftAtom, 'Old instruction')
    store.set(setSpecEditDraftAtom, '# Task\nUnsaved old edit')
    expect(store.get(specPreviewOpenAtom)).toBe(true)

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'build', stage: 'explore' } },
    })
    expect(store.get(pendingCommentsAtom)).toHaveLength(1)
    expect(store.get(currentSpecDraftAtom)).toEqual({
      comment: { quote: 'Old definition', text: 'Old draft note' },
      instruction: 'Old instruction',
      edit: '# Task\nUnsaved old edit',
    })

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'normal', stage: null } },
    })
    store.set(openSpecPreviewAtom)
    expect(store.get(currentSessionFocusPaneAtom)?.kind).toBe('task_spec')

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'stage', position: { mode: 'build', stage: 'clarify' } },
    })

    expect(store.get(briefFamily(id))).toBeNull()
    expect(store.get(currentTaskConfirmAtom)).toBeNull()
    expect(store.get(currentBriefAtom)).toBeNull()
    expect(store.get(currentSessionFocusPaneAtom)).toBeNull()
    expect(store.get(specPreviewOpenAtom)).toBe(false)
    expect(store.get(pendingCommentsAtom)).toHaveLength(1)
    expect(store.get(currentSpecDraftAtom)).toEqual({
      comment: { quote: 'Old definition', text: 'Old draft note' },
      instruction: 'Old instruction',
      edit: '# Task\nUnsaved old edit',
    })

    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: { type: 'message_start', messageId: 'assistant-new-build', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: id,
      event: {
        type: 'task_confirm_request',
        requestId: 'task-new-build',
        taskMarkdown: '# Task\nNew definition',
      },
    })
    expect(store.get(currentTaskConfirmAtom)?.requestId).toBe('task-new-build')
    expect(store.get(currentBriefAtom)).toBe('# Task\nNew definition')
  })
})

describe('composeCommentBatchText', () => {
  const mk = (quote: string, text: string): PendingComment => ({ id: 'x', quote, text })

  it('numbers each comment and quotes its targeted snippet', () => {
    const out = composeCommentBatchText([mk('抓取上限：50 条', '先按 50 跑通'), mk('请求间隔 2–5 秒', '改成 3–6 秒')])
    expect(out).toContain(i18n.t('build.commentBatch.head', { count: 2 }))
    expect(out).toContain(i18n.t('build.commentBatch.item', { index: 1, quote: '抓取上限：50 条', text: '先按 50 跑通' }))
    expect(out).toContain(i18n.t('build.commentBatch.item', { index: 2, quote: '请求间隔 2–5 秒', text: '改成 3–6 秒' }))
  })

  it('appends the optional free-form instruction (and trims it)', () => {
    const out = composeCommentBatchText([mk('字段', '加 note_url')], '  顺便加超时保护  ')
    expect(out.endsWith('顺便加超时保护')).toBe(true)
  })

  it('omits the instruction tail when blank', () => {
    const out = composeCommentBatchText([mk('字段', '加 note_url')], '   ')
    expect(out.endsWith('加 note_url')).toBe(true)
  })
})

describe('spec preview + pending comments', () => {
  it('open/close drive the active session preview; open is a no-op with no session', () => {
    const store = createStore()
    store.set(openSpecPreviewAtom) // no active session → ignored
    expect(store.get(specPreviewOpenAtom)).toBe(false)
    const id = store.set(newSessionAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(false)
    // An effectively open preview requires session brief content; seed one first.
    store.set(briefFamily(id), '# Task\n内容')
    store.set(openSpecPreviewAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(true)
    store.set(closeSpecPreviewAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(false)
  })

  it('preview open-state is isolated per session (switch shows the right session)', () => {
    // Preview state belongs to each session: open A, switch to closed B, then return to open A.
    // Switching sessions no longer closes every preview; each session retains its own state.
    const store = createStore()
    store.set(activeSessionIdAtom, 'sess-a')
    store.set(briefFamily('sess-a'), '# Task\nA') // An effectively open preview requires a brief.
    store.set(openSpecPreviewAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(true)

    store.set(activeSessionIdAtom, 'sess-b') // B never opened it
    expect(store.get(specPreviewOpenAtom)).toBe(false)

    store.set(activeSessionIdAtom, 'sess-a') // back to A → preserved
    expect(store.get(specPreviewOpenAtom)).toBe(true)
  })

  it('preview reads closed once the brief disappears (auto-hide, no manual close)', () => {
    // If the user opens but never closes the preview, removing the brief must also hide the pane
    // and return the right column to session output instead of leaving an empty placeholder.
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(briefFamily(id), '# Task\n有内容')
    store.set(openSpecPreviewAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(true)
    store.set(briefFamily(id), null) // The brief disappeared after a context switch or backend 404.
    expect(store.get(specPreviewOpenAtom)).toBe(false) // Intent remains, but the pane is no longer effectively open.
  })

  it('add needs an active session; ignores blank; remove drops a single entry', () => {
    const store = createStore()
    store.set(addPendingCommentAtom, { quote: 'q1', text: 'no session' }) // no session → no-op
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)
    store.set(newSessionAtom)
    store.set(addPendingCommentAtom, { quote: 'q1', text: '   ' }) // blank → ignored
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)
    store.set(addPendingCommentAtom, { quote: 'q1', text: '  改成 3–6 秒 ' }) // trimmed
    expect(store.get(pendingCommentsAtom)).toHaveLength(1)
    expect(store.get(pendingCommentsAtom)[0]!.text).toBe('改成 3–6 秒')
    const onlyId = store.get(pendingCommentsAtom)[0]!.id
    store.set(removePendingCommentAtom, onlyId) // single entry IS removable
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)
  })

  it('clear empties the active session pending but keeps the preview open', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(briefFamily(id), '# Task\n内容') // An effectively open preview requires a brief.
    store.set(openSpecPreviewAtom)
    store.set(addPendingCommentAtom, { quote: 'q', text: 't' })
    store.set(clearPendingCommentsAtom)
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)
    expect(store.get(specPreviewOpenAtom)).toBe(true) // preview stays
  })

  it('pending is isolated per session (switch shows the right session)', () => {
    // Distinct literal ids — newSessionAtom would reuse an empty draft, so it
    // can't produce two separate sessions here; the map key is just the id.
    const store = createStore()
    store.set(activeSessionIdAtom, 'sess-a')
    store.set(addPendingCommentAtom, { quote: 'qa', text: 'a-comment' })
    store.set(activeSessionIdAtom, 'sess-b')
    expect(store.get(pendingCommentsAtom)).toHaveLength(0) // b is empty
    store.set(addPendingCommentAtom, { quote: 'qb', text: 'b-comment' })
    store.set(activeSessionIdAtom, 'sess-a')
    expect(store.get(pendingCommentsAtom)[0]!.text).toBe('a-comment') // a intact
    store.set(activeSessionIdAtom, 'sess-b')
    expect(store.get(pendingCommentsAtom)[0]!.text).toBe('b-comment')
  })

  it('setAll bulk-loads the persisted map (persistence bridge)', () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    const seeded: PendingComment[] = [{ id: 'c1', quote: 'q', text: '从磁盘恢复' }]
    store.set(setAllPendingCommentsAtom, { [id]: seeded })
    expect(store.get(pendingCommentsAtom)[0]!.text).toBe('从磁盘恢复')
    expect(store.get(allPendingCommentsAtom)[id]).toHaveLength(1)
  })
})

describe('sendCommentBatchAtom', () => {
  it('no-ops when there are no pending comments', () => {
    const store = createStore()
    store.set(newSessionAtom)
    store.set(sendCommentBatchAtom)
    expect(store.get(currentMessagesAtom)).toHaveLength(0)
  })

  it('sends one merged human turn and clears pending', () => {
    const store = createStore()
    store.set(newSessionAtom) // also sets it active
    store.set(addPendingCommentAtom, { quote: '抓取上限：50 条', text: '先按 50 跑通' })
    store.set(addPendingCommentAtom, { quote: '请求间隔 2–5 秒', text: '改成 3–6 秒' })
    store.set(sendCommentBatchAtom, '顺便加超时保护')
    // First message = the optimistic merged user turn.
    const first = store.get(currentMessagesAtom)[0]!
    expect(first.role).toBe('user')
    expect(first.text).toContain(i18n.t('build.commentBatch.head', { count: 2 }))
    expect(first.text).toContain('顺便加超时保护')
    // Pending drains after send (input restores; preview stays open per f6).
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)
    expect(store.get(specPreviewOpenAtom)).toBe(false) // send doesn't toggle preview
  })

  it('submits selected comments through the pending task-review response', async () => {
    const store = createStore()
    const id = store.set(newSessionAtom)
    store.set(messageFamily(id), [{
      id: 'assistant-review',
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'task_confirm',
        requestId: 'task-review-1',
        taskMarkdown: '# Task\n内容',
        status: 'pending',
      }],
      done: true,
      createdAt: 1,
    }])
    store.set(addPendingCommentAtom, { quote: '内容', text: '补充输出格式' })

    await store.set(sendCommentBatchAtom)

    const review = store.get(currentTaskConfirmAtom)
    expect(review?.status).toBe('revision_requested')
    expect(review?.feedback).toContain('补充输出格式')
    expect(store.get(pendingCommentsAtom)).toHaveLength(0)
  })
})

/**
 * Lifecycle of unsubmitted SpecSessionDraft values: when each field must be cleared.
 *
 * Moving these drafts from component state to session atoms removed the cleanup previously
 * provided by component unmount. Each write atom must now clear explicitly. Missing one cleanup
 * resurrects abandoned content in a later turn and sends it without an obvious connection to the old action.
 */
describe('spec session draft lifecycle', () => {
  function storeWithSession(sid: string) {
    const store = createStore()
    store.set(activeSessionIdAtom, sid)
    return store
  }

  it('staging a comment closes its composer draft', () => {
    const store = storeWithSession('s-draft-add')
    store.set(setSpecCommentDraftAtom, { quote: '被引用的原文', text: '这段删掉' })
    store.set(addPendingCommentAtom, { quote: '被引用的原文', text: '这段删掉' })

    expect(store.get(pendingCommentsAtom)).toHaveLength(1)
    // Enqueueing and clearing the composer must be one transition, or content exists in both places.
    expect(store.get(currentSpecDraftAtom).comment).toBeNull()
  })

  it('cancelling the batch also drops the instruction draft', () => {
    const store = storeWithSession('s-draft-cancel')
    store.set(addPendingCommentAtom, { quote: '原文', text: '评论' })
    store.set(setSpecInstructionDraftAtom, '全部用英文输出')

    store.set(clearPendingCommentsAtom)

    expect(store.get(pendingCommentsAtom)).toHaveLength(0)
    // Without clearing, reopening the pane for another paragraph restores this text in the
    // composer and sends it with the new comment.
    expect(store.get(currentSpecDraftAtom).instruction).toBe('')
  })

  it('keeps drafts of other sessions untouched', () => {
    const store = storeWithSession('s-draft-a')
    store.set(setSpecInstructionDraftAtom, '只属于 A')
    store.set(setSpecCommentDraftAtom, { quote: 'A 的原文', text: 'A 的评论' })

    store.set(activeSessionIdAtom, 's-draft-b')
    expect(store.get(currentSpecDraftAtom).instruction).toBe('')
    expect(store.get(currentSpecDraftAtom).comment).toBeNull()
    store.set(clearPendingCommentsAtom)

    store.set(activeSessionIdAtom, 's-draft-a')
    expect(store.get(currentSpecDraftAtom).instruction).toBe('只属于 A')
    expect(store.get(currentSpecDraftAtom).comment).toEqual({ quote: 'A 的原文', text: 'A 的评论' })
  })
})
