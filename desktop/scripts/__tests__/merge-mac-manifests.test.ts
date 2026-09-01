/**
 * merge-mac-manifests combines each architecture's latest-mac.yml into one multi-architecture feed.
 *
 * These tests cover malformed merges that would permanently prevent one architecture
 * from updating:
 *  - both architectures must be present in files (the key Intel parity assertion);
 *  - mismatched versions must fail instead of choosing one;
 *  - arm64 must be present because it is the primary platform;
 *  - legacy path/sha512 fields must point to arm64 because older clients read only them.
 *
 * Client-side selection is an electron-updater concern (MacUpdater.js branches on
 * whether the URL contains `arm64`). This test only guarantees a valid input manifest.
 */
import { describe, expect, it } from 'bun:test'
import { isArm64Entry, mergeMacManifests, type MacManifest } from '../merge-mac-manifests'

/** Based on a real 0.1.9 manifest, with sha512 values shortened. */
const ARM64: MacManifest = {
  version: '0.1.9',
  files: [{ url: 'Bridgic-Agent-0.1.9-arm64.zip', sha512: 'AAAAarm64==', size: 232493718 }],
  path: 'Bridgic-Agent-0.1.9-arm64.zip',
  sha512: 'AAAAarm64==',
  releaseDate: '2026-08-11T15:45:00.000Z',
}

const X64: MacManifest = {
  version: '0.1.9',
  files: [{ url: 'Bridgic-Agent-0.1.9-x64.zip', sha512: 'BBBBx64==', size: 240000000 }],
  path: 'Bridgic-Agent-0.1.9-x64.zip',
  sha512: 'BBBBx64==',
  releaseDate: '2026-08-11T16:10:00.000Z',
}

describe('isArm64Entry', () => {
  it('mirrors the client-side substring test', () => {
    // MacUpdater uses this exact check: whether the URL contains `arm64`.
    expect(isArm64Entry(ARM64.files[0]!)).toBe(true)
    expect(isArm64Entry(X64.files[0]!)).toBe(false)
  })
})

describe('mergeMacManifests', () => {
  it('keeps both architectures so each machine can find its own build', () => {
    const merged = mergeMacManifests([ARM64, X64])

    expect(merged.files).toHaveLength(2)
    expect(merged.files.filter(isArm64Entry)).toHaveLength(1)
    // Intel can update only when something remains after arm64 entries are filtered out.
    expect(merged.files.filter((f) => !isArm64Entry(f))).toHaveLength(1)
  })

  it('is order-independent', () => {
    const a = mergeMacManifests([ARM64, X64])
    const b = mergeMacManifests([X64, ARM64])
    expect(new Set(a.files.map((f) => f.url))).toEqual(new Set(b.files.map((f) => f.url)))
  })

  it('points legacy path/sha512 at arm64 even when x64 comes first', () => {
    // Older clients ignore files and read only these fallback fields in Provider.js::getFileList.
    const merged = mergeMacManifests([X64, ARM64])
    expect(merged.path).toBe('Bridgic-Agent-0.1.9-arm64.zip')
    expect(merged.sha512).toBe('AAAAarm64==')
  })

  it('refuses to merge builds of different versions', () => {
    // Mismatched versions mean the two jobs did not build the same commit. Choosing one
    // gives half the users a package whose manifest disagrees with the backend and traps them at the version gate.
    expect(() => mergeMacManifests([ARM64, { ...X64, version: '0.2.0' }])).toThrow(/version mismatch/)
  })

  it('refuses a feed with no arm64 build', () => {
    expect(() => mergeMacManifests([X64])).toThrow(/no arm64 entry/)
  })

  it('drops duplicate urls', () => {
    const merged = mergeMacManifests([ARM64, ARM64, X64])
    expect(merged.files).toHaveLength(2)
  })

  it('takes the newest releaseDate so a retried job never moves the feed backwards', () => {
    expect(mergeMacManifests([ARM64, X64]).releaseDate).toBe('2026-08-11T16:10:00.000Z')
  })

  it('rejects an empty input list', () => {
    expect(() => mergeMacManifests([])).toThrow(/no manifests/)
  })
})
