import { describe, expect, test } from 'bun:test'

import type { PromptReconstruction } from '../api'
import { analyzePromptCachePotential } from './cache-potential'

function prompt(
  turnId: string,
  roundIndex: number,
  options: { model?: string; user?: string; tools?: string[]; history?: string[] } = {},
): PromptReconstruction {
  const model = options.model ?? 'gpt-test'
  const history = options.history ?? []
  const messages = [
    { role: 'system' as const, content: 'You are a careful agent.\n<context>workspace</context>' },
    ...history.map((content) => ({ role: 'assistant' as const, content })),
    { role: 'user' as const, content: options.user ?? 'Inspect the project.' },
  ]
  return {
    sessionId: 'session-1',
    turnId,
    roundId: `${turnId}:round:${roundIndex + 1}`,
    roundIndex,
    stage: 'main',
    model,
    messages,
    tools: (options.tools ?? ['read_file']).map((name) => ({
      name,
      description: `${name} description`,
      group: 'test',
      advanced: false,
      required: [],
      properties: [],
      parameters: {},
      schemaFidelity: 'lab_catalog',
    })),
    components: [
      { id: 'persona', kind: 'persona', label: 'Persona', content: 'You are a careful agent.', messageIndexes: [0], source: [], fidelity: 'reconstructed', limitations: [] },
      { id: 'context', kind: 'context', label: 'Context', content: '<context>workspace</context>', messageIndexes: [0], source: [], fidelity: 'reconstructed', limitations: [] },
      { id: 'history', kind: 'session_history', label: 'History', messageIndexes: history.map((_, index) => index + 1), source: [], fidelity: 'reconstructed', limitations: [] },
      { id: 'input', kind: 'current_input', label: 'Input', messageIndexes: [messages.length - 1], source: [], fidelity: 'reconstructed', limitations: [] },
      { id: 'turn', kind: 'current_turn', label: 'Turn', messageIndexes: [], source: [], fidelity: 'reconstructed', limitations: [] },
      { id: 'tools', kind: 'tools', label: 'Tools', messageIndexes: [], source: [], fidelity: 'reconstructed', limitations: [] },
    ],
    fidelity: { level: 'reconstructed', score: 1, exactComponents: 0, totalComponents: 6, limitations: [] },
    reconstructedAt: '2026-08-18T00:00:00Z',
  }
}

