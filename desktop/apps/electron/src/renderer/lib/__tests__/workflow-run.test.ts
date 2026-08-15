import { describe, expect, it } from 'bun:test'
import type { ChatBlock } from '@shared/types'
import {
  formatWorkflowRunShortTimestamp,
  formatWorkflowRunTimestamp,
  workflowRunCommandInput,
  workflowRunInputBlocks,
  workflowRunMentionLabel,
} from '../workflowRun'

describe('Workflow Run display identity', () => {
  it('uses a precise local timestamp to distinguish repeated runs', () => {
    const createdAt = new Date(2026, 6, 20, 10, 11, 12).toISOString()

    expect(formatWorkflowRunTimestamp(createdAt)).toBe('2026-07-20 10:11:12')
    expect(workflowRunMentionLabel({ workflow_name: '目录统计', created_at: createdAt }))
      .toBe('目录统计 · 2026-07-20 10:11:12')
  })

  it('preserves an unknown timestamp instead of inventing a date', () => {
    expect(formatWorkflowRunTimestamp('unknown')).toBe('unknown')
  })

  it('treats legacy timestamps without an offset as UTC', () => {
    const legacyUtc = '2026-07-20T03:36:57'

    expect(formatWorkflowRunTimestamp(legacyUtc)).toBe(formatWorkflowRunTimestamp(`${legacyUtc}Z`))
    expect(formatWorkflowRunShortTimestamp(legacyUtc)).toBe(formatWorkflowRunShortTimestamp(`${legacyUtc}Z`))
  })

  it('preserves structured Workflow input blocks', () => {
    const blocks: ChatBlock[] = [
      { type: 'slash', id: 'wf_1', label: '论文筛选', resource: 'workflow' },
      { type: 'text', value: ' 查找上下文压缩论文' },
    ]
    const run = {
      workflow_id: 'wf_1',
      workflow_name: '论文筛选',
      workflow_input: { text: '/论文筛选 查找上下文压缩论文', blocks },
    }

    expect(workflowRunInputBlocks(run)).toEqual(blocks)
  })

  it('rebuilds the Workflow token for legacy inputs without blocks', () => {
    const blocks = workflowRunInputBlocks({
      workflow_id: 'wf_1',
      workflow_name: '论文筛选',
      workflow_input: { text: '/论文筛选 查找上下文压缩论文', blocks: [] },
    })

    expect(blocks).toEqual([
      { type: 'slash', id: 'wf_1', label: '论文筛选', resource: 'workflow' },
      { type: 'text', value: ' 查找上下文压缩论文' },
    ])
  })

  it('shows only the input after the Workflow command', () => {
    const blocks: ChatBlock[] = [
      { type: 'slash', id: 'wf_1', label: '论文筛选', resource: 'workflow' },
      { type: 'text', value: ' 查找上下文压缩论文，参考 ' },
      { type: 'mention', id: 'file_1', label: '研究目录', group: '文件/文件夹' },
    ]
    const run = {
      workflow_id: 'wf_1',
      workflow_name: '论文筛选',
      workflow_input: { text: '/论文筛选 查找上下文压缩论文，参考 @研究目录', blocks },
    }

    expect(workflowRunCommandInput(run)).toBe('查找上下文压缩论文，参考 @研究目录')
  })

  it('omits a repeated Workflow name when a run has no command input', () => {
    expect(workflowRunCommandInput({
      workflow_id: 'wf_1',
      workflow_name: '论文筛选',
      workflow_input: { text: '/论文筛选', blocks: [] },
    })).toBe('')
  })

  it('preserves legacy input text that is not the Workflow command', () => {
    const base = {
      workflow_id: 'wf_1',
      workflow_name: '论文筛选',
    }

    expect(workflowRunCommandInput({
      ...base,
      workflow_input: { text: '查找上下文压缩论文', blocks: [] },
    })).toBe('查找上下文压缩论文')
    expect(workflowRunCommandInput({
      ...base,
      workflow_input: { text: '/论文筛选扩展 查找论文', blocks: [] },
    })).toBe('/论文筛选扩展 查找论文')
  })

})
