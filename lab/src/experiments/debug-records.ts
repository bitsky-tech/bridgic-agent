import { getDebugStage, type DebugStage } from './debug-data'
import { debugCallId, debugRoundId, type DebugPromptMessage, type DebugRecords, type DebugRound, type DebugToolCall, type DebugToolDefinition } from './debug-record-types'
import type { DemoScenario } from './demo-data'
import type { ExperimentSession, ExperimentTurn } from './experiment-state'
import type { PresentationTrace, PresentationTraceRound } from './presentation-trace-data'

type Locale = 'zh-CN' | 'en-US'
type Text = (zh: string, en: string) => string

function callSummary(arguments_: Record<string, unknown>, fallback: string): string {
  for (const key of ['query', 'url', 'file_path', 'path', 'goal', 'prompt', 'summary', 'command', 'reason', 'stage']) {
    const value = arguments_[key]
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim()
  }
  return fallback
}

function exampleDefinitions(stage: DebugStage | undefined, callNames: string[], t: Text): DebugToolDefinition[] {
  const definitions = new Map<string, DebugToolDefinition>()
  for (const tool of stage?.tools ?? []) {
    if (tool.availability !== 'available') continue
    definitions.set(tool.name, { name: tool.name, description: tool.description, schema: structuredClone(tool.schema) })
  }
  for (const name of callNames) {
    if (!definitions.has(name)) definitions.set(name, {
      name,
      description: t('此示例包含调用记录，未提供工具定义。', 'This example contains a call but does not provide its tool definition.'),
      schema: null,
    })
  }
  return [...definitions.values()]
}

/** Local message history is illustrative request assembly, not a captured model request. */
function turnMessages(session: ExperimentSession, turnIndex: number, scenario: DemoScenario, t: Text): DebugPromptMessage[] {
  const messages: DebugPromptMessage[] = []
  session.turns.slice(0, turnIndex + 1).forEach((turn, index) => {
    messages.push({
      id: `${turn.id}:input`, label: t(`第 ${index + 1} 轮用户消息`, `Turn ${index + 1} user message`),
      role: 'user', content: turn.input, fidelity: 'illustrative',
    })
    if (index === turnIndex) return
    const stage = scenario.stages[Math.min(turn.completedStages, scenario.stages.length - 1)]
    const content = turn.status === 'cancelled'
      ? t(`第 ${index + 1} 轮已由用户停止，停止位置：${stage?.title ?? '未知阶段'}。未完成的阶段没有完成回执。`, `Turn ${index + 1} was stopped by the user at ${stage?.title ?? 'an unknown stage'}. Unfinished stages have no completion receipt.`)
      : turn.status === 'awaiting'
        ? t(`第 ${index + 1} 轮停留在${stage?.title ?? '当前阶段'}，等待用户输入；不能据此推断用户已确认。`, `Turn ${index + 1} is awaiting user input at ${stage?.title ?? 'the current stage'}; this does not imply user approval.`)
        : turn.status === 'completed'
          ? t(`第 ${index + 1} 轮模拟执行完成。`, `Turn ${index + 1} completed its simulated execution.`)
          : t(`第 ${index + 1} 轮正在模拟执行。`, `Turn ${index + 1} is running in the simulation.`)
    messages.push({
      id: `${turn.id}:execution-state`, label: t(`第 ${index + 1} 轮执行状态 · 示意`, `Turn ${index + 1} execution state · illustrative`),
      role: 'system', content, fidelity: 'illustrative',
    })
  })
  return messages
}

function fixtureRound(round: PresentationTraceRound, turn: ExperimentTurn, scenario: DemoScenario, locale: Locale, t: Text): DebugRound {
  const stage = scenario.stages.find(item => item.id === round.stage)
  const example = stage ? getDebugStage(scenario.id, stage.id, locale) : undefined
  const id = debugRoundId(turn.id, round.id)
  const stageLabel = stage?.title ?? t('流程入口', 'Workflow entry')
  const calls: DebugToolCall[] = round.calls.map(call => ({
    id: debugCallId(turn.id, round.id, call.id), sourceCallId: call.id,
    roundId: id, sourceRoundId: round.id, turnId: turn.id, turnOrdinal: 1,
    roundLabel: round.id, stageId: round.stage, stageLabel,
    name: call.name, summary: callSummary(call.arguments, round.summary), status: call.status,
    arguments: structuredClone(call.arguments), result: structuredClone(call.result), error: call.error ?? null,
    durationMs: null, startedAt: null, source: 'fixture',
  }))
  const awaiting = calls.some(call => {
    const result = call.result
    return result !== null && typeof result === 'object' && 'status' in result
      && typeof result.status === 'string' && result.status.startsWith('awaiting_')
  })
  return {
    id, sourceRoundId: round.id, turnId: turn.id, turnOrdinal: 1, label: round.id,
    stageId: round.stage, stageLabel, title: round.title, summary: round.summary,
    status: awaiting ? 'waiting' : calls.some(call => call.status === 'error') ? 'error' : 'success', source: 'fixture',
    promptMessages: round.promptBlocks.map(block => ({ ...block })),
    toolDefinitions: exampleDefinitions(example, calls.map(call => call.name), t),
    model: null, modelOptions: null, output: round.output ?? null, thinking: round.thinking ?? null,
    ...(round.output != null && round.outputFidelity ? { outputFidelity: round.outputFidelity } : {}),
    ...(round.thinking != null && round.thinkingFidelity ? { thinkingFidelity: round.thinkingFidelity } : {}),
    ...(round.inspectionSource ? { inspectionSource: round.inspectionSource } : {}),
    decision: round.decision, evidence: [...round.evidence], beforeState: null, afterState: null,
    durationMs: null, calls,
    ...(round.metrics ? { metrics: { ...round.metrics } } : {}),
  }
}

