import { describe, expect, it } from 'bun:test'
import {
  createBlankPresentationProject,
  createBlankPresentationSlide,
  presentationSlideBackground,
  presentationSlideFooter,
  replacePresentationPages,
} from '@/atoms/presentation'
import { applyPresentationDesign, resizePresentationProject } from '../presentationDesign'
import { createPresentationTableElement } from '../presentationInsert'

describe('presentation design defaults', () => {
  it('scales table cell text runs when changing slide aspect ratio', () => {
    const document = createBlankPresentationProject('Rich table resize')
    const table = createPresentationTableElement([['Title']])
    table.fontSize = 20
    table.cellStyles = [[{ fontSize: 24, textRuns: [{ start: 0, end: 5, style: { fontSize: 28 } }] }]]
    document.slides.pages[0]!.elements = [table]
    const resized = resizePresentationProject(document, 'standard')
    const result = resized.slides.pages[0]!.elements[0]
    if (result?.type !== 'table') throw new Error('Missing resized table')
    expect(result.fontSize).toBe(15)
    expect(result.cellStyles?.[0]?.[0]?.fontSize).toBe(18)
    expect(result.cellStyles?.[0]?.[0]?.textRuns?.[0]?.style.fontSize).toBe(21)
  })

  it('updates global theme defaults without copying over page overrides', () => {
    const document = createBlankPresentationProject('Theme defaults')
    const inherited = document.slides.pages[0]!
    const overridden = {
      ...createBlankPresentationSlide('Override'),
      background: '#F7F3EA',
      footer: { text: 'Page footer', showDate: false, showSlideNumber: false },
    }
    document.slides = replacePresentationPages(document.slides, [inherited, overridden])

    const designed = applyPresentationDesign(document, {
      background: '#17182B',
      footer: { text: 'Global footer', showDate: true, showSlideNumber: true },
    })

    expect(designed.theme.background).toBe('#17182B')
    expect(designed.theme.footer).toEqual({ text: 'Global footer', showDate: true, showSlideNumber: true })
    expect(designed.slides.pages[0]!.background).toBeUndefined()
    expect(designed.slides.pages[0]!.footer).toBeUndefined()
    expect(presentationSlideBackground(designed.theme, designed.slides.pages[0]!)).toBe('#17182B')
    expect(presentationSlideFooter(designed.theme, designed.slides.pages[0]!)).toEqual(designed.theme.footer)
    expect(presentationSlideBackground(designed.theme, designed.slides.pages[1]!)).toBe('#F7F3EA')
    expect(presentationSlideFooter(designed.theme, designed.slides.pages[1]!)).toEqual(overridden.footer)
  })
})
