import type {
  JsonObject,
  JsonValue,
  PromptComponent,
  PromptMessage,
  PromptReconstruction,
  PromptToolSummary,
} from '../api/types'
import type {
  CanonicalPromptBlockKind,
  PromptTranscriptView,
  PromptViewModel,
  PromptViewOptions,
  ReadablePromptBlock,
  ReadablePromptFidelity,
  ReadablePromptMessage,
  RenderTranscriptOptions,
} from './types'

export const PROMPT_BLOCK_ORDER = [
  'persona',
  'context',
  'session_history',
  'current_input',
  'current_turn',
  'tools',
] as const satisfies readonly CanonicalPromptBlockKind[]

const defaultBlockTitles: Record<CanonicalPromptBlockKind, string> = {
  persona: 'Persona',
  context: 'Context',
  session_history: 'Session history',
  current_input: 'Current input',
  current_turn: 'Current turn',
  tools: 'Tool surface',
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function indent(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n')
}

function readableScalar(value: string): string {
  if (value === '') return '""'
  if (/^[\w./@+\- ]+$/u.test(value) && value.trim() === value) return value
  return JSON.stringify(value)
}

/** Render JSON data as an indentation-based diagnostic value rather than a JSON blob. */
export function renderReadableValue(value: JsonValue, depth = 0): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (!value.includes('\n')) return readableScalar(value)
    return `|\n${indent(value, depth + 2)}`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map((item) => {
      const rendered = renderReadableValue(item, depth + 2)
      return rendered.includes('\n')
        ? `${' '.repeat(depth)}-\n${indent(rendered, 2)}`
        : `${' '.repeat(depth)}- ${rendered}`
    }).join('\n')
  }
  if (isObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    return entries.map(([key, item]) => {
      const rendered = renderReadableValue(item, depth + 2)
      return rendered.includes('\n')
        ? `${' '.repeat(depth)}${key}:\n${indent(rendered, 2)}`
        : `${' '.repeat(depth)}${key}: ${rendered}`
    }).join('\n')
  }
  return String(value)
}

function roleName(role: string): string {
  return role.toUpperCase()
}

function renderMessage(
  message: PromptMessage,
  index: number,
  includeMessageExtras: boolean,
): ReadablePromptMessage {
  const heading = `${roleName(message.role)} · message ${index + 1}`
  const lines = [heading]

  if (message.role === 'tool') {
    lines.push(`tool call id: ${message.toolCallId ?? '(not recorded)'}`)
  }
  if (message.content === null || message.content === '') {
    lines.push('(no text content)')
  } else {
    lines.push(message.content)
  }

  const toolCalls = (message.toolCalls ?? []).map((call) => ({
    ...call,
    argumentsText: renderReadableValue(call.arguments),
  }))
  if (toolCalls.length > 0) {
    lines.push('tool calls:')
    toolCalls.forEach((call, callIndex) => {
      lines.push(`  ${callIndex + 1}. ${call.name || '(name not recorded)'}`)
      lines.push(`     id: ${call.id || '(not recorded)'}`)
      lines.push('     arguments:')
      lines.push(indent(call.argumentsText, 7))
    })
  }

  const extras = includeMessageExtras ? message.extras ?? null : null
  if (includeMessageExtras && extras && Object.keys(extras).length > 0) {
    lines.push('provider replay metadata:')
    lines.push(indent(renderReadableValue(extras), 2))
  }

  return {
    id: `message-${index}`,
    index,
    role: message.role,
    heading,
    label: heading,
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    toolCalls,
    extras,
    text: lines.join('\n'),
    copyText: lines.join('\n'),
  }
}

/** Render native messages as role-labelled prose while preserving tool pairing. */
export function renderPromptTranscript(
  messages: readonly PromptMessage[],
  options: RenderTranscriptOptions = {},
): PromptTranscriptView {
  const indexes = options.messageIndexes ?? messages.map((_, index) => index)
  const rendered = indexes.flatMap((index) => {
    const message = messages[index]
    return message ? [renderMessage(message, index, options.includeMessageExtras === true)] : []
  })
  return {
    messages: rendered,
    text: rendered.map((message) => message.text).join('\n\n'),
  }
}

