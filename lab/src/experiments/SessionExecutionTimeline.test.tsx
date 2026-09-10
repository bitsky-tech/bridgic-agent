import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n'
import { getDemoScenarios } from './demo-data'
import type { ExperimentSession, ExperimentTurn } from './experiment-state'
import type { DebugRound } from './debug-record-types'
import { executionStageStatus, getTurnPromptHistory, resolveStageTurn, SessionExecutionTimeline } from './SessionExecutionTimeline'

const scenario = getDemoScenarios('en-US')[0]!
const first: ExperimentTurn = { id: 'turn-1', input: 'Original task', startedAt: 100, endedAt: 1500, status: 'cancelled', startStageIndex: 0, completedStages: 1, continuation: 'initial' }
const second: ExperimentTurn = { id: 'turn-2', input: 'Change the audience to children.', startedAt: 80000, endedAt: 85000, status: 'cancelled', startStageIndex: 0, completedStages: 0, continuation: 'reassess' }
const third: ExperimentTurn = { id: 'turn-3', input: 'This later message must not enter earlier context.', startedAt: 90000, status: 'running', startStageIndex: 0, completedStages: 0, continuation: 'continue' }
const session: ExperimentSession = { id: 'session-1', input: first.input, draft: '', createdAt: 100, status: 'running', completedStages: 0, turns: [first, second, third] }
const noop = () => {}

function debugRound(turnId: string, stageId: string, id: string): DebugRound {
  return {
    id, sourceRoundId: id, turnId, turnOrdinal: 1, label: id, stageId, stageLabel: stageId,
    title: id, summary: `${id} execution summary`, status: 'example', source: 'simulation',
    promptMessages: [], toolDefinitions: [], model: null, modelOptions: null, output: null,
    decision: `${id} stage decision`, evidence: [], beforeState: null, afterState: null, durationMs: null,
    calls: [{
      id: `${id}-call`, sourceCallId: 'call-1', roundId: id, sourceRoundId: id, turnId, turnOrdinal: 1,
      roundLabel: id, stageId, stageLabel: stageId, name: 'example_tool', summary: `${id} tool summary`,
      status: 'example', arguments: { input: 'Detailed payload belongs in the sidebar' }, result: null,
      error: null, durationMs: null, startedAt: null, source: 'simulation',
    }],
  }
}

