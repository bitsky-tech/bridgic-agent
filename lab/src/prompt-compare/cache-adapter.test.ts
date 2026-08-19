import { describe, expect, test } from 'bun:test'
import type { PromptCacheInvocationPotential } from '../analytics/cache-potential'
import type {
  PromptBlockComparison,
  PromptComparison,
  PromptSectionComparison,
  PromptToolSurfaceComparison,
} from './types'
import { buildPromptCacheComparisonViewModel } from './cache-adapter'

function section(
  status: PromptBlockComparison['status'],
  baselineText: string | null,
  currentText: string | null,
  currentTokens = 20,
): PromptSectionComparison {
  return {
    title: 'Section',
    status,
    baseline: baselineText === null ? null : {
      text: baselineText,
      characterCount: baselineText.length,
      estimatedTokenCount: 20,
      fidelity: 'reconstructed',
    },
    current: currentText === null ? null : {
      text: currentText,
      characterCount: currentText.length,
      estimatedTokenCount: currentTokens,
      fidelity: 'reconstructed',
    },
    beforeText: baselineText,
    afterText: currentText,
    characterDelta: (currentText?.length ?? 0) - (baselineText?.length ?? 0),
    estimatedTokenDelta: 0,
    commonPrefixCharacterCount: 0,
    commonSuffixCharacterCount: 0,
  }
}

function block(
  kind: PromptBlockComparison['kind'],
  status: PromptBlockComparison['status'],
  baselineText: string | null,
  currentText: string | null,
  currentTokens = 20,
): PromptBlockComparison {
  return {
    kind,
    order: 0,
    ...section(status, baselineText, currentText, currentTokens),
    title: kind,
  }
}

const toolSurface: PromptToolSurfaceComparison = {
  kind: 'tools',
  ...section('same', 'Stable tools', 'Stable tools'),
  title: 'tools',
}

const comparison: PromptComparison = {
  baseline: {
    sessionId: 'session-1',
    turnId: 'turn-1',
    roundId: 'round-1',
    roundIndex: 0,
    stage: 'main',
    model: 'gpt-5',
  },
  current: {
    sessionId: 'session-1',
    turnId: 'turn-2',
    roundId: 'round-2',
    roundIndex: 1,
    stage: 'main',
    model: 'gpt-5',
  },
  blocks: [
    block('persona', 'same', 'Stable persona', 'Stable persona', 30),
    block('context', 'changed', 'Old context', 'New context', 12),
    block('current_input', 'added', null, 'New task', 8),
  ],
  toolSurface,
  firstChangedBlock: 'context',
  changedBlockCount: 2,
  sameBlockCount: 1,
}

const baselineInvocation: PromptCacheInvocationPotential = {
  turnId: 'turn-1',
  roundId: 'round-1',
  roundIndex: 0,
  model: 'gpt-5',
  baselineTurnId: null,
  baselineRoundId: null,
  estimatedRequestTokens: 100,
  estimatedReusableTokens: 0,
  estimatedNonReusableTokens: 100,
  potentialRatio: 0,
  nonReusableRatio: 1,
  nonReusableSections: [{ section: 'persona', estimatedTokens: 100 }],
  firstDifference: null,
}

const currentInvocation: PromptCacheInvocationPotential = {
  turnId: 'turn-2',
  roundId: 'round-2',
  roundIndex: 1,
  model: 'gpt-5',
  baselineTurnId: 'turn-1',
  baselineRoundId: 'round-1',
  estimatedRequestTokens: 140,
  estimatedReusableTokens: 110,
  estimatedNonReusableTokens: 30,
  potentialRatio: 110 / 140,
  nonReusableRatio: 30 / 140,
  nonReusableSections: [
    { section: 'context', estimatedTokens: 9 },
    { section: 'context', estimatedTokens: 3 },
    { section: 'current_input', estimatedTokens: 18 },
  ],
  firstDifference: { section: 'context', messageIndex: 0 },
}

describe('buildPromptCacheComparisonViewModel', () => {
  test('joins identities, usage, statuses, and miss sections without localized text', () => {
    const resolverCalls: Array<[string, string, number]> = []
    const result = buildPromptCacheComparisonViewModel(
      comparison,
      currentInvocation,
      [baselineInvocation, currentInvocation],
      new Map([['turn-1', 0], ['turn-2', 1]]),
      (turnId, invocation, count) => {
        resolverCalls.push([turnId, invocation.roundId, count])
        return turnId === 'turn-1' ? 7 : 11
      },
    )

    expect(result.id).toBe('round-1->round-2')
    expect(result.baseline).toMatchObject({
      id: 'round-1',
      label: 'T1 · R1',
      turnOrdinal: 1,
      roundOrdinal: 1,
      inputTokens: 100,
      outputTokens: 7,
    })
    expect(result.current).toMatchObject({
      id: 'round-2',
      label: 'T2 · R2',
      turnOrdinal: 2,
      roundOrdinal: 2,
      inputTokens: 140,
      outputTokens: 11,
    })
    expect(resolverCalls).toEqual([
      ['turn-1', 'round-1', 1],
      ['turn-2', 'round-2', 1],
    ])
    expect(result).toMatchObject({
      hitTokens: 110,
      missTokens: 30,
      hitRate: 110 / 140,
      firstChangedBlockId: 'context',
    })
    expect(result.blocks.map((item) => [item.kind, item.status, item.hitTokens, item.missTokens])).toEqual([
      ['persona', 'unchanged', null, null],
      ['context', 'changed', null, 12],
      ['current_input', 'added', null, 18],
    ])
    expect(result.toolSurface).toMatchObject({
      id: 'tools',
      kind: 'tools',
      status: 'unchanged',
      baselineText: 'Stable tools',
      currentText: 'Stable tools',
      missTokens: null,
    })
  })

  test('keeps tool cache misses independent while retaining the first message change', () => {
    const result = buildPromptCacheComparisonViewModel(
      {
        ...comparison,
        toolSurface: {
          ...toolSurface,
          status: 'changed',
          current: {
            text: 'Changed tools',
            characterCount: 13,
            estimatedTokenCount: 4,
            fidelity: 'reconstructed',
          },
        },
      },
      {
        ...currentInvocation,
        nonReusableSections: [
          { section: 'tools', estimatedTokens: 6 },
          { section: 'persona', estimatedTokens: 24 },
        ],
        firstDifference: { section: 'tools', messageIndex: null },
      },
      [baselineInvocation, currentInvocation],
      new Map([['turn-1', 0], ['turn-2', 1]]),
      () => null,
    )

    expect(result.firstChangedBlockId).toBe('context')
    expect(result.toolSurface).toMatchObject({ status: 'changed', missTokens: 6 })
    expect(result.blocks.find((block) => block.kind === 'persona')?.missTokens).toBe(24)
  })

  test('takes the message change from the structural diff and leaves unresolved usage null', () => {
    const result = buildPromptCacheComparisonViewModel(
      comparison,
      { ...currentInvocation, firstDifference: { section: 'request_end', messageIndex: null } },
      [currentInvocation],
      new Map([['turn-2', 4]]),
      () => 99,
    )

    expect(result.firstChangedBlockId).toBe('context')
    expect(result.baseline).toMatchObject({
      label: 'T? · R1',
      turnOrdinal: null,
      inputTokens: null,
      outputTokens: null,
    })
    expect(result.current.label).toBe('T5 · R2')
  })
})
