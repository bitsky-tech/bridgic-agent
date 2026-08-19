import { LabApiInvalidResponseError } from './errors'
import type {
  JsonObject,
  JsonValue,
  OtaActionResult,
  OtaPermission,
  OtaRound,
  OtaThinkResult,
  OtaToolCall,
  OtaToolResult,
  Page,
  PromptComponent,
  PromptComponentKind,
  PromptComponentFidelity,
  PromptMessage,
  PromptReconstruction,
  PromptReconstructionList,
  PromptRole,
  PromptToolSummary,
  SessionKind,
  SessionMount,
  SessionStatus,
  SessionSummary,
  SourceHealth,
  SourceStatus,
  SubagentMode,
  TurnDetail,
  TurnStatus,
  TurnSummary,
} from './types'

type RecordValue = Record<string, unknown>

function invalid(path: string, reason: string): never {
  throw new LabApiInvalidResponseError(path, reason)
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(path, 'expected an object')
  }
  return value as RecordValue
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'expected an array')
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(path, 'expected a string')
  return value
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null
  return string(value, path)
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(path, 'expected a finite number')
  }
  return value
}

function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null
  return number(value, path)
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'expected a boolean')
  return value
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  const candidate = string(value, path)
  if (!choices.includes(candidate as T)) {
    invalid(path, `expected one of ${choices.join(', ')}`)
  }
  return candidate as T
}

function optionalRecord(value: unknown, path: string): RecordValue | null {
  return value === null ? null : record(value, path)
}

function jsonObject(value: unknown, path: string): JsonObject {
  return record(value, path) as JsonObject
}

function jsonValue(value: unknown): JsonValue {
  return value as JsonValue
}

function snakeOrCamel(value: RecordValue, camel: string, snake: string): unknown {
  return value[camel] ?? value[snake]
}

const sourceStatuses = ['connected', 'missing', 'error'] as const satisfies readonly SourceStatus[]
export function parseSourceHealth(value: unknown, path = '$'): SourceHealth {
  const item = record(value, path)
  const counts = item.counts === null ? null : record(item.counts, `${path}.counts`)
  const error = item.error == null ? null : record(item.error, `${path}.error`)
  return {
    status: oneOf(item.status, sourceStatuses, `${path}.status`),
    readonly: boolean(item.readonly, `${path}.readonly`),
    path: string(item.path, `${path}.path`),
    counts: counts && {
      sessions: number(counts.sessions, `${path}.counts.sessions`),
      turns: number(counts.turns, `${path}.counts.turns`),
      mounts: number(counts.mounts, `${path}.counts.mounts`),
    },
    sizeBytes: item.sizeBytes === undefined ? undefined : nullableNumber(item.sizeBytes, `${path}.sizeBytes`),
    lastModifiedAt: item.lastModifiedAt === undefined
      ? undefined
      : nullableString(item.lastModifiedAt, `${path}.lastModifiedAt`),
    error: error && {
      code: string(error.code, `${path}.error.code`),
      message: string(error.message, `${path}.error.message`),
    },
  }
}

export function parseSessionSummary(value: unknown, path = '$'): SessionSummary {
  const item = record(value, path)
  return {
    id: string(item.id, `${path}.id`),
    title: nullableString(item.title, `${path}.title`),
    status: string(item.status, `${path}.status`) as SessionStatus,
    kind: string(item.kind, `${path}.kind`) as SessionKind,
    parentSessionId: nullableString(item.parentSessionId, `${path}.parentSessionId`),
    parentCallId: nullableString(item.parentCallId, `${path}.parentCallId`),
    subagentMode: item.subagentMode === null
      ? null
      : string(item.subagentMode, `${path}.subagentMode`) as SubagentMode,
    workspaceRoot: string(item.workspaceRoot, `${path}.workspaceRoot`),
    scheduleId: nullableString(item.scheduleId, `${path}.scheduleId`),
    lastUsedModel: nullableString(item.lastUsedModel, `${path}.lastUsedModel`),
    lastAnswer: nullableString(item.lastAnswer, `${path}.lastAnswer`),
    createdAt: string(item.createdAt, `${path}.createdAt`),
    updatedAt: string(item.updatedAt, `${path}.updatedAt`),
    turnCount: number(item.turnCount, `${path}.turnCount`),
    inputTokens: number(item.inputTokens, `${path}.inputTokens`),
    outputTokens: number(item.outputTokens, `${path}.outputTokens`),
  }
}

