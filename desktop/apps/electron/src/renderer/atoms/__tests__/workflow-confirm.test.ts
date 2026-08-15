import { afterAll, afterEach, describe, expect, it } from 'bun:test'

interface SentWorkflowConfirm {
  sessionId: string
  payload: {
    request_id: string
    action: 'confirm' | 'save_as_new' | 'cancel'
    name?: string | null
  }
}

const sentWorkflowConfirms: SentWorkflowConfirm[] = []

const { createStore } = await import('jotai')
const { getAmphiWsConnection } = await import('@/lib/amphiWsConnection')
const {
  currentPendingFrameworkInteractionAtom,
  streamingFamily,
} = await import('../agent')
const { activeSessionIdAtom } = await import('../sessions')
const { confirmWorkflowBuildAtom } = await import('../workflows')

const connection = getAmphiWsConnection()
const originalWorkflowConfirm = connection.workflowConfirm
connection.workflowConfirm = (
  sessionId: string,
  payload: SentWorkflowConfirm['payload'],
) => {
  sentWorkflowConfirms.push({ sessionId, payload })
}

afterEach(() => {
  sentWorkflowConfirms.length = 0
})
afterAll(() => {
  connection.workflowConfirm = originalWorkflowConfirm
})

describe('confirmWorkflowBuildAtom', () => {
  it('answers the card and sends one WS save command without a Workflow id', async () => {
    const store = createStore()
    const sessionId = 'session-build-confirm'
    store.set(activeSessionIdAtom, sessionId)
    store.set(streamingFamily(sessionId), {
      messageId: 'assistant-build-confirm',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_confirm',
        requestId: 'workflow-confirm-1',
        defaultName: '默认名称',
        operation: 'create',
        workflowId: null,
        status: 'pending',
      }],
      startedAt: 1,
    })

    expect(store.get(currentPendingFrameworkInteractionAtom)?.type).toBe('workflow_confirm')

    await store.set(confirmWorkflowBuildAtom, {
      sessionId,
      requestId: 'workflow-confirm-1',
      action: 'confirm',
      name: '  每日报告  ',
    })

    expect(sentWorkflowConfirms).toEqual([{
      sessionId,
      payload: {
        request_id: 'workflow-confirm-1',
        action: 'confirm',
        name: '每日报告',
      },
    }])
    expect(store.get(streamingFamily(sessionId))?.blocks[0]).toMatchObject({
      type: 'workflow_confirm',
      status: 'continued',
      name: '每日报告',
      workflowId: null,
    })
    expect(store.get(currentPendingFrameworkInteractionAtom)).toBeNull()
  })

  it('answers cancellation through the same WS command', async () => {
    const store = createStore()
    const sessionId = 'session-build-cancel'
    store.set(activeSessionIdAtom, sessionId)
    store.set(streamingFamily(sessionId), {
      messageId: 'assistant-build-cancel',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_confirm',
        requestId: 'workflow-confirm-2',
        defaultName: '无需保存',
        status: 'pending',
      }],
      startedAt: 1,
    })

    await store.set(confirmWorkflowBuildAtom, {
      sessionId,
      requestId: 'workflow-confirm-2',
      action: 'cancel',
    })

    expect(sentWorkflowConfirms).toEqual([{
      sessionId,
      payload: {
        request_id: 'workflow-confirm-2',
        action: 'cancel',
        name: null,
      },
    }])
    expect(store.get(streamingFamily(sessionId))?.blocks[0]).toMatchObject({
      type: 'workflow_confirm',
      status: 'cancelled',
    })
    expect(store.get(currentPendingFrameworkInteractionAtom)).toBeNull()
  })

  it('saves an edited Workflow as a new definition without retaining the original id', async () => {
    const store = createStore()
    const sessionId = 'session-edit-save-as-new'
    store.set(activeSessionIdAtom, sessionId)
    store.set(streamingFamily(sessionId), {
      messageId: 'assistant-edit-save-as-new',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_confirm',
        requestId: 'workflow-confirm-save-as-new',
        defaultName: '每日报告',
        operation: 'edit',
        workflowId: 'wf-original',
        status: 'pending',
      }],
      startedAt: 1,
    })

    await store.set(confirmWorkflowBuildAtom, {
      sessionId,
      requestId: 'workflow-confirm-save-as-new',
      action: 'save_as_new',
      name: '  每日报告 副本  ',
    })

    expect(sentWorkflowConfirms).toEqual([{
      sessionId,
      payload: {
        request_id: 'workflow-confirm-save-as-new',
        action: 'save_as_new',
        name: '每日报告 副本',
      },
    }])
    expect(store.get(streamingFamily(sessionId))?.blocks[0]).toMatchObject({
      type: 'workflow_confirm',
      status: 'continued',
      name: '每日报告 副本',
      operation: 'create',
      workflowId: null,
    })
    expect(store.get(currentPendingFrameworkInteractionAtom)).toBeNull()
  })

  it('keeps the original target when an edited Workflow is confirmed for overwrite', async () => {
    const store = createStore()
    const sessionId = 'session-edit-overwrite'
    store.set(activeSessionIdAtom, sessionId)
    store.set(streamingFamily(sessionId), {
      messageId: 'assistant-edit-overwrite',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_confirm',
        requestId: 'workflow-confirm-overwrite',
        defaultName: '每日报告',
        operation: 'edit',
        workflowId: 'wf-original',
        status: 'pending',
      }],
      startedAt: 1,
    })

    await store.set(confirmWorkflowBuildAtom, {
      sessionId,
      requestId: 'workflow-confirm-overwrite',
      action: 'confirm',
      name: '每日报告',
    })

    expect(sentWorkflowConfirms).toEqual([{
      sessionId,
      payload: {
        request_id: 'workflow-confirm-overwrite',
        action: 'confirm',
        name: '每日报告',
      },
    }])
    expect(store.get(streamingFamily(sessionId))?.blocks[0]).toMatchObject({
      type: 'workflow_confirm',
      status: 'continued',
      name: '每日报告',
      operation: 'edit',
      workflowId: 'wf-original',
    })
  })
})
