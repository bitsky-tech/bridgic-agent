import { describe, expect, it } from 'bun:test'
import { updateCheckBlockedBy, type UpdateCheckState } from '../update-guards'

function state(overrides: Partial<UpdateCheckState> = {}): UpdateCheckState {
  return {
    updaterEnabled: true,
    checkInFlight: false,
    hasStagedUpdate: false,
    handoverStarted: false,
    ...overrides,
  }
}

describe('deciding whether an update check may start', () => {
  it('returns the blocking reason with stable precedence', () => {
    expect(updateCheckBlockedBy(state())).toBeNull()
    expect(updateCheckBlockedBy(state({ updaterEnabled: false }))).toBe('disabled')
    expect(updateCheckBlockedBy(state({ checkInFlight: true }))).toBe('busy')
    expect(updateCheckBlockedBy(state({ hasStagedUpdate: true }))).toBe('staged')

    // The scenario this exists for: on macOS the handover runs
    // `nativeUpdater.checkForUpdates()`, and Squirrel spends up to four minutes
    // re-fetching the archive through a loopback proxy this process owns. Any
    // error it raises arrives as a normal `error` event, which clears
    // `stagedUpdate` and arms a retry -- so 60s later a fresh round would
    // complete a download whose `updateDownloaded()` closes that proxy out from
    // under Squirrel (MacUpdater.js:124).
    expect(updateCheckBlockedBy(state({ handoverStarted: true }))).toBe('busy')

    // A build with no feed cannot be "busy": saying so would send Settings
    // looking for a round that does not exist.
    expect(
      updateCheckBlockedBy(
        state({ updaterEnabled: false, handoverStarted: true, checkInFlight: true }),
      ),
    ).toBe('disabled')
  })
})
