/**
 * Tests for lib/mermaidCode.ts — Mermaid source normalization before rendering.
 *
 * Regression: `wrap2` recognizes `<br>` but not the self-closing `<br/>` often emitted by
 * models in timelines, leaving literal markup and overflowing text. Normalizing to `<br>`
 * restores line wrapping.
 */
import { describe, it, expect } from 'bun:test'
import { normalizeBreakTags } from '../mermaidCode'

describe('normalizeBreakTags', () => {
  it('normalizes self-closing break variants and leaves other Mermaid source intact', () => {
    const cases = [
      ['模拟通信<br/>简单半导体工艺', '模拟通信<br>简单半导体工艺'],
      ['a<br />b<BR/>c', 'a<br>b<br>c'],
      ['a<br>b', 'a<br>b'],
      ['flowchart TD\n  A-->B', 'flowchart TD\n  A-->B'],
    ]
    for (const [source, expected] of cases) {
      expect(normalizeBreakTags(source!)).toBe(expected!)
    }
  })
})
