/**
 * cycleMentionScope 纯逻辑单测:验证 ←/→ 在 5 个分类 Tab 间的环绕切换顺序,
 * 使键盘 Tab 切换与头部渲染顺序保持一致(§4.11 单一来源)。
 */
import { describe, expect, it } from 'bun:test'
import { MENTION_SCOPES, cycleMentionScope } from '../mentionScope'

describe('cycleMentionScope', () => {
  it('cycles through the canonical scope order in both directions with wrapping', () => {
    expect(MENTION_SCOPES).toEqual([
      'all',
      'session-files',
      'workflows',
      'workflow-runs',
      'schedules',
    ])
    for (let index = 0; index < MENTION_SCOPES.length; index += 1) {
      const current = MENTION_SCOPES[index]!
      const next = MENTION_SCOPES[(index + 1) % MENTION_SCOPES.length]!
      const previous = MENTION_SCOPES[(index - 1 + MENTION_SCOPES.length) % MENTION_SCOPES.length]!
      expect(cycleMentionScope(current, 'next')).toBe(next)
      expect(cycleMentionScope(current, 'prev')).toBe(previous)
    }
  })
})
