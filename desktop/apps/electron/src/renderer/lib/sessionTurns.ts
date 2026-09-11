import type { AgentMessage, AgentMessageSubagent, MessageBlock, SessionTurnRecord, WorkflowRunState } from '@shared/types'
import { AgentRole } from '@shared/types'
import { i18n } from './i18n'

type Data = Record<string, unknown>
type WorkflowStep = Extract<MessageBlock, { type: 'workflow_step' }>
export interface SessionTurnChild {
  session_id: string
  title: string
  turn: SessionTurnRecord | null
}
export interface TurnProjectionContext {
  subagents?: Record<string, SessionTurnChild[]>
  showPendingInteraction?: boolean
}

const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown): string => value == null ? '' : String(value)
const terminal = (turn: SessionTurnRecord) => ['completed', 'failed', 'cancelled'].includes(turn.status)
const runKey = (workflowId: string, generation: string) => JSON.stringify([workflowId, generation])

/** Older tool arguments sometimes contain Python literals instead of JSON. No evaluation. */
function storedValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { /* Try the legacy literal encoding below. */ }
  try {
    const normalized = value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:None|True|False)\b/g, (token) => {
      if (token[0] === '"') return token
      if (token[0] !== "'") return { None: 'null', True: 'true', False: 'false' }[token] ?? token
      const content = token.slice(1, -1).replace(/\\(?:x[\da-fA-F]{2}|.|$)/g, (escape) => {
        if (escape === "\\'") return "'"
        if (escape.startsWith('\\x')) return String.fromCharCode(parseInt(escape.slice(2), 16))
        try { return JSON.parse(`"${escape}"`) as string } catch { return escape }
      })
      return JSON.stringify(content)
    })
    return JSON.parse(normalized)
  } catch { return value }
}

function questionText(arguments_: Data): string {
  const value = storedValue(arguments_.questions || arguments_.prompt || '')
  const questions = Array.isArray(value) ? value : array(object(value).questions)
  return questions.length ? questions.map((q) => string(object(q).question)).filter(Boolean).join('\n\n') : string(value)
}

function childBlock(child: SessionTurnChild, goal = ''): AgentMessageSubagent {
  return {
    invocationId: child.session_id,
    goal: child.turn?.user_input.text ?? goal,
    status: child.turn?.status ?? 'running',
    answer: child.turn?.final_answer ?? null,
    ...(child.turn?.error ? { error: child.turn.error } : {}),
  }
}

function permissionItems(permission: Data) {
  return array(permission.items).map((value) => {
    const item = object(value)
    return {
      ...item,
      callIndex: Number(item.call_index ?? 0),
      tool: string(item.tool), arguments: item.arguments ?? {}, capability: string(item.capability),
      boundary: string(item.boundary), label: string(item.label),
      decision: item.decision as 'allow' | 'deny' | undefined,
      instruction: item.instruction == null ? null : string(item.instruction),
    }
  })
}

/** One durable Turn owns one user message and one logical assistant reply, including all interaction resumes. */
export function sessionTurnsToMessages(turns: SessionTurnRecord[], context: TurnProjectionContext = {}): AgentMessage[] {
  return turns.flatMap((turn, index) => {
    const prefix = `${turn.session_id}:${turn.session_ordinal}`
    const user: AgentMessage = {
      id: `${turn.session_id}:u${turn.session_ordinal}`, turnId: turn.id, role: AgentRole.User,
      text: turn.user_input.text, blocks: turn.user_input.blocks.flatMap((block): MessageBlock[] => {
        if (block.type === 'text') return [{ type: 'text', text: string(block.value) }]
        if (block.type === 'mention') return [{
          type: 'mention', id: string(block.id), label: string(block.label), group: string(block.group),
          ...(block.path ? { path: string(block.path) } : {}),
        }]
        if (block.type === 'slash') return [{
          type: 'slash', id: string(block.id), label: string(block.label),
          ...(block.resource === 'workflow' || block.resource === 'schedule' ? { resource: block.resource } : {}),
        }]
        return []
      }), toolCalls: [], done: true, createdAt: turn.session_ordinal * 2,
    }
    const blocks = turnBlocks(turn, { ...context, showPendingInteraction: index === turns.length - 1 && context.showPendingInteraction })
    if (!blocks.length && turn.final_answer) blocks.push({ type: 'text', text: turn.final_answer })
    if (!blocks.length && !turn.error && turn.status !== 'cancelled') return [user]
    const duration = [...(turn.ota_records ?? [])].reverse().find((round) => round.turn_duration_ms != null)?.turn_duration_ms
    const assistant: AgentMessage = {
      id: prefix, turnId: turn.id, role: AgentRole.Assistant, blocks,
      text: blocks.flatMap((block) => block.type === 'text' && block.text ? [block.text] : []).join('\n\n'),
      toolCalls: blocks.flatMap((block) => block.type === 'tool' ? [block] : []),
      done: true, turnStatus: turn.status, finalAnswer: turn.final_answer, createdAt: turn.session_ordinal * 2 + 1,
      completedAt: Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(turn.created_at) ? turn.created_at : `${turn.created_at}Z`),
      durationMs: duration != null && Number.isFinite(Number(duration)) ? Math.max(0, Math.trunc(Number(duration))) : null,
      ...(turn.model ? { model: turn.model } : {}),
      ...(['request', 'auto', 'full'].includes(turn.execution_mode ?? '') ? { executionMode: turn.execution_mode as AgentMessage['executionMode'] } : {}),
      ...(turn.status === 'failed' && turn.error ? { error: turn.error } : {}),
      ...(turn.status === 'cancelled' ? { stopped: true } : {}),
    }
    return [user, assistant]
  })
}

