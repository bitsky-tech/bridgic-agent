import { describe, expect, it } from 'bun:test'
import { buildPresentationTextRevealFrames } from '../presentationAgentTransition'

describe('PowerPoint Agent visual transitions', () => {
  it('reveals short text progressively and preserves the exact final value', () => {
    expect(buildPresentationTextRevealFrames('增长 24%')).toEqual([
      '增',
      '增长',
      '增长 ',
      '增长 2',
      '增长 24',
      '增长 24%',
    ])
  })

  it('bounds long text to the requested frame budget', () => {
    const text = 'A'.repeat(100)
    const frames = buildPresentationTextRevealFrames(text, 10)
    expect(frames).toHaveLength(10)
    expect(frames.at(-1)).toBe(text)
  })
})
