import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  applySubagentEventAtom,
  hasActiveForegroundSubagent,
  isParentWaitingForSubagents,
  SubagentLifecycle,
  subagentsAtom,
} from '../subagents'

describe('subagent lifecycle summary', () => {
  it('keeps Child execution waits distinct from user interactions', () => {
    const childJoin = SubagentLifecycle.from('awaiting_subagents')
    expect(childJoin.kind).toBe('awaiting_subagents')
    expect(childJoin.label).toBe('等待子 Agent')
    expect(childJoin.isRunning).toBe(true)
    expect(childJoin.needsUserAction).toBe(false)

    const human = SubagentLifecycle.from('awaiting_human')
    expect(human.label).toBe('等待你的回答')
    expect(human.isRunning).toBe(false)
    expect(human.needsUserAction).toBe(true)

    const permission = SubagentLifecycle.from('awaiting_permission')
    expect(permission.label).toBe('等待工具审批')
    expect(permission.isRunning).toBe(false)
    expect(permission.needsUserAction).toBe(true)
  })

  it('rejects unspecified statuses instead of assigning implicit semantics', () => {
    expect(SubagentLifecycle.from('unexpected_status').kind).toBe('unknown')
    expect(SubagentLifecycle.from('unexpected_status').needsUserAction).toBe(false)
    expect(SubagentLifecycle.from('cancelled').kind).toBe('stopped')
    expect(SubagentLifecycle.from('failed').kind).toBe('failed')
    expect(SubagentLifecycle.from(undefined).kind).toBe('unknown')
  })

  it('resolves live, executing, and durable sources in explicit priority order', () => {
    expect(SubagentLifecycle.fromSources({
      liveStatus: 'awaiting_permission',
      isExecuting: true,
      turnStatus: 'completed',
    }).kind).toBe('awaiting_permission')
    expect(SubagentLifecycle.fromSources({
      isExecuting: true,
      turnStatus: 'completed',
    }).kind).toBe('running')
    expect(SubagentLifecycle.fromSources({
      isExecuting: false,
      turnStatus: 'awaiting_human',
    }).kind).toBe('awaiting_human')
  })

  it('tracks status without duplicating the Child Session transcript', () => {
    const store = createStore()
    store.set(applySubagentEventAtom, {
      invocationId: 'inv-1',
      parentSessionId: 'parent-1',
      mode: 'blocking',
      goal: '分析文件',
      status: 'completed',
      phase: 'status',
      answer: '完成',
    })

    expect(store.get(subagentsAtom).get('inv-1')).toEqual({
      invocationId: 'inv-1',
      parentSessionId: 'parent-1',
      mode: 'blocking',
      goal: '分析文件',
      status: 'completed',
      answer: '完成',
      error: undefined,
    })
  })

  it('derives foreground waiting state from standalone and nested persisted blocks', () => {
    expect(hasActiveForegroundSubagent([{
      type: 'subagent',
      invocationId: 'blocking-child',
      goal: '分析文件',
      status: 'running',
    }], new Map())).toBe(true)

    expect(hasActiveForegroundSubagent([{
      type: 'tool',
      toolUseId: 'bash-call',
      name: 'bash',
      input: {},
      subagents: [{
        invocationId: 'rpc-child',
        goal: '检查结果',
        status: 'awaiting_human',
      }],
    }], new Map())).toBe(true)

    expect(hasActiveForegroundSubagent([{
      type: 'subagent',
      invocationId: 'completed-child',
      goal: '分析文件',
      status: 'completed',
    }], new Map())).toBe(false)

    expect(hasActiveForegroundSubagent([{
      type: 'subagent',
      invocationId: 'unknown-child',
      goal: '分析文件',
      status: 'unexpected_status',
    }], new Map())).toBe(false)
  })

  it('uses live lifecycle state and excludes background children', () => {
    const persisted = [{
      type: 'subagent' as const,
      invocationId: 'child',
      goal: '分析文件',
      status: 'running',
    }]

    expect(hasActiveForegroundSubagent(persisted, new Map([['child', {
      invocationId: 'child',
      parentSessionId: 'parent',
      mode: 'blocking',
      goal: '分析文件',
      status: 'completed',
    }]]))).toBe(false)

    expect(hasActiveForegroundSubagent(persisted, new Map([['child', {
      invocationId: 'child',
      parentSessionId: 'parent',
      mode: 'background',
      goal: '后台分析',
      status: 'running',
    }]]))).toBe(false)
  })

  it('keeps the parent active through the durable join window', () => {
    const completed = [{
      type: 'subagent' as const,
      invocationId: 'child',
      goal: '分析文件',
      status: 'completed',
    }]

    expect(isParentWaitingForSubagents(
      completed,
      new Map(),
      'awaiting_subagents',
    )).toBe(true)
    expect(isParentWaitingForSubagents(completed, new Map(), 'completed')).toBe(false)
  })
})