/**
 * Return the model-readable message projection used by the Prompt inspector.
 * Provider replay state can be required by an API without being readable prompt
 * text, so it stays on PromptReconstruction but is excluded from UI/export data.
 */
export function promptMessagesWithoutProviderMetadata(
  messages: readonly PromptMessage[],
): PromptMessage[] {
  return messages.map(({ extras: _providerMetadata, ...message }) => ({ ...message }))
}

function renderTool(tool: PromptToolSummary, index: number): string {
  const lines = [
    `${index + 1}. ${tool.name}`,
    `   description: ${tool.description || '(not recorded)'}`,
    `   group: ${tool.group || '(not recorded)'}`,
    `   advanced: ${tool.advanced ? 'yes' : 'no'}`,
    `   schema fidelity: ${tool.schemaFidelity}`,
    `   required: ${tool.required.length > 0 ? tool.required.join(', ') : '(none)'}`,
    `   properties: ${tool.properties.length > 0 ? tool.properties.join(', ') : '(none)'}`,
    '   parameters:',
    indent(renderReadableValue(tool.parameters), 5),
  ]
  return lines.join('\n')
}

/** Human-readable tool definitions sent alongside the native message list. */
export function renderPromptToolSurface(tools: readonly PromptToolSummary[]): string {
  if (tools.length === 0) return '(no tools sent)'
  return tools.map(renderTool).join('\n\n')
}

function isCanonicalKind(kind: string): kind is CanonicalPromptBlockKind {
  return (PROMPT_BLOCK_ORDER as readonly string[]).includes(kind)
}

function normalizeFidelity(value: string): ReadablePromptFidelity {
  if (value === 'exact' || value === 'reconstructed' || value === 'partial') return value
  return 'unavailable'
}

function componentText(
  kind: CanonicalPromptBlockKind,
  component: PromptComponent,
  prompt: PromptReconstruction,
  includeMessageExtras: boolean,
  emptyBlockText: string,
): { text: string; unresolvedMessageIndexes: number[] } {
  if (kind === 'tools') {
    return { text: renderPromptToolSurface(prompt.tools), unresolvedMessageIndexes: [] }
  }
  if ((kind === 'persona' || kind === 'context') && component.content !== undefined) {
    return { text: component.content, unresolvedMessageIndexes: [] }
  }

  const unresolvedMessageIndexes = component.messageIndexes
    .filter((index) => prompt.messages[index] === undefined)
  const transcript = renderPromptTranscript(prompt.messages, {
    includeMessageExtras,
    messageIndexes: component.messageIndexes,
  })
  if (transcript.text) return { text: transcript.text, unresolvedMessageIndexes }
  if (component.content !== undefined && component.content !== '') {
    return { text: component.content, unresolvedMessageIndexes }
  }
  return { text: emptyBlockText, unresolvedMessageIndexes }
}

function missingBlock(
  kind: CanonicalPromptBlockKind,
  title: string,
  emptyBlockText: string,
): ReadablePromptBlock {
  const text = emptyBlockText
  return {
    id: kind,
    kind,
    title,
    label: title,
    originalLabel: null,
    componentId: null,
    fidelity: 'unavailable',
    sources: [],
    limitations: [`The reconstruction response did not include a ${kind} component.`],
    messageIndexes: [],
    unresolvedMessageIndexes: [],
    text,
    characterCount: text.length,
    empty: true,
    defaultExpanded: kind === 'persona',
  }
}

