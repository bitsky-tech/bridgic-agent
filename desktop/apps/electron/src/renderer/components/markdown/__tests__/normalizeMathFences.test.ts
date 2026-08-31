/**
 * normalizeMathFences 测试 —— 修坏的、且**不碰好的**。
 *
 * 这个函数的风险不在"修不好",而在"误伤":完整单行公式(`$$x=1$$`)当前走行内 math、
 * 渲染正常,若被拆成块级会从行内样式变 display 样式 —— 那是视觉回归。所以「不动」的
 * 用例和「拆开」的用例同等重要。
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
    // 代码块内那行原样
    expect(out).toContain('```\n$$\\begin{a}\n```')
    // 代码块外的被拆开
    expect(out).toContain('$$\n\\begin{pmatrix}\nb\n\\end{pmatrix}\n$$')
  })
})

describe('normalizeMathFences — 真实回归用例', () => {
  // 摘自一条真实模型回复(会话 KaTeX 渲染测试):它导致 27 组公式里 26 组被吞进同一个
  // 巨型 math 块、整篇回复变成红色报错。这是本函数存在的理由,原样钉住。
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
    // 单行的求和公式保持原样(它本来就渲染正常)
    expect(out).toContain('$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$')
    expect(out).toContain('### 线性代数')
    expect(out).toContain('### 求和与乘积')
    expect(normalizeMathFences(out)).toBe(out)
  })
})
