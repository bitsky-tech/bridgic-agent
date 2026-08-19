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
  it('runs when nothing is in the way', () => {
    expect(updateCheckBlockedBy(state())).toBeNull()
  })

  it('reports a disabled build rather than silently doing nothing', () => {
    expect(updateCheckBlockedBy(state({ updaterEnabled: false }))).toBe('disabled')
  })

  it('refuses while a round is still open', () => {
    expect(updateCheckBlockedBy(state({ checkInFlight: true }))).toBe('busy')
  })

  it('refuses once something is staged, so it is not downloaded twice', () => {
    expect(updateCheckBlockedBy(state({ hasStagedUpdate: true }))).toBe('staged')
  })

  it('refuses during the installer handover', () => {
    // The scenario this exists for: on macOS the handover runs
    // `nativeUpdater.checkForUpdates()`, and Squirrel spends up to four minutes
    // re-fetching the archive through a loopback proxy this process owns. Any
    // error it raises arrives as a normal `error` event, which clears
    // `stagedUpdate` and arms a retry -- so 60s later a fresh round would
    // complete a download whose `updateDownloaded()` closes that proxy out from
    // under Squirrel (MacUpdater.js:124).
    expect(updateCheckBlockedBy(state({ handoverStarted: true }))).toBe('busy')
  })

  it('still refuses during handover after the staged flag was cleared', () => {
    // Precisely the post-error state: the `error` handler sets stagedUpdate to
    // null and checkInFlight to false, so every other guard opens up. Only the
    // handover flag is left to say no.
    expect(
      updateCheckBlockedBy({
        updaterEnabled: true,
        checkInFlight: false,
        hasStagedUpdate: false,
        handoverStarted: true,
      }),
    ).toBe('busy')
  })

  it('reports disabled ahead of everything else', () => {
    // A build with no feed cannot be "busy": saying so would send Settings
    // looking for a round that does not exist.
    expect(
      updateCheckBlockedBy(
        state({ updaterEnabled: false, handoverStarted: true, checkInFlight: true }),
      ),
    ).toBe('disabled')
  })
})