function renderBlocks(prompt: PromptReconstruction, options: PromptViewOptions): ReadablePromptBlock[] {
  const emptyBlockText = options.emptyBlockText ?? '(no content in this block)'
  const includeMessageExtras = options.includeMessageExtras === true
  return PROMPT_BLOCK_ORDER.map((kind) => {
    const title = options.blockTitles?.[kind] ?? defaultBlockTitles[kind]
    const component = prompt.components.find((candidate) => candidate.kind === kind)
    if (!component) return missingBlock(kind, title, emptyBlockText)

    const rendered = componentText(
      kind,
      component,
      prompt,
      includeMessageExtras,
      emptyBlockText,
    )
    const limitations = rendered.unresolvedMessageIndexes.length > 0
      ? [
          ...component.limitations,
          `Message indexes were not present: ${rendered.unresolvedMessageIndexes.join(', ')}.`,
        ]
      : [...component.limitations]
    return {
      id: component.id,
      kind,
      title,
      label: title,
      originalLabel: component.label,
      componentId: component.id,
      fidelity: normalizeFidelity(component.fidelity),
      description: component.label === title ? undefined : component.label,
      sources: [...component.source],
      limitations,
      messageIndexes: [...component.messageIndexes],
      unresolvedMessageIndexes: rendered.unresolvedMessageIndexes,
      text: rendered.text,
      characterCount: rendered.text.length,
      empty: component.messageIndexes.length === 0 && !component.content && kind !== 'tools',
      defaultExpanded: kind === 'persona',
    }
  })
}

function renderProvenance(blocks: readonly ReadablePromptBlock[]): string {
  return blocks.map((block, index) => {
    const lines = [
      `${index + 1}. ${block.title}`,
      `   kind: ${block.kind}`,
      `   fidelity: ${block.fidelity}`,
      `   sources: ${block.sources.length > 0 ? block.sources.join(' · ') : '(none recorded)'}`,
    ]
    if (block.limitations.length > 0) {
      lines.push('   limitations:')
      block.limitations.forEach((limitation) => lines.push(`     - ${limitation}`))
    }
    return lines.join('\n')
  }).join('\n\n')
}

function assembledText(
  prompt: PromptReconstruction,
  transcript: PromptTranscriptView,
  toolSurfaceText: string,
  blocks: readonly ReadablePromptBlock[],
  title: string,
): string {
  const header = [
    title,
    `session: ${prompt.sessionId}`,
    `turn: ${prompt.turnId}`,
    `round: ${prompt.roundId} (index ${prompt.roundIndex})`,
    `stage: ${prompt.stage}`,
    `model: ${prompt.model ?? '(not recorded)'}`,
    `fidelity: ${prompt.fidelity.level} (score ${prompt.fidelity.score})`,
  ].join('\n')
  const messages = transcript.text || '(no native messages reconstructed)'
  return [
    header,
    'NATIVE MESSAGES',
    messages,
    'TOOL DEFINITIONS',
    toolSurfaceText,
    'COMPONENT PROVENANCE',
    renderProvenance(blocks),
  ].join('\n\n')
}

/** Build all copy/render data needed by a Prompt inspector without React coupling. */
export function buildPromptViewModel(
  prompt: PromptReconstruction,
  options: PromptViewOptions = {},
): PromptViewModel {
  const transcript = renderPromptTranscript(prompt.messages, {
    includeMessageExtras: options.includeMessageExtras,
  })
  const toolSurfaceText = renderPromptToolSurface(prompt.tools)
  const blocks = renderBlocks(prompt, options)
  const mappedIds = new Set(blocks.flatMap((block) => block.componentId ? [block.componentId] : []))
  return {
    sessionId: prompt.sessionId,
    turnId: prompt.turnId,
    roundId: prompt.roundId,
    roundIndex: prompt.roundIndex,
    stage: prompt.stage,
    model: prompt.model,
    blocks,
    transcript,
    toolSurfaceText,
    assembledText: assembledText(
      prompt,
      transcript,
      toolSurfaceText,
      blocks,
      options.documentTitle ?? 'BRIDGIC AGENT PROMPT REQUEST',
    ),
    fidelity: prompt.fidelity,
    reconstructedAt: prompt.reconstructedAt,
    unmappedComponents: prompt.components.filter((component) =>
      !mappedIds.has(component.id) || !isCanonicalKind(component.kind)),
  }
}
