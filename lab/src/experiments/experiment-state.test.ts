import { describe, expect, test } from 'bun:test'
import {
  createExperimentPreviewState, createExperimentState, experimentReducer, PRESENTATION_DEMO_SESSION_ID,
  type ExperimentAction, type ExperimentState,
} from './experiment-state'
import type { ScenarioId } from './demo-data'

const firstMode: ScenarioId = 'presentation'

function reduce(...actions: ExperimentAction[]): ExperimentState {
  return actions.reduce(experimentReducer, createExperimentState())
}

function mode(state: ExperimentState, id: ScenarioId = firstMode) {
  const found = state.modes.find(item => item.id === id)
  if (!found) throw new Error(`Missing test mode ${id}`)
  return found
}

const start = (modeId: ScenarioId = firstMode, id = 'session-1', createdAt = 1000): ExperimentAction[] => [
  { type: 'set-draft', modeId, input: `  Input for ${modeId}/${id}  ` },
  { type: 'start-session', modeId, id, createdAt },
]

describe('presentation trace preview', () => {
  test('starts at the awaiting outline with an isolated session and leaves other modes empty', () => {
    const state = createExperimentPreviewState()
    expect(state.activeModeId).toBe('presentation')
    expect(mode(state)).toMatchObject({ activeSessionId: PRESENTATION_DEMO_SESSION_ID, selectedStageId: 'ppt_plan', draft: '' })
    expect(mode(state).sessions).toEqual([{
      id: PRESENTATION_DEMO_SESSION_ID,
      input: '帮我做一个讲解佛教的 PPT',
      createdAt: Date.parse('2026-09-08T19:00:00+08:00'),
      status: 'awaiting',
      completedStages: 1,
      draft: '',
      turns: [{
        id: `${PRESENTATION_DEMO_SESSION_ID}:turn-1`,
        input: '帮我做一个讲解佛教的 PPT',
        startedAt: Date.parse('2026-09-08T19:00:00+08:00'),
        status: 'awaiting',
        startStageIndex: 0,
        completedStages: 1,
        continuation: 'initial',
      }],
      source: 'presentation-trace-demo',
    }])
    expect(mode(state, 'build').sessions).toEqual([])
    expect(mode(state, 'workflow').sessions).toEqual([])
    expect(mode(createExperimentState()).sessions).toEqual([])
    expect(mode(createExperimentPreviewState()).sessions[0]).not.toBe(mode(state).sessions[0])
  })

  test('a new test runs independently while the awaiting preview remains available in history', () => {
    const initial = createExperimentPreviewState()
    const originalSession = mode(initial).sessions[0]
    const actions: ExperimentAction[] = [
      { type: 'new-session', modeId: firstMode },
      ...start(firstMode, 'new-test'),
      { type: 'select-session', modeId: firstMode, sessionId: PRESENTATION_DEMO_SESSION_ID },
    ]
    const state = actions.reduce(experimentReducer, initial)
    expect(mode(state).activeSessionId).toBe(PRESENTATION_DEMO_SESSION_ID)
    expect(mode(state).sessions[0]).toBe(originalSession)
    expect(mode(state).sessions[1]).toMatchObject({ id: 'new-test', status: 'running', input: 'Input for presentation/new-test' })
    expect(mode(state, 'build')).toBe(mode(initial, 'build'))
  })

  test('ticks and stop do not complete or cancel an awaiting preview', () => {
    const state = createExperimentPreviewState()
    expect(experimentReducer(state, { type: 'tick', now: Date.parse('2026-09-10T19:00:00+08:00') })).toBe(state)
    expect(experimentReducer(state, { type: 'stop-session', modeId: firstMode, sessionId: PRESENTATION_DEMO_SESSION_ID })).toBe(state)
    const running = start(firstMode, 'new-test').reduce(experimentReducer, state)
    const ticked = experimentReducer(running, { type: 'tick', now: 13000 })
    expect(mode(ticked).sessions[0]).toBe(mode(state).sessions[0])
    expect(mode(ticked).sessions[1]).toMatchObject({ status: 'completed', completedStages: 4 })
  })
})

