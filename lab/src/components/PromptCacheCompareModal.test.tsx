import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  PromptCacheCompareModal,
  comparePromptCacheText,
  type PromptCacheComparisonViewModel,
} from './PromptCacheCompareModal'

const comparison: PromptCacheComparisonViewModel = {
  id: 'turn-5-round-2',
  baseline: {
    id: 'turn-5-round-1',
    label: 'T5 · 轮次 1',
    model: 'gpt-5.6-sol',
    inputTokens: 25_000,
    outputTokens: null,
  },
  current: {
    id: 'turn-5-round-2',
    label: 'T5 · 轮次 2',
    model: 'gpt-5.6-sol',
    inputTokens: 26_941,
    outputTokens: 263,
  },
  hitTokens: 16_867,
  missTokens: 995,
  hitRate: 0.94,
  firstChangedBlockId: 'current-input',
  blocks: [{
    id: 'persona',
    kind: 'persona',
    label: 'Persona',
    status: 'same',
    baselineText: 'You are an agent.',
    currentText: 'You are an agent.',
    hitTokens: 320,
    missTokens: 0,
  }, {
    id: 'current-input',
    kind: 'current_input',
    label: 'Current input',
    status: 'changed',
    baselineText: 'Review the old report.',
    currentText: 'Review the new report.',
    hitTokens: 12,
    missTokens: 6,
  }],
  toolSurface: {
    id: 'tools',
    kind: 'tools',
    label: 'Tool Schema',
    status: 'changed',
    baselineText: 'read_file(path)',
    currentText: 'read_file(path, encoding)',
    hitTokens: null,
    missTokens: 14,
  },
}

describe('comparePromptCacheText', () => {
  test('keeps the shared prefix and suffix outside the highlighted middle', () => {
    expect(comparePromptCacheText('Review the old report.', 'Review the new report.', 'changed')).toEqual({
      baseline: [
        { text: 'Review the ', changed: false },
        { text: 'old', changed: true },
        { text: ' report.', changed: false },
      ],
      current: [
        { text: 'Review the ', changed: false },
        { text: 'new', changed: true },
        { text: ' report.', changed: false },
      ],
    })
  })

  test('highlights the available side of added and removed blocks', () => {
    expect(comparePromptCacheText(null, 'New block', 'added').current).toEqual([
      { text: 'New block', changed: true },
    ])
    expect(comparePromptCacheText('Old block', null, 'removed').baseline).toEqual([
      { text: 'Old block', changed: true },
    ])
  })
})

describe('PromptCacheCompareModal', () => {
  test('renders an accessible comparison with every block collapsed', () => {
    const markup = renderToStaticMarkup(
      <PromptCacheCompareModal
        open
        comparison={comparison}
        onClose={() => undefined}
        labels={{
          title: '缓存差异对比',
          subtitle: '比较基线与当前请求',
          close: '关闭对比',
          baseline: '对比基线',
          current: '当前请求',
          cacheHit: '命中',
          cacheMiss: '未命中',
          firstMessageDifference: 'Message 首次变化',
          messageBlocks: 'Message Block',
          toolDefinitions: '工具定义',
          toolSchemaChanged: '工具定义变化',
          unchanged: '未变化',
          changed: '已变化',
        }}
      />,
    )

    expect(markup).toContain('role="dialog" aria-modal="true"')
    expect(markup).toContain('aria-label="关闭对比"')
    expect(markup).toContain('T5 · 轮次 1')
    expect(markup).toContain('T5 · 轮次 2')
    expect(markup).toContain('>94%<')
    expect(markup).toContain('>6%<')
    expect(markup).toContain('≈ 16,867')
    expect(markup).toContain('≈ 995')
    expect(markup.match(/aria-expanded="false"/g)?.length).toBe(3)
    expect(markup).toContain('id="prompt-cache-compare-R0-message-blocks">Message Block</h3><span>2</span>')
    expect(markup).toContain('id="prompt-cache-compare-R0-tool-definitions">工具定义</h3>')
    expect(markup).toContain('class="prompt-cache-compare-block is-changed is-first-change"')
    expect(markup).toContain('>已变化<')
    expect(markup).toContain('<span>Message 首次变化</span><strong>Current input</strong>')
    expect(markup).toContain('class="prompt-cache-compare-first-badge">Message 首次变化</span>')
    expect(markup).toContain('class="prompt-cache-compare-tool-difference"><strong>工具定义变化</strong>')
    expect(markup).toContain('class="prompt-cache-compare-block is-changed is-tool-surface-change" data-block-kind="tools" data-request-field="tools"')
    expect(markup).toContain('class="prompt-cache-compare-tool-change-badge">工具定义变化</span>')
    expect(markup).not.toContain('<pre>')
  })

  test('never presents a Tool Schema change as the first ordered message change', () => {
    const markup = renderToStaticMarkup(
      <PromptCacheCompareModal
        open
        comparison={{
          ...comparison,
          firstChangedBlockId: 'tools',
          blocks: comparison.blocks.map((block) => ({ ...block, status: 'same' })),
        }}
        onClose={() => undefined}
        labels={{
          firstMessageDifference: 'First message change',
          toolSchemaChanged: 'Tool Schema changed',
        }}
      />,
    )

    expect(markup).toContain('Tool Schema changed')
    expect(markup).not.toContain('is-first-change')
    expect(markup).not.toContain('prompt-cache-compare-first-difference')
    expect(markup).not.toContain('prompt-cache-compare-first-badge')
  })

  test('does not render when closed or missing a comparison', () => {
    expect(renderToStaticMarkup(
      <PromptCacheCompareModal open={false} comparison={comparison} onClose={() => undefined} />,
    )).toBe('')
    expect(renderToStaticMarkup(
      <PromptCacheCompareModal open comparison={null} onClose={() => undefined} />,
    )).toBe('')
  })
})