function turnBlocks(turn: SessionTurnRecord, context: TurnProjectionContext): MessageBlock[] {
  const blocks: MessageBlock[] = []
  const spans: { start: number; marker: number }[] = []
  const state = turn.agent_state ?? {}
  const think = object(state.think)
  const interaction = object(state.interaction)
  const showPending = context.showPendingInteraction ?? false
  const openChoice = !terminal(turn) && array(interaction.questions).length > 0
  let buildStage: string | null = null
  let workflowStart: number | null = null
  let fallbackStart = 0
  let toolIndex = 0
  let hasRunScope = false

  const addStep = (step: WorkflowStep) => {
    const existing = blocks.findIndex((block) => block.type === 'workflow_step'
      && block.workflowId === step.workflowId && block.generation === step.generation
      && block.phase === step.phase && block.stepIndex === step.stepIndex)
    if (existing >= 0) {
      if (step.status !== 'running') blocks[existing] = step
      return
    }
    spans.push({ start: workflowStart ?? fallbackStart, marker: blocks.length })
    blocks.push(step)
  }
  const removeQuestion = (question: string) => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]!
      if (block.type !== 'text') continue
      const text = block.text.trimEnd()
      if (text.endsWith(question)) blocks[index] = { type: 'text', text: text.slice(0, -question.length).trimEnd() }
      break
    }
  }
  const addInteraction = (block: MessageBlock & { status?: string }) => {
    if (block.status !== 'pending' || showPending) blocks.push(block)
  }
  const confirmationReply = (payload: Data, question: string) => {
    if (payload.status !== 'not_answered' || !string(payload.user_message).trim()) return false
    blocks.push({ type: 'confirmation', kind: 'confirmation_message', question, response: string(payload.user_message) })
    return true
  }

  for (const round of turn.ota_records ?? []) {
    const scope = object(round.think_scope)
    if (round.think_scope || 'build_stage' in round) {
      let nextBuild = string(round.build_stage) || null
      if (round.think_scope) nextBuild = scope.mode === 'build' ? string(scope.stage) || null : null
      if (nextBuild !== buildStage) blocks.push({ type: 'build_stage', stage: nextBuild })
      buildStage = nextBuild
      // A Main/Build round closes an unfinished Run segment as well.
      if (scope.mode && scope.mode !== 'run_workflow' && hasRunScope) {
        if (nextBuild === null) blocks.push({ type: 'build_stage', stage: null })
        hasRunScope = false
      }
    }
    if (scope.mode === 'run_workflow') {
      hasRunScope = true
      workflowStart ??= blocks.length
    }
    const reasoning = typeof round.reasoning_content === 'string' && round.reasoning_content.trim()
      ? round.reasoning_content
      : array(round.thinking_blocks).map((value) => string(object(value).thinking)).join('')
    if (reasoning.trim()) blocks.push({ type: 'thinking', text: reasoning })
    const content = string(object(round.think_result).step_content).trim()
    if (content) blocks.push({ type: 'text', text: content })
    const permission = object(round.permission)
    if (permission.reviewed && array(permission.items).length) blocks.push({
      type: 'permission', requestId: null, decided: true, items: permissionItems(permission), questions: [],
    })
    let entered = false
    let reported = false
    let reportTerminal = false
    for (const value of array(object(round.action_result).results)) {
      const action = object(value)
      const name = string(action.tool_name)
      const arguments_ = object(action.tool_arguments)
      const payload = object(action.tool_result)
      if (['switch', 'complete_run_workflow'].includes(name)) continue
      if (name === 'report_workflow_step') {
        if (payload.workflow_id) {
          addStep({
            type: 'workflow_step', workflowId: string(payload.workflow_id), generation: string(payload.generation),
            workflowName: string(payload.workflow_name), phase: 'execute', stepIndex: Number(payload.step_index ?? 0),
            stepCount: Number(payload.step_count ?? 0), title: string(payload.title),
            status: payload.status === 'success' ? 'success' : 'failure', summary: string(payload.summary) || null,
            ...(Array.isArray(payload.execution_steps) ? { executionSteps: payload.execution_steps.map(string) } : {}),
          })
          reported = true
          reportTerminal = Boolean(payload.run_id)
        }
        continue
      }
      if (name === 'request_human_choice') {
        const question = questionText(arguments_)
        const response = action.success !== false && typeof action.tool_result === 'string' ? action.tool_result.trim() : ''
        if (response) {
          if (question) removeQuestion(question)
          blocks.push({ type: 'confirmation', question, response,
            ...(arguments_.questions && typeof arguments_.prompt === 'string' && arguments_.prompt.trim() ? { prompt: arguments_.prompt.trim() } : {}),
          })
        } else if (!openChoice && question) blocks.push({ type: 'text', text: question })
        continue
      }
      if (name === 'request_run_workflow' || (name === 'request_build' && action.success !== false && payload.build_conflict === true)) {
        const status = string(payload.status || payload.resolved_action)
        if (name === 'request_run_workflow' && action.success !== false) {
          entered = ['started', 'resumed', 'restarted'].includes(status)
            || (status === 'resolved' && ['resume', 'restart'].includes(string(payload.action)))
            || (!['pending', 'failed', 'not_answered'].includes(status) && ['start', 'resume', 'restart'].includes(string(arguments_.action)))
        }
        const response = string(payload.response || payload.user_message).trim()
        if (['resolved', 'not_answered', 'failed'].includes(status) && response) blocks.push({
          type: 'confirmation', question: string(object(array(payload.questions)[0]).question) || (name === 'request_run_workflow'
            ? i18n.t('session.interaction.card.runTitle')
            : i18n.t('session.interaction.card.buildConflictTitle')),
          response, ...(status === 'not_answered' ? { kind: 'confirmation_message' } : {}),
        })
        continue
      }
      if (name === 'request_build') {
        if (action.success === false || confirmationReply(payload, i18n.t('session.interaction.card.buildTitle'))) continue
        if (payload.mode === 'ask') addInteraction({
          type: 'build_confirm', requestId: string(payload.request_id), goal: string(payload.goal),
          reason: string(payload.reason) || null, status: payload.status as 'pending' | 'confirmed' | 'cancelled',
        })
        continue
      }
      if (name === 'request_human_task_confirm') {
        if (confirmationReply(payload, i18n.t('session.interaction.card.taskTitle'))) continue
        if (string(payload.task_markdown).trim()) addInteraction({
          type: 'task_confirm', requestId: string(payload.request_id) || `${turn.session_id}:${turn.session_ordinal}:task-confirm`,
          taskMarkdown: string(payload.task_markdown).trim(), status: (payload.status || 'pending') as 'pending' | 'confirmed' | 'revision_requested',
          feedback: string(payload.feedback) || null,
          ...(payload.operation ? { operation: payload.operation as 'create' | 'edit' } : {}),
          ...(payload.workflow_id || think.mode === 'build' && think.workflow_id ? { workflowId: string(payload.workflow_id || think.workflow_id) } : {}),
          ...(payload.previous_task_markdown != null ? { previousTaskMarkdown: string(payload.previous_task_markdown) } : {}),
          ...(payload.original_task_markdown != null ? { originalTaskMarkdown: string(payload.original_task_markdown) } : {}),
        })
        continue
      }
      if (name === 'request_human_workflow_confirm') {
        if (confirmationReply(payload, i18n.t('session.interaction.card.workflowTitle'))) continue
        const data = Object.keys(payload).length ? payload : object(storedValue(arguments_.prompt))
        const defaultName = string(data.default_name || data.name).trim()
        if (defaultName) {
          const resultText = string(action.tool_result).toLowerCase()
          let status = data.status || 'pending'
          if (resultText.includes('confirmed')) status = 'confirmed'
          else if (/cancelled|canceled/.test(resultText)) status = 'cancelled'
          addInteraction({
            type: 'workflow_confirm', requestId: string(data.request_id) || `${turn.session_id}:${turn.session_ordinal}:workflow-confirm`,
            defaultName, summary: string(data.summary) || null, status: status as 'pending' | 'confirmed' | 'cancelled',
            ...(data.operation ? { operation: data.operation as 'create' | 'edit' } : {}),
            ...(data.workflow_id || data.workflowId ? { workflowId: string(data.workflow_id || data.workflowId) } : {}),
            ...(data.name ? { name: string(data.name) } : {}),
          })
        }
        continue
      }
      const children = context.subagents?.[string(action.tool_id)] ?? []
      if (['run_subagent', 'start_subagent'].includes(name)) {
        blocks.push(...children.map((child): MessageBlock => ({ type: 'subagent', ...childBlock(child, string(arguments_.goal) || child.title) })))
        continue
      }
      let output = string(action.tool_result)
      if (typeof action.tool_result === 'object' && action.tool_result !== null) output = JSON.stringify(action.tool_result)
      if (action.success === false) output = string(action.error || 'tool failed')
      blocks.push({
        type: 'tool', toolUseId: string(action.tool_id) || `${turn.session_id}:${turn.session_ordinal}:t${toolIndex}`,
        name, input: arguments_, result: {
          output,
          isError: action.success === false, durationMs: Number(round.act_duration_ms ?? 0),
        }, ...(children.length ? { subagents: children.map((child) => childBlock(child, child.title)) } : {}),
      })
      toolIndex += 1
    }
    const result = object(round.workflow_result)
    if (result.run_id) {
      reportTerminal ||= reported
      if (!blocks.some((block) => block.type === 'workflow_result' && block.runId === result.run_id)) blocks.push({
        type: 'workflow_result', runId: string(result.run_id), workflowId: string(result.workflow_id),
        workflowName: string(result.workflow_name), status: result.status === 'completed' ? 'completed' : 'failed',
        createdAt: string(result.created_at), summary: string(result.summary) || null,
        ...(typeof result.result_file_count === 'number' && Number.isInteger(result.result_file_count) && result.result_file_count >= 0 ? { resultFileCount: result.result_file_count } : {}),
      })
    }
    if (reported) {
      fallbackStart = blocks.length
      workflowStart = reportTerminal ? null : blocks.length
    } else if (entered) workflowStart = fallbackStart = blocks.length
  }
  if (showPending && interaction.permission) {
    const permission = object(interaction.permission)
    blocks.push({ type: 'permission', requestId: string(interaction.request_id) || null,
      items: permissionItems(permission), questions: array(permission.questions) as Extract<MessageBlock, { type: 'permission' }>['questions'],
    })
  }
  // Legacy Turns predate per-round scope recording; their cursor still owns the unreported tail.
  if (workflowStart === null && !(turn.ota_records ?? []).some((round) => round.think_scope)) workflowStart = fallbackStart
  // The Turn's own cursor identifies its unfinished section, even after later Turns advance the Run.
  if (think.mode === 'run_workflow' && think.stage === 'execute' && think.workflow_id && workflowStart !== null && workflowStart < blocks.length) {
    addStep({
      type: 'workflow_step', workflowId: string(think.workflow_id), generation: string(think.generation),
      workflowName: '', phase: 'execute', stepIndex: Number(think.step_index ?? 0), stepCount: 0, title: '',
      status: 'running',
    })
  }
  const ordered: MessageBlock[] = []
  let cursor = 0
  for (const { start, marker } of spans) {
    if (start < cursor || marker < start) continue
    ordered.push(...blocks.slice(cursor, start), blocks[marker]!, ...blocks.slice(start, marker))
    cursor = marker + 1
  }
  ordered.push(...blocks.slice(cursor))
  return ordered.filter((block) => block.type !== 'text' || block.text).map((block) =>
    terminal(turn) && block.type === 'workflow_step' && block.status === 'running'
      ? { ...block, status: turn.status === 'failed' ? 'failure' : 'neutral' }
      : block,
  )
}

