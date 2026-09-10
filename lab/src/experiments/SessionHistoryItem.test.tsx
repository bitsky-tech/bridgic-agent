import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n'
import { createExperimentPreviewState, experimentReducer } from './experiment-state'
import { SessionHistoryItem } from './SessionHistoryItem'

test('session navigation identifies the selected test without duplicating stage navigation', async () => {
  let state = experimentReducer(createExperimentPreviewState(), { type: 'set-draft', modeId: 'presentation', input: 'A new task' })
  state = experimentReducer(state, { type: 'start-session', modeId: 'presentation', id: 'new', createdAt: 0 })
  const mode = state.modes[0]!
  const html = renderToStaticMarkup(<I18nProvider initialLocale="en-US">
    {mode.sessions.map(session => <SessionHistoryItem key={session.id} session={session} active={session.id === mode.activeSessionId} onSelect={() => {}} />)}
  </I18nProvider>)
  const buttons: { title: string | null; current: string | null }[] = []
  await new HTMLRewriter().on('button', { element: element => {
    buttons.push({ title: element.getAttribute('title'), current: element.getAttribute('aria-current') })
  } }).transform(new Response(html)).text()
  expect(buttons).toEqual([
    { title: '帮我做一个讲解佛教的 PPT', current: null },
    { title: 'A new task', current: 'true' },
  ])
  expect(html).toContain('Awaiting input')
  expect(html).toContain('Simulating')
  expect(html).not.toMatch(/Cognitive|aria-expanded|aria-controls|ppt_plan/)
})
