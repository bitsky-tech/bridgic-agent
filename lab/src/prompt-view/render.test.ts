import { describe, expect, test } from 'bun:test'
import type {
  PromptComponent,
  PromptComponentKind,
  PromptReconstruction,
} from '../api/types'
import type {
  PromptReadableBlock as ComponentBlock,
  PromptReadableMessage as ComponentMessage,
} from '../components/PromptReadableView'
import {
  PROMPT_BLOCK_ORDER,
  buildPromptViewModel,
  promptMessagesWithoutProviderMetadata,
  renderPromptTranscript,
} from './render'

const ENCRYPTED_CONTENT_SENTINEL = 'encrypted-provider-state-must-not-be-visible'

function component(
  kind: PromptComponentKind,
  messageIndexes: number[],
  content?: string,
): PromptComponent {
  return {
    id: `component-${kind}`,
    kind,
    label: `Original ${kind}`,
    ...(content === undefined ? {} : { content }),
    messageIndexes,
    source: [`source.${kind}`],
    fidelity: kind === 'context' ? 'partial' : 'reconstructed',
    limitations: kind === 'context' ? ['Historical browser tabs are unavailable.'] : [],
  }
}

function prompt(): PromptReconstruction {
  return {
    sessionId: 'session-1',
    turnId: 'turn-2',
    roundId: 'turn-2:round:2',
    roundIndex: 1,
    stage: 'main',
    model: 'gpt-5',
    messages: [
      { role: 'system', content: 'PERSONA TEXT\n\nCONTEXT TEXT' },
      { role: 'user', content: 'Read the old file.' },
      {
        role: 'assistant',
        content: 'I will read it.',
        toolCalls: [{ id: 'history-call', name: 'read_file', arguments: { file_path: 'old.txt' } }],
      },
      { role: 'tool', content: 'old contents', toolCallId: 'history-call' },
      { role: 'assistant', content: 'The old file says hello.' },
      { role: 'user', content: 'Now inspect README.\n\n<current_time>\n2026-08-18\n</current_time>' },
      {
        role: 'assistant',
        content: 'Inspecting README.',
        toolCalls: [{
          id: 'current-call',
          name: 'read_file',
          arguments: { file_path: 'README.md', line_range: [1, 40] },
        }],
        extras: {
          reasoning_items: [{
            type: 'reasoning',
            encrypted_content: ENCRYPTED_CONTENT_SENTINEL,
          }],
          reasoning_content: '',
        },
      },
      { role: 'tool', content: '# Project', toolCallId: 'current-call' },
    ],
    tools: [{
      name: 'read_file',
      description: 'Read a text file.',
      group: 'workspace',
      advanced: false,
      required: ['file_path'],
      properties: ['file_path', 'line_range'],
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          line_range: { type: 'array' },
        },
      },
      schemaFidelity: 'lab_catalog',
    }],
    components: [
      component('tools', []),
      component('current_turn', [6, 7]),
      component('context', [0], 'CONTEXT TEXT'),
      component('persona', [0], 'PERSONA TEXT'),
      component('current_input', [5], 'Now inspect README.'),
      component('session_history', [1, 2, 3, 4]),
    ],
    fidelity: {
      level: 'partial',
      score: 0.82,
      exactComponents: 0,
      totalComponents: 6,
      limitations: ['Historical browser tabs are unavailable.'],
    },
    reconstructedAt: '2026-08-18T02:00:00Z',
  }
}

