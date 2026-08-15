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
  it('passes only on exact equality', () => {
    expect(compareBackendVersion('0.1.0', '0.1.0')).toEqual({
      state: CompatibilityState.Compatible,
    })
  })

  it('reports unknown when the daemon never gave a version', () => {
    expect(compareBackendVersion('0.1.0', null)).toEqual({
      state: CompatibilityState.Unknown,
      expected: '0.1.0',
    })
    expect(compareBackendVersion('0.1.0', undefined)).toEqual({
      state: CompatibilityState.Unknown,
      expected: '0.1.0',
    })
  })

  it('treats an empty version string as unknown, not as a mismatch against ""', () => {
    // An older runtime.json writes "" for a present-but-unset field. Reporting
    // `incompatible: actual=""` would put an empty version in the user-facing
    // message and send them looking for a daemon that claims to be nothing.
    expect(compareBackendVersion('0.1.0', '')).toEqual({
      state: CompatibilityState.Unknown,
      expected: '0.1.0',
    })
  })

  it('reports an older daemon as incompatible', () => {
    expect(compareBackendVersion('0.1.0', '0.0.9')).toEqual({
      state: CompatibilityState.Incompatible,
      expected: '0.1.0',
      actual: '0.0.9',
    })
  })

  it('reports a NEWER daemon as incompatible too', () => {
    // Happens when the GUI is downgraded, or when a dev runs an old packaged
    // build against a freshly built daemon. Neither combination was shipped.
    expect(compareBackendVersion('0.1.0', '0.2.0')).toEqual({
      state: CompatibilityState.Incompatible,
      expected: '0.1.0',
      actual: '0.2.0',
    })
  })
})

describe('isCompatible', () => {
  it('is true only for the compatible verdict', () => {
    expect(isCompatible({ state: CompatibilityState.Compatible })).toBe(true)
    expect(isCompatible({ state: CompatibilityState.Unknown, expected: '1.0.0' })).toBe(false)
    expect(
      isCompatible({ state: CompatibilityState.Incompatible, expected: '1.0.0', actual: '0.9.0' }),
    ).toBe(false)
  })

  it('treats a null verdict as "gate not evaluated" and passes', () => {
    // Development builds have no packaged manifest; blocking them would make
    // `bun run dev` unusable before anyone has run a full build.
    expect(isCompatible(null)).toBe(true)
  })
})
