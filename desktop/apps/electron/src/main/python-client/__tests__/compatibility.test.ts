/**
 * Tests for compatibility.ts — the GUI/daemon version policy.
 *
 * Covers:
 *  - exact equality is the only pass in P0
 *  - a daemon that reports no version is `unknown`, NOT a pass
 *  - empty string is treated as "no version", not as a mismatch against ""
 *  - both directions of drift (older AND newer daemon) are incompatible
 *  - isCompatible()'s null (= gate not evaluated) escape hatch
 */
import { describe, expect, it } from 'bun:test'
import { CompatibilityState, compareBackendVersion, isCompatible } from '../compatibility'

describe('compareBackendVersion', () => {
  it('distinguishes exact, missing, older, and newer versions', () => {
    expect(compareBackendVersion('0.1.0', '0.1.0')).toEqual({
      state: CompatibilityState.Compatible,
    })
    // An older runtime.json writes "" for a present-but-unset field. Reporting
    // `incompatible: actual=""` would put an empty version in the user-facing
    // message and send them looking for a daemon that claims to be nothing.
    for (const missing of [null, undefined, '']) {
      expect(compareBackendVersion('0.1.0', missing)).toEqual({
        state: CompatibilityState.Unknown,
        expected: '0.1.0',
      })
    }

    // Happens when the GUI is downgraded, or when a dev runs an old packaged
    // build against a freshly built daemon. Neither combination was shipped.
    for (const actual of ['0.0.9', '0.2.0']) {
      expect(compareBackendVersion('0.1.0', actual)).toEqual({
        state: CompatibilityState.Incompatible,
        expected: '0.1.0',
        actual,
      })
    }
  })
})

describe('isCompatible', () => {
  it('passes compatible and unevaluated verdicts only', () => {
    expect(isCompatible({ state: CompatibilityState.Compatible })).toBe(true)
    expect(isCompatible({ state: CompatibilityState.Unknown, expected: '1.0.0' })).toBe(false)
    expect(
      isCompatible({ state: CompatibilityState.Incompatible, expected: '1.0.0', actual: '0.9.0' }),
    ).toBe(false)
    // Development builds have no packaged manifest; blocking them would make
    // `bun run dev` unusable before anyone has run a full build.
    expect(isCompatible(null)).toBe(true)
  })
})
