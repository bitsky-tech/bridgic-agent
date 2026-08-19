import { useId, useMemo, type ReactNode } from 'react'
import type { JsonObject, JsonValue, PromptMessage } from '../api'
import './TurnHistoryView.css'

export interface TurnHistoryLabels {
  title: string
  step: string
  assistant: string
  assistantDecision: string
  toolCalls: string
  toolCall: string
  arguments: string
  noArguments: string
  toolResult: string
  noToolResult: string
  unmatchedToolResult: string
  observations: string
  observation: string
  noObservation: string
  callId: string
  message: string
  empty: string
}

export interface TurnHistoryToolResult {
  id: string
  messageIndex: number
  toolCallId: string | null
  content: string | null
  structuredContent: JsonValue | null
}

export interface TurnHistoryObservation {
  id: string
  messageIndex: number
  content: string | null
  structuredContent: JsonValue | null
}

export interface TurnHistoryAction {
  id: string
  name: string
  arguments: JsonObject
  results: TurnHistoryToolResult[]
}

export interface TurnHistoryStep {
  id: string
  ordinal: number
  assistantMessageIndex: number | null
  assistantContent: string | null
  actions: TurnHistoryAction[]
  unmatchedToolResults: TurnHistoryToolResult[]
  observations: TurnHistoryObservation[]
}

export interface TurnHistoryViewProps {
  /** Native messages from PromptReconstruction or PromptViewModel.transcript. */
  messages: readonly PromptMessage[]
  /** Usually the current_turn component's messageIndexes. Omit to inspect all messages. */
  messageIndexes?: readonly number[]
  labels?: Partial<TurnHistoryLabels>
  className?: string
  emptyState?: ReactNode
}

const defaultLabels: TurnHistoryLabels = {
  title: 'Turn history',
  step: 'Step',
  assistant: 'Assistant',
  assistantDecision: 'Tool decision',
  toolCalls: 'Tool calls',
  toolCall: 'tool call',
  arguments: 'Arguments',
  noArguments: 'No arguments',
  toolResult: 'Tool result',
  noToolResult: 'No tool result recorded',
  unmatchedToolResult: 'Unmatched tool result',
  observations: 'Observations',
  observation: 'Observation',
  noObservation: 'No observation recorded',
  callId: 'Call ID',
  message: 'Message',
  empty: 'No earlier activity in this Turn.',
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

function parseStructuredContent(content: string | null): JsonValue | null {
  if (!content) return null
  const candidate = content.trim()
  if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) return null
  try {
    const parsed: unknown = JSON.parse(candidate)
    return isJsonValue(parsed) ? parsed : null
  } catch {
    return null
  }
}

function toolResultFromMessage(message: PromptMessage, messageIndex: number): TurnHistoryToolResult {
  return {
    id: `tool-result-${messageIndex}`,
    messageIndex,
    toolCallId: message.toolCallId ?? null,
    content: message.content,
    structuredContent: parseStructuredContent(message.content),
  }
}

function observationFromMessage(message: PromptMessage, messageIndex: number): TurnHistoryObservation {
  return {
    id: `observation-${messageIndex}`,
    messageIndex,
    content: message.content,
    structuredContent: parseStructuredContent(message.content),
  }
}

function selectedMessageIndexes(messages: readonly PromptMessage[], indexes?: readonly number[]): number[] {
  const candidates = indexes ?? messages.map((_, index) => index)
  const seen = new Set<number>()
  return candidates.filter((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= messages.length || seen.has(index)) {
      return false
    }
    seen.add(index)
    return true
  })
}

