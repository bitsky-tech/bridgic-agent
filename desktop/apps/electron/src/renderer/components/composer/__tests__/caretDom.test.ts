/**
 * DOM-side caretDom and segment tests: caret placement, offset reading, and DOM parsing.
 *
 * This is the most subtle part of the composer. `placeCaretAtOffset` and
 * `caretOffsetInEditor` must use **identical character accounting** as inverse functions.
 * Drift causes misplaced mention menus or inserted text rather than exceptions, so the primary
 * cases are **round trips** requiring read() to equal n after place(n).
 *
 * Register happy-dom **locally for this file** instead of through global preload. Some atom tests
 * stub `globalThis.window` without cleanup, so a global DOM would conflict with them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// Import after registering happy-dom so module-scope DOM access sees initialized globals.
const { pickAdjacentField, placeCaretAtEnd, placeCaretAtOffset, placeCaretInElement } =
  await import('../caretDom')
const { caretOffsetInEditor, parseSegmentsFromDOM, segmentsToHtml, segmentsToText, tokenDomLength } =
  await import('../segments')
const { SlashRowKind } = await import('../menus/slashRows')

/** Create a contenteditable host with HTML, attach it to document, and return it. */
function editor(html: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('pickAdjacentField(Tab / Shift+Tab 在 field 槽间跳)', () => {
  /** Create an editor with description and name fields, returning [editor, [desc, name]]. */
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
    // '/build' is six characters.
    expect(caretOffsetInEditor(el)).toBe(6)
  })
})

/**
 * Contract: chips use contenteditable=false, so the caret **cannot enter them**. Valid positions
 * are text offsets and chip boundaries, which must round-trip exactly. Offsets inside a chip snap
 * to its trailing edge through placeCaretAtOffset's setStartAfter branch. Snapping is also part of
 * the contract because changing it misplaces the mention menu.
 */
describe('placeCaretAtOffset ↔ caretOffsetInEditor(核心不变式)', () => {
  /** Assert each offset round-trips exactly from place(n) to read(). */
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
    // 0-2 cover leading text and the chip start; 8 is the chip end; 9-10 are trailing text.
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
    // History commonly contains `/build …` or `/help`; recalling it with Up should place the
    // caret first through `remaining <= 0 -> setStartBefore`. Earlier chip cases all had leading
    // text and did not cover this branch.
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
    // A widget host is empty in serialized HTML and populated by a portal at runtime; flat is its
    // logical length. Using textContent would shift every caret position after the portal mounts.
    const flat = '每天 9:00'
    const segs = [
      { type: 'text' as const, value: 'X' },
      { type: 'widget' as const, kind: 'sched-freq', id: 'f', value: '0 0 9 * * *', flat },
      { type: 'text' as const, value: 'Y' },
    ]
    const el = editor(segmentsToHtml(segs))
    const host = el.querySelector('[data-token-type="widget"]') as HTMLElement
    expect(tokenDomLength(host)).toBe(flat.length)

    const tail = 1 + flat.length // Trailing chip edge.
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
    // Simulate a portal inserting control DOM into the host; parsing must ignore it.
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
    // The name slot is an empty field. Inserting a mention elsewhere triggers a full model-to-DOM
    // rewrite; if parsing flattens the empty field to nothing, it disappears from the model and UI.
    // Empty fields must preserve boundaries, while non-empty fields flatten as required for mentions.
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
