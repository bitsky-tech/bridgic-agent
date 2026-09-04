import { describe, expect, it } from 'bun:test'

import { calculateWordFitZoom } from '../wordZoom'

describe('calculateWordFitZoom', () => {
  it('leaves a readable gutter around a portrait page in a narrow dock', () => {
    expect(calculateWordFitZoom(740, { margins: 'normal', orientation: 'portrait', size: 'a4' })).toBe(75)
    expect(calculateWordFitZoom(830, { margins: 'normal', orientation: 'portrait', size: 'a4' })).toBe(85)
  })

  it('uses the oriented paper width and never enlarges beyond 100 percent', () => {
    expect(calculateWordFitZoom(740, { margins: 'normal', orientation: 'landscape', size: 'a4' })).toBe(50)
    expect(calculateWordFitZoom(1400, { margins: 'normal', orientation: 'portrait', size: 'letter' })).toBe(100)
  })
})
