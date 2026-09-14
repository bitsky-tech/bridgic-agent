import { describe, expect, test } from 'bun:test'
import { createTranslator, localeSelfName, translate } from '.'
import { en, type TranslationKey } from './en'
import { zhCN } from './zh-CN'

describe('Lab internationalization', () => {
  test('keeps English and Chinese message keys in sync', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
  })

  test('keeps interpolation parameters aligned across both catalogs', () => {
    const parameters = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const key of Object.keys(en) as TranslationKey[]) {
      expect({ key, parameters: parameters(zhCN[key]) }).toEqual({ key, parameters: parameters(en[key]) })
    }
  })

  test('interpolates translated interface messages', () => {
    expect(translate('en-US', 'run.roundCountMany', { count: 3 })).toBe('3 rounds')
    expect(translate('zh-CN', 'sidebar.emptySearch', { query: '工作流' }))
      .toBe('没有匹配“工作流”的会话，当前 Trace 仍保持选中。')
  })

  test('exposes each locale native name for the language switcher', () => {
    expect(localeSelfName('en-US')).toBe('EN')
    expect(localeSelfName('zh-CN')).toBe('中文')
  })

  test('binds experiment messages to the locale and preserves interpolated source text', () => {
    const english = createTranslator('en-US')
    const chinese = createTranslator('zh-CN')
    expect(english('experiments.outlineCountDiscrepancy', { reported: 12, actual: 11 }))
      .toBe('The report says 12 slides; the outline contains 11')
    expect(chinese('experiments.outlineCountDiscrepancy', { reported: 12, actual: 11 }))
      .toBe('报告写了 12 页，实际大纲为 11 页')
    expect(english('experiments.turnStoppedAtStage', { ordinal: 2, stage: '规划 {ordinal} $&' }))
      .toBe('Turn 2 was stopped by the user at 规划 {ordinal} $&. Unfinished stages have no completion receipt.')
  })
})
