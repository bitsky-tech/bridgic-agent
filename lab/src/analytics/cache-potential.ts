import type {
  PromptComponentKind,
  PromptMessage,
  PromptReconstruction,
  PromptToolSummary,
} from '../api'

export type PromptCacheSection = PromptComponentKind | 'tools' | 'request_end'

export interface PromptCacheFirstDifference {
  section: PromptCacheSection
  messageIndex: number | null
}

export interface PromptCacheNonReusableSection {
  section: PromptCacheSection
  estimatedTokens: number
}

export interface PromptCacheInvocationPotential {
  turnId: string
  roundId: string
  roundIndex: number
  model: string | null
  baselineTurnId: string | null
  baselineRoundId: string | null
  estimatedRequestTokens: number
  estimatedReusableTokens: number
  estimatedNonReusableTokens: number
  potentialRatio: number
  nonReusableRatio: number
  nonReusableSections: PromptCacheNonReusableSection[]
  firstDifference: PromptCacheFirstDifference | null
}

export interface PromptCacheTurnPotential {
  turnId: string
  estimatedRequestTokens: number
  estimatedReusableTokens: number
  estimatedNonReusableTokens: number
  potentialRatio: number
  nonReusableRatio: number
  nonReusableSections: PromptCacheNonReusableSection[]
  comparableInvocations: number
  totalInvocations: number
  invocations: PromptCacheInvocationPotential[]
}

export interface PromptCachePotentialAnalysis {
  method: 'lab-canonical-prefix-v1'
  observedCacheUsage: false
  invocations: PromptCacheInvocationPotential[]
  turns: PromptCacheTurnPotential[]
}

interface RequestUnit {
  section: PromptCacheSection
  messageIndex: number | null
  text: string
}