describe('experiment sessions', () => {
  test('starts with three fixed modes and no implicit test run', () => {
    const state = createExperimentState()
    expect(state).toEqual({ modes: (['presentation', 'build', 'workflow'] as const).map(id => ({ id, draft: '', sessions: [], activeSessionId: null, selectedStageId: null, panel: 'cognitive' })), activeModeId: firstMode })
    const other = createExperimentState()
    expect(other.modes).not.toBe(state.modes)
    expect(other.modes[0]!.sessions).not.toBe(state.modes[0]!.sessions)
  })

  test('different modes retain separate input, selections, and sessions even with equal session ids', () => {
    const state = reduce(
      ...start(),
      { type: 'select-stage', modeId: firstMode, stageId: 'ppt_plan' },
      { type: 'select-panel', modeId: firstMode, panel: 'tools' },
      { type: 'set-draft', modeId: firstMode, input: 'Unsubmitted first draft' },
      { type: 'select-mode', modeId: 'build' },
      ...start('build'),
      { type: 'select-panel', modeId: 'build', panel: 'prompt' },
    )
    expect(mode(state).sessions[0]!.input).toBe('Input for presentation/session-1')
    expect(mode(state, 'build').sessions[0]!.input).toBe('Input for build/session-1')
    expect(mode(state)).toMatchObject({ draft: 'Unsubmitted first draft', panel: 'tools', selectedStageId: 'ppt_plan' })
    expect(mode(state, 'build')).toMatchObject({ draft: '', panel: 'prompt', selectedStageId: null })
    const selected = experimentReducer(state, { type: 'select-mode', modeId: firstMode })
    expect(selected.activeModeId).toBe(firstMode)
    expect(selected.modes).toBe(state.modes)
  })

  test('repeated mode switching reuses each workspace without duplicating or replacing sessions', () => {
    const state = reduce(...start(), { type: 'set-draft', modeId: firstMode, input: 'Next test draft' })
    let switched = state
    for (let index = 0; index < 3; index++) {
      switched = experimentReducer(switched, { type: 'select-mode', modeId: 'build' })
      switched = experimentReducer(switched, { type: 'select-mode', modeId: firstMode })
    }
    expect(switched.modes.map(item => item.id)).toEqual(['presentation', 'build', 'workflow'])
    expect(switched.modes).toBe(state.modes)
    expect(mode(switched)).toMatchObject({ draft: 'Next test draft', activeSessionId: 'session-1' })
    expect(mode(switched).sessions).toHaveLength(1)
    expect(experimentReducer(switched, { type: 'select-mode', modeId: firstMode })).toBe(switched)
  })

  test('starting trims and captures input, clears the draft, and rejects blank or overlapping runs', () => {
    const blank = reduce({ type: 'set-draft', modeId: firstMode, input: ' \n ' })
    expect(experimentReducer(blank, { type: 'start-session', modeId: firstMode, id: 'blank', createdAt: 0 })).toBe(blank)
    const state = reduce(...start(), { type: 'set-draft', modeId: firstMode, input: 'Keep this next draft' })
    expect(mode(state).sessions[0]).toMatchObject({ input: 'Input for presentation/session-1', status: 'running', completedStages: 0 })
    expect(experimentReducer(state, { type: 'start-session', modeId: firstMode, id: 'overlap', createdAt: 2000 })).toBe(state)
    expect(mode(state).draft).toBe('Keep this next draft')
  })

  test('new-session preserves the unsubmitted draft and lets the previous run continue in the background', () => {
    const state = reduce(...start(),
      { type: 'select-stage', modeId: firstMode, stageId: 'ppt_plan' },
      { type: 'set-draft', modeId: firstMode, input: 'Next test' },
      { type: 'new-session', modeId: firstMode },
    )
    expect(mode(state)).toMatchObject({ activeSessionId: null, selectedStageId: null, draft: 'Next test' })
    expect(mode(experimentReducer(state, { type: 'tick', now: 4000 })).sessions[0]!.completedStages).toBe(1)
    expect(experimentReducer(state, { type: 'start-session', modeId: firstMode, id: 'still-running', createdAt: 2000 })).toBe(state)
  })

  test('completed sessions remain inspectable without overwriting a newer draft or another session', () => {
    const state = reduce(...start(),
      { type: 'tick', now: 13000 },
      ...start(firstMode, 'session-2', 14000),
      { type: 'select-stage', modeId: firstMode, stageId: 'ppt_review' },
      { type: 'set-draft', modeId: firstMode, input: 'Third draft' },
      { type: 'select-session', modeId: firstMode, sessionId: 'session-1' },
    )
    expect(mode(state)).toMatchObject({ activeSessionId: 'session-1', selectedStageId: null, draft: 'Third draft' })
    expect(mode(state).sessions.map(session => [session.id, session.status])).toEqual([['session-1', 'completed'], ['session-2', 'running']])
    expect(mode(state).sessions[0]!.input).toBe('Input for presentation/session-1')
    expect(mode(state).sessions[1]!.input).toBe('Input for presentation/session-2')
    const repeatedId = experimentReducer(experimentReducer(state, { type: 'stop-session', modeId: firstMode, sessionId: 'session-2' }), { type: 'start-session', modeId: firstMode, id: 'session-1', createdAt: 15000 })
    expect(mode(repeatedId).sessions).toHaveLength(2)
    expect(mode(repeatedId).draft).toBe('Third draft')
  })

  test('wrong mode or session ids cannot select or stop another mode’s work', () => {
    const state = reduce(...start(),
      { type: 'select-mode', modeId: 'build' },
      ...start('build', 'build-session'),
    )
    for (const action of [
      { type: 'stop-session', modeId: firstMode, sessionId: 'build-session' },
      { type: 'select-session', modeId: firstMode, sessionId: 'build-session' },
      { type: 'stop-session', modeId: 'missing' as ScenarioId, sessionId: 'session-1' },
      { type: 'set-draft', modeId: 'missing' as ScenarioId, input: 'do not create a mode' },
      { type: 'select-mode', modeId: 'missing' as ScenarioId },
    ] satisfies ExperimentAction[]) expect(experimentReducer(state, action)).toBe(state)
    const stopped = experimentReducer(state, { type: 'stop-session', modeId: firstMode, sessionId: 'session-1' })
    expect(mode(stopped, 'build')).toBe(mode(state, 'build'))
    expect(mode(stopped).sessions[0]!.status).toBe('cancelled')
  })

  test('stage selection belongs to its mode’s scenario and does not leak across sessions', () => {
    const state = reduce(...start(), { type: 'select-stage', modeId: firstMode, stageId: 'ppt_plan' })
    expect(experimentReducer(state, { type: 'select-stage', modeId: firstMode, stageId: 'generate' })).toBe(state)
    expect(experimentReducer(state, { type: 'select-session', modeId: firstMode, sessionId: 'session-1' })).toBe(state)
    const newSession = experimentReducer(state, { type: 'new-session', modeId: firstMode })
    expect(mode(newSession).selectedStageId).toBeNull()
  })
})