export function parseSessionMount(value: unknown, path = '$'): SessionMount {
  const item = record(value, path)
  return {
    id: string(item.id, `${path}.id`),
    sessionId: string(item.sessionId, `${path}.sessionId`),
    name: string(item.name, `${path}.name`),
    absPath: string(item.absPath, `${path}.absPath`),
    kind: oneOf(item.kind, ['file', 'folder'] as const, `${path}.kind`),
    createdAt: string(item.createdAt, `${path}.createdAt`),
  }
}

export function parseTurnSummary(value: unknown, path = '$'): TurnSummary {
  const item = record(value, path)
  const userInput = record(item.userInput, `${path}.userInput`)
  return {
    id: string(item.id, `${path}.id`),
    sessionId: string(item.sessionId, `${path}.sessionId`),
    sessionOrdinal: number(item.sessionOrdinal, `${path}.sessionOrdinal`),
    userInput: {
      text: string(userInput.text, `${path}.userInput.text`),
      blocks: array(userInput.blocks, `${path}.userInput.blocks`).map((block, index) =>
        jsonObject(block, `${path}.userInput.blocks[${index}]`)),
    },
    status: string(item.status, `${path}.status`) as TurnStatus,
    finalAnswer: nullableString(item.finalAnswer, `${path}.finalAnswer`),
    error: nullableString(item.error, `${path}.error`),
    executionMode: nullableString(item.executionMode, `${path}.executionMode`),
    maxRounds: nullableNumber(item.maxRounds, `${path}.maxRounds`),
    model: nullableString(item.model, `${path}.model`),
    inputTokens: number(item.inputTokens, `${path}.inputTokens`),
    outputTokens: number(item.outputTokens, `${path}.outputTokens`),
    createdAt: string(item.createdAt, `${path}.createdAt`),
    completedAt: nullableString(item.completedAt, `${path}.completedAt`),
    durationMs: nullableNumber(item.durationMs, `${path}.durationMs`),
  }
}

function parseToolCall(value: unknown, path: string): OtaToolCall {
  const item = record(value, path)
  const argumentsValue = snakeOrCamel(item, 'arguments', 'tool_arguments') ?? []
  if (!Array.isArray(argumentsValue) && (typeof argumentsValue !== 'object' || argumentsValue === null)) {
    invalid(`${path}.arguments`, 'expected an object or array')
  }
  return {
    callId: item.callId === undefined && item.call_id === undefined
      ? null
      : nullableString(snakeOrCamel(item, 'callId', 'call_id'), `${path}.callId`),
    tool: string(item.tool, `${path}.tool`),
    arguments: jsonValue(argumentsValue) as JsonObject | JsonValue[],
    raw: item as JsonObject,
  }
}

function parseThinkResult(value: unknown, path: string): OtaThinkResult | null {
  if (value === null || value === undefined) return null
  const item = record(value, path)
  const calls = snakeOrCamel(item, 'toolCalls', 'tool_calls') ?? []
  return {
    stepContent: string(snakeOrCamel(item, 'stepContent', 'step_content') ?? '', `${path}.stepContent`),
    toolCalls: array(calls, `${path}.toolCalls`).map((call, index) =>
      parseToolCall(call, `${path}.toolCalls[${index}]`)),
    raw: item as JsonObject,
  }
}

function parseToolResult(value: unknown, path: string): OtaToolResult {
  const item = record(value, path)
  const toolResult = snakeOrCamel(item, 'toolResult', 'tool_result') ?? null
  return {
    toolId: snakeOrCamel(item, 'toolId', 'tool_id') == null
      ? null
      : string(snakeOrCamel(item, 'toolId', 'tool_id'), `${path}.toolId`),
    toolName: string(snakeOrCamel(item, 'toolName', 'tool_name') ?? '', `${path}.toolName`),
    toolArguments: jsonObject(
      snakeOrCamel(item, 'toolArguments', 'tool_arguments') ?? {},
      `${path}.toolArguments`,
    ),
    toolResult: jsonValue(toolResult),
    success: item.success === undefined ? true : boolean(item.success, `${path}.success`),
    error: item.error == null ? null : string(item.error, `${path}.error`),
    raw: item as JsonObject,
  }
}

function parseActionResult(value: unknown, path: string): OtaActionResult | null {
  if (value === null || value === undefined) return null
  const item = record(value, path)
  return {
    results: array(item.results ?? [], `${path}.results`).map((result, index) =>
      parseToolResult(result, `${path}.results[${index}]`)),
    raw: item as JsonObject,
  }
}