describe('prompt cache reuse potential', () => {
  test('treats the first same-model request as a cold start and reuses an unchanged prefix', () => {
    const result = analyzePromptCachePotential([
      prompt('turn-1', 0),
      prompt('turn-1', 1, { history: ['Tool result'] }),
    ])

    expect(result.observedCacheUsage).toBe(false)
    expect(result.invocations[0]).toMatchObject({
      baselineRoundId: null,
      estimatedReusableTokens: 0,
      potentialRatio: 0,
      nonReusableRatio: 1,
    })
    expect(result.invocations[0]?.estimatedNonReusableTokens).toBe(
      result.invocations[0]?.estimatedRequestTokens,
    )
    expect(result.invocations[0]?.nonReusableSections.map((section) => section.section)).toEqual([
      'tools',
      'persona',
      'context',
      'current_input',
    ])
    expect(result.invocations[1]?.baselineRoundId).toBe('turn-1:round:1')
    expect(result.invocations[1]?.estimatedReusableTokens).toBeGreaterThan(0)
    expect(result.invocations[1]?.firstDifference?.section).toBe('session_history')
    expect(result.invocations[1]?.nonReusableSections.map((section) => section.section)).toEqual([
      'session_history',
      'current_input',
    ])
  })

  test('does not compare requests across different model names', () => {
    const result = analyzePromptCachePotential([
      prompt('turn-1', 0, { model: 'model-a' }),
      prompt('turn-2', 0, { model: 'model-b' }),
    ])
    expect(result.invocations[1]?.baselineRoundId).toBeNull()
    expect(result.turns[1]?.potentialRatio).toBe(0)
  })

  test('treats a changed tool surface as an early prefix break', () => {
    const result = analyzePromptCachePotential([
      prompt('turn-1', 0, { tools: ['read_file'] }),
      prompt('turn-1', 1, { tools: ['read_file', 'write_file'] }),
    ])
    expect(result.invocations[1]?.firstDifference?.section).toBe('tools')
    expect(result.invocations[1]?.potentialRatio).toBeLessThan(0.35)
    expect(result.invocations[1]?.nonReusableSections[0]?.section).toBe('tools')
  })

  test('aggregates Turn potential as a ratio of token sums, including cold starts', () => {
    const result = analyzePromptCachePotential([
      prompt('turn-1', 0),
      prompt('turn-1', 1, { history: ['A'] }),
      prompt('turn-1', 2, { history: ['A', 'B'] }),
    ])
    const turn = result.turns[0]
    expect(turn?.totalInvocations).toBe(3)
    expect(turn?.comparableInvocations).toBe(2)
    expect(turn?.potentialRatio).toBeCloseTo(
      (turn?.estimatedReusableTokens ?? 0) / (turn?.estimatedRequestTokens ?? 1),
      10,
    )
    expect(turn?.nonReusableRatio).toBeCloseTo(1 - (turn?.potentialRatio ?? 0), 10)
  })

  test('keeps reusable and non-reusable token estimates strictly reconcilable', () => {
    const result = analyzePromptCachePotential([
      prompt('turn-1', 0),
      prompt('turn-1', 1, { history: ['A'] }),
      prompt('turn-2', 0, { tools: ['read_file', 'write_file'], user: '检查项目。' }),
    ])

    for (const invocation of result.invocations) {
      expect(invocation.estimatedNonReusableTokens).toBe(
        invocation.estimatedRequestTokens - invocation.estimatedReusableTokens,
      )
      expect(invocation.nonReusableSections.reduce(
        (sum, section) => sum + section.estimatedTokens,
        0,
      )).toBe(invocation.estimatedNonReusableTokens)
      expect(invocation.nonReusableRatio).toBeCloseTo(
        invocation.estimatedNonReusableTokens / invocation.estimatedRequestTokens,
        10,
      )
    }

    for (const turn of result.turns) {
      expect(turn.estimatedNonReusableTokens).toBe(
        turn.estimatedRequestTokens - turn.estimatedReusableTokens,
      )
      expect(turn.nonReusableSections.reduce(
        (sum, section) => sum + section.estimatedTokens,
        0,
      )).toBe(turn.estimatedNonReusableTokens)
    }
  })

  test('treats a byte-identical same-model request as fully reusable', () => {
    const result = analyzePromptCachePotential([
      prompt('turn-1', 0),
      prompt('turn-2', 0),
    ])
    expect(result.invocations[1]).toMatchObject({
      potentialRatio: 1,
      nonReusableRatio: 0,
      estimatedNonReusableTokens: 0,
      nonReusableSections: [],
      firstDifference: null,
    })
  })

  test('excludes opaque provider replay metadata from prompt cache estimates', () => {
    const baseline = prompt('turn-1', 0, { history: ['Tool result'] })
    const current = prompt('turn-2', 0, { history: ['Tool result'] })
    const baselineHistory = baseline.messages[1]
    const currentHistory = current.messages[1]
    if (!baselineHistory || !currentHistory) throw new Error('Expected history messages')

    baseline.messages[1] = {
      ...baselineHistory,
      extras: {
        reasoning_items: [{
          type: 'reasoning',
          encrypted_content: 'opaque-state-from-the-earlier-request',
        }],
      },
    }
    current.messages[1] = {
      ...currentHistory,
      extras: {
        reasoning_items: [{
          type: 'reasoning',
          encrypted_content: 'different-opaque-state-from-the-current-request',
        }],
      },
    }

    const result = analyzePromptCachePotential([baseline, current])

    expect(result.invocations[0]?.estimatedRequestTokens).toBe(
      result.invocations[1]?.estimatedRequestTokens,
    )
    expect(result.invocations[1]).toMatchObject({
      potentialRatio: 1,
      nonReusableRatio: 0,
      estimatedNonReusableTokens: 0,
      nonReusableSections: [],
      firstDifference: null,
    })
  })
})
