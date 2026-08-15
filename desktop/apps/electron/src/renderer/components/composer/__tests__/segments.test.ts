import { describe, expect, it } from 'bun:test'
import {
  blocksToSegments,
  EMPTY_SEGMENTS,
  findTriggerAtCaret,
  getReachableCaretEnd,
  hasActiveTrigger,
  isSegmentsEmpty,
  locateCaret,
  MentionGroup,
  replaceTriggerWithSegments,
  replaceTriggerWithToken,
  segmentLength,
  segmentsEqual,
  segmentsToBlocks,
  segmentsToHtml,
  segmentsToText,
  textToSegments,
  tokenInsertCaretOffset,
  type Segment,
  type TokenSegment,
} from '../segments'

describe('composer segment contract', () => {
  it('serializes mixed input consistently for display, wire, and editable HTML', () => {
    const segments: Segment[] = [
      { type: 'text', value: '看 ' },
      {
        type: 'mention',
        id: 'file-1',
        label: '行程单.pdf',
        group: MentionGroup.File,
        path: '发票/行程单.pdf',
      },
      { type: 'text', value: ' 再跑 ' },
      {
        type: 'slash',
        id: 'wf-1',
        label: '每周报告',
        resource: 'workflow',
      },
    ]

    expect(segmentsToText(segments)).toBe('看 @行程单.pdf 再跑 /每周报告')
    expect(segmentsToBlocks(segments)).toEqual([
      { type: 'text', value: '看 ' },
      {
        type: 'mention',
        id: 'file-1',
        label: '行程单.pdf',
        group: MentionGroup.File,
        path: '发票/行程单.pdf',
      },
      { type: 'text', value: ' 再跑 ' },
      {
        type: 'slash',
        id: 'wf-1',
        label: '每周报告',
        resource: 'workflow',
      },
    ])

    const html = segmentsToHtml(segments)
    expect(html).toContain('data-token-path="发票/行程单.pdf"')
    expect(html).toContain('data-token-resource="workflow"')
    expect(html).toContain('contenteditable="false"')
  })

  it('escapes rendered content and preserves entity-specific mention presentation', () => {
    const html = segmentsToHtml([
      { type: 'text', value: '<b>x</b>\n' },
      { type: 'mention', id: 'skill', label: '<script>x</script>', group: MentionGroup.Skill },
      { type: 'mention', id: 'workflow', label: '论文筛选', group: MentionGroup.WorkflowEntity },
      { type: 'mention', id: 'run', label: '论文筛选 · 运行结果', group: MentionGroup.WorkflowRun },
      { type: 'mention', id: 'schedule', label: '每日汇总', group: MentionGroup.Schedule },
    ])

    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;<br>')
    expect(html).toContain('/&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('data-token-label="&lt;script&gt;x&lt;/script&gt;"')
    expect(html).toContain('>@论文筛选<')
    expect(html).toContain('bg-entity-workflow-bg text-entity-workflow')
    expect(html).toContain('>@论文筛选 · 运行结果<')
    expect(html).toContain('bg-entity-workflow-run-bg text-entity-workflow-run')
    expect(html).toContain('>@每日汇总<')
  })

  it('keeps empty editor state safe without sharing mutable arrays', () => {
    const first = textToSegments('')
    const second = textToSegments('')

    expect(Object.isFrozen(EMPTY_SEGMENTS)).toBe(true)
    expect(first).toEqual([{ type: 'text', value: '' }])
    expect(first).not.toBe(EMPTY_SEGMENTS)
    expect(first).not.toBe(second)
    expect(isSegmentsEmpty(first)).toBe(true)
    expect(isSegmentsEmpty([{ type: 'text', value: '' }, { type: 'text', value: '' }])).toBe(true)
    expect(isSegmentsEmpty([{ type: 'slash', id: 'build', label: '构建' }])).toBe(false)
    expect(textToSegments('hello')).toEqual([{ type: 'text', value: 'hello' }])
  })

  it('round-trips persisted input blocks and drops non-input history blocks', () => {
    const original: Segment[] = [
      { type: 'text', value: '看 ' },
      {
        type: 'mention',
        id: 'file-1',
        label: 'doc.md',
        group: MentionGroup.File,
        path: 'sub/doc.md',
      },
      { type: 'slash', id: 'build', label: '构建' },
    ]
    const messageBlocks = [
      ...segmentsToBlocks(original).map((block) =>
        block.type === 'text' ? { type: 'text' as const, text: block.value } : block,
      ),
      { type: 'thinking' as const, text: 'internal' },
      { type: 'text' as const, text: '' },
    ]

    expect(blocksToSegments(messageBlocks)).toEqual(original)
    expect(blocksToSegments([
      { type: 'mention', id: 'root', label: '资料/', group: MentionGroup.File },
    ])).toEqual([
      { type: 'mention', id: 'root', label: '资料/', group: MentionGroup.File },
    ])
  })

  it('locates carets only in editable text around flattened tokens', () => {
    const segments: Segment[] = [
      { type: 'text', value: 'hi ' },
      { type: 'mention', id: 'web', label: 'Web', group: MentionGroup.File },
      { type: 'text', value: ' x' },
    ]

    expect(locateCaret(segments, 2)).toEqual({ segIndex: 0, local: 2 })
    expect(locateCaret(segments, 3)).toEqual({ segIndex: 0, local: 3 })
    expect(locateCaret(segments, 5)).toBeNull()
    expect(locateCaret(segments, 7)).toEqual({ segIndex: 2, local: 0 })
    expect(locateCaret(segments, 9)).toEqual({ segIndex: 2, local: 2 })
  })

  it('matches only a live slash or mention run immediately before the caret', () => {
    const cases: Array<{
      value: string
      trigger: '/' | '@'
      caret: number | null
      filter: string | null
    }> = [
      { value: '/build', trigger: '/', caret: 6, filter: 'build' },
      { value: 'hi @foo', trigger: '@', caret: 7, filter: 'foo' },
      { value: 'foo @bar baz', trigger: '@', caret: 8, filter: 'bar' },
      { value: 'hi @foo', trigger: '@', caret: null, filter: 'foo' },
      { value: 'http://x', trigger: '/', caret: 8, filter: null },
      { value: '你好@foo', trigger: '@', caret: 7, filter: null },
      { value: '/b c', trigger: '/', caret: 4, filter: null },
      { value: 'hello', trigger: '/', caret: 5, filter: null },
    ]

    for (const { value, trigger, caret, filter } of cases) {
      const match = findTriggerAtCaret([{ type: 'text', value }], trigger, caret)
      expect(match?.filter ?? null).toBe(filter)
    }
  })

  it('does not mistake prose slashes for an active trigger', () => {
    expect(hasActiveTrigger([
      { type: 'text', value: '在 (one-off/rebuild_skill_list/) 目录下' },
    ], null)).toBe(false)
    expect(hasActiveTrigger([
      { type: 'mention', id: 'm', label: 'AmphiAgent/', group: MentionGroup.File },
      { type: 'text', value: ' 为模板 (a/b/) 目录' },
    ], 13)).toBe(false)
  })

  it('replaces a trigger with a token while preserving surrounding content and caret math', () => {
    const segments: Segment[] = [
      { type: 'text', value: '先跑 ' },
      { type: 'slash', id: 'build', label: '构建' },
      { type: 'text', value: ' 再看 @q tail' },
    ]
    const match = findTriggerAtCaret(segments, '@', 15)
    const token: TokenSegment = {
      type: 'mention',
      id: 'web',
      label: 'Web',
      group: MentionGroup.Skill,
    }

    expect(match).not.toBeNull()
    const next = replaceTriggerWithToken(segments, match!, token)
    expect(next).toEqual([
      { type: 'text', value: '先跑 ' },
      { type: 'slash', id: 'build', label: '构建' },
      { type: 'text', value: ' 再看 ' },
      token,
      { type: 'text', value: ' tail' },
    ])
    const caret = tokenInsertCaretOffset(segments, match!, token)
    expect(caret).toBe(18)
    expect(hasActiveTrigger(next, caret)).toBe(false)
  })

  it('adds one separator after an end-of-input token insertion', () => {
    const segments: Segment[] = [{ type: 'text', value: '/bu' }]
    const match = findTriggerAtCaret(segments, '/', 3)!
    const token: TokenSegment = { type: 'slash', id: 'build', label: '构建' }

    expect(replaceTriggerWithToken(segments, match, token)).toEqual([
      token,
      { type: 'text', value: ' ' },
    ])
    expect(tokenInsertCaretOffset(segments, match, token)).toBe(7)
  })

  it('splices a guided template without losing text around the trigger', () => {
    const segments: Segment[] = [{ type: 'text', value: '先看看 /sch 收尾' }]
    const match = findTriggerAtCaret(segments, '/', 8)!
    const insert: Segment[] = [
      { type: 'text', value: '帮我创建定时任务，内容:' },
      { type: 'field', id: 'description', placeholder: '任务内容', value: '' },
      { type: 'text', value: '。' },
    ]

    expect(replaceTriggerWithSegments(segments, match, insert)).toEqual([
      { type: 'text', value: '先看看 ' },
      ...insert,
      { type: 'text', value: ' 收尾' },
    ])
  })

  it('compares semantic segment structure without treating empty paths as changes', () => {
    const mention = {
      type: 'mention',
      id: 'm',
      label: 'a',
      group: MentionGroup.File,
    } satisfies Segment
    const base: Segment[] = [mention]
    expect(segmentsEqual(base, [{ ...mention }])).toBe(true)
    expect(segmentsEqual(base, [{ ...mention, path: '' }])).toBe(true)
    expect(segmentsEqual(base, [{ ...mention, path: 'x/y' }])).toBe(false)
    expect(segmentsEqual(base, [{ type: 'text', value: '@a' }])).toBe(false)
  })

  it('flattens widgets to their human value while preserving editable metadata', () => {
    const widget: Segment = {
      type: 'widget',
      kind: 'sched-freq',
      id: 'frequency',
      value: '0 0 9 * * *',
      flat: '每天 09:00',
    }

    expect(segmentsToText([widget])).toBe('每天 09:00')
    expect(segmentsToBlocks([widget])).toEqual([{ type: 'text', value: '每天 09:00' }])
    expect(segmentLength(widget)).toBe('每天 09:00'.length)
    const html = segmentsToHtml([widget])
    expect(html).toContain('data-token-type="widget"')
    expect(html).toContain('data-token-kind="sched-freq"')
    expect(html).toContain('data-token-value="0 0 9 * * *"')
    expect(html).toContain('data-token-flat="每天 09:00"')
  })

  it('keeps fields editable in HTML and flattens only their current text', () => {
    const field: Segment = {
      type: 'field',
      id: 'description',
      placeholder: '描述…',
      value: '汇总数据',
    }

    expect(segmentsToText([field])).toBe('汇总数据')
    expect(segmentsToBlocks([field])).toEqual([{ type: 'text', value: '汇总数据' }])
    expect(segmentLength(field)).toBe('汇总数据'.length)
    const html = segmentsToHtml([{ ...field, value: '' }])
    expect(html).toContain('data-field-id="description"')
    expect(html).toContain('class="composer-field"')
    expect(html).not.toContain('data-token-type="field"')
    expect(html).not.toContain('contenteditable="false"')
  })
})

describe('getReachableCaretEnd — 历史 ↓ 翻页的"光标已到尾部"判定阈值', () => {
  const mention: Segment = {
    type: 'mention',
    id: 'img-1',
    label: 'image.png',
    group: MentionGroup.File,
  }

  it('内容以非空 text 结尾时等于展平总长', () => {
    const segments: Segment[] = [
      { type: 'slash', id: 'wf-1', label: '每周报告', resource: 'workflow' },
      { type: 'text', value: ' 跑一下' },
    ]
    expect(getReachableCaretEnd(segments)).toBe(segmentsToText(segments).length)
  })

  it('以 chip 结尾（无后续文本锚点）时停在最后一段非空 text 的末尾', () => {
    // 真实场景:消息以 @image.png 收尾且分隔空格被删——contenteditable=false
    // 的 span 后没有文本节点,浏览器放不下光标,展平总长永远达不到。
    const segments: Segment[] = [{ type: 'text', value: '看这个 ' }, mention]
    expect(getReachableCaretEnd(segments)).toBe('看这个 '.length)
  })

  it('chip 后跟空 text 段(不产生 DOM 节点)同样不可达', () => {
    const segments: Segment[] = [
      { type: 'text', value: '看这个 ' },
      mention,
      { type: 'text', value: '' },
    ]
    expect(getReachableCaretEnd(segments)).toBe('看这个 '.length)
  })

  it('非空 field(可编辑 span)视同文本可达', () => {
    const segments: Segment[] = [
      { type: 'slash', id: 'wf-1', label: '每周报告', resource: 'workflow' },
      { type: 'field', id: 'args', placeholder: '补充…', value: '带上参数' },
    ]
    expect(getReachableCaretEnd(segments)).toBe(segmentsToText(segments).length)
  })

  it('纯 chip / 空内容返回 0', () => {
    expect(getReachableCaretEnd([mention])).toBe(0)
    expect(getReachableCaretEnd([...EMPTY_SEGMENTS])).toBe(0)
  })
})