describe('Prompt readable blocks', () => {
  test('always emits the canonical assembly order with fidelity, sources, and localized titles', () => {
    const view = buildPromptViewModel(prompt(), {
      blockTitles: { persona: '角色', tools: '工具面' },
    })
    const componentBlocks: readonly ComponentBlock[] = view.blocks
    const componentMessages: readonly ComponentMessage[] = view.transcript.messages

    expect(view.blocks.map((block) => block.kind)).toEqual([...PROMPT_BLOCK_ORDER])
    expect(componentBlocks).toHaveLength(6)
    expect(componentMessages).toHaveLength(8)
    expect(view.blocks.map((block) => block.title)).toEqual([
      '角色',
      'Context',
      'Session history',
      'Current input',
      'Current turn',
      '工具面',
    ])
    expect(view.blocks[1]).toMatchObject({
      fidelity: 'partial',
      sources: ['source.context'],
      text: 'CONTEXT TEXT',
    })
    expect(view.blocks[5]?.text).toContain('1. read_file')
    expect(view.blocks[5]?.text).toContain('required: file_path')
  })

  test('renders the history component from only its native message indexes', () => {
    const reconstruction = prompt()
    const historyComponent = reconstruction.components.find((item) => item.kind === 'session_history')
    if (historyComponent) {
      historyComponent.metadata = {
        compactionApplied: true,
        compactedTurns: 2,
        includedTurns: 1,
      }
    }
    const view = buildPromptViewModel(reconstruction)
    const history = view.blocks.find((block) => block.kind === 'session_history')

    expect(history?.text).toContain('USER · message 2\nRead the old file.')
    expect(history?.text).toContain('ASSISTANT · message 3')
    expect(history?.text).toContain('id: history-call')
    expect(history?.text).toContain('TOOL · message 4\ntool call id: history-call\nold contents')
    expect(history?.text).toContain('The old file says hello.')
    expect(history?.text).not.toContain('Now inspect README.')
    expect(history?.text).not.toContain('current-call')
    expect(history?.metadata).toEqual({
      compactionApplied: true,
      compactedTurns: 2,
      includedTurns: 1,
    })
  })
})

describe('native message transcript', () => {
  test('renders assistant tool calls and paired tool results as readable prose instead of JSON', () => {
    const transcript = renderPromptTranscript(prompt().messages)

    expect(transcript.text).toContain('ASSISTANT · message 7\nInspecting README.')
    expect(transcript.text).toContain('1. read_file\n     id: current-call')
    expect(transcript.text).toContain('file_path: README.md')
    expect(transcript.text).toContain('line_range:\n           - 1\n           - 40')
    expect(transcript.text).toContain('TOOL · message 8\ntool call id: current-call\n# Project')
    expect(transcript.text).not.toContain('"role": "assistant"')
    expect(transcript.text).not.toContain('provider replay metadata')
    expect(transcript.text).not.toContain('encrypted_content')
    expect(transcript.text).not.toContain(ENCRYPTED_CONTENT_SENTINEL)
    expect(transcript.messages[6]?.extras).toBeNull()
  })

  test('creates an export-safe message projection without mutating persisted provider metadata', () => {
    const source = prompt().messages
    const projected = promptMessagesWithoutProviderMetadata(source)

    expect(projected[6]).not.toHaveProperty('extras')
    expect(JSON.stringify(projected)).not.toContain('encrypted_content')
    expect(JSON.stringify(projected)).not.toContain(ENCRYPTED_CONTENT_SENTINEL)
    expect(source[6]?.extras).toMatchObject({
      reasoning_items: [{ encrypted_content: ENCRYPTED_CONTENT_SENTINEL }],
    })
  })

  test('provides one complete document containing messages, tools, and component provenance', () => {
    const view = buildPromptViewModel(prompt())

    expect(view.assembledText).toContain('BRIDGIC AGENT PROMPT REQUEST')
    expect(view.assembledText).toContain('NATIVE MESSAGES\n\nSYSTEM · message 1')
    expect(view.assembledText).toContain('TOOL DEFINITIONS\n\n1. read_file')
    expect(view.assembledText).toContain('COMPONENT PROVENANCE')
    expect(view.assembledText).toContain('kind: session_history')
    expect(view.assembledText).toContain('sources: source.session_history')
    expect(view.assembledText).not.toContain('encrypted_content')
    expect(view.assembledText).not.toContain(ENCRYPTED_CONTENT_SENTINEL)
    expect(view.blocks.find((block) => block.kind === 'current_turn')?.text)
      .not.toContain(ENCRYPTED_CONTENT_SENTINEL)
  })
})
