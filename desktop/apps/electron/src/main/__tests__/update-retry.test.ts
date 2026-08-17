import { describe, expect, it } from 'bun:test'
import { isRetriableUpdateError, retryDelayMs } from '../update-retry'

describe('deciding whether an update failure is worth retrying', () => {
  it('gives up on a feed that has no build for this architecture', () => {
    // Retrying cannot conjure an artifact the release never contained; Intel
    // machines hit exactly this before the arm64/x64 feeds were merged.
    expect(isRetriableUpdateError('ERR_UPDATER_ZIP_FILE_NOT_FOUND')).toBe(false)
    expect(isRetriableUpdateError('ERR_UPDATER_ASSET_NOT_FOUND')).toBe(false)
  })

  it('gives up on a rejected signature rather than hammering the feed', () => {
    expect(isRetriableUpdateError('ERR_UPDATER_INVALID_SIGNATURE')).toBe(false)
  })

  it('gives up on a misconfigured provider', () => {
    expect(isRetriableUpdateError('ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION')).toBe(false)
    expect(isRetriableUpdateError('ERR_UPDATER_UNSUPPORTED_PROVIDER')).toBe(false)
  })

  it('retries a bare network failure, which carries no code at all', () => {
    // The case this whole ladder exists for: a laptop that slept or changed
    // network mid-download. electron-updater surfaces those without a `code`.
    expect(isRetriableUpdateError(undefined)).toBe(true)
  })

  it('retries a corrupted download', () => {
    // A checksum mismatch means the bytes arrived wrong, not that the release
    // is wrong -- refetching is exactly the right response.
    expect(isRetriableUpdateError('ERR_CHECKSUM_MISMATCH')).toBe(true)
  })

  it('retries an unrecognised code instead of going silent for four hours', () => {
    // Unknown reasons are treated as transient on purpose: a missed retry costs
    // the user a long wait, while a pointless one costs a bounded handful of
    // requests.
    expect(isRetriableUpdateError('ERR_SOMETHING_NOBODY_HAS_SEEN_YET')).toBe(true)
  })

  it('retries a feed that is momentarily unreachable', () => {
    // A CDN blip and a permanently wrong URL are indistinguishable here, and
    // the blip is far more common.
    expect(isRetriableUpdateError('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')).toBe(true)
  })
})

describe('spacing out update retries', () => {
  it('starts within a minute rather than at the next four-hourly tick', () => {
    expect(retryDelayMs(0)).toBe(60_000)
  })

  it('backs off geometrically so a persistent outage is not hammered', () => {
    const ladder = [0, 1, 2, 3].map(retryDelayMs)

    expect(ladder).toEqual([60_000, 120_000, 240_000, 480_000])
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!)
    }
  })

  it('stops rather than retrying forever', () => {
    // Past the ladder the regular timer takes over again. Without this the app
    // would keep a retry loop alive for its whole tray-resident lifetime.
    expect(retryDelayMs(4)).toBeNull()
    expect(retryDelayMs(99)).toBeNull()
  })

  it('spends less than the regular check interval on the whole ladder', () => {
    // Otherwise the retries would outlive the 4h tick they are meant to bridge,
    // and the two schedules would start racing each other.
    let total = 0
    for (let attempt = 0; ; attempt++) {
      const delay = retryDelayMs(attempt)
      if (delay === null) break
      total += delay
    }

    expect(total).toBeLessThan(4 * 60 * 60 * 1000)
  })
})
