import { expect, test } from 'bun:test'
import { getPresentationTrace } from './presentation-trace-data'
import { presentationResponseSnapshot, presentationResponseSnapshotSource } from './presentation-response-snapshot'

test('historical response fields survive fixture assembly without translation or empty-value substitution', () => {
  expect(presentationResponseSnapshotSource.outputField).toBe('think_result.step_content')
  expect(presentationResponseSnapshotSource.thinkingField).toBe('reasoning_content')
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const { rounds } = getPresentationTrace(locale)
    expect(rounds.map(round => round.id)).toEqual(Object.keys(presentationResponseSnapshot))
    expect(rounds.filter(round => round.output?.length)).toHaveLength(5)
    expect(rounds.filter(round => round.output === '')).toHaveLength(5)
    expect(rounds.filter(round => round.thinking?.length)).toHaveLength(8)
    for (const round of rounds) {
      const snapshot = presentationResponseSnapshot[round.id]!
      expect(round.output).toBe(snapshot.output)
      expect(round.thinking).toBe(snapshot.thinking)
      expect(round.outputFidelity).toBe('recorded')
      expect(round.thinkingFidelity).toBe(snapshot.thinkingFidelity)
      expect(round.inspectionSource).toBe('example')
      expect(round.metrics?.source).toBe('example')
    }
    expect(rounds[1]!.output).toBe('为避免内容深度与表达方式不匹配，我需要先确定这套讲解的听众和使用场景。')
    expect(rounds[1]!.thinking).toBe('**Planning brief questions**')
    expect(rounds[0]!.thinking).toBeNull()
  }
})
