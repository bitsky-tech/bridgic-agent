import { getDemoScenarios, type ScenarioId } from './demo-data'

export type InspectorPanel = 'cognitive' | 'prompt' | 'tools'

export const PRESENTATION_DEMO_SESSION_ID = 'presentation-trace-demo'

export interface ExperimentTurn {
  id: string
  input: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'cancelled' | 'awaiting'
  startStageIndex: number
  completedStages: number
  continuation: 'initial' | 'reassess' | 'continue'
}

export interface ExperimentSession {
  id: string
  input: string
  createdAt: number
  status: 'running' | 'completed' | 'cancelled' | 'awaiting'
  completedStages: number
  draft: string
  turns: ExperimentTurn[]
  source?: 'presentation-trace-demo'
}

export interface ExperimentModeState {
  id: ScenarioId
  draft: string
  sessions: ExperimentSession[]
  activeSessionId: string | null
  selectedStageId: string | null
  panel: InspectorPanel
}

export interface ExperimentState {
  modes: ExperimentModeState[]
  activeModeId: ScenarioId
}

export type ExperimentAction =
  | { type: 'select-mode'; modeId: ScenarioId }
  | { type: 'set-draft'; modeId: ScenarioId; input: string }
  | { type: 'set-session-draft'; modeId: ScenarioId; sessionId: string; input: string }
  | { type: 'new-session'; modeId: ScenarioId }
  | { type: 'start-session'; modeId: ScenarioId; id: string; createdAt: number }
  | { type: 'select-session'; modeId: ScenarioId; sessionId: string }
  | { type: 'stop-session'; modeId: ScenarioId; sessionId: string; stoppedAt?: number }
  | { type: 'append-message'; modeId: ScenarioId; sessionId: string; turnId: string; createdAt: number; continuation: 'reassess' | 'continue' }
  | { type: 'select-stage'; modeId: ScenarioId; stageId: string }
  | { type: 'select-panel'; modeId: ScenarioId; panel: InspectorPanel }
  | { type: 'tick'; now: number }

const stagesByScenario = new Map(getDemoScenarios('en-US').map(scenario => [
  scenario.id, scenario.stages.map(stage => stage.id),
]))

function createMode(id: ScenarioId): ExperimentModeState {
  return { id, draft: '', sessions: [], activeSessionId: null, selectedStageId: null, panel: 'cognitive' }
}

export function createExperimentState(): ExperimentState {
  return { modes: [...stagesByScenario.keys()].map(createMode), activeModeId: 'presentation' }
}

export function createExperimentPreviewState(): ExperimentState {
  return updateMode(createExperimentState(), 'presentation', mode => ({
    ...mode,
    sessions: [{
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
    }],
    activeSessionId: PRESENTATION_DEMO_SESSION_ID,
    selectedStageId: 'ppt_plan',
  }))
}

function updateMode(state: ExperimentState, modeId: ScenarioId, update: (mode: ExperimentModeState) => ExperimentModeState): ExperimentState {
  const index = state.modes.findIndex(mode => mode.id === modeId)
  const previous = state.modes[index]
  if (!previous) return state
  const mode = update(previous)
  if (mode === previous) return state
  const modes = state.modes.slice()
  modes[index] = mode
  return { ...state, modes }
}

function updateSession(mode: ExperimentModeState, sessionId: string, update: (session: ExperimentSession) => ExperimentSession): ExperimentModeState {
  const index = mode.sessions.findIndex(session => session.id === sessionId)
  const previous = mode.sessions[index]
  if (!previous) return mode
  const session = update(previous)
  if (session === previous) return mode
  const sessions = mode.sessions.slice()
  sessions[index] = session
  return { ...mode, sessions }
}

function replaceCurrentTurn(session: ExperimentSession, turn: ExperimentTurn): ExperimentSession {
  const turns = session.turns.slice()
  turns[turns.length - 1] = turn
  return { ...session, turns, status: turn.status, completedStages: turn.completedStages }
}

/** Advance only the current run; time between user messages does not count as execution. */
function tickMode(mode: ExperimentModeState, now: number): ExperimentModeState {
  const stageCount = stagesByScenario.get(mode.id)!.length
  let changed = false
  const sessions = mode.sessions.map(session => {
    if (session.status !== 'running') return session
    const turn = session.turns[session.turns.length - 1]!
    const elapsedStages = Math.floor((now - turn.startedAt) / 3000)
    const completedStages = Math.min(stageCount, Math.max(turn.completedStages, turn.startStageIndex + elapsedStages))
    if (completedStages === session.completedStages) return session
    changed = true
    return replaceCurrentTurn(session, {
      ...turn,
      completedStages,
      status: completedStages === stageCount ? 'completed' : 'running',
      ...(completedStages === stageCount ? { endedAt: turn.startedAt + (stageCount - turn.startStageIndex) * 3000 } : {}),
    })
  })
  return changed ? { ...mode, sessions } : mode
}

