import { describe, expect, test } from 'bun:test'
import { buildDebugRecords } from './debug-records'
import { debugCallId, debugRoundId } from './debug-record-types'
import { getDemoScenarios } from './demo-data'
import { createExperimentPreviewState, type ExperimentSession, type ExperimentTurn } from './experiment-state'
import { getPresentationTrace } from './presentation-trace-data'
import { roundCacheHitPercent } from './round-metrics'

const locale = 'en-US'
const scenario = getDemoScenarios(locale)[0]!
const trace = getPresentationTrace(locale)
const first: ExperimentTurn = { id: 'turn:1', input: 'Original task', startedAt: 100, endedAt: 4000, status: 'cancelled', startStageIndex: 0, completedStages: 1, continuation: 'initial' }
const second: ExperimentTurn = { id: 'turn:2', input: 'Change the audience to children.', startedAt: 8000, endedAt: 14000, status: 'cancelled', startStageIndex: 1, completedStages: 2, continuation: 'continue' }
const third: ExperimentTurn = { id: 'turn:3', input: 'This future message must not leak into prior requests.', startedAt: 16000, status: 'running', startStageIndex: 0, completedStages: 0, continuation: 'reassess' }
const session: ExperimentSession = { id: 'session-1', input: first.input, createdAt: 100, status: 'running', completedStages: 0, draft: 'An unsent draft must never appear in requests.', turns: [first, second, third] }

