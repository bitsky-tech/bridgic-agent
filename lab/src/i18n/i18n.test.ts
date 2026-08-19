import { describe, expect, test } from 'bun:test'
import { translate } from '.'
import { en } from './en'
import { zhCN } from './zh-CN'

describe('Lab internationalization', () => {
  test('keeps English and Chinese message keys in sync', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
  })

  test('interpolates translated interface messages', () => {
    expect(translate('en-US', 'run.roundCountMany', { count: 3 })).toBe('3 rounds')
    expect(translate('zh-CN', 'sidebar.emptySearch', { query: '工作流' }))
      .toBe('没有匹配“工作流”的会话，当前 Trace 仍保持选中。')
  })
})
