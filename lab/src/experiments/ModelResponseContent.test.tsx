import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n'
import { ModelResponseContent } from './ModelResponseContent'

test('response text is a paragraph while Thinking is independently collapsed', () => {
  const html = renderToStaticMarkup(<I18nProvider initialLocale="en-US"><ModelResponseContent output="Recorded response body" thinking="Recorded reasoning field" outputFidelity="recorded" thinkingFidelity="recorded" /></I18nProvider>)
  expect(html).toContain('<details class="model-thinking" data-content-source="recorded">')
  expect(html).not.toContain('<details open')
  expect(html).toContain('Recorded reasoning field</p>')
  expect(html).toContain('<p class="model-output-text" aria-label="Model response text">Recorded response body</p>')
  expect(html.indexOf('Recorded reasoning field')).toBeLessThan(html.indexOf('Recorded response body'))
  expect(html).not.toContain('<strong>Recorded response body')
})

test('missing, empty, and example responses do not imply unrecorded Thinking', () => {
  const render = (output?: string | null, thinking?: string | null) => renderToStaticMarkup(<I18nProvider initialLocale="en-US"><ModelResponseContent output={output} thinking={thinking} /></I18nProvider>)
  expect(render(null)).toContain('Model response data is unavailable')
  expect(render('')).toContain('No response text in this round')
  expect(render('')).not.toContain('is unavailable')
  expect(render('Body only')).not.toContain('<details')
  expect(render('Body only', '   ')).not.toContain('<details')
  const example = renderToStaticMarkup(<I18nProvider initialLocale="en-US"><ModelResponseContent output="Example body" outputFidelity="example" /></I18nProvider>)
  expect(example).toContain('Example response')
})