describe('debug record normalization', () => {
  test('missing session produces empty lists', () => {
    expect(buildDebugRecords(undefined, scenario, trace, locale)).toEqual({ rounds: [], calls: [] })
  })

  test('the first fixture snapshot is included once while followups use their own stages', () => {
    const fixture = createExperimentPreviewState().modes[0]!.sessions[0]!
    const records = buildDebugRecords({ ...fixture, turns: [...fixture.turns, second, third] }, scenario, trace, locale)
    expect(records.rounds.filter(round => round.source === 'fixture')).toHaveLength(10)
    expect(records.calls.filter(call => call.source === 'fixture')).toHaveLength(17)
    expect(records.rounds.filter(round => round.source === 'simulation').map(round => round.sourceRoundId)).toEqual(['ppt_plan', 'ppt_compose', 'ppt_brief'])
    expect(records.rounds.find(round => round.sourceRoundId === 'R10')?.status).toBe('waiting')
    for (const roundId of ['R06', 'R07', 'R08']) expect(records.rounds.find(round => round.sourceRoundId === roundId)?.status).toBe('error')
    for (const roundId of ['R01', 'R02', 'R03', 'R04', 'R05', 'R09']) expect(records.rounds.find(round => round.sourceRoundId === roundId)?.status).toBe('success')
    expect(records.rounds.find(round => round.sourceRoundId === 'R06')?.calls.every(call => call.status === 'error')).toBe(true)
    expect(records.rounds.find(round => round.sourceRoundId === 'R01')?.output).toBe(trace.rounds[0]!.output)
  })

  test('a waiting confirmation takes precedence over other failed calls in the round', () => {
    const fixture = createExperimentPreviewState().modes[0]!.sessions[0]!
    const mixedTrace = getPresentationTrace(locale)
    mixedTrace.rounds.at(-1)!.calls.unshift(structuredClone(mixedTrace.rounds[5]!.calls[0]!))
    const waiting = buildDebugRecords(fixture, scenario, mixedTrace, locale).rounds.at(-1)!
    expect(waiting.status).toBe('waiting')
    expect(waiting.calls.some(call => call.status === 'error')).toBe(true)
  })

  test('same-stage calls in separate turns have different stable identities', () => {
    const repeated: ExperimentSession = { ...session, turns: [first, { ...first, id: second.id, input: second.input, continuation: 'reassess' }] }
    const records = buildDebugRecords(repeated, scenario, null, locale)
    expect(records.rounds[0]!.id).toBe(debugRoundId(first.id, 'ppt_brief'))
    expect(records.calls[0]!.id).toBe(debugCallId(first.id, 'ppt_brief', 'example-call'))
    expect(records.calls[1]!.id).toBe(debugCallId(second.id, 'ppt_brief', 'example-call'))
    expect(new Set(records.rounds.map(round => round.id)).size).toBe(records.rounds.length)
    expect(new Set(records.calls.map(call => call.id)).size).toBe(records.calls.length)
    expect(debugRoundId('a:b', 'c')).not.toBe(debugRoundId('a', 'b:c'))
    expect(records.calls.map(call => call.turnOrdinal)).toEqual([1, 2])
    expect(buildDebugRecords(repeated, scenario, null, locale)).toEqual(records)
  })

  test('pending and inherited stages are excluded and unfinished stages have no fabricated call or output', () => {
    const records = buildDebugRecords(session, scenario, null, locale)
    expect(records.rounds.map(round => [round.turnOrdinal, round.sourceRoundId, round.status])).toEqual([
      [1, 'ppt_brief', 'example'], [1, 'ppt_plan', 'cancelled'],
      [2, 'ppt_plan', 'example'], [2, 'ppt_compose', 'cancelled'],
      [3, 'ppt_brief', 'running'],
    ])
    expect(records.calls).toHaveLength(2)
    expect(records.calls.every(call => call.status === 'example')).toBe(true)
    for (const round of records.rounds.filter(round => round.status !== 'example')) {
      expect(round.calls).toEqual([])
      expect(round.output).toBeNull()
    }
    const waiting = buildDebugRecords({ ...session, turns: [{ ...first, status: 'awaiting' }] }, scenario, null, locale)
    expect(waiting.rounds.at(-1)?.status).toBe('waiting')
    const completed = buildDebugRecords({ ...session, turns: [{ ...second, status: 'completed', completedStages: 4 }] }, scenario, null, locale)
    expect(completed.rounds.map(round => round.sourceRoundId)).toEqual(['ppt_plan', 'ppt_compose', 'ppt_review'])
  })

  test('request previews contain bounded user messages and stop state without future, draft, or canned conversation leakage', () => {
    const records = buildDebugRecords(session, scenario, null, locale)
    const firstRequest = records.rounds.find(round => round.turnId === first.id)!.promptMessages
    expect(firstRequest.filter(message => message.role === 'user').map(message => message.content)).toEqual([first.input])
    const secondRequest = records.rounds.find(round => round.turnId === second.id)!.promptMessages
    expect(secondRequest.filter(message => message.role === 'user').map(message => message.content)).toEqual([first.input, second.input])
    expect(secondRequest.some(message => message.content.includes('stopped by the user at Plan the slides'))).toBe(true)
    expect(JSON.stringify(secondRequest)).not.toContain(third.input)
    expect(JSON.stringify(records)).not.toContain(session.draft)
    expect(JSON.stringify(secondRequest)).not.toContain('Su Shi')
    expect(secondRequest.every(message => message.fidelity === 'illustrative')).toBe(true)
    const fixture = createExperimentPreviewState().modes[0]!.sessions[0]!
    const followup = buildDebugRecords({ ...fixture, turns: [...fixture.turns, third] }, scenario, trace, locale).rounds.at(-1)!
    expect(followup.promptMessages.some(message => message.content.includes('this does not imply user approval'))).toBe(true)
  })

  test('missing telemetry stays unavailable and tool definitions do not guess unknown schemas', () => {
    const fixture = createExperimentPreviewState().modes[0]!.sessions[0]!
    const records = buildDebugRecords({ ...fixture, turns: [...fixture.turns, first] }, scenario, trace, locale)
    for (const round of records.rounds) {
      expect(round.durationMs).toBeNull()
      expect(round.model).toBeNull()
      expect(round.modelOptions).toBeNull()
      expect(round.beforeState).toBeNull()
      expect(round.afterState).toBeNull()
      for (const call of round.calls) {
        expect(call.durationMs).toBeNull()
        expect(call.startedAt).toBeNull()
      }
    }
    expect(records.rounds.find(round => round.sourceRoundId === 'R01')!.toolDefinitions.find(tool => tool.name === 'request_presentation')!.schema).toBeNull()
    expect(records.rounds.find(round => round.sourceRoundId === 'R07')!.toolDefinitions.find(tool => tool.name === 'web_fetch')!.schema).toBeNull()
    expect(records.rounds.find(round => round.sourceRoundId === 'R03')!.toolDefinitions.some(tool => tool.name === 'write_file' && tool.schema?.type === 'object')).toBe(true)
    expect(records.rounds.find(round => round.sourceRoundId === 'R03')!.toolDefinitions.some(tool => tool.name === 'report_presentation_step')).toBe(false)
  })

  test('normalization does not share mutable payloads with the source fixture', () => {
    const fixture = createExperimentPreviewState().modes[0]!.sessions[0]!
    const original = getPresentationTrace(locale)
    const before = structuredClone(original)
    const records = buildDebugRecords(fixture, scenario, original, locale)
    records.calls[0]!.arguments.goal = 'changed locally'
    ;(records.calls[0]!.result as Record<string, unknown>).next_stage = 'changed locally'
    records.rounds[0]!.promptMessages[0]!.content = 'changed locally'
    records.rounds[0]!.evidence.push('changed locally')
    records.rounds[0]!.metrics!.inputTokens = 1
    expect(original).toEqual(before)
  })

  test('only the fixed preview has explicit example metrics and normalization preserves their provenance', () => {
    const fixture = createExperimentPreviewState().modes[0]!.sessions[0]!
    const records = buildDebugRecords({ ...fixture, turns: [...fixture.turns, first] }, scenario, trace, locale)
    expect(trace.rounds).toHaveLength(10)
    trace.rounds.forEach((round, index) => {
      expect(round.metrics?.source).toBe('example')
      expect(round.metrics?.inputTokens).toBeGreaterThan(0)
      expect(round.metrics?.outputTokens).toBeGreaterThan(0)
      expect(round.metrics?.durationMs).toBeGreaterThan(0)
      const cachePercent = roundCacheHitPercent(round.metrics)
      expect(cachePercent).not.toBeNull()
      expect(cachePercent!).toBeGreaterThanOrEqual(0)
      expect(cachePercent!).toBeLessThanOrEqual(100)
      expect(records.rounds[index]!.metrics).toEqual(round.metrics)
      expect(records.rounds[index]!.metrics).not.toBe(round.metrics)
      expect(records.rounds[index]!.durationMs).toBeNull()
    })
    expect(records.rounds.filter(round => round.source === 'simulation').every(round => round.metrics === undefined)).toBe(true)
    expect(buildDebugRecords(session, scenario, null, locale).rounds.every(round => round.metrics === undefined)).toBe(true)
    expect(getPresentationTrace('zh-CN').rounds.map(round => round.metrics)).toEqual(trace.rounds.map(round => round.metrics))
  })

  test('recorded responses stay with their fixture while timer examples never use inspection text as output', () => {
    const fixture = createExperimentPreviewState().modes[0]!.sessions[0]!
    const records = buildDebugRecords({ ...fixture, turns: [...fixture.turns, { ...first, status: 'completed', completedStages: 4 }] }, scenario, trace, locale)
    expect(records.rounds.filter(round => round.source === 'simulation')).toHaveLength(4)
    for (const round of trace.rounds) {
      expect(round.outputFidelity).toBe('recorded')
      expect(round.output).not.toBe(round.summary)
      expect(round.thinking).not.toBe(round.decision)
      expect(round.inspectionSource).toBe('example')
    }
    for (const round of records.rounds.filter(round => round.source === 'simulation')) {
      expect(round.title.length).toBeGreaterThan(0)
      expect(round.summary.length).toBeGreaterThan(0)
      expect(round.decision.length).toBeGreaterThan(0)
      expect(round.output).toBeNull()
      expect(round.thinking).toBeNull()
      expect(round.outputFidelity).toBeUndefined()
      expect(round.thinkingFidelity).toBeUndefined()
      expect(round.inspectionSource).toBe('example')
    }
  })

  test('explicit model content, fidelity, and empty strings are preserved independently', () => {
    const fixture = createExperimentPreviewState().modes[0]!.sessions[0]!
    const withContent = getPresentationTrace(locale)
    withContent.rounds[0] = {
      ...withContent.rounds[0]!, output: 'Recorded assistant body', outputFidelity: 'recorded',
      thinking: 'Recorded reasoning text', thinkingFidelity: 'recorded',
    }
    withContent.rounds[1] = {
      ...withContent.rounds[1]!, output: '', outputFidelity: 'recorded',
      thinking: '', thinkingFidelity: 'recorded',
    }
    withContent.rounds[2] = {
      ...withContent.rounds[2]!, output: undefined, outputFidelity: 'example',
      thinking: null, thinkingFidelity: 'example',
    }
    const [recorded, empty, missing] = buildDebugRecords(fixture, scenario, withContent, locale).rounds
    expect(recorded!.output).toBe('Recorded assistant body')
    expect(recorded!.thinking).toBe('Recorded reasoning text')
    expect(recorded!.outputFidelity).toBe('recorded')
    expect(recorded!.thinkingFidelity).toBe('recorded')
    expect(empty!.output).toBe('')
    expect(empty!.thinking).toBe('')
    expect(empty!.outputFidelity).toBe('recorded')
    expect(empty!.thinkingFidelity).toBe('recorded')
    expect(missing!.output).toBeNull()
    expect(missing!.thinking).toBeNull()
    expect(missing!.outputFidelity).toBeUndefined()
    expect(missing!.thinkingFidelity).toBeUndefined()
  })
})
