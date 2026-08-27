import { describe, expect, it } from 'bun:test'
import {
  presentationCharacterSpacingFromPoints,
  presentationCharacterSpacingToPoints,
  presentationFontSizeFromPoints,
  presentationFontSizeToPoints,
  presentationRenderingFontFamily,
  shouldSplitPresentationTextByGrapheme,
} from '../presentationText'

describe('presentation text rendering', () => {
  it('wraps CJK text by grapheme without changing Latin word wrapping', () => {
    expect(shouldSplitPresentationTextByGrapheme('佛教从印度传播到中国')).toBe(true)
    expect(shouldSplitPresentationTextByGrapheme('Buddhism spread across Asia')).toBe(false)
    expect(shouldSplitPresentationTextByGrapheme('佛教从印度传播到中国', false)).toBe(false)
  })

  it('adds script-appropriate fallbacks without changing the stored font name', () => {
    expect(presentationRenderingFontFamily('思源黑体', '佛教历史')).toContain('PingFang SC')
    expect(presentationRenderingFontFamily('思源宋体', '佛教历史')).toContain('Songti SC')
    expect(presentationRenderingFontFamily('思源黑体', '01')).toContain('PingFang SC')
    expect(presentationRenderingFontFamily('思源宋体', 'CONTENTS')).toContain('Songti SC')
    expect(presentationRenderingFontFamily('Aptos', 'Buddhist History')).toBe('Aptos, "Helvetica Neue", Arial, sans-serif')
  })

  it('converts PowerPoint point metrics into browser and Fabric units without losing tracking', () => {
    expect(presentationFontSizeFromPoints(45)).toBe(60)
    expect(presentationFontSizeToPoints(60)).toBe(45)
    const tracking = presentationCharacterSpacingFromPoints(4.5, 10.5)
    expect(tracking).toBeCloseTo(428.571, 3)
    expect(presentationCharacterSpacingToPoints(tracking, 10.5)).toBeCloseTo(4.5, 6)
  })
})
