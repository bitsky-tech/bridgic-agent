import { describe, expect, it } from 'bun:test'
import {
  createBlankPresentationProject,
  createBlankPresentationSlide,
  presentationSlideBackground,
  presentationSlideFooter,
  replacePresentationPages,
} from '@/atoms/presentation'
import { applyPresentationDesign } from '../presentationDesign'

describe('presentation design defaults', () => {
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