/** Share labels within a Run generation, never its outcome or its current step position across Turns. */
export function resolveWorkflowStepMetadata(messages: AgentMessage[], run?: WorkflowRunState | null): AgentMessage[] {
  const metadata = new Map<string, { name: string; titles: string[]; count: number }>()
  for (const message of messages) for (const block of message.blocks ?? []) {
    if (block.type !== 'workflow_step') continue
    const key = runKey(block.workflowId, block.generation)
    const previous = metadata.get(key)
    const titles = block.executionSteps?.length ? [...block.executionSteps] : [...(previous?.titles ?? [])]
    if (block.title) titles[block.stepIndex] = block.title
    metadata.set(key, { name: block.workflowName || previous?.name || '', titles, count: Math.max(block.stepCount, previous?.count ?? 0) })
  }
  if (run) {
    const key = runKey(run.workflowId, run.generation)
    const previous = metadata.get(key)
    metadata.set(key, {
      name: run.workflowName || previous?.name || '',
      titles: run.executionSteps.length ? run.executionSteps : previous?.titles ?? [],
      count: Math.max(run.executionSteps.length, previous?.count ?? 0),
    })
  }
  return messages.map((message) => ({ ...message, blocks: message.blocks?.map((block) => {
    if (block.type !== 'workflow_step') return block
    const data = metadata.get(runKey(block.workflowId, block.generation))
    return data ? { ...block, workflowName: block.workflowName || data.name, title: block.title || data.titles[block.stepIndex] || '', stepCount: block.stepCount || data.count } : block
  }) }))
}