describe('session execution timeline', () => {
  test('request snapshots include prior user messages and stop states, but never later messages', () => {
    expect(getTurnPromptHistory(session, first.id, scenario, 'en-US')).toEqual([{ role: 'user', content: first.input, source: 'user_message', turnId: first.id }])
    const history = getTurnPromptHistory(session, second.id, scenario, 'en-US')
    expect(history.map(message => message.role)).toEqual(['user', 'system', 'user'])
    expect(history[0]!.content).toBe(first.input)
    expect(history[1]!.content).toContain('stopped by the user at Plan the slides')
    expect(history[2]!.content).toBe(second.input)
    expect(JSON.stringify(history)).not.toContain(third.input)
    expect(getTurnPromptHistory(session, 'missing', scenario, 'en-US')).toEqual([])
  })

  test('each continuation preserves stopped, inherited, reached and upcoming stage distinctions', () => {
    expect(scenario.stages.map((_, index) => executionStageStatus(first, index))).toEqual(['completed', 'cancelled', 'pending', 'pending'])
    const continued = { ...third, startStageIndex: 1, completedStages: 2 }
    expect(scenario.stages.map((_, index) => executionStageStatus(continued, index))).toEqual(['inherited', 'completed', 'running', 'pending'])
    const completed = { ...continued, status: 'completed' as const, completedStages: 4 }
    expect(scenario.stages.map((_, index) => executionStageStatus(completed, index))).toEqual(['inherited', 'completed', 'completed', 'completed'])
  })

  test('stage navigation stays within the specified turn and defaults to the latest one', () => {
    expect(resolveStageTurn(session, scenario, { stageId: 'ppt_plan' })?.id).toBe(third.id)
    expect(resolveStageTurn(session, scenario, { stageId: 'ppt_plan', turnId: first.id })?.id).toBe(first.id)
    expect(resolveStageTurn(session, scenario, { stageId: 'ppt_plan', turnId: 'missing' })).toBeUndefined()
    expect(resolveStageTurn(session, scenario, { stageId: 'unknown' })).toBeUndefined()
  })

  test('full session shows messages in order, stopped boundaries and all stages without duplicate ids', () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en-US"><SessionExecutionTimeline session={session} scenario={scenario} focusRequest={null} onFocusHandled={noop} onStageChange={noop} /></I18nProvider>)
    expect(html.indexOf(first.input)).toBeLessThan(html.indexOf(second.input))
    expect(html.indexOf(second.input)).toBeLessThan(html.indexOf(third.input))
    expect(html).toContain('Stopped · Plan the slides')
    expect(html).toContain('Stopped · Define the brief')
    for (const stage of scenario.stages) expect(html.match(new RegExp(`data-stage-id="${stage.id}"`, 'g'))?.length).toBe(3)
    const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const control of html.matchAll(/aria-controls="([^"]+)"/g)) expect(ids).toContain(control[1])
  })

  test('each user message is followed by a separately labelled Agent response containing its own execution', () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en-US"><SessionExecutionTimeline session={session} scenario={scenario} focusRequest={null} onFocusHandled={noop} onStageChange={noop} /></I18nProvider>)
    expect(Array.from(html.matchAll(/data-message-role="([^"]+)"/g), match => match[1])).toEqual(['user', 'agent', 'user', 'agent', 'user', 'agent'])
    const turns = html.split(/<li class="session-turn" data-turn-id="[^"]+">/).slice(1)
    expect(turns).toHaveLength(3)
    turns.forEach((turn, index) => {
      expect(turn).toContain(`aria-label="Turn ${index + 1} · User message"`)
      expect(turn).toContain(`aria-label="Turn ${index + 1} · Bridgic Agent"`)
      expect(turn).toContain('<h2>Bridgic Agent</h2>')
      expect(turn.indexOf(session.turns[index]!.input)).toBeLessThan(turn.indexOf('data-message-role="agent"'))
      expect(turn.indexOf('data-message-role="agent"')).toBeLessThan(turn.indexOf('class="session-stage-tree"'))
    })
    expect(html).toContain('Select a tool or round')
    expect(html).not.toContain('Select a sidebar stage')
  })

  test('fixture preserves its original trace once and followups render their own stages', () => {
    const fixtureSession: ExperimentSession = { ...session, source: 'presentation-trace-demo', turns: [{ ...first, status: 'awaiting' }, second] }
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en-US"><SessionExecutionTimeline session={fixtureSession} scenario={scenario} focusRequest={null} onFocusHandled={noop} onStageChange={noop} initialTrace={<section>Original R01–R10 snapshot</section>} /></I18nProvider>)
    expect(html.match(/Original R01–R10 snapshot/g)?.length).toBe(1)
    expect(html).toContain('This snapshot preserves its waiting state')
    expect(html).toContain(second.input)
    for (const stage of scenario.stages) expect(html.match(new RegExp(`data-stage-id="${stage.id}"`, 'g'))?.length).toBe(1)
    const history = getTurnPromptHistory(fixtureSession, second.id, scenario, 'en-US')
    expect(history[1]!.content).toContain('this does not imply user approval')
  })

  test('compact debug links belong to the correct turn and omit unreached stages', () => {
    const rounds = [
      debugRound(first.id, 'ppt_brief', 'earlier-brief'),
      debugRound(second.id, 'ppt_brief', 'later-brief'),
      debugRound(second.id, 'ppt_compose', 'unreached-compose'),
      debugRound('other-session-turn', 'ppt_brief', 'unrelated-brief'),
    ]
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en-US">
      <SessionExecutionTimeline session={session} scenario={scenario} focusRequest={null} onFocusHandled={noop} onStageChange={noop} debugRecords={{ rounds, calls: rounds.flatMap(round => round.calls) }} onOpenTool={noop} onOpenRound={noop} />
    </I18nProvider>)
    const turns = html.split(/<li class="session-turn" data-turn-id="[^"]+">/).slice(1)
    expect(turns[0]).toContain('earlier-brief execution summary')
    expect(turns[0]).toContain('data-debug-call-id="earlier-brief-call"')
    expect(turns[0]).not.toContain('later-brief')
    expect(turns[1]).toContain('later-brief execution summary')
    expect(turns[1]).toContain('data-debug-call-id="later-brief-call"')
    expect(turns[1]).not.toContain('earlier-brief')
    expect(turns[1]).toContain('this stage has no completion receipt')
    expect(html).not.toContain('unreached-compose')
    expect(html).not.toContain('unrelated-brief')
    expect(html).not.toContain('Detailed payload belongs in the sidebar')
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('<pre>')
    expect(html.match(/aria-label="Inspect round /g)?.length).toBe(2)
    expect(html).toContain('Example')
  })
})
