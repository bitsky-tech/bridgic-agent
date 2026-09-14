import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n'
import { getPresentationTrace } from './presentation-trace-data'
import { TraceExecutionTree } from './TraceExecutionTree'

const noop = () => {}

async function visibleMarkup(html: string) {
  return new HTMLRewriter()
    .on('[hidden]', { element: element => { element.remove() } })
    .on('details:not([open]) > :not(summary)', { element: element => { element.remove() } })
    .transform(new Response(html))
    .text()
}

describe('execution trace tree', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    test(`${locale} shows all executed stages in order without selecting a stage or round`, async () => {
      const trace = getPresentationTrace(locale)
      const html = await visibleMarkup(renderToStaticMarkup(<I18nProvider initialLocale={locale}>
        <TraceExecutionTree rounds={trace.rounds} focusRequest={null} onFocusHandled={noop} onPanelChange={noop} onArtifact={noop} onInspectRound={noop} />
      </I18nProvider>))

      let previousPosition = -1
      for (const round of trace.rounds.filter(round => round.stage !== 'main')) {
        expect(html).toContain(round.title)
        expect(html).not.toContain(round.summary)
        expect(html).not.toContain(round.decision)
        for (const call of round.calls) expect(html).toContain(call.name)
        const position = html.indexOf(`aria-label="${locale === 'zh-CN' ? '循环' : 'Round'} ${round.id}"`)
        expect(position).toBeGreaterThan(previousPosition)
        previousPosition = position
      }
      expect(html).not.toContain(trace.rounds[0]!.summary)
      expect(html).not.toContain(locale === 'zh-CN' ? '暂无模型正文数据' : 'Model response data is unavailable')
      expect(html).toContain(trace.rounds[1]!.output!)
      expect(html).toContain('Thinking')
      expect(html).not.toContain(trace.rounds[1]!.thinking!)
      const stages = [...html.matchAll(/data-stage-id="([^"]+)"/g)].map(match => match[1])
      expect(stages).toEqual(['ppt_brief', 'ppt_plan', 'ppt_compose', 'ppt_review'])
      expect(html).toContain(locale === 'zh-CN' ? '尚未执行' : 'Not started')
    })
  }

  test('offers each call and round as a sidebar entry without embedding payloads or module tabs', () => {
    const trace = getPresentationTrace('en-US')
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en-US">
      <TraceExecutionTree rounds={trace.rounds} focusRequest={null} onFocusHandled={noop} onPanelChange={noop} onArtifact={noop} onInspectRound={noop} onOpenTool={noop} onOpenRound={noop} />
    </I18nProvider>)
    const calls = [...html.matchAll(/data-round-id="([^"]+)" data-call-id="([^"]+)"/g)].map(match => [match[1], match[2]])
    expect(calls).toEqual(trace.rounds.flatMap(round => round.calls.map(call => [round.id, call.id])))
    expect(html.match(/aria-label="Inspect round /g)?.length).toBe(trace.rounds.length)
    expect(html).not.toContain('<pre>')
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('disabled=""')
  })
})
