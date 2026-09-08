import { describe, expect, it } from 'bun:test'
import {
  presentationCharacterSpacingFromPoints,
  presentationCharacterSpacingToPoints,
  presentationFontSizeFromPoints,
  presentationFontSizeToPoints,
  presentationRenderingFontFamily,
  shouldSplitPresentationTextByGrapheme,
  patchPresentationText,
  presentationTextDisplaySegments,
  presentationTextStyleAt,
  scalePresentationParagraphs,
  presentationNumberMarker,
} from '../presentationText'
import { formatPresentationText, stripPresentationTextFormatting, layoutPresentationVerticalText, type PresentationTextElement } from '../../atoms/presentation'

describe('presentation text rendering', () => {
  it.each([[27, 'alphaUcPeriod', 'AA. '], [9, 'romanLcParenBoth', '(ix) '], [12, 'arabicParenR', '12) '],
    [2, 'circleNumDbPlain', '② '], [11, 'circleNumWdBlackPlain', '⓫ '], [12, 'ea1ChsPlain', '十二 ']] as const)('formats list number %s using %s', (value, format, expected) => {
    expect(presentationNumberMarker(value, format)).toBe(expected)
  })
  const rich: PresentationTextElement = {
    id: 'multi-edit', type: 'text', x: 0, y: 0, width: 500, height: 200, rotation: 0,
    text: '标题 English 😀结尾', fontSize: 40, fontFamily: 'Arial', fontWeight: 700, color: '#111111', align: 'left',
    textRuns: [{ start: 3, end: 10, style: { fontSize: 20, fontWeight: 400, color: '#0088CC' } },
      { start: 11, end: 13, style: { fontFamily: 'Apple Color Emoji', color: '#FF0000' } }],
  }

  it('retains empty-paragraph styles when surrounding text is edited or the frame is resized', () => {
    const element: PresentationTextElement = { ...rich, text: 'Before\n\nAfter', textRuns: undefined,
      paragraphs: [{ start: 0, end: 6, style: {} }, { start: 7, end: 7, style: {}, endStyle: { fontSize: 128, fontFamily: 'Georgia' } }, { start: 8, end: 13, style: {} }],
    }
    const edited = patchPresentationText(element, { text: 'New Before\n\nNew After' })
    expect(edited.paragraphs?.[1]).toMatchObject({ start: 11, end: 11, endStyle: { fontSize: 128, fontFamily: 'Georgia' } })
    expect(patchPresentationText(edited, { fontSize: 20, fontFamily: 'Arial' }).paragraphs?.[1]!.endStyle).toMatchObject({ fontSize: 64, fontFamily: 'Arial' })
    expect(scalePresentationParagraphs(element.paragraphs, 0.5)?.[1]!.endStyle).toMatchObject({ fontSize: 64, fontFamily: 'Georgia' })
  })

  it('keeps all untouched runs through separated edits, replacements and emoji insertion', () => {
    const updated = patchPresentationText(rich, { text: '新标题 English 😀新结尾' })
    expect(presentationTextStyleAt(updated, 4)).toMatchObject({ fontSize: 20, fontWeight: 400, color: '#0088CC' })
    expect(presentationTextStyleAt(updated, 12)).toMatchObject({ fontFamily: 'Apple Color Emoji', color: '#FF0000' })
    const replaced = patchPresentationText(updated, { text: '新标题 French 😀新结尾' })
    expect(presentationTextStyleAt(replaced, 4).color).toBe('#0088CC')
    const emoji = patchPresentationText(updated, { text: '新标题 English 😃😀新结尾' })
    expect(emoji.textRuns?.every(run => !/[\uDC00-\uDFFF]/.test(emoji.text[run.start]!))).toBe(true)
  })

  it('treats explicit runs as authoritative while scaling inherited runs with frame formatting', () => {
    const textRuns = [{ start: 3, end: 10, style: { fontSize: 40, fontWeight: 400 as const, color: '#0088CC' } }]
    const changed = patchPresentationText(rich, { fontSize: 80, fontWeight: 700, color: '#FF0000', textRuns })
    expect(changed.textRuns).toEqual(textRuns)
    expect(presentationTextStyleAt(changed, 0)).toMatchObject({ fontSize: 80, color: '#FF0000' })
    expect(presentationTextStyleAt(changed, 3)).toMatchObject(textRuns[0]!.style)
    expect(presentationTextStyleAt(patchPresentationText(rich, { fontSize: 80 }), 3).fontSize).toBe(40)
  })

  it('numbers list items independently from headings, with nested levels and authored sequence starts', () => {
    const text = 'Heading\nFirst\nNested\nNext\nSecond\nBreak\nRestart\nContinue'
    let start = 0
    const styles = [{ listStyle: 'none' }, { listStyle: 'number', listStartAt: 5 },
      { listStyle: 'number', indentLevel: 1 }, { listStyle: 'number', indentLevel: 1 },
      { listStyle: 'number', listStartAt: 5 }, { listStyle: 'none' },
      { listStyle: 'number', listStartAt: 9 }, { listStyle: 'number' }] as const
    const element: PresentationTextElement = { ...rich, text, textRuns: undefined, paragraphs: text.split('\n').map((part, index) => {
      const paragraph = { start, end: start + part.length, style: styles[index]! }
      start = paragraph.end + 1
      return paragraph
    }) }
    const displayed = 'Heading\n5. First\n1. Nested\n2. Next\n6. Second\nBreak\n9. Restart\n10. Continue'
    expect(formatPresentationText(element)).toBe(displayed)
    expect(stripPresentationTextFormatting(displayed.replace('Second', 'Changed'), element)).toBe(text.replace('Second', 'Changed'))
    expect(formatPresentationText({ ...rich, text: 'First\n\nSecond', listStyle: 'number', textRuns: undefined })).toBe('1. First\n\n2. Second')
  })

  it('removes generated custom markers after text edits and deletion of an earlier list item', () => {
    const element: PresentationTextElement = { ...rich, text: 'First\nSecond', textRuns: undefined, paragraphs: [
      { start: 0, end: 5, style: { listStyle: 'number', listNumberFormat: 'romanUcPeriod' } },
      { start: 6, end: 12, style: { listStyle: 'number', listNumberFormat: 'romanUcPeriod' } },
    ] }
    expect(stripPresentationTextFormatting('II. Second', element)).toBe('Second')
    expect(stripPresentationTextFormatting('I. Changed\nII. Second', element)).toBe('Changed\nSecond')
    element.paragraphs!.forEach(paragraph => { paragraph.style = { listStyle: 'bullet', listBulletChar: '◆' } })
    expect(stripPresentationTextFormatting('◆ Changed\n◆ Second', element)).toBe('Changed\nSecond')
    const alpha = { ...rich, textRuns: [{ start: 3, end: 10, style: { opacity: 0.25 } }] }
    const patched = patchPresentationText(alpha, { text: '新标题 English 😀结尾', opacity: 0.5 })
    expect(presentationTextStyleAt(patched, 4).opacity).toBe(0.25)
    expect(patched.opacity).toBe(0.5)
  })

  it('rebases paragraph styles without turning retained soft breaks into hard breaks', () => {
    const element: PresentationTextElement = { ...rich, text: 'Title\nBody\nMore', textRuns: undefined, paragraphs: [
      { start: 0, end: 5, style: { align: 'center', lineSpacing: 48, spaceAfter: 12 } },
      { start: 6, end: 15, style: { align: 'right', lineSpacing: 28 } },
    ] }
    const updated = patchPresentationText(element, { text: 'New Title\nNew Body\nMore!' })
    expect(updated.paragraphs).toEqual([
      { start: 0, end: 9, style: expect.objectContaining({ align: 'center', lineSpacing: 48 }) },
      { start: 10, end: 24, style: expect.objectContaining({ align: 'right', lineSpacing: 28 }) },
    ])
    const split = patchPresentationText(updated, { text: 'New Title\nNew\nBody\nMore!' })
    expect(split.paragraphs).toHaveLength(3)
    expect(split.paragraphs?.slice(1).every(paragraph => paragraph.style.align === 'right')).toBe(true)
    const resized = patchPresentationText(element, { fontSize: 20, lineSpacing: 24, paragraphs: scalePresentationParagraphs(element.paragraphs, 0.5) })
    expect(resized.paragraphs?.map(paragraph => paragraph.style.lineSpacing)).toEqual([24, 14])
    expect(resized.paragraphs?.[0]!.style.spaceAfter).toBe(6)
    expect(patchPresentationText(element, { align: 'left', lineHeight: 1.5 }).paragraphs?.every(paragraph => paragraph.style.align === 'left' && paragraph.style.lineHeight === 1.5 && !paragraph.style.lineSpacing)).toBe(true)
  })

  it('round-trips mixed paragraph list markers through direct editing without adding markers at soft breaks', () => {
    const element: PresentationTextElement = { ...rich, text: 'Title\nBody\nMore', textRuns: undefined, paragraphs: [
      { start: 0, end: 5, style: { listStyle: 'none' } }, { start: 6, end: 15, style: { listStyle: 'bullet' } },
    ] }
    expect(formatPresentationText(element)).toBe('Title\n• Body\nMore')
    expect(stripPresentationTextFormatting('New Title\n• New Body\nMore', element)).toBe('New Title\nNew Body\nMore')
  })

  it('uses each vertical paragraph’s spacing for its columns', () => {
    const layout = layoutPresentationVerticalText({ ...rich, text: '甲乙\n丙丁\n戊', fontSize: 24, textRuns: undefined,
      textDirection: 'eastAsianVertical', wordWrap: false, paragraphs: [
        { start: 0, end: 2, style: { lineSpacing: 48, spaceAfter: 6 } },
        { start: 3, end: 5, style: { lineSpacing: 80, spaceBefore: 4 } },
        { start: 6, end: 7, style: {} },
      ],
    })
    expect(layout.columns).toEqual(['甲乙', '丙丁', '戊'])
    expect(layout.columnOffsets[0]! - layout.columnOffsets[1]!).toBeCloseTo(58)
    expect(layout.columnOffsets[1]! - layout.columnOffsets[2]!).toBeCloseTo(80)
    expect(layout.sourceOffsets).toEqual([[0, 1], [3, 4], [6]])
  })

  it('preserves inline suffix styles through typing, deletion and frame formatting', () => {
    const element = {
      id: 'text', type: 'text' as const, x: 0, y: 0, width: 300, height: 100, rotation: 0,
      text: '标题 English', fontSize: 32, fontFamily: 'Aptos', fontWeight: 700 as const, color: '#111111', align: 'left' as const,
      textRuns: [{ start: 3, end: 10, style: { fontSize: 16, fontWeight: 400 as const, color: '#0088CC' } }],
    }
    const inserted = patchPresentationText(element, { text: '新标题 English' })
    expect(presentationTextStyleAt(inserted, 4)).toMatchObject({ fontSize: 16, fontWeight: 400, color: '#0088CC' })
    const deleted = patchPresentationText(inserted, { text: ' English' })
    expect(presentationTextStyleAt(deleted, 1).fontSize).toBe(16)
    const formatted = patchPresentationText(inserted, { fontSize: 48, color: '#FFFFFF' })
    expect(presentationTextStyleAt(formatted, 4)).toMatchObject({ fontSize: 24, fontWeight: 400, color: '#FFFFFF' })
    expect(element.textRuns[0]!.style.fontSize).toBe(16)
  })

  it('inserts display-only list markers without shifting rich text source offsets', () => {
    const element = {
      id: 'text', type: 'text' as const, x: 0, y: 0, width: 300, height: 100, rotation: 0,
      text: 'A😀\nB', fontSize: 24, fontFamily: 'Aptos', fontWeight: 400 as const, color: '#111111', align: 'left' as const,
      listStyle: 'number' as const, textRuns: [{ start: 4, end: 5, style: { color: '#0088CC' } }],
    }
    const segments = presentationTextDisplaySegments(element)
    expect(segments.map(segment => segment.text).join('')).toBe('1. A😀\n2. B')
    expect(segments.find(segment => segment.text === 'B')).toMatchObject({ start: 4, style: { color: '#0088CC' } })
  })

  it('wraps CJK text by grapheme without changing Latin word wrapping', () => {
    expect(shouldSplitPresentationTextByGrapheme('佛教从印度传播到中国')).toBe(true)
    expect(shouldSplitPresentationTextByGrapheme('Buddhism spread across Asia')).toBe(false)
    expect(shouldSplitPresentationTextByGrapheme('佛教从印度传播到中国', false)).toBe(false)
  })

  it('adds script-appropriate fallbacks without changing the stored font name', () => {
    expect(presentationRenderingFontFamily('思源黑体', '佛教历史')).toContain('PingFang SC')
    expect(presentationRenderingFontFamily('思源宋体', '佛教历史')).toContain('Songti SC')
    expect(presentationRenderingFontFamily('思源黑体', '01')).toContain('PingFang SC')
    expect(presentationRenderingFontFamily('思源宋体', 'CONTENTS')).toContain('Songti SC')
    expect(presentationRenderingFontFamily('叶根友毛笔行书2.0版', '佛教历史')).toStartWith('"叶根友毛笔行书2.0版",')
    expect(presentationRenderingFontFamily('叶根友毛笔行书2.0版', '佛教历史')).toContain('Kaiti SC')
    expect(presentationRenderingFontFamily('经典繁方篆', '壹')).toContain('Kaiti SC')
    expect(presentationRenderingFontFamily('Aptos', 'Buddhist History')).toBe('"Aptos", "Helvetica Neue", Arial, sans-serif')
  })

  it('converts PowerPoint point metrics into browser and Fabric units without losing tracking', () => {
    expect(presentationFontSizeFromPoints(45)).toBe(60)
    expect(presentationFontSizeToPoints(60)).toBe(45)
    const tracking = presentationCharacterSpacingFromPoints(4.5, 10.5)
    expect(tracking).toBeCloseTo(428.571, 3)
    expect(presentationCharacterSpacingToPoints(tracking, 10.5)).toBeCloseTo(4.5, 6)
  })
})
