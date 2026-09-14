import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n'
import { PresentationArtifactContent } from './PresentationArtifactContent'
import { getPresentationTrace, type PresentationTrace } from './presentation-trace-data'

describe('presentation artifact content', () => {
  const render = (trace: PresentationTrace, artifact: 'brief' | 'outline' | 'sources') => renderToStaticMarkup(
    <I18nProvider initialLocale="en-US"><PresentationArtifactContent trace={trace} artifact={artifact} onRound={() => {}} /></I18nProvider>,
  )

  test('derives outline counts from the pages and renders an empty outline safely', () => {
    const trace = getPresentationTrace('en-US')
    const html = render(trace, 'outline')
    expect(html).toContain('4 chapters / 11 slides')
    expect(html).toContain('the outline contains 11')
    expect(html.match(/<option /g)).toHaveLength(11)
    expect(html).not.toContain('<dialog')

    const shortened = { ...trace, chapters: trace.chapters.slice(0, 2).map((chapter, index) => ({ ...chapter, slides: index ? chapter.slides.slice(0, 1) : [] })), reportedSlideCount: 1 }
    const shortenedHtml = render(shortened, 'outline')
    expect(shortenedHtml).toContain('2 chapters / 1 slide')
    expect(shortenedHtml).toContain(shortened.chapters[1]!.slides[0]!.keyMessage)
    expect(shortenedHtml).not.toContain('trace-discrepancy')
    expect(shortenedHtml).toContain('R10 outline record')

    const emptyHtml = render({ ...trace, chapters: [], reportedSlideCount: 0 }, 'outline')
    expect(emptyHtml).toContain('0 chapters / 0 slides')
    expect(emptyHtml).toContain('This outline has no slides yet.')
    expect(emptyHtml).not.toMatch(/<select|trace-discrepancy/)
  })

  test('preserves source retrieval outcomes and links each record to its originating round', async () => {
    const trace = getPresentationTrace('en-US')
    const html = render(trace, 'sources')
    const cards: string[] = []
    await new HTMLRewriter().on('.trace-source-card', {
      element: () => { cards.push('') },
      text: chunk => { cards[cards.length - 1] += chunk.text },
    }).transform(new Response(html)).text()

    expect(html).toContain(`${trace.sources.length} sources`)
    expect(html).toContain('Registering a source does not mean it was retrieved or verified.')
    expect(cards).toHaveLength(trace.sources.length)
    trace.sources.forEach((source, index) => {
      expect(cards[index]).toContain(source.note)
      expect(cards[index]).toContain(source.status === 'available' ? 'Available' : 'Unverified')
      expect(cards[index]).toContain(source.kind === 'brief' ? 'R03' : 'R09')
    })
    expect(html).not.toContain('<dialog')
  })
})
