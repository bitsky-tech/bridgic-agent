/**
 * normalizeMathFences tests repair malformed input while **preserving valid input**.
 *
 * The main risk is collateral damage rather than failed repair. A complete single-line formula
 * such as `$$x=1$$` renders correctly as inline math; splitting it into a block changes to display
 * styling and causes a visual regression. Preservation cases are therefore as important as repair cases.
 */
import { describe, expect, it } from 'bun:test'
import { normalizeMathFences } from '../normalizeMathFences'

describe('normalizeMathFences — 拆开会被吞掉的跨行围栏', () => {
  it('拆开粘连的开闭围栏并保留合法缩进', () => {
    const input = '$$\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}$$'
    expect(normalizeMathFences(input)).toBe(
      '$$\n\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}\n$$',
    )
    expect(normalizeMathFences('$$\\begin{vmatrix}\na\n$$')).toBe('$$\n\\begin{vmatrix}\na\n$$')
    expect(normalizeMathFences('$$\na\n\\end{vmatrix}$$')).toBe('$$\na\n\\end{vmatrix}\n$$')
    expect(normalizeMathFences('  $$\\begin{pmatrix}\na\n$$')).toBe('  $$\n\\begin{pmatrix}\na\n$$')
  })
})

describe('normalizeMathFences — 不得误伤当前渲染正常的写法', () => {
  it('逐字保留单行、合规块级、行内和普通 Markdown', () => {
    const unchanged = [
      '$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$',
      '$$a$$ 后面的文字',
      '$$a$$ 中间 $$b$$',
      '$$\n\\begin{pmatrix}\na & b\n\\end{pmatrix}\n$$',
      '质能方程 $E = mc^2$ 众所周知',
      '# 标题\n\n普通段落 `code` **粗体**',
    ]
    for (const input of unchanged) {
      expect(normalizeMathFences(input)).toBe(input)
    }
  })
})

describe('normalizeMathFences — 代码块内一律不碰', () => {
  it('跳过两类代码围栏但继续处理代码块外内容', () => {
    const input = '```md\n$$\\begin{pmatrix}\na\n\\end{pmatrix}$$\n```'
    expect(normalizeMathFences(input)).toBe(input)
    const tildeInput = '~~~\n$$\\begin{x}\na\n\\end{x}$$\n~~~'
    expect(normalizeMathFences(tildeInput)).toBe(tildeInput)

    const mixedInput = '```\n$$\\begin{a}\n```\n\n$$\\begin{pmatrix}\nb\n\\end{pmatrix}$$'
    const out = normalizeMathFences(mixedInput)
    // Preserve the line inside the code block.
    expect(out).toContain('```\n$$\\begin{a}\n```')
    // Split the line outside the code block.
    expect(out).toContain('$$\n\\begin{pmatrix}\nb\n\\end{pmatrix}\n$$')
  })
})

describe('normalizeMathFences — 真实回归用例', () => {
  // Taken from a real model response in a KaTeX rendering session: it merged 26 of 27 formulas
  // into one giant math block and turned the entire response into a red error. Preserve it as the motivating regression.
  const REAL = [
    '### 线性代数',
    '矩阵：',
    '$$\\begin{pmatrix}',
    'a & b \\\\',
    'c & d',
    '\\end{pmatrix}$$',
    '',
    '行列式：',
    '$$\\det(A) = \\begin{vmatrix}',
    'a_{11} & a_{12} \\\\',
    'a_{21} & a_{22}',
    '\\end{vmatrix}$$',
    '',
    '### 求和与乘积',
    '求和公式：',
    '$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$',
  ].join('\n')

  it('修复真实回复，同时保留标题、单行公式和幂等性', () => {
    const out = normalizeMathFences(REAL)
    expect(out).toContain('$$\n\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}\n$$')
    expect(out).toContain('$$\n\\det(A) = \\begin{vmatrix}')
    expect(out).toContain('\\end{vmatrix}\n$$')
    // Preserve the single-line summation formula because it already renders correctly.
    expect(out).toContain('$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$')
    expect(out).toContain('### 线性代数')
    expect(out).toContain('### 求和与乘积')
    expect(normalizeMathFences(out)).toBe(out)
  })
})
