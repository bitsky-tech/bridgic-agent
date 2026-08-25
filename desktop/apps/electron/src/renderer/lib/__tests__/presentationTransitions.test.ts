import { describe, expect, it } from 'bun:test'
import {
  changePresentationTransitionEffect,
  createDefaultPresentationTransition,
  getPresentationTransitionDefinition,
  normalizePresentationTransition,
  presentationTransitionDefinitions,
} from '../presentationTransitions'

describe('presentation transitions', () => {
  it('registers every supported effect with its label and direction options', () => {
    expect(presentationTransitionDefinitions.map((definition) => definition.effect)).toEqual([
      'none',
      'cut',
      'fade',
      'push',
      'wipe',
      'reveal',
      'cover',
      'zoom',
      'flip',
      'cube',
    ])
    expect(getPresentationTransitionDefinition('push')).toMatchObject({
      labelKey: 'session.presentation.effectPush',
      directions: ['left', 'right', 'up', 'down'],
      defaultDirection: 'left',
    })
    expect(getPresentationTransitionDefinition('zoom')).toMatchObject({
      directions: ['in', 'out'],
      defaultDirection: 'in',
    })
    expect(getPresentationTransitionDefinition('reveal')).toMatchObject({
      directions: ['left', 'right'],
      supportsThroughBlack: true,
    })
    expect(getPresentationTransitionDefinition('flip').directions).toEqual(['left', 'right'])
  })

  it('creates and normalizes transitions into complete safe values', () => {
    expect(createDefaultPresentationTransition()).toEqual({ effect: 'none', durationMs: 1_000 })
    expect(normalizePresentationTransition('push')).toEqual({ effect: 'push', durationMs: 1_000, direction: 'left' })
    expect(normalizePresentationTransition({ effect: 'wipe', durationMs: 49, direction: 'right' })).toEqual({
      effect: 'wipe',
      durationMs: 100,
      direction: 'right',
    })
    expect(normalizePresentationTransition({ effect: 'zoom', durationMs: 40_000, direction: 'left' })).toEqual({
      effect: 'zoom',
      durationMs: 20_000,
      direction: 'in',
    })
    expect(normalizePresentationTransition({ effect: 'cut', durationMs: 750.4, throughBlack: true })).toEqual({
      effect: 'cut',
      durationMs: 750,
      throughBlack: true,
    })
  })

  it('preserves duration while changing effects and resets incompatible options', () => {
    expect(changePresentationTransitionEffect(undefined, 'fade')).toEqual({
      effect: 'fade',
      durationMs: 1_000,
    })
    expect(changePresentationTransitionEffect({
      effect: 'push',
      durationMs: 1_250,
      direction: 'right',
    }, 'wipe')).toEqual({
      effect: 'wipe',
      durationMs: 1_250,
      direction: 'right',
    })
    expect(changePresentationTransitionEffect({
      effect: 'fade',
      durationMs: 800,
      throughBlack: true,
    }, 'zoom')).toEqual({
      effect: 'zoom',
      durationMs: 800,
      direction: 'in',
    })
  })
})
