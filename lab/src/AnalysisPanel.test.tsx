import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { AnalysisPanel, PromptCacheAnalysisSection } from './App'
import type { TurnPromptPotentialRow } from './components'
import { I18nProvider } from './i18n'

const selected: TurnPromptPotentialRow = {
  turnId: 'turn-2',
  ordinal: 1,
  inputTokens: 13_824,
  outputTokens: 260,
  estimatedInputTokens: 12_000,
  reusableTokens: 9_000,
  nonReusableTokens: 3_000,
  potentialRate: 0.75,
  nonReusableRate: 0.25,
  alignmentDeltaTokens: 1_824,
  alignmentDeltaRate: 1_824 / 13_824,
  comparableRounds: 1,
  totalRounds: 1,
  rounds: [],
}

const noop = () => undefined

describe('AnalysisPanel', () => {
  test('keeps the cache overview visible while only the long details start collapsed', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en-US">
        <AnalysisPanel
          rows={[selected]}
          selectedTurnId={selected.turnId}
          loading={false}
          error={null}
          onSelectTurn={noop}
          onCompareRound={noop}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('Token change')
    expect(markup).toContain('13,824')
    expect(markup).toContain('Prompt cache analysis')
    expect(markup).toContain('type="button"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-controls="prompt-cache-analysis-details"')
    expect(markup).toContain('aria-label="Expand Prompt cache details"')
    expect(markup).toContain('>Expand<')
    expect(markup).toContain('≈ 9,000')
    expect(markup).toContain('≈ 3,000')
    expect(markup).toContain('width:75%')
    expect(markup).toContain('width:25%')
    expect(markup).toContain('id="prompt-cache-analysis-details"')
    expect(markup).toContain('hidden=""')
    expect(markup).not.toContain('class="turn-prompt-analysis"')
  })

  test('renders cache details only after the section is expanded', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="zh-CN">
        <PromptCacheAnalysisSection
          rows={[selected]}
          selected={selected}
          selectedTurnId={selected.turnId}
          loading={false}
          error={null}
          expanded
          onToggle={noop}
          onSelectTurn={noop}
          onCompareRound={noop}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('aria-label="收起 Prompt 缓存明细"')
    expect(markup).toContain('>收起<')
    expect(markup).toContain('id="prompt-cache-analysis-details"')
    expect(markup).not.toContain('hidden=""')
    expect(markup).toContain('≈ 9,000')
    expect(markup).toContain('≈ 3,000')
    expect(markup).toContain('class="turn-prompt-analysis"')
  })
})