interface LinearRequest {
  text: string
  units: Array<RequestUnit & { start: number; end: number }>
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

function providerTool(tool: PromptToolSummary): object {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

function componentContent(prompt: PromptReconstruction, kind: string): string | null {
  const content = prompt.components.find((component) => component.kind === kind)?.content
  return typeof content === 'string' ? content : null
}

function messageSection(prompt: PromptReconstruction, messageIndex: number): PromptCacheSection {
  const preferred = ['current_turn', 'current_input', 'session_history'] as const
  for (const kind of preferred) {
    if (prompt.components.some((component) =>
      component.kind === kind && component.messageIndexes.includes(messageIndex))) return kind
  }
  return 'session_history'
}

/**
 * Keep only prompt-facing fields when estimating reusable prompt text.
 * Provider replay metadata in `extras` (for example encrypted reasoning
 * state) is deliberately excluded: it is opaque transport state, not a
 * user-optimizable prompt block, and its encoded byte length is not a valid
 * approximation of provider input tokens.
 */
function promptFacingMessage(message: PromptMessage): object {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  }
}

function messageUnit(message: PromptMessage, index: number, section: PromptCacheSection): RequestUnit {
  return {
    section,
    messageIndex: index,
    text: `message:${stableJson(promptFacingMessage(message))}\n`,
  }
}

function requestUnits(prompt: PromptReconstruction): RequestUnit[] {
  const units: RequestUnit[] = [{
    section: 'tools',
    messageIndex: null,
    // Tool schemas are treated as an early cache gate. This is conservative
    // across providers whose internal request encoders place tools differently.
    text: `tools:${stableJson(prompt.tools.map(providerTool))}\n`,
  }]

  const persona = componentContent(prompt, 'persona')
  const context = componentContent(prompt, 'context')
  if (persona !== null || context !== null) {
    units.push({
      section: 'persona',
      messageIndex: 0,
      text: `message-system-persona:${stableJson(persona ?? '')}\n`,
    })
    units.push({
      section: 'context',
      messageIndex: 0,
      text: `message-system-context:${stableJson(context ?? '')}\n`,
    })
  } else if (prompt.messages[0]) {
    units.push(messageUnit(prompt.messages[0], 0, 'context'))
  }

  const start = persona !== null || context !== null ? 1 : prompt.messages.length > 0 ? 1 : 0
  for (let index = start; index < prompt.messages.length; index += 1) {
    const message = prompt.messages[index]
    if (message) units.push(messageUnit(message, index, messageSection(prompt, index)))
  }
  return units
}

function linearize(prompt: PromptReconstruction): LinearRequest {
  let offset = 0
  const units = requestUnits(prompt).map((unit) => {
    const mapped = { ...unit, start: offset, end: offset + unit.text.length }
    offset = mapped.end
    return mapped
  })
  return { text: units.map((unit) => unit.text).join(''), units }
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

export function estimatePromptTokens(text: string): number {
  const bytes = new TextEncoder().encode(text).byteLength
  return bytes === 0 ? 0 : Math.ceil(bytes / 4)
}

function estimatedTokens(text: string, reusable = false): number {
  if (!reusable) return estimatePromptTokens(text)
  const bytes = new TextEncoder().encode(text).byteLength
  return Math.floor(bytes / 4)
}

function differenceAt(request: LinearRequest, offset: number): PromptCacheFirstDifference | null {
  const unit = request.units.find((candidate) => offset < candidate.end)
  if (!unit) return offset >= request.text.length ? null : { section: 'request_end', messageIndex: null }
  return { section: unit.section, messageIndex: unit.messageIndex }
}

function buildNonReusableSections(
  request: LinearRequest,
  prefixLength: number,
  estimatedNonReusableTokens: number,
): PromptCacheNonReusableSection[] {
  if (estimatedNonReusableTokens === 0) return []

  const bytesBySection = new Map<PromptCacheSection, number>()
  for (const unit of request.units) {
    if (unit.end <= prefixLength) continue
    const unitOffset = Math.max(0, prefixLength - unit.start)
    const bytes = new TextEncoder().encode(unit.text.slice(unitOffset)).byteLength
    if (bytes > 0) bytesBySection.set(unit.section, (bytesBySection.get(unit.section) ?? 0) + bytes)
  }

  const entries = [...bytesBySection.entries()]
  const totalBytes = entries.reduce((sum, [, bytes]) => sum + bytes, 0)
  if (totalBytes === 0) {
    return [{ section: 'request_end', estimatedTokens: estimatedNonReusableTokens }]
  }

  let cumulativeBytes = 0
  let allocatedTokens = 0
  return entries.map(([section, bytes], index) => {
    cumulativeBytes += bytes
    const allocatedThroughSection = index === entries.length - 1
      ? estimatedNonReusableTokens
      : Math.round(estimatedNonReusableTokens * cumulativeBytes / totalBytes)
    const estimatedTokens = allocatedThroughSection - allocatedTokens
    allocatedTokens = allocatedThroughSection
    return { section, estimatedTokens }
  })
}

function aggregateNonReusableSections(
  invocations: readonly PromptCacheInvocationPotential[],
): PromptCacheNonReusableSection[] {
  const tokensBySection = new Map<PromptCacheSection, number>()
  for (const invocation of invocations) {
    for (const section of invocation.nonReusableSections) {
      tokensBySection.set(section.section, (tokensBySection.get(section.section) ?? 0) + section.estimatedTokens)
    }
  }
  return [...tokensBySection].map(([section, estimatedTokens]) => ({ section, estimatedTokens }))
}

/**
 * Estimate reusable prompt tokens from the canonical shared prefix of each
 * request and the latest earlier request using the same exact model name.
 * This is structural potential, not provider-observed cache telemetry.
 */
export function analyzePromptCachePotential(
  prompts: readonly PromptReconstruction[],
): PromptCachePotentialAnalysis {
  const latestByModel = new Map<string, { prompt: PromptReconstruction; request: LinearRequest }>()
  const invocations: PromptCacheInvocationPotential[] = []
  const turnOrder: string[] = []
  const turnInvocations = new Map<string, PromptCacheInvocationPotential[]>()

  for (const prompt of prompts) {
    const request = linearize(prompt)
    const baseline = prompt.model ? latestByModel.get(prompt.model) ?? null : null
    const prefixLength = baseline ? commonPrefixLength(baseline.request.text, request.text) : 0
    const estimatedRequestTokens = estimatedTokens(request.text)
    const estimatedReusableTokens = prefixLength >= request.text.length
      ? estimatedRequestTokens
      : estimatedTokens(request.text.slice(0, prefixLength), true)
    const estimatedNonReusableTokens = estimatedRequestTokens - estimatedReusableTokens
    const invocation: PromptCacheInvocationPotential = {
      turnId: prompt.turnId,
      roundId: prompt.roundId,
      roundIndex: prompt.roundIndex,
      model: prompt.model,
      baselineTurnId: baseline?.prompt.turnId ?? null,
      baselineRoundId: baseline?.prompt.roundId ?? null,
      estimatedRequestTokens,
      estimatedReusableTokens,
      estimatedNonReusableTokens,
      potentialRatio: estimatedRequestTokens > 0 ? estimatedReusableTokens / estimatedRequestTokens : 0,
      nonReusableRatio: estimatedRequestTokens > 0 ? estimatedNonReusableTokens / estimatedRequestTokens : 0,
      nonReusableSections: buildNonReusableSections(request, prefixLength, estimatedNonReusableTokens),
      firstDifference: baseline ? differenceAt(request, prefixLength) : null,
    }
    invocations.push(invocation)

    if (!turnInvocations.has(prompt.turnId)) {
      turnOrder.push(prompt.turnId)
      turnInvocations.set(prompt.turnId, [])
    }
    turnInvocations.get(prompt.turnId)?.push(invocation)
    if (prompt.model) latestByModel.set(prompt.model, { prompt, request })
  }

  const turns = turnOrder.map((turnId): PromptCacheTurnPotential => {
    const items = turnInvocations.get(turnId) ?? []
    const estimatedRequestTokens = items.reduce((sum, item) => sum + item.estimatedRequestTokens, 0)
    const estimatedReusableTokens = items.reduce((sum, item) => sum + item.estimatedReusableTokens, 0)
    const estimatedNonReusableTokens = estimatedRequestTokens - estimatedReusableTokens
    return {
      turnId,
      estimatedRequestTokens,
      estimatedReusableTokens,
      estimatedNonReusableTokens,
      potentialRatio: estimatedRequestTokens > 0 ? estimatedReusableTokens / estimatedRequestTokens : 0,
      nonReusableRatio: estimatedRequestTokens > 0 ? estimatedNonReusableTokens / estimatedRequestTokens : 0,
      nonReusableSections: aggregateNonReusableSections(items),
      comparableInvocations: items.filter((item) => item.baselineRoundId !== null).length,
      totalInvocations: items.length,
      invocations: items,
    }
  })

  return {
    method: 'lab-canonical-prefix-v1',
    observedCacheUsage: false,
    invocations,
    turns,
  }
}
