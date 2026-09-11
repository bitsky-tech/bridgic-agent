import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n'
import { RoundMetricsBar } from './RoundMetricsBar'

const render = (metrics?: Parameters<typeof RoundMetricsBar>[0]['metrics']) => renderToStaticMarkup(<I18nProvider initialLocale="en-US"><RoundMetricsBar metrics={metrics} /></I18nProvider>)

test('keeps absent metrics distinct from recorded zero values', () => {
  const missing = render()
  expect((missing.match(/<dd>—<\/dd>/g) ?? []).length).toBe(4)
  expect(missing).not.toContain('0%')
  const zero = render({ durationMs: 0, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, source: 'recorded' })
  expect(zero).toContain('<dd>0 ms</dd>')
  expect(zero).toContain('<dd>0</dd>')
  expect(zero).toContain('<dd>0%</dd>')
  expect(zero).not.toContain('Demo')
})

test('shows example provenance and derives cache hits from input tokens', () => {
  const html = render({ durationMs: 3200, inputTokens: 8000, outputTokens: 512, cacheReadTokens: 6000, source: 'example' })
  expect(html).toContain('<dd>3.2 s</dd>')
  expect(html).toContain('<dd>8,000</dd>')
  expect(html).toContain('<dd>512</dd>')
  expect(html).toContain('<dd>75%</dd>')
  expect(html).toContain('Cache-read 6,000 / input 8,000 tokens')
  expect(html).toContain('not actual execution telemetry')
  expect(html).toContain('data-source="example"')
})
