/**
 * splitMarkdownBlocks tests verify stable boundaries for complete code, table, and list blocks,
 * plus balanced math so block formulas containing blank lines stay intact. This underpins per-block memoization.
 */
import { describe, it, expect } from 'bun:test'
import { splitMarkdownBlocks } from '../markdownBlocks'

describe('splitMarkdownBlocks', () => {
  it('空串 → []', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
  })

  it('多段落切成多块', () => {
    expect(splitMarkdownBlocks('第一段\n\n第二段\n\n第三段').length).toBe(3)
  })

  it('代码围栏整体一块(块内空行不拆)', () => {
    const md = '前\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n后'
    const blocks = splitMarkdownBlocks(md)
    const fence = blocks.find((b) => b.includes('```ts'))
    expect(fence).toBeDefined()
    // Opening and closing fences remain in the same block.
    expect((fence!.match(/```/g) ?? []).length).toBe(2)
  })

  it('表格 / 列表各自一块', () => {
    expect(splitMarkdownBlocks('| a | b |\n|---|---|\n| 1 | 2 |')).toHaveLength(1)
    expect(splitMarkdownBlocks('- 一\n- 二\n- 三')).toHaveLength(1)
  })

  it('多行块级公式(含空行)被配平回一块,$$ 成对', () => {
    const md = '$$\n\\begin{aligned}\nx &= 1\n\ny &= 2\n\\end{aligned}\n$$'
    const blocks = splitMarkdownBlocks(md)
    expect(blocks).toHaveLength(1)
    expect((blocks[0]!.match(/\$\$/g) ?? []).length).toBe(2)
  })

  it('单行完整公式不受影响', () => {
    const blocks = splitMarkdownBlocks('文字 $$x = 1$$ 更多文字')
    expect(blocks).toHaveLength(1)
    expect((blocks[0]!.match(/\$\$/g) ?? []).length).toBe(2)
  })

  it('纯空白块被丢弃', () => {
    expect(splitMarkdownBlocks('\n\n\n')).toEqual([])
  })
})
