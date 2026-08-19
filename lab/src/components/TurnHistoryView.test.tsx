import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PromptMessage } from '../api'
import { buildTurnHistorySteps, TurnHistoryView } from './TurnHistoryView'

const messages: PromptMessage[] = [
  { role: 'system', content: 'System prompt' },
  { role: 'user', content: 'Inspect the workspace.' },
  {
    role: 'assistant',
    content: 'I will inspect two files.',
    toolCalls: [
      { id: 'call_a', name: 'read_file', arguments: { path: '/tmp/a.md' } },
      { id: 'call_b', name: 'read_file', arguments: { path: '/tmp/b.md' } },
    ],
  },
  { role: 'tool', content: '{"path":"b.md","lines":12}', toolCallId: 'call_b' },
  { role: 'tool', content: 'Contents of A', toolCallId: 'call_a' },
  { role: 'user', content: 'Both source files are now available.' },
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'call_c', name: 'write_file', arguments: { path: '/tmp/result.md' } }],
  },
  { role: 'tool', content: 'Saved', toolCallId: 'call_c' },
  { role: 'user', content: '{"changed":true,"next":"verify"}' },
  { role: 'assistant', content: 'The write is complete.' },
  { role: 'user', content: 'Proceed to the final response.' },
]

const messagesWithProviderMetadata: PromptMessage[] = messages.map((message, index) => (
  index === 2
    ? {
        ...message,
        extras: {
          reasoning_items: [{
            type: 'reasoning',
            encrypted_content: 'opaque-turn-history-provider-state',
          }],
        },
      }
    : message
))

describe('TurnHistoryView', () => {
  test('groups Assistant tool calls with matching Tool results and User observations', () => {
    const steps = buildTurnHistorySteps(messages, [2, 3, 4, 5, 6, 7, 8])
    const firstStep = steps[0]!
    const secondStep = steps[1]!

    expect(steps).toHaveLength(2)
    expect(firstStep.assistantContent).toBe('I will inspect two files.')
    expect(firstStep.actions.map((action) => action.id)).toEqual(['call_a', 'call_b'])
    expect(firstStep.actions[0]!.results[0]!.content).toBe('Contents of A')
    expect(firstStep.actions[1]!.results[0]!.structuredContent).toEqual({
      path: 'b.md',
      lines: 12,
    })
    expect(firstStep.observations[0]!.content).toBe('Both source files are now available.')
    expect(secondStep.actions[0]!.results[0]!.content).toBe('Saved')
    expect(secondStep.observations[0]!.structuredContent).toEqual({ changed: true, next: 'verify' })
  })

  test('honors current_turn message indexes and ignores messages outside the block', () => {
    const steps = buildTurnHistorySteps(messages, [6, 7, 8])
    const firstStep = steps[0]!

    expect(steps).toHaveLength(1)
    expect(firstStep.assistantMessageIndex).toBe(6)
    expect(firstStep.actions.map((action) => action.name)).toEqual(['write_file'])
  })

  test('renders Chinese labels and structured arguments/results without JSON blobs', () => {
    const markup = renderToStaticMarkup(
      <TurnHistoryView
        messages={messages}
        messageIndexes={[2, 3, 4, 5]}
        labels={{
          title: 'Turn 历史',
          step: '步骤',
          assistant: 'Assistant 决策',
          toolCalls: '工具调用',
          observations: '观察结果',
          arguments: '参数',
        }}
      />,
    )

    expect(markup).toContain('Turn 历史')
    expect(markup).toContain('步骤 1')
    expect(markup).toContain('Assistant 决策')
    expect(markup).toContain('read_file')
    expect(markup).toContain('Tool result')
    expect(markup).toContain('Both source files are now available.')
    expect(markup).toContain('<dt>path</dt>')
    expect(markup).toContain('<dt>lines</dt>')
    expect(markup).not.toContain('&quot;path&quot;')
  })

  test('does not render opaque provider replay metadata attached to Assistant messages', () => {
    const markup = renderToStaticMarkup(
      <TurnHistoryView messages={messagesWithProviderMetadata} messageIndexes={[2, 3, 4, 5]} />,
    )

    expect(markup).toContain('I will inspect two files.')
    expect(markup).not.toContain('encrypted_content')
    expect(markup).not.toContain('opaque-turn-history-provider-state')
  })

  test('keeps Assistant and User observation steps that do not call tools', () => {
    const steps = buildTurnHistorySteps(messages, [9, 10])
    const firstStep = steps[0]!

    expect(steps).toHaveLength(1)
    expect(firstStep.assistantContent).toBe('The write is complete.')
    expect(firstStep.actions).toEqual([])
    expect(firstStep.observations[0]!.content).toBe('Proceed to the final response.')
  })

  test('shows a localized empty state when the block has no prior activity', () => {
    const markup = renderToStaticMarkup(
      <TurnHistoryView messages={messages} messageIndexes={[]} labels={{ empty: '当前还没有 Turn 历史' }} />,
    )

    expect(markup).toContain('当前还没有 Turn 历史')
    expect(markup).toContain('role="status"')
  })
})