describe('simulation timing and termination', () => {
  test('advances exactly at three-second boundaries without accumulating duplicate or backward ticks', () => {
    const state = reduce(...start())
    expect(experimentReducer(state, { type: 'tick', now: 3999 })).toBe(state)
    const one = experimentReducer(state, { type: 'tick', now: 4000 })
    expect(mode(one).sessions[0]!.completedStages).toBe(1)
    expect(experimentReducer(one, { type: 'tick', now: 4000 })).toBe(one)
    expect(experimentReducer(one, { type: 'tick', now: 1000 })).toBe(one)
    expect(mode(experimentReducer(one, { type: 'tick', now: 10000 })).sessions[0]!.completedStages).toBe(3)
  })

  test('catch-up ticks progress background modes using their own start times and stage counts', () => {
    const state = reduce(...start(),
      { type: 'select-mode', modeId: 'workflow' },
      ...start('workflow', 'workflow-session', 4000),
      { type: 'select-mode', modeId: 'build' },
      ...start('build', 'build-session', 12000),
      { type: 'tick', now: 13000 },
    )
    expect(state.activeModeId).toBe('build')
    expect(mode(state).sessions[0]).toMatchObject({ status: 'completed', completedStages: 4 })
    expect(mode(state, 'workflow').sessions[0]).toMatchObject({ status: 'completed', completedStages: 3 })
    expect(mode(state, 'build').sessions[0]).toMatchObject({ status: 'running', completedStages: 0 })
    const completed = experimentReducer(state, { type: 'tick', now: 999999 })
    expect(mode(completed, 'build').sessions[0]).toMatchObject({ status: 'completed', completedStages: 4 })
    expect(experimentReducer(completed, { type: 'tick', now: 1000000 })).toBe(completed)
  })

  test('stop preserves completed work and pending ticks never revive or complete a cancelled session', () => {
    const state = reduce(...start(),
      { type: 'tick', now: 7000 },
      { type: 'stop-session', modeId: firstMode, sessionId: 'session-1' },
    )
    expect(mode(state).sessions[0]).toMatchObject({ status: 'cancelled', completedStages: 2 })
    expect(experimentReducer(state, { type: 'tick', now: 50000 })).toBe(state)
    expect(experimentReducer(state, { type: 'stop-session', modeId: firstMode, sessionId: 'session-1' })).toBe(state)
    const restarted = start(firstMode, 'session-2', 50000).reduce(experimentReducer, state)
    const ticked = experimentReducer(restarted, { type: 'tick', now: 53000 })
    expect(mode(ticked).sessions.map(session => [session.status, session.completedStages])).toEqual([['cancelled', 2], ['running', 1]])
  })

  test('stopping after completion does not relabel a successfully completed run', () => {
    const state = reduce(...start(), { type: 'tick', now: 13000 })
    expect(experimentReducer(state, { type: 'stop-session', modeId: firstMode, sessionId: 'session-1' })).toBe(state)
  })

  test('an explicit stop catches up throttled timers and retains a run that has already finished', () => {
    const state = reduce(...start())
    const stopped = experimentReducer(state, { type: 'stop-session', modeId: firstMode, sessionId: 'session-1', stoppedAt: 7500 })
    expect(mode(stopped).sessions[0]!.turns[0]).toMatchObject({ status: 'cancelled', completedStages: 2, endedAt: 7500 })
    const completed = experimentReducer(state, { type: 'stop-session', modeId: firstMode, sessionId: 'session-1', stoppedAt: 15000 })
    expect(mode(completed).sessions[0]!.turns[0]).toMatchObject({ status: 'completed', completedStages: 4, endedAt: 13000 })
  })

  test('invalid timestamps cannot create a permanently running session or corrupt progress', () => {
    const draft = reduce({ type: 'set-draft', modeId: firstMode, input: 'Input' })
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(experimentReducer(draft, { type: 'start-session', modeId: firstMode, id: 'bad-time', createdAt: value })).toBe(draft)
      const running = reduce(...start())
      expect(experimentReducer(running, { type: 'tick', now: value })).toBe(running)
    }
  })

  test('tick and stop preserve older state snapshots and untouched mode identities', () => {
    const state = reduce(...start())
    Object.freeze(mode(state).sessions[0])
    Object.freeze(mode(state).sessions)
    Object.freeze(mode(state))
    Object.freeze(state.modes)
    Object.freeze(state)
    const ticked = experimentReducer(state, { type: 'tick', now: 4000 })
    const stopped = experimentReducer(state, { type: 'stop-session', modeId: firstMode, sessionId: 'session-1' })
    expect(mode(state).sessions[0]).toMatchObject({ status: 'running', completedStages: 0 })
    expect(mode(ticked).sessions[0]!.completedStages).toBe(1)
    expect(mode(stopped).sessions[0]!.status).toBe('cancelled')
    expect(mode(ticked, 'workflow')).toBe(mode(state, 'workflow'))
    expect(mode(stopped, 'workflow')).toBe(mode(state, 'workflow'))
  })
})