export function experimentReducer(state: ExperimentState, action: ExperimentAction): ExperimentState {
  switch (action.type) {
    case 'select-mode':
      return state.activeModeId === action.modeId || !state.modes.some(mode => mode.id === action.modeId)
        ? state
        : { ...state, activeModeId: action.modeId }
    case 'set-draft':
      return updateMode(state, action.modeId, mode => mode.draft === action.input ? mode : { ...mode, draft: action.input })
    case 'set-session-draft':
      return updateMode(state, action.modeId, mode => updateSession(mode, action.sessionId, session => session.draft === action.input
        ? session
        : { ...session, draft: action.input }))
    case 'new-session':
      return updateMode(state, action.modeId, mode => mode.activeSessionId === null && mode.selectedStageId === null
        ? mode
        : { ...mode, activeSessionId: null, selectedStageId: null })
    case 'start-session':
      return updateMode(state, action.modeId, mode => {
        const input = mode.draft.trim()
        const turnId = `${action.id}:turn-1`
        if (!input || !action.id.trim() || !Number.isFinite(action.createdAt) || action.createdAt < 0
          || mode.sessions.some(session => session.status === 'running' || session.id === action.id || session.turns.some(turn => turn.id === turnId))) return mode
        const turn: ExperimentTurn = { id: turnId, input, startedAt: action.createdAt, status: 'running', startStageIndex: 0, completedStages: 0, continuation: 'initial' }
        const session: ExperimentSession = { id: action.id, input, createdAt: action.createdAt, status: 'running', completedStages: 0, draft: '', turns: [turn] }
        return { ...mode, draft: '', sessions: [...mode.sessions, session], activeSessionId: session.id, selectedStageId: null }
      })
    case 'append-message':
      return updateMode(state, action.modeId, mode => {
        if (!action.turnId.trim() || !Number.isFinite(action.createdAt) || action.createdAt < 0
          || mode.sessions.some(session => session.status === 'running' || session.turns.some(turn => turn.id === action.turnId))) return mode
        const updated = updateSession(mode, action.sessionId, session => {
          const input = session.draft.trim()
          const previous = session.turns[session.turns.length - 1]!
          const lastExecutionAt = previous.endedAt ?? previous.startedAt + (previous.completedStages - previous.startStageIndex) * 3000
          if (!input || action.createdAt < lastExecutionAt) return session
          const stageCount = stagesByScenario.get(mode.id)!.length
          const startStageIndex = action.continuation === 'reassess' ? 0 : Math.min(session.completedStages, stageCount - 1)
          const turn: ExperimentTurn = {
            id: action.turnId, input, startedAt: action.createdAt, status: 'running',
            startStageIndex, completedStages: startStageIndex, continuation: action.continuation,
          }
          return { ...session, draft: '', turns: [...session.turns, turn], status: turn.status, completedStages: turn.completedStages }
        })
        return updated === mode ? mode : { ...updated, activeSessionId: action.sessionId, selectedStageId: null }
      })
    case 'select-session':
      return updateMode(state, action.modeId, mode => mode.activeSessionId === action.sessionId || !mode.sessions.some(session => session.id === action.sessionId)
        ? mode
        : { ...mode, activeSessionId: action.sessionId, selectedStageId: null })
    case 'stop-session':
      return updateMode(state, action.modeId, mode => updateSession(mode, action.sessionId, session => {
        if (session.status !== 'running') return session
        const turn = session.turns[session.turns.length - 1]!
        const lastExecutionAt = turn.startedAt + (turn.completedStages - turn.startStageIndex) * 3000
        const endedAt = action.stoppedAt ?? lastExecutionAt
        if (!Number.isFinite(endedAt) || endedAt < lastExecutionAt) return session
        const stageCount = stagesByScenario.get(mode.id)!.length
        const completedStages = Math.min(stageCount, turn.startStageIndex + Math.floor((endedAt - turn.startedAt) / 3000))
        return replaceCurrentTurn(session, {
          ...turn,
          completedStages,
          status: completedStages === stageCount ? 'completed' : 'cancelled',
          endedAt: completedStages === stageCount ? turn.startedAt + (stageCount - turn.startStageIndex) * 3000 : endedAt,
        })
      }))
    case 'select-stage':
      return updateMode(state, action.modeId, mode => mode.selectedStageId === action.stageId || !stagesByScenario.get(mode.id)!.includes(action.stageId)
        ? mode
        : { ...mode, selectedStageId: action.stageId })
    case 'select-panel':
      return updateMode(state, action.modeId, mode => mode.panel === action.panel ? mode : { ...mode, panel: action.panel })
    case 'tick': {
      if (!Number.isFinite(action.now)) return state
      const modes = state.modes.map(mode => tickMode(mode, action.now))
      return modes.some((mode, index) => mode !== state.modes[index]) ? { ...state, modes } : state
    }
  }
}
