/**
 * Tests for lib/mermaidCode.ts — 渲染前的 mermaid 源码规范化。
 *
 * 复现 bug:timeline 图里 LLM 写的自闭合 `<br/>` 不被 `wrap2` 识别(它只认 `<br>`),
 * 导致字面 `<br/>` + 文本不换行溢出。规范成 `<br>` 后 timeline 能正确换行。
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
