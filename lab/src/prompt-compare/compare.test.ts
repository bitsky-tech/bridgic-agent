import { describe, expect, test } from 'bun:test'
import type {
  PromptComponent,
  PromptComponentKind,
  PromptReconstruction,
  PromptToolSummary,
} from '../api/types'
import { comparePromptReconstructions, estimatePromptTextTokens } from './compare'

const messageBlockOrder = [
  'persona',
  'context',
  'session_history',
  'current_input',
  'current_turn',
] as const

const tools: PromptToolSummary[] = [{
  name: 'read_file',
  description: 'Read a file.',
  group: 'workspace',
  advanced: false,
  required: ['path'],
  properties: ['path'],
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  schemaFidelity: 'lab_catalog',
}]

function component(kind: PromptComponentKind, content?: string): PromptComponent {
  return {
    id: kind,
    kind,
    label: kind,
    ...(content === undefined ? {} : { content }),
    messageIndexes: [],
    source: [],
    fidelity: 'reconstructed',
    limitations: [],
  }
}

function prompt(overrides: {
  roundId?: string
  roundIndex?: number
  persona?: string
  context?: string
  sessionHistory?: string
  currentInput?: string
  currentTurn?: string
  tools?: PromptToolSummary[]
  omit?: PromptComponentKind
} = {}): PromptReconstruction {
  const texts: Array<[PromptComponentKind, string | undefined]> = [
    ['persona', overrides.persona ?? 'Stable persona'],
    ['context', overrides.context ?? 'Stable context'],
    ['session_history', overrides.sessionHistory ?? 'Stable history'],
    ['current_input', overrides.currentInput ?? 'Current task'],
    ['current_turn', overrides.currentTurn ?? 'Round history'],
    ['tools', undefined],
  ]
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    roundId: overrides.roundId ?? 'round-1',
    roundIndex: overrides.roundIndex ?? 0,
    stage: 'main',
    model: 'gpt-5',
    messages: [],
    tools: overrides.tools ?? tools,
    components: texts
      .filter(([kind]) => kind !== overrides.omit)
      .map(([kind, content]) => component(kind, content)),
    fidelity: {
      level: 'reconstructed',
      score: 1,
      exactComponents: 0,
      totalComponents: 6,
      limitations: [],
    },
    reconstructedAt: '2026-08-18T00:00:00Z',
  }
}

