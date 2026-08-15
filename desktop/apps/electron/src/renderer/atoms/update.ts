/**
 * Cross-component signal for the desktop update flow.
 *
 * Settings → About can offer "update now", but it must NOT re-implement the
 * install decision: that flow asks the daemon whether an agent is running and,
 * if so, offers "update when idle" first. All of that lives in
 * `AutoUpdateBanner`. This atom is how About hands control back to it.
 *
 * Invariants:
 *   - The value is a monotonically increasing counter, not a boolean. Two
 *     requests in a row must both be observable, and a boolean would need an
 *     explicit reset that races the consumer's effect.
 *   - 0 means "never requested"; consumers skip that value on mount.
 */
import { atom } from 'jotai'
import { buildAmphiClient } from './backend'
import { rlog } from '@/lib/logger'

const _reopenCount = atom(0)

/** Bumped every time something asks the banner to show its install card. */
export const updateCardReopenAtom = atom((get) => get(_reopenCount))

/** Ask `AutoUpdateBanner` to surface the "ready to install" card again. */
export const requestUpdateCardAtom = atom(null, (get, set) => {
  set(_reopenCount, get(_reopenCount) + 1)
})

const _isHandingOver = atom(false)

/**
 * True from the moment the user commits to installing until the app quits (or
 * the handover fails).
 *
 * Exists because stopping the daemon is *part of* the handover: without this
 * flag the gateway going down mid-install renders the ordinary "gateway is not
 * running — start it?" screen, and a user who takes that offer spawns a daemon
 * that the installer is about to kill again.
 */
export const isHandingOverUpdateAtom = atom((get) => get(_isHandingOver))

/** Enter the handover — call BEFORE asking the main process to stop the daemon. */
export const beginUpdateHandoverAtom = atom(null, (_get, set) => {
  set(_isHandingOver, true)
})

/** Leave the handover after a refusal or timeout, so the UI works again. */
export const endUpdateHandoverAtom = atom(null, (_get, set) => {
  set(_isHandingOver, false)
})

/**
 * Ask the daemon whether any Agent task is in flight.
 *
 * A write atom rather than a plain function because the daemon client is built
 * from `backendSnapshotAtom` (base URL + token), which only a Jotai getter can
 * reach.
 *
 * **Fails closed.** No client, or an unreachable daemon, resolves to `true`.
 * Guessing "idle" would let the update restart the app on top of a running turn
 * — the exact thing this check exists to prevent — whereas guessing "busy" only
 * costs the user one extra confirmation.
 */
export const fetchAgentActivityAtom = atom(null, async (get): Promise<boolean> => {
  const client = buildAmphiClient(get)
  if (client === null) {
    rlog.warn('[update] no daemon client; treating agent as busy')
    return true
  }
  try {
    const { running } = await client.getAgentStatus()
    return running
  } catch (err) {
    rlog.warn('[update] agent status probe failed; treating agent as busy', err)
    return true
  }
})
