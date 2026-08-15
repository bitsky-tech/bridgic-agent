/**
 * caretDom + segments 的 DOM 侧测试 —— 光标落位 / 偏移读取 / DOM 反解析。
 *
 * 这里是 composer 里最难也最容易静默出错的一段:`placeCaretAtOffset`(偏移 → 光标)
 * 与 `caretOffsetInEditor`(光标 → 偏移)必须用**同一套字符记账**,两者互为逆函数。
 * 口径一旦漂移不会抛错,只表现为「@ 菜单在错的位置弹出 / 文字插到奇怪的地方」——
 * 所以主力用例是**往返测试**:place(n) 之后 read() 必须还等于 n。
 *
 * DOM 环境:happy-dom **按文件局部注册**,不走全局 preload —— test-setup.ts 记录了
 * 若干 atom 测试会自行 stub `globalThis.window` 且不清理,全局挂 DOM 会与之打架。
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// happy-dom 注册后再 import —— 模块顶层若触碰 DOM,提前 import 会拿到未注册的全局。
const { pickAdjacentField, placeCaretAtEnd, placeCaretAtOffset, placeCaretInElement } =
  await import('../caretDom')
const { caretOffsetInEditor, parseSegmentsFromDOM, segmentsToHtml, segmentsToText, tokenDomLength } =
  await import('../segments')
const { SlashRowKind } = await import('../menus/slashRows')

/** 造一个 contenteditable 宿主并塞入 html;返回该元素(已挂进 document)。 */
function editor(html: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('pickAdjacentField(Tab / Shift+Tab 在 field 槽间跳)', () => {
  /** 造含两个 field 槽(描述 + 名称)的编辑器,返回 [editor, [desc, name]]。 */
  function twoFields(): [HTMLElement, HTMLElement[]] {
    const el = editor(
      segmentsToHtml([
        { type: 'text', value: '内容: ' },
        { type: 'field', id: 'sched-desc', placeholder: '描述', value: '' },
        { type: 'text', value: '，命名为: ' },
        { type: 'field', id: 'sched-name', placeholder: '任务名称', value: '' },
        { type: 'text', value: '。' },
      ]),
    )
    return [el, Array.from(el.querySelectorAll<HTMLElement>('[data-field-id]'))]
  }

  it('不在任何 field 内:next→首个、prev→末个', () => {
    const [, fields] = twoFields()
    expect(pickAdjacentField(fields, null, 'next')).toBe(fields[0]!)
    expect(pickAdjacentField(fields, null, 'prev')).toBe(fields[1]!)
  })

  it('在描述槽内:next→名称槽', () => {
    const [, fields] = twoFields()
    expect(pickAdjacentField(fields, fields[0]!, 'next')).toBe(fields[1]!)
  })

  it('在名称槽(末个)内:next→null(放行原生 Tab,不困住焦点)', () => {
    const [, fields] = twoFields()
    expect(pickAdjacentField(fields, fields[1]!, 'next')).toBeNull()
  })

  it('在名称槽内:prev→描述槽', () => {
    const [, fields] = twoFields()
    expect(pickAdjacentField(fields, fields[1]!, 'prev')).toBe(fields[0]!)
  })

  it('无 field 槽:null', () => {
    expect(pickAdjacentField([], null, 'next')).toBeNull()
  })
})

describe('placeCaretInElement(Tab / seed 聚焦落进 field 槽)', () => {
  it('空 field 也能把光标落进内部,偏移落在它之前的文本长度处', () => {
    const el = editor(
      segmentsToHtml([
        { type: 'text', value: '命名为: ' },
        { type: 'field', id: 'sched-name', placeholder: '任务名称', value: '' },
        { type: 'text', value: '，频率' },
      ]),
    )
    const field = el.querySelector<HTMLElement>('[data-field-id="sched-name"]')!
    placeCaretInElement(field)
    expect(caretOffsetInEditor(el)).toBe('命名为: '.length)
  })

  it('field 有内容时光标落到其末尾', () => {
    const el = editor(
      segmentsToHtml([
        { type: 'text', value: '命名为: ' },
        { type: 'field', id: 'sched-name', placeholder: '任务名称', value: '日报' },
      ]),
    )
    const field = el.querySelector<HTMLElement>('[data-field-id="sched-name"]')!
    placeCaretInElement(field)
    expect(caretOffsetInEditor(el)).toBe('命名为: 日报'.length)
  })
})

describe('placeCaretAtEnd', () => {
  it('把光标收到内容末尾', () => {
    const el = editor('你好世界')
    placeCaretAtEnd(el)
    expect(caretOffsetInEditor(el)).toBe(4)
  })

  it('末尾是 token chip 时也落在其后', () => {
    const el = editor(segmentsToHtml([{ type: 'slash', id: 'build', label: '构建' }]))
    placeCaretAtEnd(el)
    // '/build' = 6 字符
    expect(caretOffsetInEditor(el)).toBe(6)
  })
})

/**
 * 契约:chip 是 contenteditable=false,光标**停不进去**,所以只有「文本位置 + chip 边界」
 * 是合法落点,那些必须精确往返;落在 chip 内部的偏移会吸附到 chip 尾边(见
 * placeCaretAtOffset 的 setStartAfter 分支)。两条都测 —— 吸附行为本身也是契约,
 * 变了会让 @ 菜单在错的位置弹出。
 */
describe('placeCaretAtOffset ↔ caretOffsetInEditor(核心不变式)', () => {
  /** 逐个断言:place(n) 之后 read() 恰好回到 n。 */
  function expectExactRoundTrip(el: HTMLElement, offsets: number[]): void {
    for (const n of offsets) {
      placeCaretAtOffset(el, n)
      expect({ placed: n, read: caretOffsetInEditor(el) }).toEqual({ placed: n, read: n })
    }
  }

  it('纯文本:每个偏移都精确往返', () => {
    const el = editor('你好世界')
    expectExactRoundTrip(el, [0, 1, 2, 3, 4])
  })

  it('文本 + slash chip + 文本:文本位置与 chip 两边精确往返', () => {
    const segs = [
      { type: 'text' as const, value: '前 ' },
      { type: 'slash' as const, id: 'build', label: '构建' },
      { type: 'text' as const, value: ' 后' },
    ]
    const el = editor(segmentsToHtml(segs))
    expect(segmentsToText(segs)).toBe('前 /build 后') // 2 + 6 + 2 = 10
    // 0-2 = 前置文本 + chip 头边;8 = chip 尾边;9-10 = 后置文本。
    expectExactRoundTrip(el, [0, 1, 2, 8, 9, 10])
  })

  it('落进 slash chip 内部的偏移吸附到尾边(光标进不去 chip)', () => {
    const segs = [
      { type: 'text' as const, value: '前 ' },
      { type: 'slash' as const, id: 'build', label: '构建' },
      { type: 'text' as const, value: ' 后' },
    ]
    const el = editor(segmentsToHtml(segs))
    for (const inside of [3, 4, 5, 6, 7]) {
      placeCaretAtOffset(el, inside)
      expect(caretOffsetInEditor(el)).toBe(8)
    }
  })

  it('mention chip 同样:边界精确、内部吸附', () => {
    const segs = [
      { type: 'text' as const, value: 'a ' },
      { type: 'mention' as const, id: 'm1', label: '文档', group: '文件/文件夹' },
      { type: 'text' as const, value: ' b' },
    ]
    const el = editor(segmentsToHtml(segs))
    expect(segmentsToText(segs)).toBe('a @文档 b') // 2 + 3 + 2 = 7
    expectExactRoundTrip(el, [0, 1, 2, 5, 6, 7])
    for (const inside of [3, 4]) {
      placeCaretAtOffset(el, inside)
      expect(caretOffsetInEditor(el)).toBe(5)
    }
  })

  it('chip 位于最开头:offset 0 落在 chip 之前(↑ 调历史的实际路径)', () => {
    // 历史里最常见的形态就是 `/build …` / `/help` —— 用 ↑ 翻回来时光标要落
    // 首位,走的正是 placeCaretAtOffset 的 `remaining <= 0 → setStartBefore`
    // 分支。此前所有 chip 用例前面都垫了文本,这条路径没被测过。
    const segs = [
      { type: 'slash' as const, id: 'build', label: '构建' },
      { type: 'text' as const, value: ' 做个爬虫' },
    ]
    const el = editor(segmentsToHtml(segs))
    expect(segmentsToText(segs)).toBe('/build 做个爬虫') // 6 + 5 = 11
    expectExactRoundTrip(el, [0, 6, 7, 11])
  })

  it('chip 位于末尾:offset=总长落在 chip 之后(↓ 调历史的实际路径)', () => {
    const segs = [
      { type: 'text' as const, value: '看 ' },
      { type: 'mention' as const, id: 'm1', label: '报告', group: '文件/文件夹' },
    ]
    const el = editor(segmentsToHtml(segs))
    expect(segmentsToText(segs)).toBe('看 @报告') // 2 + 3 = 5
    expectExactRoundTrip(el, [0, 1, 2, 5])
  })

  it('整条内容只有一个 chip:首尾两端都精确', () => {
    const segs = [{ type: 'slash' as const, id: 'help', label: '帮助' }]
    const el = editor(segmentsToHtml(segs))
    expect(segmentsToText(segs)).toBe('/help')
    expectExactRoundTrip(el, [0, 5])
  })

  it('widget host 按 data-token-flat 记账,而非其渲染内容', () => {
    // widget 的 HTML 宿主在字符串里是空的(运行时由 portal 填充),flat 才是逻辑长度 ——
    // 记账若改用 textContent,portal 一挂上光标就会全线错位。
    const flat = '每天 9:00'
    const segs = [
      { type: 'text' as const, value: 'X' },
      { type: 'widget' as const, kind: 'sched-freq', id: 'f', value: '0 0 9 * * *', flat },
      { type: 'text' as const, value: 'Y' },
    ]
    const el = editor(segmentsToHtml(segs))
    const host = el.querySelector('[data-token-type="widget"]') as HTMLElement
    expect(tokenDomLength(host)).toBe(flat.length)

    const tail = 1 + flat.length // chip 尾边
    expectExactRoundTrip(el, [0, 1, tail, tail + 1])
  })

  it('偏移越界时兜底到末尾,不抛', () => {
    const el = editor('abc')
    placeCaretAtOffset(el, 999)
    expect(caretOffsetInEditor(el)).toBe(3)
  })

  it('<br> 记 1 个字符', () => {
    const el = editor('a<br>b')
    placeCaretAtOffset(el, 2)
    expect(caretOffsetInEditor(el)).toBe(2)
  })
})

describe('parseSegmentsFromDOM(此前零覆盖)', () => {
  it('文本 + slash + mention 往返回 Segment[]', () => {
    const segs = [
      { type: 'text' as const, value: '前 ' },
      { type: 'slash' as const, id: 'build', label: '构建' },
      { type: 'text' as const, value: ' 中 ' },
      { type: 'mention' as const, id: 'm1', label: '文档', group: '文件/文件夹' },
      { type: 'text' as const, value: ' 后' },
    ]
    const el = editor(segmentsToHtml(segs))
    expect(parseSegmentsFromDOM(el)).toEqual(segs)
  })

  it('mention 的 path 必须活过 DOM 往返 —— 丢了会静默退化成挂载根', () => {
    const segs = [
      { type: 'mention' as const, id: 'mnt', label: 'a.ts', group: '文件/文件夹', path: 'src/a.ts' },
      { type: 'text' as const, value: '' },
    ]
    const el = editor(segmentsToHtml(segs))
    const parsed = parseSegmentsFromDOM(el)
    expect(parsed[0]).toMatchObject({ type: 'mention', path: 'src/a.ts' })
  })

  it('widget 从 data-* 还原,不递归进 portal 内容', () => {
    const segs = [
      { type: 'widget' as const, kind: 'sched-name', id: 'n', value: '日报', flat: '日报' },
      { type: 'text' as const, value: '' },
    ]
    const el = editor(segmentsToHtml(segs))
    // 模拟 portal 往宿主里塞了控件 DOM —— 解析必须无视它。
    const host = el.querySelector('[data-token-type="widget"]') as HTMLElement
    host.innerHTML = '<input value="不该被解析" /><span>噪音</span>'
    const parsed = parseSegmentsFromDOM(el)
    expect(parsed[0]).toEqual({ type: 'widget', kind: 'sched-name', id: 'n', value: '日报', flat: '日报' })
  })

  it('field 不被识别为 token —— 内层文字拍平进主文本流(@ 因此零内核改动可用)', () => {
    const segs = [
      { type: 'text' as const, value: '要 ' },
      { type: 'field' as const, id: 'desc', placeholder: '描述', value: '每天发日报' },
    ]
    const el = editor(segmentsToHtml(segs))
    expect(parseSegmentsFromDOM(el)).toEqual([{ type: 'text', value: '要 每天发日报' }])
  })

  it('空 field 原样存活 —— 否则空槽(如「命名为」后的名称)会在下次 DOM 重写时凭空消失', () => {
    // 名称槽是空 field。用户在别处(描述)插 @mention 会触发 model→DOM 全量重写;
    // 若解析把空 field 拍平成「无」,该 field 就从 model 里掉了,重写后名称块消失。
    // 空 field 必须保留 boundary;非空 field 才拍平(见上一条,@ 支持所需)。
    const segs = [
      { type: 'text' as const, value: '，命名为 ' },
      { type: 'field' as const, id: 'sched-name', placeholder: '任务名称', value: '' },
      { type: 'text' as const, value: '，调度频率 ' },
    ]
    const el = editor(segmentsToHtml(segs))
    expect(parseSegmentsFromDOM(el)).toEqual([
      { type: 'text', value: '，命名为 ' },
      { type: 'field', id: 'sched-name', placeholder: '任务名称', value: '' },
      { type: 'text', value: '，调度频率 ' },
    ])
  })

  it('<br> 还原成换行', () => {
    const el = editor('a<br>b')
    expect(parseSegmentsFromDOM(el)).toEqual([{ type: 'text', value: 'a\nb' }])
  })

  it('粘贴进来的包装元素被递归穿透,内层 chip 存活', () => {
    const chip = segmentsToHtml([{ type: 'slash', id: 'help', label: '帮助' }])
    const el = editor(`<div><span>包 ${chip} 装</span></div>`)
    const parsed = parseSegmentsFromDOM(el)
    expect(parsed.some((s) => s.type === 'slash' && s.id === 'help')).toBe(true)
  })

  it('末尾恒留一个 text 段供光标落脚', () => {
    const el = editor(segmentsToHtml([{ type: 'slash', id: 'help', label: '帮助' }]))
    const parsed = parseSegmentsFromDOM(el)
    expect(parsed[parsed.length - 1]).toEqual({ type: 'text', value: '' })
  })
})

describe('SlashRowKind 在 DOM 环境下仍可用(冒烟)', () => {
  it('const 成员齐全', () => {
    expect(Object.values(SlashRowKind)).toEqual(['command', 'skill', 'workflow', 'schedule'])
  })
})