describe('comparePromptReconstructions', () => {
  test('aligns the ordered message blocks and reports an unchanged request surface', () => {
    const result = comparePromptReconstructions(prompt(), prompt({ roundId: 'round-2', roundIndex: 1 }))

    expect(result.blocks.map((block) => block.kind)).toEqual([...messageBlockOrder])
    expect(result.blocks.every((block) => block.status === 'same')).toBe(true)
    expect(result.toolSurface.status).toBe('same')
    expect(result.firstChangedBlock).toBeNull()
    expect(result.changedBlockCount).toBe(0)
    expect(result.sameBlockCount).toBe(5)
    expect(result.baseline.roundId).toBe('round-1')
    expect(result.current.roundId).toBe('round-2')
  })

  test('finds the first changed block and returns exact counts plus concise excerpts', () => {
    const sharedPrefix = 'A'.repeat(300)
    const baseline = prompt({ context: `${sharedPrefix} before`, currentInput: 'Old task' })
    const current = prompt({ context: `${sharedPrefix} after`, currentInput: 'New task' })
    const result = comparePromptReconstructions(baseline, current, { excerptCharacterLimit: 60 })
    const context = result.blocks.find((block) => block.kind === 'context')

    expect(result.firstChangedBlock).toBe('context')
    expect(result.changedBlockCount).toBe(2)
    expect(context?.status).toBe('changed')
    expect(context?.commonPrefixCharacterCount).toBe(301)
    expect(context?.beforeText?.length).toBeLessThanOrEqual(62)
    expect(context?.beforeText).toContain('before')
    expect(context?.afterText).toContain('after')
    expect(context?.baseline?.characterCount).toBe(`${sharedPrefix} before`.length)
    expect(context?.current?.characterCount).toBe(`${sharedPrefix} after`.length)
    expect(context?.characterDelta).toBe(-1)
  })

  test('distinguishes added and removed components without counting placeholder text', () => {
    const added = comparePromptReconstructions(
      prompt({ omit: 'session_history' }),
      prompt(),
    ).blocks.find((block) => block.kind === 'session_history')
    const removed = comparePromptReconstructions(
      prompt(),
      prompt({ omit: 'current_turn' }),
    ).blocks.find((block) => block.kind === 'current_turn')

    expect(added).toMatchObject({ status: 'added', baseline: null })
    expect(added?.current?.text).toBe('Stable history')
    expect(added?.beforeText).toBeNull()
    expect(removed).toMatchObject({ status: 'removed', current: null })
    expect(removed?.baseline?.text).toBe('Round history')
    expect(removed?.afterText).toBeNull()
    expect(removed?.characterDelta).toBe(-'Round history'.length)
  })

  test('compares tool definitions as a parallel surface, not an ordered message block', () => {
    const currentTools = [{ ...tools[0]!, description: 'Read one text file from disk.' }]
    const result = comparePromptReconstructions(prompt(), prompt({ tools: currentTools }))

    expect(result.blocks.map((block) => block.kind)).toEqual([...messageBlockOrder])
    expect(result.firstChangedBlock).toBeNull()
    expect(result.changedBlockCount).toBe(0)
    expect(result.sameBlockCount).toBe(5)
    expect(result.toolSurface.status).toBe('changed')
    expect(result.toolSurface.beforeText).toContain('Read a file.')
    expect(result.toolSurface.afterText).toContain('Read one text file from disk.')
    expect(result.toolSurface.baseline?.estimatedTokenCount).toBeGreaterThan(0)
  })

  test('reads the tool surface from the top-level request even without component metadata', () => {
    const result = comparePromptReconstructions(
      prompt({ omit: 'tools' }),
      prompt({ roundId: 'round-2', roundIndex: 1 }),
    )

    expect(result.toolSurface.status).toBe('same')
    expect(result.toolSurface.baseline?.text).toContain('read_file')
    expect(result.toolSurface.current?.text).toContain('read_file')
    expect(result.blocks).toHaveLength(5)
  })

  test('ignores opaque provider replay metadata in the readable Prompt comparison', () => {
    const baseline = prompt()
    const current = prompt({ roundId: 'round-2', roundIndex: 1 })
    baseline.messages = [{
      role: 'assistant',
      content: 'Stable assistant message',
      extras: {
        reasoning_items: [{
          type: 'reasoning',
          encrypted_content: 'baseline-encrypted-provider-state',
        }],
      },
    }]
    current.messages = [{
      role: 'assistant',
      content: 'Stable assistant message',
      extras: {
        reasoning_items: [{
          type: 'reasoning',
          encrypted_content: 'different-encrypted-provider-state',
        }],
      },
    }]
    baseline.components = baseline.components.map((item) => (
      item.kind === 'current_turn' ? { ...item, messageIndexes: [0] } : item
    ))
    current.components = current.components.map((item) => (
      item.kind === 'current_turn' ? { ...item, messageIndexes: [0] } : item
    ))

    const result = comparePromptReconstructions(baseline, current)
    const currentTurn = result.blocks.find((block) => block.kind === 'current_turn')

    expect(currentTurn?.status).toBe('same')
    expect(currentTurn?.baseline?.text).toContain('Stable assistant message')
    expect(currentTurn?.baseline?.text).not.toContain('encrypted_content')
    expect(currentTurn?.current?.text).not.toContain('different-encrypted-provider-state')
    expect(result.changedBlockCount).toBe(0)
  })
})

describe('estimatePromptTextTokens', () => {
  test('uses UTF-8 bytes and handles empty text without a synthetic token', () => {
    expect(estimatePromptTextTokens('')).toBe(0)
    expect(estimatePromptTextTokens('abcd')).toBe(1)
    expect(estimatePromptTextTokens('你好')).toBe(2)
  })
})