/** Groups current-turn native messages into Assistant -> Tool call/result -> Observation steps. */
export function buildTurnHistorySteps(
  messages: readonly PromptMessage[],
  messageIndexes?: readonly number[],
): TurnHistoryStep[] {
  const steps: TurnHistoryStep[] = []
  let currentStep: TurnHistoryStep | null = null

  for (const messageIndex of selectedMessageIndexes(messages, messageIndexes)) {
    const message = messages[messageIndex]
    if (!message) continue
    if (message.role === 'assistant') {
      currentStep = {
        id: `assistant-${messageIndex}`,
        ordinal: steps.length + 1,
        assistantMessageIndex: messageIndex,
        assistantContent: message.content,
        actions: (message.toolCalls ?? []).map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          results: [],
        })),
        unmatchedToolResults: [],
        observations: [],
      }
      steps.push(currentStep)
      continue
    }

    if (message.role === 'user') {
      if (!currentStep) {
        currentStep = {
          id: `user-${messageIndex}`,
          ordinal: steps.length + 1,
          assistantMessageIndex: null,
          assistantContent: null,
          actions: [],
          unmatchedToolResults: [],
          observations: [],
        }
        steps.push(currentStep)
      }
      currentStep.observations.push(observationFromMessage(message, messageIndex))
      continue
    }

    if (message.role !== 'tool') continue

    const toolResult = toolResultFromMessage(message, messageIndex)
    const matchingAction = [...steps]
      .reverse()
      .flatMap((step) => [...step.actions].reverse())
      .find((action) => Boolean(message.toolCallId) && action.id === message.toolCallId)
    if (matchingAction) {
      matchingAction.results.push(toolResult)
      continue
    }

    if (!currentStep) {
      currentStep = {
        id: `tool-${messageIndex}`,
        ordinal: steps.length + 1,
        assistantMessageIndex: null,
        assistantContent: null,
        actions: [],
        unmatchedToolResults: [],
        observations: [],
      }
      steps.push(currentStep)
    }
    currentStep.unmatchedToolResults.push(toolResult)
  }

  return steps.filter((step) =>
    step.assistantContent !== null
    || step.actions.length > 0
    || step.unmatchedToolResults.length > 0
    || step.observations.length > 0)
}

function StructuredValue({ value }: { value: JsonValue }) {
  if (value === null) return <span className="turn-history-value-muted">null</span>
  if (typeof value === 'boolean' || typeof value === 'number') {
    return <span className="turn-history-value-primitive">{String(value)}</span>
  }
  if (typeof value === 'string') return <span className="turn-history-value-string">{value}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="turn-history-value-muted">—</span>
    return (
      <ol className="turn-history-value-array">
        {value.map((item, index) => <li key={index}><StructuredValue value={item} /></li>)}
      </ol>
    )
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return <span className="turn-history-value-muted">—</span>
  return (
    <dl className="turn-history-value-object">
      {entries.map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd><StructuredValue value={item} /></dd>
        </div>
      ))}
    </dl>
  )
}

function MessageContent({ entry, emptyLabel }: {
  entry: TurnHistoryObservation | TurnHistoryToolResult
  emptyLabel: string
}) {
  if (entry.structuredContent !== null) {
    return <StructuredValue value={entry.structuredContent} />
  }
  if (!entry.content) return <span className="turn-history-value-muted">{emptyLabel}</span>
  return <pre className="turn-history-prose">{entry.content}</pre>
}

function FlowArrow() {
  return <span className="turn-history-arrow" aria-hidden="true">→</span>
}