function parsePermission(value: unknown, path: string): OtaPermission | null {
  if (value === null || value === undefined) return null
  const item = record(value, path)
  return {
    executionMode: snakeOrCamel(item, 'executionMode', 'execution_mode') == null
      ? null
      : string(snakeOrCamel(item, 'executionMode', 'execution_mode'), `${path}.executionMode`),
    reviewed: item.reviewed === undefined ? false : boolean(item.reviewed, `${path}.reviewed`),
    verdicts: array(item.verdicts ?? [], `${path}.verdicts`).map((value, index) => {
      const verdict = record(value, `${path}.verdicts[${index}]`)
      return {
        id: verdict.id == null ? null : string(verdict.id, `${path}.verdicts[${index}].id`),
        tool: string(verdict.tool ?? '', `${path}.verdicts[${index}].tool`),
        arguments: jsonObject(verdict.arguments ?? {}, `${path}.verdicts[${index}].arguments`),
        verdict: string(verdict.verdict ?? '', `${path}.verdicts[${index}].verdict`),
        reason: verdict.reason == null ? null : string(verdict.reason, `${path}.verdicts[${index}].reason`),
        raw: verdict as JsonObject,
      }
    }),
    items: array(item.items ?? [], `${path}.items`).map((entry, index) =>
      jsonObject(entry, `${path}.items[${index}]`)),
    raw: item as JsonObject,
  }
}

function parseOtaRound(value: unknown, index: number, turnId: string, path: string): OtaRound {
  const item = record(value, path)
  const ordinal = item.ordinal === undefined ? index + 1 : number(item.ordinal, `${path}.ordinal`)
  const duration = item.turnDurationMs ?? item.durationMs ?? item.turn_duration_ms
  return {
    id: item.id === undefined ? `${turnId}:round:${ordinal}` : string(item.id, `${path}.id`),
    ordinal,
    observationResult: jsonValue(snakeOrCamel(item, 'observationResult', 'observation_result') ?? null),
    thinkResult: parseThinkResult(
      snakeOrCamel(item, 'thinkResult', 'think_result'),
      `${path}.thinkResult`,
    ),
    permission: parsePermission(item.permission, `${path}.permission`),
    actionResult: parseActionResult(
      snakeOrCamel(item, 'actionResult', 'action_result'),
      `${path}.actionResult`,
    ),
    durationMs: duration == null ? null : number(duration, `${path}.durationMs`),
    raw: item.raw === undefined ? item as JsonObject : jsonObject(item.raw, `${path}.raw`),
  }
}

export function parseTurnDetail(value: unknown, path = '$'): TurnDetail {
  const item = record(value, path)
  const summary = parseTurnSummary(item, path)
  const mounts = array(item.mounts, `${path}.mounts`).map((mount, index) =>
    parseSessionMount(mount, `${path}.mounts[${index}]`))
  const session = parseSessionSummary(item.session, `${path}.session`)
  return {
    ...summary,
    otaRecords: array(item.otaRecords, `${path}.otaRecords`).map((round, index) =>
      parseOtaRound(round, index, summary.id, `${path}.otaRecords[${index}]`)),
    agentState: optionalRecord(item.agentState, `${path}.agentState`) as JsonObject | null,
    browserToolLoaded: boolean(item.browserToolLoaded, `${path}.browserToolLoaded`),
    workspaceToolsLoaded: boolean(item.workspaceToolsLoaded, `${path}.workspaceToolsLoaded`),
    skillsToolLoaded: boolean(item.skillsToolLoaded, `${path}.skillsToolLoaded`),
    mounts,
    session,
    workspace: { root: session.workspaceRoot, mounts },
  }
}

export function parsePage<T>(value: unknown, parseItem: (item: unknown, path: string) => T, path = '$'): Page<T> {
  const page = record(value, path)
  return {
    items: array(page.items, `${path}.items`).map((item, index) =>
      parseItem(item, `${path}.items[${index}]`)),
    nextCursor: nullableString(page.nextCursor, `${path}.nextCursor`),
    total: number(page.total, `${path}.total`),
  }
}

