import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { I18nProvider } from '../i18n'
import { TurnPromptAnalysis, type TurnPromptPotentialRow } from './TurnPromptAnalysis'

const rows: TurnPromptPotentialRow[] = [
  {
    turnId: 'turn-1',
    ordinal: 0,
    inputTokens: 13_824,
    outputTokens: 260,
    estimatedInputTokens: 12_000,
    reusableTokens: 0,
    nonReusableTokens: 12_000,
    potentialRate: 0,
    nonReusableRate: 1,
    alignmentDeltaTokens: 1_824,
    alignmentDeltaRate: 1_824 / 13_824,
    comparableRounds: 0,
    totalRounds: 1,
    rounds: [{
      roundId: 'round-1',
      ordinal: 0,
      estimatedInputTokens: 12_000,
      outputTokens: 260,
      reusableTokens: 0,
      nonReusableTokens: 12_000,
      potentialRate: 0,
      nonReusableRate: 1,
      hasBaseline: false,
      baselineTurnOrdinal: null,
      baselineRoundOrdinal: null,
      firstChangedBlock: null,
      toolSurfaceChanged: false,
      nonReusableSections: ['tools', 'context'],
    }],
  },
  {
    turnId: 'turn-2',
    ordinal: 1,
    inputTokens: 27_204,
    outputTokens: 931,
    estimatedInputTokens: 25_000,
    reusableTokens: 19_500,
    nonReusableTokens: 5_500,
    potentialRate: 0.78,
    nonReusableRate: 0.22,
    alignmentDeltaTokens: 2_204,
    alignmentDeltaRate: 2_204 / 27_204,
    comparableRounds: 2,
    totalRounds: 2,
    rounds: [{
      roundId: 'round-2-cold',
      ordinal: 0,
      estimatedInputTokens: 13_000,
      outputTokens: null,
      reusableTokens: 0,
      nonReusableTokens: 13_000,
      potentialRate: 0,
      nonReusableRate: 1,
      hasBaseline: false,
      baselineTurnOrdinal: null,
      baselineRoundOrdinal: null,
      firstChangedBlock: null,
      toolSurfaceChanged: false,
      nonReusableSections: ['persona', 'tools'],
    }, {
      roundId: 'round-2',
      ordinal: 1,
      estimatedInputTokens: 12_000,
      outputTokens: 851,
      reusableTokens: 9_000,
      nonReusableTokens: 3_000,
      potentialRate: 0.75,
      nonReusableRate: 0.25,
      hasBaseline: true,
      baselineTurnOrdinal: 0,
      baselineRoundOrdinal: 0,
      firstChangedBlock: 'current_input',
      toolSurfaceChanged: true,
      nonReusableSections: ['current_input', 'current_turn'],
    }],
  },
]

describe('TurnPromptAnalysis', () => {
  test('shows persisted input/output and expands the selected Turn potential', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="zh-CN">
        <TurnPromptAnalysis
          rows={rows}
          selectedTurnId="turn-2"
          onSelectTurn={() => undefined}
          onCompareRound={() => undefined}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('13,824')
    expect(markup).toContain('27,204')
    expect(markup).toContain('class="turn-analysis-item is-selected is-expanded"')
    expect(markup).toContain('aria-pressed="true" aria-expanded="true"')
    expect(markup).toContain('aria-pressed="false" aria-expanded="false"')
    expect(markup).toContain('>78%<')
    expect(markup).toContain('≈ 19,500')
    expect(markup).toContain('轮次 2')
    expect(markup).toContain('命中 75%')
    expect(markup).toContain('未命中 25%')
    expect(markup).toContain('无可比请求')
    expect(markup).not.toContain('命中 0%')
    expect(markup).not.toContain('未命中 100%')
    expect(markup).toContain('<span>输入<code>≈ 12,000</code></span>')
    expect(markup).toContain('<span>输出<code>851</code></span>')
    expect(markup).toContain('<span>输出<code>—</code></span>')
    expect(markup).toContain('对比 T1 · 轮次 1')
    expect(markup).toContain('Message 首次变化：current_input')
    expect(markup).toContain('class="round-tool-surface-change">工具定义变化</small>')
    expect(markup).toContain('未命中 Message Block：current_input、current_turn')
    expect(markup).toContain('查看 Prompt 差异')
    expect(markup.match(/class="round-prompt-compare-trigger"/g)?.length).toBe(1)
    expect(markup).toContain('2 / 2 个轮次')
  })

  test('keeps a request without a compatible predecessor concise', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en-US">
        <TurnPromptAnalysis
          rows={rows}
          selectedTurnId="turn-1"
          onSelectTurn={() => undefined}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('No comparable request')
    expect(markup).toContain('<span>Input<code>≈ 12,000</code></span>')
    expect(markup).toContain('<span>Output<code>260</code></span>')
    expect(markup).toContain('class="turn-analysis-item is-selected is-expanded"')
    expect(markup).toContain('aria-pressed="true" aria-expanded="true"')
    expect(markup).not.toContain('None of this Turn’s 1 model requests has an earlier same-model request')
    expect(markup).not.toContain('This does not mean the cache hit rate is 0%')
    expect(markup).not.toContain('Expected cache hit tokens')
    expect(markup).not.toContain('0 / 1 model requests')
  })

  test('reports a tool-only change without treating it as the first message change', () => {
    const comparable = rows[1]!
    const toolOnlyRows: TurnPromptPotentialRow[] = [{
      ...comparable,
      rounds: comparable.rounds.map((round) => round.hasBaseline
        ? {
            ...round,
            firstChangedBlock: null,
            toolSurfaceChanged: true,
            nonReusableSections: [],
          }
        : round),
    }]
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en-US">
        <TurnPromptAnalysis
          rows={toolOnlyRows}
          selectedTurnId="turn-2"
          onSelectTurn={() => undefined}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('class="round-tool-surface-change">Tool Schema changed</small>')
    expect(markup).not.toContain('First message change:')
    expect(markup).not.toContain('First message change: Tool definitions')
  })
})
