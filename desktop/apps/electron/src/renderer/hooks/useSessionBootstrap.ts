/**
 * Session bootstrap — daemon is the source of truth.
 *
 * Two concerns with DIFFERENT lifetimes (previously coupled in one
 * once-effect, which left the sidebar stale after a gateway restart):
 *
 *   1. Hydrate the sidebar session list — runs on EVERY `* → Ready`
 *      transition, so a daemon restart (stop→start from the sidebar)
 *      resyncs sessions just like useModelsHydration resyncs models.
 *      Guarded by an in-flight ref against StrictMode's double-mount
 *      firing two concurrent fetches.
 *   2. Land on the initial view — runs exactly ONCE per app launch.
 *      Restores the last active session (persisted as
 *      `settings.ui.lastSessionId` by useActiveSessionPersistence) when it
 *      still exists; otherwise lands on a fresh Landing draft. A mid-session
 *      gateway restart must NOT re-run this (the `landedRef` guard), so it
 *      won't yank the user away from their current conversation.
 *
 *      The remembered id is fetched via `settings.get()` IPC (disk truth),
 *      NOT from the settings atom: the atom's seed rides on
 *      `additionalArguments` frozen at BrowserWindow creation, so after an
 *      in-window reload (Cmd+R) it's stale — restoring would land on the
 *      session that was active at APP START, not at the reload.
 *
 * Known edge (deliberately unhandled): if another client deleted the
 * session the user is viewing, re-hydrate drops its sidebar row but the
 * center view keeps showing it until the user navigates away.
 */
import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  hydrateSessionsFromDaemonAtom,
  markBootLandedAtom,
  newSessionAtom,
  pickInitialSession,
  selectSessionAtom,
} from '@/atoms/sessions'
import { settingsAtom } from '@/atoms/settings'
import { backendStateAtom } from '@/atoms/backend'
import { BackendState } from '../../main/python-client/types'
import { rlog } from '@/lib/logger'

export function useSessionBootstrap(): void {
  const backendState = useAtomValue(backendStateAtom)
  const hydrateFromDaemon = useSetAtom(hydrateSessionsFromDaemonAtom)
  const newSession = useSetAtom(newSessionAtom)
  const selectSession = useSetAtom(selectSessionAtom)
  const markBootLanded = useSetAtom(markBootLandedAtom)
  // Fallback only (IPC-get failure): the atom seed comes from
  // `additionalArguments` FROZEN at BrowserWindow creation, so after an
  // in-window reload (Cmd+R) it holds the value from app start — any
  // lastSessionId written since is invisible here. The land path below
  // fetches disk truth via IPC instead.
  const seedLastSessionId = useAtomValue(settingsAtom).ui.lastSessionId
  const landedRef = useRef(false)
  const hydrateInFlightRef = useRef(false)

  useEffect(() => {
    if (backendState !== BackendState.Ready) return
    if (hydrateInFlightRef.current) return
    hydrateInFlightRef.current = true
    void (async () => {
      let metas: Awaited<ReturnType<typeof hydrateFromDaemon>> = []
      try {
        metas = await hydrateFromDaemon()
      } catch (err) {
        rlog.warn('[app] hydrate sessions from daemon failed', err)
      } finally {
        hydrateInFlightRef.current = false
      }
      if (landedRef.current) return
      landedRef.current = true
      // Read disk truth rather than the atom seed: the seed is injected via
      // additionalArguments and frozen at window creation — Cmd+R does not
      // recreate the window, so any lastSessionId persisted since (especially
      // "click new session → record null") is invisible in the seed and we'd
      // wrongly restore the session from app start.
      let remembered = seedLastSessionId
      try {
        remembered = (await window.api.settings.get()).ui.lastSessionId
      } catch (err) {
        rlog.warn('[app] settings.get for session restore failed; using seed', err)
      }
      // Restore the last active session (only if it still exists); otherwise
      // land on a fresh draft (Landing). A draft never reaches the daemon — it
      // materializes on the first message, so repeated launches don't pile up
      // empty sessions.
      const target = pickInitialSession(metas, remembered)
      if (target) selectSession(target)
      else newSession()
      // Land first, then light up the center column (React auto-batches within
      // the same promise callback, so it's a single commit) — this releases
      // CenterView's bootPending placeholder and renders the final view
      // directly, with no Landing flicker.
      markBootLanded()
    })()
    // hydrateFromDaemon / newSession / selectSession are stable useSetAtom
    // references, and seedLastSessionId is only the IPC-failure fallback for
    // that one land pass — the effect is driven solely by backendState
    // transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendState])
}
