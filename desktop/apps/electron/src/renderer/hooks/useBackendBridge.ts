/**
 * Backend IPC bridge — split out of atoms/backend.ts so that file stays pure
 * atoms (state) while this owns the IPC-effect side.
 *
 * Mount once from the root component. Pulls the initial snapshot (single IPC
 * round-trip) and subscribes to push updates from main. Cleanup is automatic
 * on unmount.
 */
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { backendSnapshotAtom } from '@/atoms/backend'
import { rlog } from '@/lib/logger'

export function useBackendBridge(): void {
  const setSnapshot = useSetAtom(backendSnapshotAtom)

  useEffect(() => {
    let cancelled = false
    // If a push arrives first, drop the late initial snapshot — app startup
    // coincides with the daemon state machine transitioning fast
    // (spawning→ready), so a push that lands during the fetch is newer than the
    // fetch result. Subscribe first, then fetch, so a stale snapshot can't
    // overwrite the state backwards.
    let pushed = false
    const unsub = window.api.events.onBackendState((next) => {
      pushed = true
      setSnapshot(next)
    })

    void window.api.backend
      .snapshot()
      .then((snap) => {
        if (!cancelled && !pushed) setSnapshot(snap)
      })
      .catch((err: unknown) => {
        rlog.error('[backend] initial snapshot failed', err)
      })

    return () => {
      cancelled = true
      unsub()
    }
  }, [setSnapshot])
}