function parsePromptMessage(value: unknown, path: string): PromptMessage {
  const item = record(value, path)
  return {
    role: string(item.role, `${path}.role`) as PromptRole,
    content: nullableString(item.content, `${path}.content`),
    toolCalls: item.toolCalls === undefined
      ? undefined
      : array(item.toolCalls, `${path}.toolCalls`).map((value, index) => {
        const call = record(value, `${path}.toolCalls[${index}]`)
        return {
          id: string(call.id, `${path}.toolCalls[${index}].id`),
          name: string(call.name, `${path}.toolCalls[${index}].name`),
          arguments: jsonObject(call.arguments, `${path}.toolCalls[${index}].arguments`),
        }
      }),
    toolCallId: item.toolCallId === undefined
      ? undefined
      : string(item.toolCallId, `${path}.toolCallId`),
    extras: item.extras === undefined ? undefined : jsonObject(item.extras, `${path}.extras`),
  }
}

function parsePromptComponent(value: unknown, path: string): PromptComponent {
  const item = record(value, path)
  return {
    id: string(item.id, `${path}.id`),
    kind: string(item.kind, `${path}.kind`) as PromptComponentKind,
    label: string(item.label, `${path}.label`),
    content: item.content === undefined ? undefined : string(item.content, `${path}.content`),
    messageIndexes: array(item.messageIndexes, `${path}.messageIndexes`).map((entry, index) =>
      number(entry, `${path}.messageIndexes[${index}]`)),
    source: array(item.source, `${path}.source`).map((entry, index) =>
      string(entry, `${path}.source[${index}]`)),
    fidelity: string(item.fidelity, `${path}.fidelity`) as PromptComponentFidelity,
    limitations: array(item.limitations, `${path}.limitations`).map((entry, index) =>
      string(entry, `${path}.limitations[${index}]`)),
    metadata: item.metadata === undefined
      ? undefined
      : jsonObject(item.metadata, `${path}.metadata`),
  }
}

function parsePromptTool(value: unknown, path: string): PromptToolSummary {
  const item = record(value, path)
  return {
    name: string(item.name, `${path}.name`),
    description: string(item.description, `${path}.description`),
    group: string(item.group, `${path}.group`),
    advanced: boolean(item.advanced, `${path}.advanced`),
    required: array(item.required, `${path}.required`).map((entry, index) =>
      string(entry, `${path}.required[${index}]`)),
    properties: array(item.properties, `${path}.properties`).map((entry, index) =>
      string(entry, `${path}.properties[${index}]`)),
    parameters: jsonObject(item.parameters, `${path}.parameters`),
    schemaFidelity: string(item.schemaFidelity, `${path}.schemaFidelity`),
  }
}

export function parsePromptReconstruction(value: unknown, path = '$'): PromptReconstruction {
  const item = record(value, path)
  const fidelity = record(item.fidelity, `${path}.fidelity`)
  return {
    sessionId: string(item.sessionId, `${path}.sessionId`),
    turnId: string(item.turnId, `${path}.turnId`),
    roundId: string(item.roundId, `${path}.roundId`),
    roundIndex: number(item.roundIndex, `${path}.roundIndex`),
    stage: string(item.stage, `${path}.stage`),
    model: nullableString(item.model, `${path}.model`),
    messages: array(item.messages, `${path}.messages`).map((message, index) =>
      parsePromptMessage(message, `${path}.messages[${index}]`)),
    tools: array(item.tools, `${path}.tools`).map((tool, index) =>
      parsePromptTool(tool, `${path}.tools[${index}]`)),
    components: array(item.components, `${path}.components`).map((component, index) =>
      parsePromptComponent(component, `${path}.components[${index}]`)),
    fidelity: {
      level: string(fidelity.level, `${path}.fidelity.level`),
      score: number(fidelity.score, `${path}.fidelity.score`),
      exactComponents: number(fidelity.exactComponents, `${path}.fidelity.exactComponents`),
      totalComponents: number(fidelity.totalComponents, `${path}.fidelity.totalComponents`),
      limitations: array(fidelity.limitations, `${path}.fidelity.limitations`).map((entry, index) =>
        string(entry, `${path}.fidelity.limitations[${index}]`)),
    },
    reconstructedAt: string(item.reconstructedAt, `${path}.reconstructedAt`),
  }
}

export function parsePromptReconstructionList(value: unknown, path = '$'): PromptReconstructionList {
  const collection = record(value, path)
  return {
    items: array(collection.items, `${path}.items`).map((item, index) =>
      parsePromptReconstruction(item, `${path}.items[${index}]`)),
    total: number(collection.total, `${path}.total`),
  }
}