function simulatedRounds(session: ExperimentSession, turn: ExperimentTurn, turnIndex: number, scenario: DemoScenario, locale: Locale, t: Text): DebugRound[] {
  const messages = turnMessages(session, turnIndex, scenario, t)
  return scenario.stages.flatMap((stage, stageIndex): DebugRound[] => {
    const completed = stageIndex < turn.completedStages
    const current = stageIndex === turn.completedStages && turn.status !== 'completed'
    if (stageIndex < turn.startStageIndex || (!completed && !current)) return []
    const example = getDebugStage(scenario.id, stage.id, locale)
    const id = debugRoundId(turn.id, stage.id)
    const label = `R${String(stageIndex + 1).padStart(2, '0')}`
    const calls: DebugToolCall[] = completed ? [{
      id: debugCallId(turn.id, stage.id, 'example-call'), sourceCallId: 'example-call',
      roundId: id, sourceRoundId: stage.id, turnId: turn.id, turnOrdinal: turnIndex + 1,
      roundLabel: label, stageId: stage.id, stageLabel: stage.title,
      name: example.call.tool, summary: callSummary(example.call.arguments, example.purpose), status: 'example',
      arguments: structuredClone(example.call.arguments), result: structuredClone(example.call.result), error: null,
      durationMs: null, startedAt: null, source: 'simulation',
    }] : []
    const persona = example.blocks.find(block => block.id === 'persona')
    const status = completed ? 'example' : turn.status === 'awaiting' ? 'waiting' : turn.status === 'cancelled' ? 'cancelled' : 'running'
    const decision = completed
      ? example.decision
      : turn.status === 'cancelled'
        ? t('用户已在此阶段停止模拟执行，没有完成回执。', 'The user stopped the simulation at this stage; no completion receipt is available.')
        : turn.status === 'awaiting'
          ? t('此阶段等待用户输入，尚无后续执行结果。', 'This stage is awaiting user input; no subsequent execution result is available.')
          : t('此阶段正在模拟执行，尚无完成回执。', 'This stage is being simulated; no completion receipt is available.')
    return [{
      id, sourceRoundId: stage.id, turnId: turn.id, turnOrdinal: turnIndex + 1, label,
      stageId: stage.id, stageLabel: stage.title, title: stage.title, summary: stage.description,
      status, source: 'simulation',
      promptMessages: [
        ...(persona ? [{ id: `${id}:persona`, label: persona.label, role: persona.role, content: persona.content, fidelity: 'illustrative' as const }] : []),
        ...messages.map(message => ({ ...message })),
      ],
      toolDefinitions: exampleDefinitions(example, calls.map(call => call.name), t),
      model: null, modelOptions: null, output: null, thinking: null, inspectionSource: 'example',
      decision, evidence: [], beforeState: null, afterState: null, durationMs: null, calls,
    }]
  })
}

/** Normalize session-scoped fixtures and simulation snapshots without fabricating runtime telemetry. */
export function buildDebugRecords(session: ExperimentSession | undefined, scenario: DemoScenario, trace: PresentationTrace | null, locale: Locale): DebugRecords {
  if (!session) return { rounds: [], calls: [] }
  const t: Text = (zh, en) => locale === 'zh-CN' ? zh : en
  const rounds = session.turns.flatMap((turn, turnIndex) => (
    turnIndex === 0 && session.source === 'presentation-trace-demo' && trace
      ? trace.rounds.map(round => fixtureRound(round, turn, scenario, locale, t))
      : simulatedRounds(session, turn, turnIndex, scenario, locale, t)
  ))
  return { rounds, calls: rounds.flatMap(round => round.calls) }
}
