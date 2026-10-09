import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { activeSessionIdAtom } from '../sessions'
import {
  PRESENTATION_PAGE_SIZES,
  createBlankPresentationSlide,
  createBlankPresentationProject,
  createInitialPresentationProject,
  presentationExpandedAtom,
  purgePresentationSessionAtom,
  formatPresentationText,
  layoutPresentationVerticalText,
  presentationSlideBackground,
  presentationSlideFooter,
  stripPresentationListMarkers,
  stripPresentationTextFormatting,
} from '../presentation'

describe('presentation atoms', () => {
  it('creates documents with an explicit widescreen page size', () => {
    expect(createInitialPresentationProject().pageSize).toEqual(PRESENTATION_PAGE_SIZES.wide)
    expect(createBlankPresentationProject('Blank').pageSize).toEqual(PRESENTATION_PAGE_SIZES.wide)
  })

  it('gives every generated slide an explicit no-transition default', () => {
    const blank = createBlankPresentationSlide('Blank')
    expect(blank.transition).toEqual({ effect: 'none', durationMs: 1_000 })
    expect(blank.background).toBeUndefined()
    expect(blank.footer).toBeUndefined()
    const initialDocument = createInitialPresentationProject()
    expect(initialDocument.slides.pages.every((slide) => (
      slide.transition.effect === 'none' && slide.transition.durationMs === 1_000
    ))).toBe(true)
    expect(initialDocument.slides.pages.every((slide) => slide.footer === undefined)).toBe(true)
  })

  it('starts with one unnamed slide containing ordinary editable text boxes instead of bundled sample content', () => {
    const document = createInitialPresentationProject()
    expect(document.title).toBe('')
    expect(document.slides.pages).toHaveLength(1)
    expect(document.slides.selectedPageId).toBe(document.slides.pages[0]!.id)
    expect(document.slides.pages[0]).toMatchObject({
      layout: 'title',
      name: 'Slide 1',
      notes: '',
    })
    expect(presentationSlideBackground(document.theme, document.slides.pages[0]!)).toBe('#FFFFFF')
    expect(document.slides.pages[0]!.elements).toHaveLength(3)
    expect(document.slides.pages[0]!.elements.every((element) => element.type === 'text')).toBe(true)
    expect(document.slides.pages[0]!.elements.every((element) => element.type !== 'text' || element.text.length > 0)).toBe(true)
    expect(document.slides.pages[0]!.elements.every((element) => !('placeholder' in element))).toBe(true)
    expect(JSON.stringify(document)).not.toContain('Ideas that move forward')
  })

  it('resolves global theme defaults while preserving page overrides', () => {
    const document = createBlankPresentationProject('Theme defaults')
    const slide = document.slides.pages[0]!
    document.theme = {
      ...document.theme,
      background: '#17182B',
      footer: { text: 'Global footer', showDate: true, showSlideNumber: true },
    }

    expect(presentationSlideBackground(document.theme, slide)).toBe('#17182B')
    expect(presentationSlideFooter(document.theme, slide)).toEqual(document.theme.footer)
    expect(presentationSlideBackground(document.theme, { ...slide, background: '#F7F3EA' })).toBe('#F7F3EA')
    expect(presentationSlideFooter(document.theme, {
      ...slide,
      footer: { text: '', showDate: false, showSlideNumber: false },
    })).toEqual({ text: '', showDate: false, showSlideNumber: false })
  })

  it('formats list markers for display without polluting editable text', () => {
    const element = {
      id: 'list-text',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 300,
      height: 120,
      rotation: 0,
      text: 'First point\nSecond point',
      fontSize: 24,
      fontFamily: 'Aptos',
      fontWeight: 400 as const,
      color: '#1D1D28',
      align: 'left' as const,
      listStyle: 'number' as const,
    }

    const displayText = formatPresentationText(element)
    expect(displayText).toBe('1. First point\n2. Second point')
    expect(stripPresentationListMarkers(displayText, element.listStyle)).toBe(element.text)
  })

  it('lays out East Asian vertical text as right-to-left columns without changing its source', () => {
    const element = {
      id: 'vertical-text',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 120,
      height: 240,
      rotation: 0,
      text: '甲乙\n丙丁',
      fontSize: 24,
      fontFamily: 'Aptos',
      fontWeight: 400 as const,
      color: '#1D1D28',
      align: 'left' as const,
      textDirection: 'eastAsianVertical' as const,
    }

    const displayText = formatPresentationText(element)
    expect(displayText).toBe('丙　甲\n丁　乙')
    expect(stripPresentationTextFormatting(displayText, element)).toBe(element.text)
  })

  it('aligns the complete vertical text block without pushing a left-aligned numeral into the next title', () => {
    const element = {
      id: 'template-section-number',
      type: 'text' as const,
      x: 621,
      y: 122,
      width: 179,
      height: 116,
      rotation: 0,
      text: '壹',
      fontSize: 88,
      fontFamily: '方正行楷简体',
      fontWeight: 400 as const,
      color: '#000000',
      align: 'left' as const,
      textDirection: 'eastAsianVertical' as const,
      textInsets: { left: 9.6, top: 4.8, right: 9.6, bottom: 4.8 },
    }
    const layout = layoutPresentationVerticalText(element)
    const numeralRight = element.x + element.textInsets.left + layout.columnOffsets[0]! + element.fontSize
    expect(numeralRight).toBeLessThan(728)

    const centered = layoutPresentationVerticalText({ ...element, align: 'center' })
    const rightAligned = layoutPresentationVerticalText({ ...element, align: 'right' })
    expect(centered.columnOffsets[0]).toBeCloseTo(35.9)
    expect(rightAligned.columnOffsets[0]).toBeCloseTo(71.8)
  })

  it.each(['eastAsianVertical', 'stacked'] as const)('keeps spaces, markers and rich-run offsets in %s text', (textDirection) => {
    const element = { id: 'vertical', type: 'text' as const, x: 0, y: 0, width: 600, height: 400, rotation: 0,
      text: '甲\n乙\n丙', fontSize: 40, fontFamily: 'Arial', fontWeight: 400 as const, color: '#111111', align: 'left' as const,
      textDirection, wordWrap: false,
      paragraphs: [{ start: 0, end: 3, style: { listStyle: 'bullet' as const, listBulletChar: '◆', listMarkerFontFamily: 'Georgia' } },
        { start: 4, end: 5, style: { listStyle: 'number' as const, listNumberFormat: 'romanUcPeriod' } }],
      textRuns: [{ start: 2, end: 3, style: { color: '#FF0000', fontSize: 60, opacity: 0.5 } }],
    }
    const layout = layoutPresentationVerticalText(element)
    expect(layout.columns).toEqual(['◆ 甲', '乙', 'I. 丙'])
    expect(layout.sourceOffsets).toEqual([[0, 0, 0], [2], [4, 4, 4, 4]])
    expect(layout.glyphStyles[0]![0]!.fontFamily).toBe('Georgia')
    expect(layout.glyphStyles[0]![2]!.fontFamily).toBe('Arial')
    expect(layout.glyphStyles[1]![0]).toMatchObject({ fontSize: 60, color: '#FF0000', opacity: 0.5 })
    expect(formatPresentationText(element).match(/◆/g)).toHaveLength(1)
    for (const space of [' ', '　']) {
      const spaced = layoutPresentationVerticalText({ ...element, text: `背${space}景`, paragraphs: undefined, textRuns: undefined })
      expect(spaced.columns).toEqual([`背${space}景`])
      expect(spaced.rowOffsets).toEqual([[0, 40, 80]])
      expect(spaced.columnHeights).toEqual([120])
      const wrapped = layoutPresentationVerticalText({ ...element, text: `背${space}景`, height: 80, wordWrap: true, paragraphs: undefined, textRuns: undefined })
      expect(wrapped.columns).toEqual([`背${space}`, '景'])
      expect(wrapped.sourceOffsets).toEqual([[0, 1], [2]])
    }
  })

  it('keeps unwrapped vertical paragraphs intact and applies tracking along rows and line spacing across columns', () => {
    const element = {
      id: 'template-vertical-copy',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 124,
      height: 80,
      rotation: 0,
      text: '请插入您的文本内容\n请插入您的文本内容\n请插入您的文本内容',
      fontSize: 24,
      fontFamily: '楷体',
      fontWeight: 400 as const,
      color: '#000000',
      align: 'left' as const,
      textDirection: 'eastAsianVertical' as const,
      wordWrap: false,
      lineHeight: 1.5,
      characterSpacing: 250,
    }
    const layout = layoutPresentationVerticalText(element)
    expect(layout.columns).toEqual(element.text.split('\n'))
    expect(layout.rowAdvance).toBe(30)
    expect(layout.columnAdvance).toBe(36)
    expect(layout.columnOffsets).toEqual([72, 36, 0])
    expect(layoutPresentationVerticalText({ ...element, wordWrap: true }).columns.length).toBeGreaterThan(3)
  })

  it('wraps East Asian vertical text to the text-frame height instead of overflowing in paragraph columns', () => {
    const element = {
      id: 'vertical-poem',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 311,
      height: 173,
      rotation: 0,
      text: '万木冻欲折孤根暖独回 前村深雪里昨夜一枝开 \n风递幽香出禽窥素艳来 明年如应律先发映春台',
      fontSize: 30.1067,
      fontFamily: '叶根友毛笔行书2.0版',
      fontWeight: 400 as const,
      color: '#000000',
      align: 'left' as const,
      textDirection: 'eastAsianVertical' as const,
      textInsets: { left: 9.6, top: 4.8, right: 9.6, bottom: 4.8 },
    }

    const layout = layoutPresentationVerticalText(element)

    expect(layout.rowsPerColumn).toBe(5)
    expect(layout.columns).toEqual([
      '万木冻欲折',
      '孤根暖独回',
      '前村深雪里',
      '昨夜一枝开',
      '风递幽香出',
      '禽窥素艳来',
      '明年如应律',
      '先发映春台',
    ])
    expect(layout.columnOffsets[0]! + element.fontSize).toBeLessThanOrEqual(element.width - 19.2)
    expect(stripPresentationTextFormatting(formatPresentationText(element), element)).toBe(element.text)
  })

  it('keeps expanded state independent between Sessions', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(presentationExpandedAtom, true)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(presentationExpandedAtom)).toBe(false)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(presentationExpandedAtom)).toBe(true)
  })

  it('removes a deleted Session expansion state', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-delete')
    store.set(presentationExpandedAtom, true)

    store.set(purgePresentationSessionAtom, 'session-delete')

    expect(store.get(presentationExpandedAtom)).toBe(false)
  })

})