describe('same-session message continuation', () => {
  const sessionId = 'session-1'
  const draft = (input = '  Make it suitable for children  '): ExperimentAction => ({ type: 'set-session-draft', modeId: firstMode, sessionId, input })
  const append = (createdAt = 50000, continuation: 'continue' | 'reassess' = 'continue'): Extract<ExperimentAction, { type: 'append-message' }> => ({ type: 'append-message', modeId: firstMode, sessionId, turnId: 'turn-2', createdAt, continuation })
  const stopped = () => reduce(...start(), { type: 'tick', now: 7000 }, { type: 'stop-session', modeId: firstMode, sessionId, stoppedAt: 7500 })

  test('captures a new message in the same session, retaining the original task and cancelled run', () => {
    const initial = stopped()
    const firstTurn = mode(initial).sessions[0]!.turns[0]!
    const state = [draft(), append()].reduce(experimentReducer, initial)
    const session = mode(state).sessions[0]!
    expect(mode(state).sessions).toHaveLength(1)
    expect(session).toMatchObject({ id: sessionId, input: 'Input for presentation/session-1', createdAt: 1000, status: 'running', completedStages: 2, draft: '' })
    expect(session.turns[0]).toBe(firstTurn)
    expect(firstTurn).toMatchObject({ status: 'cancelled', endedAt: 7500, completedStages: 2, continuation: 'initial' })
    expect(session.turns[1]).toEqual({ id: 'turn-2', input: 'Make it suitable for children', startedAt: 50000, status: 'running', startStageIndex: 2, completedStages: 2, continuation: 'continue' })
    expect(mode(state, 'build')).toBe(mode(initial, 'build'))
  })

  test('time spent stopped never advances a new run and completion is tied to its own start time', () => {
    const state = [draft(), append()].reduce(experimentReducer, stopped())
    expect(experimentReducer(state, { type: 'tick', now: 52999 })).toBe(state)
    const one = experimentReducer(state, { type: 'tick', now: 53000 })
    expect(mode(one).sessions[0]!.turns[1]).toMatchObject({ status: 'running', completedStages: 3 })
    expect(experimentReducer(one, { type: 'tick', now: 51000 })).toBe(one)
    const complete = experimentReducer(one, { type: 'tick', now: 100000 })
    expect(mode(complete).sessions[0]).toMatchObject({ status: 'completed', completedStages: 4 })
    expect(mode(complete).sessions[0]!.turns[1]).toMatchObject({ status: 'completed', completedStages: 4, endedAt: 56000 })
    expect(mode(complete).sessions[0]!.turns[0]).toBe(mode(state).sessions[0]!.turns[0])
  })

  test('reassessment starts at the first stage without relabeling previous completed work', () => {
    const initial = stopped()
    const state = [draft(), append(50000, 'reassess')].reduce(experimentReducer, initial)
    expect(mode(state).sessions[0]).toMatchObject({ status: 'running', completedStages: 0 })
    expect(mode(state).sessions[0]!.turns[1]).toMatchObject({ startStageIndex: 0, completedStages: 0, continuation: 'reassess' })
    expect(mode(state).sessions[0]!.turns[0]).toBe(mode(initial).sessions[0]!.turns[0])
    expect(mode(experimentReducer(state, { type: 'tick', now: 53000 })).sessions[0]!.completedStages).toBe(1)
  })

  test('continuing a completed session reruns its final stage rather than immediately completing', () => {
    const initial = reduce(...start(), { type: 'tick', now: 13000 })
    const state = [draft(), append()].reduce(experimentReducer, initial)
    expect(mode(state).sessions[0]!.turns[1]).toMatchObject({ status: 'running', startStageIndex: 3, completedStages: 3 })
    expect(experimentReducer(state, { type: 'tick', now: 50000 })).toBe(state)
    expect(mode(experimentReducer(state, { type: 'tick', now: 53000 })).sessions[0]!.turns[1]).toMatchObject({ status: 'completed', endedAt: 53000 })
  })

  test('separate session drafts survive session and mode switches without changing a running input', () => {
    const state = reduce(...start(), draft('First session draft'), { type: 'stop-session', modeId: firstMode, sessionId },
      ...start(firstMode, 'session-2', 10000),
      { type: 'set-session-draft', modeId: firstMode, sessionId: 'session-2', input: 'Second draft' },
      { type: 'set-draft', modeId: firstMode, input: 'New session draft' },
      ...start('build', sessionId),
      { type: 'set-session-draft', modeId: 'build', sessionId, input: 'Build draft' },
      { type: 'select-session', modeId: firstMode, sessionId },
      { type: 'select-mode', modeId: firstMode },
    )
    expect(mode(state).sessions.map(session => session.draft)).toEqual(['First session draft', 'Second draft'])
    expect(mode(state).draft).toBe('New session draft')
    expect(mode(state, 'build').sessions[0]!.draft).toBe('Build draft')
    expect(mode(state).sessions[0]!.turns[0]!.input).toBe('Input for presentation/session-1')
    expect(experimentReducer(state, draft('First session draft'))).toBe(state)
  })

  test('blank input, old timestamps, duplicate turns, unknown sessions, and overlapping runs leave drafts intact', () => {
    const initial = experimentReducer(stopped(), draft())
    for (const action of [
      append(7499), append(NaN), append(Infinity), append(-1),
      { ...append(), turnId: `${sessionId}:turn-1` },
      { ...append(), turnId: '' },
      { ...append(), sessionId: 'unknown' },
      { ...append(), modeId: 'build' },
      { type: 'set-session-draft', modeId: firstMode, sessionId: 'unknown', input: 'Missing' },
    ] as ExperimentAction[]) expect(experimentReducer(initial, action)).toBe(initial)
    const blank = experimentReducer(initial, draft(' \n '))
    expect(experimentReducer(blank, append())).toBe(blank)
    const running = experimentReducer(initial, append())
    const pending = experimentReducer(running, draft('Next message'))
    expect(experimentReducer(pending, { ...append(), turnId: 'turn-3' })).toBe(pending)
    const background = start(firstMode, 'session-2', 10000).reduce(experimentReducer, initial)
    expect(experimentReducer(background, append())).toBe(background)
    expect(mode(background).sessions[0]!.draft).toBe('  Make it suitable for children  ')
  })

  test('stale stop timestamps cannot cancel a new run after a continuation has started', () => {
    const initial = [draft(), append()].reduce(experimentReducer, stopped())
    for (const stoppedAt of [7500, 49999, NaN, Infinity]) {
      expect(experimentReducer(initial, { type: 'stop-session', modeId: firstMode, sessionId, stoppedAt })).toBe(initial)
    }
    const cancelled = experimentReducer(initial, { type: 'stop-session', modeId: firstMode, sessionId, stoppedAt: 52000 })
    expect(mode(cancelled).sessions[0]!.turns[1]).toMatchObject({ status: 'cancelled', endedAt: 52000, completedStages: 2 })
    expect(experimentReducer(cancelled, { type: 'tick', now: 100000 })).toBe(cancelled)
  })

  test('adding and advancing turns preserves frozen history and inactive session identities', () => {
    const state = experimentReducer(stopped(), draft())
    const previous = mode(state).sessions[0]!
    Object.freeze(previous.turns[0])
    Object.freeze(previous.turns)
    Object.freeze(previous)
    const continued = experimentReducer(state, append())
    const ticked = experimentReducer(continued, { type: 'tick', now: 53000 })
    const cancelled = experimentReducer(ticked, { type: 'stop-session', modeId: firstMode, sessionId, stoppedAt: 54000 })
    expect(previous.turns).toHaveLength(1)
    expect(previous.draft).toBe('  Make it suitable for children  ')
    expect(mode(cancelled).sessions[0]!.turns[0]).toBe(previous.turns[0])
    expect(mode(continued).sessions[0]!.turns[1]).toMatchObject({ status: 'running', completedStages: 2 })
    expect(mode(ticked).sessions[0]!.turns[1]).toMatchObject({ status: 'running', completedStages: 3 })
    expect(mode(cancelled).sessions[0]!.turns[1]).toMatchObject({ status: 'cancelled', completedStages: 3 })
  })

  test('continuing the fixed PPT preview retains the fixture identity and its awaiting first turn', () => {
    const initial = createExperimentPreviewState()
    const firstTurn = mode(initial).sessions[0]!.turns[0]!
    const actions: ExperimentAction[] = [
      { type: 'set-session-draft', modeId: firstMode, sessionId: PRESENTATION_DEMO_SESSION_ID, input: 'Revise the audience' },
      { type: 'append-message', modeId: firstMode, sessionId: PRESENTATION_DEMO_SESSION_ID, turnId: 'preview-turn-2', createdAt: firstTurn.startedAt + 100000, continuation: 'reassess' },
    ]
    const state = actions.reduce(experimentReducer, initial)
    expect(mode(state).sessions).toHaveLength(1)
    expect(mode(state).sessions[0]).toMatchObject({ id: PRESENTATION_DEMO_SESSION_ID, source: 'presentation-trace-demo', status: 'running', completedStages: 0 })
    expect(mode(state).sessions[0]!.turns[0]).toBe(firstTurn)
    expect(firstTurn.status).toBe('awaiting')
    expect(mode(initial).sessions[0]!.turns).toHaveLength(1)
  })
})