export function TurnHistoryView({
  messages,
  messageIndexes,
  labels: labelOverrides,
  className = '',
  emptyState,
}: TurnHistoryViewProps) {
  const headingId = `turn-history-${useId().replace(/:/g, '')}`
  const labels = useMemo(
    () => ({ ...defaultLabels, ...labelOverrides }),
    [labelOverrides],
  )
  const indexSignature = messageIndexes?.join(',') ?? '*'
  const steps = useMemo(
    () => buildTurnHistorySteps(messages, messageIndexes),
    [messages, indexSignature],
  )

  if (steps.length === 0) {
    return (
      <div className={`turn-history-empty ${className}`.trim()} role="status">
        {emptyState ?? labels.empty}
      </div>
    )
  }

  return (
    <section className={`turn-history-view ${className}`.trim()} aria-labelledby={headingId}>
      <h3 id={headingId}>{labels.title}</h3>
      <ol className="turn-history-steps">
        {steps.map((step) => (
            <li key={step.id} className="turn-history-step">
              <header className="turn-history-step-header">
                <span className="turn-history-step-number">{step.ordinal}</span>
                <strong>{labels.step} {step.ordinal}</strong>
                {step.assistantMessageIndex !== null && (
                  <span>{labels.message} {step.assistantMessageIndex + 1}</span>
                )}
              </header>

              <div className="turn-history-flow">
                <section className="turn-history-node turn-history-assistant-node">
                  <header>
                    <span className="turn-history-node-dot" aria-hidden="true" />
                    <strong>{labels.assistant}</strong>
                  </header>
                  {step.assistantContent
                    ? <pre className="turn-history-prose">{step.assistantContent}</pre>
                    : step.actions.length > 0 ? (
                      <p className="turn-history-decision">
                        {labels.assistantDecision}
                        <span>{step.actions.length} {labels.toolCall}</span>
                      </p>
                    ) : <p className="turn-history-value-muted">—</p>}
                </section>

                <FlowArrow />

                <section className="turn-history-node turn-history-actions-node">
                  <header>
                    <span className="turn-history-node-dot" aria-hidden="true" />
                    <strong>{labels.toolCalls}</strong>
                    <span className="turn-history-count">{step.actions.length}</span>
                  </header>
                  {step.actions.length > 0 || step.unmatchedToolResults.length > 0 ? (
                    <ol className="turn-history-actions">
                      {step.actions.map((action, actionIndex) => (
                        <li key={`${action.id}-${actionIndex}`}>
                          <div className="turn-history-action-heading">
                            <span>{actionIndex + 1}</span>
                            <code>{action.name || labels.toolCall}</code>
                          </div>
                          {action.id && <small>{labels.callId}: {action.id}</small>}
                          <details className="turn-history-arguments">
                            <summary>{labels.arguments}</summary>
                            {Object.keys(action.arguments).length > 0
                              ? <StructuredValue value={action.arguments} />
                              : <span className="turn-history-value-muted">{labels.noArguments}</span>}
                          </details>
                          <div className="turn-history-tool-results">
                            <strong>{labels.toolResult}</strong>
                            {action.results.length > 0
                              ? action.results.map((result) => (
                                  <div key={result.id} className="turn-history-tool-result">
                                    <MessageContent entry={result} emptyLabel={labels.noToolResult} />
                                  </div>
                                ))
                              : <span className="turn-history-value-muted">{labels.noToolResult}</span>}
                          </div>
                        </li>
                      ))}
                      {step.unmatchedToolResults.map((result) => (
                        <li key={result.id} className="turn-history-unmatched-result">
                          <div className="turn-history-observation-heading">
                            <span>{labels.unmatchedToolResult}</span>
                            {result.toolCallId && <code>{result.toolCallId}</code>}
                          </div>
                          <MessageContent entry={result} emptyLabel={labels.noToolResult} />
                        </li>
                      ))}
                    </ol>
                  ) : <p className="turn-history-value-muted">—</p>}
                </section>

                <FlowArrow />

                <section className="turn-history-node turn-history-observations-node">
                  <header>
                    <span className="turn-history-node-dot" aria-hidden="true" />
                    <strong>{labels.observations}</strong>
                    <span className="turn-history-count">{step.observations.length}</span>
                  </header>
                  {step.observations.length > 0 ? (
                    <ol className="turn-history-observations">
                      {step.observations.map((observation) => (
                        <li key={observation.id}>
                          <div className="turn-history-observation-heading">
                            <span>{labels.observation}</span>
                          </div>
                          <MessageContent entry={observation} emptyLabel={labels.noObservation} />
                        </li>
                      ))}
                    </ol>
                  ) : <p className="turn-history-value-muted">{labels.noObservation}</p>}
                </section>
              </div>
            </li>
        ))}
      </ol>
    </section>
  )
}
