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
  it('$$ 紧跟内容 + 跨行(模型最常见的矩阵写法)', () => {
    const input = '$$\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}$$'
    expect(normalizeMathFences(input)).toBe(
      '$$\n\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}\n$$',
    )
  })

  it('只有开围栏紧跟内容时,也拆', () => {
    expect(normalizeMathFences('$$\\begin{vmatrix}\na\n$$')).toBe('$$\n\\begin{vmatrix}\na\n$$')
  })

  it('只有闭围栏被粘住时,也拆', () => {
    expect(normalizeMathFences('$$\na\n\\end{vmatrix}$$')).toBe('$$\na\n\\end{vmatrix}\n$$')
  })

  it('保留缩进(≤3 空格仍是 markdown 块级上下文)', () => {
    expect(normalizeMathFences('  $$\\begin{pmatrix}\na\n$$')).toBe('  $$\n\\begin{pmatrix}\na\n$$')
  })
})

describe('normalizeMathFences — 不得误伤当前渲染正常的写法', () => {
  it('完整单行公式原样不动(它走行内 math,拆了会变 display 样式)', () => {
    const input = '$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$'
    expect(normalizeMathFences(input)).toBe(input)
  })

  it('单行公式 + 后置文字,不动', () => {
    const input = '$$a$$ 后面的文字'
    expect(normalizeMathFences(input)).toBe(input)
  })

  it('一行里两个完整公式,不动', () => {
    const input = '$$a$$ 中间 $$b$$'
    expect(normalizeMathFences(input)).toBe(input)
  })

  it('已经合规的块级围栏,不动', () => {
    const input = '$$\n\\begin{pmatrix}\na & b\n\\end{pmatrix}\n$$'
    expect(normalizeMathFences(input)).toBe(input)
  })

  it('行内单 $ 公式,不动', () => {
    const input = '质能方程 $E = mc^2$ 众所周知'
    expect(normalizeMathFences(input)).toBe(input)
  })

  it('完全没有 $$ 的文档,逐字返回', () => {
    const input = '# 标题\n\n普通段落 `code` **粗体**'
    expect(normalizeMathFences(input)).toBe(input)
  })
})

describe('normalizeMathFences — 代码块内一律不碰', () => {
  it('``` 围栏里的 $$ 写法不被改写(否则会毁掉讲解 $$ 语法的示例)', () => {
    const input = '```md\n$$\\begin{pmatrix}\na\n\\end{pmatrix}$$\n```'
    expect(normalizeMathFences(input)).toBe(input)
  })

  it('~~~ 围栏同样跳过', () => {
    const input = '~~~\n$$\\begin{x}\na\n\\end{x}$$\n~~~'
    expect(normalizeMathFences(input)).toBe(input)
  })

  it('代码块之外的照常处理', () => {
    const input = '```\n$$\\begin{a}\n```\n\n$$\\begin{pmatrix}\nb\n\\end{pmatrix}$$'
    const out = normalizeMathFences(input)
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

  it('两个跨行矩阵都被拆开,单行求和公式不动', () => {
    const out = normalizeMathFences(REAL)
    expect(out).toContain('$$\n\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}\n$$')
    expect(out).toContain('$$\n\\det(A) = \\begin{vmatrix}')
    expect(out).toContain('\\end{vmatrix}\n$$')
    // 单行的求和公式保持原样(它本来就渲染正常)
    expect(out).toContain('$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$')
  })

  it('markdown 标题不受影响', () => {
    const out = normalizeMathFences(REAL)
    expect(out).toContain('### 线性代数')
    expect(out).toContain('### 求和与乘积')
  })

  it('幂等 —— 跑两遍与跑一遍结果相同', () => {
    const once = normalizeMathFences(REAL)
    expect(normalizeMathFences(once)).toBe(once)
  })
})
